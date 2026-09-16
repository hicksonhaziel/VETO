# Day 8 — KeeperHub conditional execution in the durable VETO path

This milestone replaces the primary worker submission mode with KeeperHub's documented
`check-and-execute` endpoint while preserving direct execution as an explicit fallback. The exact
conditional request is persisted before submission with the operation identity and idempotency key.
KeeperHub reads Morpho's `executableAt(bytes)`, compares it with VETO's persisted proposal time,
and calls the unchanged `VetoExitGuard` only when they are equal.

## Case A — precheck true, guard true

KeeperHub observed `1789550186`, equal to the persisted target. Execution
`35o448zta7uy9dun9j6py` called the guard in [public transaction
`0x24bafb…c3d6e`](https://base-sepolia.blockscout.com/tx/0x24bafbb926788884dee9160f4ad723a107b3159e4f5ea03b5b78cf07045c3d6e).
The receipt succeeded at block `46889242`; 10 shares became zero, the owner received 10 fixture-USD
units, the guard retained zero, mandate `2` was consumed, duplicate claiming returned nothing, and
the worker reconciled `EXITED`. See [`conditional-success.json`](conditional-success.json).

## Case B — precheck false, no financial transaction

VETO persisted mandate `4` while the exact proposal was pending at `1789551002`, then the proposal
was [revoked publicly](https://base-sepolia.blockscout.com/tx/0x60e539ddf306f6803ec9dd6b76c8745e7f77dc20661d2359a73df5f6967f15e5).
KeeperHub read `0`, returned `met: false`, and supplied neither an execution ID nor transaction hash.
The financial action was not broadcast. The real `ExitPipeline` performed this conditional step;
shares, owner assets, guard assets, and vault assets were unchanged, the mandate stayed active, and
the worker recorded `BLOCKED / PROPOSAL_NOT_PENDING_AT_EXECUTION`.

A separate recorder transaction again captured `ProposalIsNotExecutable()` from the same guard
calldata. Its successful outer receipt is independent rejection evidence, not a failed withdrawal
and not the conditional action. See [`conditional-false.json`](conditional-false.json).

## Case C — read true, state changes, guard false

The pinned Base-fork contract test deterministically reads/simulates the valid proposal, revokes it,
then sends the previously valid guard arguments. The guard rejects, shares and assets remain
unchanged, and the mandate remains active. This is fork evidence, not a claimed public race. It
proves the KeeperHub read at T1 cannot replace the guard's atomic check at T2.

## Recovery evidence

The database-backed worker suite ran against a disposable PostgreSQL 16 database with 11 passing
tests and zero skips. It covers false-without-transaction, a lost conditional response recovered by
the identical serialized request and idempotency key, duplicate durable intent/worker behavior,
restart recovery, and KeeperHub-success/chain-mismatch becoming `DISPUTED`. KeeperHub status is
platform information; only receipt, guard event, proposal hash, owner, shares, minimum return, and
consumed mandate can produce `EXITED`.

The public vault is unmodified official Morpho Vault V2 source deployed by VETO on Base Sepolia for
reproducibility. It is not an official Morpho Association deployment, mainnet, real USDC, an audit,
or production-security evidence.
