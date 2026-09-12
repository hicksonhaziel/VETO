# Day 1 integration gates

This runbook answers one question before product development expands: can VETO receive the right
signal, verify a compatible Morpho Vault V2, and move assets through KeeperHub? Record observed
facts and public evidence. Do not treat a local simulation, test webhook, or HTTP success as proof
of an onchain exit.

## Required outputs

Create `evidence/day-1/` locally and retain these artifacts without secrets:

- `gate-a-signal.md`: Glacient access result, observed event coverage, payload facts, and fallback.
- `gate-b-vault.md`: chain, vault, factory provenance, source version, asset, roles, gates, adapters,
  fee timelock, and withdrawal simulation.
- `gate-c-keeperhub.md`: credential check, organization wallet, chain, simulation, execution ID,
  transaction hash, receipt, share change, asset transfer, gas, and conclusion.
- Redacted JSON responses and payloads referenced by those reports.

Never save API keys, session cookies, private keys, full authorization headers, or unredacted user
data in `evidence/`. The directory is intended to become public submission evidence.

## Prerequisites

1. Prepare a dedicated test wallet and a test-only RPC endpoint.
2. Create accounts for Glacient and KeeperHub through their normal interfaces.
3. Decide who controls the depositor wallet and who controls the KeeperHub organization wallet.
4. Use a stable KeeperHub-supported testnet for the first write. Query the live catalog rather than
   copying a chain list into code.
5. Define a stop time. If any gate is still unproven at the end of Day 1, document the blocker and
   follow the fallback stated under that gate.

## Gate A — establish the signal source

### A1. Confirm product access

1. Sign in at Glacient and open the Morpho Vault V2 monitoring surface.
2. Confirm that the current account tier can deliver to a user-controlled HTTPS webhook.
3. Record the tier or trial, account access date, supported networks, and any delivery limits.
4. Do not purchase a plan without an explicit budget decision.

### A2. Prove the required event exists

1. Search the Glacient metric/monitor catalog for a **queued Vault V2 management-fee change**.
2. Select one exact vault address and chain. A general fee, APY, TVL, or warning alert is not the
   required event.
3. Configure an HTTPS receiver that retains the raw request body and headers securely. Use a
   controlled endpoint; do not expose repository or wallet secrets to a public request bin.
4. Trigger or wait for an actual supported event. A “test webhook” proves transport only.
5. Save a redacted copy containing the receive time, raw-body hash, delivery identifier if present,
   authentication method, chain, vault, transaction/block reference, and proposal fields.

### A3. Resolve the alert independently

1. Use the chain ID and vault address from the delivery to locate the canonical Vault V2 proposal.
2. Decode its calldata with the ABI pinned from the verified Morpho source.
3. Confirm the selector is `setManagementFee`, the proposed raw fee exceeds the chosen ceiling,
   and the proposal remains pending.
4. Record the proposal submission block/hash, scheduled execution time, and remaining headroom.
5. Repeat with a revoked or stale proposal to learn how Glacient represents cancellation and replay.

### Gate A pass or fallback

**Pass:** one real Glacient delivery resolves to the exact live proposal on the correct chain.

**Fallback:** if the product cannot deliver this event, state that by the Day 1 cutoff. Keep VETO,
but use a canonical chain scanner for Vault V2 `Submit` and `Revoke` events. Do not claim a completed
Glacient integration. The scanner remains a reconciliation source even if Gate A passes.

## Gate B — verify an actual Morpho Vault V2

### B1. Choose the chain before the vault

1. Request `GET https://app.keeperhub.com/api/chains`.
2. Keep only entries where `chainType` is `evm` and `isEnabled` is true. Start with an entry where `isTestnet` is also
   true for the controlled execution; separately identify the mainnet on which public Vault V2
   compatibility will be checked.
3. Record the numeric `chainId`, status, explorer, and RPC source. Do not use a deprecated network
   name in new KeeperHub requests.

### B2. Prove factory provenance and source compatibility

1. Select a deployed vault from Morpho's current application/API or published metadata.
2. Obtain the official Vault V2 factory address for that chain from Morpho's address registry.
3. Read `isVaultV2(candidate)` on the factory. Reject the candidate if it is false.
4. Find the factory creation transaction/event and record the block and transaction hash.
5. Confirm the explorer source is verified. Pin the exact Morpho Vault V2 release or commit and
   compare deployed bytecode or verified compiler metadata. A “V2” label is insufficient.

### B3. Inspect the vault configuration

Record these onchain reads at a pinned block:

- asset address, symbol, and decimals;
- owner, curator, sentinels, and allocators relevant to the test;
- receive/send share and asset gates;
- adapters, registry, liquidity adapter, and liquidity data;
- current management fee and fee recipient;
- timelock for `setManagementFee` and any exact pending proposal;
- owner share balance and the proposed finite guard allowance.

Management fee is a WAD-scaled per-second raw integer. Compare raw integers in authorization logic;
annualize only for display. Verify the maximum against the selected source version.

### B4. Prove the withdrawal path

1. Construct the exact future guard call with the intended owner, share amount, receiver, minimum
   assets, mandate expiry, proposal calldata, proposal timestamp, and safety margin.
2. Simulate it at a pinned block with `eth_call` from the KeeperHub organization wallet.
3. Ensure the simulated receiver is always the owner and the share allowance is finite.
4. Inspect idle assets and the configured liquidity adapter. Do not use TVL, `maxWithdraw()`, or
   `maxRedeem()` alone as withdrawal-capacity evidence.
5. Repeat after revoking the proposal; the simulated call must fail.

### Gate B pass

**Pass:** factory provenance, exact source compatibility, non-zero proposal window, and a viable
delegated redemption path are documented for a real deployment. A local vault does not pass.

## Gate C — execute through KeeperHub

### C1. Establish authenticated access

1. Sign in to KeeperHub, create or select an organization, and locate its managed wallet.
2. Create an **organization** API key from the Organisation keys area. It should use the `kh_`
   prefix. A `wfb_` webhook-trigger key is not interchangeable.
3. Store the key only in a local secret manager or ignored `.env` file.
4. Verify it with `GET https://app.keeperhub.com/api/keys` using a Bearer header. A `200` proves the
   organization credential works; the public chains endpoint does not.
5. Record the organization wallet returned by the authenticated profile/wallet read and fund it
   with only the test assets and gas needed for the experiment.

### C2. Prepare a controlled first exit

1. Use an enabled stable testnet from the live chains response.
2. Deploy the hardened candidate guard and controlled Vault V2 fixture when no compatible public
   testnet vault exists. Label this evidence as controlled testnet, not production.
3. Deposit a small test amount from the depositor wallet.
4. Register one mandate and approve the guard for exactly the mandate's share quantity.
5. Queue a management fee above the mandate ceiling with enough timelock headroom.

### C3. Simulate the exact KeeperHub call

1. Build a `POST /api/execute/contract-call` body with numeric `chainId`, guard address, pinned ABI,
   function name, and JSON-encoded positional arguments.
2. Submit the exact body with `simulate: true`; a simulation creates no execution audit row and no
   transaction hash.
3. Require a clean result, then independently run `eth_call` from the actual organization wallet.
4. Use a different idempotency key for broadcast. Reusing the simulation key with a changed body
   can produce an idempotency conflict.

### C4. Broadcast once and reconcile

1. Serialize and persist the final request before submission.
2. Send it once with a stable `Idempotency-Key` representing `chain + guard + mandate ID`.
3. Save the returned `executionId` and transaction hash immediately.
4. If the response is lost or uncertain, retry the identical serialized request with the same key.
   Never create a fresh financial intent merely because the transport timed out.
5. Poll `GET /api/execute/{executionId}/status` until terminal or explicitly unconfirmed.
6. Verify the chain receipt independently. KeeperHub `completed` alone is not proof of success;
   require a successful receipt and the expected guard event.
7. At the transaction block, verify the mandate is consumed, owner shares fell by the expected
   amount, the owner received at least the minimum assets, no third party received proceeds, and
   the transaction was included before the proposal deadline.

### C5. Run the minimum failure checks

1. Deliver the same signal again; no second economic effect is allowed.
2. Queue another proposal, simulate, revoke it, then submit; the guard must reject it.
3. Remove the finite share allowance; simulation must fail.
4. Set the minimum assets above the achievable return; the entire transaction must revert.

### Gate C pass or stop

**Pass:** a KeeperHub execution ID maps to a public-chain transaction with a successful receipt and
an independently verified owner-only redemption.

**Stop:** if no KeeperHub write passes, label the main-track integration incomplete. Continue local
contract and adapter development, but do not substitute a direct wallet transaction or polished UI
for KeeperHub execution evidence.

## End-of-day decision record

| Gate          | Result   | Evidence                                                             | Next action                  |
| ------------- | -------- | -------------------------------------------------------------------- | ---------------------------- |
| A — signal    | FALLBACK | Standard tier cannot connect the exact monitor to Webhook            | Use canonical Morpho scanner |
| B — vault     | PASS     | Gauntlet USDC Prime, Base block `51221130`, deterministic fork proof | Retain regression tests      |
| C — execution | PASS     | `71hffqk5o7i68xphnkoc0` / `0x0fdf2a92…0e021584b`                     | Build product pipeline       |

Decision recorded on 2026-09-12 by the project operator and Codex. Gate A uses the planned canonical
chain fallback and must not be described as a completed Glacient webhook integration. Gate B uses a
real Morpho Base deployment with a labelled fork-only proposal. Gate C uses a controlled Base
Sepolia fixture and a real KeeperHub-submitted public transaction.

Record the date, operator, exact environment, known limitations, and the next morning's first task.
Do not proceed to dashboard polish while Gate B or Gate C is unresolved.

## Current primary references

- [Glacient Morpho monitoring](https://glacient.ai/)
- [Glacient documentation](https://docs.glacient.ai/)
- [Morpho contract addresses](https://docs.morpho.org/developers/contracts/addresses/)
- [Morpho Vault V2 source](https://github.com/morpho-org/vault-v2)
- [KeeperHub platform reference](https://docs.keeperhub.com/platform-reference)
- [KeeperHub chains API](https://docs.keeperhub.com/api/chains)
- [KeeperHub direct execution API](https://docs.keeperhub.com/api/direct-execution)
- [KeeperHub execution recovery](https://docs.keeperhub.com/cli/execution-recovery)
