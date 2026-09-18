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
  keccak256,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { foundry } from 'viem/chains';
import { Pool } from 'pg';

import { scanConfiguredMandate } from '../src/scanner.js';
import { ExitPipeline } from '../src/pipeline.js';
import { PostgresIntentStore } from '../src/store.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresTest = databaseUrl ? test : test.skip;
const rpcUrl = 'http://127.0.0.1:18551';

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
  'function decreaseRelativeCap(bytes idData, uint256 newRelativeCap)',
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
  'PHASE 2 K & L: scanner produces READY only for relative-cap breach; KeeperHub conditional execution & false check',
  async (context) => {
    const anvil = spawn(
      process.execPath,
      [
        'node_modules/@foundry-rs/anvil/bin.mjs',
        '--host',
        '127.0.0.1',
        '--port',
        '18551',
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

    // Arm mandate with relative cap policy
    const testIdData = '0x112233445566778899aabbccddeeff0011223344' as Hex;
    const testRiskId = keccak256(testIdData);
    const otherIdData = '0xdeadbeef' as Hex;
    const otherRiskId = keccak256(otherIdData);

    const maxRelativeCap = 200_000_000_000_000_000n; // 20% WAD (0.20e18)
    const POLICY_RELATIVE_CAP = 4n;

    const block = await client.getBlock();
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

    // Step 1: Submit non-breaching relative cap (10% <= 20%)
    const nonBreachData = encodeFunctionData({
      abi: increaseRelativeCapAbi,
      functionName: 'increaseRelativeCap',
      args: [testIdData, 100_000_000_000_000_000n],
    });
    const submitNonBreach = await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'submit',
      args: [nonBreachData],
    });
    await client.waitForTransactionReceipt({ hash: submitNonBreach });

    // Scan should record decision but create 0 READY intents
    const nonBreachScan = await scanConfiguredMandate({ client, store, config });
    assert.equal(nonBreachScan.proposals, 1);
    assert.equal(nonBreachScan.readyCreated, 0);
    assert.equal(nonBreachScan.decisionsRecorded, 1);

    const nonBreachDecisions = await pool.query<{ decision: string }>(
      'SELECT decision FROM proposal_decisions',
    );
    assert.deepEqual(
      nonBreachDecisions.rows.map((r) => r.decision),
      ['cap-within-owner-limit'],
    );
    const nonBreachIntents = await pool.query('SELECT count(*) FROM exit_intents');
    assert.equal(nonBreachIntents.rows[0].count, '0');

    // Revoke non-breach
    await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'revoke',
      args: [nonBreachData],
    });

    // Step 2: Submit unconfigured risk ID (50%)
    const unconfData = encodeFunctionData({
      abi: increaseRelativeCapAbi,
      functionName: 'increaseRelativeCap',
      args: [otherIdData, 500_000_000_000_000_000n],
    });
    const submitUnconf = await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'submit',
      args: [unconfData],
    });
    await client.waitForTransactionReceipt({ hash: submitUnconf });

    const unconfScan = await scanConfiguredMandate({ client, store, config });
    assert.equal(unconfScan.readyCreated, 0);
    const unconfDecisions = await pool.query<{ decision: string }>(
      'SELECT decision FROM proposal_decisions ORDER BY created_at DESC LIMIT 1',
    );
    assert.equal(unconfDecisions.rows[0]?.decision, 'risk-not-configured');

    // Revoke unconfigured
    await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'revoke',
      args: [unconfData],
    });

    // Step 3: Derisking decreaseRelativeCap executed directly -> 0 READY intents
    await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'decreaseRelativeCap',
      args: [testIdData, 100_000_000_000_000_000n],
    });
    const deriskScan = await scanConfiguredMandate({ client, store, config });
    assert.equal(deriskScan.readyCreated, 0);

    // Step 4: Submit breaching relative cap (50% > 20%)
    const breachData = encodeFunctionData({
      abi: increaseRelativeCapAbi,
      functionName: 'increaseRelativeCap',
      args: [testIdData, 500_000_000_000_000_000n],
    });
    const submitBreach = await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'submit',
      args: [breachData],
    });
    await client.waitForTransactionReceipt({ hash: submitBreach });

    // Scan should record eligible and create 1 READY intent
    const breachScan = await scanConfiguredMandate({ client, store, config });
    assert.equal(breachScan.readyCreated, 1);

    const breachIntents = await pool.query<{ state: string; execution_mode: string }>(
      'SELECT state, execution_mode FROM exit_intents',
    );
    assert.equal(breachIntents.rowCount, 1);
    assert.equal(breachIntents.rows[0]?.state, 'READY');
    assert.equal(breachIntents.rows[0]?.execution_mode, 'conditional');

    // Step 5: Test KeeperHub conditional false (curator revokes proposal)
    const revokeBreach = await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'revoke',
      args: [breachData],
    });
    await client.waitForTransactionReceipt({ hash: revokeBreach });

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
    }).runOnce('rel-cap-worker');

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
