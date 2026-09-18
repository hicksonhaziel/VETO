import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';

import { KeeperHubClient, keeperHubIdempotencyKey } from '@veto/keeperhub';
import { Pool } from 'pg';

import { ExitPipeline } from '../src/pipeline.js';
import { PostgresIntentStore } from '../src/store.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresTest = databaseUrl ? test : test.skip;

postgresTest(
  'restart and duplicate delivery recover one KeeperHub economic effect',
  async (context) => {
    const receivedBroadcasts: Array<{ body: string; key: string }> = [];
    const acceptedKeys = new Set<string>();
    let dropFirstSubmissionResponse = true;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8');
      if (request.url === '/api/execute/contract-call') {
        const parsed = JSON.parse(body) as { simulate?: boolean };
        if (parsed.simulate) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end('{"success":true,"wouldRevert":false}');
          return;
        }
        const key = request.headers['idempotency-key'] as string;
        receivedBroadcasts.push({ body, key });
        acceptedKeys.add(key);
        if (dropFirstSubmissionResponse) {
          dropFirstSubmissionResponse = false;
          request.socket.destroy();
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"executionId":"restart-proof-1","status":"pending"}');
        return;
      }
      if (request.url === '/api/execute/restart-proof-1/status') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(`{"status":"completed","transactionHash":"0x${'c'.repeat(64)}"}`);
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
    const serverAddress = server.address();
    assert(serverAddress && typeof serverAddress !== 'string');

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

    const operationKey = '84532:0x1111111111111111111111111111111111111111:9';
    const ready = {
      operationKey,
      chainId: 84_532,
      guard: '0x1111111111111111111111111111111111111111' as const,
      mandateId: '9',
      proposalIdentity: '84532:vault:proposal:block:log',
      proposalData: '0x1234' as const,
      expectedExecutableAt: '10000',
      request: {
        contractAddress: '0x1111111111111111111111111111111111111111' as const,
        chainId: 84_532,
        functionName: 'execute',
        functionArgs: '["9","0x1234","10000"]',
        abi: '[]',
      },
      idempotencyKey: keeperHubIdempotencyKey(operationKey),
    };
    assert.equal(await store.createReady(ready), true);
    assert.equal(await store.createReady(ready), false);

    const client = new KeeperHubClient({
      apiKey: 'kh_test-only',
      baseUrl: `http://127.0.0.1:${serverAddress.port}`,
      maxAttempts: 1,
    });
    const reconcile = async () => ({
      ok: true,
      detail: { receiptStatus: 'success', consumed: true, ownerOnly: true },
    });

    const firstWorker = new ExitPipeline(store, client, reconcile);
    const uncertain = await firstWorker.runOnce('worker-before-restart');
    assert.equal(uncertain?.state, 'UNKNOWN');

    const restartedWorker = new ExitPipeline(store, client, reconcile);
    const recovered = await restartedWorker.runOnce('worker-after-restart');
    assert.equal(recovered?.state, 'EXITED');
    assert.equal(recovered?.executionId, 'restart-proof-1');
    assert.equal(acceptedKeys.size, 1);
    assert.equal(receivedBroadcasts.length, 2);
    assert.equal(receivedBroadcasts[0]?.body, receivedBroadcasts[1]?.body);
    assert.equal(receivedBroadcasts[0]?.key, receivedBroadcasts[1]?.key);
    assert.equal(await store.claimNext('third-worker'), undefined);

    const history = await pool.query<{ to_state: string }>(
      'SELECT to_state FROM exit_intent_events WHERE operation_key = $1 ORDER BY event_id',
      [operationKey],
    );
    assert.deepEqual(
      history.rows.map((row) => row.to_state),
      [
        'READY',
        'SIMULATED',
        'SUBMITTING',
        'UNKNOWN',
        'RECONCILING',
        'PENDING',
        'CONFIRMING',
        'EXITED',
      ],
    );
  },
);
