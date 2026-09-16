import { createHash } from 'node:crypto';
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
  toFunctionSelector,
} from 'viem';
import { baseSepolia } from 'viem/chains';

import {
  canonicalFactoryRuntimeSha256,
  canonicalVaultRuntimeSha256,
  compileOfficialMorphoVaultV2,
  morphoVaultV2Commit,
  morphoVaultV2Release,
} from '../../../contracts/scripts/compile-official-morpho-v2.mjs';
import { ExitPipeline } from '../dist/pipeline.js';
import { createChainReconciler } from '../dist/reconcile.js';
import { scanConfiguredMandate } from '../dist/scanner.js';
import { PostgresIntentStore } from '../dist/store.js';

const chainId = baseSepolia.id;
const singletonFactory = getAddress('0xce0042B868300000d44A59004Da54A005ffdcf9f');
const keeperHubWallet = getAddress('0x3e7a055f59c662987ae68240fd713195c30c0497');
const fixtureAsset = getAddress('0xEeae78be065258b11119D43C91c975a92A3aD6dc');
const depositAssets = 10_000_000n;
const feeTimelockSeconds = 3_600n;
const safetySeconds = 300n;
const feeCeiling = 10n ** 16n / 31_536_000n;
const proposedFee = (2n * 10n ** 16n) / 31_536_000n;
const keeperHubApiKey = process.env.KEEPERHUB_API_KEY;
const keeperHubBaseUrl = process.env.KEEPERHUB_BASE_URL || 'https://app.keeperhub.com';
const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
const databaseUrl = process.env.DATABASE_URL;
const executionMode = process.env.KEEPERHUB_EXECUTION_MODE || 'direct';
if (!['direct', 'conditional'].includes(executionMode)) {
  throw new Error('INVALID_KEEPERHUB_EXECUTION_MODE');
}
if (!keeperHubApiKey) throw new Error('KEEPERHUB_API_KEY is required');
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../../..');
const artifactDirectory = path.join(repositoryRoot, 'contracts', 'dist');
const evidenceRun = process.env.VETO_EVIDENCE_RUN || 'real-morpho-live';
const outputDirectory = path.join(repositoryRoot, '.local-data', evidenceRun);
fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });

const singletonAbi = parseAbi([
  'function deploy(bytes initCode, bytes32 salt) returns (address payable createdContract)',
]);
const tokenAbi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);
const guardArtifact = JSON.parse(
  fs.readFileSync(path.join(artifactDirectory, 'VetoExitGuard.json'), 'utf8'),
);
const client = createPublicClient({
  chain: baseSepolia,
  transport: http(rpcUrl),
  cacheTime: 0,
});
const keeperHub = new KeeperHubClient({ apiKey: keeperHubApiKey, baseUrl: keeperHubBaseUrl });

function sha256Code(code) {
  return createHash('sha256')
    .update(Buffer.from(code.slice(2), 'hex'))
    .digest('hex');
}

function normalizedRuntimeHash(code, artifact) {
  const normalized = Buffer.from(code.slice(2), 'hex');
  for (const references of Object.values(artifact.evm.deployedBytecode.immutableReferences ?? {})) {
    for (const { start, length } of references) normalized.fill(0, start, start + length);
  }
  return createHash('sha256').update(normalized).digest('hex');
}

function readRecorded(label) {
  const resultPath = path.join(outputDirectory, `${label}.json`);
  return fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8')) : undefined;
}

async function waitForExecution(executionId) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const execution = await keeperHub.getExecution(executionId);
    if (execution.state !== 'pending') return execution;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`SETUP_EXECUTION_DID_NOT_SETTLE:${executionId}`);
}

async function setupCall(label, request) {
  const resultPath = path.join(outputDirectory, `${label}.json`);
  const recorded = readRecorded(label);
  if (recorded?.transactionHash) {
    const receipt = await client.getTransactionReceipt({ hash: recorded.transactionHash });
    if (receipt.status === 'success') return recorded;
  }

  await keeperHub.simulateContractCall(request);
  const serialized = serializeContractCall(request);
  const execution = await keeperHub.submitContractCall(
    serialized,
    keeperHubIdempotencyKey(`real-morpho-setup:${chainId}:${evidenceRun}:${label}`),
  );
  const terminal = await waitForExecution(execution.executionId);
  if (terminal.state !== 'completed' || !terminal.transactionHash) {
    throw new Error(`SETUP_EXECUTION_FAILED:${label}:${terminal.state}`);
  }
  const receipt = await client.getTransactionReceipt({ hash: terminal.transactionHash });
  if (receipt.status !== 'success') throw new Error(`SETUP_RECEIPT_REVERTED:${label}`);
  const result = {
    label,
    executionId: terminal.executionId,
    transactionHash: terminal.transactionHash,
    blockNumber: receipt.blockNumber.toString(),
    gasUsed: receipt.gasUsed.toString(),
  };
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ event: 'real_morpho_setup_complete', ...result }));
  return result;
}

async function deployDeterministic(label, initCode, saltLabel, expectedRuntimeHash) {
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
  const code = await client.getCode({ address });
  if (!code) throw new Error(`DEPLOYMENT_CODE_MISSING:${label}`);
  const runtimeHash = sha256Code(code);
  if (expectedRuntimeHash && runtimeHash !== expectedRuntimeHash) {
    throw new Error(`DEPLOYMENT_RUNTIME_HASH_MISMATCH:${label}`);
  }
  return { address, runtimeHash };
}

async function submitThenExecute({ label, vault, vaultAbi, data, functionName, functionArgs }) {
  let executableAt = await client.readContract({
    address: vault,
    abi: vaultAbi,
    functionName: 'executableAt',
    args: [data],
  });
  if (executableAt === 0n) {
    await setupCall(`${label}-submit`, {
      contractAddress: vault,
      chainId,
      functionName: 'submit',
      functionArgs: JSON.stringify([data]),
      abi: JSON.stringify(vaultAbi),
    });
    executableAt = await client.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'executableAt',
      args: [data],
    });
  }
  if (executableAt === 0n) throw new Error(`TIMELOCK_SUBMISSION_MISSING:${label}`);
  return setupCall(`${label}-execute`, {
    contractAddress: vault,
    chainId,
    functionName,
    functionArgs: JSON.stringify(functionArgs),
    abi: JSON.stringify(vaultAbi),
  });
}

async function fetchKeeperHubProfile() {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(new URL('/api/user', keeperHubBaseUrl), {
        headers: { authorization: `Bearer ${keeperHubApiKey}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`KEEPERHUB_AUTH_FAILED:${response.status}`);
      return response.json();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < 5) {
        await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** attempt));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('KEEPERHUB_AUTH_FAILED');
}

const profile = await fetchKeeperHubProfile();
const returnedWallet =
  profile.walletAddress || profile.wallet?.address || profile.organization?.walletAddress;
if (!returnedWallet || getAddress(returnedWallet) !== keeperHubWallet) {
  throw new Error('KEEPERHUB_WALLET_CHANGED');
}

const [assetSymbol, assetDecimals, ownerAssetsAtStart, morpho] = await Promise.all([
  client.readContract({ address: fixtureAsset, abi: tokenAbi, functionName: 'symbol' }),
  client.readContract({ address: fixtureAsset, abi: tokenAbi, functionName: 'decimals' }),
  client.readContract({
    address: fixtureAsset,
    abi: tokenAbi,
    functionName: 'balanceOf',
    args: [keeperHubWallet],
  }),
  compileOfficialMorphoVaultV2(),
]);
if (assetSymbol !== 'vfUSD' || assetDecimals !== 6) throw new Error('UNEXPECTED_FIXTURE_ASSET');

const factoryInitCode = `0x${morpho.factory.evm.bytecode.object}`;
const factoryDeployment = await deployDeterministic(
  'deploy-official-morpho-v2-factory',
  factoryInitCode,
  'VETO official Morpho Vault V2 factory 2025-09-15 Base Sepolia v1',
  canonicalFactoryRuntimeSha256,
);
const morphoFactory = factoryDeployment.address;

const guardInitCode = encodeDeployData({
  abi: guardArtifact.abi,
  bytecode: `0x${guardArtifact.evm.bytecode.object}`,
  args: [morphoFactory],
});
const guardDeployment = await deployDeterministic(
  'deploy-real-morpho-exit-guard',
  guardInitCode,
  'VETO real Morpho exit guard Base Sepolia v1',
);
const guard = guardDeployment.address;

const vaultSalt = keccak256(stringToHex('VETO real Morpho Vault V2 Base Sepolia v1'));
let vault = await client.readContract({
  address: morphoFactory,
  abi: morpho.factory.abi,
  functionName: 'vaultV2',
  args: [keeperHubWallet, fixtureAsset, vaultSalt],
});
let vaultCreation = readRecorded('create-official-morpho-v2-vault');
if (vault === '0x0000000000000000000000000000000000000000') {
  vaultCreation = await setupCall('create-official-morpho-v2-vault', {
    contractAddress: morphoFactory,
    chainId,
    functionName: 'createVaultV2',
    functionArgs: JSON.stringify([keeperHubWallet, fixtureAsset, vaultSalt]),
    abi: JSON.stringify(morpho.factory.abi),
    gasLimitMultiplier: '1.3',
  });
  vault = await client.readContract({
    address: morphoFactory,
    abi: morpho.factory.abi,
    functionName: 'vaultV2',
    args: [keeperHubWallet, fixtureAsset, vaultSalt],
  });
}
vault = getAddress(vault);
const vaultCode = await client.getCode({ address: vault });
if (!vaultCode || normalizedRuntimeHash(vaultCode, morpho.vault) !== canonicalVaultRuntimeSha256) {
  throw new Error('OFFICIAL_MORPHO_VAULT_RUNTIME_HASH_MISMATCH');
}
const factoryApproved = await client.readContract({
  address: morphoFactory,
  abi: morpho.factory.abi,
  functionName: 'isVaultV2',
  args: [vault],
});
if (!factoryApproved) throw new Error('OFFICIAL_MORPHO_FACTORY_REJECTED_VAULT');

const vaultAbi = morpho.vault.abi;
if (
  getAddress(
    await client.readContract({ address: vault, abi: vaultAbi, functionName: 'curator' }),
  ) !== keeperHubWallet
) {
  await setupCall('set-vault-curator', {
    contractAddress: vault,
    chainId,
    functionName: 'setCurator',
    functionArgs: JSON.stringify([keeperHubWallet]),
    abi: JSON.stringify(vaultAbi),
  });
}
if ((await client.readContract({ address: vault, abi: vaultAbi, functionName: 'name' })) === '') {
  await setupCall('set-vault-name', {
    contractAddress: vault,
    chainId,
    functionName: 'setName',
    functionArgs: JSON.stringify(['VETO Morpho V2 Public Proof']),
    abi: JSON.stringify(vaultAbi),
  });
  await setupCall('set-vault-symbol', {
    contractAddress: vault,
    chainId,
    functionName: 'setSymbol',
    functionArgs: JSON.stringify(['vmV2']),
    abi: JSON.stringify(vaultAbi),
  });
}

let managementFeeRecipient = getAddress(
  await client.readContract({
    address: vault,
    abi: vaultAbi,
    functionName: 'managementFeeRecipient',
  }),
);
if (managementFeeRecipient !== keeperHubWallet) {
  const recipientData = encodeFunctionData({
    abi: vaultAbi,
    functionName: 'setManagementFeeRecipient',
    args: [keeperHubWallet],
  });
  await submitThenExecute({
    label: 'set-management-fee-recipient',
    vault,
    vaultAbi,
    data: recipientData,
    functionName: 'setManagementFeeRecipient',
    functionArgs: [keeperHubWallet],
  });
  managementFeeRecipient = getAddress(
    await client.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'managementFeeRecipient',
    }),
  );
}
if (managementFeeRecipient !== keeperHubWallet) throw new Error('FEE_RECIPIENT_NOT_CONFIGURED');

const setManagementFeeSelector = toFunctionSelector('setManagementFee(uint256)');
let managementFeeTimelock = await client.readContract({
  address: vault,
  abi: vaultAbi,
  functionName: 'timelock',
  args: [setManagementFeeSelector],
});
if (managementFeeTimelock === 0n) {
  const increaseData = encodeFunctionData({
    abi: vaultAbi,
    functionName: 'increaseTimelock',
    args: [setManagementFeeSelector, feeTimelockSeconds],
  });
  await submitThenExecute({
    label: 'configure-management-fee-timelock',
    vault,
    vaultAbi,
    data: increaseData,
    functionName: 'increaseTimelock',
    functionArgs: [setManagementFeeSelector, feeTimelockSeconds.toString()],
  });
  managementFeeTimelock = await client.readContract({
    address: vault,
    abi: vaultAbi,
    functionName: 'timelock',
    args: [setManagementFeeSelector],
  });
}
if (managementFeeTimelock !== feeTimelockSeconds) {
  throw new Error(`UNEXPECTED_MANAGEMENT_FEE_TIMELOCK:${managementFeeTimelock}`);
}

let ownerSharesBefore = await client.readContract({
  address: vault,
  abi: vaultAbi,
  functionName: 'balanceOf',
  args: [keeperHubWallet],
});
if (ownerSharesBefore === 0n) {
  if (ownerAssetsAtStart < depositAssets) throw new Error('INSUFFICIENT_FIXTURE_ASSETS');
  const assetAllowance = await client.readContract({
    address: fixtureAsset,
    abi: tokenAbi,
    functionName: 'allowance',
    args: [keeperHubWallet, vault],
  });
  if (assetAllowance < depositAssets) {
    await setupCall('approve-official-morpho-deposit', {
      contractAddress: fixtureAsset,
      chainId,
      functionName: 'approve',
      functionArgs: JSON.stringify([vault, depositAssets.toString()]),
      abi: JSON.stringify(tokenAbi),
    });
  }
  await setupCall('deposit-into-official-morpho-v2', {
    contractAddress: vault,
    chainId,
    functionName: 'deposit',
    functionArgs: JSON.stringify([depositAssets.toString(), keeperHubWallet]),
    abi: JSON.stringify(vaultAbi),
  });
  ownerSharesBefore = await client.readContract({
    address: vault,
    abi: vaultAbi,
    functionName: 'balanceOf',
    args: [keeperHubWallet],
  });
}
if (ownerSharesBefore === 0n) throw new Error('OFFICIAL_MORPHO_DEPOSIT_MINTED_NO_SHARES');
const ownerAssetsAfterDeposit = await client.readContract({
  address: fixtureAsset,
  abi: tokenAbi,
  functionName: 'balanceOf',
  args: [keeperHubWallet],
});

const shareAllowance = await client.readContract({
  address: vault,
  abi: vaultAbi,
  functionName: 'allowance',
  args: [keeperHubWallet, guard],
});
if (shareAllowance < ownerSharesBefore) {
  await setupCall('approve-real-morpho-exit-guard', {
    contractAddress: vault,
    chainId,
    functionName: 'approve',
    functionArgs: JSON.stringify([guard, ownerSharesBefore.toString()]),
    abi: JSON.stringify(vaultAbi),
  });
}

let nextMandateId = await client.readContract({
  address: guard,
  abi: guardArtifact.abi,
  functionName: 'nextMandateId',
});
let mandateId = nextMandateId === 0n ? 0n : nextMandateId - 1n;
let mandate =
  nextMandateId === 0n
    ? undefined
    : await client.readContract({
        address: guard,
        abi: guardArtifact.abi,
        functionName: 'mandates',
        args: [mandateId],
      });
let mandateArming = readRecorded('arm-real-morpho-exit-mandate');
const mandateCheckBlock = await client.getBlock();
if (!mandate?.[7] || mandate[5] <= mandateCheckBlock.timestamp) {
  mandateId = nextMandateId;
  const block = await client.getBlock();
  const minimumAssets = await client.readContract({
    address: vault,
    abi: vaultAbi,
    functionName: 'previewRedeem',
    args: [ownerSharesBefore],
  });
  mandateArming = await setupCall('arm-real-morpho-exit-mandate', {
    contractAddress: guard,
    chainId,
    functionName: 'arm',
    functionArgs: JSON.stringify([
      vault,
      ownerSharesBefore.toString(),
      feeCeiling.toString(),
      minimumAssets.toString(),
      (block.timestamp + 86_400n).toString(),
      safetySeconds.toString(),
    ]),
    abi: JSON.stringify(guardArtifact.abi),
  });
  mandate = await client.readContract({
    address: guard,
    abi: guardArtifact.abi,
    functionName: 'mandates',
    args: [mandateId],
  });
}
if (!mandate?.[7] || getAddress(mandate[1]) !== vault || mandate[2] !== ownerSharesBefore) {
  throw new Error('REAL_MORPHO_MANDATE_MISMATCH');
}

const proposalData = encodeFunctionData({
  abi: vaultAbi,
  functionName: 'setManagementFee',
  args: [proposedFee],
});
let executableAt = await client.readContract({
  address: vault,
  abi: vaultAbi,
  functionName: 'executableAt',
  args: [proposalData],
});
let proposalSubmission = readRecorded('queue-real-morpho-fee-proposal');
if (executableAt === 0n) {
  proposalSubmission = await setupCall('queue-real-morpho-fee-proposal', {
    contractAddress: vault,
    chainId,
    functionName: 'submit',
    functionArgs: JSON.stringify([proposalData]),
    abi: JSON.stringify(vaultAbi),
  });
  executableAt = await client.readContract({
    address: vault,
    abi: vaultAbi,
    functionName: 'executableAt',
    args: [proposalData],
  });
}
if (!proposalSubmission || executableAt === 0n) throw new Error('REAL_MORPHO_PROPOSAL_MISSING');

const pool = new Pool({ connectionString: databaseUrl });
const store = new PostgresIntentStore(pool);
for (const migration of [
  '0001_exit_intents.sql',
  '0002_proposal_decisions.sql',
  '0003_managed_rules.sql',
  '0004_keeperhub_conditional.sql',
]) {
  await store.applyMigration(
    fs.readFileSync(path.join(repositoryRoot, 'db', 'migrations', migration), 'utf8'),
  );
}
const scan = await scanConfiguredMandate({
  client,
  store,
  config: {
    chainId,
    factory: morphoFactory,
    vault,
    guard,
    mandateId,
    startBlock: BigInt(proposalSubmission.blockNumber),
    confirmationDepth: 0n,
    reorgRewindBlocks: 12n,
    executionMode,
  },
});
console.log(
  JSON.stringify({
    event: 'real_morpho_scan_complete',
    proposals: scan.proposals,
    decisionsRecorded: scan.decisionsRecorded,
    readyCreated: scan.readyCreated,
  }),
);

const pipeline = new ExitPipeline(store, keeperHub, createChainReconciler(client));
let pipelineResult;
for (let attempt = 0; attempt < 60; attempt += 1) {
  pipelineResult = await pipeline.runOnce(`real-morpho-live-${process.pid}`);
  if (!pipelineResult || ['EXITED', 'BLOCKED', 'DISPUTED'].includes(pipelineResult.state)) break;
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}
const operationKey = financialOperationKey({ chainId, guard, mandateId });
const stored = await store.get(operationKey);
if (!stored || stored.state !== 'EXITED' || !stored.transactionHash || !stored.executionId) {
  throw new Error(`REAL_MORPHO_PIPELINE_NOT_EXITED:${stored?.state ?? 'missing'}`);
}
const duplicateRun = await pipeline.runOnce(`real-morpho-duplicate-${process.pid}`);
if (duplicateRun !== undefined) throw new Error('REAL_MORPHO_DUPLICATE_WAS_CLAIMED');

const [ownerSharesAfter, ownerAssetsAfter, guardAssetsAfter, vaultAssetsAfter, mandateAfter] =
  await Promise.all([
    client.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'balanceOf',
      args: [keeperHubWallet],
    }),
    client.readContract({
      address: fixtureAsset,
      abi: tokenAbi,
      functionName: 'balanceOf',
      args: [keeperHubWallet],
    }),
    client.readContract({
      address: fixtureAsset,
      abi: tokenAbi,
      functionName: 'balanceOf',
      args: [guard],
    }),
    client.readContract({
      address: fixtureAsset,
      abi: tokenAbi,
      functionName: 'balanceOf',
      args: [vault],
    }),
    client.readContract({
      address: guard,
      abi: guardArtifact.abi,
      functionName: 'mandates',
      args: [mandateId],
    }),
  ]);
if (
  ownerSharesAfter !== 0n ||
  ownerAssetsAfter <= ownerAssetsAfterDeposit ||
  guardAssetsAfter !== 0n ||
  vaultAssetsAfter !== 0n ||
  mandateAfter[7] !== false
) {
  throw new Error('REAL_MORPHO_FINAL_STATE_MISMATCH');
}

const history = await pool.query(
  'SELECT from_state, to_state, detail_json, created_at FROM exit_intent_events WHERE operation_key = $1 ORDER BY event_id',
  [operationKey],
);
const evidence = {
  evidence: 'real-morpho-v2-live-pipeline',
  environment:
    'Base Sepolia with canonical Morpho Vault V2 2025-09-15 code and valueless test asset',
  chainId,
  source: {
    repository: 'https://github.com/morpho-org/vault-v2',
    release: morphoVaultV2Release,
    commit: morphoVaultV2Commit,
    factoryRuntimeSha256: factoryDeployment.runtimeHash,
    canonicalFactoryRuntimeSha256,
    vaultRuntimeSha256: sha256Code(vaultCode),
    immutableNormalizedVaultRuntimeSha256: normalizedRuntimeHash(vaultCode, morpho.vault),
    canonicalVaultTemplateRuntimeSha256: canonicalVaultRuntimeSha256,
  },
  keeperHubWallet,
  morphoFactory,
  vault,
  fixtureAsset,
  guard,
  factoryApproved,
  mandateId: mandateId.toString(),
  proposalData,
  proposedFee: proposedFee.toString(),
  executableAt: executableAt.toString(),
  operationKey,
  idempotencyKey: stored.idempotencyKey,
  executionId: stored.executionId,
  transactionHash: stored.transactionHash,
  finalState: stored.state,
  executionMode: stored.executionMode,
  conditionalRequest: stored.conditionalRequest,
  balances: {
    ownerAssetsAtStart: ownerAssetsAtStart.toString(),
    ownerAssetsAfterDeposit: ownerAssetsAfterDeposit.toString(),
    ownerSharesBeforeExit: ownerSharesBefore.toString(),
    ownerSharesAfterExit: ownerSharesAfter.toString(),
    ownerAssetsAfterExit: ownerAssetsAfter.toString(),
    guardAssetsAfterExit: guardAssetsAfter.toString(),
    vaultAssetsAfterExit: vaultAssetsAfter.toString(),
  },
  mandateConsumed: mandateAfter[7] === false,
  duplicateClaimed: false,
  reconciliation: stored.reconciliation,
  transitions: history.rows,
  transactions: {
    factoryDeployment: readRecorded('deploy-official-morpho-v2-factory'),
    vaultCreation,
    guardDeployment: readRecorded('deploy-real-morpho-exit-guard'),
    deposit: readRecorded('deposit-into-official-morpho-v2'),
    mandateArming,
    proposalSubmission,
  },
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
    morphoFactory,
    vault,
    guard,
    executionId: stored.executionId,
    transactionHash: stored.transactionHash,
    ownerSharesBefore: ownerSharesBefore.toString(),
    ownerSharesAfter: ownerSharesAfter.toString(),
    ownerAssetsAfter: ownerAssetsAfter.toString(),
    guardAssetsAfter: guardAssetsAfter.toString(),
    mandateConsumed: evidence.mandateConsumed,
    finalState: stored.state,
  }),
);
await pool.end();
