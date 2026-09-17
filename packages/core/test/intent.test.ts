import assert from 'node:assert/strict';
import test from 'node:test';

import { assertTransition, canTransition, financialOperationKey } from '../src/index.js';

test('permits the successful durable exit path', () => {
  const path = [
    'OBSERVED',
    'CHECKING',
    'READY',
    'SIMULATED',
    'SUBMITTING',
    'PENDING',
    'CONFIRMING',
    'EXITED',
  ] as const;

  for (let index = 1; index < path.length; index += 1) {
    assertTransition(path[index - 1]!, path[index]!);
  }
});

test('allows unknown execution recovery but rejects replay from a terminal state', () => {
  assert.equal(canTransition('SUBMITTING', 'UNKNOWN'), true);
  assert.equal(canTransition('UNKNOWN', 'RECONCILING'), true);
  assert.equal(canTransition('RECONCILING', 'EXITED'), true);
  assert.equal(canTransition('EXITED', 'SUBMITTING'), false);
  assert.equal(canTransition('CONFIRMING', 'BLOCKED'), true);
  assert.equal(canTransition('PENDING', 'RECONCILING'), true);
  assert.equal(canTransition('RECONCILING', 'RECONCILING'), true);
});

test('builds one normalized key for a financial operation', () => {
  const upper = financialOperationKey({
    chainId: 84_532,
    guard: '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD',
    mandateId: 7n,
  });
  const lower = financialOperationKey({
    chainId: 84_532,
    guard: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    mandateId: '7',
  });
  assert.equal(upper, lower);

  const proposalSpecific = financialOperationKey({
    chainId: 84_532,
    guard: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    mandateId: '7',
    proposalIdentity: '84532:0xvault:0xhash:100:1',
  });
  assert.equal(
    proposalSpecific,
    '84532:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd:7:84532%3A0xvault%3A0xhash%3A100%3A1',
  );
  assert.notEqual(proposalSpecific, lower);

  assert.throws(
    () =>
      financialOperationKey({
        chainId: 0,
        guard: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        mandateId: 7n,
      }),
    /INVALID_CHAIN_ID/,
  );
});
