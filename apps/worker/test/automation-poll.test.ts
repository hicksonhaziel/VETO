import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { type TestContext } from 'node:test';

import { financialOperationKey } from '@veto/core';
import { keeperHubIdempotencyKey } from '@veto/keeperhub';
import { Pool } from 'pg';

import { WAITING_INTENT_STATES } from '../src/automation.js';
import { ExitPipeline } from '../src/pipeline.js';
import { PostgresIntentStore } from '../src/store.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresTest = databaseUrl ? test : test.skip;

const chainId = 84_532;
const guard = '0x1111111111111111111111111111111111111111' as const;
const mandateId = '19';

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
  'Automation Tick: Unresolved waiting operation yields tick and never busy-loops 50 times',
  async (context) => {
    const { store } = await setupStore(context);
    const ready = makeReadyIntent('prop-poll-guard', '0x1234');
    await store.createReady(ready);

    // Transition to PENDING with executionId
    await store.claimNext('w1');
    await store.transition(ready.operationKey, 'w1', 'SIMULATED');
    await store.transition(ready.operationKey, 'w1', 'SUBMITTING');
    await store.transition(ready.operationKey, 'w1', 'PENDING', {
      executionId: 'exec-poll-guard',
    });
    await store.release(ready.operationKey, 'w1');

    let getExecutionCalls = 0;
    const client = {
      simulateContractCall: async () => ({}),
      submitContractCall: async () => ({
        executionId: 'exec-poll-guard',
        state: 'pending' as const,
        raw: {},
      }),
      checkAndExecute: async () => ({
        executed: true as const,
        executionId: 'exec-poll-guard',
        state: 'pending' as const,
        conditionResult: { met: true },
        raw: {},
      }),
      getExecution: async () => {
        getExecutionCalls += 1;
        return {
          executionId: 'exec-poll-guard',
          state: 'pending' as const,
          transactionHash: undefined,
          raw: { status: 'pending' },
        };
      },
    };

    const reconcile = async () => ({
      ok: false,
      pending: true,
      detail: { reason: 'RECEIPT_UNAVAILABLE' },
    });

    const pipeline = new ExitPipeline(store, client, reconcile);
    const workerId = 'worker-poll-test';

    // Simulate an automation tick loop with the 50-iteration limit
    let iterations = 0;
    for (let count = 0; count < 50; count += 1) {
      iterations += 1;
      const result = await pipeline.runOnce(workerId);
      if (!result) break;
      if (WAITING_INTENT_STATES.has(result.state)) {
        // Must break on waiting state!
        break;
      }
    }

    // Proves: in a single tick, it ran exactly ONCE and yielded control.
    // Zero busy-looping (iterations === 1, getExecutionCalls === 1, NOT 50!).
    assert.equal(iterations, 1);
    assert.equal(getExecutionCalls, 1);

    // Later tick resumes and also checks exactly once
    for (let count = 0; count < 50; count += 1) {
      const result = await pipeline.runOnce(workerId);
      if (!result) break;
      if (WAITING_INTENT_STATES.has(result.state)) {
        break;
      }
    }
    assert.equal(getExecutionCalls, 2);
  },
);
