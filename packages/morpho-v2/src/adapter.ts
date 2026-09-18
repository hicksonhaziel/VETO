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
  addAdapterSelector,
  decodeAddAdapter,
  decodeIncreaseRelativeCap,
  decodeManagementFee,
  decodePerformanceFee,
  decodeSetReceiveAssetsGate,
  decodeSetSendSharesGate,
  increaseRelativeCapSelector,
  setManagementFeeSelector,
  setPerformanceFeeSelector,
  setReceiveAssetsGateSelector,
  setSendSharesGateSelector,
  type ManagementFeeProposal,
  type VaultProposal,
} from './scanner.js';

export const maxManagementFeePerSecond = 50_000_000_000_000_000n / 31_536_000n;
export const maxPerformanceFeeWadProtocol = 500_000_000_000_000_000n; // 0.5e18 = 50%
export const maxRelativeCapWadProtocol = 1_000_000_000_000_000_000n; // 1.0e18 = 100% WAD

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
  | 'policy-disabled'
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
  policyEnabled?: boolean;
}): ManagementFeeAssessment {
  const {
    data,
    maxFeePerSecond,
    safetySeconds,
    expectedExecutableAt,
    snapshot,
    policyEnabled = true,
  } = options;
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
  if (!policyEnabled) return result('policy-disabled');
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
  policyEnabled?: boolean;
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
    policyEnabled: options.policyEnabled,
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

export type RelativeCapAssessmentReason =
  | 'eligible'
  | 'unsupported-vault'
  | 'unsupported-proposal'
  | 'policy-disabled'
  | 'risk-not-configured'
  | 'cap-within-owner-limit'
  | 'cap-exceeds-protocol-limit'
  | 'setter-abdicated'
  | 'proposal-cleared'
  | 'proposal-changed'
  | 'exit-window-closed';

export type RelativeCapSnapshot = {
  factoryApproved: boolean;
  abdicated: boolean;
  executableAt: bigint;
  observedAt: bigint;
};

export type RelativeCapAssessment = {
  eligible: boolean;
  reason: RelativeCapAssessmentReason;
  proposalHash: Hex;
  riskId?: Hex;
  newRelativeCap?: bigint;
  executableAt?: bigint;
  remainingSeconds?: bigint;
};

export function assessRelativeCapProposal(options: {
  data: Hex;
  hasRiskConfig: boolean;
  maxRelativeCapWad: bigint;
  safetySeconds: bigint;
  expectedExecutableAt: bigint;
  snapshot: RelativeCapSnapshot;
  policyEnabled?: boolean;
}): RelativeCapAssessment {
  const {
    data,
    hasRiskConfig,
    maxRelativeCapWad,
    safetySeconds,
    expectedExecutableAt,
    snapshot,
    policyEnabled = true,
  } = options;
  const proposalHash = keccak256(data);
  const decoded = decodeIncreaseRelativeCap(data);
  const result = (
    reason: RelativeCapAssessmentReason,
    extras: Partial<RelativeCapAssessment> = {},
  ): RelativeCapAssessment => ({
    eligible: reason === 'eligible',
    reason,
    proposalHash,
    riskId: decoded?.riskId,
    newRelativeCap: decoded?.newRelativeCap,
    executableAt: snapshot.executableAt,
    ...extras,
  });

  if (!snapshot.factoryApproved) return result('unsupported-vault');
  if (decoded === undefined) return result('unsupported-proposal');
  if (!policyEnabled) return result('policy-disabled');
  if (!hasRiskConfig) return result('risk-not-configured');
  if (decoded.newRelativeCap <= maxRelativeCapWad) return result('cap-within-owner-limit');
  if (decoded.newRelativeCap > maxRelativeCapWadProtocol)
    return result('cap-exceeds-protocol-limit');
  if (snapshot.abdicated) return result('setter-abdicated');
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

export async function verifyRelativeCapProposal<
  TTransport extends Transport,
  TChain extends Chain | undefined,
>(options: {
  client: PublicClient<TTransport, TChain>;
  factory: Address;
  vault: Address;
  data: Hex;
  hasRiskConfig: boolean;
  maxRelativeCapWad: bigint;
  safetySeconds: bigint;
  expectedExecutableAt: bigint;
  policyEnabled?: boolean;
  blockNumber?: bigint;
}): Promise<RelativeCapAssessment> {
  const {
    client,
    factory,
    vault,
    data,
    hasRiskConfig,
    maxRelativeCapWad,
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
    return assessRelativeCapProposal({
      data,
      hasRiskConfig,
      maxRelativeCapWad,
      safetySeconds,
      expectedExecutableAt,
      policyEnabled,
      snapshot: {
        factoryApproved,
        abdicated: false,
        executableAt: 0n,
        observedAt: block.timestamp,
      },
    });
  }

  const [executableAt, abdicated] = await Promise.all([
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
      args: [increaseRelativeCapSelector],
      blockNumber,
    }),
  ]);

  return assessRelativeCapProposal({
    data,
    hasRiskConfig,
    maxRelativeCapWad,
    safetySeconds,
    expectedExecutableAt,
    policyEnabled,
    snapshot: {
      factoryApproved,
      abdicated,
      executableAt,
      observedAt: block.timestamp,
    },
  });
}

export type AdapterAssessmentReason =
  | 'eligible'
  | 'unsupported-vault'
  | 'unsupported-proposal'
  | 'policy-disabled'
  | 'adapter-approved'
  | 'setter-abdicated'
  | 'proposal-cleared'
  | 'proposal-changed'
  | 'exit-window-closed';

export type AdapterSnapshot = {
  factoryApproved: boolean;
  abdicated: boolean;
  executableAt: bigint;
  observedAt: bigint;
};

export type AdapterAssessment = {
  eligible: boolean;
  reason: AdapterAssessmentReason;
  proposalHash: Hex;
  adapter?: Address;
  executableAt?: bigint;
  remainingSeconds?: bigint;
};

export function assessAdapterProposal(options: {
  data: Hex;
  isApproved: boolean;
  safetySeconds: bigint;
  expectedExecutableAt: bigint;
  snapshot: AdapterSnapshot;
  policyEnabled?: boolean;
}): AdapterAssessment {
  const {
    data,
    isApproved,
    safetySeconds,
    expectedExecutableAt,
    snapshot,
    policyEnabled = true,
  } = options;
  const proposalHash = keccak256(data);
  const adapter = decodeAddAdapter(data);
  const result = (
    reason: AdapterAssessmentReason,
    extras: Partial<AdapterAssessment> = {},
  ): AdapterAssessment => ({
    eligible: reason === 'eligible',
    reason,
    proposalHash,
    adapter,
    executableAt: snapshot.executableAt,
    ...extras,
  });

  if (!snapshot.factoryApproved) return result('unsupported-vault');
  if (adapter === undefined) return result('unsupported-proposal');
  if (!policyEnabled) return result('policy-disabled');
  if (isApproved) return result('adapter-approved');
  if (snapshot.abdicated) return result('setter-abdicated');
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

export async function verifyAdapterProposal<
  TTransport extends Transport,
  TChain extends Chain | undefined,
>(options: {
  client: PublicClient<TTransport, TChain>;
  factory: Address;
  vault: Address;
  data: Hex;
  isApproved: boolean;
  safetySeconds: bigint;
  expectedExecutableAt: bigint;
  policyEnabled?: boolean;
  blockNumber?: bigint;
}): Promise<AdapterAssessment> {
  const {
    client,
    factory,
    vault,
    data,
    isApproved,
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
    return assessAdapterProposal({
      data,
      isApproved,
      safetySeconds,
      expectedExecutableAt,
      policyEnabled,
      snapshot: {
        factoryApproved,
        abdicated: false,
        executableAt: 0n,
        observedAt: block.timestamp,
      },
    });
  }

  const [executableAt, abdicated] = await Promise.all([
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
      args: [addAdapterSelector],
      blockNumber,
    }),
  ]);

  return assessAdapterProposal({
    data,
    isApproved,
    safetySeconds,
    expectedExecutableAt,
    policyEnabled,
    snapshot: {
      factoryApproved,
      abdicated,
      executableAt,
      observedAt: block.timestamp,
    },
  });
}

export type GateAssessmentReason =
  | 'eligible'
  | 'unsupported-vault'
  | 'unsupported-proposal'
  | 'policy-disabled'
  | 'gate-approved'
  | 'setter-abdicated'
  | 'proposal-cleared'
  | 'proposal-changed'
  | 'exit-window-closed';

export type GateSnapshot = {
  factoryApproved: boolean;
  abdicated: boolean;
  executableAt: bigint;
  observedAt: bigint;
};

export type GateAssessment = {
  eligible: boolean;
  reason: GateAssessmentReason;
  proposalHash: Hex;
  gate?: Address;
  executableAt?: bigint;
  remainingSeconds?: bigint;
};

export function assessGateProposal(options: {
  data: Hex;
  isApproved: boolean;
  safetySeconds: bigint;
  expectedExecutableAt: bigint;
  snapshot: GateSnapshot;
  policyEnabled?: boolean;
}): GateAssessment {
  const {
    data,
    isApproved,
    safetySeconds,
    expectedExecutableAt,
    snapshot,
    policyEnabled = true,
  } = options;
  const proposalHash = keccak256(data);
  const gate = decodeSetSendSharesGate(data) ?? decodeSetReceiveAssetsGate(data);
  const result = (
    reason: GateAssessmentReason,
    extras: Partial<GateAssessment> = {},
  ): GateAssessment => ({
    eligible: reason === 'eligible',
    reason,
    proposalHash,
    gate,
    executableAt: snapshot.executableAt,
    ...extras,
  });

  if (!snapshot.factoryApproved) return result('unsupported-vault');
  if (gate === undefined) return result('unsupported-proposal');
  if (!policyEnabled) return result('policy-disabled');
  if (gate === '0x0000000000000000000000000000000000000000' || isApproved) {
    return result('gate-approved');
  }
  if (snapshot.abdicated) return result('setter-abdicated');
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

export async function verifyGateProposal<
  TTransport extends Transport,
  TChain extends Chain | undefined,
>(options: {
  client: PublicClient<TTransport, TChain>;
  factory: Address;
  vault: Address;
  selector: Hex;
  data: Hex;
  isApproved: boolean;
  safetySeconds: bigint;
  expectedExecutableAt: bigint;
  policyEnabled?: boolean;
  blockNumber?: bigint;
}): Promise<GateAssessment> {
  const {
    client,
    factory,
    vault,
    selector,
    data,
    isApproved,
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
    return assessGateProposal({
      data,
      isApproved,
      safetySeconds,
      expectedExecutableAt,
      policyEnabled,
      snapshot: {
        factoryApproved,
        abdicated: false,
        executableAt: 0n,
        observedAt: block.timestamp,
      },
    });
  }

  const [executableAt, abdicated] = await Promise.all([
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
      args: [selector as `0x${string}`],
      blockNumber,
    }),
  ]);

  return assessGateProposal({
    data,
    isApproved,
    safetySeconds,
    expectedExecutableAt,
    policyEnabled,
    snapshot: {
      factoryApproved,
      abdicated,
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
