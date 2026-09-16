import { financialOperationKey } from '@veto/core';
import {
  proposalIdentity,
  scanManagementFeeProposals,
  verifyManagementFeeProposal,
} from '@veto/morpho-v2';
import { getAddress, type Address, type Chain, type PublicClient, type Transport } from 'viem';

import { buildReadyExitIntent } from './candidate.js';
import { PostgresIntentStore } from './store.js';

const guardReadAbi = [
  {
    type: 'function',
    name: 'mandates',
    stateMutability: 'view',
    inputs: [{ name: 'mandateId', type: 'uint256' }],
    outputs: [
      { name: 'owner', type: 'address' },
      { name: 'vault', type: 'address' },
      { name: 'shares', type: 'uint256' },
      { name: 'maxFeePerSecond', type: 'uint256' },
      { name: 'minAssets', type: 'uint256' },
      { name: 'expiresAt', type: 'uint256' },
      { name: 'safetySeconds', type: 'uint256' },
      { name: 'active', type: 'bool' },
    ],
  },
] as const;

const MAX_LOG_BLOCK_RANGE = 9_999n;

function assessmentJson(value: object): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(value, (_, item: unknown) =>
      typeof item === 'bigint' ? item.toString() : item,
    ),
  ) as Record<string, unknown>;
}

export type MorphoScannerConfig = {
  chainId: number;
  factory: Address;
  vault: Address;
  guard: Address;
  mandateId: bigint;
  startBlock: bigint;
  confirmationDepth: bigint;
  reorgRewindBlocks: bigint;
  executionMode?: 'direct' | 'conditional';
};

export type ScanResult = {
  fromBlock?: bigint;
  toBlock?: bigint;
  proposals: number;
  readyCreated: number;
  decisionsRecorded: number;
  rewoundForReorg: boolean;
};

export async function scanConfiguredMandate<
  TTransport extends Transport,
  TChain extends Chain | undefined,
>(options: {
  client: PublicClient<TTransport, TChain>;
  store: PostgresIntentStore;
  config: MorphoScannerConfig;
}): Promise<ScanResult> {
  const { client, store, config } = options;
  const latestBlock = await client.getBlockNumber();
  if (latestBlock < config.confirmationDepth) {
    return { proposals: 0, readyCreated: 0, decisionsRecorded: 0, rewoundForReorg: false };
  }
  const confirmedToBlock = latestBlock - config.confirmationDepth;
  const checkpoint = await store.getManagedRuleCheckpoint({
    chainId: config.chainId,
    guard: config.guard,
    mandateId: config.mandateId,
  });
  let fromBlock = checkpoint?.nextBlock ?? config.startBlock;
  let rewoundForReorg = false;

  if (checkpoint?.lastBlockHash && checkpoint.nextBlock > 0n) {
    const previousBlock = await client.getBlock({ blockNumber: checkpoint.nextBlock - 1n });
    if (String(previousBlock.hash).toLowerCase() !== checkpoint.lastBlockHash.toLowerCase()) {
      const rewindFrom =
        checkpoint.nextBlock > config.reorgRewindBlocks
          ? checkpoint.nextBlock - config.reorgRewindBlocks
          : config.startBlock;
      fromBlock = rewindFrom > config.startBlock ? rewindFrom : config.startBlock;
      rewoundForReorg = true;
    }
  }
  const rangeTip = fromBlock + MAX_LOG_BLOCK_RANGE;
  const toBlock = rangeTip < confirmedToBlock ? rangeTip : confirmedToBlock;
  if (fromBlock > toBlock) {
    return {
      fromBlock,
      toBlock,
      proposals: 0,
      readyCreated: 0,
      decisionsRecorded: 0,
      rewoundForReorg,
    };
  }

  const mandate = await client.readContract({
    address: config.guard,
    abi: guardReadAbi,
    functionName: 'mandates',
    args: [config.mandateId],
    blockNumber: toBlock,
  });
  const operationKey = financialOperationKey({
    chainId: config.chainId,
    guard: config.guard,
    mandateId: config.mandateId,
  });
  const proposals = await scanManagementFeeProposals({
    client,
    vault: config.vault,
    fromBlock,
    toBlock,
  });
  let readyCreated = 0;
  let decisionsRecorded = 0;

  for (const proposal of proposals) {
    const identity = proposalIdentity(config.chainId, proposal);
    let decision: string = proposal.status;
    let assessment: Record<string, unknown> = { status: proposal.status };

    if (!mandate[7]) {
      decision = 'mandate-inactive';
      assessment = { status: proposal.status, active: false };
    } else if (getAddress(mandate[1]) !== getAddress(config.vault)) {
      decision = 'mandate-vault-mismatch';
      assessment = { status: proposal.status, mandateVault: mandate[1] };
    } else if (proposal.status === 'pending') {
      const verified = await verifyManagementFeeProposal({
        client,
        factory: config.factory,
        vault: config.vault,
        data: proposal.data,
        maxFeePerSecond: mandate[3],
        safetySeconds: mandate[6],
        expectedExecutableAt: proposal.executableAt,
        blockNumber: toBlock,
      });
      decision = verified.reason;
      assessment = assessmentJson(verified);
      if (verified.eligible) {
        const ready = buildReadyExitIntent({
          chainId: config.chainId,
          vault: config.vault,
          guard: config.guard,
          mandateId: config.mandateId,
          proposalIdentity: identity,
          proposalData: proposal.data,
          expectedExecutableAt: proposal.executableAt,
          assessment: verified,
          executionMode: config.executionMode,
        });
        if (await store.createReady(ready)) readyCreated += 1;
      }
    }

    await store.recordProposalDecision({
      proposalIdentity: identity,
      operationKey,
      chainId: config.chainId,
      vault: config.vault,
      mandateId: config.mandateId,
      decision,
      assessment,
      sourceBlock: proposal.submittedAtBlock,
      sourceTransactionHash: proposal.submitTransactionHash,
    });
    decisionsRecorded += 1;
  }

  const scannedTip = await client.getBlock({ blockNumber: toBlock });
  if (!scannedTip.hash) throw new Error('SCANNED_BLOCK_HASH_MISSING');
  await store.saveManagedRuleCheckpoint({
    chainId: config.chainId,
    guard: config.guard,
    mandateId: config.mandateId,
    nextBlock: toBlock + 1n,
    lastBlockHash: scannedTip.hash,
  });
  return {
    fromBlock,
    toBlock,
    proposals: proposals.length,
    readyCreated,
    decisionsRecorded,
    rewoundForReorg,
  };
}
