import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { type TestContext } from 'node:test';

import { financialOperationKey } from '@veto/core';
import { keeperHubIdempotencyKey } from '@veto/keeperhub';
import { Pool } from 'pg';
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  keccak256,
  parseAbiParameters,
  type PublicClient,
} from 'viem';

import { ExitPipeline } from '../src/pipeline.js';
import { createChainReconciler } from '../src/reconcile.js';
import { PostgresIntentStore, type StoredExitIntent } from '../src/store.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresTest = databaseUrl ? test : test.skip;

const chainId = 84_532;
const guardAddress = '0x1111111111111111111111111111111111111111' as const;
const ownerAddress = '0x2222222222222222222222222222222222222222' as const;
const executorAddress = '0x3333333333333333333333333333333333333333' as const;
const mandateId = 7n;
const proposalData =
  '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890123456' as const;
const proposalHash = keccak256(proposalData);
const shares = 1_000_000n;
const minAssets = 900_000n;
const actualAssets = 950_000n;
const defaultTxHash = `0x${'a'.repeat(64)}` as const;

const exitedEventAbi = [
  {
    type: 'event',
    name: 'Exited',
    inputs: [
      { name: 'mandateId', type: 'uint256', indexed: true },
      { name: 'owner', type: 'address', indexed: true },
      { name: 'executor', type: 'address', indexed: true },
      { name: 'shares', type: 'uint256', indexed: false },
      { name: 'assets', type: 'uint256', indexed: false },
      { name: 'proposalHash', type: 'bytes32', indexed: false },
    ],
  },
] as const;

function makeExitedLog(overrides?: {
  mandateId?: bigint;
  owner?: `0x${string}`;
  executor?: `0x${string}`;
  shares?: bigint;
  assets?: bigint;
  proposalHash?: `0x${string}`;
  transactionHash?: `0x${string}`;
  blockNumber?: bigint;
}) {
  const mid = overrides?.mandateId ?? mandateId;
  const own = overrides?.owner ?? ownerAddress;
  const exec = overrides?.executor ?? executorAddress;
  const sh = overrides?.shares ?? shares;
  const as = overrides?.assets ?? actualAssets;
  const ph = overrides?.proposalHash ?? proposalHash;
  const txHash = overrides?.transactionHash ?? defaultTxHash;
  const bn = overrides?.blockNumber ?? 50_000n;

  const topics = encodeEventTopics({
    abi: exitedEventAbi,
    eventName: 'Exited',
    args: { mandateId: mid, owner: own, executor: exec },
  });
  const data = encodeAbiParameters(parseAbiParameters('uint256, uint256, bytes32'), [sh, as, ph]);

  return {
    address: guardAddress,
    topics,
    data,
    blockNumber: bn,
    transactionHash: txHash,
    args: { mandateId: mid, owner: own, executor: exec, shares: sh, assets: as, proposalHash: ph },
  };
}

function makeTestIntent(): StoredExitIntent {
  const proposalId = 'prop-direct-100-1';
  const proposalIdentity = `${chainId}:0x9999999999999999999999999999999999999999:${proposalData}:49000:1`;
  const operationKey = financialOperationKey({
    chainId,
    guard: guardAddress,
    mandateId,
    proposalIdentity,
  });
  const request = {
    contractAddress: guardAddress,
    chainId,
    functionName: 'execute',
    functionArgs: '[]',
    abi: '[]',
  };
  return {
    operationKey,
    chainId,
    guard: guardAddress,
    mandateId: mandateId.toString(),
    proposalIdentity,
    proposalData,
    expectedExecutableAt: '2000000000',
    state: 'CONFIRMING',
    request,
    serializedRequest: '{}',
    idempotencyKey: keeperHubIdempotencyKey(operationKey),
    executionMode: 'conditional',
    conditionalRequest: {
      contractAddress: '0x9999999999999999999999999999999999999999',
      chainId,
      functionName: 'executableAt',
      functionArgs: '[]',
      abi: '[]',
      condition: { operator: 'eq', value: '2000000000' },
      action: request,
    },
    serializedConditionalRequest: '{}',
    version: 1,
  };
}

async function setupStore(context: TestContext) {
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
    'TRUNCATE exit_intent_events, exit_intents, proposal_decisions, scanner_checkpoints RESTART IDENTITY',
  );
  return { pool, store };
}

// -----------------------------------------------------------------------------------------
// DIRECT RECONCILER TEST 1: successful receipt + exact Exited event -> ok / exit confirmed
// -----------------------------------------------------------------------------------------
test('Direct Reconciler 1: successful receipt + exact Exited event => ok and exact exit confirmed', async () => {
  const intent = makeTestIntent();
  const exitLog = makeExitedLog();

  const mockClient = {
    async getTransactionReceipt({ hash }: { hash: `0x${string}` }) {
      assert.equal(hash, defaultTxHash);
      return {
        status: 'success' as const,
        blockNumber: 50_000n,
        logs: [exitLog],
      };
    },
    async readContract({ functionName }: { functionName: string }) {
      assert.equal(functionName, 'mandates');
      return [
        ownerAddress,
        '0x4444444444444444444444444444444444444444',
        shares,
        100n,
        minAssets,
        2_000_000_000n,
        300n,
        false, // active = false (consumed!)
      ];
    },
  } as unknown as PublicClient;

  const reconciler = createChainReconciler(mockClient);
  const result = await reconciler(intent, defaultTxHash);

  assert.equal(result.ok, true);
  assert.equal(result.detail.receiptStatus, 'success');
  assert.equal(result.detail.consumed, true);
  assert.equal(result.detail.proposalMatches, true);
  assert.equal(result.detail.ownerMatches, true);
  assert.equal(result.detail.shareAmountMatches, true);
  assert.equal(result.detail.minimumSatisfied, true);
  assert.equal(result.detail.shares, shares.toString());
  assert.equal(result.detail.assets, actualAssets.toString());
});

// -----------------------------------------------------------------------------------------
// DIRECT RECONCILER TEST 2: successful receipt + wrong or missing Exited event -> mismatch
// -----------------------------------------------------------------------------------------
test('Direct Reconciler 2: successful receipt + missing or mismatched Exited event => mismatch / DISPUTED', async () => {
  const intent = makeTestIntent();

  // Case 2a: No Exited event in logs
  const clientNoEvent = {
    async getTransactionReceipt() {
      return { status: 'success' as const, blockNumber: 50_000n, logs: [] };
    },
  } as unknown as PublicClient;

  const reconcilerNoEvent = createChainReconciler(clientNoEvent);
  const resultNoEvent = await reconcilerNoEvent(intent, defaultTxHash);
  assert.equal(resultNoEvent.ok, false);
  assert.equal(resultNoEvent.detail.expectedExitEvent, false);

  // Case 2b: Exited event has mismatched proposalHash
  const wrongHashLog = makeExitedLog({
    proposalHash: `0x${'f'.repeat(64)}` as const,
  });
  const clientWrongData = {
    async getTransactionReceipt() {
      return { status: 'success' as const, blockNumber: 50_000n, logs: [wrongHashLog] };
    },
    async readContract() {
      return [
        ownerAddress,
        '0x4444444444444444444444444444444444444444',
        shares,
        100n,
        minAssets,
        2_000_000_000n,
        300n,
        false,
      ];
    },
  } as unknown as PublicClient;

  const reconcilerWrongData = createChainReconciler(clientWrongData);
  const resultWrongData = await reconcilerWrongData(intent, defaultTxHash);
  assert.equal(resultWrongData.ok, false);
  assert.equal(resultWrongData.detail.proposalMatches, false);
});

// -----------------------------------------------------------------------------------------
// DIRECT RECONCILER TEST 3: reverted receipt => explicit reverted result / zero economic effect
// -----------------------------------------------------------------------------------------
test('Direct Reconciler 3: reverted receipt => explicit reverted result and zero economic effect', async () => {
  const intent = makeTestIntent();
  const clientReverted = {
    async getTransactionReceipt() {
      return { status: 'reverted' as const, blockNumber: 50_000n, logs: [] };
    },
  } as unknown as PublicClient;

  const reconciler = createChainReconciler(clientReverted);
  const result = await reconciler(intent, defaultTxHash);

  assert.equal(result.ok, false);
  assert.equal(result.reverted, true);
  assert.equal(result.detail.receiptStatus, 'reverted');
  assert.equal(result.detail.economicEffect, 'none');
});

// -----------------------------------------------------------------------------------------
// DIRECT RECONCILER TEST 4: transaction receipt temporarily unavailable => pending, not failure
// -----------------------------------------------------------------------------------------
test('Direct Reconciler 4: receipt temporarily unavailable => pending, not failure', async () => {
  const intent = makeTestIntent();
  const clientUnavailable = {
    async getTransactionReceipt() {
      throw new Error('Transaction receipt not found');
    },
  } as unknown as PublicClient;

  const reconciler = createChainReconciler(clientUnavailable);
  const result = await reconciler(intent, defaultTxHash);

  assert.equal(result.ok, false);
  assert.equal(result.pending, true);
  assert.equal(result.detail.reason, 'RECEIPT_UNAVAILABLE');
});

// -----------------------------------------------------------------------------------------
// DIRECT RECONCILER TEST 5: no tx hash + matching attributable Exited event => recover tx hash
// -----------------------------------------------------------------------------------------
test('Direct Reconciler 5: no tx hash + matching attributable Exited event => recovers tx hash and confirms exit', async () => {
  const intent = makeTestIntent();
  const recoveredTx = `0x${'e'.repeat(64)}` as const;
  const exitLog = makeExitedLog({ transactionHash: recoveredTx });

  const clientLogRecovery = {
    async getBlockNumber() {
      return 50_100n;
    },
    async getLogs({ address }: { address: `0x${string}` }) {
      assert.equal(getAddress(address), getAddress(guardAddress));
      return [exitLog];
    },
    async getTransactionReceipt({ hash }: { hash: `0x${string}` }) {
      assert.equal(hash, recoveredTx);
      return { status: 'success' as const, blockNumber: 50_000n, logs: [exitLog] };
    },
    async readContract() {
      return [
        ownerAddress,
        '0x4444444444444444444444444444444444444444',
        shares,
        100n,
        minAssets,
        2_000_000_000n,
        300n,
        false,
      ];
    },
  } as unknown as PublicClient;

  const reconciler = createChainReconciler(clientLogRecovery);
  const result = await reconciler(intent); // called without transactionHash

  assert.equal(result.ok, true);
  assert.equal(result.detail.transactionHash, recoveredTx);
  assert.equal(result.detail.consumed, true);
  assert.equal(result.detail.proposalMatches, true);
});

// -----------------------------------------------------------------------------------------
// DIRECT RECONCILER TEST 6: no tx hash + no event on FIRST reconciliation attempt
// => starts bounded grace window in RECONCILING, NOT BLOCKED
// -----------------------------------------------------------------------------------------
postgresTest(
  'Direct Reconciler 6: no tx hash + no event on FIRST attempt => enters RECONCILING with grace deadline, NOT BLOCKED',
  async (context) => {
    const { store } = await setupStore(context);
    const intent = makeTestIntent();
    await store.createReady(intent);
    await store.claimNext('w1');
    await store.transition(intent.operationKey, 'w1', 'SIMULATED');
    await store.transition(intent.operationKey, 'w1', 'SUBMITTING');
    await store.transition(intent.operationKey, 'w1', 'PENDING', {
      executionId: 'exec-case-e-1',
    });
    await store.release(intent.operationKey, 'w1');

    // Real createChainReconciler with mock client returning no logs
    const mockClient = {
      async getBlockNumber() {
        return 50_000n;
      },
      async getLogs() {
        return []; // No attributable log visible onchain
      },
    } as unknown as PublicClient;

    const mockKeeperHub = {
      simulateContractCall: async () => ({}),
      submitContractCall: async () => ({
        executionId: 'exec-case-e-1',
        state: 'pending' as const,
        raw: {},
      }),
      checkAndExecute: async () => ({
        executed: true as const,
        executionId: 'exec-case-e-1',
        state: 'pending' as const,
        conditionResult: { met: true },
        raw: {},
      }),
      getExecution: async () => ({
        executionId: 'exec-case-e-1',
        state: 'failed' as const,
        transactionHash: undefined,
        raw: { status: 'failed' },
      }),
    };

    const reconciler = createChainReconciler(mockClient);
    const pipeline = new ExitPipeline(store, mockKeeperHub, reconciler, {
      reconciliationGraceMs: 60_000,
    });

    const result = await pipeline.runOnce('w2');

    // MUST be in RECONCILING with durable grace window, NOT BLOCKED
    assert.equal(result?.state, 'RECONCILING');
    assert.equal(result?.reconciliation?.uncertainBroadcast, true);
    assert.equal(result?.reconciliation?.keeperHubState, 'failed');
    assert(result?.reconciliation?.graceDeadline);
    assert(new Date(result.reconciliation.graceDeadline as string).getTime() > Date.now());
  },
);

// -----------------------------------------------------------------------------------------
// DIRECT RECONCILER TEST 7: no tx hash + no event AFTER durable grace window expires
// => DISPUTED / BROADCAST_OUTCOME_UNPROVEN (not BLOCKED / economicEffect: none)
// -----------------------------------------------------------------------------------------
postgresTest(
  'Direct Reconciler 7: no tx hash + no event AFTER grace window expires => DISPUTED / BROADCAST_OUTCOME_UNPROVEN',
  async (context) => {
    const { store } = await setupStore(context);
    const intent = makeTestIntent();
    await store.createReady(intent);
    await store.claimNext('w1');
    await store.transition(intent.operationKey, 'w1', 'SIMULATED');
    await store.transition(intent.operationKey, 'w1', 'SUBMITTING');
    await store.transition(intent.operationKey, 'w1', 'PENDING', {
      executionId: 'exec-case-e-2',
    });
    // Set already-expired grace deadline in durable PostgreSQL state
    const pastDeadline = new Date(Date.now() - 5_000).toISOString();
    await store.transition(intent.operationKey, 'w1', 'RECONCILING', {
      reconciliation: {
        keeperHubState: 'failed',
        uncertainBroadcast: true,
        graceStartedAt: new Date(Date.now() - 65_000).toISOString(),
        graceDeadline: pastDeadline,
        reconciliationAttempts: 3,
      },
    });
    await store.release(intent.operationKey, 'w1');

    const mockClient = {
      async getBlockNumber() {
        return 50_000n;
      },
      async getLogs() {
        return [];
      },
    } as unknown as PublicClient;

    const mockKeeperHub = {
      simulateContractCall: async () => ({}),
      submitContractCall: async () => ({
        executionId: 'exec-case-e-2',
        state: 'pending' as const,
        raw: {},
      }),
      checkAndExecute: async () => ({
        executed: true as const,
        executionId: 'exec-case-e-2',
        state: 'pending' as const,
        conditionResult: { met: true },
        raw: {},
      }),
      getExecution: async () => ({
        executionId: 'exec-case-e-2',
        state: 'failed' as const,
        transactionHash: undefined,
        raw: { status: 'failed' },
      }),
    };

    const reconciler = createChainReconciler(mockClient);
    const pipeline = new ExitPipeline(store, mockKeeperHub, reconciler);

    const result = await pipeline.runOnce('w2');

    // Grace window elapsed + successful scan returned [] => DISPUTED, never economicEffect: none
    assert.equal(result?.state, 'DISPUTED');
    assert.equal(result?.lastError, 'BROADCAST_OUTCOME_UNPROVEN');
    assert.equal(result?.reconciliation?.economicEffect, 'unknown');
    assert.equal(result?.reconciliation?.transactionHash, null);
    assert.equal(result?.reconciliation?.attributableEventFound, false);
    assert.equal(result?.reconciliation?.automaticRecoveryWindowExpired, true);
    assert(result?.reconciliation?.graceExpiredAt);
  },
);

// -----------------------------------------------------------------------------------------
// DIRECT RECONCILER TEST 7b: grace expired + getLogs throws
// => stays RECONCILING, never BLOCKED or DISPUTED
// -----------------------------------------------------------------------------------------
postgresTest(
  'Direct Reconciler 7b: grace expired + getLogs throws => stays RECONCILING, never BLOCKED or DISPUTED',
  async (context) => {
    const { store } = await setupStore(context);
    const intent = makeTestIntent();
    await store.createReady(intent);
    await store.claimNext('w1');
    await store.transition(intent.operationKey, 'w1', 'SIMULATED');
    await store.transition(intent.operationKey, 'w1', 'SUBMITTING');
    await store.transition(intent.operationKey, 'w1', 'PENDING', {
      executionId: 'exec-case-e-rpc-fail',
    });
    // Set already-expired grace deadline in durable PostgreSQL state
    const pastDeadline = new Date(Date.now() - 5_000).toISOString();
    await store.transition(intent.operationKey, 'w1', 'RECONCILING', {
      reconciliation: {
        keeperHubState: 'failed',
        uncertainBroadcast: true,
        graceStartedAt: new Date(Date.now() - 65_000).toISOString(),
        graceDeadline: pastDeadline,
        reconciliationAttempts: 3,
      },
    });
    await store.release(intent.operationKey, 'w1');

    // RPC client where getLogs throws an error
    const mockClient = {
      async getBlockNumber() {
        return 50_000n;
      },
      async getLogs() {
        throw new Error('RPC_NODE_DISCONNECTED');
      },
    } as unknown as PublicClient;

    const mockKeeperHub = {
      simulateContractCall: async () => ({}),
      submitContractCall: async () => ({
        executionId: 'exec-case-e-rpc-fail',
        state: 'pending' as const,
        raw: {},
      }),
      checkAndExecute: async () => ({
        executed: true as const,
        executionId: 'exec-case-e-rpc-fail',
        state: 'pending' as const,
        conditionResult: { met: true },
        raw: {},
      }),
      getExecution: async () => ({
        executionId: 'exec-case-e-rpc-fail',
        state: 'failed' as const,
        transactionHash: undefined,
        raw: { status: 'failed' },
      }),
    };

    const reconciler = createChainReconciler(mockClient);
    const pipeline = new ExitPipeline(store, mockKeeperHub, reconciler);

    const result = await pipeline.runOnce('w2');

    // A FAILED CHAIN QUERY IS NOT A SUCCESSFUL QUERY THAT FOUND ZERO EVENTS.
    // Must remain in RECONCILING and never settle to BLOCKED or DISPUTED.
    assert.equal(result?.state, 'RECONCILING');
    assert.equal(result?.reconciliation?.lastChainCheckFailed, true);
    assert.equal(result?.reconciliation?.lastChainCheckError, 'LOG_SEARCH_FAILED');
  },
);

// -----------------------------------------------------------------------------------------
// DIRECT RECONCILER TEST 8: RPC tip lag / later event appearance
// first pass finds nothing, later pass finds matching event => recover and EXITED
// -----------------------------------------------------------------------------------------
postgresTest(
  'Direct Reconciler 8: RPC tip lag / later event appearance => recovers tx and settles EXITED',
  async (context) => {
    const { store } = await setupStore(context);
    const intent = makeTestIntent();
    await store.createReady(intent);
    await store.claimNext('w1');
    await store.transition(intent.operationKey, 'w1', 'SIMULATED');
    await store.transition(intent.operationKey, 'w1', 'SUBMITTING');
    await store.transition(intent.operationKey, 'w1', 'PENDING', {
      executionId: 'exec-case-e-lag',
    });
    await store.release(intent.operationKey, 'w1');

    const recoveredTx = `0x${'9'.repeat(64)}` as const;
    const exitLog = makeExitedLog({ transactionHash: recoveredTx });

    let rpcLagged = true;
    const mockClient = {
      async getBlockNumber() {
        return 50_100n;
      },
      async getLogs() {
        if (rpcLagged) return []; // First pass: RPC node is lagged, no event visible
        return [exitLog]; // Later pass: Event appears onchain!
      },
      async getTransactionReceipt({ hash }: { hash: `0x${string}` }) {
        assert.equal(hash, recoveredTx);
        return { status: 'success' as const, blockNumber: 50_000n, logs: [exitLog] };
      },
      async readContract() {
        return [
          ownerAddress,
          '0x4444444444444444444444444444444444444444',
          shares,
          100n,
          minAssets,
          2_000_000_000n,
          300n,
          false,
        ];
      },
    } as unknown as PublicClient;

    const mockKeeperHub = {
      simulateContractCall: async () => ({}),
      submitContractCall: async () => ({
        executionId: 'exec-case-e-lag',
        state: 'pending' as const,
        raw: {},
      }),
      checkAndExecute: async () => ({
        executed: true as const,
        executionId: 'exec-case-e-lag',
        state: 'pending' as const,
        conditionResult: { met: true },
        raw: {},
      }),
      getExecution: async () => ({
        executionId: 'exec-case-e-lag',
        state: 'failed' as const,
        transactionHash: undefined,
        raw: { status: 'failed' },
      }),
    };

    const reconciler = createChainReconciler(mockClient);
    const pipeline = new ExitPipeline(store, mockKeeperHub, reconciler, {
      reconciliationGraceMs: 60_000,
    });

    // Pass 1: RPC node lagged => enters RECONCILING, does NOT mark BLOCKED
    const pass1 = await pipeline.runOnce('w2');
    assert.equal(pass1?.state, 'RECONCILING');

    // Pass 2: RPC catches up, Exited event appears!
    rpcLagged = false;
    const pass2 = await pipeline.runOnce('w3');
    assert.equal(pass2?.state, 'EXITED');
    assert.equal(pass2?.transactionHash, recoveredTx);
    assert.equal(pass2?.reconciliation?.platformDisagreement, true);
    assert.equal(pass2?.reconciliation?.keeperHubReported, 'failed');
    assert.equal(pass2?.reconciliation?.chainConfirmed, 'EXITED');
  },
);
