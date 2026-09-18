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

const rpcUrl = 'http://127.0.0.1:18554';
const readAbi = parseAbi([
  'function latestAsset() view returns (address)',
  'function latestVault() view returns (address)',
  'function balanceOf(address account) view returns (uint256)',
  'function activeMandateByOwnerVault(address owner, address vault) view returns (uint256)',
  'function mandates(uint256 mandateId) view returns (address owner, address vault, uint256 shares, uint256 minAssets, uint256 expiresAt, uint256 safetySeconds, bool active, uint256 policyFlags, uint256 maxManagementFee, uint256 maxPerformanceFee)',
  'function approvedSendSharesGateByMandate(uint256 mandateId, address gate) view returns (bool)',
  'function approvedReceiveAssetsGateByMandate(uint256 mandateId, address gate) view returns (bool)',
  'function executableAt(bytes data) view returns (uint256)',
]);

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
  throw new Error('redemption-gate test RPC did not start');
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

test('PHASE 4 H-J, M: VetoExitGuardV2 redemption gate allowlist enforcement and TOCTOU safety', async (context) => {
  const anvil = spawn(
    process.execPath,
    [
      'node_modules/@foundry-rs/anvil/bin.mjs',
      '--host',
      '127.0.0.1',
      '--port',
      '18554',
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
  const guardV2Artifact = compiled['VetoExitGuardV2.sol'].VetoExitGuardV2;

  const factoryAddress = await deploy(ownerClient, publicClient, factoryArtifact);
  const guardV2Address = await deploy(ownerClient, publicClient, guardV2Artifact, [factoryAddress]);

  // Create controlled vault: 10,000 initialAssets, 3600s timelock
  const createHash = await ownerClient.writeContract({
    address: factoryAddress,
    abi: factoryArtifact.abi,
    functionName: 'create',
    args: [10_000n, 3600n],
  });
  await publicClient.waitForTransactionReceipt({ hash: createHash });

  const assetAddress = await publicClient.readContract({
    address: factoryAddress,
    abi: readAbi,
    functionName: 'latestAsset',
  });
  const vaultAddress = await publicClient.readContract({
    address: factoryAddress,
    abi: readAbi,
    functionName: 'latestVault',
  });

  // Deposit 10,000 into vault for owner
  await ownerClient.writeContract({
    address: assetAddress,
    abi: assetArtifact.abi,
    functionName: 'approve',
    args: [vaultAddress, 10_000n],
  });
  await ownerClient.writeContract({
    address: vaultAddress,
    abi: vaultArtifact.abi,
    functionName: 'deposit',
    args: [10_000n, owner],
  });

  // Approve guard
  await ownerClient.writeContract({
    address: vaultAddress,
    abi: vaultArtifact.abi,
    functionName: 'approve',
    args: [guardV2Address, 10_000n],
  });

  const approvedSendGate = getAddress('0x1111111111111111111111111111111111111111');
  const approvedReceiveGate = getAddress('0x2222222222222222222222222222222222222222');
  const unapprovedGate = getAddress('0x3333333333333333333333333333333333333333');
  const zeroGate = getAddress('0x0000000000000000000000000000000000000000');

  // Verify InvalidMandate if address(0) is passed in approved gates
  await assert.rejects(
    publicClient.simulateContract({
      account: owner,
      address: guardV2Address,
      abi: guardV2Artifact.abi,
      functionName: 'armPolicyMandate',
      args: [
        vaultAddress,
        10_000n,
        10_000n,
        BigInt(Math.floor(Date.now() / 1000) + 86400),
        300n,
        {
          policyFlags: 16n, // POLICY_REDEMPTION_GATE_ALLOWLIST
          maxManagementFee: 0n,
          maxPerformanceFee: 0n,
          relativeCaps: [],
          approvedAdapters: [],
          approvedSendSharesGates: [zeroGate],
          approvedReceiveAssetsGates: [],
        },
      ],
    }),
    /InvalidMandate/,
  );

  // Arm valid mandate with approved gates
  const armHash = await ownerClient.writeContract({
    address: guardV2Address,
    abi: guardV2Artifact.abi,
    functionName: 'armPolicyMandate',
    args: [
      vaultAddress,
      10_000n,
      10_000n,
      BigInt(Math.floor(Date.now() / 1000) + 86400),
      300n,
      {
        policyFlags: 16n, // POLICY_REDEMPTION_GATE_ALLOWLIST
        maxManagementFee: 0n,
        maxPerformanceFee: 0n,
        relativeCaps: [],
        approvedAdapters: [],
        approvedSendSharesGates: [approvedSendGate],
        approvedReceiveAssetsGates: [approvedReceiveGate],
      },
    ],
  });
  await publicClient.waitForTransactionReceipt({ hash: armHash });

  const mandateId = 0n;
  const isSendApproved = await publicClient.readContract({
    address: guardV2Address,
    abi: readAbi,
    functionName: 'approvedSendSharesGateByMandate',
    args: [mandateId, approvedSendGate],
  });
  assert.equal(isSendApproved, true);

  const isReceiveApproved = await publicClient.readContract({
    address: guardV2Address,
    abi: readAbi,
    functionName: 'approvedReceiveAssetsGateByMandate',
    args: [mandateId, approvedReceiveGate],
  });
  assert.equal(isReceiveApproved, true);

  // 1. Submit proposal for approved send shares gate => GateIsApproved revert
  const approvedSendProposal = encodeFunctionData({
    abi: setSendSharesGateAbi,
    functionName: 'setSendSharesGate',
    args: [approvedSendGate],
  });
  await ownerClient.writeContract({
    address: vaultAddress,
    abi: vaultArtifact.abi,
    functionName: 'submit',
    args: [approvedSendProposal],
  });
  const execAtApprovedSend = await publicClient.readContract({
    address: vaultAddress,
    abi: readAbi,
    functionName: 'executableAt',
    args: [approvedSendProposal],
  });

  await assert.rejects(
    publicClient.simulateContract({
      account: relayer,
      address: guardV2Address,
      abi: guardV2Artifact.abi,
      functionName: 'execute',
      args: [mandateId, approvedSendProposal, execAtApprovedSend],
    }),
    /GateIsApproved/,
  );

  // Malformed proposal checks (wrong selector or extra trailing bytes)
  await assert.rejects(
    publicClient.simulateContract({
      account: relayer,
      address: guardV2Address,
      abi: guardV2Artifact.abi,
      functionName: 'execute',
      args: [mandateId, '0xc21ad0281122', 12345n],
    }),
    /UnsupportedProposal/,
  );
  await assert.rejects(
    publicClient.simulateContract({
      account: relayer,
      address: guardV2Address,
      abi: guardV2Artifact.abi,
      functionName: 'execute',
      args: [mandateId, `${approvedSendProposal}00`, 12345n],
    }),
    /UnsupportedProposal/,
  );

  // Revoke approved proposal to clean up
  await ownerClient.writeContract({
    address: vaultAddress,
    abi: vaultArtifact.abi,
    functionName: 'revoke',
    args: [approvedSendProposal],
  });

  // 2. Submit proposal for address(0) (ungated / derisking) => GateIsApproved revert
  const zeroSendProposal = encodeFunctionData({
    abi: setSendSharesGateAbi,
    functionName: 'setSendSharesGate',
    args: [zeroGate],
  });
  await ownerClient.writeContract({
    address: vaultAddress,
    abi: vaultArtifact.abi,
    functionName: 'submit',
    args: [zeroSendProposal],
  });
  const execAtZeroSend = await publicClient.readContract({
    address: vaultAddress,
    abi: readAbi,
    functionName: 'executableAt',
    args: [zeroSendProposal],
  });

  await assert.rejects(
    publicClient.simulateContract({
      account: relayer,
      address: guardV2Address,
      abi: guardV2Artifact.abi,
      functionName: 'execute',
      args: [mandateId, zeroSendProposal, execAtZeroSend],
    }),
    /GateIsApproved/,
  );

  await ownerClient.writeContract({
    address: vaultAddress,
    abi: vaultArtifact.abi,
    functionName: 'revoke',
    args: [zeroSendProposal],
  });

  // 3. Submit proposal for approved receive assets gate => GateIsApproved revert
  const approvedReceiveProposal = encodeFunctionData({
    abi: setReceiveAssetsGateAbi,
    functionName: 'setReceiveAssetsGate',
    args: [approvedReceiveGate],
  });
  await ownerClient.writeContract({
    address: vaultAddress,
    abi: vaultArtifact.abi,
    functionName: 'submit',
    args: [approvedReceiveProposal],
  });
  const execAtApprovedReceive = await publicClient.readContract({
    address: vaultAddress,
    abi: readAbi,
    functionName: 'executableAt',
    args: [approvedReceiveProposal],
  });

  await assert.rejects(
    publicClient.simulateContract({
      account: relayer,
      address: guardV2Address,
      abi: guardV2Artifact.abi,
      functionName: 'execute',
      args: [mandateId, approvedReceiveProposal, execAtApprovedReceive],
    }),
    /GateIsApproved/,
  );

  await ownerClient.writeContract({
    address: vaultAddress,
    abi: vaultArtifact.abi,
    functionName: 'revoke',
    args: [approvedReceiveProposal],
  });

  // 4. TOCTOU safety: submit unapproved gate proposal, then revoke it before execute
  const unapprovedSendProposal = encodeFunctionData({
    abi: setSendSharesGateAbi,
    functionName: 'setSendSharesGate',
    args: [unapprovedGate],
  });
  await ownerClient.writeContract({
    address: vaultAddress,
    abi: vaultArtifact.abi,
    functionName: 'submit',
    args: [unapprovedSendProposal],
  });
  const execAtUnapproved = await publicClient.readContract({
    address: vaultAddress,
    abi: readAbi,
    functionName: 'executableAt',
    args: [unapprovedSendProposal],
  });

  // Revoke before execution
  await ownerClient.writeContract({
    address: vaultAddress,
    abi: vaultArtifact.abi,
    functionName: 'revoke',
    args: [unapprovedSendProposal],
  });

  await assert.rejects(
    publicClient.simulateContract({
      account: relayer,
      address: guardV2Address,
      abi: guardV2Artifact.abi,
      functionName: 'execute',
      args: [mandateId, unapprovedSendProposal, execAtUnapproved],
    }),
    /ProposalIsNotExecutable/,
  );

  // 5. Abdication safety: if selector abdicated on vault, reverts ProposalIsNotExecutable
  await ownerClient.writeContract({
    address: vaultAddress,
    abi: vaultArtifact.abi,
    functionName: 'submit',
    args: [unapprovedSendProposal],
  });
  const execAtAbdicated = await publicClient.readContract({
    address: vaultAddress,
    abi: readAbi,
    functionName: 'executableAt',
    args: [unapprovedSendProposal],
  });

  await ownerClient.writeContract({
    address: vaultAddress,
    abi: vaultArtifact.abi,
    functionName: 'abdicate',
    args: ['0xc21ad028'], // SET_SEND_SHARES_GATE_SELECTOR
  });

  await assert.rejects(
    publicClient.simulateContract({
      account: relayer,
      address: guardV2Address,
      abi: guardV2Artifact.abi,
      functionName: 'execute',
      args: [mandateId, unapprovedSendProposal, execAtAbdicated],
    }),
    /ProposalIsNotExecutable/,
  );

  await ownerClient.writeContract({
    address: vaultAddress,
    abi: vaultArtifact.abi,
    functionName: 'revoke',
    args: [unapprovedSendProposal],
  });

  // 6. Test BREACH EXECUTION on unapproved receive assets gate
  // Deploy fresh vault where SET_RECEIVE_ASSETS_GATE_SELECTOR is not abdicated
  const createHash2 = await ownerClient.writeContract({
    address: factoryAddress,
    abi: factoryArtifact.abi,
    functionName: 'create',
    args: [10_000n, 3600n],
  });
  await publicClient.waitForTransactionReceipt({ hash: createHash2 });
  const asset2Address = await publicClient.readContract({
    address: factoryAddress,
    abi: readAbi,
    functionName: 'latestAsset',
  });
  const vault2Address = await publicClient.readContract({
    address: factoryAddress,
    abi: readAbi,
    functionName: 'latestVault',
  });

  // Deposit 10,000 for owner in vault2
  await ownerClient.writeContract({
    address: asset2Address,
    abi: assetArtifact.abi,
    functionName: 'approve',
    args: [vault2Address, 10_000n],
  });
  await ownerClient.writeContract({
    address: vault2Address,
    abi: vaultArtifact.abi,
    functionName: 'deposit',
    args: [10_000n, owner],
  });
  await ownerClient.writeContract({
    address: vault2Address,
    abi: vaultArtifact.abi,
    functionName: 'approve',
    args: [guardV2Address, 10_000n],
  });

  // Arm mandate on vault2
  const arm2Hash = await ownerClient.writeContract({
    address: guardV2Address,
    abi: guardV2Artifact.abi,
    functionName: 'armPolicyMandate',
    args: [
      vault2Address,
      10_000n,
      10_000n,
      BigInt(Math.floor(Date.now() / 1000) + 86400),
      300n,
      {
        policyFlags: 16n, // POLICY_REDEMPTION_GATE_ALLOWLIST
        maxManagementFee: 0n,
        maxPerformanceFee: 0n,
        relativeCaps: [],
        approvedAdapters: [],
        approvedSendSharesGates: [],
        approvedReceiveAssetsGates: [approvedReceiveGate],
      },
    ],
  });
  await publicClient.waitForTransactionReceipt({ hash: arm2Hash });
  const mandate2Id = 1n;

  // Submit unapproved receive assets gate proposal
  const unapprovedReceiveProposal = encodeFunctionData({
    abi: setReceiveAssetsGateAbi,
    functionName: 'setReceiveAssetsGate',
    args: [unapprovedGate],
  });
  await ownerClient.writeContract({
    address: vault2Address,
    abi: vaultArtifact.abi,
    functionName: 'submit',
    args: [unapprovedReceiveProposal],
  });
  const execAtUnapprovedReceive = await publicClient.readContract({
    address: vault2Address,
    abi: readAbi,
    functionName: 'executableAt',
    args: [unapprovedReceiveProposal],
  });

  // Execute breach exit!
  const execHash = await relayerClient.writeContract({
    address: guardV2Address,
    abi: guardV2Artifact.abi,
    functionName: 'execute',
    args: [mandate2Id, unapprovedReceiveProposal, execAtUnapprovedReceive],
  });
  const execReceipt = await publicClient.waitForTransactionReceipt({ hash: execHash });
  assert.equal(execReceipt.status, 'success');

  // Verify owner received the redeemed assets
  const ownerAssetBalance = await publicClient.readContract({
    address: asset2Address,
    abi: readAbi,
    functionName: 'balanceOf',
    args: [owner],
  });
  assert.ok(ownerAssetBalance >= 10_000n);

  // Verify mandate consumed
  const mandateState = await publicClient.readContract({
    address: guardV2Address,
    abi: readAbi,
    functionName: 'mandates',
    args: [mandate2Id],
  });
  assert.equal(mandateState[6], false); // active = false

  // 7. Duplicate execution protection
  await assert.rejects(
    publicClient.simulateContract({
      account: relayer,
      address: guardV2Address,
      abi: guardV2Artifact.abi,
      functionName: 'execute',
      args: [mandate2Id, unapprovedReceiveProposal, execAtUnapprovedReceive],
    }),
    /MandateInactive/,
  );
});
