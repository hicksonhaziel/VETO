import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test, { type TestContext } from 'node:test';

import { KeeperHubClient, keeperHubIdempotencyKey } from '@veto/keeperhub';
import { Pool } from 'pg';

import { ExitPipeline } from '../src/pipeline.js';
import { PostgresIntentStore } from '../src/store.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresTest = databaseUrl ? test : test.skip;
const hash = `0x${'d'.repeat(64)}` as const;

async function setupStore(context: TestContext) {
  const pool = new Pool({ connectionString: databaseUrl });
  context.after(() => pool.end());
  const store = new PostgresIntentStore(pool);
  for (const migration of [
    '0001_exit_intents.sql',
    '0002_proposal_decisions.sql',
    '0003_managed_rules.sql',
    '0004_keeperhub_conditional.sql',
    '0005_proposal_attempts.sql',
    '0006_multi_policy_rules.sql',
  ]) {
    await store.applyMigration(
      await readFile(new URL(`../../../db/migrations/${migration}`, import.meta.url), 'utf8'),
    );
  }
  await pool.query(
    'TRUNCATE exit_intent_events, exit_intents, scanner_checkpoints RESTART IDENTITY',
  );
  return store;
}

function ready(operationKey: string) {
  const action = {
    contractAddress: '0x1111111111111111111111111111111111111111' as const,
    chainId: 84_532,
    functionName: 'execute',
    functionArgs: '["9","0x1234","10000"]',
    abi: '[]',
  };
  return {
    operationKey,
    chainId: 84_532,
    guard: action.contractAddress,
    mandateId: '9',
    proposalIdentity: 'proposal-1',
    proposalData: '0x1234' as const,
    expectedExecutableAt: '10000',
    request: action,
    idempotencyKey: keeperHubIdempotencyKey(operationKey),
    executionMode: 'conditional' as const,
    conditionalRequest: {
      contractAddress: '0x2222222222222222222222222222222222222222' as const,
      chainId: 84_532,
      functionName: 'executableAt',
      functionArgs: '["0x1234"]',
      abi: '[]',
      condition: { operator: 'eq' as const, value: '10000' },
      action,
    },
  };
}

postgresTest('conditional false blocks without an execution or transaction', async (context) => {
  const store = await setupStore(context);
  const operationKey = '84532:0x1111111111111111111111111111111111111111:9';
  await store.createReady(ready(operationKey));
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      '{"executed":false,"conditionResult":{"met":false,"observedValue":"0","targetValue":"10000","operator":"eq"}}',
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => server.close());
  const address = server.address();
  assert(address && typeof address !== 'string');
  const client = new KeeperHubClient({
    apiKey: 'kh_test-only',
    baseUrl: `http://127.0.0.1:${address.port}`,
  });
  const result = await new ExitPipeline(store, client, async () => {
    throw new Error('RECONCILIATION_MUST_NOT_RUN');
  }).runOnce('false-worker');
  assert.equal(result?.state, 'BLOCKED');
  assert.equal(result?.lastError, 'PROPOSAL_NOT_PENDING_AT_EXECUTION');
  assert.equal(result?.executionId, undefined);
  assert.equal(result?.transactionHash, undefined);
  assert.equal(result?.reconciliation?.economicEffect, 'none');
});

postgresTest(
  'lost conditional response recovers one execution and trusts chain reconciliation',
  async (context) => {
    const store = await setupStore(context);
    const operationKey = '84532:0x1111111111111111111111111111111111111111:9';
    await store.createReady(ready(operationKey));
    const received: Array<{ body: string; key?: string }> = [];
    let first = true;
    const server = createServer(async (request, response) => {
      if (request.url?.endsWith('/status')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(`{"status":"completed","transactionHash":"${hash}"}`);
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received.push({
        body: Buffer.concat(chunks).toString('utf8'),
        key: request.headers['idempotency-key'] as string | undefined,
      });
      if (first) {
        first = false;
        request.socket.destroy();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        '{"executed":true,"executionId":"conditional-recovery-1","status":"pending","conditionResult":{"met":true,"observedValue":"10000","targetValue":"10000","operator":"eq"}}',
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    context.after(() => server.close());
    const address = server.address();
    assert(address && typeof address !== 'string');
    const client = new KeeperHubClient({
      apiKey: 'kh_test-only',
      baseUrl: `http://127.0.0.1:${address.port}`,
      maxAttempts: 1,
    });
    const reconcile = async () => ({
      ok: true,
      detail: { receipt: 'success', effect: 'verified' },
    });
    assert.equal(
      (await new ExitPipeline(store, client, reconcile).runOnce('worker-1'))?.state,
      'UNKNOWN',
    );
    const recovered = await new ExitPipeline(store, client, reconcile).runOnce('worker-2');
    assert.equal(recovered?.state, 'EXITED');
    assert.equal(recovered?.executionId, 'conditional-recovery-1');
    assert.equal(received.length, 2);
    assert.equal(received[0]?.body, received[1]?.body);
    assert.equal(received[0]?.key, received[1]?.key);
  },
);

postgresTest('KeeperHub success without the expected chain effect is disputed', async (context) => {
  const store = await setupStore(context);
  const operationKey = '84532:0x1111111111111111111111111111111111111111:9';
  await store.createReady(ready(operationKey));
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      request.url?.endsWith('/status')
        ? `{"status":"completed","transactionHash":"${hash}"}`
        : '{"executed":true,"executionId":"conditional-mismatch-1","status":"pending","conditionResult":{"met":true}}',
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => server.close());
  const address = server.address();
  assert(address && typeof address !== 'string');
  const client = new KeeperHubClient({
    apiKey: 'kh_test-only',
    baseUrl: `http://127.0.0.1:${address.port}`,
  });
  const result = await new ExitPipeline(store, client, async () => ({
    ok: false,
    detail: { expectedExitEvent: false },
  })).runOnce('mismatch-worker');
  assert.equal(result?.state, 'DISPUTED');
  assert.equal(result?.lastError, 'CHAIN_EFFECT_MISMATCH');
});
