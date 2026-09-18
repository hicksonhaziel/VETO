import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseAbi,
  stringToHex,
} from 'viem';
import { foundry } from 'viem/chains';

import { compileContracts } from '../scripts/compile.mjs';

const rpcUrl = 'http://127.0.0.1:18555';
const readAbi = parseAbi([
  'function latestAsset() view returns (address)',
  'function latestVault() view returns (address)',
  'function balanceOf(address account) view returns (uint256)',
  'function activeMandateByOwnerVault(address owner, address vault) view returns (uint256)',
  'function mandates(uint256 mandateId) view returns (address owner, address vault, uint256 shares, uint256 minAssets, uint256 expiresAt, uint256 safetySeconds, bool active, uint256 policyFlags, uint256 maxManagementFee, uint256 maxPerformanceFee)',
  'function executableAt(bytes data) view returns (uint256)',
]);

const vaultAbi = parseAbi([
  'function submit(bytes data)',
  'function revoke(bytes data)',
  'function approve(address spender, uint256 shares) returns (bool)',
  'function deposit(uint256 assets, address onBehalf) returns (uint256)',
]);

const setManagementFeeAbi = [
  {
    type: 'function',
    name: 'setManagementFee',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newFee', type: 'uint256' }],
    outputs: [],
  },
];

const setPerformanceFeeAbi = [
  {
    type: 'function',
    name: 'setPerformanceFee',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newFee', type: 'uint256' }],
    outputs: [],
  },
];

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

const addAdapterAbi = [
  {
    type: 'function',
    name: 'addAdapter',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'adapter', type: 'address' }],
    outputs: [],
  },
];

const setSendSharesGateAbi = [
  {
    type: 'function',
    name: 'setSendSharesGate',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newGate', type: 'address' }],
    outputs: [],
  },
];

const setReceiveAssetsGateAbi = [
  {
    type: 'function',
    name: 'setReceiveAssetsGate',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newGate', type: 'address' }],
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
  throw new Error('combined test RPC did not start');
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

test('PHASE 5: VetoExitGuardV2 combined 5-policy mandate enforcement, cross-policy isolation, and TOCTOU', async (context) => {
  const anvil = spawn(
    process.execPath,
    [
      'node_modules/@foundry-rs/anvil/bin.mjs',
      '--host',
      '127.0.0.1',
      '--port',
      '18555',
      '--hardfork',
      'cancun',
      '--silent',
    ],
    { cwd: new URL('..', import.meta.url), stdio: 'ignore' },
  );
  context.after(() => anvil.kill('SIGTERM'));

  const client = createPublicClient({ chain: foundry, transport: http(rpcUrl), cacheTime: 0 });
  await waitForRpc(client);

  const owner = getAddress('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
  const relayer = getAddress('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
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

  const artifacts = compileContracts();
  const factoryArtifact = artifacts['ControlledVaultV2Fixture.sol'].ControlledVaultV2Factory;
  const fixtureArtifact = artifacts['ControlledVaultV2Fixture.sol'].ControlledVaultV2Fixture;
  const assetArtifact = artifacts['ControlledVaultV2Fixture.sol'].FixtureAsset;
  const guardArtifact = artifacts['VetoExitGuardV2.sol'].VetoExitGuardV2;

  const factory = await deploy(ownerClient, client, factoryArtifact);
  const fixtureHash = await ownerClient.writeContract({
    address: factory,
    abi: factoryArtifact.abi,
    functionName: 'create',
    args: [100_000_000n, 3_600n],
  });
  const fixtureReceipt = await client.waitForTransactionReceipt({ hash: fixtureHash });
  assert.equal(fixtureReceipt.status, 'success');
  const asset = await client.readContract({
    address: factory,
    abi: readAbi,
    functionName: 'latestAsset',
  });
  const vault = await client.readContract({
    address: factory,
    abi: readAbi,
    functionName: 'latestVault',
  });
  const guard = await deploy(ownerClient, client, guardArtifact, [factory]);

  const depositAmount = 50_000_000n;
  const approveAssetHash = await ownerClient.writeContract({
    address: asset,
    abi: assetArtifact.abi,
    functionName: 'approve',
    args: [vault, depositAmount],
  });
  const approveAssetReceipt = await client.waitForTransactionReceipt({ hash: approveAssetHash });
  assert.equal(approveAssetReceipt.status, 'success');

  const depositHash = await ownerClient.writeContract({
    address: vault,
    abi: vaultAbi,
    functionName: 'deposit',
    args: [depositAmount, owner],
  });
  const depositReceipt = await client.waitForTransactionReceipt({ hash: depositHash });
  assert.equal(depositReceipt.status, 'success');

  const approveGuardHash = await ownerClient.writeContract({
    address: vault,
    abi: vaultAbi,
    functionName: 'approve',
    args: [guard, depositAmount],
  });
  const approveGuardReceipt = await client.waitForTransactionReceipt({ hash: approveGuardHash });
  assert.equal(approveGuardReceipt.status, 'success');

  // Policy configuration: ALL 5 POLICIES ENABLED (flag = 1|2|4|8|16 = 31n)
  const POLICY_ALL = 31n;
  const maxManagementFee = 500_000_000n; // ~1.58% annual
  const maxPerformanceFee = 150_000_000_000_000_000n; // 15% WAD
  const testRiskIdData = stringToHex('risk-usdc-core');
  const testRiskId = keccak256(testRiskIdData);
  const maxRelativeCap = 250_000_000_000_000_000n; // 25% WAD
  const approvedAdapter = getAddress('0x1111111111111111111111111111111111111111');
  const unapprovedAdapter = getAddress('0x2222222222222222222222222222222222222222');
  const approvedGate = getAddress('0x3333333333333333333333333333333333333333');
  const unapprovedGate = getAddress('0x4444444444444444444444444444444444444444');

  const armMandate = async (shares = 1_000_000n) => {
    const block = await client.getBlock();
    const config = {
      policyFlags: POLICY_ALL,
      maxManagementFee,
      maxPerformanceFee,
      relativeCaps: [{ riskId: testRiskId, maxRelativeCap }],
      approvedAdapters: [approvedAdapter],
      approvedSendSharesGates: [approvedGate],
      approvedReceiveAssetsGates: [approvedGate],
    };
    const hash = await ownerClient.writeContract({
      address: guard,
      abi: guardArtifact.abi,
      functionName: 'armPolicyMandate',
      args: [vault, shares, shares, block.timestamp + 10_000n, 300n, config],
    });
    const receipt = await client.waitForTransactionReceipt({ hash });
    const encoded = await client.readContract({
      address: guard,
      abi: readAbi,
      functionName: 'activeMandateByOwnerVault',
      args: [owner, vault],
    });
    return encoded - 1n;
  };

  // ========================================================
  // 1. Management fee breach triggers exit
  // ========================================================
  {
    const mandateId = await armMandate(1_000_000n);
    const breachingFee = 600_000_000n; // > 500_000_000n
    const data = encodeFunctionData({
      abi: setManagementFeeAbi,
      functionName: 'setManagementFee',
      args: [breachingFee],
    });
    await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'submit',
      args: [data],
    });
    const when = await client.readContract({
      address: vault,
      abi: readAbi,
      functionName: 'executableAt',
      args: [data],
    });

    try {
      await client.simulateContract({
        account: relayer,
        address: guard,
        abi: guardArtifact.abi,
        functionName: 'execute',
        args: [mandateId, data, when],
      });
      const exitHash = await relayerClient.writeContract({
        address: guard,
        abi: guardArtifact.abi,
        functionName: 'execute',
        args: [mandateId, data, when],
      });
      const receipt = await client.waitForTransactionReceipt({ hash: exitHash });
      assert.equal(receipt.status, 'success');
    } catch (err) {
      console.error('EXECUTE_REVERT:', err);
      throw err;
    }
    const mandateAfter = await client.readContract({
      address: guard,
      abi: readAbi,
      functionName: 'mandates',
      args: [mandateId],
    });
    assert.equal(mandateAfter[6], false, 'Mandate consumed');
    await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'revoke',
      args: [data],
    });
  }

  // ========================================================
  // 2. Performance fee breach triggers exit
  // ========================================================
  {
    const mandateId = await armMandate(1_000_000n);
    const breachingFee = 200_000_000_000_000_000n; // 20% > 15%
    const data = encodeFunctionData({
      abi: setPerformanceFeeAbi,
      functionName: 'setPerformanceFee',
      args: [breachingFee],
    });
    await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'submit',
      args: [data],
    });
    const when = await client.readContract({
      address: vault,
      abi: readAbi,
      functionName: 'executableAt',
      args: [data],
    });

    const exitHash = await relayerClient.writeContract({
      address: guard,
      abi: guardArtifact.abi,
      functionName: 'execute',
      args: [mandateId, data, when],
    });
    const receipt = await client.waitForTransactionReceipt({ hash: exitHash });
    assert.equal(receipt.status, 'success');
    const mandateAfter = await client.readContract({
      address: guard,
      abi: readAbi,
      functionName: 'mandates',
      args: [mandateId],
    });
    assert.equal(mandateAfter[6], false, 'Mandate consumed');
    await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'revoke',
      args: [data],
    });
  }

  // ========================================================
  // 3. Configured relative cap breach triggers exit
  // ========================================================
  {
    const mandateId = await armMandate(1_000_000n);
    const breachingCap = 300_000_000_000_000_000n; // 30% > 25%
    const data = encodeFunctionData({
      abi: increaseRelativeCapAbi,
      functionName: 'increaseRelativeCap',
      args: [testRiskIdData, breachingCap],
    });
    await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'submit',
      args: [data],
    });
    const when = await client.readContract({
      address: vault,
      abi: readAbi,
      functionName: 'executableAt',
      args: [data],
    });

    const exitHash = await relayerClient.writeContract({
      address: guard,
      abi: guardArtifact.abi,
      functionName: 'execute',
      args: [mandateId, data, when],
    });
    const receipt = await client.waitForTransactionReceipt({ hash: exitHash });
    assert.equal(receipt.status, 'success');
    const mandateAfter = await client.readContract({
      address: guard,
      abi: readAbi,
      functionName: 'mandates',
      args: [mandateId],
    });
    assert.equal(mandateAfter[6], false, 'Mandate consumed');
    await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'revoke',
      args: [data],
    });
  }

  // ========================================================
  // 4. Unapproved adapter triggers exit
  // ========================================================
  {
    const mandateId = await armMandate(1_000_000n);
    const data = encodeFunctionData({
      abi: addAdapterAbi,
      functionName: 'addAdapter',
      args: [unapprovedAdapter],
    });
    await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'submit',
      args: [data],
    });
    const when = await client.readContract({
      address: vault,
      abi: readAbi,
      functionName: 'executableAt',
      args: [data],
    });

    const exitHash = await relayerClient.writeContract({
      address: guard,
      abi: guardArtifact.abi,
      functionName: 'execute',
      args: [mandateId, data, when],
    });
    const receipt = await client.waitForTransactionReceipt({ hash: exitHash });
    assert.equal(receipt.status, 'success');
    const mandateAfter = await client.readContract({
      address: guard,
      abi: readAbi,
      functionName: 'mandates',
      args: [mandateId],
    });
    assert.equal(mandateAfter[6], false, 'Mandate consumed');
    await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'revoke',
      args: [data],
    });
  }

  // ========================================================
  // 5a. Unapproved sendSharesGate triggers exit
  // ========================================================
  {
    const mandateId = await armMandate(1_000_000n);
    const data = encodeFunctionData({
      abi: setSendSharesGateAbi,
      functionName: 'setSendSharesGate',
      args: [unapprovedGate],
    });
    await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'submit',
      args: [data],
    });
    const when = await client.readContract({
      address: vault,
      abi: readAbi,
      functionName: 'executableAt',
      args: [data],
    });

    const exitHash = await relayerClient.writeContract({
      address: guard,
      abi: guardArtifact.abi,
      functionName: 'execute',
      args: [mandateId, data, when],
    });
    const receipt = await client.waitForTransactionReceipt({ hash: exitHash });
    assert.equal(receipt.status, 'success');
    const mandateAfter = await client.readContract({
      address: guard,
      abi: readAbi,
      functionName: 'mandates',
      args: [mandateId],
    });
    assert.equal(mandateAfter[6], false, 'Mandate consumed');
    await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'revoke',
      args: [data],
    });
  }

  // ========================================================
  // 5b. Unapproved receiveAssetsGate triggers exit
  // ========================================================
  {
    const mandateId = await armMandate(1_000_000n);
    const data = encodeFunctionData({
      abi: setReceiveAssetsGateAbi,
      functionName: 'setReceiveAssetsGate',
      args: [unapprovedGate],
    });
    await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'submit',
      args: [data],
    });
    const when = await client.readContract({
      address: vault,
      abi: readAbi,
      functionName: 'executableAt',
      args: [data],
    });

    const exitHash = await relayerClient.writeContract({
      address: guard,
      abi: guardArtifact.abi,
      functionName: 'execute',
      args: [mandateId, data, when],
    });
    const receipt = await client.waitForTransactionReceipt({ hash: exitHash });
    assert.equal(receipt.status, 'success');
    const mandateAfter = await client.readContract({
      address: guard,
      abi: readAbi,
      functionName: 'mandates',
      args: [mandateId],
    });
    assert.equal(mandateAfter[6], false, 'Mandate consumed');
    await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'revoke',
      args: [data],
    });
  }

  // ========================================================
  // 6-10. Non-breaching proposals revert
  // ========================================================
  {
    const mandateId = await armMandate(1_000_000n);

    // 6. Management fee <= limit
    const okMgmtData = encodeFunctionData({
      abi: setManagementFeeAbi,
      functionName: 'setManagementFee',
      args: [maxManagementFee],
    });
    await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'submit',
      args: [okMgmtData],
    });
    const whenMgmt = await client.readContract({
      address: vault,
      abi: readAbi,
      functionName: 'executableAt',
      args: [okMgmtData],
    });
    await assert.rejects(
      client.simulateContract({
        account: relayer,
        address: guard,
        abi: guardArtifact.abi,
        functionName: 'execute',
        args: [mandateId, okMgmtData, whenMgmt],
      }),
      /FeeDoesNotBreachLimit/,
    );
    await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'revoke',
      args: [okMgmtData],
    });

    // 7. Performance fee <= limit
    const okPerfData = encodeFunctionData({
      abi: setPerformanceFeeAbi,
      functionName: 'setPerformanceFee',
      args: [maxPerformanceFee],
    });
    await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'submit',
      args: [okPerfData],
    });
    const whenPerf = await client.readContract({
      address: vault,
      abi: readAbi,
      functionName: 'executableAt',
      args: [okPerfData],
    });
    await assert.rejects(
      client.simulateContract({
        account: relayer,
        address: guard,
        abi: guardArtifact.abi,
        functionName: 'execute',
        args: [mandateId, okPerfData, whenPerf],
      }),
      /FeeDoesNotBreachLimit/,
    );
    await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'revoke',
      args: [okPerfData],
    });

    // 8a. Relative cap for unconfigured risk ID
    const unconfiguredRiskIdData = stringToHex('unconfigured-risk');
    const unconfiguredData = encodeFunctionData({
      abi: increaseRelativeCapAbi,
      functionName: 'increaseRelativeCap',
      args: [unconfiguredRiskIdData, 500_000_000_000_000_000n],
    });
    await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'submit',
      args: [unconfiguredData],
    });
    const whenUnconf = await client.readContract({
      address: vault,
      abi: readAbi,
      functionName: 'executableAt',
      args: [unconfiguredData],
    });
    await assert.rejects(
      client.simulateContract({
        account: relayer,
        address: guard,
        abi: guardArtifact.abi,
        functionName: 'execute',
        args: [mandateId, unconfiguredData, whenUnconf],
      }),
      /CapDoesNotBreachLimit/,
    );
    await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'revoke',
      args: [unconfiguredData],
    });

    // 8b. Relative cap <= ceiling
    const okCapData = encodeFunctionData({
      abi: increaseRelativeCapAbi,
      functionName: 'increaseRelativeCap',
      args: [testRiskIdData, maxRelativeCap],
    });
    await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'submit',
      args: [okCapData],
    });
    const whenCap = await client.readContract({
      address: vault,
      abi: readAbi,
      functionName: 'executableAt',
      args: [okCapData],
    });
    await assert.rejects(
      client.simulateContract({
        account: relayer,
        address: guard,
        abi: guardArtifact.abi,
        functionName: 'execute',
        args: [mandateId, okCapData, whenCap],
      }),
      /CapDoesNotBreachLimit/,
    );
    await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'revoke',
      args: [okCapData],
    });

    // 8c. decreaseRelativeCap is unsupported by vault submit and guard execute
    const decCapData = encodeFunctionData({
      abi: decreaseRelativeCapAbi,
      functionName: 'decreaseRelativeCap',
      args: [testRiskIdData, 100_000_000_000_000_000n],
    });
    await assert.rejects(
      client.simulateContract({
        account: owner,
        address: vault,
        abi: vaultAbi,
        functionName: 'submit',
        args: [decCapData],
      }),
      /unsupported/,
    );
    await assert.rejects(
      client.simulateContract({
        account: relayer,
        address: guard,
        abi: guardArtifact.abi,
        functionName: 'execute',
        args: [mandateId, decCapData, 1000n],
      }),
      /UnsupportedProposal/,
    );

    // 9. Approved adapter
    const okAdapterData = encodeFunctionData({
      abi: addAdapterAbi,
      functionName: 'addAdapter',
      args: [approvedAdapter],
    });
    await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'submit',
      args: [okAdapterData],
    });
    const whenAdapter = await client.readContract({
      address: vault,
      abi: readAbi,
      functionName: 'executableAt',
      args: [okAdapterData],
    });
    await assert.rejects(
      client.simulateContract({
        account: relayer,
        address: guard,
        abi: guardArtifact.abi,
        functionName: 'execute',
        args: [mandateId, okAdapterData, whenAdapter],
      }),
      /AdapterIsApproved/,
    );
    await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'revoke',
      args: [okAdapterData],
    });

    // 10a. Gate address(0) (derisking)
    const zeroGateData = encodeFunctionData({
      abi: setSendSharesGateAbi,
      functionName: 'setSendSharesGate',
      args: ['0x0000000000000000000000000000000000000000'],
    });
    await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'submit',
      args: [zeroGateData],
    });
    const whenZero = await client.readContract({
      address: vault,
      abi: readAbi,
      functionName: 'executableAt',
      args: [zeroGateData],
    });
    await assert.rejects(
      client.simulateContract({
        account: relayer,
        address: guard,
        abi: guardArtifact.abi,
        functionName: 'execute',
        args: [mandateId, zeroGateData, whenZero],
      }),
      /GateIsApproved/,
    );
    await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'revoke',
      args: [zeroGateData],
    });

    // 10b. Approved sendSharesGate
    const okSendGateData = encodeFunctionData({
      abi: setSendSharesGateAbi,
      functionName: 'setSendSharesGate',
      args: [approvedGate],
    });
    await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'submit',
      args: [okSendGateData],
    });
    const whenSend = await client.readContract({
      address: vault,
      abi: readAbi,
      functionName: 'executableAt',
      args: [okSendGateData],
    });
    await assert.rejects(
      client.simulateContract({
        account: relayer,
        address: guard,
        abi: guardArtifact.abi,
        functionName: 'execute',
        args: [mandateId, okSendGateData, whenSend],
      }),
      /GateIsApproved/,
    );
    await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'revoke',
      args: [okSendGateData],
    });

    // 10c. Approved receiveAssetsGate
    const okRecvGateData = encodeFunctionData({
      abi: setReceiveAssetsGateAbi,
      functionName: 'setReceiveAssetsGate',
      args: [approvedGate],
    });
    await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'submit',
      args: [okRecvGateData],
    });
    const whenRecv = await client.readContract({
      address: vault,
      abi: readAbi,
      functionName: 'executableAt',
      args: [okRecvGateData],
    });
    await assert.rejects(
      client.simulateContract({
        account: relayer,
        address: guard,
        abi: guardArtifact.abi,
        functionName: 'execute',
        args: [mandateId, okRecvGateData, whenRecv],
      }),
      /GateIsApproved/,
    );
    await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'revoke',
      args: [okRecvGateData],
    });
  }

  // ========================================================
  // 11. Cross-policy isolation and malformed calldata
  // ========================================================
  {
    const mandateId = await armMandate(1_000_000n);

    // Malformed calldata: selector valid, length incorrect (e.g. 20 bytes instead of 36)
    const malformedData = '0xfe56e232000000000000000000000000';
    await assert.rejects(
      client.simulateContract({
        account: relayer,
        address: guard,
        abi: guardArtifact.abi,
        functionName: 'execute',
        args: [mandateId, malformedData, 1000n],
      }),
      /UnsupportedProposal/,
    );

    // Unknown random selector
    const unknownSelectorData =
      '0x123456780000000000000000000000000000000000000000000000000000000000000001';
    await assert.rejects(
      client.simulateContract({
        account: relayer,
        address: guard,
        abi: guardArtifact.abi,
        functionName: 'execute',
        args: [mandateId, unknownSelectorData, 1000n],
      }),
      /UnsupportedProposal/,
    );
  }

  // ========================================================
  // 12. TOCTOU Revocation: precheck true -> curator revokes -> zero exit
  // ========================================================
  {
    const mandateId = await armMandate(1_000_000n);
    const breachingFee = 700_000_000n;
    const data = encodeFunctionData({
      abi: setManagementFeeAbi,
      functionName: 'setManagementFee',
      args: [breachingFee],
    });
    await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'submit',
      args: [data],
    });
    const when = await client.readContract({
      address: vault,
      abi: readAbi,
      functionName: 'executableAt',
      args: [data],
    });
    assert.ok(when > 0n, 'Proposal is pending');

    const sharesBefore = await client.readContract({
      address: vault,
      abi: readAbi,
      functionName: 'balanceOf',
      args: [owner],
    });

    // Curator revokes proposal
    await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'revoke',
      args: [data],
    });

    // Execution must revert with ProposalIsNotExecutable
    await assert.rejects(
      client.simulateContract({
        account: relayer,
        address: guard,
        abi: guardArtifact.abi,
        functionName: 'execute',
        args: [mandateId, data, when],
      }),
      /ProposalIsNotExecutable/,
    );

    // Verify 0 movement, mandate remains active
    const sharesAfter = await client.readContract({
      address: vault,
      abi: readAbi,
      functionName: 'balanceOf',
      args: [owner],
    });
    assert.equal(sharesAfter, sharesBefore);
    const mandateAfter = await client.readContract({
      address: guard,
      abi: readAbi,
      functionName: 'mandates',
      args: [mandateId],
    });
    assert.equal(mandateAfter[6], true, 'Mandate remains active');
  }
});
