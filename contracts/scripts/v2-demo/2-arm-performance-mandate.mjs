import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createPublicClient,
  createWalletClient,
  formatEther,
  getAddress,
  http,
  parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

import { compileGuardV2 } from '../compile.mjs';

const rpcUrl =
  process.env.BASE_SEPOLIA_RPC_URL || process.env.VETO_RPC_URL || 'https://sepolia.base.org';
const vaultAddress = getAddress(
  process.env.VETO_VAULT_ADDRESS || '0x9019B1e26795E90825c567aD08c945C603e7F9B9',
);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const outDir = path.join(root, '.local-data', 'v2-demo');
const deploymentFile = path.join(outDir, 'deployment.json');

let guardAddress;
if (fs.existsSync(deploymentFile)) {
  const deployment = JSON.parse(fs.readFileSync(deploymentFile, 'utf8'));
  guardAddress = getAddress(deployment.guardAddress);
} else if (process.env.VETO_GUARD_ADDRESS) {
  guardAddress = getAddress(process.env.VETO_GUARD_ADDRESS);
} else {
  console.error('No guard deployment found. Run 1-deploy-guard-v2.mjs or set VETO_GUARD_ADDRESS.');
  process.exit(1);
}

const rawKey = process.env.DEPLOYER_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!rawKey) {
  console.error('================================================================');
  console.error('STOPPING BEFORE BROADCAST: No deployer private key found.');
  console.error('Please set DEPLOYER_PRIVATE_KEY or PRIVATE_KEY in your environment.');
  console.error('================================================================');
  process.exit(1);
}

const formattedKey = rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`;
const account = privateKeyToAccount(formattedKey);
const ownerAddress = account.address;

const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(rpcUrl),
});

const vaultAbi = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function asset() view returns (address)',
  'function previewRedeem(uint256 shares) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

async function main() {
  const ethBalance = await publicClient.getBalance({ address: ownerAddress });
  console.log(`Owner Address: ${ownerAddress}`);
  console.log(`Base Sepolia ETH Balance: ${formatEther(ethBalance)} ETH`);
  console.log(`Vault Address: ${vaultAddress}`);
  console.log(`Guard Address: ${guardAddress}`);

  if (ethBalance === 0n) {
    console.error('================================================================');
    console.error('STOPPING BEFORE BROADCAST: Insufficient ETH.');
    console.error(`Owner address ${ownerAddress} requires Base Sepolia testnet ETH for gas.`);
    console.error('================================================================');
    process.exit(1);
  }

  const shares = await publicClient.readContract({
    address: vaultAddress,
    abi: vaultAbi,
    functionName: 'balanceOf',
    args: [ownerAddress],
  });
  console.log(`Vault Shares Owned: ${shares}`);

  if (shares === 0n) {
    console.error('================================================================');
    console.error('STOPPING BEFORE BROADCAST: Insufficient Vault Shares.');
    console.error(`Owner address ${ownerAddress} holds 0 shares in vault ${vaultAddress}.`);
    console.error('Deposit underlying assets into the vault before arming a mandate.');
    console.error('================================================================');
    process.exit(1);
  }

  const expectedAssets = await publicClient.readContract({
    address: vaultAddress,
    abi: vaultAbi,
    functionName: 'previewRedeem',
    args: [shares],
  });
  console.log(`Expected Assets on Full Redeem: ${expectedAssets}`);

  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(rpcUrl),
  });

  const allowance = await publicClient.readContract({
    address: vaultAddress,
    abi: vaultAbi,
    functionName: 'allowance',
    args: [ownerAddress, guardAddress],
  });

  if (allowance < shares) {
    console.log(`Approving ${shares} shares to guard ${guardAddress}...`);
    const approveHash = await walletClient.writeContract({
      address: vaultAddress,
      abi: vaultAbi,
      functionName: 'approve',
      args: [guardAddress, shares],
    });
    console.log(`Approval transaction broadcast: ${approveHash}`);
    await publicClient.waitForTransactionReceipt({ hash: approveHash });
    console.log('Approval confirmed.');
  }

  const guardArtifact = compileGuardV2();
  const block = await publicClient.getBlock();
  const POLICY_PERFORMANCE_FEE = 2n; // 1 << 1
  const maxPerformanceFee = 100_000_000_000_000_000n; // 10% WAD ceiling

  const policyConfig = {
    policyFlags: POLICY_PERFORMANCE_FEE,
    maxManagementFee: 0n,
    maxPerformanceFee,
    relativeCaps: [],
    approvedAdapters: [],
    approvedSendSharesGates: [],
    approvedReceiveAssetsGates: [],
  };

  const minAssets = expectedAssets > 1n ? expectedAssets - 1n : 1n;
  const expiresAt = block.timestamp + 86_400n * 7n; // 7 days
  const safetySeconds = 300n; // 5 minutes

  console.log('Arming V2 performance-fee mandate...');
  const armHash = await walletClient.writeContract({
    address: guardAddress,
    abi: guardArtifact.abi,
    functionName: 'armPolicyMandate',
    args: [vaultAddress, shares, minAssets, expiresAt, safetySeconds, policyConfig],
  });
  console.log(`Arm transaction broadcast: ${armHash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash: armHash });
  if (receipt.status !== 'success') {
    throw new Error(`Arm transaction reverted: ${armHash}`);
  }

  console.log(`V2 Mandate successfully armed in tx ${armHash}!`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'mandate.json'),
    JSON.stringify(
      {
        chainId: baseSepolia.id,
        guardAddress,
        vaultAddress,
        ownerAddress,
        shares: shares.toString(),
        minAssets: minAssets.toString(),
        maxPerformanceFee: maxPerformanceFee.toString(),
        policyFlags: POLICY_PERFORMANCE_FEE.toString(),
        transactionHash: armHash,
        blockNumber: receipt.blockNumber.toString(),
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`Mandate evidence saved to .local-data/v2-demo/mandate.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
