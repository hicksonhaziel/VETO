import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { createPublicClient, createWalletClient, encodeFunctionData, http, parseAbi } from 'viem';
import { foundry } from 'viem/chains';

import { compileContracts } from '../scripts/compile.mjs';

const rpcUrl = 'http://127.0.0.1:18549';
const readAbi = parseAbi([
  'function latestAsset() view returns (address)',
  'function latestVault() view returns (address)',
  'function balanceOf(address account) view returns (uint256)',
  'function activeMandateByOwnerVault(address owner, address vault) view returns (uint256)',
  'function mandates(uint256 mandateId) view returns (address owner, address vault, uint256 shares, uint256 minAssets, uint256 expiresAt, uint256 safetySeconds, bool active, uint256 policyFlags, uint256 maxManagementFee, uint256 maxPerformanceFee)',
  'function executableAt(bytes data) view returns (uint256)',
]);

async function waitForRpc(client) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      await client.getBlockNumber();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('authority test RPC did not start');
}

async function deploy(client, publicClient, artifact, args = []) {
  const hash = await client.deployContract({
    abi: artifact.abi,
    bytecode: `0x${artifact.evm.bytecode.object}`,
    args,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success');
  assert.ok(receipt.contractAddress);
  return receipt.contractAddress;
}

test('PHASE 1 H-J, M: VetoExitGuardV2 performance-fee ceiling enforcement and TOCTOU safety', async (context) => {
  const anvil = spawn(
    process.execPath,
    [
      'node_modules/@foundry-rs/anvil/bin.mjs',
      '--host',
      '127.0.0.1',
      '--port',
      '18549',
      '--hardfork',
      'cancun',
      '--silent',
    ],
    { cwd: new URL('..', import.meta.url), stdio: 'ignore' },
  );
  context.after(() => anvil.kill('SIGTERM'));

  const publicClient = createPublicClient({
    chain: foundry,
    transport: http(rpcUrl),
    cacheTime: 0,
  });
  await waitForRpc(publicClient);
  const [owner, relayer, stranger] = await publicClient.request({ method: 'eth_accounts' });
  const ownerClient = createWalletClient({
    chain: foundry,
    transport: http(rpcUrl),
    account: owner,
  });
  const relayerClient = createWalletClient({
    chain: foundry,
    transport: http(rpcUrl),
    account: relayer,
  });

  const compiled = compileContracts();
  const factoryArtifact = compiled['ControlledVaultV2Fixture.sol'].ControlledVaultV2Factory;
  const assetArtifact = compiled['ControlledVaultV2Fixture.sol'].FixtureAsset;
  const vaultArtifact = compiled['ControlledVaultV2Fixture.sol'].ControlledVaultV2Fixture;
  const guardArtifact = compiled['VetoExitGuardV2.sol'].VetoExitGuardV2;

  const factory = await deploy(ownerClient, publicClient, factoryArtifact);
  const createHash = await ownerClient.writeContract({
    address: factory,
    abi: factoryArtifact.abi,
    functionName: 'create',
    args: [10_000_000n, 3_600n],
  });
  await publicClient.waitForTransactionReceipt({ hash: createHash });
  const asset = await publicClient.readContract({
    address: factory,
    abi: readAbi,
    functionName: 'latestAsset',
  });
  const vault = await publicClient.readContract({
    address: factory,
    abi: readAbi,
    functionName: 'latestVault',
  });
  const guard = await deploy(ownerClient, publicClient, guardArtifact, [factory]);

  const depositAmount = 1_000_000n;
  const approveAssetHash = await ownerClient.writeContract({
    address: asset,
    abi: assetArtifact.abi,
    functionName: 'approve',
    args: [vault, depositAmount],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveAssetHash });
  const depositHash = await ownerClient.writeContract({
    address: vault,
    abi: vaultArtifact.abi,
    functionName: 'deposit',
    args: [depositAmount, owner],
  });
  await publicClient.waitForTransactionReceipt({ hash: depositHash });
  const approveSharesHash = await ownerClient.writeContract({
    address: vault,
    abi: vaultArtifact.abi,
    functionName: 'approve',
    args: [guard, depositAmount],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveSharesHash });

  const currentBlock = await publicClient.getBlock();
  const maxPerformanceFee = 100_000_000_000_000_000n; // 10% WAD (0.10e18)
  const POLICY_PERFORMANCE_FEE = 2n;

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
    args: [
      vault,
      depositAmount,
      depositAmount,
      currentBlock.timestamp + 7_200n,
      300n,
      policyConfig,
    ],
  });
  await publicClient.waitForTransactionReceipt({ hash: armHash });

  const mandate = await publicClient.readContract({
    address: guard,
    abi: readAbi,
    functionName: 'mandates',
    args: [0n],
  });
  assert.equal(mandate[0].toLowerCase(), owner.toLowerCase());
  assert.equal(mandate[1].toLowerCase(), vault.toLowerCase());
  assert.equal(mandate[2], depositAmount);
  assert.equal(mandate[6], true); // active
  assert.equal(mandate[7], POLICY_PERFORMANCE_FEE);
  assert.equal(mandate[9], maxPerformanceFee);

  // Proposal 1: Non-breaching performance fee (5% <= 10%)
  const nonBreachingFee = 50_000_000_000_000_000n;
  const nonBreachingProposal = encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'setPerformanceFee',
        stateMutability: 'nonpayable',
        inputs: [{ name: 'newPerformanceFee', type: 'uint256' }],
        outputs: [],
      },
    ],
    functionName: 'setPerformanceFee',
    args: [nonBreachingFee],
  });

  const submitNonBreachHash = await ownerClient.writeContract({
    address: vault,
    abi: vaultArtifact.abi,
    functionName: 'submit',
    args: [nonBreachingProposal],
  });
  await publicClient.waitForTransactionReceipt({ hash: submitNonBreachHash });
  const nonBreachExecutableAt = await publicClient.readContract({
    address: vault,
    abi: readAbi,
    functionName: 'executableAt',
    args: [nonBreachingProposal],
  });

  // Test C: Non-breaching proposal -> Reverts FeeDoesNotBreachLimit
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

  // Revoke non-breaching proposal
  const revokeNonBreachHash = await ownerClient.writeContract({
    address: vault,
    abi: vaultArtifact.abi,
    functionName: 'revoke',
    args: [nonBreachingProposal],
  });
  await publicClient.waitForTransactionReceipt({ hash: revokeNonBreachHash });

  // Proposal 2: Breaching performance fee (20% > 10%)
  const breachingFee = 200_000_000_000_000_000n;
  const breachingProposal = encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'setPerformanceFee',
        stateMutability: 'nonpayable',
        inputs: [{ name: 'newPerformanceFee', type: 'uint256' }],
        outputs: [],
      },
    ],
    functionName: 'setPerformanceFee',
    args: [breachingFee],
  });

  const submitBreachHash = await ownerClient.writeContract({
    address: vault,
    abi: vaultArtifact.abi,
    functionName: 'submit',
    args: [breachingProposal],
  });
  await publicClient.waitForTransactionReceipt({ hash: submitBreachHash });
  const breachExecutableAt = await publicClient.readContract({
    address: vault,
    abi: readAbi,
    functionName: 'executableAt',
    args: [breachingProposal],
  });

  // Precheck passes
  await publicClient.simulateContract({
    account: relayer,
    address: guard,
    abi: guardArtifact.abi,
    functionName: 'execute',
    args: [0n, breachingProposal, breachExecutableAt],
  });

  // Test M: TOCTOU - precheck true, then curator revokes -> guard rejects with zero movement
  const snapshotBeforeRevoke = await publicClient.request({ method: 'evm_snapshot' });
  const revokeBreachHash = await ownerClient.writeContract({
    address: vault,
    abi: vaultArtifact.abi,
    functionName: 'revoke',
    args: [breachingProposal],
  });
  await publicClient.waitForTransactionReceipt({ hash: revokeBreachHash });

  await assert.rejects(
    publicClient.simulateContract({
      account: relayer,
      address: guard,
      abi: guardArtifact.abi,
      functionName: 'execute',
      args: [0n, breachingProposal, breachExecutableAt],
    }),
    /ProposalIsNotExecutable/,
  );

  // Mandate remains active, zero funds moved
  const mandateAfterRevoke = await publicClient.readContract({
    address: guard,
    abi: readAbi,
    functionName: 'mandates',
    args: [0n],
  });
  assert.equal(mandateAfterRevoke[6], true);
  assert.equal(
    await publicClient.readContract({
      address: vault,
      abi: readAbi,
      functionName: 'balanceOf',
      args: [owner],
    }),
    depositAmount,
  );

  // Revert snapshot back to pending proposal state
  await publicClient.request({ method: 'evm_revert', params: [snapshotBeforeRevoke] });

  // Test I: minAssets failure -> atomic revert
  const snapshotMinAssets = await publicClient.request({ method: 'evm_snapshot' });
  const highMinArmHash = await ownerClient.writeContract({
    address: guard,
    abi: guardArtifact.abi,
    functionName: 'armPolicyMandate',
    args: [
      vault,
      depositAmount,
      depositAmount * 2n,
      currentBlock.timestamp + 7_200n,
      300n,
      policyConfig,
    ],
  });
  await publicClient.waitForTransactionReceipt({ hash: highMinArmHash });
  await assert.rejects(
    publicClient.simulateContract({
      account: relayer,
      address: guard,
      abi: guardArtifact.abi,
      functionName: 'execute',
      args: [1n, breachingProposal, breachExecutableAt],
    }),
    /AssetsBelowMinimum/,
  );
  await publicClient.request({ method: 'evm_revert', params: [snapshotMinAssets] });

  // Test H: Guard positive execution -> shares 100% redeemed direct to owner
  const ownerAssetsBefore = await publicClient.readContract({
    address: asset,
    abi: readAbi,
    functionName: 'balanceOf',
    args: [owner],
  });
  const relayerAssetsBefore = await publicClient.readContract({
    address: asset,
    abi: readAbi,
    functionName: 'balanceOf',
    args: [relayer],
  });

  const executeHash = await relayerClient.writeContract({
    address: guard,
    abi: guardArtifact.abi,
    functionName: 'execute',
    args: [0n, breachingProposal, breachExecutableAt],
  });
  const executeReceipt = await publicClient.waitForTransactionReceipt({ hash: executeHash });
  assert.equal(executeReceipt.status, 'success');

  const ownerAssetsAfter = await publicClient.readContract({
    address: asset,
    abi: readAbi,
    functionName: 'balanceOf',
    args: [owner],
  });
  const ownerSharesAfter = await publicClient.readContract({
    address: vault,
    abi: readAbi,
    functionName: 'balanceOf',
    args: [owner],
  });
  const relayerAssetsAfter = await publicClient.readContract({
    address: asset,
    abi: readAbi,
    functionName: 'balanceOf',
    args: [relayer],
  });

  assert.equal(ownerAssetsAfter - ownerAssetsBefore, depositAmount);
  assert.equal(ownerSharesAfter, 0n);
  assert.equal(relayerAssetsAfter, relayerAssetsBefore);

  // Test J: Duplicate execute -> rejected because mandate consumed
  const mandateAfterExit = await publicClient.readContract({
    address: guard,
    abi: readAbi,
    functionName: 'mandates',
    args: [0n],
  });
  assert.equal(mandateAfterExit[6], false); // active == false

  await assert.rejects(
    publicClient.simulateContract({
      account: relayer,
      address: guard,
      abi: guardArtifact.abi,
      functionName: 'execute',
      args: [0n, breachingProposal, breachExecutableAt],
    }),
    /MandateInactive/,
  );
});
