# Day 2 hardening gates

Day 2 turns the three Day 1 feasibility proofs into one guarded, reusable Morpho Vault V2 decision
boundary. It does not replace the full plan, the Day 1 records, or the remaining Day 3–5 work.

## Completion conditions

| Condition                                                       | Result | Evidence                                                                                   |
| --------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------ |
| Only one active mandate exists per owner and vault              | PASS   | Replacement invalidates the previous mandate and updates the active index                  |
| Only the owner controls mandate creation and cancellation       | PASS   | A non-owner cancellation fails; owner cancellation clears the active index                 |
| Exit assets can reach only the mandate owner                    | PASS   | Receiver and on-behalf addresses are fixed to the stored owner in the guard                |
| Exit amount is bounded and cannot repeat                        | PASS   | Finite share allowance, stored share amount, consume-before-call, and replay rejection     |
| Exact Morpho proposal is checked at decision and execution time | PASS   | Adapter and guard both verify calldata, fee, timestamp, pending state, and safety headroom |
| Actual deployed Vault V2 withdrawal simulates                   | PASS   | Pinned Base fork at block `51221130` against Gauntlet USDC Prime                           |
| Cancellation between observation and action stops the exit      | PASS   | Real Morpho fork proposal is submitted, verified, revoked, and then classified as cleared  |
| Repository-wide checks pass                                     | PASS   | Format, lint, typecheck, 11 tests, and build passed on 13 September 2026                   |

## Guard behavior added

- `activeMandateByOwnerVault` records exactly one current mandate for each owner/vault pair.
- Arming a replacement consumes the old mandate rather than leaving overlapping exit authority.
- Owner cancellation is single-use and clears the current mandate index.
- Execution rechecks factory registration and deployed vault code.
- A mandate must remain valid beyond its own safety interval when it is armed.
- Successful execution clears the active index before calling the vault. A revert rolls all state
  back atomically.

The receiver remains hard-coded to the owner. KeeperHub or another relayer can call `execute`, but
cannot select the receiver, increase the share quantity, change the fee ceiling, change the minimum
return, or reuse a consumed mandate.

## Morpho adapter behavior added

The adapter independently reads the official factory and selected vault before execution. It emits
one explicit result:

- `eligible`
- `unsupported-vault`
- `unsupported-proposal`
- `fee-within-owner-limit`
- `fee-exceeds-protocol-limit`
- `setter-abdicated`
- `missing-fee-recipient`
- `proposal-cleared`
- `proposal-changed`
- `exit-window-closed`

Management-fee calldata must be exactly 36 bytes and use `setManagementFee(uint256)`. The adapter
compares the raw per-second fee integer; annualization is display-only. Proposal identity includes
chain, checksummed vault, calldata hash, submission block, and log index so separate submissions do
not collapse into one record.

## Test environments

### Pinned public-vault fork

- Environment: local Anvil fork of Base mainnet
- Base block: `51221130`
- Vault: `0x050cE30b927Da55177A4914EC73480238BAD56f0`
- Factory: `0x4501125508079A99ebBebCE205DeC9593C2b5857`
- Scenario: submit a management-fee proposal as the recorded curator, verify it, simulate the exact
  guarded redemption, revoke the proposal, and prove both the adapter and guard refuse the revoked
  state.

Fork transaction hashes are deterministic local evidence, not public-chain transactions.

### Controlled authority test

- Environment: local Anvil chain
- Asset and vault: controlled test-only fixtures
- Assertions: unsupported vault rejection, unusable mandate rejection, stranger cancellation
  rejection, replacement, explicit owner cancellation, exact owner receipt, zero relayer receipt,
  zero guard receipt, active-index clearing, and replay rejection.

The fixture is not Morpho production evidence. The pinned public-vault fork provides compatibility
evidence, while the Day 1 Base Sepolia KeeperHub run provides public execution evidence.

## Reproduce

From the repository root:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Set `BASE_RPC_URL` to a private Base archive-capable RPC when the public endpoint is unavailable.
No secret is required in committed files.

## Known limitations retained from the plan

- The guard is unaudited and must not be used with valuable assets.
- The Day 2 invariant suite is deterministic; broader Foundry fuzzing remains required before any
  production claim.
- Insufficient liquidity, adapter failure, vault gates, unusual token behavior, reorg recovery, and
  provider disagreement remain explicit tests in the full plan.
- Day 2 does not connect the scanner to KeeperHub. Durable storage, idempotent submission, restart
  recovery, status polling, and receipt reconciliation are the Day 3 gate.
- Glacient remains the documented Standard-tier fallback. Do not claim a completed Glacient webhook
  integration.

## Day 3 handoff

Connect the scanner and adapter to a durable intent state machine. Persist the financial identity
before submission, send one bounded guard call through KeeperHub, and prove that restart or duplicate
delivery cannot produce a second economic effect.
