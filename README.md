# VETO

**VETO gives Morpho depositors enforceable exit rules for queued vault changes.**

> VETO — your right to leave before the rules change.

VETO lets a Morpho Vault V2 depositor define when their approved position is no longer allowed to remain in the vault. When a supported queued change violates the depositor's policy, VETO coordinates autonomous, conditional redemption through KeeperHub, while `VetoExitGuard` independently rechecks the owner's authorization and the live Morpho state onchain before any shares can move.

### Quick Judge Links

- **[Live Morpho Vault V2 Evidence](docs/LIVE-MORPHO-EVIDENCE.md)**: Proof of real Gauntlet USDC Prime compatibility, factory provenance, live read (`pnpm live:morpho`), and real $3.07M depositor exit on pinned Base fork.
- **[Canonical Evidence Index](evidence/EVIDENCE.md)**: Verified onchain receipts, public conditional block proofs, and TOCTOU defense on Base Sepolia.
- **[KeeperHub Integration](docs/KEEPERHUB-INTEGRATION.md)**: Idempotent `check-and-execute` conditional integration map and platform disagreement handling.
- **[Lifecycle Safety & Reconciliation](docs/LIFECYCLE-SAFETY.md)**: Proposal-specific attempt model, queue serialization, bounded recovery, and `DISPUTED` operator quarantine.

```text
Morpho → VETO scanner/policy → durable intent → KeeperHub reads executableAt
  → condition false: STOP / BLOCKED
  → condition true: KeeperHub executes VetoExitGuard → Morpho redeem → owner
  → VETO receipt/event/state reconciliation → EXITED or DISPUTED
```

The worker uses KeeperHub's documented, idempotent `check-and-execute` API rather than a visual workflow because that endpoint provides the stable-key lost-response recovery required for a financial operation. The proven direct contract-call route remains an explicit fallback.

“Veto” does not mean cancelling Morpho governance or preventing a curator from changing a vault. The depositor is vetoing **their own continued participation** by leaving.

## The problem

A managed vault can queue changes while depositor capital remains inside. An alert can tell the
depositor what was true when it fired, but it does not enforce what should happen to the position.
It may also be stale by the time an automated transaction lands.

For example, a proposal can be valid when detected and simulated, then be revoked before broadcast
or inclusion. A worker's earlier decision must not, by itself, authorize movement of funds.

Protocols have governance. VETO gives depositors control over whether their capital stays.

## What VETO does today

VETO V2 supports **five programmable Morpho Vault V2 policy families**:

1. **Management-fee ceiling** (`setManagementFee`): Maximum acceptable annual management fee rate (strictly `< 5.00%` protocol max).
2. **Performance-fee ceiling** (`setPerformanceFee`): Maximum acceptable performance fee percentage (up to `50.00%` protocol max).
3. **Relative-cap ceiling** (`increaseRelativeCap`): Market exposure ceiling for explicitly configured `bytes32` risk IDs (unconfigured risk IDs do not breach).
4. **Adapter allowlist** (`addAdapter`): Explicit set of authorized adapter addresses (unapproved adapter proposals breach immediately).
5. **Redemption-gate allowlist** (`setSendSharesGate`, `setReceiveAssetsGate`): Explicit set of authorized share-transfer and asset-distribution gates.

```text
queued vault change breaches depositor policy
    -> verify the exact proposal calldata against enabled policy rules
    -> persist one bounded exit intent in PostgreSQL
    -> KeeperHub reads the live proposal state and conditionally executes VetoExitGuardV2
    -> guard rechecks the multi-policy mandate and live proposal onchain
    -> redeem the approved shares directly to the owner (zero custody)
    -> reconcile receipt, Exited event, and consumed mandate
```

Morpho exposes these governance actions as deterministic queued calldata with scheduled execution times. That makes each policy exactly machine-verifiable. Crossing an authorized ceiling or proposing an unlisted adapter/gate means the depositor's predefined policy was violated; it does **not** imply the curator is malicious or that liquidation was imminent.

Historical V1 contracts and public Base Sepolia KeeperHub conditional proofs (`VetoExitGuard.sol`, Day 5/6/8 receipts) remain preserved as permanent public verification evidence. V2 (`VetoExitGuardV2.sol`) expands protection across all five governance surfaces with bitflag policy activation (`policyFlags`), atomic single-use mandate consumption, and TOCTOU defense.

## Why the guard exists

Observation and authorization are deliberately separate:

```text
proposal detected
    -> offchain verification passes
    -> KeeperHub simulation passes
    -> proposal is revoked
    -> transaction later lands
```

Without execution-time enforcement, stale automation could withdraw the user unnecessarily.
`VetoExitGuard.execute` instead rechecks, in the same transaction:

- the configured Vault V2 factory still recognizes the exact vault;
- the owner mandate is active, current, and unexpired;
- the calldata is exactly `setManagementFee(uint256)`;
- the proposed fee breaches the owner's ceiling but not the protocol maximum;
- the exact proposal is still pending with the expected executable time;
- the remaining waiting period exceeds the owner's safety window;
- only the mandate's fixed share amount can be redeemed;
- the redemption meets the owner's minimum return; and
- the receiver and on-behalf account are the mandate owner.

The mandate is consumed before the external redemption call, preventing a second economic effect.
If redemption reverts, the EVM rolls the consumption back atomically and the position remains with
the owner. This is **trust-minimized delegated execution**: the transaction enforces the policy
instead of trusting a stale alert or unconstrained relayer.

## Why KeeperHub

KeeperHub is VETO's managed financial execution layer, not merely a notification channel. VETO
persists a `check-and-execute` body containing the Morpho read, exact equality condition, and
`VetoExitGuard.execute` action with a stable financial-operation idempotency key. KeeperHub reads
the live proposal, blocks false conditions without broadcasting, or executes and exposes a durable
execution identity and status.

If a response is lost, the worker recovers with the same body and key rather than inventing a new
financial intent. After KeeperHub reports completion, VETO independently checks the chain receipt,
the exact `Exited` event, proposal hash, shares, minimum return, and consumed mandate. This shows a
useful pattern for KeeperHub-initiated financial actions: KeeperHub performs delegated execution
while an onchain guard keeps the action within independently enforceable user bounds.

## Architecture

```text
Morpho Vault V2 Submit / Revoke / Accept events
                         |
                         v
              VETO scanner + policy check
                         |
                PostgreSQL exit intent
             (unique key, lease, recovery)
                         |
                         v
       KeeperHub read + condition + managed execute
                         |
                         v
               VetoExitGuard.execute
                         |
       +-----------------+------------------+
       | transaction-time checks            |
       | vault · mandate · exact proposal    |
       | fee · pending state · time window   |
       | shares · min return · owner receiver|
       +-----------------+------------------+
                         |
                         v
                Morpho vault redemption
                         |
                 assets directly to owner
                         |
                         v
              receipt + state reconciliation
```

Glacient's management-fee monitor was verified in its product UI, but the available account could
not connect that alert to a webhook workflow. The canonical Morpho event scanner is therefore the
implemented signal source. A raw webhook receiver exists for transport experiments; VETO does not
claim a completed Glacient integration.

## Current evidence

The strongest proof now joins real Morpho contract behavior and public KeeperHub conditional execution in one
end-to-end Base Sepolia run.

### Primary proof: Day 8 KeeperHub conditional path

VETO deploys Morpho's unmodified Vault V2 `2025-09-15` factory source on Base Sepolia. The compiled
factory runtime hash exactly matches Morpho's canonical Base factory. The primary execution uses
KeeperHub's official `check-and-execute` conditional endpoint:

```text
Morpho proposal
  ↓
VETO scanner + owner policy
  ↓
durable PostgreSQL financial intent
  ↓
KeeperHub reads Morpho executableAt
  ↓
KeeperHub evaluates condition == true
  ↓
KeeperHub executes VetoExitGuard
  ↓
Morpho redeem to owner (zero custody)
  ↓
VETO receipt/event/state reconciliation → EXITED
```

| Field                     | Recorded result                                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Network                   | Base Sepolia (`84532`)                                                                                                        |
| Execution mode            | KeeperHub conditional (`POST /api/execute/check-and-execute`)                                                                 |
| Morpho Vault V2           | `0x9019B1e26795E90825c567aD08c945C603e7F9B9`                                                                                  |
| KeeperHub execution ID    | `35o448zta7uy9dun9j6py`                                                                                                       |
| Transaction               | [`0x24bafb…c3d6e`](https://base-sepolia.blockscout.com/tx/0x24bafbb926788884dee9160f4ad723a107b3159e4f5ea03b5b78cf07045c3d6e) |
| Receipt                   | Success, block `46889242`                                                                                                     |
| Owner return              | `10.000000` VETO Fixture USD units                                                                                            |
| Owner shares after        | `0`                                                                                                                           |
| Guard asset balance after | `0`                                                                                                                           |
| Mandate state             | Consumed (single-use enforced)                                                                                                |
| Worker state              | `EXITED`                                                                                                                      |
| Duplicate intent claimed  | No                                                                                                                            |
| Raw evidence              | [`evidence/day-8/conditional-success.json`](evidence/day-8/conditional-success.json)                                          |

_(Historical direct-call path proof from Day 5 remains recorded in [`evidence/day-5/real-morpho-v2.md`](evidence/day-5/real-morpho-v2.md) with execution ID `e6gg1z9q6eb37cd2v6v1w` and tx `0x6823882c…ce333`)._

### Conditional-false safety: Zero broadcast on proposal revocation

The companion Day 8 run proves that when a queued proposal is revoked before execution, no financial transaction is broadcast:

1. **Curator Revocation:** The curator revoked the pending fee proposal in transaction [`0x60e539dd…f15e5`](https://base-sepolia.blockscout.com/tx/0x60e539ddf306f6803ec9dd6b76c8745e7f77dc20661d2359a73df5f6967f15e5).
2. **KeeperHub Precheck Evaluation:** KeeperHub read `executableAt = 0`, evaluated `0 == 1789551002` (`false`), and returned `executed: false` with **no execution ID and no transaction hash**.
3. **Outcome:** **Zero financial transactions were broadcast.** Owner shares (`10.000000`), owner assets, and vault assets remained completely untouched. The mandate remains active for future proposals, and the worker settled to `BLOCKED / PROPOSAL_NOT_PENDING_AT_EXECUTION`. See [`evidence/day-8/conditional-false.json`](evidence/day-8/conditional-false.json).

Further evidence covers PostgreSQL restart recovery, duplicate delivery, worker leasing,
independent per-mandate scanner checkpoints, proposal/receipt reconciliation, the responsive web
application, and the unsuccessful Glacient entitlement check. Follow the chronological
[`Day 1`](docs/DAY-1-GATES.md), [`Day 2`](docs/DAY-2-GATES.md),
[`Day 3`](docs/DAY-3-GATES.md), and [`Day 4`](docs/DAY-4-GATES.md) records, then read the
[`Day 8 conditional execution`](evidence/day-8/keeperhub-conditional-execution.md) and
[`canonical evidence index`](evidence/EVIDENCE.md), followed by the
[`current functional layer`](docs/FUNCTIONAL-LAYER.md).

## What the web app does

The App Router interface is a controlled-testnet control panel, not only an evidence viewer. It can:

1. connect an EIP-1193 owner wallet;
2. read the configured supported vault position from Base Sepolia;
3. display runtime, database, and monitoring readiness;
4. review the implemented rule type and its exact limits;
5. request a finite vault-share approval;
6. arm an owner-bound mandate through `VetoExitGuard`;
7. verify the arming receipt before registering the rule in PostgreSQL;
8. cancel an active mandate with the owner wallet; and
9. inspect live rule state separately from recorded transaction evidence.

The Day 5 exit evidence records zero owner shares **at that run's end**. The Day 6 revoked-proposal
experiment later deposited a new 10-share position in the same vault, so that historical Day 5
balance is not a claim about today's live balance. Exercising the signing flow requires a browser
wallet that holds shares in the configured controlled Base Sepolia vault.

## Repository map

| Path                                                                                                           | Purpose                                                             |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [`contracts/src/VetoExitGuardV2.sol`](contracts/src/VetoExitGuardV2.sol)                                       | V2 multi-policy owner mandate and execution-time policy enforcement |
| [`contracts/src/VetoExitGuard.sol`](contracts/src/VetoExitGuard.sol)                                           | Historical V1 owner mandate guard (Day 5/6/8 public proofs)         |
| [`contracts/test/v2-gauntlet-fork-performance.test.mjs`](contracts/test/v2-gauntlet-fork-performance.test.mjs) | Pinned Gauntlet Base fork V2 performance fee proof                  |
| [`contracts/test/base-fork.test.mjs`](contracts/test/base-fork.test.mjs)                                       | Pinned real Morpho V1 redemption and adverse checks                 |
| [`packages/morpho-v2/src/scanner.ts`](packages/morpho-v2/src/scanner.ts)                                       | Canonical proposal lifecycle decoding across all 5 policy families  |
| [`packages/morpho-v2/src/adapter.ts`](packages/morpho-v2/src/adapter.ts)                                       | Proposal eligibility against live vault state                       |
| [`packages/keeperhub/src/client.ts`](packages/keeperhub/src/client.ts)                                         | Simulation, submission, retries, and status normalization           |
| [`apps/worker/src/scanner.ts`](apps/worker/src/scanner.ts)                                                     | Mandate-aware scanning and durable decisions                        |
| [`apps/worker/src/pipeline.ts`](apps/worker/src/pipeline.ts)                                                   | KeeperHub execution state machine and recovery                      |
| [`apps/worker/src/reconcile.ts`](apps/worker/src/reconcile.ts)                                                 | Independent receipt and mandate reconciliation                      |
| [`apps/worker/src/store.ts`](apps/worker/src/store.ts)                                                         | PostgreSQL uniqueness, leases, transitions, and checkpoints         |
| [`apps/web/src/app`](apps/web/src/app)                                                                         | Owner controls, runtime APIs, outcome, activity, and evidence UI    |
| [`evidence`](evidence)                                                                                         | Public receipts, screenshots, raw facts, and claim boundaries       |
| [`docs`](docs)                                                                                                 | Chronological gate reports and current functional-layer notes       |

## Run and test

Requirements are Node.js 22+, pnpm 10, and Git. Install and run the ordinary repository checks:

```bash
pnpm install
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

The contract and Morpho suites start local Anvil processes. Their pinned Base-fork tests use
`BASE_RPC_URL` when supplied and otherwise attempt the public Base RPC.

Database-backed worker tests require a disposable PostgreSQL database:

```bash
TEST_DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:5432/DATABASE \
  pnpm --filter @veto/worker test
```

To run the functional layer, copy `.env.example` to an ignored `.env`, configure PostgreSQL and the
controlled runtime, build the workspace, then run the worker and web app in separate terminals:

```bash
pnpm build
pnpm --filter @veto/worker start
pnpm --filter @veto/web dev
```

`pnpm --filter @veto/worker day3:live`, `pnpm --filter @veto/worker real-morpho:live`, and the
KeeperHub Gate C script make real external testnet requests. They require an organization API key,
funded or sponsored testnet execution, and explicit operator intent. Never commit credentials or
funded-wallet secrets.

## Limitations

- VETO V2 implements five Morpho Vault V2 policy families (management fee ceiling, performance fee ceiling, relative cap ceiling, adapter allowlist, and redemption gate allowlist).
- The contracts are unaudited, test-only, and not production-ready.
- The public end-to-end proof uses canonical Morpho Vault V2 code with a valueless test asset on
  Base Sepolia, not real USDC.
- Its factory is a VETO-controlled deployment of canonical Morpho code, not a Morpho Association
  testnet deployment.
- Compatibility and adverse behavior against a Morpho mainnet deployment remain pinned-fork
  evidence; no public mainnet asset movement is claimed.
- Glacient webhook delivery and payload authentication are not integrated.
- The web runtime supports configured factory, vault, and guard on Base Sepolia.
- VETO can enforce **when an exit is authorized**. It cannot guarantee that a vault has enough
  executable liquidity to complete it.
- P0 has no automatic partial exit. If the exact authorized redemption reverts, the position is
  preserved and the concrete error is recorded; VETO does not guess that every failure is
  `BLOCKED_LIQUIDITY`.
- Exitability prechecks, bounded partial exits, and explicitly authorized deallocation paths are
  potential later work, not current features.
- No audit, production operations, user adoption, enterprise demand, or KeeperHub endorsement is
  claimed.

## Vision

VETO's multi-policy engine demonstrates a foundational primitive: **user-defined conditions controlling whether capital remains in a managed protocol**. Across fee limits, market exposure allocations, and contract allowlists, depositors retain cryptographic authority to leave before adverse changes take effect.
