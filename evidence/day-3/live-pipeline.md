# Day 3 evidence — durable KeeperHub pipeline

- Recorded: 13 September 2026 (Africa/Lagos)
- Network: Base Sepolia (`84532`)
- Evidence type: controlled public testnet execution
- Asset: valueless `VETO Fixture USD`, six decimals
- Database: temporary local PostgreSQL 16, removed after verification

## Result

**PASS for the Day 3 milestone.** The canonical scanner observed one queued management-fee proposal,
verified it against on-chain state, created one durable intent, simulated the exact guard call,
submitted it through KeeperHub, reconciled the public receipt and guard state, and reached `EXITED`.
A second pipeline run could not claim or execute the completed intent.

## Main execution

- KeeperHub execution ID: `j220ikha5alnm38w8asm8`
- Transaction hash:
  `0xfd35e6e64adb4631b2bcd851789291a8ff000d76b9546b00eee4f602d9a24be2`
- Public explorer: [open the successful Base Sepolia transaction](https://base-sepolia.blockscout.com/tx/0xfd35e6e64adb4631b2bcd851789291a8ff000d76b9546b00eee4f602d9a24be2)
- Explorer screenshot: [`transaction-proof.jpg`](./transaction-proof.jpg)
- Block: `46750196`
- Block timestamp: `1789268680`
- Receipt status: success
- Gas used: `125379`
- Operation key: `84532:0x2d55d4c2a101eed8c50b7428a20e486f9db60751:0`
- Idempotency key: `veto-exit-9019f1dc4e40f7da89e45878e7fb0dca`

## Contracts and balances

- KeeperHub owner wallet: `0x3E7A055F59c662987Ae68240Fd713195C30C0497`
- Controlled factory: `0x6fDe9C612Cbb2A35d783F376BEd0c58bAb1EEbE4`
- Controlled vault: `0x4425441e908a7Dcc8a7EC56125c24147977a0aC4`
- Fixture asset: `0xEeae78be065258b11119D43C91c975a92A3aD6dc`
- Current Day 2 guard: `0x2d55D4c2A101eed8c50B7428A20e486f9db60751`
- Mandate ID: `0`
- Shares redeemed: `10000000`
- Assets returned to owner: `10000000`
- Owner shares after: `0`
- Owner assets after: `10000000`
- Guard assets after: `0`

## Reconciliation assertions

| Assertion | Result |
|---|---|
| Public receipt succeeded | PASS |
| Expected guard `Exited` event exists | PASS |
| Event mandate ID matches | PASS |
| Proposal hash matches persisted calldata | PASS |
| Redeemed shares match stored mandate | PASS |
| Assets satisfy stored minimum | PASS |
| Mandate is consumed at receipt block | PASS |
| Duplicate run claims another intent | NO |

## Durable transition history

```text
READY
  -> SIMULATED
  -> SUBMITTING
  -> PENDING
  -> CONFIRMING
  -> EXITED
```

The serialized request and idempotency key were stored before submission. Separate PostgreSQL
integration evidence injected a lost response and proved a restarted worker recovers with the same
body and key, producing one accepted economic operation.

## Claim boundary

This is a real KeeperHub-submitted public transaction using the current guard, scanner, database
pipeline, and receipt reconciler. The vault and asset are controlled test fixtures and must not be
presented as Morpho mainnet or real USDC. Real Morpho deployed-contract compatibility is established
separately by the pinned Base-fork tests.
