# Real Morpho Vault V2 public end-to-end evidence

- Recorded: 14 September 2026 (Africa/Lagos)
- Network: Base Sepolia (`84532`)
- Asset: valueless `VETO Fixture USD` (`vfUSD`), six decimals
- Result: **PASS**

## What is new

This run joins the two evidence layers that were previously separate. KeeperHub created and
configured an actual Morpho Vault V2 instance, deposited test funds, armed VETO, queued a real
Morpho `setManagementFee(uint256)` proposal, and then submitted the guard execution selected by the
existing scanner and durable worker pipeline.

The Morpho contracts were compiled without source modification from release `2025-09-15`, commit
`6f2af6602e05d9e123a87c1067712a4566608044`. Every fetched source file is hash-pinned. The compiled
factory runtime SHA-256 is
`cf0f79d0fb41a563e915b81cefb581f74acb46336cee022c1991671d9e575d8e`, exactly matching the
canonical Morpho factory deployed on Base at `0x4501125508079A99ebBebCE205DeC9593C2b5857`.
Constructor-bound immutable slots are normalized when checking the created vault runtime; the
remaining bytecode exactly matches the canonical compiled template.

This is genuine Morpho Vault V2 behavior on a public testnet, but the factory is a VETO-controlled
deployment of canonical Morpho code rather than a Morpho Association deployment. No real-value
asset or Morpho mainnet position moved.

## Public identities

| Field | Value |
|---|---|
| Morpho Vault V2 factory | `0x934c8F413D8c5C770259010D5313Bd8bc44432f9` |
| Morpho Vault V2 | `0x9019B1e26795E90825c567aD08c945C603e7F9B9` |
| VetoExitGuard | `0xF23824d2ce4e43fA1073896D1F2E898fE47BBE0F` |
| Owner | `0x3E7A055F59c662987Ae68240Fd713195C30C0497` |
| Test asset | `0xEeae78be065258b11119D43C91c975a92A3aD6dc` |
| Mandate | `0` |

The deployed factory returns `isVaultV2(vault) = true` for the exact vault above.

## Acceptance evidence

| Criterion | Public or independently reconciled result |
|---|---|
| KeeperHub execution ID | `e6gg1z9q6eb37cd2v6v1w` |
| Exit transaction | [`0x6823882c…ce333`](https://base-sepolia.blockscout.com/tx/0x6823882c7605922935c902c53efad5ff7c4827e3461d05fe8313116b962ce333) |
| Actual Morpho V2 contract | Canonical runtime provenance plus factory-recognized vault |
| Proposal evidence | [`0xbf4209d8…01d60`](https://base-sepolia.blockscout.com/tx/0xbf4209d8d6518ceec294cd7d4abf3c52acab4b1319b018266c100f3e6f601d60) |
| Mandate evidence | [`0xc47ceb19…c253f`](https://base-sepolia.blockscout.com/tx/0xc47ceb19e1927007fc527a627d929a22348e0343b45842dcad17ed74984c253f) |
| Shares before / after | `10000000000000000000` / `0` |
| Owner assets after deposit / exit | `0` / `10000000` |
| Owner receives funds | PASS — receipt transfers `10.000000 vfUSD` to owner |
| Guard retains nothing | PASS — asset balance `0` |
| Vault retains nothing | PASS — asset balance `0` |
| Mandate consumed | PASS — `active = false` at receipt block |
| Worker state | `EXITED` |
| Duplicate claim | No |

## Exact trigger and reconciliation

The owner ceiling was 1% annualized (`317097919` per second). The queued fee was 2% annualized
(`634195839` per second) with a one-hour timelock. The proposal was executable at Unix time
`1789387400`; VETO exited at block `46807762`, while the proposal was still pending and more than the
owner's 300-second safety window remained.

The worker recorded:

```text
READY -> SIMULATED -> SUBMITTING -> PENDING -> CONFIRMING -> EXITED
```

Independent receipt reconciliation found the exact `Exited` event, matching proposal hash, matching
share amount, returned assets meeting the mandate minimum, and the consumed mandate. A second worker
run found no claimable intent.

Raw public identifiers and setup transactions are retained in [`executions.json`](./executions.json).
