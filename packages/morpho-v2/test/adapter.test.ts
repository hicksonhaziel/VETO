import assert from 'node:assert/strict';
import test from 'node:test';

import { encodeFunctionData, type Address } from 'viem';

import {
  assessManagementFeeProposal,
  maxManagementFeePerSecond,
  proposalIdentity,
  type ManagementFeeProposal,
  type ManagementFeeSnapshot,
} from '../src/index.js';

const vault = '0x050cE30b927Da55177A4914EC73480238BAD56f0' as Address;
const recipient = '0x9E33faAE38ff641094fa68c65c2cE600b3410585' as Address;
const transaction = `0x${'1'.padStart(64, '0')}` as const;
const feeData = (fee: bigint) =>
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

const ceiling = 10n ** 16n / 31_536_000n;
const proposedFee = (2n * 10n ** 16n) / 31_536_000n;
const executableAt = 10_000n;
const eligibleSnapshot: ManagementFeeSnapshot = {
  factoryApproved: true,
  abdicated: false,
  managementFeeRecipient: recipient,
  executableAt,
  observedAt: 9_000n,
};

function reasonFor(
  overrides: {
    data?: `0x${string}`;
    maxFeePerSecond?: bigint;
    safetySeconds?: bigint;
    expectedExecutableAt?: bigint;
    snapshot?: Partial<ManagementFeeSnapshot>;
  } = {},
) {
  return assessManagementFeeProposal({
    data: overrides.data ?? feeData(proposedFee),
    maxFeePerSecond: overrides.maxFeePerSecond ?? ceiling,
    safetySeconds: overrides.safetySeconds ?? 300n,
    expectedExecutableAt: overrides.expectedExecutableAt ?? executableAt,
    snapshot: { ...eligibleSnapshot, ...overrides.snapshot },
  }).reason;
}

test('accepts only the exact still-pending fee proposal with enough exit time', () => {
  const assessment = assessManagementFeeProposal({
    data: feeData(proposedFee),
    maxFeePerSecond: ceiling,
    safetySeconds: 300n,
    expectedExecutableAt: executableAt,
    snapshot: eligibleSnapshot,
  });

  assert.equal(assessment.eligible, true);
  assert.equal(assessment.reason, 'eligible');
  assert.equal(assessment.remainingSeconds, 1_000n);
  assert.equal(assessment.proposedFee, proposedFee);
});

test('rejects every unsafe authority and proposal state explicitly', () => {
  assert.equal(reasonFor({ snapshot: { factoryApproved: false } }), 'unsupported-vault');
  assert.equal(reasonFor({ data: '0x12345678' }), 'unsupported-proposal');
  assert.equal(reasonFor({ maxFeePerSecond: proposedFee }), 'fee-within-owner-limit');
  assert.equal(
    reasonFor({ data: feeData(maxManagementFeePerSecond + 1n) }),
    'fee-exceeds-protocol-limit',
  );
  assert.equal(reasonFor({ snapshot: { abdicated: true } }), 'setter-abdicated');
  assert.equal(
    reasonFor({
      snapshot: { managementFeeRecipient: '0x0000000000000000000000000000000000000000' },
    }),
    'missing-fee-recipient',
  );
  assert.equal(reasonFor({ snapshot: { executableAt: 0n } }), 'proposal-cleared');
  assert.equal(reasonFor({ expectedExecutableAt: executableAt + 1n }), 'proposal-changed');
  assert.equal(reasonFor({ snapshot: { observedAt: executableAt - 300n } }), 'exit-window-closed');
  assert.equal(reasonFor({ snapshot: { observedAt: executableAt } }), 'exit-window-closed');
});

test('builds a stable identity for one canonical submission', () => {
  const proposal: ManagementFeeProposal = {
    vault,
    data: feeData(proposedFee),
    proposedFee,
    executableAt,
    submittedAtBlock: 123n,
    submitTransactionHash: transaction,
    submitLogIndex: 4,
    status: 'pending',
  };

  assert.equal(proposalIdentity(8453, proposal), proposalIdentity(8453, { ...proposal }));
  assert.notEqual(proposalIdentity(8453, proposal), proposalIdentity(84532, proposal));
  assert.notEqual(
    proposalIdentity(8453, proposal),
    proposalIdentity(8453, { ...proposal, submitLogIndex: 5 }),
  );
});
