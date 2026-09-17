import conditionalFalse from '../../../../evidence/day-8/conditional-false.json';
import conditionalSuccess from '../../../../evidence/day-8/conditional-success.json';
import dayThree from '../../../../evidence/day-5/executions.json';

const scenario = dayThree.scenario;
const exit = dayThree.exit;

const activityLabels: Record<string, string> = {
  'deploy-official-morpho-v2-factory': 'Canonical Morpho V2 factory deployed',
  'deploy-real-morpho-exit-guard': 'Exit guard deployed',
  'create-official-morpho-v2-vault': 'Actual Morpho V2 vault created',
  'set-vault-curator': 'Controlled curator assigned',
  'set-vault-name': 'Vault name set',
  'set-vault-symbol': 'Vault symbol set',
  'set-management-fee-recipient-submit': 'Fee recipient change submitted',
  'set-management-fee-recipient-execute': 'Fee recipient configured',
  'configure-management-fee-timelock-submit': 'Fee timelock submitted',
  'configure-management-fee-timelock-execute': 'One-hour fee timelock configured',
  'approve-official-morpho-deposit': 'Test deposit approved',
  'deposit-into-official-morpho-v2': 'Test position deposited',
  'approve-real-morpho-exit-guard': 'Finite share approval granted',
  'arm-real-morpho-exit-mandate': 'Exit rule armed',
  'queue-real-morpho-fee-proposal': '2% Morpho fee proposal queued',
};

function formatFixtureUnits(value: string): string {
  return (Number(value) / 10 ** scenario.assetDecimals).toFixed(scenario.assetDecimals);
}

function formatShares(value: string): string {
  return (Number(value) / 10 ** scenario.shareDecimals).toFixed(6);
}

function formatUtc(timestamp: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: 'UTC',
  }).format(new Date(Number(timestamp) * 1_000));
}

export const dayThreeEvidence = {
  environment: conditionalSuccess.environment,
  recordedAt: new Date(conditionalSuccess.recordedAt).toISOString(),
  chain: {
    id: conditionalSuccess.chainId,
    name: 'Base Sepolia',
  },
  source: dayThree.source,
  position: {
    owner: conditionalSuccess.owner,
    factory: conditionalSuccess.factory,
    vault: conditionalSuccess.vault,
    asset: conditionalSuccess.asset,
    assetName: 'VETO Fixture USD',
    sharesBefore: formatShares(conditionalSuccess.balances.ownerSharesBefore),
    sharesAfter: formatShares(conditionalSuccess.balances.ownerSharesAfter),
  },
  instruction: {
    mandateId: conditionalSuccess.mandateId,
    guard: conditionalSuccess.guard,
    feeCeiling: '1.00%',
    shares: formatShares(conditionalSuccess.balances.ownerSharesBefore),
    minimumReturn: formatFixtureUnits(conditionalSuccess.balances.ownerAssetsAfter),
    expiresAt: formatUtc(scenario.mandateExpiresAt),
    safetyWindow: '10 minutes',
  },
  proposal: {
    currentFee: '0.00%',
    proposedFee: '2.00%',
    transactionHash: conditionalSuccess.proposalTransactionHash,
    submittedAt: formatUtc(scenario.proposalSubmittedAt),
    executableAt: formatUtc(conditionalSuccess.expectedExecutableAt),
    leadTime: '55m 12s',
  },
  result: {
    state: conditionalSuccess.workerState,
    assetsReturned: formatFixtureUnits(conditionalSuccess.balances.ownerAssetsAfter),
    guardAssets: formatFixtureUnits(conditionalSuccess.balances.guardAssetsAfter),
    executionId: conditionalSuccess.keeperHubExecutionId,
    transactionHash: conditionalSuccess.transactionHash,
    blockNumber: conditionalSuccess.blockNumber,
    gasUsed: Number(exit.gasUsed).toLocaleString('en-US'),
    includedAt: formatUtc(scenario.exitIncludedAt),
    duplicateClaimed: conditionalSuccess.duplicateClaimed,
    historicalDirectExecutionId: exit.executionId,
    historicalDirectTransactionHash: exit.transactionHash,
  },
  revokedProposal: {
    mandateId: conditionalFalse.mandateId,
    executionId: 'none (condition-false)',
    curatorRevocationTx: conditionalFalse.revocationTransactionHash,
    transactionHash: conditionalFalse.revocationTransactionHash,
    proposedFee: '2.00%',
    ownerShares: formatShares(conditionalFalse.balancesBeforeAndAfter.ownerShares),
    vaultAssets: formatFixtureUnits(conditionalFalse.balancesBeforeAndAfter.vaultAssets),
    guardAssets: formatFixtureUnits(conditionalFalse.balancesBeforeAndAfter.guardAssets),
    revertName: 'ConditionMet == false (0 != 1789551002)',
    workerState: conditionalFalse.workerState,
    balancesUnchanged: true,
    mandateStillActive: conditionalFalse.mandateStillActive,
    financialTxBroadcast: false,
    separateGuardProof: conditionalFalse.separateGuardProof,
  },
  activity: [
    ...dayThree.setup.map((entry) => ({
      label: activityLabels[entry.label] ?? entry.label,
      executionId: entry.executionId,
      transactionHash: entry.transactionHash,
      blockNumber: entry.blockNumber,
      gasUsed: Number(entry.gasUsed).toLocaleString('en-US'),
      kind: entry.label.includes('proposal') ? 'trigger' : 'setup',
    })),
    {
      label: 'KeeperHub conditional exit confirmed (Day 8)',
      executionId: conditionalSuccess.keeperHubExecutionId,
      transactionHash: conditionalSuccess.transactionHash,
      blockNumber: conditionalSuccess.blockNumber,
      gasUsed: Number(exit.gasUsed).toLocaleString('en-US'),
      kind: 'result',
    },
  ],
} as const;

export function explorerTransaction(hash: string): string {
  return `https://base-sepolia.blockscout.com/tx/${hash}`;
}

export function explorerAddress(address: string): string {
  return `https://base-sepolia.blockscout.com/address/${address}`;
}
