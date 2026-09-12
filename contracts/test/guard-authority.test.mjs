import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { createPublicClient, createWalletClient, encodeFunctionData, http, parseAbi } from 'viem';
import { foundry } from 'viem/chains';

import { compileContracts } from '../scripts/compile.mjs';

const rpcUrl = 'http://127.0.0.1:18547';
const readAbi = parseAbi([
  'function latestAsset() view returns (address)',
  'function latestVault() view returns (address)',
  'function balanceOf(address account) view returns (uint256)',
  'function activeMandateByOwnerVault(address owner, address vault) view returns (uint256)',
  'function mandates(uint256 mandateId) view returns (address owner, address vault, uint256 shares, uint256 maxFeePerSecond, uint256 minAssets, uint256 expiresAt, uint256 safetySeconds, bool active)',
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

test('authority invariants keep every exit owner-bound, bounded, replaceable, and single-use', async (context) => {
  const anvil = spawn(
    process.execPath,
    [
      'node_modules/@foundry-rs/anvil/bin.mjs',
      '--host',
      '127.0.0.1',
      '--port',
      '18547',
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
  const guardArtifact = compiled['VetoExitGuard.sol'].VetoExitGuard;

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
  const feeCeiling = 10n ** 16n / 31_536_000n;
  const proposedFee = (2n * 10n ** 16n) / 31_536_000n;
  const mandateArgs = [
    vault,
    depositAmount,
    feeCeiling,
    depositAmount,
    currentBlock.timestamp + 7_200n,
    300n,
  ];

  await assert.rejects(
    publicClient.simulateContract({
      account: owner,
      address: guard,
      abi: guardArtifact.abi,
      functionName: 'arm',
      args: [asset, ...mandateArgs.slice(1)],
    }),
  );
  await assert.rejects(
    publicClient.simulateContract({
      account: owner,
      address: guard,
      abi: guardArtifact.abi,
      functionName: 'arm',
      args: [vault, depositAmount, feeCeiling, depositAmount, currentBlock.timestamp + 300n, 300n],
    }),
  );

  const firstArmHash = await ownerClient.writeContract({
    address: guard,
    abi: guardArtifact.abi,
    functionName: 'arm',
    args: mandateArgs,
  });
  await publicClient.waitForTransactionReceipt({ hash: firstArmHash });
  await assert.rejects(
    publicClient.simulateContract({
      account: stranger,
      address: guard,
      abi: guardArtifact.abi,
      functionName: 'cancel',
      args: [0n],
    }),
  );

  const replacementArmHash = await ownerClient.writeContract({
    address: guard,
    abi: guardArtifact.abi,
    functionName: 'arm',
    args: mandateArgs,
  });
  await publicClient.waitForTransactionReceipt({ hash: replacementArmHash });
  const firstMandate = await publicClient.readContract({
    address: guard,
    abi: readAbi,
    functionName: 'mandates',
    args: [0n],
  });
  assert.equal(firstMandate[7], false);
  assert.equal(
    await publicClient.readContract({
      address: guard,
      abi: readAbi,
      functionName: 'activeMandateByOwnerVault',
      args: [owner, vault],
    }),
    2n,
  );

  const cancelHash = await ownerClient.writeContract({
    address: guard,
    abi: guardArtifact.abi,
    functionName: 'cancel',
    args: [1n],
  });
  await publicClient.waitForTransactionReceipt({ hash: cancelHash });
  assert.equal(
    await publicClient.readContract({
      address: guard,
      abi: readAbi,
      functionName: 'activeMandateByOwnerVault',
      args: [owner, vault],
    }),
    0n,
  );
  await assert.rejects(
    publicClient.simulateContract({
      account: owner,
      address: guard,
      abi: guardArtifact.abi,
      functionName: 'cancel',
      args: [1n],
    }),
  );

  const finalArmHash = await ownerClient.writeContract({
    address: guard,
    abi: guardArtifact.abi,
    functionName: 'arm',
    args: mandateArgs,
  });
  await publicClient.waitForTransactionReceipt({ hash: finalArmHash });

  const proposal = encodeFunctionData({
    abi: vaultArtifact.abi,
    functionName: 'setManagementFee',
    args: [proposedFee],
  });
  const submitHash = await ownerClient.writeContract({
    address: vault,
    abi: vaultArtifact.abi,
    functionName: 'submit',
    args: [proposal],
  });
  await publicClient.waitForTransactionReceipt({ hash: submitHash });
  const executableAt = await publicClient.readContract({
    address: vault,
    abi: readAbi,
    functionName: 'executableAt',
    args: [proposal],
  });

  await assert.rejects(
    publicClient.simulateContract({
      account: relayer,
      address: guard,
      abi: guardArtifact.abi,
      functionName: 'execute',
      args: [0n, proposal, executableAt],
    }),
  );
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
  const guardAssetsBefore = await publicClient.readContract({
    address: asset,
    abi: readAbi,
    functionName: 'balanceOf',
    args: [guard],
  });

  await publicClient.simulateContract({
    account: relayer,
    address: guard,
    abi: guardArtifact.abi,
    functionName: 'execute',
    args: [2n, proposal, executableAt],
  });
  const executeHash = await relayerClient.writeContract({
    address: guard,
    abi: guardArtifact.abi,
    functionName: 'execute',
    args: [2n, proposal, executableAt],
  });
  const executeReceipt = await publicClient.waitForTransactionReceipt({ hash: executeHash });
  assert.equal(executeReceipt.status, 'success');

  const ownerAssetsAfter = await publicClient.readContract({
    address: asset,
    abi: readAbi,
    functionName: 'balanceOf',
    args: [owner],
  });
  assert.equal(ownerAssetsAfter - ownerAssetsBefore, depositAmount);
  assert.equal(
    await publicClient.readContract({
      address: asset,
      abi: readAbi,
      functionName: 'balanceOf',
      args: [relayer],
    }),
    relayerAssetsBefore,
  );
  assert.equal(
    await publicClient.readContract({
      address: asset,
      abi: readAbi,
      functionName: 'balanceOf',
      args: [guard],
    }),
    guardAssetsBefore,
  );
  assert.equal(
    await publicClient.readContract({
      address: guard,
      abi: readAbi,
      functionName: 'activeMandateByOwnerVault',
      args: [owner, vault],
    }),
    0n,
  );
  await assert.rejects(
    publicClient.simulateContract({
      account: relayer,
      address: guard,
      abi: guardArtifact.abi,
      functionName: 'execute',
      args: [2n, proposal, executableAt],
    }),
  );
});
