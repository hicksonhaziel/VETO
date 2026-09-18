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

import { compileContracts, compileGuardV2 } from '../scripts/compile.mjs';

const rpcUrl = 'http://127.0.0.1:18558';
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
  'function setPerformanceFee(uint256 newPerformanceFee)',
]);
const erc20Abi = parseAbi(['function balanceOf(address account) view returns (uint256)']);

const POLICY_PERFORMANCE_FEE = 2n; // 1 << 1

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

test('PINNED MAINNET FORK: VetoExitGuardV2 positive performance fee proof on live Gauntlet Base deployment', async (context) => {
  const anvil = spawn(
    process.execPath,
    [
      'node_modules/@foundry-rs/anvil/bin.mjs',
      '--host',
      '127.0.0.1',
      '--port',
      '18558',
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

  const guardArtifact = compileGuardV2();
  const deploymentHash = await deployerClient.deployContract({
    abi: guardArtifact.abi,
    bytecode: `0x${guardArtifact.evm.bytecode.object}`,
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
  const maxPerformanceFee = 100_000_000_000_000_000n; // 10% WAD
  const policyConfig = {
    policyFlags: POLICY_PERFORMANCE_FEE,
    maxManagementFee: 0n,
    maxPerformanceFee,
    relativeCaps: [],
    approvedAdapters: [],
    approvedSendSharesGates: [],
    approvedReceiveAssetsGates: [],
  };

  const armHash = await ownerClient.writeContract({
    address: guard,
    abi: guardArtifact.abi,
    functionName: 'armPolicyMandate',
    args: [vault, shares, expectedAssets - 1n, block.timestamp + 86_400n, 300n, policyConfig],
  });
  await publicClient.waitForTransactionReceipt({ hash: armHash });

  const mandateBefore = await publicClient.readContract({
    address: guard,
    abi: guardArtifact.abi,
    functionName: 'mandates',
    args: [0n],
  });
  assert.equal(mandateBefore[0].toLowerCase(), owner.toLowerCase());
  assert.equal(mandateBefore[1].toLowerCase(), vault.toLowerCase());
  assert.equal(mandateBefore[2], shares);
  assert.equal(mandateBefore[6], true); // active
  assert.equal(mandateBefore[7], POLICY_PERFORMANCE_FEE);
  assert.equal(mandateBefore[9], maxPerformanceFee);

  // 1. Non-breaching performance fee (5% <= 10%)
  const nonBreachingProposal = encodeFunctionData({
    abi: vaultAbi,
    functionName: 'setPerformanceFee',
    args: [50_000_000_000_000_000n],
  });
  const submitNonBreachHash = await curatorClient.writeContract({
    address: vault,
    abi: vaultAbi,
    functionName: 'submit',
    args: [nonBreachingProposal],
  });
  await publicClient.waitForTransactionReceipt({ hash: submitNonBreachHash });
  const nonBreachExecutableAt = await publicClient.readContract({
    address: vault,
    abi: vaultAbi,
    functionName: 'executableAt',
    args: [nonBreachingProposal],
  });

  await assert.rejects(
    publicClient.simulateContract({
      account: relayer,
      address: guard,
      abi: guardArtifact.abi,
      functionName: 'execute',
      args: [0n, nonBreachingProposal, nonBreachExecutableAt],
    }),
    /FeeDoesNotBreachLimit/,
  );

  const revokeNonBreachHash = await curatorClient.writeContract({
    address: vault,
    abi: vaultAbi,
    functionName: 'revoke',
    args: [nonBreachingProposal],
  });
  await publicClient.waitForTransactionReceipt({ hash: revokeNonBreachHash });

  // 2. Breaching performance fee proposal (20% > 10%)
  const proposedPerformanceFee = 200_000_000_000_000_000n; // 20% WAD
  const proposal = encodeFunctionData({
    abi: vaultAbi,
    functionName: 'setPerformanceFee',
    args: [proposedPerformanceFee],
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
  assert(executableAt > block.timestamp);

  // Advance time by 3,600s (within 3-day timelock window before executableAt - safetySeconds)
  await publicClient.request({
    method: 'evm_increaseTime',
    params: [3600],
  });
  await publicClient.request({
    method: 'evm_mine',
  });

  // Deterministic TOCTOU test: precondition valid, curator revokes -> guard rejects, 0 movement
  const sharesBeforeRace = await publicClient.readContract({
    address: vault,
    abi: vaultAbi,
    functionName: 'balanceOf',
    args: [owner],
  });
  const assetsBeforeRace = await publicClient.readContract({
    address: asset,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner],
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
      abi: guardArtifact.abi,
      functionName: 'execute',
      args: [0n, proposal, executableAt],
    }),
  );
  assert.equal(
    await publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'balanceOf',
      args: [owner],
    }),
    sharesBeforeRace,
  );
  assert.equal(
    await publicClient.readContract({
      address: asset,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [owner],
    }),
    assetsBeforeRace,
  );
  assert.equal(
    await publicClient.request({ method: 'evm_revert', params: [queuedSnapshot] }),
    true,
  );

  // Execute emergency exit redemption via guard
  const executeHash = await relayerClient.writeContract({
    address: guard,
    abi: guardArtifact.abi,
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
  const guardAssets = await publicClient.readContract({
    address: asset,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [guard],
  });
  const relayerAssets = await publicClient.readContract({
    address: asset,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [relayer],
  });

  // Assertions: shares redeemed to 0, owner received assets, guard holds 0, relayer holds 0
  assert.equal(ownerSharesAfter, 0n);
  assert(ownerAssetsAfter - ownerAssetsBefore >= expectedAssets - 1n);
  assert.equal(guardAssets, 0n);
  assert.equal(relayerAssets, 0n);

  const mandateAfter = await publicClient.readContract({
    address: guard,
    abi: guardArtifact.abi,
    functionName: 'mandates',
    args: [0n],
  });
  assert.equal(mandateAfter[6], false); // active = false (mandate consumed)

  // Subsequent call fails
  await assert.rejects(
    publicClient.simulateContract({
      account: relayer,
      address: guard,
      abi: guardArtifact.abi,
      functionName: 'execute',
      args: [0n, proposal, executableAt],
    }),
    /MandateInactive/,
  );

  console.log(
    JSON.stringify({
      proof: 'PINNED MAINNET FORK',
      policy: 'performance-fee-ceiling',
      forkBlock,
      vault,
      guard,
      owner,
      curator,
      sharesRedeemed: shares.toString(),
      ownerAssetIncrease: (ownerAssetsAfter - ownerAssetsBefore).toString(),
      guardAssetBalance: guardAssets.toString(),
      relayerAssetBalance: relayerAssets.toString(),
      executeTransactionHash: executeHash,
    }),
  );
});
