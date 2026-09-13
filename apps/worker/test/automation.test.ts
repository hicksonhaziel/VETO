import assert from 'node:assert/strict';
import test from 'node:test';

import { automationConfigFromEnv } from '../src/automation.js';

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
};

test('parses one explicit supported-chain automation configuration', () => {
  const config = automationConfigFromEnv(completeEnvironment);
  assert.equal(config.chainId, 8453);
  assert.equal(config.mandateId, 7n);
  assert.equal(config.startBlock, 100n);
  assert.equal(config.confirmationDepth, 2n);
  assert.equal(config.reorgRewindBlocks, 12n);
  assert.equal(config.pollIntervalMs, 15_000);
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
