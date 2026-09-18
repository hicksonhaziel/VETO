import { financialOperationKey } from '@veto/core';
import {
  proposalIdentity,
  scanVaultProposals,
  setManagementFeeSelector,
  setPerformanceFeeSelector,
  verifyManagementFeeProposal,
  verifyPerformanceFeeProposal,
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

const guardV2ReadAbi = [
  {
    type: 'function',
    name: 'mandates',
    stateMutability: 'view',
    inputs: [{ name: 'mandateId', type: 'uint256' }],
    outputs: [
      { name: 'owner', type: 'address' },
      { name: 'vault', type: 'address' },
      { name: 'shares', type: 'uint256' },
      { name: 'minAssets', type: 'uint256' },
      { name: 'expiresAt', type: 'uint256' },
      { name: 'safetySeconds', type: 'uint256' },
      { name: 'active', type: 'bool' },
      { name: 'policyFlags', type: 'uint256' },
      { name: 'maxManagementFee', type: 'uint256' },
      { name: 'maxPerformanceFee', type: 'uint256' },
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
  guardVersion?: 'v1' | 'v2';
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

  let mandateOwner: Address;
  let mandateVault: Address;
  let mandateSafetySeconds: bigint;
  let mandateActive: boolean;
  let policyFlags: bigint = 1n; // default V1 is management fee
  let maxManagementFee: bigint = 0n;
  let maxPerformanceFee: bigint = 0n;

  if (config.guardVersion === 'v2') {
    const mandateV2 = await client.readContract({
      address: config.guard,
      abi: guardV2ReadAbi,
      functionName: 'mandates',
      args: [config.mandateId],
      blockNumber: toBlock,
    });
    mandateOwner = mandateV2[0];
    mandateVault = mandateV2[1];
    mandateSafetySeconds = mandateV2[5];
    mandateActive = mandateV2[6];
    policyFlags = mandateV2[7];
    maxManagementFee = mandateV2[8];
    maxPerformanceFee = mandateV2[9];
  } else {
    const mandateV1 = await client.readContract({
      address: config.guard,
      abi: guardReadAbi,
      functionName: 'mandates',
      args: [config.mandateId],
      blockNumber: toBlock,
    });
    mandateOwner = mandateV1[0];
    mandateVault = mandateV1[1];
    maxManagementFee = mandateV1[3];
    mandateSafetySeconds = mandateV1[6];
    mandateActive = mandateV1[7];
  }

  const proposals = await scanVaultProposals({
    client,
    vault: config.vault,
    fromBlock,
    toBlock,
  });
  let readyCreated = 0;
  let decisionsRecorded = 0;

  for (const proposal of proposals) {
    const identity = proposalIdentity(config.chainId, proposal);
    const operationKey = financialOperationKey({
      chainId: config.chainId,
      guard: config.guard,
      mandateId: config.mandateId,
      proposalIdentity: identity,
    });
    let decision: string = proposal.status;
    let assessment: Record<string, unknown> = { status: proposal.status };

    if (!mandateActive) {
      decision = 'mandate-inactive';
      assessment = { status: proposal.status, active: false };
    } else if (getAddress(mandateVault) !== getAddress(config.vault)) {
      decision = 'mandate-vault-mismatch';
      assessment = { status: proposal.status, mandateVault };
    } else if (proposal.status === 'pending') {
      let verified: { eligible: boolean; reason: string } | undefined;

      if (proposal.selector.toLowerCase() === setManagementFeeSelector.toLowerCase()) {
        verified = await verifyManagementFeeProposal({
          client,
          factory: config.factory,
          vault: config.vault,
          data: proposal.data,
          maxFeePerSecond: maxManagementFee,
          safetySeconds: mandateSafetySeconds,
          expectedExecutableAt: proposal.executableAt,
          blockNumber: toBlock,
        });
      } else if (proposal.selector.toLowerCase() === setPerformanceFeeSelector.toLowerCase()) {
        verified = await verifyPerformanceFeeProposal({
          client,
          factory: config.factory,
          vault: config.vault,
          data: proposal.data,
          maxPerformanceFeeWad: maxPerformanceFee,
          safetySeconds: mandateSafetySeconds,
          expectedExecutableAt: proposal.executableAt,
          policyEnabled: (policyFlags & 2n) !== 0n,
          blockNumber: toBlock,
        });
      } else {
        decision = 'unsupported-proposal';
        assessment = { status: proposal.status, selector: proposal.selector };
      }

      if (verified) {
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
