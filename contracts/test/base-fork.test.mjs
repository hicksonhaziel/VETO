import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
} from 'viem';
import { base } from 'viem/chains';

import { compileGuard } from '../scripts/compile.mjs';

const rpcUrl = 'http://127.0.0.1:18546';
const forkUrl = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const forkBlock = 51_221_130;
const factory = getAddress('0x4501125508079A99ebBebCE205DeC9593C2b5857');
const vault = getAddress('0x050cE30b927Da55177A4914EC73480238BAD56f0');
const owner = getAddress('0xa0894a415c4f246ce95bae718849579c099cc1d2');
const curator = getAddress('0x9E33faAE38ff641094fa68c65c2cE600b3410585');
const asset = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');

const vaultAbi = parseAbi([
  'function approve(address spender, uint256 shares) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function previewRedeem(uint256 shares) view returns (uint256)',
  'function submit(bytes data)',
  'function revoke(bytes data)',
  'function executableAt(bytes data) view returns (uint256)',
  'function setManagementFee(uint256 newManagementFee)',
]);
const erc20Abi = parseAbi(['function balanceOf(address account) view returns (uint256)']);

async function waitForRpc(client) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      await client.getBlockNumber();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('fork RPC did not start');
}

test('owner-only redemption succeeds on the pinned Gauntlet Base deployment', async (context) => {
  const anvil = spawn(
    process.execPath,
    [
      'node_modules/@foundry-rs/anvil/bin.mjs',
      '--host',
      '127.0.0.1',
      '--port',
      '18546',
      '--fork-url',
      forkUrl,
      '--fork-block-number',
      String(forkBlock),
      '--hardfork',
      'cancun',
      '--silent',
    ],
    { cwd: new URL('..', import.meta.url), stdio: 'ignore' },
  );
  context.after(() => anvil.kill('SIGTERM'));

  const publicClient = createPublicClient({
    chain: base,
    transport: http(rpcUrl),
    cacheTime: 0,
  });
  await waitForRpc(publicClient);
  const pinnedBlock = await publicClient.getBlock({ blockNumber: BigInt(forkBlock) });
  await publicClient.request({
    method: 'evm_setNextBlockTimestamp',
    params: [Number(pinnedBlock.timestamp + 1n)],
  });
  const [deployer, relayer] = await publicClient.request({ method: 'eth_accounts' });

  for (const account of [owner, curator]) {
    await publicClient.request({
      method: 'anvil_setBalance',
      params: [account, '0x3635c9adc5dea00000'],
    });
  }
  await publicClient.request({ method: 'anvil_impersonateAccount', params: [owner] });
  await publicClient.request({ method: 'anvil_impersonateAccount', params: [curator] });

  const deployerClient = createWalletClient({
    chain: base,
    transport: http(rpcUrl),
    account: deployer,
  });
  const ownerClient = createWalletClient({
    chain: base,
    transport: http(rpcUrl),
    account: owner,
  });
  const curatorClient = createWalletClient({
    chain: base,
    transport: http(rpcUrl),
    account: curator,
  });
  const relayerClient = createWalletClient({
    chain: base,
    transport: http(rpcUrl),
    account: relayer,
  });
  const artifact = compileGuard();
  const deploymentHash = await deployerClient.deployContract({
    abi: artifact.abi,
    bytecode: `0x${artifact.evm.bytecode.object}`,
    args: [factory],
  });
  const deployment = await publicClient.waitForTransactionReceipt({ hash: deploymentHash });
  assert.equal(deployment.status, 'success');
  const guard = deployment.contractAddress;
  assert.ok(guard);

  const shares = await publicClient.readContract({
    address: vault,
    abi: vaultAbi,
    functionName: 'balanceOf',
    args: [owner],
  });
  assert(shares > 0n);
  const expectedAssets = await publicClient.readContract({
    address: vault,
    abi: vaultAbi,
    functionName: 'previewRedeem',
    args: [shares],
  });
  const ownerAssetsBefore = await publicClient.readContract({
    address: asset,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner],
  });

  const approveHash = await ownerClient.writeContract({
    address: vault,
    abi: vaultAbi,
    functionName: 'approve',
    args: [guard, shares],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });

  const block = await publicClient.getBlock();
  const feeCeiling = 10n ** 16n / 31_536_000n;
  const proposedFee = (2n * 10n ** 16n) / 31_536_000n;
  const armHash = await ownerClient.writeContract({
    address: guard,
    abi: artifact.abi,
    functionName: 'arm',
    args: [vault, shares, feeCeiling, expectedAssets - 1n, block.timestamp + 86_400n, 300n],
  });
  await publicClient.waitForTransactionReceipt({ hash: armHash });

  const proposal = encodeFunctionData({
    abi: vaultAbi,
    functionName: 'setManagementFee',
    args: [proposedFee],
  });
  const submitHash = await curatorClient.writeContract({
    address: vault,
    abi: vaultAbi,
    functionName: 'submit',
    args: [proposal],
  });
  await publicClient.waitForTransactionReceipt({ hash: submitHash });
  const executableAt = await publicClient.readContract({
    address: vault,
    abi: vaultAbi,
    functionName: 'executableAt',
    args: [proposal],
  });

  await publicClient.simulateContract({
    account: relayer,
    address: guard,
    abi: artifact.abi,
    functionName: 'execute',
    args: [0n, proposal, executableAt],
  });

  const queuedSnapshot = await publicClient.request({ method: 'evm_snapshot' });
  const revokeHash = await curatorClient.writeContract({
    address: vault,
    abi: vaultAbi,
    functionName: 'revoke',
    args: [proposal],
  });
  await publicClient.waitForTransactionReceipt({ hash: revokeHash });
  await assert.rejects(
    publicClient.simulateContract({
      account: relayer,
      address: guard,
      abi: artifact.abi,
      functionName: 'execute',
      args: [0n, proposal, executableAt],
    }),
  );
  assert.equal(
    await publicClient.request({ method: 'evm_revert', params: [queuedSnapshot] }),
    true,
  );

  const allowanceSnapshot = await publicClient.request({ method: 'evm_snapshot' });
  const clearAllowanceHash = await ownerClient.writeContract({
    address: vault,
    abi: vaultAbi,
    functionName: 'approve',
    args: [guard, 0n],
  });
  await publicClient.waitForTransactionReceipt({ hash: clearAllowanceHash });
  await assert.rejects(
    publicClient.simulateContract({
      account: relayer,
      address: guard,
      abi: artifact.abi,
      functionName: 'execute',
      args: [0n, proposal, executableAt],
    }),
  );
  assert.equal(
    await publicClient.request({ method: 'evm_revert', params: [allowanceSnapshot] }),
    true,
  );

  const highMinimumSnapshot = await publicClient.request({ method: 'evm_snapshot' });
  const highMinimumArmHash = await ownerClient.writeContract({
    address: guard,
    abi: artifact.abi,
    functionName: 'arm',
    args: [vault, shares, feeCeiling, expectedAssets * 2n, block.timestamp + 86_400n, 300n],
  });
  await publicClient.waitForTransactionReceipt({ hash: highMinimumArmHash });
  await assert.rejects(
    publicClient.simulateContract({
      account: relayer,
      address: guard,
      abi: artifact.abi,
      functionName: 'execute',
      args: [1n, proposal, executableAt],
    }),
  );
  assert.equal(
    await publicClient.request({ method: 'evm_revert', params: [highMinimumSnapshot] }),
    true,
  );

  const executeHash = await relayerClient.writeContract({
    address: guard,
    abi: artifact.abi,
    functionName: 'execute',
    args: [0n, proposal, executableAt],
  });
  const executeReceipt = await publicClient.waitForTransactionReceipt({ hash: executeHash });
  assert.equal(executeReceipt.status, 'success');

  const ownerSharesAfter = await publicClient.readContract({
    address: vault,
    abi: vaultAbi,
    functionName: 'balanceOf',
    args: [owner],
  });
  const ownerAssetsAfter = await publicClient.readContract({
    address: asset,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner],
  });
  const relayerAssets = await publicClient.readContract({
    address: asset,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [relayer],
  });
  assert.equal(ownerSharesAfter, 0n);
  assert(ownerAssetsAfter - ownerAssetsBefore >= expectedAssets - 1n);
  assert.equal(relayerAssets, 0n);

  console.log(
    JSON.stringify({
      evidence: 'gate-b-base-fork',
      forkBlock,
      vault,
      guard,
      owner,
      sharesRedeemed: shares.toString(),
      ownerAssetIncrease: (ownerAssetsAfter - ownerAssetsBefore).toString(),
      relayerAssetBalance: relayerAssets.toString(),
      executeTransactionHash: executeHash,
    }),
  );

  await assert.rejects(
    publicClient.simulateContract({
      account: relayer,
      address: guard,
      abi: artifact.abi,
      functionName: 'execute',
      args: [0n, proposal, executableAt],
    }),
  );
});
