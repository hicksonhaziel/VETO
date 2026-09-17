# VETO Lifecycle Safety and Reconciliation Architecture

This document specifies the current-state lifecycle safety design and reconciliation guarantees implemented in VETO.

---

## 1. Multi-Proposal Support Under a Single Mandate

### The Problem
Previously, the database schema enforced a unique constraint on `(chain_id, guard_address, mandate_id)`. If an active mandate encountered Proposal A that resulted in a `BLOCKED` outcome (e.g., proposal revoked or conditional precheck failing), the mandate was left stranded: a subsequent Proposal B violating the depositor's policy could not be recorded or acted upon because the historical intent record for Proposal A occupied the unique key.

### The Solution
A mandate represents the depositor's persistent onchain exit authorization. It may encounter multiple distinct proposal events over its lifetime until an exit is executed or the mandate is revoked.

1. **Proposal-Specific Attempt Identity:**
   Every intent is uniquely identified by its financial operation key:
   `financialOperationKey({ chainId, guard, mandateId, proposalIdentity })`.
2. **Migration 0005 (`0005_proposal_attempts.sql`):**
   The table drops the single-mandate unique constraint and establishes:
   - A unique constraint on `(chain_id, guard_address, mandate_id, proposal_identity)`.
   - An index on `(chain_id, guard_address, mandate_id, created_at, operation_key)`.
3. **Immutable History:**
   Past attempts (`BLOCKED`, `CANCELLED`, `EXPIRED`) are never overwritten or deleted. Every evaluated proposal retains its own permanent audit record, execution ID, and evidence.

---

## 2. Serialization of Unresolved Economic Attempts

### The Invariant
While a mandate supports multiple historical attempts, **only one unresolved economic attempt may be active at any time**.

### Worker Queue Guarantee
In `PostgresIntentStore.claimNext`:
- The query uses PostgreSQL `FOR UPDATE SKIP LOCKED` to serialize concurrent worker claims.
- A candidate intent is claimed **only if no older unresolved attempt exists** for the same `(chain_id, guard_address, mandate_id)`:
  ```sql
  AND NOT EXISTS (
    SELECT 1 FROM exit_intents prior
    WHERE prior.chain_id = i.chain_id
      AND prior.guard_address = i.guard_address
      AND prior.mandate_id = i.mandate_id
      AND prior.operation_key <> i.operation_key
      AND (
        prior.state = 'EXITED'
        OR (
          prior.state NOT IN ('BLOCKED', 'CANCELLED', 'EXPIRED', 'NOT_APPLICABLE')
          AND (prior.created_at, prior.operation_key) < (i.created_at, i.operation_key)
        )
      )
  )
  ```
- If a prior attempt has reached `EXITED`, the mandate is consumed; no subsequent proposal can ever be claimed for execution.
- If a prior attempt is in an active/in-flight state (`READY`, `SIMULATED`, `SUBMITTING`, `PENDING`, `CONFIRMING`, `UNKNOWN`, `RECONCILING`, `DISPUTED`), subsequent attempts for that mandate wait until the prior attempt is conclusively resolved.

---

## 3. Platform Status Does Not Override Chain Reconciliation

### Core Principle
KeeperHub is a managed execution relayer. **The EVM state is the sole authority on financial movement.** A relayer's reporting may diverge from blockchain reality due to network partitions, timeouts, client errors, or edge cases.

The reconciliation engine categorizes execution outcomes into five explicit cases:

| Case | Scenario | Platform Report | Chain Evidence | Final State | Economic Effect |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Case A** | Relayer reports failure, but tx mined successfully | `failed` | Valid `Exited` receipt & logs | `EXITED` | Full exit confirmed; platform disagreement flagged |
| **Case B** | Relayer reports completed/failed with tx hash, receipt succeeded, but logs do not match expected exit | `completed` / `failed` | Succeeded receipt, missing `Exited` event | `DISPUTED` | Flagged for operator intervention; no exit assumed |
| **Case C** | Transaction mined with onchain revert | `failed` / `completed` | Receipt status `reverted` (`0x0`) | `BLOCKED` | Zero funds moved; mandate remains active; economic effect `none` |
| **Case D** | Transaction in flight, receipt not yet available | `pending` / `completed` | RPC returns receipt not found | `CONFIRMING` | Pipeline yields cleanly; retried on subsequent poll without failure |
| **Case E** | Relayer reports failure without transaction hash | `failed` (no hash) | Log scan: attributable event or no event | `EXITED` (if event recovered) or `BLOCKED` (if no onchain event) | Settles conclusively without infinite loops |

### Infinite Loop Elimination
Previously, if KeeperHub reported `failed` without a transaction hash, the worker transitioned between `UNKNOWN` and `PENDING` indefinitely.

Now:
1. The reconciler attempts an attributable log scan for `Exited(mandateId, ...)` matching `proposalHash`.
2. If an attributable log exists, the transaction hash is recovered and reconciled to `EXITED`.
3. If no attributable log exists (`noAttributableEvent: true`), the attempt conclusively settles to `BLOCKED` with `lastError: 'KEEPERHUB_EXECUTION_FAILED'` and `reconciliation: { economicEffect: 'none', transactionHash: null }`.
4. It never bounces back into `UNKNOWN` or `PENDING`.

---

## 4. Platform/Chain Disagreement Recorded as Evidence

When onchain reconciliation contradicts the platform status (Case A), VETO does not discard or hide the discrepancy.

Instead, the disagreement is explicitly persisted in both the intent's `reconciliation_json` and the immutable `exit_intent_events` audit trail:

```json
{
  "platformDisagreement": true,
  "keeperHubReported": "failed",
  "chainConfirmed": "EXITED",
  "transactionHash": "0x...",
  "receiptStatus": "success",
  "consumed": true
}
```

This ensures full transparency for post-execution verification and postmortems while honoring the onchain truth that the depositor's position was safely redeemed.
