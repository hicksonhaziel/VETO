import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { financialOperationKey } from '@veto/core';
import { KeeperHubClient, serializeContractCall } from '@veto/keeperhub';
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
  parseEventLogs,
  stringToHex,
  toFunctionSelector,
} from 'viem';
import { baseSepolia } from 'viem/chains';

import { compileOfficialMorphoVaultV2 } from '../../../contracts/scripts/compile-official-morpho-v2.mjs';
import { scanConfiguredMandate } from '../dist/scanner.js';
import { PostgresIntentStore } from '../dist/store.js';

const chainId = baseSepolia.id;
const singletonFactory = getAddress('0xce0042B868300000d44A59004Da54A005ffdcf9f');
const owner = getAddress('0x3E7A055F59c662987Ae68240Fd713195C30C0497');
const factory = getAddress('0x934c8F413D8c5C770259010D5313Bd8bc44432f9');
const vault = getAddress('0x9019B1e26795E90825c567aD08c945C603e7F9B9');
const guard = getAddress('0xF23824d2ce4e43fA1073896D1F2E898fE47BBE0F');
const asset = getAddress('0xEeae78be065258b11119D43C91c975a92A3aD6dc');
const depositAssets = 10_000_000n;
const feeCeiling = 10n ** 16n / 31_536_000n;
const proposedFee = (2n * 10n ** 16n) / 31_536_000n;
const safetySeconds = 300n;
const keeperHubApiKey = process.env.KEEPERHUB_API_KEY;
const keeperHubBaseUrl = process.env.KEEPERHUB_BASE_URL || 'https://app.keeperhub.com';
const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
const databaseUrl = process.env.DATABASE_URL;
if (!keeperHubApiKey) throw new Error('KEEPERHUB_API_KEY is required');
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../../..');
const outputDirectory = path.join(repositoryRoot, '.local-data', 'real-morpho-revoked');
const evidencePath = path.join(outputDirectory, 'evidence.json');
fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });

const tokenAbi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
]);
const guardArtifact = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, 'contracts', 'dist', 'VetoExitGuard.json'), 'utf8'),
);
const recorderArtifactPath = path.join(
  repositoryRoot,
  'contracts',
  'dist',
  'GuardRejectionRecorder.json',
);
if (!fs.existsSync(recorderArtifactPath)) {
  throw new Error('RECORDER_ARTIFACT_MISSING: run pnpm --filter @veto/contracts build');
}
const recorderArtifact = JSON.parse(fs.readFileSync(recorderArtifactPath, 'utf8'));
const singletonAbi = parseAbi([
  'function deploy(bytes initCode, bytes32 salt) returns (address payable createdContract)',
]);
const client = createPublicClient({
  chain: baseSepolia,
  transport: http(rpcUrl),
  cacheTime: 0,
});
const keeperHub = new KeeperHubClient({ apiKey: keeperHubApiKey, baseUrl: keeperHubBaseUrl });

function readRecorded(label) {
  const resultPath = path.join(outputDirectory, `${label}.json`);
  return fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8')) : undefined;
}

async function waitForExecution(executionId) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const execution = await keeperHub.getExecution(executionId);
    if (execution.state !== 'pending') return execution;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`EXECUTION_DID_NOT_SETTLE:${executionId}`);
}

async function setupCall(label, request) {
  const resultPath = path.join(outputDirectory, `${label}.json`);
  const recorded = readRecorded(label);
  if (recorded?.transactionHash) {
    const receipt = await client.getTransactionReceipt({ hash: recorded.transactionHash });
    if (receipt.status === 'success') return recorded;
  }

  await keeperHub.simulateContractCall(request);
  const execution = await keeperHub.submitContractCall(
    serializeContractCall(request),
    `veto-revoked-${keccak256(new TextEncoder().encode(label)).slice(2, 34)}`,
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
  console.log(JSON.stringify({ event: 'revoked_case_setup_complete', ...result }));
  return result;
}

async function balances(vaultAbi) {
  const [ownerShares, ownerAssets, guardAssets, vaultAssets] = await Promise.all([
    client.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'balanceOf',
      args: [owner],
    }),
    client.readContract({
      address: asset,
      abi: tokenAbi,
      functionName: 'balanceOf',
      args: [owner],
    }),
    client.readContract({
      address: asset,
      abi: tokenAbi,
      functionName: 'balanceOf',
      args: [guard],
    }),
    client.readContract({
      address: asset,
      abi: tokenAbi,
      functionName: 'balanceOf',
      args: [vault],
    }),
  ]);
  return {
    ownerShares: ownerShares.toString(),
    ownerAssets: ownerAssets.toString(),
    guardAssets: guardAssets.toString(),
    vaultAssets: vaultAssets.toString(),
  };
}

function findRevertData(error) {
  const seen = new Set();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if (typeof current.data === 'string' && /^0x[0-9a-fA-F]+$/.test(current.data)) {
      return current.data;
    }
    current = current.cause;
  }
  return undefined;
}

if (fs.existsSync(evidencePath)) {
  const previous = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const receipt = await client.getTransactionReceipt({ hash: previous.rejection.transactionHash });
  if (receipt.status === 'reverted') {
    console.log(JSON.stringify({ event: 'revoked_case_already_complete', ...previous.rejection }));
    process.exit(0);
  }
}

const morpho = await compileOfficialMorphoVaultV2();
const vaultAbi = morpho.vault.abi;
const factoryApproved = await client.readContract({
  address: factory,
  abi: morpho.factory.abi,
  functionName: 'isVaultV2',
  args: [vault],
});
if (!factoryApproved) throw new Error('FACTORY_REJECTED_VAULT');

const proposalData = encodeFunctionData({
  abi: vaultAbi,
  functionName: 'setManagementFee',
  args: [proposedFee],
});

const previousExecutableAt = await client.readContract({
  address: vault,
  abi: vaultAbi,
  functionName: 'executableAt',
  args: [proposalData],
});
let previousProposalCleanup;
if (previousExecutableAt !== 0n) {
  previousProposalCleanup = await setupCall('clear-previous-fee-proposal', {
    contractAddress: vault,
    chainId,
    functionName: 'revoke',
    functionArgs: JSON.stringify([proposalData]),
    abi: JSON.stringify(vaultAbi),
  });
}

let beforeDeposit = await balances(vaultAbi);
if (BigInt(beforeDeposit.ownerShares) === 0n) {
  if (BigInt(beforeDeposit.ownerAssets) < depositAssets)
    throw new Error('INSUFFICIENT_TEST_ASSETS');
  const assetAllowance = await client.readContract({
    address: asset,
    abi: tokenAbi,
    functionName: 'allowance',
    args: [owner, vault],
  });
  if (assetAllowance < depositAssets) {
    await setupCall('approve-revoked-case-deposit', {
      contractAddress: asset,
      chainId,
      functionName: 'approve',
      functionArgs: JSON.stringify([vault, depositAssets.toString()]),
      abi: JSON.stringify(tokenAbi),
    });
  }
  await setupCall('deposit-revoked-case-assets', {
    contractAddress: vault,
    chainId,
    functionName: 'deposit',
    functionArgs: JSON.stringify([depositAssets.toString(), owner]),
    abi: JSON.stringify(vaultAbi),
  });
}
const afterDeposit = await balances(vaultAbi);
const shares = BigInt(afterDeposit.ownerShares);
if (shares === 0n) throw new Error('DEPOSIT_MINTED_NO_SHARES');

const shareAllowance = await client.readContract({
  address: vault,
  abi: vaultAbi,
  functionName: 'allowance',
  args: [owner, guard],
});
if (shareAllowance < shares) {
  await setupCall('approve-revoked-case-guard', {
    contractAddress: vault,
    chainId,
    functionName: 'approve',
    functionArgs: JSON.stringify([guard, shares.toString()]),
    abi: JSON.stringify(vaultAbi),
  });
}

let encodedMandateId = await client.readContract({
  address: guard,
  abi: guardArtifact.abi,
  functionName: 'activeMandateByOwnerVault',
  args: [owner, vault],
});
let mandateArming = readRecorded('arm-revoked-case-mandate');
if (encodedMandateId === 0n) {
  const mandateId = await client.readContract({
    address: guard,
    abi: guardArtifact.abi,
    functionName: 'nextMandateId',
  });
  const [block, minimumAssets] = await Promise.all([
    client.getBlock(),
    client.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'previewRedeem',
      args: [shares],
    }),
  ]);
  mandateArming = await setupCall('arm-revoked-case-mandate', {
    contractAddress: guard,
    chainId,
    functionName: 'arm',
    functionArgs: JSON.stringify([
      vault,
      shares.toString(),
      feeCeiling.toString(),
      minimumAssets.toString(),
      (block.timestamp + 86_400n).toString(),
      safetySeconds.toString(),
    ]),
    abi: JSON.stringify(guardArtifact.abi),
  });
  encodedMandateId = mandateId + 1n;
}
const mandateId = encodedMandateId - 1n;
const mandate = await client.readContract({
  address: guard,
  abi: guardArtifact.abi,
  functionName: 'mandates',
  args: [mandateId],
});
if (!mandate[7] || mandate[2] !== shares) throw new Error('ACTIVE_MANDATE_MISMATCH');

let proposalSubmission = readRecorded('queue-revoked-case-fee-proposal');
let revocation = readRecorded('revoke-detected-fee-proposal');
let executableAt = await client.readContract({
  address: vault,
  abi: vaultAbi,
  functionName: 'executableAt',
  args: [proposalData],
});
const resumingAfterKeeperHubPreflightRejection =
  executableAt === 0n && proposalSubmission !== undefined && revocation !== undefined;
if (executableAt === 0n && !resumingAfterKeeperHubPreflightRejection) {
  proposalSubmission = await setupCall('queue-revoked-case-fee-proposal', {
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
if (!proposalSubmission) throw new Error('PROPOSAL_SUBMISSION_MISSING');

const pool = new Pool({ connectionString: databaseUrl });
const store = new PostgresIntentStore(pool);
for (const migration of [
  '0001_exit_intents.sql',
  '0002_proposal_decisions.sql',
  '0003_managed_rules.sql',
]) {
  await store.applyMigration(
    fs.readFileSync(path.join(repositoryRoot, 'db', 'migrations', migration), 'utf8'),
  );
}

const operationKey = financialOperationKey({ chainId, guard, mandateId });
const workerId = `real-morpho-revoked-${process.pid}`;
let scan = { proposals: 1, decisionsRecorded: 1, readyCreated: 1 };
let simulationPassedBeforeRevoke = true;
let intent;
let directExecution;

if (resumingAfterKeeperHubPreflightRejection) {
  intent = await store.get(operationKey);
  if (!intent || intent.state !== 'PENDING' || !intent.executionId) {
    throw new Error(`CANNOT_RESUME_REJECTED_INTENT:${intent?.state ?? 'missing'}`);
  }
  executableAt = BigInt(intent.expectedExecutableAt);
  directExecution = await keeperHub.getExecution(intent.executionId);
  if (directExecution.state !== 'failed' || directExecution.transactionHash) {
    throw new Error('EXPECTED_KEEPERHUB_PREFLIGHT_REJECTION_NOT_FOUND');
  }
  await pool.query(
    'UPDATE exit_intents SET claimed_by = $2, claimed_at = now() WHERE operation_key = $1',
    [operationKey, workerId],
  );
} else {
  scan = await scanConfiguredMandate({
    client,
    store,
    config: {
      chainId,
      factory,
      vault,
      guard,
      mandateId,
      startBlock: BigInt(proposalSubmission.blockNumber),
      confirmationDepth: 0n,
      reorgRewindBlocks: 12n,
    },
  });
  if (scan.readyCreated !== 1) throw new Error(`SCANNER_DID_NOT_CREATE_READY:${scan.readyCreated}`);

  intent = await store.claimNext(workerId);
  if (!intent || intent.operationKey !== operationKey || intent.state !== 'READY') {
    throw new Error(`READY_INTENT_NOT_CLAIMED:${intent?.state ?? 'missing'}`);
  }
  const simulation = await keeperHub.simulateContractCall(intent.request);
  simulationPassedBeforeRevoke = simulation.success === true && simulation.wouldRevert !== true;
  intent = await store.transition(operationKey, workerId, 'SIMULATED', {
    lastError: null,
    detail: { simulation: 'passed', proposalStillPending: true },
  });
  intent = await store.transition(operationKey, workerId, 'SUBMITTING', {
    detail: { requestPersisted: true, idempotencyKeyPersisted: true },
  });

  revocation = await setupCall('revoke-detected-fee-proposal', {
    contractAddress: vault,
    chainId,
    functionName: 'revoke',
    functionArgs: JSON.stringify([proposalData]),
    abi: JSON.stringify(vaultAbi),
  });

  const submitted = await keeperHub.submitContractCall(
    intent.serializedRequest,
    intent.idempotencyKey,
  );
  intent = await store.transition(operationKey, workerId, 'PENDING', {
    executionId: submitted.executionId,
    transactionHash: submitted.transactionHash,
    detail: { keeperHubState: submitted.state, submittedAfterRevocation: true },
  });
  directExecution =
    submitted.state === 'pending' ? await waitForExecution(submitted.executionId) : submitted;
}

const executableAfterRevoke = await client.readContract({
  address: vault,
  abi: vaultAbi,
  functionName: 'executableAt',
  args: [proposalData],
});
if (executableAfterRevoke !== 0n) throw new Error('PROPOSAL_REVOCATION_NOT_EFFECTIVE');

let localRevertData;
try {
  await client.call({
    account: owner,
    to: guard,
    data: encodeFunctionData({
      abi: guardArtifact.abi,
      functionName: 'execute',
      args: [mandateId, proposalData, executableAt],
    }),
  });
  throw new Error('GUARD_ACCEPTED_REVOKED_PROPOSAL');
} catch (error) {
  localRevertData = findRevertData(error);
}
const expectedRevertSelector = toFunctionSelector('ProposalIsNotExecutable()');
if (!localRevertData?.startsWith(expectedRevertSelector)) {
  throw new Error(`UNEXPECTED_GUARD_REVERT:${localRevertData ?? 'missing-data'}`);
}

const beforeRejection = await balances(vaultAbi);
let publicProof;
if (directExecution.transactionHash) {
  const receipt = await client.getTransactionReceipt({ hash: directExecution.transactionHash });
  if (receipt.status !== 'reverted') throw new Error(`EXPECTED_REVERTED_RECEIPT:${receipt.status}`);
  const transaction = await client.getTransaction({ hash: directExecution.transactionHash });
  if (!transaction.to || getAddress(transaction.to) !== guard) {
    throw new Error('REJECTED_TRANSACTION_DID_NOT_REACH_GUARD');
  }
  let receiptBlockRevertData;
  try {
    await client.call({
      account: transaction.from,
      to: transaction.to,
      data: transaction.input,
      value: transaction.value,
      blockNumber: receipt.blockNumber,
    });
  } catch (error) {
    receiptBlockRevertData = findRevertData(error);
  }
  if (!receiptBlockRevertData?.startsWith(expectedRevertSelector)) {
    throw new Error(`PUBLIC_REVERT_REASON_MISMATCH:${receiptBlockRevertData ?? 'missing-data'}`);
  }
  publicProof = {
    mode: 'direct-reverted-transaction',
    executionId: directExecution.executionId,
    transactionHash: directExecution.transactionHash,
    blockNumber: receipt.blockNumber.toString(),
    gasUsed: receipt.gasUsed.toString(),
    receiptStatus: receipt.status,
    target: guard,
    guardReached: true,
    revertSelector: receiptBlockRevertData.slice(0, 10),
    revertName: 'ProposalIsNotExecutable',
  };
} else {
  if (directExecution.state !== 'failed') {
    throw new Error(`DIRECT_EXECUTION_NOT_TERMINAL:${directExecution.state}`);
  }
  const recorderInitCode = encodeDeployData({
    abi: recorderArtifact.abi,
    bytecode: `0x${recorderArtifact.evm.bytecode.object}`,
  });
  const recorderSalt = keccak256(stringToHex('VETO guard rejection recorder Base Sepolia v1'));
  const recorder = getCreate2Address({
    from: singletonFactory,
    salt: recorderSalt,
    bytecode: recorderInitCode,
  });
  if ((await client.getCode({ address: recorder })) === undefined) {
    await setupCall('deploy-guard-rejection-recorder', {
      contractAddress: singletonFactory,
      chainId,
      functionName: 'deploy',
      functionArgs: JSON.stringify([recorderInitCode, recorderSalt]),
      abi: JSON.stringify(singletonAbi),
    });
  }
  if ((await client.getCode({ address: recorder })) === undefined) {
    throw new Error('REJECTION_RECORDER_DEPLOYMENT_MISSING');
  }

  const guardCallData = encodeFunctionData({
    abi: guardArtifact.abi,
    functionName: 'execute',
    args: [mandateId, proposalData, executableAt],
  });
  const recorderExecution = await setupCall('record-guard-rejection', {
    contractAddress: recorder,
    chainId,
    functionName: 'executeAndRecord',
    functionArgs: JSON.stringify([guard, guardCallData, expectedRevertSelector]),
    abi: JSON.stringify(recorderArtifact.abi),
  });
  const receipt = await client.getTransactionReceipt({ hash: recorderExecution.transactionHash });
  const events = parseEventLogs({
    abi: recorderArtifact.abi,
    logs: receipt.logs,
    eventName: 'GuardRejected',
  });
  const rejectionEvent = events.find(
    (event) =>
      getAddress(event.args.guard) === guard &&
      event.args.revertSelector === expectedRevertSelector &&
      event.args.callHash === keccak256(guardCallData),
  );
  if (!rejectionEvent) throw new Error('PUBLIC_GUARD_REJECTION_EVENT_MISSING');
  publicProof = {
    mode: 'recorded-guard-rejection',
    executionId: recorderExecution.executionId,
    transactionHash: recorderExecution.transactionHash,
    blockNumber: recorderExecution.blockNumber,
    gasUsed: recorderExecution.gasUsed,
    receiptStatus: receipt.status,
    target: recorder,
    recorder,
    calledGuard: guard,
    guardReached: true,
    guardCallHash: rejectionEvent.args.callHash,
    revertSelector: rejectionEvent.args.revertSelector,
    revertName: 'ProposalIsNotExecutable',
  };
}

intent = await store.transition(operationKey, workerId, 'BLOCKED', {
  lastError: 'PROPOSAL_REVOKED_BEFORE_EXECUTION',
  reconciliation: {
    directKeeperHubExecutionId: directExecution.executionId,
    directKeeperHubState: directExecution.state,
    directTransactionHash: directExecution.transactionHash ?? null,
    publicProofExecutionId: publicProof.executionId,
    publicProofTransactionHash: publicProof.transactionHash,
    guardReached: true,
    revertSelector: publicProof.revertSelector,
    revertName: 'ProposalIsNotExecutable',
    expectedStaleRejection: true,
  },
  detail: {
    keeperHubState: directExecution.state,
    expectedStaleRejection: true,
    publicProofMode: publicProof.mode,
  },
});
await store.release(operationKey, workerId);

const afterRejection = await balances(vaultAbi);
const mandateAfter = await client.readContract({
  address: guard,
  abi: guardArtifact.abi,
  functionName: 'mandates',
  args: [mandateId],
});
if (JSON.stringify(beforeRejection) !== JSON.stringify(afterRejection)) {
  throw new Error('BALANCES_CHANGED_DURING_REJECTED_EXIT');
}
if (!mandateAfter[7]) throw new Error('REVERTED_EXIT_CONSUMED_MANDATE');

const history = await pool.query(
  'SELECT from_state, to_state, detail_json, created_at FROM exit_intent_events WHERE operation_key = $1 ORDER BY event_id',
  [operationKey],
);
const evidence = {
  evidence: 'real-morpho-v2-revoked-proposal',
  recordedAt: new Date().toISOString(),
  chainId,
  owner,
  factory,
  vault,
  guard,
  asset,
  factoryApproved,
  mandateId: mandateId.toString(),
  proposal: {
    data: proposalData,
    proposedFee: proposedFee.toString(),
    feeCeiling: feeCeiling.toString(),
    executableAtBeforeRevoke: executableAt.toString(),
    executableAtAfterRevoke: executableAfterRevoke.toString(),
    submission: proposalSubmission,
    revocation,
  },
  detection: {
    proposals: scan.proposals,
    decisionsRecorded: scan.decisionsRecorded,
    readyCreated: scan.readyCreated,
    simulationPassedBeforeRevoke,
  },
  rejection: {
    directKeeperHubExecutionId: directExecution.executionId,
    directKeeperHubState: directExecution.state,
    directTransactionHash: directExecution.transactionHash ?? null,
    ...publicProof,
    workerState: intent.state,
    workerError: intent.lastError,
  },
  balances: {
    beforeDeposit,
    afterDeposit,
    beforeRejection,
    afterRejection,
    unchanged: JSON.stringify(beforeRejection) === JSON.stringify(afterRejection),
  },
  mandate: {
    arming: mandateArming,
    activeAfterRejection: mandateAfter[7],
  },
  previousProposalCleanup,
  transitions: history.rows,
};
fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
console.log(
  JSON.stringify({
    evidence: evidence.evidence,
    executionId: publicProof.executionId,
    transactionHash: publicProof.transactionHash,
    receiptStatus: publicProof.receiptStatus,
    revertName: evidence.rejection.revertName,
    zeroSharesMoved: beforeRejection.ownerShares === afterRejection.ownerShares,
    zeroAssetsMoved: beforeRejection.ownerAssets === afterRejection.ownerAssets,
    mandateStillActive: mandateAfter[7],
    workerState: intent.state,
  }),
);
await pool.end();
