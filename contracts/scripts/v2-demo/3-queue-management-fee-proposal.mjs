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
  toFunctionSelector,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

const rpcUrl =
  process.env.BASE_SEPOLIA_RPC_URL || process.env.VETO_RPC_URL || 'https://sepolia.base.org';
const vaultAddress = getAddress(
  process.env.VETO_VAULT_ADDRESS || '0x9019B1e26795E90825c567aD08c945C603e7F9B9',
);
const expectedChainId = 84532;
const secondsPerYear = 31_536_000n;
const onePercentPerSecond = (1n * 10n ** 16n) / secondsPerYear;
const twoPercentPerSecond = (2n * 10n ** 16n) / secondsPerYear;
const setManagementFeeSelector = toFunctionSelector('setManagementFee(uint256)');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const outDir = path.join(root, '.local-data', 'v2-demo');

const rawKey = process.env.CURATOR_PRIVATE_KEY;
if (!rawKey) {
  console.error('STOPPING BEFORE BROADCAST: CURATOR_PRIVATE_KEY is not configured.');
  process.exit(1);
}

const formattedKey = rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`;
const account = privateKeyToAccount(formattedKey);
const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(rpcUrl),
});
const walletClient = createWalletClient({
  account,
  chain: baseSepolia,
  transport: http(rpcUrl),
});

const vaultAbi = parseAbi([
  'function submit(bytes data)',
  'function executableAt(bytes data) view returns (uint256)',
  'function curator() view returns (address)',
  'function timelock(bytes4 selector) view returns (uint256)',
  'function abdicated(bytes4 selector) view returns (bool)',
  'function managementFeeRecipient() view returns (address)',
  'function setManagementFee(uint256 newManagementFee)',
]);

async function main() {
  const chainId = await publicClient.getChainId();
  if (chainId !== expectedChainId) throw new Error(`UNSUPPORTED_CHAIN:${chainId}`);

  const [vaultCurator, ethBalance, timelock, abdicated, feeRecipient] = await Promise.all([
    publicClient.readContract({ address: vaultAddress, abi: vaultAbi, functionName: 'curator' }),
    publicClient.getBalance({ address: account.address }),
    publicClient.readContract({
      address: vaultAddress,
      abi: vaultAbi,
      functionName: 'timelock',
      args: [setManagementFeeSelector],
    }),
    publicClient.readContract({
      address: vaultAddress,
      abi: vaultAbi,
      functionName: 'abdicated',
      args: [setManagementFeeSelector],
    }),
    publicClient.readContract({
      address: vaultAddress,
      abi: vaultAbi,
      functionName: 'managementFeeRecipient',
    }),
  ]);

  if (getAddress(vaultCurator) !== account.address) {
    throw new Error(`CURATOR_MISMATCH:${account.address}:${vaultCurator}`);
  }
  if (ethBalance === 0n) throw new Error('CURATOR_HAS_NO_BASE_SEPOLIA_ETH');
  if (timelock === 0n) throw new Error('MANAGEMENT_FEE_TIMELOCK_MISSING');
  if (abdicated) throw new Error('MANAGEMENT_FEE_SETTER_ABDICATED');
  if (getAddress(feeRecipient) === '0x0000000000000000000000000000000000000000') {
    throw new Error('MANAGEMENT_FEE_RECIPIENT_MISSING');
  }

  const proposalCalldata = encodeFunctionData({
    abi: vaultAbi,
    functionName: 'setManagementFee',
    args: [twoPercentPerSecond],
  });
  if (proposalCalldata.slice(0, 10).toLowerCase() !== setManagementFeeSelector.toLowerCase()) {
    throw new Error('UNEXPECTED_MANAGEMENT_FEE_SELECTOR');
  }
  if (twoPercentPerSecond <= onePercentPerSecond) {
    throw new Error('PROPOSAL_DOES_NOT_BREACH_ONE_PERCENT_CEILING');
  }

  const existingExecutableAt = await publicClient.readContract({
    address: vaultAddress,
    abi: vaultAbi,
    functionName: 'executableAt',
    args: [proposalCalldata],
  });
  if (existingExecutableAt !== 0n) throw new Error('IDENTICAL_PROPOSAL_ALREADY_PENDING');

  await publicClient.simulateContract({
    address: vaultAddress,
    abi: vaultAbi,
    functionName: 'submit',
    args: [proposalCalldata],
    account,
  });

  console.log(
    JSON.stringify(
      {
        chainId,
        vaultAddress,
        curatorAddress: account.address,
        managementFeeSelector: setManagementFeeSelector,
        proposedAnnualizedPercent: '2%',
        proposedManagementFeePerSecond: twoPercentPerSecond.toString(),
        onePercentCeilingPerSecond: onePercentPerSecond.toString(),
        timelockSeconds: timelock.toString(),
        curatorEth: formatEther(ethBalance),
        simulated: true,
      },
      null,
      2,
    ),
  );

  if (process.env.VETO_QUEUE_CONFIRM !== 'YES') {
    console.log('Preflight passed. Set VETO_QUEUE_CONFIRM=YES to broadcast the queue transaction.');
    return;
  }

  const submitHash = await walletClient.writeContract({
    address: vaultAddress,
    abi: vaultAbi,
    functionName: 'submit',
    args: [proposalCalldata],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: submitHash });
  if (receipt.status !== 'success') throw new Error(`SUBMIT_REVERTED:${submitHash}`);

  const executableAt = await publicClient.readContract({
    address: vaultAddress,
    abi: vaultAbi,
    functionName: 'executableAt',
    args: [proposalCalldata],
  });
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(outDir, 'management-proposal.json'),
    `${JSON.stringify(
      {
        chainId,
        vaultAddress,
        curatorAddress: account.address,
        proposalCalldata,
        proposedManagementFeePerSecond: twoPercentPerSecond.toString(),
        onePercentCeilingPerSecond: onePercentPerSecond.toString(),
        executableAt: executableAt.toString(),
        transactionHash: submitHash,
        blockNumber: receipt.blockNumber.toString(),
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  console.log(`Management-fee proposal queued: ${submitHash}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
