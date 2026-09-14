# VETO

**Depositor-controlled exit rules for protocol changes.**

> VETO — your right to leave before the rules change.

VETO lets a Morpho Vault V2 depositor define when their approved position is no longer allowed to
remain in the vault. The worker observes a supported queued change and asks KeeperHub to submit the
bounded exit, while `VetoExitGuard` independently rechecks the owner's authorization and the live
Morpho condition onchain before any shares can move.

“Veto” does not mean cancelling Morpho governance or preventing a curator from changing a vault.
The depositor is vetoing **their own continued participation** by leaving.

## The problem

A managed vault can queue changes while depositor capital remains inside. An alert can tell the
depositor what was true when it fired, but it does not enforce what should happen to the position.
It may also be stale by the time an automated transaction lands.

For example, a proposal can be valid when detected and simulated, then be revoked before broadcast
or inclusion. A worker's earlier decision must not, by itself, authorize movement of funds.

Protocols have governance. VETO gives depositors control over whether their capital stays.

## What VETO does today

The first implemented policy is a **management-fee ceiling**:

```text
queued management fee > owner's ceiling
    -> verify the exact proposal
    -> persist one bounded exit intent
    -> KeeperHub simulates and submits the guard call
    -> guard rechecks the mandate and proposal onchain
    -> redeem the approved shares directly to the owner
    -> reconcile the receipt, event, and consumed mandate
```

Morpho exposes this change as deterministic queued calldata with a scheduled execution time. That
makes it suitable for an exact machine-verifiable first rule. Crossing the ceiling means the
depositor's predefined policy was violated; it does **not** imply the curator is malicious or that
liquidation or loss was imminent. For a small position, the cost of exiting and redeploying may be
greater than the fee difference.

Management fee is the demonstrated predicate, not the limit of the VETO thesis. Any later policy
class must first be verified against actual protocol semantics before it can join the authorization
path.

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

KeeperHub is VETO's financial execution layer, not an interchangeable notification channel. VETO
builds one explicit `VetoExitGuard.execute` contract call, simulates it, persists the serialized
broadcast body and a stable financial-operation idempotency key, submits it through KeeperHub, and
polls the resulting execution identity.

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
              KeeperHub simulate + submit
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

Real Morpho compatibility and public KeeperHub execution are demonstrated as **separate evidence
layers**.

### Real Morpho compatibility

The guard, adapter, and scanner are tested against the deployed Gauntlet USDC Prime Vault V2 on a
pinned Base fork at block `51221130`. The tests verify factory provenance, real proposal semantics,
owner-only redemption, proposal revocation, missing allowance, excessive minimum return, and replay
rejection. Fork transactions are deterministic local evidence, not Base mainnet transactions.

### Public KeeperHub execution

The strongest public execution uses the current pipeline and a controlled, valueless Base Sepolia
fixture:

| Field                     | Recorded result                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Network                   | Base Sepolia (`84532`)                                                                                                          |
| KeeperHub execution       | `j220ikha5alnm38w8asm8`                                                                                                         |
| Transaction               | [`0xfd35e6e…a24be2`](https://base-sepolia.blockscout.com/tx/0xfd35e6e64adb4631b2bcd851789291a8ff000d76b9546b00eee4f602d9a24be2) |
| Receipt                   | Success, block `46750196`                                                                                                       |
| Owner return              | `10.000000` VETO Fixture USD units                                                                                              |
| Owner shares after        | `0`                                                                                                                             |
| Guard asset balance after | `0`                                                                                                                             |
| Duplicate intent claimed  | No                                                                                                                              |

This proves a public KeeperHub-submitted, owner-only controlled-testnet redemption. It does not
prove that KeeperHub exited a real Morpho mainnet position or moved real USDC.

Further evidence covers PostgreSQL restart recovery, duplicate delivery, worker leasing,
independent per-mandate scanner checkpoints, proposal/receipt reconciliation, the responsive web
application, and the unsuccessful Glacient entitlement check. Follow the chronological
[`Day 1`](docs/DAY-1-GATES.md), [`Day 2`](docs/DAY-2-GATES.md),
[`Day 3`](docs/DAY-3-GATES.md), and [`Day 4`](docs/DAY-4-GATES.md) records, then read the
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

The recorded Day 3 owner has no shares remaining after its successful exit. Exercising the signing
flow requires a browser wallet that holds shares in the configured controlled Base Sepolia vault.

## Repository map

| Path                                                                     | Purpose                                                          |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| [`contracts/src/VetoExitGuard.sol`](contracts/src/VetoExitGuard.sol)     | Owner mandate and execution-time policy enforcement              |
| [`contracts/test/base-fork.test.mjs`](contracts/test/base-fork.test.mjs) | Pinned real Morpho redemption and adverse checks                 |
| [`packages/morpho-v2/src/scanner.ts`](packages/morpho-v2/src/scanner.ts) | Canonical proposal lifecycle decoding                            |
| [`packages/morpho-v2/src/adapter.ts`](packages/morpho-v2/src/adapter.ts) | Proposal eligibility against live vault state                    |
| [`packages/keeperhub/src/client.ts`](packages/keeperhub/src/client.ts)   | Simulation, submission, retries, and status normalization        |
| [`apps/worker/src/scanner.ts`](apps/worker/src/scanner.ts)               | Mandate-aware scanning and durable decisions                     |
| [`apps/worker/src/pipeline.ts`](apps/worker/src/pipeline.ts)             | KeeperHub execution state machine and recovery                   |
| [`apps/worker/src/reconcile.ts`](apps/worker/src/reconcile.ts)           | Independent receipt and mandate reconciliation                   |
| [`apps/worker/src/store.ts`](apps/worker/src/store.ts)                   | PostgreSQL uniqueness, leases, transitions, and checkpoints      |
| [`apps/web/src/app`](apps/web/src/app)                                   | Owner controls, runtime APIs, outcome, activity, and evidence UI |
| [`evidence`](evidence)                                                   | Public receipts, screenshots, raw facts, and claim boundaries    |
| [`docs`](docs)                                                           | Chronological gate reports and current functional-layer notes    |

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

`pnpm --filter @veto/worker day3:live` and the KeeperHub Gate C script make real external testnet
requests. They require an organization API key, funded or sponsored testnet execution, and explicit
operator intent. Never commit credentials or funded-wallet secrets.

## Limitations

- Management-fee ceiling is the only implemented exit policy.
- The contracts are unaudited, test-only, and not production-ready.
- The public KeeperHub proof uses a controlled Base Sepolia vault and valueless asset.
- Compatibility with a deployed Morpho Vault V2 is currently proven separately on a pinned fork.
- Glacient webhook delivery and payload authentication are not integrated.
- The web runtime supports one configured factory, vault, and guard on Base Sepolia.
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

The management-fee ceiling is the first narrow proof of a broader primitive: **user-defined
conditions controlling whether capital remains in a managed protocol**. Other governance or risk
changes may become future policy classes only after their exact Morpho semantics, timing,
authorization surface, liquidity behavior, and guard enforcement are independently verified.
