import dayThree from '../../../../evidence/day-3/executions.json';

const scenario = dayThree.scenario;
const exit = dayThree.exit;

const activityLabels: Record<string, string> = {
  'deploy-controlled-factory': 'Controlled factory deployed',
  'deploy-exit-guard': 'Exit guard deployed',
  'create-fixture': 'Test vault created',
  'approve-fixture-deposit': 'Deposit approved',
  'deposit-fixture-assets': 'Position funded',
  'approve-exit-guard': 'Finite share approval granted',
  'arm-exit-mandate': 'Exit rule armed',
  'queue-fee-proposal': '2% fee proposal queued',
};

function formatFixtureUnits(value: string): string {
  return (Number(value) / 10 ** scenario.assetDecimals).toFixed(scenario.assetDecimals);
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
  position: {
    owner: scenario.owner,
    vault: scenario.vault,
    asset: scenario.asset,
    assetName: scenario.assetName,
    sharesBefore: formatFixtureUnits(scenario.shares),
    sharesAfter: formatFixtureUnits(exit.ownerShares),
  },
  instruction: {
    mandateId: scenario.mandateId,
    guard: scenario.guard,
    feeCeiling: `${scenario.feeCeilingPercent}%`,
    shares: formatFixtureUnits(scenario.shares),
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
