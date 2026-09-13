import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';

import type { ContractCallRequest } from '@veto/core';

import {
  KeeperHubClient,
  keeperHubIdempotencyKey,
  normalizeExecutionStatus,
  serializeContractCall,
} from '../src/index.js';

const request: ContractCallRequest = {
  contractAddress: '0x1111111111111111111111111111111111111111',
  chainId: 84_532,
  functionName: 'execute',
  functionArgs: '["7","0x1234","10000"]',
  abi: '[]',
  gasLimitMultiplier: '1.3',
};

test('retries the identical serialized request and idempotency key', async (context) => {
  const received: Array<{ body: string; key?: string }> = [];
  let submissionAttempts = 0;
  const server = createServer(async (incoming, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString('utf8');

    if (incoming.url === '/api/execute/contract-call') {
      const parsed = JSON.parse(body) as { simulate?: boolean };
      if (parsed.simulate) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"success":true,"wouldRevert":false}');
        return;
      }
      received.push({ body, key: incoming.headers['idempotency-key'] as string | undefined });
      submissionAttempts += 1;
      if (submissionAttempts === 1) {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end('{"error":"temporary"}');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"executionId":"execution-1","status":"pending"}');
      return;
    }

    if (incoming.url === '/api/execute/execution-1/status') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        '{"status":"completed","transactionHash":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
      );
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(async () => {
    server.close();
    await once(server, 'close');
  });
  const address = server.address();
  assert(address && typeof address !== 'string');

  const client = new KeeperHubClient({
    apiKey: 'kh_test-only',
    baseUrl: `http://127.0.0.1:${address.port}`,
    maxAttempts: 2,
  });
  await client.simulateContractCall(request);
  const serialized = serializeContractCall(request);
  const key = keeperHubIdempotencyKey('84532:0x1111111111111111111111111111111111111111:7');
  const submitted = await client.submitContractCall(serialized, key);
  assert.equal(submitted.executionId, 'execution-1');
  assert.equal(submitted.state, 'pending');
  assert.deepEqual(received, [
    { body: serialized, key },
    { body: serialized, key },
  ]);

  const completed = await client.getExecution('execution-1');
  assert.equal(completed.state, 'completed');
  assert.match(completed.transactionHash ?? '', /^0x[a-f0-9]{64}$/);
});

test('normalizes uncertain and terminal KeeperHub states', () => {
  assert.equal(normalizeExecutionStatus('1', { status: 'queued' }).state, 'pending');
  assert.equal(normalizeExecutionStatus('1', { status: 'reverted' }).state, 'failed');
  assert.equal(normalizeExecutionStatus('1', { status: 'unconfirmed' }).state, 'unconfirmed');
  assert.equal(normalizeExecutionStatus('1', { status: 'success' }).state, 'completed');
});

test('requires an organization API key without exposing its value', () => {
  assert.throws(() => new KeeperHubClient({ apiKey: 'wfb_wrong-kind' }), {
    message: 'KEEPERHUB_ORGANIZATION_KEY_REQUIRED',
  });
});
