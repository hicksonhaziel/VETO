import assert from 'node:assert/strict';
import test from 'node:test';

import { encodeFunctionData, keccak256, type Address, type Hex } from 'viem';

import {
  assessRelativeCapProposal,
  decreaseRelativeCapSelector,
  decodeIncreaseRelativeCap,
  identifyProposal,
  increaseRelativeCapSelector,
  maxRelativeCapWadProtocol,
  reduceVaultProposalLogs,
  type FeeLifecycleLog,
  type RelativeCapSnapshot,
} from '../src/index.js';

const vault = '0x050cE30b927Da55177A4914EC73480238BAD56f0' as Address;
const transaction = (suffix: string) => `0x${suffix.padStart(64, '0')}` as Hex;

const increaseRelativeCapAbi = [
  {
    type: 'function',
    name: 'increaseRelativeCap',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'idData', type: 'bytes' },
      { name: 'newRelativeCap', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

const decreaseRelativeCapAbi = [
  {
    type: 'function',
    name: 'decreaseRelativeCap',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'idData', type: 'bytes' },
      { name: 'newRelativeCap', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

const relativeCapData = (idData: Hex, cap: bigint) =>
  encodeFunctionData({
    abi: increaseRelativeCapAbi,
    functionName: 'increaseRelativeCap',
    args: [idData, cap],
  });

const decreaseRelativeCapData = (idData: Hex, cap: bigint) =>
  encodeFunctionData({
    abi: decreaseRelativeCapAbi,
    functionName: 'decreaseRelativeCap',
    args: [idData, cap],
  });

const testIdData = '0x112233445566778899aabbccddeeff0011223344' as Hex;
const testRiskId = keccak256(testIdData);
const otherIdData = '0xdeadbeef' as Hex;
const otherRiskId = keccak256(otherIdData);

const ceiling = 200_000_000_000_000_000n; // 20% (0.20e18 WAD)
const proposedCap = 500_000_000_000_000_000n; // 50% (0.50e18 WAD)
const executableAt = 10_000n;

const eligibleSnapshot: RelativeCapSnapshot = {
  factoryApproved: true,
  abdicated: false,
  executableAt,
  observedAt: 9_000n,
};

test('PHASE 2 A & B: decode valid increaseRelativeCap and reject malformed calldata', () => {
  const data = relativeCapData(testIdData, proposedCap);
  const decoded = decodeIncreaseRelativeCap(data);
  assert.ok(decoded);
  assert.equal(decoded.idData, testIdData);
  assert.equal(decoded.riskId, testRiskId);
  assert.equal(decoded.newRelativeCap, proposedCap);

  // Wrong selector
  assert.equal(decodeIncreaseRelativeCap('0x12345678'), undefined);
  // Truncated (< 100 bytes)
  assert.equal(decodeIncreaseRelativeCap('0x2438525b1234'), undefined);
  // Extra trailing bytes rejected
  assert.equal(decodeIncreaseRelativeCap(`${data}00`), undefined);
  // Malformed offset inside calldata
  const corrupt = `0x2438525b${'00'.repeat(31)}20${data.slice(10 + 64)}`;
  assert.equal(decodeIncreaseRelativeCap(corrupt as Hex), undefined);
});

test('PHASE 2 C: unconfigured risk ID => NO EXIT', () => {
  const assessment = assessRelativeCapProposal({
    data: relativeCapData(otherIdData, proposedCap),
    hasRiskConfig: false, // owner did not configure this risk ID
    maxRelativeCapWad: ceiling,
    safetySeconds: 300n,
    expectedExecutableAt: executableAt,
    snapshot: eligibleSnapshot,
  });
  assert.equal(assessment.eligible, false);
  assert.equal(assessment.reason, 'risk-not-configured');
});

test('PHASE 2 D: proposed cap below or equal to ceiling => NO EXIT', () => {
  // Below ceiling
  const below = assessRelativeCapProposal({
    data: relativeCapData(testIdData, 100_000_000_000_000_000n), // 10% < 20%
    hasRiskConfig: true,
    maxRelativeCapWad: ceiling,
    safetySeconds: 300n,
    expectedExecutableAt: executableAt,
    snapshot: eligibleSnapshot,
  });
  assert.equal(below.eligible, false);
  assert.equal(below.reason, 'cap-within-owner-limit');

  // Equal to ceiling
  const equal = assessRelativeCapProposal({
    data: relativeCapData(testIdData, ceiling), // 20% == 20%
    hasRiskConfig: true,
    maxRelativeCapWad: ceiling,
    safetySeconds: 300n,
    expectedExecutableAt: executableAt,
    snapshot: eligibleSnapshot,
  });
  assert.equal(equal.eligible, false);
  assert.equal(equal.reason, 'cap-within-owner-limit');
});

test('PHASE 2 E: proposed cap above ceiling => ELIGIBLE', () => {
  const assessment = assessRelativeCapProposal({
    data: relativeCapData(testIdData, proposedCap), // 50% > 20%
    hasRiskConfig: true,
    maxRelativeCapWad: ceiling,
    safetySeconds: 300n,
    expectedExecutableAt: executableAt,
    snapshot: eligibleSnapshot,
  });
  assert.equal(assessment.eligible, true);
  assert.equal(assessment.reason, 'eligible');
  assert.equal(assessment.riskId, testRiskId);
  assert.equal(assessment.newRelativeCap, proposedCap);
  assert.equal(assessment.remainingSeconds, 1_000n);
});

test('PHASE 2 F: proposed cap above protocol limit (> 100% WAD) => rejected', () => {
  const exceedsProtocol = assessRelativeCapProposal({
    data: relativeCapData(testIdData, maxRelativeCapWadProtocol + 1n),
    hasRiskConfig: true,
    maxRelativeCapWad: ceiling,
    safetySeconds: 300n,
    expectedExecutableAt: executableAt,
    snapshot: eligibleSnapshot,
  });
  assert.equal(exceedsProtocol.eligible, false);
  assert.equal(exceedsProtocol.reason, 'cap-exceeds-protocol-limit');
});

test('PHASE 2 G: revoked, changed, stale safety window, abdicated, or disabled rejected', () => {
  // Revoked (executableAt == 0)
  const revoked = assessRelativeCapProposal({
    data: relativeCapData(testIdData, proposedCap),
    hasRiskConfig: true,
    maxRelativeCapWad: ceiling,
    safetySeconds: 300n,
    expectedExecutableAt: executableAt,
    snapshot: { ...eligibleSnapshot, executableAt: 0n },
  });
  assert.equal(revoked.eligible, false);
  assert.equal(revoked.reason, 'proposal-cleared');

  // ExecutableAt changed
  const changed = assessRelativeCapProposal({
    data: relativeCapData(testIdData, proposedCap),
    hasRiskConfig: true,
    maxRelativeCapWad: ceiling,
    safetySeconds: 300n,
    expectedExecutableAt: executableAt + 1n,
    snapshot: eligibleSnapshot,
  });
  assert.equal(changed.eligible, false);
  assert.equal(changed.reason, 'proposal-changed');

  // Stale safety window
  const stale = assessRelativeCapProposal({
    data: relativeCapData(testIdData, proposedCap),
    hasRiskConfig: true,
    maxRelativeCapWad: ceiling,
    safetySeconds: 300n,
    expectedExecutableAt: executableAt,
    snapshot: { ...eligibleSnapshot, observedAt: executableAt - 200n },
  });
  assert.equal(stale.eligible, false);
  assert.equal(stale.reason, 'exit-window-closed');

  // Setter abdicated
  const abdicated = assessRelativeCapProposal({
    data: relativeCapData(testIdData, proposedCap),
    hasRiskConfig: true,
    maxRelativeCapWad: ceiling,
    safetySeconds: 300n,
    expectedExecutableAt: executableAt,
    snapshot: { ...eligibleSnapshot, abdicated: true },
  });
  assert.equal(abdicated.eligible, false);
  assert.equal(abdicated.reason, 'setter-abdicated');

  // Policy disabled
  const disabled = assessRelativeCapProposal({
    data: relativeCapData(testIdData, proposedCap),
    hasRiskConfig: true,
    maxRelativeCapWad: ceiling,
    safetySeconds: 300n,
    expectedExecutableAt: executableAt,
    snapshot: eligibleSnapshot,
    policyEnabled: false,
  });
  assert.equal(disabled.eligible, false);
  assert.equal(disabled.reason, 'policy-disabled');
});

test('PHASE 2 M: decreaseRelativeCap is derisking and never triggers a breach', () => {
  const decreaseData = decreaseRelativeCapData(testIdData, 100_000_000_000_000_000n);
  assert.equal(decodeIncreaseRelativeCap(decreaseData), undefined);
  assert.equal(identifyProposal(decreaseRelativeCapSelector, decreaseData), undefined);

  const assessment = assessRelativeCapProposal({
    data: decreaseData,
    hasRiskConfig: true,
    maxRelativeCapWad: ceiling,
    safetySeconds: 300n,
    expectedExecutableAt: executableAt,
    snapshot: eligibleSnapshot,
  });
  assert.equal(assessment.eligible, false);
  assert.equal(assessment.reason, 'unsupported-proposal');
});

test('PHASE 2: scanner reduces increaseRelativeCap submit, revoke, accept lifecycle', () => {
  const data = relativeCapData(testIdData, proposedCap);
  const logs: FeeLifecycleLog[] = [
    {
      kind: 'submit',
      blockNumber: 10n,
      logIndex: 0,
      transactionHash: transaction('01'),
      selector: increaseRelativeCapSelector,
      data,
      executableAt,
    },
    {
      kind: 'revoke',
      blockNumber: 11n,
      logIndex: 0,
      transactionHash: transaction('02'),
      selector: increaseRelativeCapSelector,
      data,
    },
    {
      kind: 'submit',
      blockNumber: 12n,
      logIndex: 0,
      transactionHash: transaction('03'),
      selector: increaseRelativeCapSelector,
      data,
      executableAt: executableAt + 500n,
    },
    {
      kind: 'accept',
      blockNumber: 13n,
      logIndex: 0,
      transactionHash: transaction('04'),
      selector: increaseRelativeCapSelector,
      data,
    },
  ];

  const proposals = reduceVaultProposalLogs(vault, logs);
  assert.equal(proposals.length, 2);

  assert.equal(proposals[0]?.status, 'revoked');
  assert.equal(proposals[0]?.proposalType, 'relative-cap');
  assert.equal(proposals[0]?.riskId, testRiskId);
  assert.equal(proposals[0]?.newRelativeCap, proposedCap);
  assert.equal(proposals[0]?.resolutionTransactionHash, transaction('02'));

  assert.equal(proposals[1]?.status, 'accepted');
  assert.equal(proposals[1]?.proposalType, 'relative-cap');
  assert.equal(proposals[1]?.riskId, testRiskId);
  assert.equal(proposals[1]?.newRelativeCap, proposedCap);
  assert.equal(proposals[1]?.resolutionTransactionHash, transaction('04'));
});
