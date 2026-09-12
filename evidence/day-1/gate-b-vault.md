# Gate B — Morpho Vault V2 compatibility

Status: **IN PROGRESS — deployment verified; exact guarded redemption not yet simulated**

Checked at: 2026-09-12T16:48:10Z

Pinned API block: Base block `51221130`

## Selected deployment

| Field | Value |
|---|---|
| Network | Base |
| Chain ID | `8453` |
| Vault | `0x050cE30b927Da55177A4914EC73480238BAD56f0` |
| Name | Gauntlet USDC Prime |
| Version | `2.0` |
| Factory | `0x4501125508079A99ebBebCE205DeC9593C2b5857` |
| Creation block | `37179342` |
| Asset | USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) |
| Asset decimals | `6` |
| Owner | `0x5a4E19842e09000a582c20A4f524C26Fb48Dd4D0` |
| Curator | `0x9E33faAE38ff641094fa68c65c2cE600b3410585` |
| Liquidity adapter | `0x2fEcd40f436CA170D2478a58Da898FcE93988eef` |
| Adapter registry | `0x5C2531Cbd2cf112Cf687da3Cd536708aDd7DB10a` |
| Current management fee | `0` |
| Management-fee timelock | `259200` seconds (3 days) |

## Checks completed

- Morpho REST identifies the deployment as Vault V2 and returns the factory and creation block.
- An authenticated KeeperHub read of `factory.isVaultV2(vault)` returned `true`.
- Base Blockscout reports verified Solidity source compiled with `0.8.28`, Cancun EVM, with
  `lib/vault-v2/src/VaultV2.sol` as the contract path.
- All four vault gates are unset according to the Morpho API.
- The Morpho API reports one Morpho Market V1 V2 adapter.
- At the pinned API block, the withdrawal-options endpoint reported:
  - idle assets: `0`;
  - liquidity-adapter available assets: `155481498893061` USDC base units;
  - force-deallocatable assets: `4683201589655` USDC base units;
  - force-deallocation penalty: `10000000000000` WAD.
- The current `pendingConfigs` query returned an empty list. No live fee proposal exists to trigger
  an exit at the time of this check.

## Why this vault was selected

Several higher-TVL Vault V2 deployments expose a zero timelock for `setManagementFee`, which gives
VETO no waiting window. This vault uses standard Base USDC and a three-day management-fee timelock.
Both Base mainnet and Base Sepolia are currently enabled by KeeperHub.

## Remaining work before PASS

1. Pin and compare the exact verified deployed source against the selected upstream release.
2. Build the candidate guard and simulate its exact call against this deployment at a pinned block.
3. Prove owner-only receipt, finite share allowance, minimum-assets enforcement, and revoked-proposal
   failure.
4. Capture a real pending `setManagementFee` proposal or label the public portion as a replay/fork.

## Sources

- Morpho GraphQL and REST APIs
- Base JSON-RPC
- Base Blockscout verified-contract API
- KeeperHub direct contract-call API
