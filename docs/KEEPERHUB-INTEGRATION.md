# KeeperHub integration: judge map

## Current role and exact surfaces

VETO is depositor-controlled exit authorization for a queued Morpho Vault V2 management-fee
increase. The VETO scanner and durable policy decide **which** owner-approved exit is eligible.
KeeperHub manages the financial attempt through `POST /api/execute/check-and-execute`: it reads the
exact Morpho proposal timestamp, applies an equality condition, and only then executes the persisted
guard action. VETO persists the serialized read + condition + action and stable idempotency key
before submission, stores the returned execution identity, recovers with the same body/key, and
polls `GET /api/execute/{executionId}/status`. Direct contract execution remains a fallback.

```text
Morpho Submit/Revoke → VETO rule → PostgreSQL intent
  → KeeperHub read executableAt → equality condition
       false → no financial tx → BLOCKED
       true  → managed VetoExitGuard.execute → Morpho redeem → owner
  → receipt/event/state reconciliation → EXITED or DISPUTED
```

KeeperHub is not claimed to be technically irreplaceable. The implemented dependency is its
protocol-state read, conditional pre-broadcast gating, managed signing/execution, execution identity,
stable-key submission, status/recovery, and transaction evidence. The guard remains the final
authorization, independent of KeeperHub.

## Three proof cases

The [Day 8 report](../evidence/day-8/keeperhub-conditional-execution.md) contains the current proof:

- **true + true:** KeeperHub execution `35o448zta7uy9dun9j6py`, [public exit tx
  `0x24bafb…c3d6e`](https://base-sepolia.blockscout.com/tx/0x24bafbb926788884dee9160f4ad723a107b3159e4f5ea03b5b78cf07045c3d6e),
  funds to owner, mandate consumed, worker `EXITED`;
- **false before execution:** KeeperHub observed `0` instead of `1789551002`, returned false with
  no conditional execution ID or financial transaction, balances unchanged, mandate active, worker
  `BLOCKED`; and
- **T1 true, T2 false:** the deterministic pinned Base-fork test changes Morpho state after the
  valid precheck and proves the guard rejects with zero movement and an active mandate. This is
  explicitly fork evidence, not a public-race claim.

## Public successful and revoked paths

The successful [Day 5 real-Morpho run](../evidence/day-5/real-morpho-v2.md) used an unmodified
Morpho Vault V2 build deployed through a **VETO-controlled canonical-code factory** on Base
Sepolia, with a valueless fixture asset. KeeperHub execution `e6gg1z9q6eb37cd2v6v1w` produced
[public tx `0x6823882c…ce333`](https://base-sepolia.blockscout.com/tx/0x6823882c7605922935c902c53efad5ff7c4827e3461d05fe8313116b962ce333).
The guard redeemed 10 owner shares, 10 fixture-USD units arrived at the owner, the guard retained
no asset, the mandate was consumed, and the worker recorded `EXITED`. This is not a Morpho
Association deployment or a real-USDC/mainnet claim.

The [Day 6 revoked case](../evidence/day-6/revoked-proposal.md) queued and detected a 2% fee,
then revoked its exact calldata after VETO had simulated the exit. KeeperHub direct execution
`bdcnl33bxkwcsowy2g2ze` **failed preflight without a public withdrawal tx**. Separately, a
zero-custody recorder submitted the same prepared calldata through KeeperHub execution
`bqjr8pzwyx4sd6jcawhfd` in [public tx `0x5456da6a…226f0`](https://base-sepolia.blockscout.com/tx/0x5456da6a430874eece4ad7ec6dc8752bd8c6b56ba274c5842425be73a4d226f0).
Its **successful outer receipt** captured the **inner guard rejection**
`ProposalIsNotExecutable()`; it was not a failed withdrawal transaction. Owner shares and assets
did not move, the mandate stayed active, and the worker recorded
`BLOCKED / PROPOSAL_REVOKED_BEFORE_EXECUTION`.

## Two checks, two times

KeeperHub's implemented conditional read avoids sending an obviously stale call at time `T1`.
Morpho state may change before transaction inclusion at `T2`. Only
`VetoExitGuard.execute` enforces the owner's mandate, exact proposal, fee ceiling, timing window,
shares, minimum return, expiry, one-time use, and owner receiver **atomically at T2**. KeeperHub
and the guard are defense in depth, not redundant checks.

## Why check-and-execute, not a visual workflow

KeeperHub's official [workflow API](https://docs.keeperhub.com/api/workflows) documents
programmatic create/execute, and its [Web3 plugin](https://docs.keeperhub.com/plugins/web3) and
[workflow builder](https://docs.keeperhub.com/workflows/creating) document read-contract,
Condition true/false routing, and write-contract nodes. On 2026-09-15, authenticated live
`GET /api/mcp/schemas` listed all three actions as enabled, `GET /api/features` reported this
organization on Pro, and `GET /api/workflows` accepted its API key. So the relevant primitives
**are available**; absence of a public API or entitlement is **not** the blocker.

The workflow primitives exist, but the manual workflow execute documentation still does not clearly
specify equivalent stable-key recovery for a lost response. KeeperHub's direct
`check-and-execute` endpoint explicitly documents idempotency and provides the required read,
condition, action, execution ID, and status semantics. It is therefore the deeper **reliable**
integration used by VETO. It supports one scalar read, so KeeperHub checks exact proposal liveness;
the guard still enforces the fee ceiling, timing headroom, mandate, amount, minimum return, receiver,
and one-time use. No visual workflow execution is claimed.

## Recovery and economic truth

Mode and exact requests are persisted per intent, so configuration changes cannot switch an
in-flight operation between endpoints. Unique operation/idempotency keys, row leasing, and
`FOR UPDATE SKIP LOCKED` prevent duplicate workers/events from creating a second intent. An unknown
submission re-enters `RECONCILING` with the identical body/key; pending and confirming operations
resume from KeeperHub status or the chain receipt. KeeperHub success never directly means `EXITED`:
receipt, guard event, proposal hash, mandate owner, shares, minimum assets, and consumption must
agree, otherwise VETO records `DISPUTED`.

## Inspect the code and evidence

| Question                                                | File                                                                                                                                                                               |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KeeperHub conditional/direct client and stable replay   | [`packages/keeperhub/src/client.ts`](../packages/keeperhub/src/client.ts)                                                                                                          |
| Stable body/key, durable submission and status recovery | [`apps/worker/src/pipeline.ts`](../apps/worker/src/pipeline.ts), [`apps/worker/src/store.ts`](../apps/worker/src/store.ts)                                                         |
| Morpho lifecycle decoding and live eligibility          | [`packages/morpho-v2/src/scanner.ts`](../packages/morpho-v2/src/scanner.ts), [`packages/morpho-v2/src/adapter.ts`](../packages/morpho-v2/src/adapter.ts)                           |
| Mandate-aware worker scan                               | [`apps/worker/src/scanner.ts`](../apps/worker/src/scanner.ts)                                                                                                                      |
| Atomic mandate/proposal policy                          | [`contracts/src/VetoExitGuard.sol`](../contracts/src/VetoExitGuard.sol)                                                                                                            |
| Receipt/event/share/mandate reconciliation              | [`apps/worker/src/reconcile.ts`](../apps/worker/src/reconcile.ts)                                                                                                                  |
| Judge-facing evidence UI                                | [`apps/web/src/app/_components/operator-console.tsx`](../apps/web/src/app/_components/operator-console.tsx), [`apps/web/src/data/day-three.ts`](../apps/web/src/data/day-three.ts) |
| Raw public facts                                        | [`Day 8 conditional proof`](../evidence/day-8/), [`Day 5`](../evidence/day-5/), [`Day 6`](../evidence/day-6/)                                                                      |

KeeperHub's [direct execution documentation](https://docs.keeperhub.com/api/direct-execution)
specifies preflight, stable-key replay, execution statuses, and the separate check-and-execute
surface. Current limitations: one scalar KeeperHub precondition, one implemented Morpho policy,
test-only unaudited contracts, and no claim of visual workflow usage or production readiness.
