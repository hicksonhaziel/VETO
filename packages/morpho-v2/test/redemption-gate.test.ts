import assert from 'node:assert/strict';
import test from 'node:test';

import { encodeFunctionData, getAddress, type Address, type Hex } from 'viem';

import {
  assessGateProposal,
  decodeSetReceiveAssetsGate,
  decodeSetSendSharesGate,
  reduceVaultProposalLogs,
  setReceiveAssetsGateSelector,
  setSendSharesGateSelector,
  type FeeLifecycleLog,
  type GateSnapshot,
} from '../src/index.js';

const vault = '0x050cE30b927Da55177A4914EC73480238BAD56f0' as Address;
const transaction = (suffix: string) => `0x${suffix.padStart(64, '0')}` as Hex;

const setSendSharesGateAbi = [
  {
    type: 'function',
    name: 'setSendSharesGate',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newGate', type: 'address' }],
    outputs: [],
  },
] as const;

const setReceiveAssetsGateAbi = [
  {
    type: 'function',
    name: 'setReceiveAssetsGate',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newGate', type: 'address' }],
    outputs: [],
  },
] as const;

const sendSharesGateData = (gate: Address) =>
  encodeFunctionData({
    abi: setSendSharesGateAbi,
    functionName: 'setSendSharesGate',
    args: [gate],
  });

const receiveAssetsGateData = (gate: Address) =>
  encodeFunctionData({
    abi: setReceiveAssetsGateAbi,
    functionName: 'setReceiveAssetsGate',
    args: [gate],
  });

const approvedGate = getAddress('0x1111111111111111111111111111111111111111');
const unapprovedGate = getAddress('0x2222222222222222222222222222222222222222');
const zeroGate = getAddress('0x0000000000000000000000000000000000000000');
const executableAt = 10_000n;

const eligibleSnapshot: GateSnapshot = {
  factoryApproved: true,
  abdicated: false,
  executableAt,
  observedAt: 9_000n,
};

test('PHASE 4 A & B: decode valid setSendSharesGate & setReceiveAssetsGate and reject malformed calldata', () => {
  const sendData = sendSharesGateData(unapprovedGate);
  assert.equal(decodeSetSendSharesGate(sendData), unapprovedGate);
  assert.equal(decodeSetReceiveAssetsGate(sendData), undefined);

  const receiveData = receiveAssetsGateData(unapprovedGate);
  assert.equal(decodeSetReceiveAssetsGate(receiveData), unapprovedGate);
  assert.equal(decodeSetSendSharesGate(receiveData), undefined);

  // address(0) is valid in Morpho (means ungated)
  assert.equal(decodeSetSendSharesGate(sendSharesGateData(zeroGate)), zeroGate);
  assert.equal(decodeSetReceiveAssetsGate(receiveAssetsGateData(zeroGate)), zeroGate);

  // Wrong selector
  assert.equal(decodeSetSendSharesGate('0x12345678'), undefined);
  assert.equal(decodeSetReceiveAssetsGate('0x12345678'), undefined);
  // Truncated calldata (< 36 bytes)
  assert.equal(decodeSetSendSharesGate('0xc21ad0281122'), undefined);
  assert.equal(decodeSetReceiveAssetsGate('0x04dbf0ce1122'), undefined);
  // Extra trailing bytes rejected
  assert.equal(decodeSetSendSharesGate(`${sendData}00`), undefined);
  assert.equal(decodeSetReceiveAssetsGate(`${receiveData}00`), undefined);
});

test('PHASE 4 C: address(0) (ungated / derisking) => NO EXIT (gate-approved)', () => {
  const sendAssessment = assessGateProposal({
    data: sendSharesGateData(zeroGate),
    isApproved: false, // Even if not explicitly in mapping, zero address is ungated
    safetySeconds: 300n,
    expectedExecutableAt: executableAt,
    snapshot: eligibleSnapshot,
  });
  assert.equal(sendAssessment.eligible, false);
  assert.equal(sendAssessment.reason, 'gate-approved');

  const receiveAssessment = assessGateProposal({
    data: receiveAssetsGateData(zeroGate),
    isApproved: false,
    safetySeconds: 300n,
    expectedExecutableAt: executableAt,
    snapshot: eligibleSnapshot,
  });
  assert.equal(receiveAssessment.eligible, false);
  assert.equal(receiveAssessment.reason, 'gate-approved');
});

test('PHASE 4 D: approved gate in allowlist => NO EXIT (gate-approved)', () => {
  const assessment = assessGateProposal({
    data: sendSharesGateData(approvedGate),
    isApproved: true,
    safetySeconds: 300n,
    expectedExecutableAt: executableAt,
    snapshot: eligibleSnapshot,
  });
  assert.equal(assessment.eligible, false);
  assert.equal(assessment.reason, 'gate-approved');
});

test('PHASE 4 E: unapproved gate => ELIGIBLE', () => {
  const sendAssessment = assessGateProposal({
    data: sendSharesGateData(unapprovedGate),
    isApproved: false,
    safetySeconds: 300n,
    expectedExecutableAt: executableAt,
    snapshot: eligibleSnapshot,
  });
  assert.equal(sendAssessment.eligible, true);
  assert.equal(sendAssessment.reason, 'eligible');
  assert.equal(sendAssessment.gate, unapprovedGate);
  assert.equal(sendAssessment.remainingSeconds, 1_000n);

  const receiveAssessment = assessGateProposal({
    data: receiveAssetsGateData(unapprovedGate),
    isApproved: false,
    safetySeconds: 300n,
    expectedExecutableAt: executableAt,
    snapshot: eligibleSnapshot,
  });
  assert.equal(receiveAssessment.eligible, true);
  assert.equal(receiveAssessment.reason, 'eligible');
  assert.equal(receiveAssessment.gate, unapprovedGate);
});

test('PHASE 4 F: revoked, changed, stale window, abdicated, or disabled rejected', () => {
  const data = sendSharesGateData(unapprovedGate);

  // Policy disabled
  assert.equal(
    assessGateProposal({
      data,
      isApproved: false,
      safetySeconds: 300n,
      expectedExecutableAt: executableAt,
      snapshot: eligibleSnapshot,
      policyEnabled: false,
    }).reason,
    'policy-disabled',
  );

  // Setter abdicated
  assert.equal(
    assessGateProposal({
      data,
      isApproved: false,
      safetySeconds: 300n,
      expectedExecutableAt: executableAt,
      snapshot: { ...eligibleSnapshot, abdicated: true },
    }).reason,
    'setter-abdicated',
  );

  // Proposal cleared / revoked
  assert.equal(
    assessGateProposal({
      data,
      isApproved: false,
      safetySeconds: 300n,
      expectedExecutableAt: executableAt,
      snapshot: { ...eligibleSnapshot, executableAt: 0n },
    }).reason,
    'proposal-cleared',
  );

  // Proposal executableAt changed
  assert.equal(
    assessGateProposal({
      data,
      isApproved: false,
      safetySeconds: 300n,
      expectedExecutableAt: 9_999n,
      snapshot: eligibleSnapshot,
    }).reason,
    'proposal-changed',
  );

  // Stale / safety window closed
  assert.equal(
    assessGateProposal({
      data,
      isApproved: false,
      safetySeconds: 300n,
      expectedExecutableAt: executableAt,
      snapshot: { ...eligibleSnapshot, observedAt: 9_800n }, // 200s left <= 300s
    }).reason,
    'exit-window-closed',
  );
});

test('PHASE 4: scanner reduces sendSharesGate and receiveAssetsGate submit, revoke, accept lifecycle', () => {
  const data1 = sendSharesGateData(unapprovedGate);
  const data2 = receiveAssetsGateData(unapprovedGate);

  const logs: FeeLifecycleLog[] = [
    {
      kind: 'submit',
      blockNumber: 100n,
      logIndex: 0,
      transactionHash: transaction('1'),
      selector: setSendSharesGateSelector,
      data: data1,
      executableAt: 200n,
    },
    {
      kind: 'submit',
      blockNumber: 105n,
      logIndex: 1,
      transactionHash: transaction('2'),
      selector: setReceiveAssetsGateSelector,
      data: data2,
      executableAt: 205n,
    },
    {
      kind: 'revoke',
      blockNumber: 110n,
      logIndex: 0,
      transactionHash: transaction('3'),
      selector: setSendSharesGateSelector,
      data: data1,
    },
    {
      kind: 'accept',
      blockNumber: 210n,
      logIndex: 0,
      transactionHash: transaction('4'),
      selector: setReceiveAssetsGateSelector,
      data: data2,
    },
  ];

  const proposals = reduceVaultProposalLogs(vault, logs);
  assert.equal(proposals.length, 2);

  assert.equal(proposals[0]?.proposalType, 'send-shares-gate');
  assert.equal(proposals[0]?.gate, unapprovedGate);
  assert.equal(proposals[0]?.status, 'revoked');

  assert.equal(proposals[1]?.proposalType, 'receive-assets-gate');
  assert.equal(proposals[1]?.gate, unapprovedGate);
  assert.equal(proposals[1]?.status, 'accepted');
});
