import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  parseAbi,
} from 'viem';
import { foundry } from 'viem/chains';

import { compileContracts } from '../scripts/compile.mjs';

const rpcUrl = 'http://127.0.0.1:18550';
const readAbi = parseAbi([
  'function latestAsset() view returns (address)',
  'function latestVault() view returns (address)',
  'function balanceOf(address account) view returns (uint256)',
  'function activeMandateByOwnerVault(address owner, address vault) view returns (uint256)',
  'function mandates(uint256 mandateId) view returns (address owner, address vault, uint256 shares, uint256 minAssets, uint256 expiresAt, uint256 safetySeconds, bool active, uint256 policyFlags, uint256 maxManagementFee, uint256 maxPerformanceFee)',
  'function hasRelativeCapByMandateRisk(uint256 mandateId, bytes32 riskId) view returns (bool)',
  'function maxRelativeCapByMandateRisk(uint256 mandateId, bytes32 riskId) view returns (uint256)',
  'function executableAt(bytes data) view returns (uint256)',
]);

const increaseRelativeCapAbi = [
  {
    type: 'function',
    name: 'increaseRelativeCap',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'idData', type: 'bytes' },
      { name: 'newRelativeCap', type: 'uint256' },
    ],
    outputs: [],
  },
];

const decreaseRelativeCapAbi = [
  {
    type: 'function',
    name: 'decreaseRelativeCap',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'idData', type: 'bytes' },
      { name: 'newRelativeCap', type: 'uint256' },
    ],
    outputs: [],
  },
];

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

test('PHASE 2 H-J, M: VetoExitGuardV2 relative-cap ceiling enforcement and TOCTOU safety', async (context) => {
  const anvil = spawn(
    process.execPath,
    [
      'node_modules/@foundry-rs/anvil/bin.mjs',
      '--host',
      '127.0.0.1',
      '--port',
      '18550',
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
  const [owner, relayer] = await publicClient.request({ method: 'eth_accounts' });
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
  const testIdData = '0x112233445566778899aabbccddeeff0011223344';
  const testRiskId = keccak256(testIdData);
  const otherIdData = '0xdeadbeef';
  const otherRiskId = keccak256(otherIdData);

  const maxRelativeCap = 200_000_000_000_000_000n; // 20% WAD (0.20e18)
  const POLICY_RELATIVE_CAP = 4n;

  const policyConfig = {
    policyFlags: POLICY_RELATIVE_CAP,
    maxManagementFee: 0n,
    maxPerformanceFee: 0n,
    relativeCaps: [{ riskId: testRiskId, maxRelativeCap }],
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
  assert.equal(mandate[6], true); // active
  assert.equal(mandate[7], POLICY_RELATIVE_CAP);

  const hasTestRisk = await publicClient.readContract({
    address: guard,
    abi: readAbi,
    functionName: 'hasRelativeCapByMandateRisk',
    args: [0n, testRiskId],
  });
  assert.equal(hasTestRisk, true);
  const storedCap = await publicClient.readContract({
    address: guard,
    abi: readAbi,
    functionName: 'maxRelativeCapByMandateRisk',
    args: [0n, testRiskId],
  });
  assert.equal(storedCap, maxRelativeCap);

  const hasOtherRisk = await publicClient.readContract({
    address: guard,
    abi: readAbi,
    functionName: 'hasRelativeCapByMandateRisk',
    args: [0n, otherRiskId],
  });
  assert.equal(hasOtherRisk, false);

  // Proposal 1: Below ceiling (10% < 20%)
  const belowProposal = encodeFunctionData({
    abi: increaseRelativeCapAbi,
    functionName: 'increaseRelativeCap',
    args: [testIdData, 100_000_000_000_000_000n],
  });
  const belowSubmitHash = await ownerClient.writeContract({
    address: vault,
    abi: vaultArtifact.abi,
    functionName: 'submit',
    args: [belowProposal],
  });
  await publicClient.waitForTransactionReceipt({ hash: belowSubmitHash });
  const belowExecutableAt = await publicClient.readContract({
    address: vault,
    abi: readAbi,
    functionName: 'executableAt',
    args: [belowProposal],
  });

  await assert.rejects(
    publicClient.simulateContract({
      account: relayer,
      address: guard,
      abi: guardArtifact.abi,
      functionName: 'execute',
      args: [0n, belowProposal, belowExecutableAt],
    }),
    /CapDoesNotBreachLimit/,
  );

  // Proposal 2: Equal to ceiling (20% == 20%)
  const equalProposal = encodeFunctionData({
    abi: increaseRelativeCapAbi,
    functionName: 'increaseRelativeCap',
    args: [testIdData, maxRelativeCap],
  });
  const equalSubmitHash = await ownerClient.writeContract({
    address: vault,
    abi: vaultArtifact.abi,
    functionName: 'submit',
    args: [equalProposal],
  });
  await publicClient.waitForTransactionReceipt({ hash: equalSubmitHash });
  const equalExecutableAt = await publicClient.readContract({
    address: vault,
    abi: readAbi,
    functionName: 'executableAt',
    args: [equalProposal],
  });

  await assert.rejects(
    publicClient.simulateContract({
      account: relayer,
      address: guard,
      abi: guardArtifact.abi,
      functionName: 'execute',
      args: [0n, equalProposal, equalExecutableAt],
    }),
    /CapDoesNotBreachLimit/,
  );

  // Proposal 3: Unconfigured risk ID (otherRiskId, 50%)
  const unconfiguredProposal = encodeFunctionData({
    abi: increaseRelativeCapAbi,
    functionName: 'increaseRelativeCap',
    args: [otherIdData, 500_000_000_000_000_000n],
  });
  const unconfSubmitHash = await ownerClient.writeContract({
    address: vault,
    abi: vaultArtifact.abi,
    functionName: 'submit',
    args: [unconfiguredProposal],
  });
  await publicClient.waitForTransactionReceipt({ hash: unconfSubmitHash });
  const unconfExecutableAt = await publicClient.readContract({
    address: vault,
    abi: readAbi,
    functionName: 'executableAt',
    args: [unconfiguredProposal],
  });

  await assert.rejects(
    publicClient.simulateContract({
      account: relayer,
      address: guard,
      abi: guardArtifact.abi,
      functionName: 'execute',
      args: [0n, unconfiguredProposal, unconfExecutableAt],
    }),
    /CapDoesNotBreachLimit/,
  );

  // Proposal 4: Derisking decreaseRelativeCap rejected by guard
  const decreaseProposal = encodeFunctionData({
    abi: decreaseRelativeCapAbi,
    functionName: 'decreaseRelativeCap',
    args: [testIdData, 100_000_000_000_000_000n],
  });
  await assert.rejects(
    publicClient.simulateContract({
      account: relayer,
      address: guard,
      abi: guardArtifact.abi,
      functionName: 'execute',
      args: [0n, decreaseProposal, 12345n],
    }),
    /UnsupportedProposal/,
  );

  // Proposal 5: Malformed calldata with trailing bytes rejected by guard
  const breachingProposal = encodeFunctionData({
    abi: increaseRelativeCapAbi,
    functionName: 'increaseRelativeCap',
    args: [testIdData, 500_000_000_000_000_000n], // 50% > 20%
  });
  await assert.rejects(
    publicClient.simulateContract({
      account: relayer,
      address: guard,
      abi: guardArtifact.abi,
      functionName: 'execute',
      args: [0n, `${breachingProposal}00`, 12345n],
    }),
    /UnsupportedProposal/,
  );

  // Submit valid breaching proposal
  const breachSubmitHash = await ownerClient.writeContract({
    address: vault,
    abi: vaultArtifact.abi,
    functionName: 'submit',
    args: [breachingProposal],
  });
  await publicClient.waitForTransactionReceipt({ hash: breachSubmitHash });
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

  // Test M: TOCTOU safety - curator revokes proposal -> guard reverts with zero movement
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

  // Proposal changed check
  await assert.rejects(
    publicClient.simulateContract({
      account: relayer,
      address: guard,
      abi: guardArtifact.abi,
      functionName: 'execute',
      args: [0n, breachingProposal, breachExecutableAt + 1n],
    }),
    /ProposalChanged/,
  );

  // Abdicated check
  const snapshotAbdicate = await publicClient.request({ method: 'evm_snapshot' });
  const abdicateHash = await ownerClient.writeContract({
    address: vault,
    abi: vaultArtifact.abi,
    functionName: 'abdicate',
    args: ['0x2438525b'],
  });
  await publicClient.waitForTransactionReceipt({ hash: abdicateHash });
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
  await publicClient.request({ method: 'evm_revert', params: [snapshotAbdicate] });

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
