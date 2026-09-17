import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { type TestContext } from 'node:test';

import { financialOperationKey } from '@veto/core';
import { keeperHubIdempotencyKey } from '@veto/keeperhub';
import { Pool } from 'pg';

import { PostgresIntentStore, type StoredExitIntent } from '../src/store.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresTest = databaseUrl ? test : test.skip;

const chainId = 84_532;
const guard = '0x1111111111111111111111111111111111111111' as const;
const mandateId = '7';

function makeAttempt(proposalId: string, data: `0x${string}`) {
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
  'Regression 1: Proposal A blocked allows Proposal B under the same mandate to execute and consume mandate',
  async (context) => {
    const { pool, store } = await setupStore(context);
    const attemptA = makeAttempt('prop-A-100-1', '0xaaaa');
    const attemptB = makeAttempt('prop-B-200-1', '0xbbbb');

    // 1. Attempt A is created and claimed
    assert.equal(await store.createReady(attemptA), true);
    const workerOne = await store.claimNext('worker-1');
    assert.equal(workerOne?.operationKey, attemptA.operationKey);

    // Attempt A becomes BLOCKED (e.g. revoked or condition false)
    await store.transition(attemptA.operationKey, 'worker-1', 'SIMULATED');
    await store.transition(attemptA.operationKey, 'worker-1', 'SUBMITTING');
    await store.transition(attemptA.operationKey, 'worker-1', 'BLOCKED', {
      lastError: 'PROPOSAL_REVOKED',
      reconciliation: { economicEffect: 'none' },
    });
    await store.release(attemptA.operationKey, 'worker-1');

    // 2. Proposal B later arrives for the same mandate
    assert.equal(await store.createReady(attemptB), true);

    // Proposal B can be claimed even though Proposal A was BLOCKED
    const workerTwo = await store.claimNext('worker-2');
    assert.equal(workerTwo?.operationKey, attemptB.operationKey);

    // Proposal B proceeds to EXITED
    await store.transition(attemptB.operationKey, 'worker-2', 'SIMULATED');
    await store.transition(attemptB.operationKey, 'worker-2', 'SUBMITTING');
    await store.transition(attemptB.operationKey, 'worker-2', 'PENDING', {
      executionId: 'exec-B',
    });
    await store.transition(attemptB.operationKey, 'worker-2', 'CONFIRMING', {
      transactionHash: `0x${'b'.repeat(64)}`,
    });
    await store.transition(attemptB.operationKey, 'worker-2', 'EXITED', {
      reconciliation: { ownerReceived: '5000000', consumed: true },
    });
    await store.release(attemptB.operationKey, 'worker-2');

    // 3. Both attempts are preserved in database as immutable history
    const storedA = await store.get(attemptA.operationKey);
    const storedB = await store.get(attemptB.operationKey);
    assert.equal(storedA?.state, 'BLOCKED');
    assert.equal(storedB?.state, 'EXITED');

    const totalRows = await pool.query('SELECT count(*) FROM exit_intents WHERE mandate_id = 7');
    assert.equal(Number(totalRows.rows[0]?.count), 2);
  },
);

postgresTest(
  'Regression 2: Proposal A BLOCKED and duplicate delivery preserves exactly one Attempt A',
  async (context) => {
    const { pool, store } = await setupStore(context);
    const attemptA = makeAttempt('prop-A-100-1', '0xaaaa');

    assert.equal(await store.createReady(attemptA), true);
    await store.claimNext('w1');
    await store.transition(attemptA.operationKey, 'w1', 'BLOCKED', {
      reconciliation: { economicEffect: 'none' },
    });
    await store.release(attemptA.operationKey, 'w1');

    // Duplicate delivery of Proposal A
    assert.equal(await store.createReady(attemptA), false);

    const rows = await pool.query(
      'SELECT count(*) FROM exit_intents WHERE proposal_identity = $1',
      [attemptA.proposalIdentity],
    );
    assert.equal(Number(rows.rows[0]?.count), 1);
  },
);

postgresTest(
  'Regression 3: Concurrent delivery and claiming across workers produces exactly one execution',
  async (context) => {
    const { store } = await setupStore(context);
    const attempt = makeAttempt('prop-C-300-1', '0xcccc');

    // Concurrent creation
    const creates = await Promise.all([
      store.createReady(attempt),
      store.createReady(attempt),
      store.createReady(attempt),
    ]);
    assert.equal(creates.filter(Boolean).length, 1);

    // Concurrent claim
    const claims = await Promise.all([
      store.claimNext('worker-a'),
      store.claimNext('worker-b'),
      store.claimNext('worker-c'),
    ]);
    const claimed = claims.filter((c): c is StoredExitIntent => c !== undefined);
    assert.equal(claimed.length, 1);
  },
);

postgresTest(
  'Regression 4: Unresolved prior attempt blocks subsequent proposal until prior outcome resolves',
  async (context) => {
    const { store } = await setupStore(context);
    const attemptA = makeAttempt('prop-A-100-1', '0xaaaa');
    const attemptB = makeAttempt('prop-B-200-1', '0xbbbb');

    assert.equal(await store.createReady(attemptA), true);
    await store.claimNext('worker-1');
    await store.transition(attemptA.operationKey, 'worker-1', 'SIMULATED');
    await store.transition(attemptA.operationKey, 'worker-1', 'SUBMITTING');
    await store.transition(attemptA.operationKey, 'worker-1', 'PENDING', {
      executionId: 'exec-A',
    });
    await store.release(attemptA.operationKey, 'worker-1');

    // Attempt B arrives while A is still PENDING
    assert.equal(await store.createReady(attemptB), true);

    // Worker trying to claim work should NOT be able to claim B ahead of resolving A
    const nextClaim = await store.claimNext('worker-2');
    // It must claim A (the unresolved attempt), never B!
    assert.equal(nextClaim?.operationKey, attemptA.operationKey);

    // When worker-2 resolves A to BLOCKED
    await store.transition(attemptA.operationKey, 'worker-2', 'BLOCKED', {
      reconciliation: { economicEffect: 'none' },
    });
    await store.release(attemptA.operationKey, 'worker-2');

    // Now B can be claimed!
    const claimB = await store.claimNext('worker-3');
    assert.equal(claimB?.operationKey, attemptB.operationKey);
  },
);

postgresTest(
  'Regression 5: Successful exit consumes mandate; subsequent proposal cannot create another redemption',
  async (context) => {
    const { store } = await setupStore(context);
    const attemptA = makeAttempt('prop-A-100-1', '0xaaaa');
    const attemptB = makeAttempt('prop-B-200-1', '0xbbbb');

    assert.equal(await store.createReady(attemptA), true);
    await store.claimNext('w1');
    await store.transition(attemptA.operationKey, 'w1', 'SIMULATED');
    await store.transition(attemptA.operationKey, 'w1', 'SUBMITTING');
    await store.transition(attemptA.operationKey, 'w1', 'PENDING', {
      executionId: 'exec-A',
    });
    await store.transition(attemptA.operationKey, 'w1', 'CONFIRMING', {
      transactionHash: `0x${'a'.repeat(64)}`,
    });
    await store.transition(attemptA.operationKey, 'w1', 'EXITED', {
      reconciliation: { consumed: true },
    });
    await store.release(attemptA.operationKey, 'w1');

    // Proposal B arrives later
    await store.createReady(attemptB);

    // claimNext must refuse to claim B because mandate was consumed by A
    const claim = await store.claimNext('w2');
    assert.equal(claim, undefined);
  },
);
