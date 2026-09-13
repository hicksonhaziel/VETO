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
  assert.throws(() => assertTransition('EXITED', 'SUBMITTING'), /INVALID_INTENT_TRANSITION/);
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
