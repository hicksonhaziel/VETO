import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { getAddress } from 'viem';
import { Pool } from 'pg';

import { PostgresIntentStore } from '../src/store.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresTest = databaseUrl ? test : test.skip;

postgresTest(
  'fresh database integration: bootstrap applies migrations 0001-0006 and operates V2 rules',
  async (context) => {
    const pool = new Pool({ connectionString: databaseUrl });
    context.after(() => pool.end());

    // 1. Wipe database completely to simulate brand-new empty database
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');

    // 2. Worker migrations list
    const migrationFiles = [
      '0001_exit_intents.sql',
      '0002_proposal_decisions.sql',
      '0003_managed_rules.sql',
      '0004_keeperhub_conditional.sql',
      '0005_proposal_attempts.sql',
      '0006_multi_policy_rules.sql',
    ];

    const store = new PostgresIntentStore(pool);
    for (const name of migrationFiles) {
      const sql = await readFile(
        new URL(`../../../db/migrations/${name}`, import.meta.url),
        'utf8',
      );
      await store.applyMigration(sql);
    }

    // 3. Verify listActiveManagedRules succeeds on fresh DB
    const chainId = 84532;
    const initialRules = await store.listActiveManagedRules(chainId);
    assert.equal(initialRules.length, 0);

    // 4. Insert a V2 managed rule with multi-policy configuration
    const guard = getAddress('0x2222222222222222222222222222222222222222');
    const vault = getAddress('0x3333333333333333333333333333333333333333');
    const owner = getAddress('0x4444444444444444444444444444444444444444');
    const factory = getAddress('0x5555555555555555555555555555555555555555');
    const mandateId = 42n;
    const policyConfigJson = {
      policyFlags: '31',
      maxManagementFee: '500000000',
      maxPerformanceFee: '150000000000000000',
      relativeCaps: [
        {
          riskId: '0x1111111111111111111111111111111111111111111111111111111111111111',
          maxRelativeCap: '250000000000000000',
        },
      ],
      approvedAdapters: ['0x6666666666666666666666666666666666666666'],
      approvedSendSharesGates: ['0x7777777777777777777777777777777777777777'],
      approvedReceiveAssetsGates: ['0x8888888888888888888888888888888888888888'],
    };

    await pool.query(
      `INSERT INTO managed_rules (
        chain_id, factory_address, guard_address, mandate_id, owner_address, vault_address,
        shares, max_fee_per_second, min_assets, expires_at, safety_seconds,
        arm_transaction_hash, arm_block, state, guard_version, policy_version, policy_config_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'ACTIVE', $14, $15, $16)`,
      [
        chainId,
        factory.toLowerCase(),
        guard.toLowerCase(),
        mandateId.toString(),
        owner.toLowerCase(),
        vault.toLowerCase(),
        '1000000',
        '500000000',
        '950000',
        '2000000000',
        '300',
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '123456',
        'v2',
        2,
        JSON.stringify(policyConfigJson),
      ],
    );

    // 5. Read back managed rule and verify all V2 fields
    const loadedRules = await store.listActiveManagedRules(chainId);
    assert.equal(loadedRules.length, 1);
    const rule = loadedRules[0];
    assert.ok(rule);
    assert.equal(rule.guard.toLowerCase(), guard.toLowerCase());
    assert.equal(rule.mandateId, mandateId);
    assert.equal(rule.guardVersion, 'v2');
    assert.equal(rule.policyVersion, 2);
    assert.deepEqual(rule.policyConfigJson, policyConfigJson);
  },
);
