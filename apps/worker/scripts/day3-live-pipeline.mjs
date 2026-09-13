import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { financialOperationKey } from '@veto/core';
import { KeeperHubClient, keeperHubIdempotencyKey, serializeContractCall } from '@veto/keeperhub';
import { Pool } from 'pg';
import {
  createPublicClient,
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  getCreate2Address,
  http,
  keccak256,
  parseAbi,
  stringToHex,
} from 'viem';
import { baseSepolia } from 'viem/chains';

import { ExitPipeline } from '../dist/pipeline.js';
import { createChainReconciler } from '../dist/reconcile.js';
import { scanConfiguredMandate } from '../dist/scanner.js';
import { PostgresIntentStore } from '../dist/store.js';

const chainId = baseSepolia.id;
const singletonFactory = getAddress('0xce0042B868300000d44A59004Da54A005ffdcf9f');
const keeperHubWallet = getAddress('0x3e7a055f59c662987ae68240fd713195c30c0497');
const keeperHubApiKey = process.env.KEEPERHUB_API_KEY;
const keeperHubBaseUrl = process.env.KEEPERHUB_BASE_URL || 'https://app.keeperhub.com';
const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
const databaseUrl = process.env.DATABASE_URL;
if (!keeperHubApiKey) throw new Error('KEEPERHUB_API_KEY is required');
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../../..');
const artifactDirectory = path.join(repositoryRoot, 'contracts', 'dist');
const outputDirectory = path.join(repositoryRoot, '.local-data', 'day3-live');
fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });

const artifact = (name) =>
  JSON.parse(fs.readFileSync(path.join(artifactDirectory, `${name}.json`), 'utf8'));
const factoryArtifact = artifact('ControlledVaultV2Factory');
const assetArtifact = artifact('FixtureAsset');
const vaultArtifact = artifact('ControlledVaultV2Fixture');
const guardArtifact = artifact('VetoExitGuard');
const singletonAbi = parseAbi([
  'function deploy(bytes initCode, bytes32 salt) returns (address payable createdContract)',
]);
const client = createPublicClient({
  chain: baseSepolia,
  transport: http(rpcUrl),
  cacheTime: 0,
});
const keeperHub = new KeeperHubClient({
  apiKey: keeperHubApiKey,
  baseUrl: keeperHubBaseUrl,
});

async function waitForExecution(executionId) {
  for (let attempt = 0; attempt < 45; attempt += 1) {
    const execution = await keeperHub.getExecution(executionId);
    if (execution.state !== 'pending') return execution;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`SETUP_EXECUTION_DID_NOT_SETTLE:${executionId}`);
}

async function setupCall(label, request) {
  const resultPath = path.join(outputDirectory, `${label}.json`);
  if (fs.existsSync(resultPath)) {
    const recorded = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    if (recorded.transactionHash) {
      const receipt = await client.getTransactionReceipt({ hash: recorded.transactionHash });
      if (receipt.status === 'success') return recorded;
    }
  }

  await keeperHub.simulateContractCall(request);
  const serialized = serializeContractCall(request);
  const execution = await keeperHub.submitContractCall(
    serialized,
    keeperHubIdempotencyKey(`day3-setup:${chainId}:${label}`),
  );
  const terminal = await waitForExecution(execution.executionId);
  if (terminal.state !== 'completed' || !terminal.transactionHash) {
    throw new Error(`SETUP_EXECUTION_FAILED:${label}:${terminal.state}`);
  }
  const receipt = await client.getTransactionReceipt({ hash: terminal.transactionHash });
  if (receipt.status !== 'success') throw new Error(`SETUP_RECEIPT_REVERTED:${label}`);
  const recorded = {
    label,
    executionId: terminal.executionId,
    transactionHash: terminal.transactionHash,
    blockNumber: receipt.blockNumber.toString(),
    gasUsed: receipt.gasUsed.toString(),
  };
  fs.writeFileSync(resultPath, `${JSON.stringify(recorded, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ event: 'day3_setup_complete', ...recorded }));
  return recorded;
}

async function deployDeterministic(label, initCode, saltLabel) {
  const salt = keccak256(stringToHex(saltLabel));
  const address = getCreate2Address({ from: singletonFactory, salt, bytecode: initCode });
  if ((await client.getCode({ address })) === undefined) {
    await setupCall(label, {
      contractAddress: singletonFactory,
      chainId,
      functionName: 'deploy',
      functionArgs: JSON.stringify([initCode, salt]),
      abi: JSON.stringify(singletonAbi),
      gasLimitMultiplier: '1.3',
    });
  }
  if ((await client.getCode({ address })) === undefined) {
    throw new Error(`DEPLOYMENT_CODE_MISSING:${label}`);
  }
  return address;
}

const authenticated = await fetch(new URL('/api/user', keeperHubBaseUrl), {
  headers: { authorization: `Bearer ${keeperHubApiKey}` },
  signal: AbortSignal.timeout(15_000),
});
if (!authenticated.ok) throw new Error(`KEEPERHUB_AUTH_FAILED:${authenticated.status}`);
const profile = await authenticated.json();
const returnedWallet =
  profile.walletAddress || profile.wallet?.address || profile.organization?.walletAddress;
if (returnedWallet && getAddress(returnedWallet) !== keeperHubWallet) {
  throw new Error('KEEPERHUB_WALLET_CHANGED');
}

const factoryInitCode = encodeDeployData({
  abi: factoryArtifact.abi,
  bytecode: `0x${factoryArtifact.evm.bytecode.object}`,
});
const controlledFactory = await deployDeterministic(
  'deploy-controlled-factory',
  factoryInitCode,
  'VETO Day3 ControlledVaultV2Factory 2026-09-13 v1',
);
const guardInitCode = encodeDeployData({
  abi: guardArtifact.abi,
  bytecode: `0x${guardArtifact.evm.bytecode.object}`,
  args: [controlledFactory],
});
const guard = await deployDeterministic(
  'deploy-exit-guard',
  guardInitCode,
  'VETO Day3 VetoExitGuard 2026-09-13 v1',
);

let fixtureVault = await client.readContract({
  address: controlledFactory,
  abi: factoryArtifact.abi,
  functionName: 'latestVault',
});
let fixtureResult;
if (fixtureVault === '0x0000000000000000000000000000000000000000') {
  fixtureResult = await setupCall('create-fixture', {
    contractAddress: controlledFactory,
    chainId,
    functionName: 'create',
    functionArgs: JSON.stringify(['10000000', '3600']),
    abi: JSON.stringify(factoryArtifact.abi),
    gasLimitMultiplier: '1.3',
  });
  fixtureVault = await client.readContract({
    address: controlledFactory,
    abi: factoryArtifact.abi,
    functionName: 'latestVault',
  });
}
fixtureVault = getAddress(fixtureVault);
const fixtureAsset = getAddress(
  await client.readContract({
    address: controlledFactory,
    abi: factoryArtifact.abi,
    functionName: 'latestAsset',
  }),
);
let ownerShares = await client.readContract({
  address: fixtureVault,
  abi: vaultArtifact.abi,
  functionName: 'balanceOf',
  args: [keeperHubWallet],
});
let ownerAssets = await client.readContract({
  address: fixtureAsset,
  abi: assetArtifact.abi,
  functionName: 'balanceOf',
  args: [keeperHubWallet],
});

if (ownerShares === 0n && ownerAssets === 10_000_000n) {
  await setupCall('approve-fixture-deposit', {
    contractAddress: fixtureAsset,
    chainId,
    functionName: 'approve',
    functionArgs: JSON.stringify([fixtureVault, '10000000']),
    abi: JSON.stringify(assetArtifact.abi),
  });
  await setupCall('deposit-fixture-assets', {
    contractAddress: fixtureVault,
    chainId,
    functionName: 'deposit',
    functionArgs: JSON.stringify(['10000000', keeperHubWallet]),
    abi: JSON.stringify(vaultArtifact.abi),
  });
  ownerShares = 10_000_000n;
  ownerAssets = 0n;
}

const nextMandateId = await client.readContract({
  address: guard,
  abi: guardArtifact.abi,
  functionName: 'nextMandateId',
});
const mandateId = nextMandateId === 0n ? 0n : nextMandateId - 1n;
if (nextMandateId === 0n) {
  await setupCall('approve-exit-guard', {
    contractAddress: fixtureVault,
    chainId,
    functionName: 'approve',
    functionArgs: JSON.stringify([guard, ownerShares.toString()]),
    abi: JSON.stringify(vaultArtifact.abi),
  });
  const block = await client.getBlock();
  await setupCall('arm-exit-mandate', {
    contractAddress: guard,
    chainId,
    functionName: 'arm',
    functionArgs: JSON.stringify([
      fixtureVault,
      ownerShares.toString(),
      (10n ** 16n / 31_536_000n).toString(),
      (ownerShares - 1n).toString(),
      (block.timestamp + 86_400n).toString(),
      '300',
    ]),
    abi: JSON.stringify(guardArtifact.abi),
  });
}

const proposalData = encodeFunctionData({
  abi: vaultArtifact.abi,
  functionName: 'setManagementFee',
  args: [(2n * 10n ** 16n) / 31_536_000n],
});
let executableAt = await client.readContract({
  address: fixtureVault,
  abi: vaultArtifact.abi,
  functionName: 'executableAt',
  args: [proposalData],
});
let proposalResult;
if (executableAt === 0n && ownerShares > 0n) {
  proposalResult = await setupCall('queue-fee-proposal', {
    contractAddress: fixtureVault,
    chainId,
    functionName: 'submit',
    functionArgs: JSON.stringify([proposalData]),
    abi: JSON.stringify(vaultArtifact.abi),
  });
  executableAt = await client.readContract({
    address: fixtureVault,
    abi: vaultArtifact.abi,
    functionName: 'executableAt',
    args: [proposalData],
  });
}
proposalResult ??= JSON.parse(
  fs.readFileSync(path.join(outputDirectory, 'queue-fee-proposal.json'), 'utf8'),
);

const pool = new Pool({ connectionString: databaseUrl });
const store = new PostgresIntentStore(pool);
for (const migration of ['0001_exit_intents.sql', '0002_proposal_decisions.sql']) {
  await store.applyMigration(
    fs.readFileSync(path.join(repositoryRoot, 'db', 'migrations', migration), 'utf8'),
  );
}
const scannerConfig = {
  chainId,
  factory: controlledFactory,
  vault: fixtureVault,
  guard,
  mandateId,
  startBlock: BigInt(proposalResult.blockNumber),
  confirmationDepth: 0n,
  reorgRewindBlocks: 12n,
};
const scan = await scanConfiguredMandate({ client, store, config: scannerConfig });
console.log(
  JSON.stringify({
    event: 'day3_scan_complete',
    proposals: scan.proposals,
    decisionsRecorded: scan.decisionsRecorded,
    readyCreated: scan.readyCreated,
  }),
);

const pipeline = new ExitPipeline(store, keeperHub, createChainReconciler(client));
let pipelineResult;
for (let attempt = 0; attempt < 45; attempt += 1) {
  pipelineResult = await pipeline.runOnce(`day3-live-${process.pid}`);
  if (!pipelineResult || ['EXITED', 'BLOCKED', 'DISPUTED'].includes(pipelineResult.state)) break;
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}
const operationKey = financialOperationKey({ chainId, guard, mandateId });
const stored = await store.get(operationKey);
if (!stored || stored.state !== 'EXITED' || !stored.transactionHash || !stored.executionId) {
  throw new Error(`DAY3_PIPELINE_NOT_EXITED:${stored?.state ?? 'missing'}`);
}
const duplicateRun = await pipeline.runOnce(`day3-duplicate-${process.pid}`);
if (duplicateRun !== undefined) throw new Error('DAY3_DUPLICATE_WAS_CLAIMED');

ownerShares = await client.readContract({
  address: fixtureVault,
  abi: vaultArtifact.abi,
  functionName: 'balanceOf',
  args: [keeperHubWallet],
});
ownerAssets = await client.readContract({
  address: fixtureAsset,
  abi: assetArtifact.abi,
  functionName: 'balanceOf',
  args: [keeperHubWallet],
});
const guardAssets = await client.readContract({
  address: fixtureAsset,
  abi: assetArtifact.abi,
  functionName: 'balanceOf',
  args: [guard],
});
if (ownerShares !== 0n || ownerAssets !== 10_000_000n || guardAssets !== 0n) {
  throw new Error('DAY3_FINAL_BALANCE_MISMATCH');
}
const history = await pool.query(
  'SELECT from_state, to_state, detail_json, created_at FROM exit_intent_events WHERE operation_key = $1 ORDER BY event_id',
  [operationKey],
);
const evidence = {
  evidence: 'day3-live-pipeline',
  environment: 'controlled Base Sepolia fixture',
  chainId,
  keeperHubWallet,
  controlledFactory,
  fixtureVault,
  fixtureAsset,
  guard,
  mandateId: mandateId.toString(),
  proposalData,
  executableAt: executableAt.toString(),
  operationKey,
  idempotencyKey: stored.idempotencyKey,
  executionId: stored.executionId,
  transactionHash: stored.transactionHash,
  finalState: stored.state,
  ownerShares: ownerShares.toString(),
  ownerAssets: ownerAssets.toString(),
  guardAssets: guardAssets.toString(),
  duplicateClaimed: false,
  reconciliation: stored.reconciliation,
  transitions: history.rows,
  fixtureCreation: fixtureResult,
};
fs.writeFileSync(
  path.join(outputDirectory, 'evidence.json'),
  `${JSON.stringify(evidence, null, 2)}\n`,
  {
    mode: 0o600,
  },
);
console.log(
  JSON.stringify({
    evidence: evidence.evidence,
    chainId,
    executionId: stored.executionId,
    transactionHash: stored.transactionHash,
    ownerShares: evidence.ownerShares,
    ownerAssets: evidence.ownerAssets,
    guardAssets: evidence.guardAssets,
    duplicateClaimed: evidence.duplicateClaimed,
  }),
);
await pool.end();
