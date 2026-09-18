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
const rpcUrl = 'http://127.0.0.1:18550';

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
  'PHASE 1 K & L: scanner produces READY only for performance-fee breach; KeeperHub conditional false produces zero broadcast',
  async (context) => {
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

    // Deploy Guard V2
    const guardHash = await ownerClient.deployContract({
      abi: compiledContracts.abi,
      bytecode: `0x${compiledContracts.evm.bytecode.object}`,
      args: [factory],
    });
    const guardReceipt = await client.waitForTransactionReceipt({ hash: guardHash });
    const guard = guardReceipt.contractAddress!;

    // Deposit and approve
    const depositAmount = 1_000_000n;
    await ownerClient.writeContract({
      address: asset,
      abi: assetArtifact.abi,
      functionName: 'approve',
      args: [vault, depositAmount],
    });
    await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'deposit',
      args: [depositAmount, owner],
    });
    await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'approve',
      args: [guard, depositAmount],
    });

    const block = await client.getBlock();
    const maxPerformanceFee = 100_000_000_000_000_000n; // 10%
    const POLICY_PERFORMANCE_FEE = 2n;

    // Arm V2 Mandate with Performance Fee Policy
    const armHash = await ownerClient.writeContract({
      address: guard,
      abi: compiledContracts.abi,
      functionName: 'armPolicyMandate',
      args: [
        vault,
        depositAmount,
        depositAmount,
        block.timestamp + 86_400n,
        300n,
        {
          policyFlags: POLICY_PERFORMANCE_FEE,
          maxManagementFee: 0n,
          maxPerformanceFee,
          relativeCaps: [],
          approvedAdapters: [],
          approvedSendSharesGates: [],
          approvedReceiveAssetsGates: [],
        },
      ],
    });
    const armReceipt = await client.waitForTransactionReceipt({ hash: armHash });

    // Setup Postgres
    const pool = new Pool({ connectionString: databaseUrl });
    context.after(() => pool.end());
    const store = new PostgresIntentStore(pool);
    for (const migration of [
      '0001_exit_intents.sql',
      '0002_proposal_decisions.sql',
      '0003_managed_rules.sql',
      '0004_keeperhub_conditional.sql',
      '0005_proposal_attempts.sql',
      '0006_multi_policy_rules.sql',
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

    // Step 1: Submit non-breaching performance fee (5% <= 10%)
    const nonBreachData = encodeFunctionData({
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
      args: [50_000_000_000_000_000n],
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
      ['fee-within-owner-limit'],
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

    // Step 1b: Submit management fee proposal when management fee policy is disabled (Finding 5)
    const mgmtFeeData = encodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'setManagementFee',
          stateMutability: 'nonpayable',
          inputs: [{ name: 'newFee', type: 'uint256' }],
          outputs: [],
        },
      ],
      functionName: 'setManagementFee',
      args: [50_000_000_000_000_000n],
    });
    const submitMgmtFee = await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'submit',
      args: [mgmtFeeData],
    });
    await client.waitForTransactionReceipt({ hash: submitMgmtFee });

    const mgmtFeeScan = await scanConfiguredMandate({ client, store, config });
    assert.equal(mgmtFeeScan.proposals, 1);
    assert.equal(mgmtFeeScan.readyCreated, 0);
    assert.equal(mgmtFeeScan.decisionsRecorded, 1);

    const mgmtFeeDecisions = await pool.query<{ decision: string }>(
      'SELECT decision FROM proposal_decisions ORDER BY created_at DESC LIMIT 1',
    );
    assert.equal(mgmtFeeDecisions.rows[0]?.decision, 'policy-disabled');

    const mgmtFeeIntents = await pool.query('SELECT count(*) FROM exit_intents');
    assert.equal(mgmtFeeIntents.rows[0].count, '0');

    // Revoke management fee
    await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'revoke',
      args: [mgmtFeeData],
    });

    // Step 2: Submit breaching performance fee (20% > 10%)
    const breachData = encodeFunctionData({
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
      args: [200_000_000_000_000_000n],
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

    // Step 3: Test KeeperHub conditional false (e.g. if curator revokes before KeeperHub execution)
    // Revoke the proposal on vault
    const revokeBreach = await ownerClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'revoke',
      args: [breachData],
    });
    await client.waitForTransactionReceipt({ hash: revokeBreach });

    // Mock KeeperHub server that performs condition check: observed 0 != expected -> executed: false
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
    }).runOnce('perf-worker');

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
