import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';

import { KeeperHubClient } from '@veto/keeperhub';
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
  type Abi,
  type Address,
} from 'viem';
import { foundry } from 'viem/chains';
import { Pool } from 'pg';

import { scanConfiguredMandate } from '../src/scanner.js';
import { ExitPipeline } from '../src/pipeline.js';
import { PostgresIntentStore } from '../src/store.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresTest = databaseUrl ? test : test.skip;
const rpcUrl = 'http://127.0.0.1:18554';

const readAbi = parseAbi([
  'function latestAsset() view returns (address)',
  'function latestVault() view returns (address)',
  'function balanceOf(address account) view returns (uint256)',
  'function executableAt(bytes data) view returns (uint256)',
]);

const vaultAbi = parseAbi([
  'function submit(bytes data)',
  'function revoke(bytes data)',
  'function approve(address spender, uint256 shares) returns (bool)',
  'function deposit(uint256 assets, address onBehalf) returns (uint256)',
]);

const setSendSharesGateAbi = [
  {
    type: 'function',
    name: 'setSendSharesGate',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newGate', type: 'address' }],
    outputs: [],
  },
] as const;

const setReceiveAssetsGateAbi = [
  {
    type: 'function',
    name: 'setReceiveAssetsGate',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newGate', type: 'address' }],
    outputs: [],
  },
] as const;

async function waitForRpc(client: { getBlockNumber(): Promise<bigint> }) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      await client.getBlockNumber();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('test RPC did not start');
}

postgresTest(
  'PHASE 4 K & L: scanner produces READY only for unapproved gate; KeeperHub conditional false check',
  async (context) => {
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
      { cwd: new URL('../../../contracts/', import.meta.url), stdio: 'ignore' },
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

    const compiledContracts = JSON.parse(
      await readFile(
        new URL('../../../contracts/dist/VetoExitGuardV2.json', import.meta.url),
        'utf8',
      ),
    ) as { abi: Abi; evm: { bytecode: { object: string } } };
    const factoryArtifact = JSON.parse(
      await readFile(
        new URL('../../../contracts/dist/ControlledVaultV2Factory.json', import.meta.url),
        'utf8',
      ),
    ) as { abi: Abi; evm: { bytecode: { object: string } } };
    const vaultArtifact = JSON.parse(
      await readFile(
        new URL('../../../contracts/dist/ControlledVaultV2Fixture.json', import.meta.url),
        'utf8',
      ),
    ) as { abi: Abi; evm: { bytecode: { object: string } } };
    const assetArtifact = JSON.parse(
      await readFile(new URL('../../../contracts/dist/FixtureAsset.json', import.meta.url), 'utf8'),
    ) as { abi: Abi; evm: { bytecode: { object: string } } };

    // Deploy factory
    const factoryHash = await ownerClient.deployContract({
      abi: factoryArtifact.abi,
      bytecode: `0x${factoryArtifact.evm.bytecode.object}`,
      args: [],
    });
    const factoryReceipt = await client.waitForTransactionReceipt({ hash: factoryHash });
    const factory = factoryReceipt.contractAddress!;

    // Create fixture vault
    const createVaultHash = await ownerClient.writeContract({
      address: factory,
      abi: factoryArtifact.abi,
      functionName: 'create',
      args: [10_000_000n, 3_600n],
    });
    await client.waitForTransactionReceipt({ hash: createVaultHash });
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

    // Deploy V2 guard
    const guardHash = await ownerClient.deployContract({
      abi: compiledContracts.abi,
      bytecode: `0x${compiledContracts.evm.bytecode.object}`,
      args: [factory],
    });
    const guardReceipt = await client.waitForTransactionReceipt({ hash: guardHash });
    const guard = guardReceipt.contractAddress!;

    // Owner deposits 1_000_000 assets and approves guard
    const depositAmount = 1_000_000n;
    const approveAsset = await ownerClient.writeContract({
      address: asset,
      abi: assetArtifact.abi,
      functionName: 'approve',
      args: [vault, depositAmount],
    });
    await client.waitForTransactionReceipt({ hash: approveAsset });

    const depositHash = await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'deposit',
      args: [depositAmount, owner],
    });
    await client.waitForTransactionReceipt({ hash: depositHash });

    const approveShares = await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'approve',
      args: [guard, depositAmount],
    });
    await client.waitForTransactionReceipt({ hash: approveShares });

    // Arm mandate with redemption gate allowlist policy (flag 16n)
    const approvedGate = getAddress('0x1111111111111111111111111111111111111111');
    const unapprovedGate = getAddress('0x2222222222222222222222222222222222222222');
    const zeroGate = getAddress('0x0000000000000000000000000000000000000000');
    const POLICY_REDEMPTION_GATE_ALLOWLIST = 16n;

    const block = await client.getBlock();
    const policyConfig = {
      policyFlags: POLICY_REDEMPTION_GATE_ALLOWLIST,
      maxManagementFee: 0n,
      maxPerformanceFee: 0n,
      relativeCaps: [],
      approvedAdapters: [],
      approvedSendSharesGates: [approvedGate],
      approvedReceiveAssetsGates: [approvedGate],
    };

    const armHash = await ownerClient.writeContract({
      address: guard,
      abi: compiledContracts.abi,
      functionName: 'armPolicyMandate',
      args: [vault, depositAmount, depositAmount, block.timestamp + 7_200n, 300n, policyConfig],
    });
    const armReceipt = await client.waitForTransactionReceipt({ hash: armHash });

    // Database setup
    const pool = new Pool({ connectionString: databaseUrl });
    context.after(() => pool.end());
    const store = new PostgresIntentStore(pool);
    for (const migration of [
      '0001_exit_intents.sql',
      '0002_proposal_decisions.sql',
      '0003_managed_rules.sql',
      '0004_keeperhub_conditional.sql',
      '0005_proposal_attempts.sql',
    ]) {
      await store.applyMigration(
        await readFile(new URL(`../../../db/migrations/${migration}`, import.meta.url), 'utf8'),
      );
    }
    await pool.query(
      'TRUNCATE proposal_decisions, exit_intent_events, exit_intents, scanner_checkpoints, managed_rule_checkpoints RESTART IDENTITY',
    );

    const config = {
      chainId: foundry.id,
      factory,
      vault,
      guard,
      mandateId: 0n,
      startBlock: armReceipt.blockNumber,
      confirmationDepth: 0n,
      reorgRewindBlocks: 12n,
      guardVersion: 'v2' as const,
      executionMode: 'conditional' as const,
    };

    // Step 1: Submit address(0) (derisking / ungated) proposal
    const zeroData = encodeFunctionData({
      abi: setSendSharesGateAbi,
      functionName: 'setSendSharesGate',
      args: [zeroGate],
    });
    const submitZero = await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'submit',
      args: [zeroData],
    });
    await client.waitForTransactionReceipt({ hash: submitZero });

    // Scan should record decision 'gate-approved' and create 0 READY intents
    const zeroScan = await scanConfiguredMandate({ client, store, config });
    assert.equal(zeroScan.proposals, 1);
    assert.equal(zeroScan.readyCreated, 0);
    assert.equal(zeroScan.decisionsRecorded, 1);

    const zeroDecisions = await pool.query<{ decision: string }>(
      'SELECT decision FROM proposal_decisions',
    );
    assert.deepEqual(
      zeroDecisions.rows.map((r) => r.decision),
      ['gate-approved'],
    );

    // Revoke zero proposal
    await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'revoke',
      args: [zeroData],
    });

    // Step 2: Submit approved gate proposal (for receiveAssetsGate)
    const approvedData = encodeFunctionData({
      abi: setReceiveAssetsGateAbi,
      functionName: 'setReceiveAssetsGate',
      args: [approvedGate],
    });
    const submitApproved = await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'submit',
      args: [approvedData],
    });
    await client.waitForTransactionReceipt({ hash: submitApproved });

    // Scan should record decision 'gate-approved' and create 0 READY intents
    const approvedScan = await scanConfiguredMandate({ client, store, config });
    assert.equal(approvedScan.readyCreated, 0);

    // Revoke approved proposal
    await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'revoke',
      args: [approvedData],
    });

    // Step 3: Submit unapproved gate proposal (for sendSharesGate)
    const unapprovedData = encodeFunctionData({
      abi: setSendSharesGateAbi,
      functionName: 'setSendSharesGate',
      args: [unapprovedGate],
    });
    const submitUnapproved = await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'submit',
      args: [unapprovedData],
    });
    await client.waitForTransactionReceipt({ hash: submitUnapproved });

    // Scan should record eligible and create 1 READY intent
    const unapprovedScan = await scanConfiguredMandate({ client, store, config });
    assert.equal(unapprovedScan.readyCreated, 1);

    const unapprovedIntents = await pool.query<{ state: string; execution_mode: string }>(
      'SELECT state, execution_mode FROM exit_intents',
    );
    assert.equal(unapprovedIntents.rowCount, 1);
    assert.equal(unapprovedIntents.rows[0]?.state, 'READY');
    assert.equal(unapprovedIntents.rows[0]?.execution_mode, 'conditional');

    // Step 4: Test KeeperHub conditional false (curator revokes proposal)
    const revokeUnapproved = await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'revoke',
      args: [unapprovedData],
    });
    await client.waitForTransactionReceipt({ hash: revokeUnapproved });

    // Mock KeeperHub server returning executed: false
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        '{"executed":false,"conditionResult":{"met":false,"observedValue":"0","targetValue":"10000","operator":"eq"}}',
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    context.after(() => server.close());
    const address = server.address();
    assert(address && typeof address !== 'string');

    const keeperClient = new KeeperHubClient({
      apiKey: 'kh_test-only',
      baseUrl: `http://127.0.0.1:${address.port}`,
    });

    const pipelineResult = await new ExitPipeline(store, keeperClient, async () => {
      throw new Error('RECONCILIATION_MUST_NOT_RUN_ON_CONDITIONAL_FALSE');
    }).runOnce('gate-worker');

    assert.equal(pipelineResult?.state, 'BLOCKED');
    assert.equal(pipelineResult?.lastError, 'PROPOSAL_NOT_PENDING_AT_EXECUTION');
    assert.equal(pipelineResult?.executionId, undefined);
    assert.equal(pipelineResult?.transactionHash, undefined);
    assert.equal(pipelineResult?.reconciliation?.economicEffect, 'none');

    // Confirm no assets were moved
    const finalShares = await client.readContract({
      address: vault,
      abi: readAbi,
      functionName: 'balanceOf',
      args: [owner],
    });
    assert.equal(finalShares, depositAmount);
  },
);
