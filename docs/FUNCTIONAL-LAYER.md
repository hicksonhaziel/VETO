# VETO functional layer

The product now connects the owner-facing dashboard to the deployed Base Sepolia guard, the public
chain, PostgreSQL rule storage, and the durable KeeperHub worker. Recorded Day 3 evidence remains
visibly separate from live connected-owner state.

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
VETO worker when a verified exit becomes eligible. No KeeperHub key is exposed to the browser.

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
