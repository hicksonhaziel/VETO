# Live Morpho Vault V2 Read Evidence

This directory contains real-time, read-only proof of VETO's connection to an active production Morpho Vault V2 deployment on Base mainnet.

## Target Deployment: Gauntlet USDC Prime

- **Network:** Base Mainnet (`chainId: 8453`)
- **Vault Address:** [`0x050cE30b927Da55177A4914EC73480238BAD56f0`](https://basescan.org/address/0x050cE30b927Da55177A4914EC73480238BAD56f0)
- **Morpho Vault V2 Factory:** [`0x4501125508079A99ebBebCE205DeC9593C2b5857`](https://basescan.org/address/0x4501125508079A99ebBebCE205DeC9593C2b5857)
- **Asset:** Native Base USDC ([`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`](https://basescan.org/token/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913))
- **Curator:** Gauntlet ([`0x9E33faAE38ff641094fa68c65c2cE600b3410585`](https://basescan.org/address/0x9E33faAE38ff641094fa68c65c2cE600b3410585))
- **Total Assets:** > $170,000,000.00 USDC
- **Management Fee Timelock:** 259,200 seconds (exactly 3.0 days)

## Reproducible Command

To independently execute the read-only live query against Base mainnet:

```bash
pnpm live:morpho
```

Or specify a custom public/private Base RPC:

```bash
BASE_RPC_URL=https://mainnet.base.org node contracts/scripts/live-morpho-read.mjs
```

This script:
1. Performs **zero write operations** (it cannot send transactions or mutate state).
2. Verifies onchain that the canonical Morpho factory recognizes the vault (`factory.isVaultV2(vault) == true`).
3. Reads vault governance, timelocks, gates, fee parameters, TVL, and recent proposal queues.
4. Outputs structured JSON and updates `evidence/live-morpho/live-read-gauntlet-usdc-prime.json`.

## Onchain Facts Verified

| Metric | Value | Verification Source |
| :--- | :--- | :--- |
| **Factory Provenance** | `isVaultV2 = true` | Verified onchain via `0x4501...5857.isVaultV2(0x050c...56f0)` |
| **Active TVL** | > $171M USDC | Real live liquidity managed by Morpho V2 |
| **Timelock Window** | `259,200s` (3 days) | `timelock(0xfe56e232)` on vault confirms a 3-day window for fee changes |
| **Gate Restrictions** | None (`address(0)`) | `sendSharesGate` and `sendAssetsGate` are both zero; exits are unobstructed |
| **Abdication** | `false` | `abdicated(0xfe56e232)` is false; management fee changes are actively timelocked |
