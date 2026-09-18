import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPublicClient, createWalletClient, formatEther, getAddress, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

import { compileGuardV2 } from '../compile.mjs';

const rpcUrl =
  process.env.BASE_SEPOLIA_RPC_URL || process.env.VETO_RPC_URL || 'https://sepolia.base.org';
const factoryAddress = getAddress(
  process.env.VETO_FACTORY_ADDRESS || '0x934c8F413D8c5C770259010D5313Bd8bc44432f9',
);

const rawKey = process.env.DEPLOYER_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!rawKey) {
  console.error('================================================================');
  console.error('STOPPING BEFORE BROADCAST: No deployer private key found.');
  console.error('Please set DEPLOYER_PRIVATE_KEY or PRIVATE_KEY in your environment.');
  console.error('Example: export DEPLOYER_PRIVATE_KEY=0x...');
  console.error('================================================================');
  process.exit(1);
}

const formattedKey = rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`;
const account = privateKeyToAccount(formattedKey);
const deployerAddress = account.address;

const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(rpcUrl),
});

async function main() {
  const balance = await publicClient.getBalance({ address: deployerAddress });
  console.log(`Deployer Address: ${deployerAddress}`);
  console.log(`Base Sepolia Balance: ${formatEther(balance)} ETH (${balance} wei)`);
  console.log(`Factory Address: ${factoryAddress}`);

  if (balance === 0n) {
    console.error('================================================================');
    console.error('STOPPING BEFORE BROADCAST: Insufficient funds.');
    console.error(`Deployer address ${deployerAddress} requires Base Sepolia testnet ETH.`);
    console.error('Please fund this address before running deployment.');
    console.error('================================================================');
    process.exit(1);
  }

  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(rpcUrl),
  });

  console.log('Compiling VetoExitGuardV2...');
  const artifact = compileGuardV2();

  console.log('Deploying VetoExitGuardV2 to Base Sepolia...');
  const hash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: `0x${artifact.evm.bytecode.object}`,
    args: [factoryAddress],
  });
  console.log(`Deployment transaction broadcast: ${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(`Deployment transaction reverted: ${hash}`);
  }

  const guardAddress = receipt.contractAddress;
  console.log(`VetoExitGuardV2 successfully deployed at: ${guardAddress}`);

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const outDir = path.join(root, '.local-data', 'v2-demo');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'deployment.json'),
    JSON.stringify(
      {
        chainId: baseSepolia.id,
        network: 'base-sepolia',
        guardAddress,
        factoryAddress,
        deployerAddress,
        transactionHash: hash,
        blockNumber: receipt.blockNumber.toString(),
        gasUsed: receipt.gasUsed.toString(),
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`Deployment evidence saved to .local-data/v2-demo/deployment.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
