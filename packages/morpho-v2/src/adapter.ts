import {
  getAddress,
  keccak256,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
} from 'viem';

import {
  decodeManagementFee,
  decodePerformanceFee,
  setManagementFeeSelector,
  setPerformanceFeeSelector,
  type ManagementFeeProposal,
  type VaultProposal,
} from './scanner.js';

export const maxManagementFeePerSecond = 50_000_000_000_000_000n / 31_536_000n;
export const maxPerformanceFeeWadProtocol = 500_000_000_000_000_000n; // 0.5e18 = 50%

const factoryReadAbi = [
  {
    type: 'function',
    name: 'isVaultV2',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

const vaultVerificationAbi = [
  {
    type: 'function',
    name: 'executableAt',
    stateMutability: 'view',
    inputs: [{ name: 'data', type: 'bytes' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'abdicated',
    stateMutability: 'view',
    inputs: [{ name: 'selector', type: 'bytes4' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'managementFeeRecipient',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'performanceFeeRecipient',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

export type ManagementFeeAssessmentReason =
  | 'eligible'
  | 'unsupported-vault'
  | 'unsupported-proposal'
  | 'fee-within-owner-limit'
  | 'fee-exceeds-protocol-limit'
  | 'setter-abdicated'
  | 'missing-fee-recipient'
  | 'proposal-cleared'
  | 'proposal-changed'
  | 'exit-window-closed';

export type ManagementFeeSnapshot = {
  factoryApproved: boolean;
  abdicated: boolean;
  managementFeeRecipient: Address;
  executableAt: bigint;
  observedAt: bigint;
};

export type ManagementFeeAssessment = {
  eligible: boolean;
  reason: ManagementFeeAssessmentReason;
  proposalHash: Hex;
  proposedFee?: bigint;
  executableAt?: bigint;
  remainingSeconds?: bigint;
};

export function assessManagementFeeProposal(options: {
  data: Hex;
  maxFeePerSecond: bigint;
  safetySeconds: bigint;
  expectedExecutableAt: bigint;
  snapshot: ManagementFeeSnapshot;
}): ManagementFeeAssessment {
  const { data, maxFeePerSecond, safetySeconds, expectedExecutableAt, snapshot } = options;
  const proposalHash = keccak256(data);
  const proposedFee = decodeManagementFee(data);
  const result = (
    reason: ManagementFeeAssessmentReason,
    extras: Partial<ManagementFeeAssessment> = {},
  ): ManagementFeeAssessment => ({
    eligible: reason === 'eligible',
    reason,
    proposalHash,
    proposedFee,
    executableAt: snapshot.executableAt,
    ...extras,
  });

  if (!snapshot.factoryApproved) return result('unsupported-vault');
  if (proposedFee === undefined) return result('unsupported-proposal');
  if (proposedFee <= maxFeePerSecond) return result('fee-within-owner-limit');
  if (proposedFee > maxManagementFeePerSecond) return result('fee-exceeds-protocol-limit');
  if (snapshot.abdicated) return result('setter-abdicated');
  if (snapshot.managementFeeRecipient === '0x0000000000000000000000000000000000000000') {
    return result('missing-fee-recipient');
  }
  if (snapshot.executableAt === 0n) return result('proposal-cleared');
  if (snapshot.executableAt !== expectedExecutableAt) return result('proposal-changed');
  if (snapshot.executableAt <= snapshot.observedAt) {
    return result('exit-window-closed', { remainingSeconds: 0n });
  }

  const remainingSeconds = snapshot.executableAt - snapshot.observedAt;
  if (remainingSeconds <= safetySeconds) {
    return result('exit-window-closed', { remainingSeconds });
  }
  return result('eligible', { remainingSeconds });
}

export async function verifyManagementFeeProposal<
  TTransport extends Transport,
  TChain extends Chain | undefined,
>(options: {
  client: PublicClient<TTransport, TChain>;
  factory: Address;
  vault: Address;
  data: Hex;
  maxFeePerSecond: bigint;
  safetySeconds: bigint;
  expectedExecutableAt: bigint;
  blockNumber?: bigint;
}): Promise<ManagementFeeAssessment> {
  const {
    client,
    factory,
    vault,
    data,
    maxFeePerSecond,
    safetySeconds,
    expectedExecutableAt,
    blockNumber,
  } = options;
  const [factoryApproved, block] = await Promise.all([
    client.readContract({
      address: factory,
      abi: factoryReadAbi,
      functionName: 'isVaultV2',
      args: [vault],
      blockNumber,
    }),
    client.getBlock({ blockNumber }),
  ]);

  if (!factoryApproved) {
    return assessManagementFeeProposal({
      data,
      maxFeePerSecond,
      safetySeconds,
      expectedExecutableAt,
      snapshot: {
        factoryApproved,
        abdicated: false,
        managementFeeRecipient: '0x0000000000000000000000000000000000000000',
        executableAt: 0n,
        observedAt: block.timestamp,
      },
    });
  }

  const [executableAt, abdicated, managementFeeRecipient] = await Promise.all([
    client.readContract({
      address: vault,
      abi: vaultVerificationAbi,
      functionName: 'executableAt',
      args: [data],
      blockNumber,
    }),
    client.readContract({
      address: vault,
      abi: vaultVerificationAbi,
      functionName: 'abdicated',
      args: [setManagementFeeSelector],
      blockNumber,
    }),
    client.readContract({
      address: vault,
      abi: vaultVerificationAbi,
      functionName: 'managementFeeRecipient',
      blockNumber,
    }),
  ]);

  return assessManagementFeeProposal({
    data,
    maxFeePerSecond,
    safetySeconds,
    expectedExecutableAt,
    snapshot: {
      factoryApproved,
      abdicated,
      managementFeeRecipient: getAddress(managementFeeRecipient),
      executableAt,
      observedAt: block.timestamp,
    },
  });
}

export type PerformanceFeeAssessmentReason =
  | 'eligible'
  | 'unsupported-vault'
  | 'unsupported-proposal'
  | 'policy-disabled'
  | 'fee-within-owner-limit'
  | 'fee-exceeds-protocol-limit'
  | 'setter-abdicated'
  | 'missing-fee-recipient'
  | 'proposal-cleared'
  | 'proposal-changed'
  | 'exit-window-closed';

export type PerformanceFeeSnapshot = {
  factoryApproved: boolean;
  abdicated: boolean;
  performanceFeeRecipient: Address;
  executableAt: bigint;
  observedAt: bigint;
};

export type PerformanceFeeAssessment = {
  eligible: boolean;
  reason: PerformanceFeeAssessmentReason;
  proposalHash: Hex;
  proposedFee?: bigint;
  executableAt?: bigint;
  remainingSeconds?: bigint;
};

export function assessPerformanceFeeProposal(options: {
  data: Hex;
  maxPerformanceFeeWad: bigint;
  safetySeconds: bigint;
  expectedExecutableAt: bigint;
  snapshot: PerformanceFeeSnapshot;
  policyEnabled?: boolean;
}): PerformanceFeeAssessment {
  const {
    data,
    maxPerformanceFeeWad,
    safetySeconds,
    expectedExecutableAt,
    snapshot,
    policyEnabled = true,
  } = options;
  const proposalHash = keccak256(data);
  const proposedFee = decodePerformanceFee(data);
  const result = (
    reason: PerformanceFeeAssessmentReason,
    extras: Partial<PerformanceFeeAssessment> = {},
  ): PerformanceFeeAssessment => ({
    eligible: reason === 'eligible',
    reason,
    proposalHash,
    proposedFee,
    executableAt: snapshot.executableAt,
    ...extras,
  });

  if (!snapshot.factoryApproved) return result('unsupported-vault');
  if (proposedFee === undefined) return result('unsupported-proposal');
  if (!policyEnabled) return result('policy-disabled');
  if (proposedFee <= maxPerformanceFeeWad) return result('fee-within-owner-limit');
  if (proposedFee > maxPerformanceFeeWadProtocol) return result('fee-exceeds-protocol-limit');
  if (snapshot.abdicated) return result('setter-abdicated');
  if (snapshot.performanceFeeRecipient === '0x0000000000000000000000000000000000000000') {
    return result('missing-fee-recipient');
  }
  if (snapshot.executableAt === 0n) return result('proposal-cleared');
  if (snapshot.executableAt !== expectedExecutableAt) return result('proposal-changed');
  if (snapshot.executableAt <= snapshot.observedAt) {
    return result('exit-window-closed', { remainingSeconds: 0n });
  }

  const remainingSeconds = snapshot.executableAt - snapshot.observedAt;
  if (remainingSeconds <= safetySeconds) {
    return result('exit-window-closed', { remainingSeconds });
  }
  return result('eligible', { remainingSeconds });
}

export async function verifyPerformanceFeeProposal<
  TTransport extends Transport,
  TChain extends Chain | undefined,
>(options: {
  client: PublicClient<TTransport, TChain>;
  factory: Address;
  vault: Address;
  data: Hex;
  maxPerformanceFeeWad: bigint;
  safetySeconds: bigint;
  expectedExecutableAt: bigint;
  policyEnabled?: boolean;
  blockNumber?: bigint;
}): Promise<PerformanceFeeAssessment> {
  const {
    client,
    factory,
    vault,
    data,
    maxPerformanceFeeWad,
    safetySeconds,
    expectedExecutableAt,
    policyEnabled = true,
    blockNumber,
  } = options;
  const [factoryApproved, block] = await Promise.all([
    client.readContract({
      address: factory,
      abi: factoryReadAbi,
      functionName: 'isVaultV2',
      args: [vault],
      blockNumber,
    }),
    client.getBlock({ blockNumber }),
  ]);

  if (!factoryApproved) {
    return assessPerformanceFeeProposal({
      data,
      maxPerformanceFeeWad,
      safetySeconds,
      expectedExecutableAt,
      policyEnabled,
      snapshot: {
        factoryApproved,
        abdicated: false,
        performanceFeeRecipient: '0x0000000000000000000000000000000000000000',
        executableAt: 0n,
        observedAt: block.timestamp,
      },
    });
  }

  const [executableAt, abdicated, performanceFeeRecipient] = await Promise.all([
    client.readContract({
      address: vault,
      abi: vaultVerificationAbi,
      functionName: 'executableAt',
      args: [data],
      blockNumber,
    }),
    client.readContract({
      address: vault,
      abi: vaultVerificationAbi,
      functionName: 'abdicated',
      args: [setPerformanceFeeSelector],
      blockNumber,
    }),
    client.readContract({
      address: vault,
      abi: vaultVerificationAbi,
      functionName: 'performanceFeeRecipient',
      blockNumber,
    }),
  ]);

  return assessPerformanceFeeProposal({
    data,
    maxPerformanceFeeWad,
    safetySeconds,
    expectedExecutableAt,
    policyEnabled,
    snapshot: {
      factoryApproved,
      abdicated,
      performanceFeeRecipient: getAddress(performanceFeeRecipient),
      executableAt,
      observedAt: block.timestamp,
    },
  });
}

export function proposalIdentity(
  chainId: number,
  proposal: { vault: Address; data: Hex; submittedAtBlock: bigint; submitLogIndex: number },
): string {
  return [
    chainId,
    getAddress(proposal.vault),
    keccak256(proposal.data),
    proposal.submittedAtBlock,
    proposal.submitLogIndex,
  ].join(':');
}
