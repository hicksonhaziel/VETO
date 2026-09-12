import assert from 'node:assert/strict';
import test from 'node:test';

import { encodeFunctionData, type Address, type Hex } from 'viem';

import {
  decodeManagementFee,
  reduceManagementFeeLogs,
  setManagementFeeSelector,
  type FeeLifecycleLog,
} from '../src/scanner.js';

const vault = '0x050cE30b927Da55177A4914EC73480238BAD56f0' as Address;
const transaction = (suffix: string) => `0x${suffix.padStart(64, '0')}` as Hex;
const managementFeeData = (fee: bigint) =>
  encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'setManagementFee',
        stateMutability: 'nonpayable',
        inputs: [{ name: 'newManagementFee', type: 'uint256' }],
        outputs: [],
      },
    ],
    functionName: 'setManagementFee',
    args: [fee],
  });

test('decodes only exact setManagementFee calldata', () => {
  assert.equal(decodeManagementFee(managementFeeData(123n)), 123n);
  assert.equal(decodeManagementFee('0x12345678'), undefined);
});

test('tracks submit, revoke, resubmit, and accept independently', () => {
  const data = managementFeeData(42n);
  const logs: FeeLifecycleLog[] = [
    {
      kind: 'accept',
      blockNumber: 13n,
      logIndex: 0,
      transactionHash: transaction('4'),
      selector: setManagementFeeSelector,
      data,
    },
    {
      kind: 'submit',
      blockNumber: 10n,
      logIndex: 0,
      transactionHash: transaction('1'),
      selector: setManagementFeeSelector,
      data,
      executableAt: 100n,
    },
    {
      kind: 'revoke',
      blockNumber: 11n,
      logIndex: 0,
      transactionHash: transaction('2'),
      selector: setManagementFeeSelector,
      data,
    },
    {
      kind: 'submit',
      blockNumber: 12n,
      logIndex: 0,
      transactionHash: transaction('3'),
      selector: setManagementFeeSelector,
      data,
      executableAt: 200n,
    },
  ];

  const proposals = reduceManagementFeeLogs(vault, logs);
  assert.deepEqual(
    proposals.map(({ status, proposedFee, executableAt }) => ({
      status,
      proposedFee,
      executableAt,
    })),
    [
      { status: 'revoked', proposedFee: 42n, executableAt: 100n },
      { status: 'accepted', proposedFee: 42n, executableAt: 200n },
    ],
  );
});

test('ignores unrelated selectors and malformed calldata', () => {
  const logs: FeeLifecycleLog[] = [
    {
      kind: 'submit',
      blockNumber: 1n,
      logIndex: 0,
      transactionHash: transaction('1'),
      selector: '0x12345678',
      data: managementFeeData(42n),
      executableAt: 100n,
    },
    {
      kind: 'submit',
      blockNumber: 2n,
      logIndex: 0,
      transactionHash: transaction('2'),
      selector: setManagementFeeSelector,
      data: setManagementFeeSelector,
      executableAt: 100n,
    },
  ];

  assert.deepEqual(reduceManagementFeeLogs(vault, logs), []);
});
