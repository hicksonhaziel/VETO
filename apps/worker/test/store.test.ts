import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { keeperHubIdempotencyKey } from '@veto/keeperhub';
import { Pool } from 'pg';

import { PostgresIntentStore } from '../src/store.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresTest = databaseUrl ? test : test.skip;

postgresTest('deduplicates, leases, transitions, and checkpoints in PostgreSQL', async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const store = new PostgresIntentStore(pool);
  try {
    for (const migration of ['0001_exit_intents.sql', '0003_managed_rules.sql']) {
      await store.applyMigration(
        await readFile(new URL(`../../../db/migrations/${migration}`, import.meta.url), 'utf8'),
      );
    }
    await pool.query(
      'TRUNCATE exit_intent_events, exit_intents, scanner_checkpoints RESTART IDENTITY',
    );

    const operationKey = '84532:0x1111111111111111111111111111111111111111:7';
    const ready = {
      operationKey,
      chainId: 84_532,
      guard: '0x1111111111111111111111111111111111111111' as const,
      mandateId: '7',
      proposalIdentity: '84532:vault:proposal:block:log',
      proposalData: '0x1234' as const,
      expectedExecutableAt: '10000',
      request: {
        contractAddress: '0x1111111111111111111111111111111111111111' as const,
        chainId: 84_532,
        functionName: 'execute',
        functionArgs: '["7","0x1234","10000"]',
        abi: '[]',
      },
      idempotencyKey: keeperHubIdempotencyKey(operationKey),
    };

    assert.equal(await store.createReady(ready), true);
    assert.equal(await store.createReady(ready), false);
    const workerOne = await store.claimNext('worker-one');
    assert.equal(workerOne?.operationKey, operationKey);
    assert.equal(await store.claimNext('worker-two'), undefined);

    await store.transition(operationKey, 'worker-one', 'SIMULATED');
    await store.transition(operationKey, 'worker-one', 'SUBMITTING');
    await store.transition(operationKey, 'worker-one', 'PENDING', {
      executionId: 'execution-1',
    });
    await store.transition(operationKey, 'worker-one', 'CONFIRMING', {
      transactionHash: `0x${'a'.repeat(64)}`,
    });
    await store.transition(operationKey, 'worker-one', 'EXITED', {
      reconciliation: { ownerReceived: '10000000', relayerReceived: '0' },
    });
    await store.release(operationKey, 'worker-one');

    const stored = await store.get(operationKey);
    assert.equal(stored?.state, 'EXITED');
    assert.equal(stored?.executionId, 'execution-1');
    assert.equal(stored?.reconciliation?.ownerReceived, '10000000');
    assert.equal(await store.claimNext('worker-two'), undefined);

    const blockHash = `0x${'b'.repeat(64)}`;
    await store.saveCheckpoint({
      chainId: 84_532,
      vault: '0x2222222222222222222222222222222222222222',
      nextBlock: 101n,
      lastBlockHash: blockHash,
    });
    await store.saveCheckpoint({
      chainId: 84_532,
      vault: '0x2222222222222222222222222222222222222222',
      nextBlock: 99n,
      lastBlockHash: blockHash,
    });
    assert.equal(
      await store.readCheckpoint(84_532, '0x2222222222222222222222222222222222222222'),
      101n,
    );

    const events = await pool.query<{ to_state: string }>(
      'SELECT to_state FROM exit_intent_events WHERE operation_key = $1 ORDER BY event_id',
      [operationKey],
    );
    assert.deepEqual(
      events.rows.map((row) => row.to_state),
      ['READY', 'SIMULATED', 'SUBMITTING', 'PENDING', 'CONFIRMING', 'EXITED'],
    );
  } finally {
    await pool.end();
  }
});
