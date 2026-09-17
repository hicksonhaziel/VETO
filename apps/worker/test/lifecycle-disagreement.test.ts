import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test, { type TestContext } from 'node:test';

import { financialOperationKey } from '@veto/core';
import { KeeperHubClient, keeperHubIdempotencyKey } from '@veto/keeperhub';
import { Pool } from 'pg';

import { ExitPipeline } from '../src/pipeline.js';
import { PostgresIntentStore } from '../src/store.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresTest = databaseUrl ? test : test.skip;

const chainId = 84_532;
const guard = '0x1111111111111111111111111111111111111111' as const;
const mandateId = '9';

function makeReadyIntent(proposalId: string, data: `0x${string}`) {
  const proposalIdentity = `${chainId}:0x2222222222222222222222222222222222222222:${data}:${proposalId}`;
  const operationKey = financialOperationKey({
    chainId,
    guard,
    mandateId,
    proposalIdentity,
  });
  return {
    operationKey,
    chainId,
    guard,
    mandateId,
    proposalIdentity,
    proposalData: data,
    expectedExecutableAt: '2000000000',
    request: {
      contractAddress: guard,
      chainId,
      functionName: 'execute',
      functionArgs: JSON.stringify([mandateId, data, '2000000000']),
      abi: '[]',
    },
    idempotencyKey: keeperHubIdempotencyKey(operationKey),
    executionMode: 'conditional' as const,
    conditionalRequest: {
      contractAddress: '0x2222222222222222222222222222222222222222' as const,
      chainId,
      functionName: 'executableAt',
      functionArgs: JSON.stringify([data]),
      abi: '[]',
      condition: { operator: 'eq' as const, value: '2000000000' },
      action: {
        contractAddress: guard,
        chainId,
        functionName: 'execute',
        functionArgs: JSON.stringify([mandateId, data, '2000000000']),
        abi: '[]',
      },
    },
  };
}

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
  ]) {
    await store.applyMigration(
      await readFile(new URL(`../../../db/migrations/${migration}`, import.meta.url), 'utf8'),
    );
  }
  await pool.query(
    'TRUNCATE exit_intent_events, exit_intents, proposal_decisions, scanner_checkpoints RESTART IDENTITY',
  );
  return { pool, store };
}

postgresTest(
  'Regression 6: Lost KeeperHub HTTP response retries identical request and idempotency key',
  async (context) => {
    const { store } = await setupStore(context);
    const ready = makeReadyIntent('prop-loss-1', '0x1234');
    await store.createReady(ready);

    const received: Array<{ body: string; key?: string }> = [];
    let first = true;
    const server = createServer(async (request, response) => {
      if (request.url?.endsWith('/status')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(`{"status":"completed","transactionHash":"0x${'1'.repeat(64)}"}`);
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
      response.end('{"executed":true,"executionId":"loss-rec-1","status":"pending"}');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    context.after(() => server.close());
    const address = server.address();
    assert(address && typeof address !== 'string');

    const client = new KeeperHubClient({
      apiKey: 'kh_test',
      baseUrl: `http://127.0.0.1:${address.port}`,
      maxAttempts: 1,
    });
    const reconcile = async () => ({
      ok: true,
      detail: { receiptStatus: 'success', consumed: true },
    });

    const pipeline = new ExitPipeline(store, client, reconcile);
    const uncertain = await pipeline.runOnce('w1');
    assert.equal(uncertain?.state, 'UNKNOWN');

    const recovered = await pipeline.runOnce('w2');
    assert.equal(recovered?.state, 'EXITED');
    assert.equal(recovered?.executionId, 'loss-rec-1');
    assert.equal(received.length, 2);
    assert.equal(received[0]?.body, received[1]?.body);
    assert.equal(received[0]?.key, received[1]?.key);
  },
);

postgresTest(
  'Regression 7 (Case A): KeeperHub status failed + tx hash + chain proves exit => EXITED with platform disagreement',
  async (context) => {
    const { store } = await setupStore(context);
    const ready = makeReadyIntent('prop-case-a', '0x1111');
    await store.createReady(ready);

    const txHash = `0x${'a'.repeat(64)}` as const;
    const client = {
      simulateContractCall: async () => ({}),
      submitContractCall: async () => ({ executionId: 'exec-a', state: 'pending' as const, raw: {} }),
      checkAndExecute: async () => ({
        executed: true as const,
        executionId: 'exec-a',
        state: 'pending' as const,
        conditionResult: { met: true },
        raw: {},
      }),
      getExecution: async () => ({
        executionId: 'exec-a',
        state: 'failed' as const,
        transactionHash: txHash,
        raw: { status: 'failed', transactionHash: txHash },
      }),
    };
    const reconcile = async () => ({
      ok: true,
      detail: { receiptStatus: 'success', consumed: true, ownerOnly: true },
    });

    const pipeline = new ExitPipeline(store, client, reconcile);
    const result = await pipeline.runOnce('w1');

    assert.equal(result?.state, 'EXITED');
    assert.equal(result?.transactionHash, txHash);
    assert.equal(result?.reconciliation?.platformDisagreement, true);
    assert.equal(result?.reconciliation?.keeperHubReported, 'failed');
    assert.equal(result?.reconciliation?.chainConfirmed, 'EXITED');
  },
);

postgresTest(
  'Regression 8 (Case C): KeeperHub status failed + tx hash + confirmed reverted receipt => BLOCKED with zero economic effect',
  async (context) => {
    const { store } = await setupStore(context);
    const ready = makeReadyIntent('prop-case-c', '0x2222');
    await store.createReady(ready);

    const txHash = `0x${'c'.repeat(64)}` as const;
    const client = {
      simulateContractCall: async () => ({}),
      submitContractCall: async () => ({ executionId: 'exec-c', state: 'pending' as const, raw: {} }),
      checkAndExecute: async () => ({
        executed: true as const,
        executionId: 'exec-c',
        state: 'pending' as const,
        conditionResult: { met: true },
        raw: {},
      }),
      getExecution: async () => ({
        executionId: 'exec-c',
        state: 'failed' as const,
        transactionHash: txHash,
        raw: { status: 'failed', transactionHash: txHash },
      }),
    };
    const reconcile = async () => ({
      ok: false,
      reverted: true,
      detail: { receiptStatus: 'reverted', economicEffect: 'none' },
    });

    const pipeline = new ExitPipeline(store, client, reconcile);
    const result = await pipeline.runOnce('w1');

    assert.equal(result?.state, 'BLOCKED');
    assert.equal(result?.lastError, 'CHAIN_TRANSACTION_REVERTED');
    assert.equal(result?.reconciliation?.economicEffect, 'none');
    assert.equal(result?.reconciliation?.reverted, true);
  },
);

postgresTest(
  'Regression 9 (Case B): KeeperHub failed/completed + tx hash + receipt succeeded but mismatched effect => DISPUTED',
  async (context) => {
    const { store } = await setupStore(context);
    const ready = makeReadyIntent('prop-case-b', '0x3333');
    await store.createReady(ready);

    const txHash = `0x${'b'.repeat(64)}` as const;
    const client = {
      simulateContractCall: async () => ({}),
      submitContractCall: async () => ({ executionId: 'exec-b', state: 'pending' as const, raw: {} }),
      checkAndExecute: async () => ({
        executed: true as const,
        executionId: 'exec-b',
        state: 'pending' as const,
        conditionResult: { met: true },
        raw: {},
      }),
      getExecution: async () => ({
        executionId: 'exec-b',
        state: 'failed' as const,
        transactionHash: txHash,
        raw: { status: 'failed', transactionHash: txHash },
      }),
    };
    const reconcile = async () => ({
      ok: false,
      detail: { receiptStatus: 'success', expectedExitEvent: false },
    });

    const pipeline = new ExitPipeline(store, client, reconcile);
    const result = await pipeline.runOnce('w1');

    assert.equal(result?.state, 'DISPUTED');
    assert.equal(result?.lastError, 'CHAIN_EFFECT_MISMATCH');
    assert.equal(result?.reconciliation?.chainEffectVerified, false);
  },
);

postgresTest(
  'Regression 10 (Case E with log recovery): KeeperHub failed + no tx hash + attributable Exited log exists => recovers tx and EXITED',
  async (context) => {
    const { store } = await setupStore(context);
    const ready = makeReadyIntent('prop-case-e-rec', '0x4444');
    await store.createReady(ready);

    const recoveredHash = `0x${'e'.repeat(64)}` as const;
    const client = {
      simulateContractCall: async () => ({}),
      submitContractCall: async () => ({ executionId: 'exec-e', state: 'pending' as const, raw: {} }),
      checkAndExecute: async () => ({
        executed: true as const,
        executionId: 'exec-e',
        state: 'pending' as const,
        conditionResult: { met: true },
        raw: {},
      }),
      getExecution: async () => ({
        executionId: 'exec-e',
        state: 'failed' as const,
        transactionHash: undefined,
        raw: { status: 'failed' },
      }),
    };
    const reconcile = async (_intent: unknown, hash?: `0x${string}`) => {
      if (!hash) {
        // Log scan recovers hash from chain event
        return {
          ok: true,
          detail: { transactionHash: recoveredHash, receiptStatus: 'success', consumed: true },
        };
      }
      return {
        ok: true,
        detail: { transactionHash: hash, receiptStatus: 'success', consumed: true },
      };
    };

    const pipeline = new ExitPipeline(store, client, reconcile);
    const result = await pipeline.runOnce('w1');

    assert.equal(result?.state, 'EXITED');
    assert.equal(result?.transactionHash, recoveredHash);
    assert.equal(result?.reconciliation?.recoveredFromGuardEvent, true);
  },
);

postgresTest(
  'Regression 11 (Case E pre-broadcast failure): KeeperHub failed + no tx hash + no attributable log => settles BLOCKED without infinite loop',
  async (context) => {
    const { store } = await setupStore(context);
    const ready = makeReadyIntent('prop-case-e-nobroadcast', '0x5555');
    await store.createReady(ready);

    const client = {
      simulateContractCall: async () => ({}),
      submitContractCall: async () => ({ executionId: 'exec-e-none', state: 'pending' as const, raw: {} }),
      checkAndExecute: async () => ({
        executed: true as const,
        executionId: 'exec-e-none',
        state: 'pending' as const,
        conditionResult: { met: true },
        raw: {},
      }),
      getExecution: async () => ({
        executionId: 'exec-e-none',
        state: 'failed' as const,
        transactionHash: undefined,
        raw: { status: 'failed' },
      }),
    };
    let reconcileCalls = 0;
    const reconcile = async () => {
      reconcileCalls += 1;
      return {
        ok: false,
        noAttributableEvent: true,
        detail: { reason: 'NO_ATTRIBUTABLE_EXIT_EVENT' },
      };
    };

    const pipeline = new ExitPipeline(store, client, reconcile);
    const result = await pipeline.runOnce('w1');

    assert.equal(result?.state, 'BLOCKED');
    assert.equal(result?.lastError, 'KEEPERHUB_EXECUTION_FAILED');
    assert.equal(result?.reconciliation?.economicEffect, 'none');
    assert.equal(result?.reconciliation?.transactionHash, null);
    assert.equal(reconcileCalls, 1);
  },
);

postgresTest(
  'Regression 12 (Case D): Receipt temporarily unavailable => remain in CONFIRMING, return cleanly, resume later',
  async (context) => {
    const { store } = await setupStore(context);
    const ready = makeReadyIntent('prop-case-d-pending', '0x6666');
    await store.createReady(ready);

    const txHash = `0x${'d'.repeat(64)}` as const;
    const client = {
      simulateContractCall: async () => ({}),
      submitContractCall: async () => ({ executionId: 'exec-d', state: 'pending' as const, raw: {} }),
      checkAndExecute: async () => ({
        executed: true as const,
        executionId: 'exec-d',
        state: 'pending' as const,
        conditionResult: { met: true },
        raw: {},
      }),
      getExecution: async () => ({
        executionId: 'exec-d',
        state: 'completed' as const,
        transactionHash: txHash,
        raw: { status: 'completed', transactionHash: txHash },
      }),
    };
    let receiptReady = false;
    const reconcile = async () => {
      if (!receiptReady) {
        return { ok: false, pending: true, detail: { reason: 'RECEIPT_UNAVAILABLE' } };
      }
      return { ok: true, detail: { receiptStatus: 'success', consumed: true } };
    };

    const pipeline = new ExitPipeline(store, client, reconcile);

    // First attempt: receipt unavailable
    const firstRun = await pipeline.runOnce('w1');
    assert.equal(firstRun?.state, 'CONFIRMING');
    assert.equal(firstRun?.transactionHash, txHash);

    // Later retry: receipt becomes available
    receiptReady = true;
    const secondRun = await pipeline.runOnce('w2');
    assert.equal(secondRun?.state, 'EXITED');
    assert.equal(secondRun?.transactionHash, txHash);
  },
);

postgresTest(
  'Regression 13: Worker restart during PENDING/CONFIRMING/UNKNOWN resumes same operation without new intent',
  async (context) => {
    const { pool, store } = await setupStore(context);
    const ready = makeReadyIntent('prop-restart-1', '0x7777');
    await store.createReady(ready);

    const txHash = `0x${'7'.repeat(64)}` as const;
    let pollCount = 0;
    const client = {
      simulateContractCall: async () => ({}),
      submitContractCall: async () => ({ executionId: 'exec-restart', state: 'pending' as const, raw: {} }),
      checkAndExecute: async () => ({
        executed: true as const,
        executionId: 'exec-restart',
        state: 'pending' as const,
        conditionResult: { met: true },
        raw: {},
      }),
      getExecution: async () => {
        pollCount += 1;
        if (pollCount === 1) {
          return { executionId: 'exec-restart', state: 'pending' as const, raw: { status: 'pending' } };
        }
        return {
          executionId: 'exec-restart',
          state: 'completed' as const,
          transactionHash: txHash,
          raw: { status: 'completed', transactionHash: txHash },
        };
      },
    };
    const reconcile = async () => ({
      ok: true,
      detail: { receiptStatus: 'success', consumed: true },
    });

    const workerA = new ExitPipeline(store, client, reconcile);
    // Worker A runs once and stops in PENDING
    const stateA = await workerA.runOnce('worker-alpha');
    assert.equal(stateA?.state, 'PENDING');
    assert.equal(stateA?.executionId, 'exec-restart');

    // Simulate worker crash / lease expiry and restart with Worker B
    const workerB = new ExitPipeline(store, client, reconcile);
    const stateB = await workerB.runOnce('worker-beta');
    assert.equal(stateB?.state, 'EXITED');
    assert.equal(stateB?.operationKey, ready.operationKey);
    assert.equal(stateB?.transactionHash, txHash);

    // Verify exactly one intent exists in the database
    const intentRows = await pool.query('SELECT count(*) FROM exit_intents WHERE mandate_id = 9');
    assert.equal(Number(intentRows.rows[0]?.count), 1);
  },
);
