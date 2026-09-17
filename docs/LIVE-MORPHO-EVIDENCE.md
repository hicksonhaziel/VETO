# VETO × Live Morpho Vault V2

> **Judge Executive Summary:**
> VETO is designed to protect depositors in Morpho Vault V2 from unauthorized protocol changes (such as predatory management fee increases). This document provides immutable, reproducible evidence that VETO works with **real Morpho Vault V2 code**, **real onchain factory provenance**, and **real live depositor balances**, while cleanly distinguishing what is executed on Base Mainnet, what is proven on a pinned Base fork, and what is executed publicly on Base Sepolia.

---

## 1. The Three Evidence Layers

To maintain rigorous transparency, VETO separates its evidence into three distinct layers. We never blur testnet simulations with mainnet reality:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ LAYER A: LIVE BASE MAINNET READ                                             │
│ Target: Gauntlet USDC Prime (0x050cE30b927Da55177A4914EC73480238BAD56f0)   │
│ Proves: Official factory provenance (isVaultV2 = true), active >$170M TVL,  │
│         3-day timelock window (259,200s), unobstructed gate configuration.  │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       │ exact production state & bytecode
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ LAYER B: PINNED BASE MAINNET FORK                                           │
│ Target: Anvil fork of Base Block 51,221,130                                 │
│ Proves: Full atomic VetoExitGuard redemption against a REAL $3.07M depositor│
│         position, returning 100% of underlying USDC with zero relayer       │
│         custody, deterministic TOCTOU resistance, and replay protection.    │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│ LAYER C: PUBLIC BASE SEPOLIA KEEPERHUB EXECUTION                            │
│ Target: Public Base Sepolia testnet with unmodified Morpho V2 bytecode      │
│ Proves: End-to-end autonomous execution: KeeperHub check-and-execute read,  │
│         conditional evaluation, mempool submission, and durable worker      │
│         reconciliation into PostgreSQL.                                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Visual Architecture & Execution Connection

```
                      LIVE MORPHO
                  Gauntlet USDC Prime
                     Base Mainnet
                          │
                          │ Exact production deployment,
                          │ liquidity state, and depositor shares
                          ▼
                 PINNED MAINNET FORK
             (Base Block 51,221,130)
          ─────────────────────────────
          Real Depositor: 0xa089...c1d2
          Real Position:  $3.07M USDC
          Atomic Guard:   VetoExitGuard
          Result:         Full exit proven
                          TOCTOU proven

                      │
                      │ Same VetoExitGuard architecture &
                      │ identical Morpho V2 Vault interfaces
                      ▼

               PUBLIC KEEPERHUB RUN
             (Base Sepolia Testnet)
          ─────────────────────────────
          Unmodified Morpho V2 Bytecode
          KeeperHub Conditional Read
          PostgreSQL Durable Pipeline
          Result: Full autonomous path
                  proven in public
```

---

## 3. Layer A: Live Base Mainnet Read

VETO inspects the live production deployment of Morpho Vault V2 on Base Mainnet.

### Target Deployment: Gauntlet USDC Prime

- **Contract Address:** [`0x050cE30b927Da55177A4914EC73480238BAD56f0`](https://basescan.org/address/0x050cE30b927Da55177A4914EC73480238BAD56f0)
- **Morpho Vault V2 Factory:** [`0x4501125508079A99ebBebCE205DeC9593C2b5857`](https://basescan.org/address/0x4501125508079A99ebBebCE205DeC9593C2b5857)
- **Underlying Asset:** Native Base USDC ([`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`](https://basescan.org/token/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913))
- **Creation Block:** `37179342`
- **Creation Tx:** [`0xd28de3cf1256f906214e7cc1fc3070d8f04a30edebcfae7fc554e169da89fb26`](https://basescan.org/tx/0xd28de3cf1256f906214e7cc1fc3070d8f04a30edebcfae7fc554e169da89fb26)
- **Curator:** Gauntlet (`0x9E33faAE38ff641094fa68c65c2cE600b3410585`)
- **Owner:** `0x5a4E19842e09000a582c20A4f524C26Fb48Dd4D0`

### Reproducible Live Query Command

Anyone can reproduce this read-only live query in seconds:

```bash
pnpm live:morpho
```

_(Script location: `contracts/scripts/live-morpho-read.mjs`)_

### Live Onchain Truth (Verified via `pnpm live:morpho`)

| Field                           | Onchain Value                    | Significance to VETO                                                                                                                                                                                                                                                                                                                |
| :------------------------------ | :------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`factory.isVaultV2(vault)`**  | `true`                           | The referenced Base Morpho Vault V2 factory returns `isVaultV2(vault) == true`.                                                                                                                                                                                                                                                     |
| **Total Assets / TVL**          | **$171,843,621.78 USDC**         | Total assets actively accounted for in Morpho V2. _(Note: Total assets is not synonymous with immediately available idle redemption liquidity; redemptions depend on market liquidity)._                                                                                                                                            |
| **Management Fee**              | `0.0000%`                        | Current active fee is 0 bps.                                                                                                                                                                                                                                                                                                        |
| **Fee Timelock (`0xfe56e232`)** | **`259,200` seconds (3.0 days)** | A newly submitted `setManagementFee` action is scheduled 259,200 seconds (3 days) after submission, providing a protocol reaction window before that change becomes executable. Successful exit still depends on the depositor's mandate and available redemption liquidity.                                                        |
| **Fee Abdication**              | `false`                          | `setManagementFee` is not abdicated, so the curator retains authority to submit future management-fee changes.                                                                                                                                                                                                                      |
| **Withdrawal Gate Assessment**  | `address(0)` (Ungated)           | Morpho Vault V2 `redeem`/`withdraw` checks `canSendShares` (`sendSharesGate`) and `canReceiveAssets` (`receiveAssetsGate`). Both are unset (`address(0)`), confirming no gate contracts restrict redemptions. An unset gate removes that specific gate restriction; it does not by itself guarantee available redemption liquidity. |

---

## 4. Factory and Source Provenance Verification

VETO guarantees exact compatibility with canonical Morpho Vault V2 smart contracts:

1. **Factory Runtime Verification:**
   - Compiled from Morpho upstream release `2025-09-15`, Git commit [`6f2af6602e05d9e123a87c1067712a4566608044`](https://github.com/morpho-org/vault-v2/commit/6f2af6602e05d9e123a87c1067712a4566608044).
   - Compiler: Solidity `0.8.28`, `cancun` EVM, `viaIR: true`, `optimizerRuns: 100,000`.
   - The compiled factory runtime SHA-256 is:
     `cf0f79d0fb41a563e915b81cefb581f74acb46336cee022c1991671d9e575d8e`
   - This **exactly matches** the deployed factory on Base at `0x4501125508079A99ebBebCE205DeC9593C2b5857`.

2. **Vault Runtime Verification:**
   - The deployed bytecode of Gauntlet USDC Prime matches the canonical Morpho `VaultV2.sol` template when constructor-bound immutable offsets (`asset`, `factory`) are normalized.
   - All source files are pinned with sha256 checksums in [`contracts/scripts/compile-official-morpho-v2.mjs`](../contracts/scripts/compile-official-morpho-v2.mjs).

---

## 5. Layer B: Pinned Base Mainnet Fork Audit

To prove that VETO works against real depositors and live market liquidity, VETO executes an automated fork test against pinned Base block `51,221,130`.

### Separation of Real State vs. Fork Controls

| Component                 | State Source     | Description                                                           |
| :------------------------ | :--------------- | :-------------------------------------------------------------------- |
| **Vault Contract**        | **REAL MAINNET** | Actual code and state of Gauntlet USDC Prime at block 51,221,130.     |
| **Factory Contract**      | **REAL MAINNET** | Actual canonical factory at `0x4501...5857`.                          |
| **Underlying Asset**      | **REAL MAINNET** | Native Base USDC contract and reserve balances.                       |
| **Depositor Address**     | **REAL MAINNET** | Real depositor: `0xA0894A415c4F246CE95BaE718849579c099Cc1d2`.         |
| **Depositor Shares**      | **REAL MAINNET** | Real balance of `2,956,324.55` vault shares (~$3.07M USDC).           |
| **Market Liquidity**      | **REAL MAINNET** | Morpho V1 market allocations and available redemption liquidity.      |
| **Curator Impersonation** | FORK CONTROL     | Fork simulation impersonates curator to queue a test 2% fee proposal. |
| **Mandate Arming**        | FORK CONTROL     | Fork simulation impersonates depositor to authorize `VetoExitGuard`.  |
| **Guard Deployment**      | FORK CONTROL     | Deployer deploys `VetoExitGuard(factory)` onto the fork.              |
| **Relayer Trigger**       | FORK CONTROL     | Relayer triggers execution via the guard.                             |

> [!IMPORTANT]
> **We do NOT claim:** _"VETO exited a depositor on Base Mainnet."_
> **We truthfully state:** _"VETO executed against a pinned fork containing exact live vault state and a real $3.07M depositor balance."_

### Pinned Fork Compatibility Results

Automated execution in [`contracts/test/base-fork.test.mjs`](../contracts/test/base-fork.test.mjs):

```
Block:              51,221,130
Depositor:          0xA0894A415c4F246CE95BaE718849579c099Cc1d2
Shares Before:      2,956,324,556,913,592,348,497,355
Shares After:       0 (100% position exited)
Assets Returned:    +3,077,821,288,866 ($3,077,821.28 USDC)
Owner Received:     YES (Directly transferred to depositor)
Relayer Balance:    0 (Zero custody; relayer cannot steal funds)
Guard Balance:      0 (Zero retained value)
Mandate Consumed:   YES (active = false; cannot be replayed)
```

### TOCTOU Safety Verified on Real Vault State

In the same fork test, the curator queues a fee proposal, the guard checks pass, and then the curator **revokes** the proposal before execution:

- The subsequent guard execution **atomically reverts** (`ProposalIsNotExecutable`).
- **Zero shares** are redeemed.
- **Zero assets** are moved.
- The depositor's mandate remains untouched (`active = true`).
  This proves that offchain prechecks cannot be tricked by frontrunning or rapid proposal revocation on real Morpho Vault V2 code.

---

## 6. Layer C: Public Base Sepolia KeeperHub Execution

While the pinned fork proves compatibility with live mainnet positions, the Base Sepolia testnet deployment proves the **complete autonomous infrastructure**:

- **Execution Infrastructure:** Autonomous relayer using KeeperHub's official `check-and-execute` conditional API.
- **Worker & Database:** Durable PostgreSQL pipeline tracking transitions from `READY` to `EXITED`.
- **Public Evidence:**
  - Public Vault (unmodified Morpho V2 bytecode): [`0x9019B1e26795E90825c567aD08c945C603e7F9B9`](https://base-sepolia.blockscout.com/address/0x9019B1e26795E90825c567aD08c945C603e7F9B9)
  - Successful Exit Tx: [`0x24bafbb926788884dee9160f4ad723a107b3159e4f5ea03b5b78cf07045c3d6e`](https://base-sepolia.blockscout.com/tx/0x24bafbb926788884dee9160f4ad723a107b3159e4f5ea03b5b78cf07045c3d6e)
  - Curator Revocation Tx: [`0x60e539ddf306f6803ec9dd6b76c8745e7f77dc20661d2359a73df5f6967f15e5`](https://base-sepolia.blockscout.com/tx/0x60e539ddf306f6803ec9dd6b76c8745e7f77dc20661d2359a73df5f6967f15e5)
  - KeeperHub Conditional False Outcome: `executed: false`; zero financial transaction broadcast (read `executableAt = 0`, evaluated `0 == 1789551002` -> `false`). Mandate active, position untouched.

---

## 7. What Is Proven vs. What Remains Unproven

| Claim                                 | Status                       | Evidence                                                                                               |
| :------------------------------------ | :--------------------------- | :----------------------------------------------------------------------------------------------------- |
| **Morpho Vault V2 Compatibility**     | **PROVEN**                   | Proven against Gauntlet USDC Prime on pinned Base fork (`base-fork.test.mjs`).                         |
| **Factory Provenance Verification**   | **PROVEN**                   | Onchain check `factory.isVaultV2 == true` verified on Base mainnet block 51,448,773.                   |
| **Real Depositor Position Exit**      | **PROVEN (FORK)**            | Redeemed $3.07M USDC for depositor `0xA089...` on pinned fork.                                         |
| **KeeperHub Conditional Integration** | **PROVEN (PUBLIC)**          | KeeperHub `check-and-execute` verified on Base Sepolia (`35o448zta7uy9dun9j6py`).                      |
| **Atomic TOCTOU Protection**          | **PROVEN (FORK & TESTNET)**  | Revoked proposals atomically fail guard execution without fund movement.                               |
| **Automatic Mainnet Execution**       | **UNPROVEN / NOT ATTEMPTED** | VETO has **not** broadcast transactions on Base Mainnet. Depositors must explicitly register mandates. |
