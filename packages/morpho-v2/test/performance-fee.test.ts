import assert from 'node:assert/strict';
import test from 'node:test';

import { encodeFunctionData, type Address, type Hex } from 'viem';

import {
  assessPerformanceFeeProposal,
  decodePerformanceFee,
  maxPerformanceFeeWadProtocol,
  reduceVaultProposalLogs,
  setPerformanceFeeSelector,
  type FeeLifecycleLog,
  type PerformanceFeeSnapshot,
} from '../src/index.js';

const vault = '0x050cE30b927Da55177A4914EC73480238BAD56f0' as Address;
const recipient = '0x9E33faAE38ff641094fa68c65c2cE600b3410585' as Address;
const transaction = (suffix: string) => `0x${suffix.padStart(64, '0')}` as Hex;

const performanceFeeData = (fee: bigint) =>
  encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'setPerformanceFee',
        stateMutability: 'nonpayable',
        inputs: [{ name: 'newPerformanceFee', type: 'uint256' }],
        outputs: [],
      },
    ],
    functionName: 'setPerformanceFee',
    args: [fee],
  });

const ceiling = 100_000_000_000_000_000n; // 10% (0.10e18)
const proposedFee = 200_000_000_000_000_000n; // 20% (0.20e18)
const executableAt = 10_000n;

const eligibleSnapshot: PerformanceFeeSnapshot = {
  factoryApproved: true,
  abdicated: false,
  performanceFeeRecipient: recipient,
  executableAt,
  observedAt: 9_000n,
};

test('PHASE 1 A & B: decode valid setPerformanceFee and reject malformed calldata', () => {
  assert.equal(decodePerformanceFee(performanceFeeData(proposedFee)), proposedFee);
  assert.equal(decodePerformanceFee('0x12345678'), undefined);
  assert.equal(decodePerformanceFee(`${performanceFeeData(proposedFee)}00`), undefined);
  assert.equal(decodePerformanceFee('0x70897b231234'), undefined);
});

test('PHASE 1 C: proposed fee below or equal to ceiling => NO EXIT', () => {
  const belowAssessment = assessPerformanceFeeProposal({
    data: performanceFeeData(50_000_000_000_000_000n), // 5%
    maxPerformanceFeeWad: ceiling,
    safetySeconds: 300n,
    expectedExecutableAt: executableAt,
    snapshot: eligibleSnapshot,
  });
  assert.equal(belowAssessment.eligible, false);
  assert.equal(belowAssessment.reason, 'fee-within-owner-limit');

  const equalAssessment = assessPerformanceFeeProposal({
    data: performanceFeeData(ceiling), // 10% exactly
    maxPerformanceFeeWad: ceiling,
    safetySeconds: 300n,
    expectedExecutableAt: executableAt,
    snapshot: eligibleSnapshot,
  });
  assert.equal(equalAssessment.eligible, false);
  assert.equal(equalAssessment.reason, 'fee-within-owner-limit');
});

test('PHASE 1 D: proposed fee above ceiling => eligible', () => {
  const assessment = assessPerformanceFeeProposal({
    data: performanceFeeData(proposedFee), // 20% > 10%
    maxPerformanceFeeWad: ceiling,
    safetySeconds: 300n,
    expectedExecutableAt: executableAt,
    snapshot: eligibleSnapshot,
  });
  assert.equal(assessment.eligible, true);
  assert.equal(assessment.reason, 'eligible');
  assert.equal(assessment.proposedFee, proposedFee);
  assert.equal(assessment.remainingSeconds, 1_000n);
});

test('PHASE 1 E & F & G: revoked, changed, or stale safety window rejected', () => {
  // Revoked (executableAt == 0)
  const revoked = assessPerformanceFeeProposal({
    data: performanceFeeData(proposedFee),
    maxPerformanceFeeWad: ceiling,
    safetySeconds: 300n,
    expectedExecutableAt: executableAt,
    snapshot: { ...eligibleSnapshot, executableAt: 0n },
  });
  assert.equal(revoked.eligible, false);
  assert.equal(revoked.reason, 'proposal-cleared');

  // ExecutableAt changed
  const changed = assessPerformanceFeeProposal({
    data: performanceFeeData(proposedFee),
    maxPerformanceFeeWad: ceiling,
    safetySeconds: 300n,
    expectedExecutableAt: executableAt + 1n,
    snapshot: eligibleSnapshot,
  });
  assert.equal(changed.eligible, false);
  assert.equal(changed.reason, 'proposal-changed');

  // Stale safety window
  const stale = assessPerformanceFeeProposal({
    data: performanceFeeData(proposedFee),
    maxPerformanceFeeWad: ceiling,
    safetySeconds: 300n,
    expectedExecutableAt: executableAt,
    snapshot: { ...eligibleSnapshot, observedAt: executableAt - 200n },
  });
  assert.equal(stale.eligible, false);
  assert.equal(stale.reason, 'exit-window-closed');
});

test('PHASE 1: protocol limits, disabled policy, and unsafe state rejections', () => {
  // Exceeds protocol maximum (50% = 0.5e18)
  const exceedsProtocol = assessPerformanceFeeProposal({
    data: performanceFeeData(maxPerformanceFeeWadProtocol + 1n),
    maxPerformanceFeeWad: ceiling,
    safetySeconds: 300n,
    expectedExecutableAt: executableAt,
    snapshot: eligibleSnapshot,
  });
  assert.equal(exceedsProtocol.eligible, false);
  assert.equal(exceedsProtocol.reason, 'fee-exceeds-protocol-limit');

  // Policy disabled
  const disabled = assessPerformanceFeeProposal({
    data: performanceFeeData(proposedFee),
    maxPerformanceFeeWad: ceiling,
    safetySeconds: 300n,
    expectedExecutableAt: executableAt,
    snapshot: eligibleSnapshot,
    policyEnabled: false,
  });
  assert.equal(disabled.eligible, false);
  assert.equal(disabled.reason, 'policy-disabled');

  // Setter abdicated
  const abdicated = assessPerformanceFeeProposal({
    data: performanceFeeData(proposedFee),
    maxPerformanceFeeWad: ceiling,
    safetySeconds: 300n,
    expectedExecutableAt: executableAt,
    snapshot: { ...eligibleSnapshot, abdicated: true },
  });
  assert.equal(abdicated.eligible, false);
  assert.equal(abdicated.reason, 'setter-abdicated');

  // Missing fee recipient
  const missingRecipient = assessPerformanceFeeProposal({
    data: performanceFeeData(proposedFee),
    maxPerformanceFeeWad: ceiling,
    safetySeconds: 300n,
    expectedExecutableAt: executableAt,
    snapshot: {
      ...eligibleSnapshot,
      performanceFeeRecipient: '0x0000000000000000000000000000000000000000',
    },
  });
  assert.equal(missingRecipient.eligible, false);
  assert.equal(missingRecipient.reason, 'missing-fee-recipient');
});

test('PHASE 1: generic scanner reduces setPerformanceFee submit, revoke, accept', () => {
  const data = performanceFeeData(proposedFee);
  const logs: FeeLifecycleLog[] = [
    {
      kind: 'submit',
      blockNumber: 10n,
      logIndex: 0,
      transactionHash: transaction('1'),
      selector: setPerformanceFeeSelector,
      data,
      executableAt: 100n,
    },
    {
      kind: 'revoke',
      blockNumber: 11n,
      logIndex: 0,
      transactionHash: transaction('2'),
      selector: setPerformanceFeeSelector,
      data,
    },
    {
      kind: 'submit',
      blockNumber: 12n,
      logIndex: 0,
      transactionHash: transaction('3'),
      selector: setPerformanceFeeSelector,
      data,
      executableAt: 200n,
    },
  ];

  const proposals = reduceVaultProposalLogs(vault, logs);
  assert.equal(proposals.length, 2);
  assert.equal(proposals[0]?.status, 'revoked');
  assert.equal(proposals[0]?.proposalType, 'performance-fee');
  assert.equal(proposals[0]?.proposedFee, proposedFee);
  assert.equal(proposals[1]?.status, 'pending');
  assert.equal(proposals[1]?.executableAt, 200n);
});
