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
import { foundry } from 'viem/chains';

import { compileContracts } from '../scripts/compile.mjs';

const rpcUrl = 'http://127.0.0.1:18552';
const readAbi = parseAbi([
  'function latestAsset() view returns (address)',
  'function latestVault() view returns (address)',
  'function balanceOf(address account) view returns (uint256)',
  'function activeMandateByOwnerVault(address owner, address vault) view returns (uint256)',
  'function mandates(uint256 mandateId) view returns (address owner, address vault, uint256 shares, uint256 minAssets, uint256 expiresAt, uint256 safetySeconds, bool active, uint256 policyFlags, uint256 maxManagementFee, uint256 maxPerformanceFee)',
  'function approvedAdapterByMandate(uint256 mandateId, address adapter) view returns (bool)',
  'function executableAt(bytes data) view returns (uint256)',
]);

const addAdapterAbi = [
  {
    type: 'function',
    name: 'addAdapter',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'adapter', type: 'address' }],
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

test('PHASE 3 H-J, M: VetoExitGuardV2 adapter allowlist enforcement and TOCTOU safety', async (context) => {
  const anvil = spawn(
    process.execPath,
    [
      'node_modules/@foundry-rs/anvil/bin.mjs',
      '--host',
      '127.0.0.1',
      '--port',
      '18552',
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
  const approvedAdapter = getAddress('0x1111111111111111111111111111111111111111');
  const unapprovedAdapter = getAddress('0x2222222222222222222222222222222222222222');
  const POLICY_ADAPTER_ALLOWLIST = 8n;

  const policyConfig = {
    policyFlags: POLICY_ADAPTER_ALLOWLIST,
    maxManagementFee: 0n,
    maxPerformanceFee: 0n,
    relativeCaps: [],
    approvedAdapters: [approvedAdapter],
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
  assert.equal(mandate[7], POLICY_ADAPTER_ALLOWLIST);

  const isApproved = await publicClient.readContract({
    address: guard,
    abi: readAbi,
    functionName: 'approvedAdapterByMandate',
    args: [0n, approvedAdapter],
  });
  assert.equal(isApproved, true);

  const isUnapproved = await publicClient.readContract({
    address: guard,
    abi: readAbi,
    functionName: 'approvedAdapterByMandate',
    args: [0n, unapprovedAdapter],
  });
  assert.equal(isUnapproved, false);

  // Proposal 1: Approved adapter proposal -> guard rejects with AdapterIsApproved
  const approvedProposal = encodeFunctionData({
    abi: addAdapterAbi,
    functionName: 'addAdapter',
    args: [approvedAdapter],
  });
  const approvedSubmitHash = await ownerClient.writeContract({
    address: vault,
    abi: vaultArtifact.abi,
    functionName: 'submit',
    args: [approvedProposal],
  });
  await publicClient.waitForTransactionReceipt({ hash: approvedSubmitHash });
  const approvedExecutableAt = await publicClient.readContract({
    address: vault,
    abi: readAbi,
    functionName: 'executableAt',
    args: [approvedProposal],
  });

  await assert.rejects(
    publicClient.simulateContract({
      account: relayer,
      address: guard,
      abi: guardArtifact.abi,
      functionName: 'execute',
      args: [0n, approvedProposal, approvedExecutableAt],
    }),
    /AdapterIsApproved/,
  );

  // Proposal 2: Malformed proposals rejected
  await assert.rejects(
    publicClient.simulateContract({
      account: relayer,
      address: guard,
      abi: guardArtifact.abi,
      functionName: 'execute',
      args: [0n, '0x60d54d411122', 12345n],
    }),
    /UnsupportedProposal/,
  );
  await assert.rejects(
    publicClient.simulateContract({
      account: relayer,
      address: guard,
      abi: guardArtifact.abi,
      functionName: 'execute',
      args: [0n, `${approvedProposal}00`, 12345n],
    }),
    /UnsupportedProposal/,
  );
  const zeroAdapterProposal = encodeFunctionData({
    abi: addAdapterAbi,
    functionName: 'addAdapter',
    args: ['0x0000000000000000000000000000000000000000'],
  });
  await assert.rejects(
    publicClient.simulateContract({
      account: relayer,
      address: guard,
      abi: guardArtifact.abi,
      functionName: 'execute',
      args: [0n, zeroAdapterProposal, 12345n],
    }),
    /UnsupportedProposal/,
  );

  // Proposal 3: Unapproved adapter proposal
  const unapprovedProposal = encodeFunctionData({
    abi: addAdapterAbi,
    functionName: 'addAdapter',
    args: [unapprovedAdapter],
  });
  const unapprovedSubmitHash = await ownerClient.writeContract({
    address: vault,
    abi: vaultArtifact.abi,
    functionName: 'submit',
    args: [unapprovedProposal],
  });
  await publicClient.waitForTransactionReceipt({ hash: unapprovedSubmitHash });
  const unapprovedExecutableAt = await publicClient.readContract({
    address: vault,
    abi: readAbi,
    functionName: 'executableAt',
    args: [unapprovedProposal],
  });

  // Precheck simulation passes
  await publicClient.simulateContract({
    account: relayer,
    address: guard,
    abi: guardArtifact.abi,
    functionName: 'execute',
    args: [0n, unapprovedProposal, unapprovedExecutableAt],
  });

  // Test M: TOCTOU safety - curator revokes proposal -> guard rejects with zero movement
  const snapshotBeforeRevoke = await publicClient.request({ method: 'evm_snapshot' });
  const revokeHash = await ownerClient.writeContract({
    address: vault,
    abi: vaultArtifact.abi,
    functionName: 'revoke',
    args: [unapprovedProposal],
  });
  await publicClient.waitForTransactionReceipt({ hash: revokeHash });

  await assert.rejects(
    publicClient.simulateContract({
      account: relayer,
      address: guard,
      abi: guardArtifact.abi,
      functionName: 'execute',
      args: [0n, unapprovedProposal, unapprovedExecutableAt],
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
      args: [0n, unapprovedProposal, unapprovedExecutableAt + 1n],
    }),
    /ProposalChanged/,
  );

  // Abdicated check
  const snapshotAbdicate = await publicClient.request({ method: 'evm_snapshot' });
  const abdicateHash = await ownerClient.writeContract({
    address: vault,
    abi: vaultArtifact.abi,
    functionName: 'abdicate',
    args: ['0x60d54d41'],
  });
  await publicClient.waitForTransactionReceipt({ hash: abdicateHash });
  await assert.rejects(
    publicClient.simulateContract({
      account: relayer,
      address: guard,
      abi: guardArtifact.abi,
      functionName: 'execute',
      args: [0n, unapprovedProposal, unapprovedExecutableAt],
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
      args: [1n, unapprovedProposal, unapprovedExecutableAt],
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
    args: [0n, unapprovedProposal, unapprovedExecutableAt],
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
      args: [0n, unapprovedProposal, unapprovedExecutableAt],
    }),
    /MandateInactive/,
  );
});
