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

import {
  KeeperHubClient,
  keeperHubIdempotencyKey,
  serializeContractCall,
} from '../../../packages/keeperhub/dist/index.js';
import { compileGuardV2 } from '../compile.mjs';

const chainId = baseSepolia.id;
const rpcUrl =
  process.env.BASE_SEPOLIA_RPC_URL || process.env.VETO_RPC_URL || 'https://sepolia.base.org';
const keeperHubApiKey = process.env.KEEPERHUB_API_KEY;
const keeperHubBaseUrl = process.env.KEEPERHUB_BASE_URL || 'https://app.keeperhub.com';
const factoryAddress = getAddress(
  process.env.VETO_FACTORY_ADDRESS || '0x934c8F413D8c5C770259010D5313Bd8bc44432f9',
);
const singletonFactory = getAddress('0xce0042B868300000d44A59004Da54A005ffdcf9f');
if (!keeperHubApiKey) throw new Error('KEEPERHUB_API_KEY is required');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const outDir = path.join(root, '.local-data', 'v2-demo');
const deploymentFile = path.join(outDir, 'deployment.json');
const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(rpcUrl),
  cacheTime: 0,
});
const keeperHub = new KeeperHubClient({ apiKey: keeperHubApiKey, baseUrl: keeperHubBaseUrl });
const singletonAbi = parseAbi([
  'function deploy(bytes initCode, bytes32 salt) returns (address payable createdContract)',
]);
const guardReadAbi = parseAbi(['function factory() view returns (address)']);

async function waitForExecution(executionId) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const execution = await keeperHub.getExecution(executionId);
    if (execution.state !== 'pending') return execution;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`KEEPERHUB_EXECUTION_DID_NOT_SETTLE:${executionId}`);
}

async function main() {
  const artifact = compileGuardV2();
  const initCode = encodeDeployData({
    abi: artifact.abi,
    bytecode: `0x${artifact.evm.bytecode.object}`,
    args: [factoryAddress],
  });
  const salt = keccak256(stringToHex('VETO VetoExitGuardV2 Base Sepolia KeeperHub v1'));
  const guardAddress = getCreate2Address({
    from: singletonFactory,
    salt,
    bytecode: initCode,
  });
  let transactionHash = null;
  let executionId = null;
  let receipt = null;
  const existingCode = await publicClient.getBytecode({ address: guardAddress });
  if (!existingCode || existingCode === '0x') {
    const request = {
      contractAddress: singletonFactory,
      chainId,
      functionName: 'deploy',
      functionArgs: JSON.stringify([initCode, salt]),
      abi: JSON.stringify(singletonAbi),
      gasLimitMultiplier: '1.3',
    };
    await keeperHub.simulateContractCall(request);
    const execution = await keeperHub.submitContractCall(
      serializeContractCall(request),
      keeperHubIdempotencyKey(`v2-guard-deploy:${chainId}:${guardAddress.toLowerCase()}`),
    );
    const terminal = await waitForExecution(execution.executionId);
    if (terminal.state !== 'completed' || !terminal.transactionHash) {
      throw new Error(`V2_GUARD_DEPLOYMENT_FAILED:${terminal.state}`);
    }
    executionId = terminal.executionId;
    transactionHash = terminal.transactionHash;
    receipt = await publicClient.getTransactionReceipt({ hash: terminal.transactionHash });
    if (receipt.status !== 'success') throw new Error('V2_GUARD_DEPLOYMENT_REVERTED');
  } else {
    console.log(`V2 guard already deployed at ${guardAddress}; no broadcast needed.`);
  }

  const deployedCode = await publicClient.getBytecode({ address: guardAddress });
  if (!deployedCode || deployedCode === '0x') throw new Error('V2_GUARD_CODE_MISSING');
  const onchainFactory = await publicClient.readContract({
    address: guardAddress,
    abi: guardReadAbi,
    functionName: 'factory',
  });
  if (getAddress(onchainFactory) !== factoryAddress) throw new Error('V2_GUARD_FACTORY_MISMATCH');

  fs.mkdirSync(outDir, { recursive: true });
  const evidence = {
    chainId,
    network: 'base-sepolia',
    guardAddress,
    factoryAddress,
    singletonFactory,
    deploymentMethod: 'KeeperHub contract-call to deterministic singleton factory',
    executionId,
    transactionHash,
    blockNumber: receipt?.blockNumber?.toString() ?? null,
    gasUsed: receipt?.gasUsed?.toString() ?? null,
    bytecodeVerified: true,
    constructorFactoryVerified: true,
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(deploymentFile, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
