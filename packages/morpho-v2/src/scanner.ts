import {
  decodeFunctionData,
  parseAbiItem,
  size,
  toFunctionSelector,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
} from 'viem';

export const submitEvent = parseAbiItem(
  'event Submit(bytes4 indexed selector, bytes data, uint256 executableAt)',
);
export const revokeEvent = parseAbiItem(
  'event Revoke(address indexed sender, bytes4 indexed selector, bytes data)',
);
export const acceptEvent = parseAbiItem('event Accept(bytes4 indexed selector, bytes data)');

const vaultReadAbi = [
  {
    type: 'function',
    name: 'executableAt',
    stateMutability: 'view',
    inputs: [{ name: 'data', type: 'bytes' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

const setManagementFeeAbi = [
  {
    type: 'function',
    name: 'setManagementFee',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newManagementFee', type: 'uint256' }],
    outputs: [],
  },
] as const;

const setPerformanceFeeAbi = [
  {
    type: 'function',
    name: 'setPerformanceFee',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newPerformanceFee', type: 'uint256' }],
    outputs: [],
  },
] as const;

export const setManagementFeeSelector = toFunctionSelector('setManagementFee(uint256)');
export const setPerformanceFeeSelector = toFunctionSelector('setPerformanceFee(uint256)');

export type ProposalType =
  | 'management-fee'
  | 'performance-fee'
  | 'relative-cap'
  | 'add-adapter'
  | 'send-shares-gate'
  | 'receive-assets-gate';

export type FeeLifecycleLog = {
  kind: 'submit' | 'revoke' | 'accept';
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
  selector: Hex;
  data: Hex;
  executableAt?: bigint;
};

export type ManagementFeeProposal = {
  vault: Address;
  data: Hex;
  proposedFee: bigint;
  executableAt: bigint;
  submittedAtBlock: bigint;
  submitTransactionHash: Hex;
  submitLogIndex: number;
  status: 'pending' | 'revoked' | 'accepted' | 'cleared-outside-range';
  resolutionTransactionHash?: Hex;
};

export type VaultProposal = {
  vault: Address;
  selector: Hex;
  data: Hex;
  proposalType?: ProposalType;
  proposedFee?: bigint;
  executableAt: bigint;
  submittedAtBlock: bigint;
  submitTransactionHash: Hex;
  submitLogIndex: number;
  status: 'pending' | 'revoked' | 'accepted' | 'cleared-outside-range';
  resolutionTransactionHash?: Hex;
};

export function decodeManagementFee(data: Hex): bigint | undefined {
  if (
    size(data) !== 36 ||
    data.slice(0, 10).toLowerCase() !== setManagementFeeSelector.toLowerCase()
  ) {
    return undefined;
  }

  try {
    const decoded = decodeFunctionData({ abi: setManagementFeeAbi, data });
    return decoded.functionName === 'setManagementFee' ? decoded.args[0] : undefined;
  } catch {
    return undefined;
  }
}

export function decodePerformanceFee(data: Hex): bigint | undefined {
  if (
    size(data) !== 36 ||
    data.slice(0, 10).toLowerCase() !== setPerformanceFeeSelector.toLowerCase()
  ) {
    return undefined;
  }

  try {
    const decoded = decodeFunctionData({ abi: setPerformanceFeeAbi, data });
    return decoded.functionName === 'setPerformanceFee' ? decoded.args[0] : undefined;
  } catch {
    return undefined;
  }
}

export function reduceManagementFeeLogs(
  vault: Address,
  logs: readonly FeeLifecycleLog[],
): ManagementFeeProposal[] {
  const proposals: ManagementFeeProposal[] = [];
  const activeByData = new Map<string, number>();
  const ordered = [...logs].sort((left, right) => {
    if (left.blockNumber === right.blockNumber) return left.logIndex - right.logIndex;
    return left.blockNumber < right.blockNumber ? -1 : 1;
  });

  for (const log of ordered) {
    if (log.selector.toLowerCase() !== setManagementFeeSelector.toLowerCase()) continue;

    const key = log.data.toLowerCase();
    if (log.kind === 'submit') {
      const proposedFee = decodeManagementFee(log.data);
      if (proposedFee === undefined || log.executableAt === undefined) continue;

      proposals.push({
        vault,
        data: log.data,
        proposedFee,
        executableAt: log.executableAt,
        submittedAtBlock: log.blockNumber,
        submitTransactionHash: log.transactionHash,
        submitLogIndex: log.logIndex,
        status: 'pending',
      });
      activeByData.set(key, proposals.length - 1);
      continue;
    }

    const proposalIndex = activeByData.get(key);
    if (proposalIndex === undefined) continue;
    const proposal = proposals[proposalIndex];
    if (!proposal || proposal.status !== 'pending') continue;

    proposal.status = log.kind === 'revoke' ? 'revoked' : 'accepted';
    proposal.resolutionTransactionHash = log.transactionHash;
    activeByData.delete(key);
  }

  return proposals;
}

export async function scanManagementFeeProposals<
  TTransport extends Transport,
  TChain extends Chain | undefined,
>(options: {
  client: PublicClient<TTransport, TChain>;
  vault: Address;
  fromBlock: bigint;
  toBlock?: bigint;
}): Promise<ManagementFeeProposal[]> {
  const { client, vault, fromBlock, toBlock } = options;
  const range = { address: vault, fromBlock, toBlock } as const;
  const [submits, revokes, accepts] = await Promise.all([
    client.getLogs({ ...range, event: submitEvent, strict: true }),
    client.getLogs({ ...range, event: revokeEvent, strict: true }),
    client.getLogs({ ...range, event: acceptEvent, strict: true }),
  ]);

  const logs: FeeLifecycleLog[] = [
    ...submits.map((log) => ({
      kind: 'submit' as const,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      transactionHash: log.transactionHash,
      selector: log.args.selector,
      data: log.args.data,
      executableAt: log.args.executableAt,
    })),
    ...revokes.map((log) => ({
      kind: 'revoke' as const,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      transactionHash: log.transactionHash,
      selector: log.args.selector,
      data: log.args.data,
    })),
    ...accepts.map((log) => ({
      kind: 'accept' as const,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      transactionHash: log.transactionHash,
      selector: log.args.selector,
      data: log.args.data,
    })),
  ];

  const proposals = reduceManagementFeeLogs(vault, logs);
  await Promise.all(
    proposals.map(async (proposal) => {
      if (proposal.status !== 'pending') return;
      const executableAt = await client.readContract({
        address: vault,
        abi: vaultReadAbi,
        functionName: 'executableAt',
        args: [proposal.data],
        blockNumber: toBlock,
      });
      if (executableAt === 0n) proposal.status = 'cleared-outside-range';
    }),
  );

  return proposals;
}

export function identifyProposal(
  selector: Hex,
  data: Hex,
): { proposalType: ProposalType; proposedFee?: bigint } | undefined {
  const sel = selector.toLowerCase();
  if (sel === setManagementFeeSelector.toLowerCase()) {
    const fee = decodeManagementFee(data);
    return fee !== undefined ? { proposalType: 'management-fee', proposedFee: fee } : undefined;
  }
  if (sel === setPerformanceFeeSelector.toLowerCase()) {
    const fee = decodePerformanceFee(data);
    return fee !== undefined ? { proposalType: 'performance-fee', proposedFee: fee } : undefined;
  }
  return undefined;
}

export function reduceVaultProposalLogs(
  vault: Address,
  logs: readonly FeeLifecycleLog[],
): VaultProposal[] {
  const proposals: VaultProposal[] = [];
  const activeByData = new Map<string, number>();
  const ordered = [...logs].sort((left, right) => {
    if (left.blockNumber === right.blockNumber) return left.logIndex - right.logIndex;
    return left.blockNumber < right.blockNumber ? -1 : 1;
  });

  for (const log of ordered) {
    const key = log.data.toLowerCase();
    if (log.kind === 'submit') {
      const identified = identifyProposal(log.selector, log.data);
      if (!identified || log.executableAt === undefined) continue;

      proposals.push({
        vault,
        selector: log.selector,
        data: log.data,
        proposalType: identified.proposalType,
        proposedFee: identified.proposedFee,
        executableAt: log.executableAt,
        submittedAtBlock: log.blockNumber,
        submitTransactionHash: log.transactionHash,
        submitLogIndex: log.logIndex,
        status: 'pending',
      });
      activeByData.set(key, proposals.length - 1);
      continue;
    }

    const proposalIndex = activeByData.get(key);
    if (proposalIndex === undefined) continue;
    const proposal = proposals[proposalIndex];
    if (!proposal || proposal.status !== 'pending') continue;

    proposal.status = log.kind === 'revoke' ? 'revoked' : 'accepted';
    proposal.resolutionTransactionHash = log.transactionHash;
    activeByData.delete(key);
  }

  return proposals;
}

export async function scanVaultProposals<
  TTransport extends Transport,
  TChain extends Chain | undefined,
>(options: {
  client: PublicClient<TTransport, TChain>;
  vault: Address;
  fromBlock: bigint;
  toBlock?: bigint;
}): Promise<VaultProposal[]> {
  const { client, vault, fromBlock, toBlock } = options;
  const range = { address: vault, fromBlock, toBlock } as const;
  const [submits, revokes, accepts] = await Promise.all([
    client.getLogs({ ...range, event: submitEvent, strict: true }),
    client.getLogs({ ...range, event: revokeEvent, strict: true }),
    client.getLogs({ ...range, event: acceptEvent, strict: true }),
  ]);

  const logs: FeeLifecycleLog[] = [
    ...submits.map((log) => ({
      kind: 'submit' as const,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      transactionHash: log.transactionHash,
      selector: log.args.selector,
      data: log.args.data,
      executableAt: log.args.executableAt,
    })),
    ...revokes.map((log) => ({
      kind: 'revoke' as const,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      transactionHash: log.transactionHash,
      selector: log.args.selector,
      data: log.args.data,
    })),
    ...accepts.map((log) => ({
      kind: 'accept' as const,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      transactionHash: log.transactionHash,
      selector: log.args.selector,
      data: log.args.data,
    })),
  ];

  const proposals = reduceVaultProposalLogs(vault, logs);
  await Promise.all(
    proposals.map(async (proposal) => {
      if (proposal.status !== 'pending') return;
      const executableAt = await client.readContract({
        address: vault,
        abi: vaultReadAbi,
        functionName: 'executableAt',
        args: [proposal.data],
        blockNumber: toBlock,
      });
      if (executableAt === 0n) proposal.status = 'cleared-outside-range';
    }),
  );

  return proposals;
}
