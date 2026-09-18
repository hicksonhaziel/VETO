import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { type TestContext } from 'node:test';

import { financialOperationKey } from '@veto/core';
import { keeperHubIdempotencyKey } from '@veto/keeperhub';
import { Pool } from 'pg';

import { ExitPipeline } from '../src/pipeline.js';
import { PostgresIntentStore } from '../src/store.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresTest = databaseUrl ? test : test.skip;

const chainId = 84_532;
const guard = '0x1111111111111111111111111111111111111111' as const;
const mandateId = '100';

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
    '0006_multi_policy_rules.sql',
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
  'Quarantine DISPUTED: DISPUTED intents are quarantined from normal claimNext and serialize subsequent attempts',
  async (context) => {
    const { pool, store } = await setupStore(context);

    // 1. Set up Proposal A and transition it to DISPUTED (e.g. Case B chain mismatch)
    const intentA = makeReadyIntent('prop-a-quarantine', '0xaaaa');
    await store.createReady(intentA);
    const claimedA = await store.claimNext('w1');
    assert(claimedA);
    assert.equal(claimedA.operationKey, intentA.operationKey);

    await store.transition(intentA.operationKey, 'w1', 'SIMULATED');
    await store.transition(intentA.operationKey, 'w1', 'SUBMITTING');
    await store.transition(intentA.operationKey, 'w1', 'PENDING', {
      executionId: 'exec-quarantine-1',
      transactionHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
    });
    await store.transition(intentA.operationKey, 'w1', 'CONFIRMING');
    await store.transition(intentA.operationKey, 'w1', 'DISPUTED', {
      lastError: 'CHAIN_EFFECT_MISMATCH',
      detail: { reason: 'NO_ATTRIBUTABLE_EVENT' },
    });
    // 2. Release worker lease
    await store.release(intentA.operationKey, 'w1');

    // Verify stored state is DISPUTED
    const storedA = await store.get(intentA.operationKey);
    assert.equal(storedA?.state, 'DISPUTED');
    assert.equal(storedA?.claimedBy, undefined);

    // 3. Normal claimNext() does NOT return the DISPUTED intent
    const claimedAgain = await store.claimNext('w2');
    assert.equal(
      claimedAgain,
      undefined,
      'claimNext must NOT automatically claim a DISPUTED intent',
    );

    // 4. Create Proposal B under the same mandate
    const intentB = makeReadyIntent('prop-b-quarantine', '0xbbbb');
    await store.createReady(intentB);

    // Proposal B cannot be claimed because Proposal A is an unresolved DISPUTED attempt
    const claimedB = await store.claimNext('w3');
    assert.equal(
      claimedB,
      undefined,
      'Proposal B must be blocked by the unresolved DISPUTED Proposal A',
    );

    // 5. Verify that scheduler pipeline does not auto-churn or generate audit events
    const initialEvents = await pool.query<{ event_id: string }>(
      'SELECT event_id FROM exit_intent_events WHERE operation_key = $1',
      [intentA.operationKey],
    );
    const eventCountBefore = initialEvents.rows.length;

    const mockKeeperHub = {
      simulateContractCall: async () => ({}),
      submitContractCall: async () => ({
        executionId: 'exec-never',
        state: 'pending' as const,
        raw: {},
      }),
      checkAndExecute: async () => ({
        executed: true as const,
        executionId: 'exec-never',
        state: 'pending' as const,
        conditionResult: { met: true },
        raw: {},
      }),
      getExecution: async () => ({
        executionId: 'exec-never',
        state: 'completed' as const,
        transactionHash: undefined,
        raw: {},
      }),
    };
    const mockReconcile = async () => ({
      ok: false,
      detail: { reason: 'SHOULD_NOT_BE_CALLED' },
    });

    const pipeline = new ExitPipeline(store, mockKeeperHub, mockReconcile);

    // Running pipeline tick produces undefined because claimNext ignores DISPUTED
    const tickResult = await pipeline.runOnce('w-tick');
    assert.equal(tickResult, undefined);

    // Zero new audit events generated
    const finalEvents = await pool.query<{ event_id: string }>(
      'SELECT event_id FROM exit_intent_events WHERE operation_key = $1',
      [intentA.operationKey],
    );
    assert.equal(
      finalEvents.rows.length,
      eventCountBefore,
      'No audit churn events should be generated for quarantined DISPUTED intent',
    );
  },
);
