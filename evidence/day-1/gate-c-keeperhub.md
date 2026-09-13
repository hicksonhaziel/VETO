# Gate C — KeeperHub execution

Status: **PASS — KeeperHub-submitted owner-only redemption verified on Base Sepolia**

Checked at: 2026-09-12T19:30:10Z

## Checks completed

- `GET /api/keys` returned HTTP `200` with the configured organization API key.
- The active key is named `veto-dev`, has no expiry, and reports no scope restriction.
- `GET /api/user` returned HTTP `200`.
- KeeperHub organization wallet: `0x3e7a055f59c662987ae68240fd713195c30c0497`.
- The live chain catalog includes enabled Base Sepolia (`84532`) and Ethereum Sepolia (`11155111`).
- A KeeperHub contract read on Base mainnet returned `true` for the selected Morpho factory's
  `isVaultV2` check.

## Test balances

| Network | Asset | Balance |
|---|---|---|
| Base Sepolia | Native ETH | `129227533622046` wei |
| Base Sepolia | Test USDC | `0` base units |
| Ethereum Sepolia | Native ETH | `0` wei |
| Ethereum Sepolia | Test USDC | `0` base units |

## Secret handling

The real API key is stored only in the ignored local `.env`. This evidence file and `.env.example`
contain no secret value. The disclosed development key must be rotated before production use.

## Controlled Base Sepolia deployment

The public test used a clearly labelled controlled fixture because no suitable funded public Morpho
Vault V2 testnet position was available. The fixture token is **not USDC** and has no financial
value. Contract deployment and every setup call were submitted through KeeperHub.

| Contract | Base Sepolia address |
|---|---|
| Controlled factory | `0xA4626F84b7E745Ce98371E9458416C050bB5d358` |
| Fixture vault | `0x7ca4178d1647548fE47f4927dE8e36b14BbC5988` |
| Fixture asset | `0x2f129AB89E2ABd291FE6Ac73DB542F5CeD02dD3D` |
| VETO exit guard | `0x2ae06c9233884af99fDD07353De48b5D97640100` |

The fixture held `10,000,000` six-decimal test units. Mandate `0` authorized exactly `10,000,000`
shares, fixed the receiver to the KeeperHub wallet, required at least `9,999,999` assets, allowed a
1% annualized management fee, and retained a 300-second safety margin. A controlled 2% annualized
fee proposal was then queued with a one-hour timelock.

## KeeperHub execution proof

- KeeperHub execution ID: `71hffqk5o7i68xphnkoc0`
- Base Sepolia transaction:
  `0x0fdf2a928713da623cfbfb95d6d5ca47be9cd6e058a5c29c6cfa30b0e021584b`
- Public explorer: [open the successful Base Sepolia transaction](https://base-sepolia.blockscout.com/tx/0x0fdf2a928713da623cfbfb95d6d5ca47be9cd6e058a5c29c6cfa30b0e021584b)
- Explorer screenshot: [`transaction-proof.jpg`](./transaction-proof.jpg)
- Block: `46736449`
- Gas used: `116130`
- Independently fetched receipt status: `0x1` (success)
- Post-state owner shares: `0`
- Post-state owner fixture assets: `10,000,000`
- Post-state guard fixture assets: `0`
- Post-state mandate: inactive/consumed

The receipt logs independently show the fixture asset moving from the vault to the KeeperHub owner,
the vault withdrawal naming that same address as receiver and owner, and the guard `Exited` event
for mandate `0`. A transient status-poll timeout occurred during the finite guard-approval step;
replaying the identical request with the same idempotency key recovered execution
`tvw9c0l77c1s8q30ombia` and its successful transaction without sending another approval.

All nine execution IDs and public transaction hashes are retained in `gate-c-executions.json`.
Gate B's real-deployment fork test proves duplicate execution, revoked proposal, missing allowance,
and excessive minimum-output failures against the hardened guard. The public Gate C transaction
proves KeeperHub delivery and owner-only asset receipt on the controlled testnet fixture.
