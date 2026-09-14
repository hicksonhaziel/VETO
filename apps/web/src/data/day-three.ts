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

function formatLeadTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}

export const dayThreeEvidence = {
  environment: dayThree.environment,
  recordedAt: new Date(dayThree.recordedAt).toISOString(),
  chain: {
    id: dayThree.chainId,
    name: 'Base Sepolia',
  },
  source: dayThree.source,
  position: {
    owner: scenario.owner,
    factory: scenario.factory,
    vault: scenario.vault,
    asset: scenario.asset,
    assetName: scenario.assetName,
    sharesBefore: formatShares(scenario.shares),
    sharesAfter: formatShares(exit.ownerShares),
  },
  instruction: {
    mandateId: scenario.mandateId,
    guard: scenario.guard,
    feeCeiling: `${scenario.feeCeilingPercent}%`,
    shares: formatShares(scenario.shares),
    minimumReturn: formatFixtureUnits(scenario.minimumAssets),
    expiresAt: formatUtc(scenario.mandateExpiresAt),
    safetyWindow: `${scenario.safetySeconds / 60} minutes`,
  },
  proposal: {
    currentFee: `${scenario.currentFeePercent}%`,
    proposedFee: `${scenario.proposedFeePercent}%`,
    transactionHash: scenario.proposalTransactionHash,
    submittedAt: formatUtc(scenario.proposalSubmittedAt),
    executableAt: formatUtc(scenario.proposalExecutableAt),
    leadTime: formatLeadTime(
      Number(scenario.proposalExecutableAt) - Number(scenario.exitIncludedAt),
    ),
  },
  result: {
    state: 'EXITED',
    assetsReturned: formatFixtureUnits(exit.ownerAssets),
    guardAssets: formatFixtureUnits(exit.guardAssets),
    executionId: exit.executionId,
    transactionHash: exit.transactionHash,
    blockNumber: exit.blockNumber,
    gasUsed: Number(exit.gasUsed).toLocaleString('en-US'),
    includedAt: formatUtc(scenario.exitIncludedAt),
    duplicateClaimed: exit.duplicateClaimed,
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
      label: 'Owner exit confirmed',
      executionId: exit.executionId,
      transactionHash: exit.transactionHash,
      blockNumber: exit.blockNumber,
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
