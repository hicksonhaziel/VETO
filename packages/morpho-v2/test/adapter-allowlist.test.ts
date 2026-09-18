import assert from 'node:assert/strict';
import test from 'node:test';

import { encodeFunctionData, getAddress, type Address, type Hex } from 'viem';

import {
  addAdapterSelector,
  assessAdapterProposal,
  decodeAddAdapter,
  reduceVaultProposalLogs,
  type AdapterSnapshot,
  type FeeLifecycleLog,
} from '../src/index.js';

const vault = '0x050cE30b927Da55177A4914EC73480238BAD56f0' as Address;
const transaction = (suffix: string) => `0x${suffix.padStart(64, '0')}` as Hex;

const addAdapterAbi = [
  {
    type: 'function',
    name: 'addAdapter',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'adapter', type: 'address' }],
    outputs: [],
  },
] as const;

const adapterData = (adapter: Address) =>
  encodeFunctionData({
    abi: addAdapterAbi,
    functionName: 'addAdapter',
    args: [adapter],
  });

const approvedAdapter = getAddress('0x1111111111111111111111111111111111111111');
const unapprovedAdapter = getAddress('0x2222222222222222222222222222222222222222');
const executableAt = 10_000n;

const eligibleSnapshot: AdapterSnapshot = {
  factoryApproved: true,
  abdicated: false,
  executableAt,
  observedAt: 9_000n,
};

test('PHASE 3 A & B: decode valid addAdapter and reject malformed calldata', () => {
  const data = adapterData(unapprovedAdapter);
  assert.equal(decodeAddAdapter(data), unapprovedAdapter);

  // Wrong selector
  assert.equal(decodeAddAdapter('0x12345678'), undefined);
  // Truncated calldata (< 36 bytes)
  assert.equal(decodeAddAdapter('0x60d54d411122'), undefined);
  // Extra trailing bytes rejected
  assert.equal(decodeAddAdapter(`${data}00`), undefined);
  // Zero address rejected
  const zeroData = adapterData('0x0000000000000000000000000000000000000000');
  assert.equal(decodeAddAdapter(zeroData), undefined);
});

test('PHASE 3 C: approved adapter in allowlist => NO EXIT', () => {
  const assessment = assessAdapterProposal({
    data: adapterData(approvedAdapter),
    isApproved: true,
    safetySeconds: 300n,
    expectedExecutableAt: executableAt,
    snapshot: eligibleSnapshot,
  });
  assert.equal(assessment.eligible, false);
  assert.equal(assessment.reason, 'adapter-approved');
});

test('PHASE 3 D: unapproved adapter => ELIGIBLE', () => {
  const assessment = assessAdapterProposal({
    data: adapterData(unapprovedAdapter),
    isApproved: false,
    safetySeconds: 300n,
    expectedExecutableAt: executableAt,
    snapshot: eligibleSnapshot,
  });
  assert.equal(assessment.eligible, true);
  assert.equal(assessment.reason, 'eligible');
  assert.equal(assessment.adapter, unapprovedAdapter);
  assert.equal(assessment.remainingSeconds, 1_000n);
});

test('PHASE 3 E, F, G: revoked, changed, stale window, abdicated, or disabled rejected', () => {
  // Revoked (executableAt == 0)
  const revoked = assessAdapterProposal({
    data: adapterData(unapprovedAdapter),
    isApproved: false,
    safetySeconds: 300n,
    expectedExecutableAt: executableAt,
    snapshot: { ...eligibleSnapshot, executableAt: 0n },
  });
  assert.equal(revoked.eligible, false);
  assert.equal(revoked.reason, 'proposal-cleared');

  // ExecutableAt changed
  const changed = assessAdapterProposal({
    data: adapterData(unapprovedAdapter),
    isApproved: false,
    safetySeconds: 300n,
    expectedExecutableAt: executableAt + 1n,
    snapshot: eligibleSnapshot,
  });
  assert.equal(changed.eligible, false);
  assert.equal(changed.reason, 'proposal-changed');

  // Stale safety window
  const stale = assessAdapterProposal({
    data: adapterData(unapprovedAdapter),
    isApproved: false,
    safetySeconds: 300n,
    expectedExecutableAt: executableAt,
    snapshot: { ...eligibleSnapshot, observedAt: executableAt - 200n },
  });
  assert.equal(stale.eligible, false);
  assert.equal(stale.reason, 'exit-window-closed');

  // Setter abdicated
  const abdicated = assessAdapterProposal({
    data: adapterData(unapprovedAdapter),
    isApproved: false,
    safetySeconds: 300n,
    expectedExecutableAt: executableAt,
    snapshot: { ...eligibleSnapshot, abdicated: true },
  });
  assert.equal(abdicated.eligible, false);
  assert.equal(abdicated.reason, 'setter-abdicated');

  // Policy disabled
  const disabled = assessAdapterProposal({
    data: adapterData(unapprovedAdapter),
    isApproved: false,
    safetySeconds: 300n,
    expectedExecutableAt: executableAt,
    snapshot: eligibleSnapshot,
    policyEnabled: false,
  });
  assert.equal(disabled.eligible, false);
  assert.equal(disabled.reason, 'policy-disabled');
});

test('PHASE 3: scanner reduces addAdapter submit, revoke, accept lifecycle', () => {
  const data = adapterData(unapprovedAdapter);
  const logs: FeeLifecycleLog[] = [
    {
      kind: 'submit',
      blockNumber: 10n,
      logIndex: 0,
      transactionHash: transaction('01'),
      selector: addAdapterSelector,
      data,
      executableAt,
    },
    {
      kind: 'revoke',
      blockNumber: 11n,
      logIndex: 0,
      transactionHash: transaction('02'),
      selector: addAdapterSelector,
      data,
    },
    {
      kind: 'submit',
      blockNumber: 12n,
      logIndex: 0,
      transactionHash: transaction('03'),
      selector: addAdapterSelector,
      data,
      executableAt: executableAt + 500n,
    },
    {
      kind: 'accept',
      blockNumber: 13n,
      logIndex: 0,
      transactionHash: transaction('04'),
      selector: addAdapterSelector,
      data,
    },
  ];

  const proposals = reduceVaultProposalLogs(vault, logs);
  assert.equal(proposals.length, 2);

  assert.equal(proposals[0]?.status, 'revoked');
  assert.equal(proposals[0]?.proposalType, 'add-adapter');
  assert.equal(proposals[0]?.adapter, unapprovedAdapter);
  assert.equal(proposals[0]?.resolutionTransactionHash, transaction('02'));

  assert.equal(proposals[1]?.status, 'accepted');
  assert.equal(proposals[1]?.proposalType, 'add-adapter');
  assert.equal(proposals[1]?.adapter, unapprovedAdapter);
  assert.equal(proposals[1]?.resolutionTransactionHash, transaction('04'));
});
