# VETO functional layer

VETO implements **depositor-controlled, enforceable exit rules for protocol changes**. “Veto” means
the depositor opts out of continued participation; it does not cancel a Morpho proposal or prevent
the curator from changing the vault.

The current product connects the owner-facing dashboard to the deployed Base Sepolia guard, the
public chain, PostgreSQL rule storage, and the durable KeeperHub worker. The recorded centerpiece is
now the Day 5 execution against canonical Morpho Vault V2 code; recorded evidence remains visibly
separate from live connected-owner state.

## Current policy boundary

The only implemented rule type is a queued Morpho Vault V2 management-fee change above the owner's
chosen ceiling. It is the first deterministic, queued, machine-verifiable policy—not the entire
long-term thesis. Crossing the ceiling records a user preference breach; it does not imply curator
malice, imminent liquidation, or guaranteed avoided loss.

## Owner flow

1. Connect an EIP-1193 browser wallet. VETO reads the configured supported vault for that address.
2. The runtime confirms that the factory recognizes the vault and that PostgreSQL monitoring is
   ready.
3. Review the exact shares, minimum return, annual management-fee ceiling, expiry, and safety
   window.
4. Sign a finite vault-share approval to the deployed guard.
5. Sign `VetoExitGuard.arm`. The receiver is fixed on-chain to the owner.
6. VETO fetches the receipt, verifies the guard target and `MandateArmed` event, and only then stores
   the rule for monitoring.
7. The worker discovers every active stored rule, scans each rule with an independent reorg-safe
   checkpoint, and submits an eligible exit through KeeperHub.
8. The owner may sign `VetoExitGuard.cancel`; VETO verifies the cancellation receipt before marking
   the rule cancelled.

The browser wallet signs owner authority. The KeeperHub organization account is used only by the
VETO worker when a verified exit becomes eligible. No KeeperHub key is exposed to the browser, and
the depositor does not need a KeeperHub account.

## Observation is not authorization

The scanner's assessment and KeeperHub simulation do not grant withdrawal authority. At execution
time, `VetoExitGuard` independently rechecks the configured vault, current owner mandate, exact
proposal calldata, fee condition, pending state, expected executable time, mandate expiry, safety
window, fixed share amount, minimum return, and owner-only receiver. If a proposal was revoked after
observation, the transaction cannot use the stale decision to redeem.

KeeperHub remains the execution layer. The guard makes that delegated execution trust-minimized by
constraining what a successful transaction is allowed to do onchain.

## Runtime surfaces

- `GET /api/runtime` checks the configured Base Sepolia contracts, current block, migrations, and
  PostgreSQL readiness.
- `GET /api/positions?owner=0x…` reads live shares, redeem preview, finite allowance, and active
  mandate from the chain.
- `GET /api/rules?owner=0x…` returns verified stored rules joined to durable execution state.
- `POST /api/rules` registers or cancels only after validating a successful public receipt and the
  matching guard event.

## Honest boundary

The full functional path is implemented for the deployed controlled Base Sepolia factory and
guard. The recorded owner has zero remaining shares because the Day 3 exit already redeemed them,
and the automated browser has no injected wallet, so no new owner-signed transaction was created in
this checkpoint. A user must connect a wallet that actually holds shares in a vault recognized by
the configured factory before the two signing actions become available.

The public Base RPC limits log queries to 10,000 blocks. The worker therefore advances each rule in
9,999-block chunks and stores a separate checkpoint per guard mandate, preventing one owner's scan
from skipping another owner's proposal.

VETO can enforce when an exit is authorized; it cannot manufacture executable vault liquidity. P0
does not attempt an automatic partial exit. If the exact redemption reverts, the transaction leaves
the owner's position and active mandate unchanged. The worker records the concrete simulation or
execution failure and must not label it `BLOCKED_LIQUIDITY` without evidence that liquidity was the
cause.

The Day 5 evidence joins real Morpho contract behavior and public KeeperHub execution: a
byte-for-byte canonical Morpho factory deployed on Base Sepolia created the actual Vault V2 used for
the deposit, fee proposal, scan, guard execution, redemption, and durable reconciliation. The
factory is VETO-controlled and the asset is valueless test data, so this is not a Morpho Association
testnet deployment or a mainnet asset-movement claim. Pinned Base-fork tests remain separate adverse
evidence against the deployed Gauntlet USDC Prime vault.

The Day 6 companion execution proves the stale-observation boundary publicly on the same vault.
After VETO detected and simulated an eligible proposal, the curator revoked it. KeeperHub rejected
the direct stale submission during preflight, and a testnet-only recorder then forwarded the exact
prepared calldata to the guard so its `ProposalIsNotExecutable()` rejection could be recorded in a
public receipt. The recorder requires that exact error and has no custody functions. No shares or
assets moved, the mandate remained active, and the worker recorded the concrete blocked reason.
