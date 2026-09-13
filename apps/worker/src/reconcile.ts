import type { StoredExitIntent } from './store.js';
import type { ReconciliationResult } from './pipeline.js';
import {
  getAddress,
  keccak256,
  parseEventLogs,
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
    transactionHash: `0x${string}`,
  ): Promise<ReconciliationResult> => {
    const receipt = await client.getTransactionReceipt({ hash: transactionHash });
    if (receipt.status !== 'success') {
      return { ok: false, detail: { receiptStatus: receipt.status } };
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
    const mandate = await client.readContract({
      address: intent.guard,
      abi: guardAbi,
      functionName: 'mandates',
      args: [BigInt(intent.mandateId)],
      blockNumber: receipt.blockNumber,
    });
    const proposalMatches = exit.args.proposalHash === keccak256(intent.proposalData);
    const shareAmountMatches = exit.args.shares === mandate[2];
    const minimumSatisfied = exit.args.assets >= mandate[4];
    const consumed = mandate[7] === false;
    const ok = proposalMatches && shareAmountMatches && minimumSatisfied && consumed;
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
        shareAmountMatches,
        minimumSatisfied,
        consumed,
      },
    };
  };
}
