import type { StoredExitIntent } from './store.js';
import type { ReconciliationResult } from './pipeline.js';
import {
  getAddress,
  keccak256,
  parseEventLogs,
  parseAbiItem,
  type Chain,
  type PublicClient,
  type Transport,
} from 'viem';

const guardAbi = [
  {
    type: 'event',
    name: 'Exited',
    inputs: [
      { name: 'mandateId', type: 'uint256', indexed: true },
      { name: 'owner', type: 'address', indexed: true },
      { name: 'executor', type: 'address', indexed: true },
      { name: 'shares', type: 'uint256', indexed: false },
      { name: 'assets', type: 'uint256', indexed: false },
      { name: 'proposalHash', type: 'bytes32', indexed: false },
    ],
  },
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

export function createChainReconciler<
  TTransport extends Transport,
  TChain extends Chain | undefined,
>(client: PublicClient<TTransport, TChain>) {
  return async (
    intent: StoredExitIntent,
    transactionHash?: `0x${string}`,
  ): Promise<ReconciliationResult> => {
    if (!transactionHash) {
      // A consumed mandate may also mean cancellation/replacement. Only an attributable
      // Exited event can recover a missing hash; absence is never proof of no broadcast.
      try {
        const tip = await client.getBlockNumber();
        const sourceBlock = intent.proposalIdentity.split(':').at(-2);
        const start =
          sourceBlock && /^\d+$/.test(sourceBlock)
            ? BigInt(sourceBlock)
            : tip > 9_999n
              ? tip - 9_999n
              : 0n;
        for (let fromBlock = start; fromBlock <= tip; fromBlock += 10_000n) {
          const toBlock = fromBlock + 9_999n < tip ? fromBlock + 9_999n : tip;
          const logs = await client.getLogs({
            address: intent.guard,
            event: parseAbiItem(
              'event Exited(uint256 indexed mandateId, address indexed owner, address indexed executor, uint256 shares, uint256 assets, bytes32 proposalHash)',
            ),
            args: { mandateId: BigInt(intent.mandateId) },
            fromBlock,
            toBlock,
            strict: true,
          });
          transactionHash = logs.find(
            (log) => log.args.proposalHash === keccak256(intent.proposalData),
          )?.transactionHash;
          if (transactionHash) break;
        }
      } catch (error) {
        return {
          ok: false,
          pending: true,
          detail: {
            reason: 'LOG_SEARCH_FAILED',
            error: error instanceof Error ? error.message : String(error),
          },
        };
      }
      if (!transactionHash) {
        return {
          ok: false,
          noAttributableEvent: true,
          detail: { reason: 'NO_ATTRIBUTABLE_EXIT_EVENT' },
        };
      }
    }
    let receipt;
    try {
      receipt = await client.getTransactionReceipt({ hash: transactionHash });
    } catch {
      return {
        ok: false,
        pending: true,
        detail: { transactionHash, reason: 'RECEIPT_UNAVAILABLE' },
      };
    }
    if (receipt.status !== 'success') {
      return {
        ok: false,
        reverted: true,
        detail: { transactionHash, receiptStatus: receipt.status, economicEffect: 'none' },
      };
    }
    const events = parseEventLogs({ abi: guardAbi, logs: receipt.logs, eventName: 'Exited' });
    const exit = events.find(
      (event) =>
        getAddress(event.address) === getAddress(intent.guard) &&
        event.args.mandateId === BigInt(intent.mandateId),
    );
    if (!exit) {
      return {
        ok: false,
        detail: { receiptStatus: receipt.status, expectedExitEvent: false },
      };
    }
    let mandate;
    try {
      mandate = await client.readContract({
        address: intent.guard,
        abi: guardAbi,
        functionName: 'mandates',
        args: [BigInt(intent.mandateId)],
        blockNumber: receipt.blockNumber,
      });
    } catch (error) {
      return {
        ok: false,
        pending: true,
        detail: {
          transactionHash,
          reason: 'MANDATE_READ_FAILED',
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
    const proposalMatches = exit.args.proposalHash === keccak256(intent.proposalData);
    const ownerMatches = getAddress(exit.args.owner) === getAddress(mandate[0]);
    const shareAmountMatches = exit.args.shares === mandate[2];
    const minimumSatisfied = exit.args.assets >= mandate[4];
    const consumed = mandate[7] === false;
    const ok =
      proposalMatches && ownerMatches && shareAmountMatches && minimumSatisfied && consumed;
    return {
      ok,
      detail: {
        receiptStatus: receipt.status,
        blockNumber: receipt.blockNumber.toString(),
        transactionHash,
        owner: exit.args.owner,
        executor: exit.args.executor,
        shares: exit.args.shares.toString(),
        assets: exit.args.assets.toString(),
        proposalMatches,
        ownerMatches,
        shareAmountMatches,
        minimumSatisfied,
        consumed,
      },
    };
  };
}
