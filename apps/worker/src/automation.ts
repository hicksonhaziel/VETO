import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { KeeperHubClient } from '@veto/keeperhub';
import { Pool } from 'pg';
import { createPublicClient, getAddress, http, type Address } from 'viem';
import { base, baseSepolia } from 'viem/chains';

import { ExitPipeline } from './pipeline.js';
import { createChainReconciler } from './reconcile.js';
import { scanConfiguredMandate, type MorphoScannerConfig } from './scanner.js';
import { PostgresIntentStore } from './store.js';

type AutomationConfig = MorphoScannerConfig & {
  databaseUrl: string;
  keeperHubApiKey: string;
  keeperHubBaseUrl: string;
  rpcUrl: string;
  pollIntervalMs: number;
};

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`MISSING_ENVIRONMENT_VARIABLE:${name}`);
  return value;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`INVALID_${name}`);
  return parsed;
}

export function automationConfigFromEnv(environment = process.env): AutomationConfig {
  const chainId = positiveInteger(required(environment, 'VETO_CHAIN_ID'), 'VETO_CHAIN_ID');
  if (chainId !== base.id && chainId !== baseSepolia.id) {
    throw new Error('UNSUPPORTED_VETO_CHAIN_ID');
  }
  return {
    databaseUrl: required(environment, 'DATABASE_URL'),
    keeperHubApiKey: required(environment, 'KEEPERHUB_API_KEY'),
    keeperHubBaseUrl: environment.KEEPERHUB_BASE_URL ?? 'https://app.keeperhub.com',
    rpcUrl: required(environment, 'VETO_RPC_URL'),
    chainId,
    factory: getAddress(required(environment, 'VETO_FACTORY_ADDRESS')),
    vault: getAddress(required(environment, 'VETO_VAULT_ADDRESS')),
    guard: getAddress(required(environment, 'VETO_GUARD_ADDRESS')),
    mandateId: BigInt(required(environment, 'VETO_MANDATE_ID')),
    startBlock: BigInt(required(environment, 'VETO_SCAN_START_BLOCK')),
    confirmationDepth: BigInt(environment.VETO_CONFIRMATION_DEPTH ?? '2'),
    reorgRewindBlocks: BigInt(environment.VETO_REORG_REWIND_BLOCKS ?? '12'),
    pollIntervalMs: positiveInteger(
      environment.VETO_POLL_INTERVAL_MS ?? '15000',
      'VETO_POLL_INTERVAL_MS',
    ),
  };
}

async function loadMigrations(): Promise<string[]> {
  return Promise.all(
    ['0001_exit_intents.sql', '0002_proposal_decisions.sql', '0003_managed_rules.sql'].map((name) =>
      readFile(new URL(`../../../db/migrations/${name}`, import.meta.url), 'utf8'),
    ),
  );
}

export async function startAutomation(config: AutomationConfig) {
  const chain = config.chainId === base.id ? base : baseSepolia;
  const client = createPublicClient({
    chain,
    transport: http(config.rpcUrl),
    cacheTime: 0,
  });
  const pool = new Pool({ connectionString: config.databaseUrl });
  const store = new PostgresIntentStore(pool);
  for (const migration of await loadMigrations()) await store.applyMigration(migration);
  const keeperHub = new KeeperHubClient({
    apiKey: config.keeperHubApiKey,
    baseUrl: config.keeperHubBaseUrl,
  });
  const pipeline = new ExitPipeline(store, keeperHub, createChainReconciler(client));
  const workerId = `worker-${randomUUID()}`;
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const registeredRules = await store.listActiveManagedRules(config.chainId);
      const scanTargets: MorphoScannerConfig[] = [
        config,
        ...registeredRules.map((rule) => ({
          ...rule,
          confirmationDepth: config.confirmationDepth,
          reorgRewindBlocks: config.reorgRewindBlocks,
        })),
      ].filter(
        (candidate, index, candidates) =>
          candidates.findIndex(
            (other) =>
              other.guard.toLowerCase() === candidate.guard.toLowerCase() &&
              other.mandateId === candidate.mandateId,
          ) === index,
      );
      const scans = await Promise.all(
        scanTargets.map((target) => scanConfiguredMandate({ client, store, config: target })),
      );
      console.info(
        JSON.stringify({
          event: 'morpho_scan_complete',
          targets: scans.length,
          proposals: scans.reduce((total, scan) => total + scan.proposals, 0),
          readyCreated: scans.reduce((total, scan) => total + scan.readyCreated, 0),
          decisionsRecorded: scans.reduce((total, scan) => total + scan.decisionsRecorded, 0),
          rewoundForReorg: scans.some((scan) => scan.rewoundForReorg),
        }),
      );
      for (let count = 0; count < 50; count += 1) {
        const result = await pipeline.runOnce(workerId);
        if (!result) break;
        console.info(
          JSON.stringify({
            event: 'exit_intent_processed',
            operationKey: result.operationKey,
            state: result.state,
            executionId: result.executionId,
            transactionHash: result.transactionHash,
          }),
        );
        if (['PENDING', 'UNKNOWN', 'DISPUTED'].includes(result.state)) break;
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'automation_tick_failed',
          message: error instanceof Error ? error.message : 'unknown_error',
        }),
      );
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), config.pollIntervalMs);
  timer.unref();
  await tick();
  return {
    workerId,
    tick,
    async close() {
      clearInterval(timer);
      await pool.end();
    },
  };
}

export type { AutomationConfig };
