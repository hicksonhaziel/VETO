import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatEther,
  getAddress,
  http,
  parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

const rpcUrl =
  process.env.BASE_SEPOLIA_RPC_URL || process.env.VETO_RPC_URL || 'https://sepolia.base.org';
const vaultAddress = getAddress(
  process.env.VETO_VAULT_ADDRESS || '0x9019B1e26795E90825c567aD08c945C603e7F9B9',
);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const outDir = path.join(root, '.local-data', 'v2-demo');

const rawKey =
  process.env.CURATOR_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!rawKey) {
  console.error('================================================================');
  console.error('STOPPING BEFORE BROADCAST: No curator private key found.');
  console.error('Please set CURATOR_PRIVATE_KEY or DEPLOYER_PRIVATE_KEY in your environment.');
  console.error('================================================================');
  process.exit(1);
}

const formattedKey = rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`;
const account = privateKeyToAccount(formattedKey);
const curatorAddress = account.address;

const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(rpcUrl),
});

const vaultAbi = parseAbi([
  'function submit(bytes data)',
  'function executableAt(bytes data) view returns (uint256)',
  'function curator() view returns (address)',
  'function setPerformanceFee(uint256 newPerformanceFee)',
]);

async function main() {
  const ethBalance = await publicClient.getBalance({ address: curatorAddress });
  console.log(`Curator Address: ${curatorAddress}`);
  console.log(`Base Sepolia ETH Balance: ${formatEther(ethBalance)} ETH`);
  console.log(`Vault Address: ${vaultAddress}`);

  if (ethBalance === 0n) {
    console.error('================================================================');
    console.error('STOPPING BEFORE BROADCAST: Insufficient ETH.');
    console.error(`Curator address ${curatorAddress} requires Base Sepolia testnet ETH.`);
    console.error('================================================================');
    process.exit(1);
  }

  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(rpcUrl),
  });

  const breachingFee = 200_000_000_000_000_000n; // 20% WAD (breaches 10% ceiling)
  const proposalCalldata = encodeFunctionData({
    abi: vaultAbi,
    functionName: 'setPerformanceFee',
    args: [breachingFee],
  });

  console.log('Submitting breaching performance fee proposal to vault...');
  console.log(`Proposed Performance Fee: 20% WAD (${breachingFee})`);
  const submitHash = await walletClient.writeContract({
    address: vaultAddress,
    abi: vaultAbi,
    functionName: 'submit',
    args: [proposalCalldata],
  });
  console.log(`Submit transaction broadcast: ${submitHash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash: submitHash });
  if (receipt.status !== 'success') {
    throw new Error(`Submit transaction reverted: ${submitHash}`);
  }

  const executableAt = await publicClient.readContract({
    address: vaultAddress,
    abi: vaultAbi,
    functionName: 'executableAt',
    args: [proposalCalldata],
  });

  console.log(`Proposal successfully queued! Executable at timestamp: ${executableAt}`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'proposal.json'),
    JSON.stringify(
      {
        chainId: baseSepolia.id,
        vaultAddress,
        curatorAddress,
        proposalCalldata,
        proposedPerformanceFee: breachingFee.toString(),
        executableAt: executableAt.toString(),
        transactionHash: submitHash,
        blockNumber: receipt.blockNumber.toString(),
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`Proposal evidence saved to .local-data/v2-demo/proposal.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
