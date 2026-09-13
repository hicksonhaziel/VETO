# Day 2 evidence — guard and Morpho adapter

- Recorded: 13 September 2026 (Africa/Lagos)
- Source state: commits `80804be`, `6bb9945`, and `77473ca`
- Mainnet interaction: none; public deployment was read through a pinned local fork
- Public execution evidence: unchanged from Day 1 KeeperHub Base Sepolia run
- Public explorer: [open the reused Day 1 successful transaction](https://base-sepolia.blockscout.com/tx/0x0fdf2a928713da623cfbfb95d6d5ca47be9cd6e058a5c29c6cfa30b0e021584b)
- Explorer screenshot: [`transaction-proof.jpg`](./transaction-proof.jpg)

The Day 2 screenshot deliberately records the unchanged Day 1 public proof. Day 2's new exit was a
fork-only simulation, so this file must not be presented as a separate Day 2 public transaction.

## Result

**PASS for the Day 2 milestone:** the hardened guard and Morpho adapter pass authority checks, the
actual Gauntlet USDC Prime Vault V2 path simulates at pinned Base block `51221130`, and proposal
revocation prevents later eligibility and execution.

## Automated results

| Suite | Tests | Result |
|---|---:|---|
| Worker receiver | 2 | PASS |
| Morpho scanner and adapter | 7 | PASS |
| Guard authority and Base fork | 2 | PASS |
| Total | 11 | PASS |

Repository-wide `format:check`, `lint`, `typecheck`, `test`, and `build` also passed.

## Exact fork result

- Chain: Base (`8453`), local fork
- Pinned block: `51221130`
- Factory: `0x4501125508079A99ebBebCE205DeC9593C2b5857`
- Vault: `0x050cE30b927Da55177A4914EC73480238BAD56f0`
- Owner: `0xA0894A415c4F246CE95BaE718849579c099Cc1d2`
- Shares redeemed: `2956324556913592348497355`
- Owner USDC-unit increase: `3077821288866`
- Relayer USDC balance after execution: `0`
- Deterministic fork-only exit hash:
  `0x494af721b15fb60d807316af3400eb2fb5d72f247ed68626d36060cbba9d0df1`

The fork changes are discarded after the test. This is exact deployed-contract simulation, not a
Base mainnet withdrawal and not new public asset movement.

## Authority conclusions

1. A vault absent from the configured Vault V2 factory registry is rejected.
2. An old mandate becomes inactive when its owner creates a replacement for the same vault.
3. A stranger cannot cancel an owner's mandate.
4. Owner cancellation clears the active mandate and cannot be repeated.
5. The relayer cannot redirect or receive the withdrawn asset.
6. The guard does not retain the withdrawn asset.
7. The stored share quantity bounds the exit.
8. Successful execution consumes the mandate before the external vault call.
9. Repeating the same execution has no second economic effect.
10. A revoked fee proposal is no longer eligible even if it was eligible before revocation.

## Claim boundary

This evidence closes the Day 2 engineering milestone only. It does not claim an audit, production
safety, a completed Glacient webhook integration, real USDC movement, or a complete automatic
scanner-to-KeeperHub pipeline. Those limitations remain visible in `docs/DAY-2-GATES.md` and the
original untracked research plan.
