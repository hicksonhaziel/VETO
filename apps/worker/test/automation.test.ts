import assert from 'node:assert/strict';
import test from 'node:test';
import { getAddress } from 'viem';

import { automationConfigFromEnv, buildScanTargets } from '../src/automation.js';
import type { ManagedRule } from '../src/store.js';

const completeEnvironment = {
  DATABASE_URL: 'postgresql://localhost/veto',
  KEEPERHUB_API_KEY: 'kh_test-only',
  VETO_CHAIN_ID: '8453',
  VETO_RPC_URL: 'http://127.0.0.1:8545',
  VETO_FACTORY_ADDRESS: '0x1111111111111111111111111111111111111111',
  VETO_VAULT_ADDRESS: '0x2222222222222222222222222222222222222222',
  VETO_GUARD_ADDRESS: '0x3333333333333333333333333333333333333333',
  VETO_MANDATE_ID: '7',
  VETO_SCAN_START_BLOCK: '100',
  VETO_GUARD_VERSION: 'v1',
};

test('parses one explicit supported-chain automation configuration with V1', () => {
  const config = automationConfigFromEnv(completeEnvironment);
  assert.equal(config.chainId, 8453);
  assert.equal(config.mandateId, 7n);
  assert.equal(config.startBlock, 100n);
  assert.equal(config.confirmationDepth, 2n);
  assert.equal(config.reorgRewindBlocks, 12n);
  assert.equal(config.pollIntervalMs, 15_000);
  assert.equal(config.executionMode, 'conditional');
  assert.equal(config.guardVersion, 'v1');
  assert.equal(config.policyVersion, 1);
});

test('parses V2 guardVersion and policyVersion 2', () => {
  const config = automationConfigFromEnv({ ...completeEnvironment, VETO_GUARD_VERSION: 'v2' });
  assert.equal(config.guardVersion, 'v2');
  assert.equal(config.policyVersion, 2);
});

test('refuses missing or invalid guard version', () => {
  assert.throws(
    () => automationConfigFromEnv({ ...completeEnvironment, VETO_GUARD_VERSION: '' }),
    /MISSING_ENVIRONMENT_VARIABLE:VETO_GUARD_VERSION/,
  );
  assert.throws(
    () => automationConfigFromEnv({ ...completeEnvironment, VETO_GUARD_VERSION: 'v3' }),
    /INVALID_VETO_GUARD_VERSION/,
  );
});

test('accepts only explicit KeeperHub execution modes', () => {
  assert.equal(
    automationConfigFromEnv({ ...completeEnvironment, KEEPERHUB_EXECUTION_MODE: 'conditional' })
      .executionMode,
    'conditional',
  );
  assert.throws(
    () => automationConfigFromEnv({ ...completeEnvironment, KEEPERHUB_EXECUTION_MODE: 'workflow' }),
    /INVALID_KEEPERHUB_EXECUTION_MODE/,
  );
});

test('refuses missing configuration and unsupported chains', () => {
  assert.throws(
    () => automationConfigFromEnv({ ...completeEnvironment, VETO_GUARD_ADDRESS: '' }),
    /MISSING_ENVIRONMENT_VARIABLE:VETO_GUARD_ADDRESS/,
  );
  assert.throws(
    () => automationConfigFromEnv({ ...completeEnvironment, VETO_CHAIN_ID: '1' }),
    /UNSUPPORTED_VETO_CHAIN_ID/,
  );
});

test('buildScanTargets deduplicates identical versions and fails safe on mismatch', () => {
  const envConfig = automationConfigFromEnv(completeEnvironment);
  const guard = getAddress(completeEnvironment.VETO_GUARD_ADDRESS);
  const vault = getAddress(completeEnvironment.VETO_VAULT_ADDRESS);
  const factory = getAddress(completeEnvironment.VETO_FACTORY_ADDRESS);

  // 1. Same version (v1 and v1) deduplicates to 1 target
  const matchingRule: ManagedRule = {
    chainId: 8453,
    factory,
    vault,
    guard,
    mandateId: 7n,
    startBlock: 50n,
    guardVersion: 'v1',
    policyVersion: 1,
  };
  const targets = buildScanTargets(envConfig, [matchingRule]);
  assert.equal(targets.length, 1);
  assert.equal(targets[0]?.guardVersion, 'v1');

  // 2. Distinct target is included
  const distinctRule: ManagedRule = {
    chainId: 8453,
    factory,
    vault,
    guard,
    mandateId: 8n,
    startBlock: 50n,
    guardVersion: 'v1',
    policyVersion: 1,
  };
  const targetsDistinct = buildScanTargets(envConfig, [matchingRule, distinctRule]);
  assert.equal(targetsDistinct.length, 2);

  // 3. Mismatched version (env is v1, DB rule is v2 for same guard & mandate) throws CONFIGURATION_CONFLICT
  const conflictingRule: ManagedRule = {
    chainId: 8453,
    factory,
    vault,
    guard,
    mandateId: 7n,
    startBlock: 50n,
    guardVersion: 'v2',
    policyVersion: 2,
  };
  assert.throws(() => buildScanTargets(envConfig, [conflictingRule]), /CONFIGURATION_CONFLICT/);
});
