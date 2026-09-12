import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const chainId = 84_532;
const singletonFactory = getAddress('0xce0042B868300000d44A59004Da54A005ffdcf9f');
const keeperHubWallet = getAddress('0x3e7a055f59c662987ae68240fd713195c30c0497');
const keeperHubBaseUrl = process.env.KEEPERHUB_BASE_URL || 'https://app.keeperhub.com';
const keeperHubApiKey = process.env.KEEPERHUB_API_KEY;
const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../../..');
const artifactDirectory = path.join(repositoryRoot, 'contracts', 'dist');
const outputDirectory = path.join(repositoryRoot, '.local-data', 'gate-c');

if (!keeperHubApiKey) throw new Error('KEEPERHUB_API_KEY is required');
fs.mkdirSync(outputDirectory, { recursive: true });

const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(rpcUrl),
  cacheTime: 0,
});
const singletonAbi = parseAbi([
  'function deploy(bytes initCode, bytes32 salt) returns (address payable createdContract)',
]);

const artifact = (name) =>
  JSON.parse(fs.readFileSync(path.join(artifactDirectory, `${name}.json`), 'utf8'));
const controlledFactoryArtifact = artifact('ControlledVaultV2Factory');
const fixtureAssetArtifact = artifact('FixtureAsset');
const fixtureVaultArtifact = artifact('ControlledVaultV2Fixture');
const guardArtifact = artifact('VetoExitGuard');

async function keeperHubRequest(pathname, options = {}) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(new URL(pathname, keeperHubBaseUrl), {
        ...options,
        signal: AbortSignal.timeout(15_000),
        headers: {
          authorization: `Bearer ${keeperHubApiKey}`,
          'content-type': 'application/json',
          ...options.headers,
        },
      });
      const text = await response.text();
      let body;
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = { raw: text };
      }
      if (response.ok) return body;
      if (response.status !== 429 && response.status < 500) {
        throw new Error(
          `KeeperHub ${pathname} returned ${response.status}: ${JSON.stringify(body)}`,
        );
      }
      if (attempt === 4) {
        throw new Error(
          `KeeperHub ${pathname} returned ${response.status}: ${JSON.stringify(body)}`,
        );
      }
    } catch (error) {
      if (attempt === 4) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** attempt));
  }
  throw new Error(`KeeperHub ${pathname} retry loop ended unexpectedly`);
}

async function waitForExecution(executionId) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const status = await keeperHubRequest(`/api/execute/${executionId}/status`);
    if (
      status.status === 'completed' ||
      status.status === 'failed' ||
      status.status === 'unconfirmed'
    ) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`KeeperHub execution ${executionId} did not settle`);
}

async function executeContractCall({ label, contractAddress, abi, functionName, args }) {
  const request = {
    contractAddress,
    chainId,
    functionName,
    functionArgs: JSON.stringify(args),
    abi: JSON.stringify(abi),
    gasLimitMultiplier: '1.3',
  };
  fs.writeFileSync(
    path.join(outputDirectory, `${label}.request.json`),
    `${JSON.stringify(request, null, 2)}\n`,
  );

  const simulation = await keeperHubRequest('/api/execute/contract-call', {
    method: 'POST',
    body: JSON.stringify({ ...request, simulate: true }),
  });
  if (simulation.success !== true || simulation.wouldRevert === true) {
    throw new Error(`${label} simulation did not pass: ${JSON.stringify(simulation)}`);
  }

  const initial = await keeperHubRequest('/api/execute/contract-call', {
    method: 'POST',
    headers: { 'idempotency-key': `veto-day1-${chainId}-${label}-v1` },
    body: JSON.stringify(request),
  });
  fs.writeFileSync(
    path.join(outputDirectory, `${label}.initial.json`),
    `${JSON.stringify(initial, null, 2)}\n`,
  );
  const status = await waitForExecution(initial.executionId);
  if (status.status !== 'completed' || !status.transactionHash) {
    throw new Error(`${label} did not complete: ${JSON.stringify(status)}`);
  }
  const receipt = await publicClient.getTransactionReceipt({ hash: status.transactionHash });
  if (receipt.status !== 'success') throw new Error(`${label} receipt reverted`);

  const result = {
    label,
    executionId: initial.executionId,
    transactionHash: status.transactionHash,
    blockNumber: receipt.blockNumber.toString(),
    gasUsed: receipt.gasUsed.toString(),
  };
  fs.writeFileSync(
    path.join(outputDirectory, `${label}.result.json`),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  console.log(JSON.stringify(result));
  return result;
}

async function recoverRecordedResult(label) {
  const requestPath = path.join(outputDirectory, `${label}.request.json`);
  const resultPath = path.join(outputDirectory, `${label}.result.json`);
  if (!fs.existsSync(requestPath) || fs.existsSync(resultPath)) return;

  const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
  const initial = await keeperHubRequest('/api/execute/contract-call', {
    method: 'POST',
    headers: { 'idempotency-key': `veto-day1-${chainId}-${label}-v1` },
    body: JSON.stringify(request),
  });
  const status = await waitForExecution(initial.executionId);
  if (status.status !== 'completed' || !status.transactionHash) {
    throw new Error(`${label} recovery did not complete: ${JSON.stringify(status)}`);
  }
  const receipt = await publicClient.getTransactionReceipt({ hash: status.transactionHash });
  if (receipt.status !== 'success') throw new Error(`${label} recovered receipt reverted`);
  const result = {
    label,
    executionId: initial.executionId,
    transactionHash: status.transactionHash,
    blockNumber: receipt.blockNumber.toString(),
    gasUsed: receipt.gasUsed.toString(),
    recoveredByIdempotentReplay: true,
  };
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
}

async function deployWithSingleton(label, initCode, saltLabel) {
  const salt = keccak256(stringToHex(saltLabel));
  const address = getCreate2Address({ from: singletonFactory, salt, bytecode: initCode });
  if ((await publicClient.getCode({ address })) !== undefined) return address;
  await executeContractCall({
    label,
    contractAddress: singletonFactory,
    abi: singletonAbi,
    functionName: 'deploy',
    args: [initCode, salt],
  });
  if ((await publicClient.getCode({ address })) === undefined) {
    throw new Error(`${label} deployment has no code at ${address}`);
  }
  return address;
}

const authenticatedUser = await keeperHubRequest('/api/user');
const returnedWallet =
  authenticatedUser.walletAddress ||
  authenticatedUser.wallet?.address ||
  authenticatedUser.organization?.walletAddress;
if (returnedWallet && getAddress(returnedWallet) !== keeperHubWallet) {
  throw new Error(`KeeperHub wallet changed: ${returnedWallet}`);
}

await recoverRecordedResult('approve-exit-guard');

const factoryInitCode = encodeDeployData({
  abi: controlledFactoryArtifact.abi,
  bytecode: `0x${controlledFactoryArtifact.evm.bytecode.object}`,
});
const controlledFactory = await deployWithSingleton(
  'deploy-controlled-factory',
  factoryInitCode,
  'VETO ControlledVaultV2Factory v1',
);

const guardInitCode = encodeDeployData({
  abi: guardArtifact.abi,
  bytecode: `0x${guardArtifact.evm.bytecode.object}`,
  args: [controlledFactory],
});
const guard = await deployWithSingleton('deploy-exit-guard', guardInitCode, 'VETO ExitGuard v1');

let fixtureVault = await publicClient.readContract({
  address: controlledFactory,
  abi: controlledFactoryArtifact.abi,
  functionName: 'latestVault',
});
if (fixtureVault === '0x0000000000000000000000000000000000000000') {
  await executeContractCall({
    label: 'create-fixture',
    contractAddress: controlledFactory,
    abi: controlledFactoryArtifact.abi,
    functionName: 'create',
    args: ['10000000', '3600'],
  });
  fixtureVault = await publicClient.readContract({
    address: controlledFactory,
    abi: controlledFactoryArtifact.abi,
    functionName: 'latestVault',
  });
}
fixtureVault = getAddress(fixtureVault);
const fixtureAsset = getAddress(
  await publicClient.readContract({
    address: controlledFactory,
    abi: controlledFactoryArtifact.abi,
    functionName: 'latestAsset',
  }),
);

let shares = await publicClient.readContract({
  address: fixtureVault,
  abi: fixtureVaultArtifact.abi,
  functionName: 'balanceOf',
  args: [keeperHubWallet],
});
const existingOwnerAssets = await publicClient.readContract({
  address: fixtureAsset,
  abi: fixtureAssetArtifact.abi,
  functionName: 'balanceOf',
  args: [keeperHubWallet],
});
const existingMandateCount = await publicClient.readContract({
  address: guard,
  abi: guardArtifact.abi,
  functionName: 'nextMandateId',
});
if (existingMandateCount > 0n) {
  const existingMandate = await publicClient.readContract({
    address: guard,
    abi: guardArtifact.abi,
    functionName: 'mandates',
    args: [0n],
  });
  if (!existingMandate[7] && shares === 0n && existingOwnerAssets === 10_000_000n) {
    console.log(
      JSON.stringify({
        evidence: 'gate-c-already-complete',
        chainId,
        keeperHubWallet,
        controlledFactory,
        fixtureVault,
        fixtureAsset,
        guard,
        ownerShares: shares.toString(),
        ownerAssets: existingOwnerAssets.toString(),
      }),
    );
    process.exit(0);
  }
}
if (shares === 0n) {
  await executeContractCall({
    label: 'approve-fixture-deposit',
    contractAddress: fixtureAsset,
    abi: fixtureAssetArtifact.abi,
    functionName: 'approve',
    args: [fixtureVault, '10000000'],
  });
  await executeContractCall({
    label: 'deposit-fixture-assets',
    contractAddress: fixtureVault,
    abi: fixtureVaultArtifact.abi,
    functionName: 'deposit',
    args: ['10000000', keeperHubWallet],
  });
  shares = 10_000_000n;
}

const guardAllowance = await publicClient.readContract({
  address: fixtureVault,
  abi: fixtureVaultArtifact.abi,
  functionName: 'allowance',
  args: [keeperHubWallet, guard],
});
if (guardAllowance !== shares) {
  await executeContractCall({
    label: 'approve-exit-guard',
    contractAddress: fixtureVault,
    abi: fixtureVaultArtifact.abi,
    functionName: 'approve',
    args: [guard, shares.toString()],
  });
}

const nextMandateId = await publicClient.readContract({
  address: guard,
  abi: guardArtifact.abi,
  functionName: 'nextMandateId',
});
if (nextMandateId === 0n) {
  const block = await publicClient.getBlock();
  await executeContractCall({
    label: 'arm-exit-mandate',
    contractAddress: guard,
    abi: guardArtifact.abi,
    functionName: 'arm',
    args: [
      fixtureVault,
      shares.toString(),
      (10n ** 16n / 31_536_000n).toString(),
      '9999999',
      (block.timestamp + 86_400n).toString(),
      '300',
    ],
  });
}

const proposal = encodeFunctionData({
  abi: fixtureVaultArtifact.abi,
  functionName: 'setManagementFee',
  args: [(2n * 10n ** 16n) / 31_536_000n],
});
let executableAt = await publicClient.readContract({
  address: fixtureVault,
  abi: fixtureVaultArtifact.abi,
  functionName: 'executableAt',
  args: [proposal],
});
if (executableAt === 0n) {
  await executeContractCall({
    label: 'queue-fee-proposal',
    contractAddress: fixtureVault,
    abi: fixtureVaultArtifact.abi,
    functionName: 'submit',
    args: [proposal],
  });
  executableAt = await publicClient.readContract({
    address: fixtureVault,
    abi: fixtureVaultArtifact.abi,
    functionName: 'executableAt',
    args: [proposal],
  });
}

const mandate = await publicClient.readContract({
  address: guard,
  abi: guardArtifact.abi,
  functionName: 'mandates',
  args: [0n],
});
if (mandate[7]) {
  await executeContractCall({
    label: 'execute-owner-exit',
    contractAddress: guard,
    abi: guardArtifact.abi,
    functionName: 'execute',
    args: ['0', proposal, executableAt.toString()],
  });
}

const finalState = {
  chainId,
  keeperHubWallet,
  singletonFactory,
  controlledFactory,
  fixtureVault,
  fixtureAsset,
  guard,
  ownerShares: (
    await publicClient.readContract({
      address: fixtureVault,
      abi: fixtureVaultArtifact.abi,
      functionName: 'balanceOf',
      args: [keeperHubWallet],
    })
  ).toString(),
  ownerAssets: (
    await publicClient.readContract({
      address: fixtureAsset,
      abi: fixtureAssetArtifact.abi,
      functionName: 'balanceOf',
      args: [keeperHubWallet],
    })
  ).toString(),
  guardAssets: (
    await publicClient.readContract({
      address: fixtureAsset,
      abi: fixtureAssetArtifact.abi,
      functionName: 'balanceOf',
      args: [guard],
    })
  ).toString(),
};
fs.writeFileSync(
  path.join(outputDirectory, 'final-state.json'),
  `${JSON.stringify(finalState, null, 2)}\n`,
);
console.log(JSON.stringify({ evidence: 'gate-c-final-state', ...finalState }));
