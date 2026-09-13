# Day 3 durable pipeline gates

Day 3 connects the canonical Morpho scanner, the owner policy, PostgreSQL durability, KeeperHub
execution, and independent chain reconciliation. It preserves the Day 1 and Day 2 evidence and does
not remove any remaining requirement from the full plan.

## Completion conditions

| Condition                                                     | Result | Evidence                                                                                             |
| ------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------- |
| Scanner creates an intent from a verified proposal            | PASS   | Actual Morpho Base fork and controlled Base Sepolia pipeline                                         |
| Financial identity is durable and unique                      | PASS   | PostgreSQL uniqueness on chain + guard + mandate and operation key                                   |
| Two workers cannot submit the same intent concurrently        | PASS   | PostgreSQL lease with `FOR UPDATE SKIP LOCKED`                                                       |
| Serialized broadcast body and idempotency key survive restart | PASS   | Lost-response integration test recovers with identical values                                        |
| Duplicate observation cannot create another exit              | PASS   | Duplicate insert returns false; terminal intent is not claimable                                     |
| KeeperHub status is reconciled with the chain                 | PASS   | Successful receipt, exact `Exited` event, proposal hash, shares, minimum, and consumed state checked |
| Controlled public end-to-end execution succeeds               | PASS   | Base Sepolia execution `j220ikha5alnm38w8asm8`                                                       |
| Full repository checks pass                                   | PASS   | Format, lint, typecheck, tests, and build on 13 September 2026                                       |

## Durable state machine

The worker uses the full state vocabulary retained from the plan:

```text
OBSERVED -> CHECKING -> NOT_APPLICABLE / BLOCKED / READY
READY -> SIMULATED -> SUBMITTING -> PENDING -> CONFIRMING -> EXITED
SUBMITTING / PENDING -> UNKNOWN -> RECONCILING
unexecuted work -> CANCELLED / EXPIRED
provider and chain disagreement -> DISPUTED
```

Invalid transitions fail instead of silently changing the financial outcome. `EXITED` is terminal
and can never transition back to submission.

## PostgreSQL records

`db/migrations/0001_exit_intents.sql` stores:

- chain, guard, and mandate identity;
- proposal identity, exact calldata, and expected execution timestamp;
- exact JSON request and serialized request body;
- stable KeeperHub idempotency key;
- execution ID and transaction hash;
- current state, last error, reconciliation result, worker lease, and version.

Every state transition is appended to `exit_intent_events`. `scanner_checkpoints` retains the next
block and previous block hash. A changed hash causes a configurable rewind; unique decisions and
intents make rescanning safe.

`db/migrations/0002_proposal_decisions.sql` stores eligible and refused proposal decisions. A
refusal is evidence too; it is not discarded simply because no transaction was submitted.

## Restart and duplicate test

The integration test uses a real temporary PostgreSQL 16 server and a controlled HTTP execution
endpoint:

1. The proposal creates one `READY` intent; inserting it again returns false.
2. The first worker simulates and changes the state to `SUBMITTING`.
3. The endpoint accepts the request but deliberately drops the response.
4. The first worker records `UNKNOWN` without inventing a new request.
5. A new worker claims the persisted intent after restart.
6. It moves through `RECONCILING` and sends the identical body and idempotency key.
7. The endpoint returns the original execution ID.
8. The transaction is confirmed and the intent becomes `EXITED`.
9. A third worker finds nothing claimable.

The injected lost response is a controlled reliability test, not a claim that KeeperHub failed in
production.

## Public controlled execution

- Network: Base Sepolia (`84532`)
- Environment: controlled test-only vault and valueless six-decimal fixture asset
- KeeperHub execution: `j220ikha5alnm38w8asm8`
- Transaction:
  `0xfd35e6e64adb4631b2bcd851789291a8ff000d76b9546b00eee4f602d9a24be2`
- Receipt: success at block `46750196`
- Guard: `0x2d55D4c2A101eed8c50B7428A20e486f9db60751`
- Vault: `0x4425441e908a7Dcc8a7EC56125c24147977a0aC4`
- Owner shares after: `0`
- Owner fixture-asset units after: `10000000`
- Guard fixture-asset units after: `0`
- Duplicate intent claimed after completion: no

The live sequence was:

```text
controlled Morpho-shaped Submit event
  -> scanner
  -> onchain proposal verification
  -> PostgreSQL READY intent
  -> KeeperHub simulation
  -> persisted SUBMITTING state
  -> KeeperHub contract call
  -> public Base Sepolia receipt
  -> Exited event and mandate reconciliation
  -> EXITED
```

The controlled vault implements the tested Vault V2 proposal and redemption surface, but it is not a
Morpho production deployment. Real Morpho compatibility remains supported by the pinned Base-fork
tests from Days 1 and 2. The evidence layers must remain separate in the demo.

## Run locally

Prepare PostgreSQL, fill the documented `.env` fields, compile the packages, then start the worker:

```bash
pnpm build
pnpm --filter @veto/worker start
```

The worker applies both migrations, scans from the configured checkpoint, persists decisions,
processes recoverable intents, and exposes the existing receiver health endpoint. Secrets are read
only from the ignored `.env` or process environment.

The public controlled proof can be reproduced only with a funded or sponsored KeeperHub organization
wallet and explicit testnet configuration:

```bash
pnpm --filter @veto/worker day3:live
```

## Known limitations retained from the plan

- Contracts remain unaudited and test-only.
- The public Day 3 asset is valueless fixture data, not USDC.
- The live proof used zero confirmation delay for test speed; the worker defaults to two blocks.
- Short reorg rewind exists, but deep reorg and every platform/chain disagreement combination remain
  pre-submission work.
- PostgreSQL was local for this evidence run; production hosting and backup configuration are not
  yet complete.
- Glacient remains a documented fallback, not a completed webhook integration.
- Liquidity failures, unusual assets, multi-vault operation, service budgets, and production alerting
  remain in the full plan.

## Day 4 handoff

Build the useful operator screen and evidence view around these durable records. A second person must
be able to understand the mandate, pending change, refusal or exit result, and follow the exact
KeeperHub and explorer links without reading source code.
