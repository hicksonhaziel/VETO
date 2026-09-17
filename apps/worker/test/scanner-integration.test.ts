import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
  type Abi,
} from 'viem';
import { base } from 'viem/chains';
import { Pool } from 'pg';

import { scanConfiguredMandate } from '../src/scanner.js';
import { PostgresIntentStore } from '../src/store.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresTest = databaseUrl ? test : test.skip;
const rpcUrl = 'http://127.0.0.1:18549';
const forkUrl = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const forkBlock = 51_221_130;
const factory = getAddress('0x4501125508079A99ebBebCE205DeC9593C2b5857');
const vault = getAddress('0x050cE30b927Da55177A4914EC73480238BAD56f0');
const owner = getAddress('0xa0894a415c4f246ce95bae718849579c099cc1d2');
const curator = getAddress('0x9E33faAE38ff641094fa68c65c2cE600b3410585');
const deployer = getAddress('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266');
const vaultAbi = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function submit(bytes data)',
  'function setManagementFee(uint256 newManagementFee)',
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
  throw new Error('scanner integration RPC did not start');
}

postgresTest(
  'scanner turns one real Morpho proposal into one durable ready intent',
  async (context) => {
    const anvil = spawn(
      process.execPath,
      [
        'node_modules/@foundry-rs/anvil/bin.mjs',
        '--host',
        '127.0.0.1',
        '--port',
        '18549',
        '--fork-url',
        forkUrl,
        '--fork-block-number',
        String(forkBlock),
        '--hardfork',
        'cancun',
        '--silent',
      ],
      { cwd: new URL('../../../contracts/', import.meta.url), stdio: 'ignore' },
    );
    context.after(() => anvil.kill('SIGTERM'));
    const client = createPublicClient({ chain: base, transport: http(rpcUrl), cacheTime: 0 });
    await waitForRpc(client);
    const testClient = createTestClient({ chain: base, mode: 'anvil', transport: http(rpcUrl) });
    for (const address of [owner, curator]) {
      await testClient.setBalance({ address, value: 1_000_000_000_000_000_000n });
      await testClient.impersonateAccount({ address });
    }
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
    const guardArtifact = JSON.parse(
      await readFile(
        new URL('../../../contracts/dist/VetoExitGuard.json', import.meta.url),
        'utf8',
      ),
    ) as { abi: Abi; evm: { bytecode: { object: string } } };
    const deploymentHash = await deployerClient.deployContract({
      abi: guardArtifact.abi,
      bytecode: `0x${guardArtifact.evm.bytecode.object}`,
      args: [factory],
    });
    const deployment = await client.waitForTransactionReceipt({ hash: deploymentHash });
    assert.ok(deployment.contractAddress);
    const guard = deployment.contractAddress;

    const shares = await client.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'balanceOf',
      args: [owner],
    });
    const block = await client.getBlock();
    const feeCeiling = 10n ** 16n / 31_536_000n;
    const armHash = await ownerClient.writeContract({
      address: guard,
      abi: guardArtifact.abi,
      functionName: 'arm',
      args: [vault, shares, feeCeiling, 1n, block.timestamp + 86_400n, 300n],
    });
    await client.waitForTransactionReceipt({ hash: armHash });
    const proposalData = encodeFunctionData({
      abi: vaultAbi,
      functionName: 'setManagementFee',
      args: [(2n * 10n ** 16n) / 31_536_000n],
    });
    const submitHash = await curatorClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'submit',
      args: [proposalData],
    });
    const submitReceipt = await client.waitForTransactionReceipt({ hash: submitHash });

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
      chainId: base.id,
      factory,
      vault,
      guard,
      mandateId: 0n,
      startBlock: submitReceipt.blockNumber,
      confirmationDepth: 0n,
      reorgRewindBlocks: 12n,
    };
    const first = await scanConfiguredMandate({ client, store, config });
    assert.equal(first.proposals, 1);
    assert.equal(first.decisionsRecorded, 1);
    assert.equal(first.readyCreated, 1);
    const second = await scanConfiguredMandate({ client, store, config });
    assert.equal(second.readyCreated, 0);

    const intents = await pool.query<{ state: string; serialized_request: string }>(
      'SELECT state, serialized_request FROM exit_intents',
    );
    assert.equal(intents.rowCount, 1);
    assert.equal(intents.rows[0]?.state, 'READY');
    assert.match(intents.rows[0]?.serialized_request ?? '', /"functionName":"execute"/);
    const decisions = await pool.query<{ decision: string }>(
      'SELECT decision FROM proposal_decisions',
    );
    assert.deepEqual(
      decisions.rows.map((row) => row.decision),
      ['eligible'],
    );
  },
);
