# KeeperHub integration: judge map

## Current role and exact surfaces

VETO is depositor-controlled exit authorization for a queued Morpho Vault V2 management-fee
increase. The VETO scanner and durable policy decide **which** owner-approved exit is eligible.
KeeperHub manages the financial attempt: direct `POST /api/execute/contract-call` simulation,
idempotent submission of the exact serialized guard call, a KeeperHub execution ID, and
`GET /api/execute/{executionId}/status` recovery. The worker then independently reconciles public
receipt and contract state. This is more than alert delivery, but the current submitted path is
**direct execution, not a KeeperHub workflow**.

```text
Morpho Submit/Revoke state → VETO proposal + mandate check → PostgreSQL intent
  → KeeperHub simulate/preflight → KeeperHub direct guard submission/status
  → VetoExitGuard.execute → Morpho redeem(shares, owner, owner)
  → owner assets + worker receipt/event/mandate reconciliation
```

KeeperHub is not claimed to be technically irreplaceable. The implemented dependency is its
managed simulation/preflight, execution identity, stable-key financial submission, status/recovery,
and transaction evidence. The guard remains the final authorization, independent of KeeperHub.

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

KeeperHub preflight or a future workflow read can avoid sending an obviously stale call at time
`T1`. Morpho state may change before transaction inclusion at `T2`. Only
`VetoExitGuard.execute` enforces the owner's mandate, exact proposal, fee ceiling, timing window,
shares, minimum return, expiry, one-time use, and owner receiver **atomically at T2**. KeeperHub
and the guard are defense in depth, not redundant checks.

## Workflow investigation and current limitation

KeeperHub's official [workflow API](https://docs.keeperhub.com/api/workflows) documents
programmatic create/execute, and its [Web3 plugin](https://docs.keeperhub.com/plugins/web3) and
[workflow builder](https://docs.keeperhub.com/workflows/creating) document read-contract,
Condition true/false routing, and write-contract nodes. On 2026-09-15, authenticated live
`GET /api/mcp/schemas` listed all three actions as enabled, `GET /api/features` reported this
organization on Pro, and `GET /api/workflows` accepted its API key. So the relevant primitives
**are available**; absence of a public API or entitlement is **not** the blocker.

We also made a separate, non-broadcast [conditional dry-run probe](../evidence/day-7/keeperhub-conditional-probe.json)
using KeeperHub's documented `POST /api/execute/check-and-execute` endpoint against the revoked
Morpho `executableAt(bytes)` proposal. KeeperHub observed `0`, compared it to the original
`1789432530`, returned `executed: false`, and did not send the action. This endpoint is a direct
single-scalar check, **not a workflow run and not used by the worker's financial path**. It does
not evaluate all VETO predicates or prove the true branch.

No read → Condition → write workflow was created or substituted into the worker in this change.
Before routing funds through one, VETO must verify the exact persisted workflow definition,
true/false run outputs, transaction/status mapping, and **lost-response/idempotent replay semantics**
for `POST /api/workflows/{id}/execute`. The documented direct endpoint has explicit stable-key
replay behavior; the workflow execute docs return a KeeperHub-assigned run ID but do not clearly
specify equivalent keyed recovery for this route. Replacing the tested direct state machine before
those semantics and the four required adverse tests are verified would weaken operational safety.
The next bounded integration is a real workflow check of the exact pending proposal, fee and
headroom, followed on true only by the same guard call; the guard must still reject a T1-true,
T2-revoked proposal. Do not claim this future workflow is implemented.

## Inspect the code and evidence

| Question                                                | File                                                                                                                                                                               |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KeeperHub direct client, retry, response normalization  | [`packages/keeperhub/src/client.ts`](../packages/keeperhub/src/client.ts)                                                                                                          |
| Stable body/key, durable submission and status recovery | [`apps/worker/src/pipeline.ts`](../apps/worker/src/pipeline.ts), [`apps/worker/src/store.ts`](../apps/worker/src/store.ts)                                                         |
| Morpho lifecycle decoding and live eligibility          | [`packages/morpho-v2/src/scanner.ts`](../packages/morpho-v2/src/scanner.ts), [`packages/morpho-v2/src/adapter.ts`](../packages/morpho-v2/src/adapter.ts)                           |
| Mandate-aware worker scan                               | [`apps/worker/src/scanner.ts`](../apps/worker/src/scanner.ts)                                                                                                                      |
| Atomic mandate/proposal policy                          | [`contracts/src/VetoExitGuard.sol`](../contracts/src/VetoExitGuard.sol)                                                                                                            |
| Receipt/event/share/mandate reconciliation              | [`apps/worker/src/reconcile.ts`](../apps/worker/src/reconcile.ts)                                                                                                                  |
| Judge-facing evidence UI                                | [`apps/web/src/app/_components/operator-console.tsx`](../apps/web/src/app/_components/operator-console.tsx), [`apps/web/src/data/day-three.ts`](../apps/web/src/data/day-three.ts) |
| Raw public facts                                        | [`Day 5`](../evidence/day-5/), [`Day 6`](../evidence/day-6/), [`Day 7 probe`](../evidence/day-7/keeperhub-conditional-probe.json)                                                  |

KeeperHub's [direct execution documentation](https://docs.keeperhub.com/api/direct-execution)
specifies preflight, stable-key replay, execution statuses, and the separate check-and-execute
surface. The repo's worker tests exercise the direct path; no workflow success is represented by
those tests.
