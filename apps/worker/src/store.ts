import type { IntentState, ReadyExitIntent } from '@veto/core';
import { assertTransition } from '@veto/core';
import { serializeCheckAndExecute, serializeContractCall } from '@veto/keeperhub';
import type { Pool, PoolClient } from 'pg';

export type StoredExitIntent = ReadyExitIntent & {
  state: IntentState;
  serializedRequest: string;
  executionMode: 'direct' | 'conditional';
  serializedConditionalRequest?: string;
  executionId?: string;
  transactionHash?: `0x${string}`;
  lastError?: string;
  reconciliation?: Record<string, unknown>;
  claimedBy?: string;
  version: number;
};

export type ScannerCheckpoint = {
  nextBlock: bigint;
  lastBlockHash?: `0x${string}`;
};

export type ManagedRule = {
  chainId: number;
  factory: `0x${string}`;
  vault: `0x${string}`;
  guard: `0x${string}`;
  mandateId: bigint;
  startBlock: bigint;
};

type IntentRow = {
  operation_key: string;
  chain_id: number;
  guard_address: `0x${string}`;
  mandate_id: string;
  proposal_identity: string;
  proposal_data: `0x${string}`;
  expected_executable_at: string;
  state: IntentState;
  request_json: ReadyExitIntent['request'];
  serialized_request: string;
  execution_mode: 'direct' | 'conditional';
  conditional_request_json: ReadyExitIntent['conditionalRequest'] | null;
  serialized_conditional_request: string | null;
  idempotency_key: string;
  execution_id: string | null;
  transaction_hash: `0x${string}` | null;
  last_error: string | null;
  reconciliation_json: Record<string, unknown> | null;
  claimed_by: string | null;
  version: string;
};

function fromRow(row: IntentRow): StoredExitIntent {
  return {
    operationKey: row.operation_key,
    chainId: row.chain_id,
    guard: row.guard_address,
    mandateId: row.mandate_id,
    proposalIdentity: row.proposal_identity,
    proposalData: row.proposal_data,
    expectedExecutableAt: row.expected_executable_at,
    request: row.request_json,
    idempotencyKey: row.idempotency_key,
    state: row.state,
    serializedRequest: row.serialized_request,
    executionMode: row.execution_mode,
    conditionalRequest: row.conditional_request_json ?? undefined,
    serializedConditionalRequest: row.serialized_conditional_request ?? undefined,
    executionId: row.execution_id ?? undefined,
    transactionHash: row.transaction_hash ?? undefined,
    lastError: row.last_error ?? undefined,
    reconciliation: row.reconciliation_json ?? undefined,
    claimedBy: row.claimed_by ?? undefined,
    version: Number(row.version),
  };
}

export class PostgresIntentStore {
  constructor(private readonly pool: Pool) {}

  async applyMigration(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async createReady(intent: ReadyExitIntent): Promise<boolean> {
    const serializedRequest = serializeContractCall(intent.request);
    const executionMode = intent.executionMode ?? 'direct';
    const serializedConditionalRequest = intent.conditionalRequest
      ? serializeCheckAndExecute(intent.conditionalRequest)
      : null;
    const result = await this.pool.query(
      `INSERT INTO exit_intents (
        operation_key, chain_id, guard_address, mandate_id, proposal_identity,
        proposal_data, expected_executable_at, state, request_json,
        serialized_request, idempotency_key, execution_mode,
        conditional_request_json, serialized_conditional_request
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'READY', $8::jsonb, $9, $10, $11, $12::jsonb, $13)
      ON CONFLICT DO NOTHING`,
      [
        intent.operationKey,
        intent.chainId,
        intent.guard.toLowerCase(),
        intent.mandateId,
        intent.proposalIdentity,
        intent.proposalData.toLowerCase(),
        intent.expectedExecutableAt,
        JSON.stringify(intent.request),
        serializedRequest,
        intent.idempotencyKey,
        executionMode,
        intent.conditionalRequest ? JSON.stringify(intent.conditionalRequest) : null,
        serializedConditionalRequest,
      ],
    );
    if (result.rowCount === 1) {
      await this.pool.query(
        `INSERT INTO exit_intent_events (operation_key, from_state, to_state, detail_json)
         VALUES ($1, NULL, 'READY', '{"source":"verified_proposal"}'::jsonb)`,
        [intent.operationKey],
      );
      return true;
    }
    return false;
  }

  async get(operationKey: string): Promise<StoredExitIntent | undefined> {
    const result = await this.pool.query<IntentRow>(
      'SELECT * FROM exit_intents WHERE operation_key = $1',
      [operationKey],
    );
    return result.rows[0] ? fromRow(result.rows[0]) : undefined;
  }

  async claimNext(workerId: string, leaseSeconds = 60): Promise<StoredExitIntent | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query<IntentRow>(
        `SELECT i.* FROM exit_intents i
         WHERE i.state IN ('READY', 'SIMULATED', 'SUBMITTING', 'PENDING', 'CONFIRMING', 'UNKNOWN', 'RECONCILING')
           AND (i.claimed_at IS NULL OR i.claimed_at < now() - ($1 * interval '1 second'))
           AND NOT EXISTS (
             SELECT 1 FROM exit_intents prior
             WHERE prior.chain_id = i.chain_id AND prior.guard_address = i.guard_address
               AND prior.mandate_id = i.mandate_id AND prior.operation_key <> i.operation_key
               AND (prior.state = 'EXITED' OR (
                 prior.state NOT IN ('BLOCKED', 'CANCELLED', 'EXPIRED', 'NOT_APPLICABLE')
                 AND (prior.created_at, prior.operation_key) < (i.created_at, i.operation_key)
               ))
           )
         ORDER BY i.updated_at, i.created_at, i.operation_key
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
        [leaseSeconds],
      );
      const row = selected.rows[0];
      if (!row) {
        await client.query('COMMIT');
        return undefined;
      }
      const claimed = await client.query<IntentRow>(
        `UPDATE exit_intents
         SET claimed_by = $2, claimed_at = now(), updated_at = now(), version = version + 1
         WHERE operation_key = $1
         RETURNING *`,
        [row.operation_key, workerId],
      );
      await client.query('COMMIT');
      return fromRow(claimed.rows[0]!);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async transition(
    operationKey: string,
    workerId: string,
    toState: IntentState,
    patch: {
      executionId?: string;
      transactionHash?: `0x${string}`;
      lastError?: string | null;
      reconciliation?: Record<string, unknown>;
      detail?: Record<string, unknown>;
    } = {},
  ): Promise<StoredExitIntent> {
    return this.inTransaction(async (client) => {
      const selected = await client.query<IntentRow>(
        'SELECT * FROM exit_intents WHERE operation_key = $1 FOR UPDATE',
        [operationKey],
      );
      const row = selected.rows[0];
      if (!row) throw new Error('INTENT_NOT_FOUND');
      if (row.claimed_by !== workerId) throw new Error('INTENT_NOT_CLAIMED_BY_WORKER');
      assertTransition(row.state, toState);

      const updated = await client.query<IntentRow>(
        `UPDATE exit_intents SET
          state = $3,
          execution_id = COALESCE($4, execution_id),
          transaction_hash = COALESCE($5, transaction_hash),
          last_error = CASE WHEN $6::boolean THEN $7 ELSE last_error END,
          reconciliation_json = COALESCE($8::jsonb, reconciliation_json),
          updated_at = now(),
          version = version + 1
         WHERE operation_key = $1 AND claimed_by = $2
         RETURNING *`,
        [
          operationKey,
          workerId,
          toState,
          patch.executionId ?? null,
          patch.transactionHash?.toLowerCase() ?? null,
          patch.lastError !== undefined,
          patch.lastError ?? null,
          patch.reconciliation ? JSON.stringify(patch.reconciliation) : null,
        ],
      );
      await client.query(
        `INSERT INTO exit_intent_events (operation_key, from_state, to_state, detail_json)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [operationKey, row.state, toState, JSON.stringify(patch.detail ?? {})],
      );
      if (toState === 'EXITED') {
        await client.query(
          `UPDATE managed_rules SET state = 'EXITED', updated_at = now()
           WHERE chain_id = $1 AND guard_address = $2 AND mandate_id = $3`,
          [row.chain_id, row.guard_address, row.mandate_id],
        );
      }
      return fromRow(updated.rows[0]!);
    });
  }

  async release(operationKey: string, workerId: string): Promise<void> {
    await this.pool.query(
      `UPDATE exit_intents
       SET claimed_by = NULL, claimed_at = NULL, updated_at = now()
       WHERE operation_key = $1 AND claimed_by = $2`,
      [operationKey, workerId],
    );
  }

  async readCheckpoint(chainId: number, vault: string): Promise<bigint | undefined> {
    return (await this.getCheckpoint(chainId, vault))?.nextBlock;
  }

  async getCheckpoint(chainId: number, vault: string): Promise<ScannerCheckpoint | undefined> {
    const result = await this.pool.query<{ next_block: string }>(
      `SELECT next_block, last_block_hash FROM scanner_checkpoints
       WHERE chain_id = $1 AND vault_address = $2`,
      [chainId, vault.toLowerCase()],
    );
    const row = result.rows[0] as
      { next_block: string; last_block_hash: `0x${string}` | null } | undefined;
    return row
      ? {
          nextBlock: BigInt(row.next_block),
          lastBlockHash: row.last_block_hash ?? undefined,
        }
      : undefined;
  }

  async saveCheckpoint(options: {
    chainId: number;
    vault: string;
    nextBlock: bigint;
    lastBlockHash: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO scanner_checkpoints (
        chain_id, vault_address, next_block, last_block_hash
       ) VALUES ($1, $2, $3, $4)
       ON CONFLICT (chain_id, vault_address) DO UPDATE SET
         next_block = EXCLUDED.next_block,
         last_block_hash = EXCLUDED.last_block_hash,
         updated_at = now()
       WHERE scanner_checkpoints.next_block <= EXCLUDED.next_block`,
      [
        options.chainId,
        options.vault.toLowerCase(),
        options.nextBlock.toString(),
        options.lastBlockHash.toLowerCase(),
      ],
    );
  }

  async getManagedRuleCheckpoint(options: {
    chainId: number;
    guard: string;
    mandateId: bigint;
  }): Promise<ScannerCheckpoint | undefined> {
    const result = await this.pool.query<{
      next_block: string;
      last_block_hash: `0x${string}` | null;
    }>(
      `SELECT next_block, last_block_hash FROM managed_rule_checkpoints
       WHERE chain_id = $1 AND guard_address = $2 AND mandate_id = $3`,
      [options.chainId, options.guard.toLowerCase(), options.mandateId.toString()],
    );
    const row = result.rows[0];
    return row
      ? {
          nextBlock: BigInt(row.next_block),
          lastBlockHash: row.last_block_hash ?? undefined,
        }
      : undefined;
  }

  async saveManagedRuleCheckpoint(options: {
    chainId: number;
    guard: string;
    mandateId: bigint;
    nextBlock: bigint;
    lastBlockHash: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO managed_rule_checkpoints (
        chain_id, guard_address, mandate_id, next_block, last_block_hash
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (chain_id, guard_address, mandate_id) DO UPDATE SET
         next_block = EXCLUDED.next_block,
         last_block_hash = EXCLUDED.last_block_hash,
         updated_at = now()
       WHERE managed_rule_checkpoints.next_block <= EXCLUDED.next_block`,
      [
        options.chainId,
        options.guard.toLowerCase(),
        options.mandateId.toString(),
        options.nextBlock.toString(),
        options.lastBlockHash.toLowerCase(),
      ],
    );
  }

  async recordProposalDecision(options: {
    proposalIdentity: string;
    operationKey: string;
    chainId: number;
    vault: string;
    mandateId: bigint;
    decision: string;
    assessment: Record<string, unknown>;
    sourceBlock: bigint;
    sourceTransactionHash: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO proposal_decisions (
        proposal_identity, operation_key, chain_id, vault_address, mandate_id,
        decision, assessment_json, source_block, source_transaction_hash
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
       ON CONFLICT (proposal_identity, operation_key) DO UPDATE SET
         decision = EXCLUDED.decision,
         assessment_json = EXCLUDED.assessment_json,
         updated_at = now()`,
      [
        options.proposalIdentity,
        options.operationKey,
        options.chainId,
        options.vault.toLowerCase(),
        options.mandateId.toString(),
        options.decision,
        JSON.stringify(options.assessment),
        options.sourceBlock.toString(),
        options.sourceTransactionHash.toLowerCase(),
      ],
    );
  }

  async listActiveManagedRules(chainId: number): Promise<ManagedRule[]> {
    const result = await this.pool.query<{
      chain_id: number;
      factory_address: `0x${string}`;
      vault_address: `0x${string}`;
      guard_address: `0x${string}`;
      mandate_id: string;
      arm_block: string;
    }>(
      `SELECT chain_id, factory_address, vault_address, guard_address, mandate_id, arm_block
       FROM managed_rules
       WHERE chain_id = $1 AND state = 'ACTIVE' AND arm_block IS NOT NULL
       ORDER BY created_at`,
      [chainId],
    );
    return result.rows.map((row) => ({
      chainId: row.chain_id,
      factory: row.factory_address,
      vault: row.vault_address,
      guard: row.guard_address,
      mandateId: BigInt(row.mandate_id),
      startBlock: BigInt(row.arm_block),
    }));
  }

  private async inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
