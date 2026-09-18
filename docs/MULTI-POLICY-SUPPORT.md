# Morpho Vault V2 Multi-Policy Support & Surface Matrix

VETO provides depositors of Morpho Vault V2 pre-authorized exit rules enforced by `VetoExitGuardV2`.
This document outlines the policy definitions, onchain enforcement mechanisms, testing proofs, and live compatibility against the canonical production deployment on Base (**Gauntlet USDC Prime**: `0x050cE30b927Da55177A4914EC73480238BAD56f0`).

---

## 1. Supported Policies Overview

| Policy # | Policy Name               | Selector                     | Signature                                                       | Onchain Flag  | Breach Condition                                                |
| :------- | :------------------------ | :--------------------------- | :-------------------------------------------------------------- | :------------ | :-------------------------------------------------------------- |
| **1**    | Management Fee Ceiling    | `0xfe56e232`                 | `setManagementFee(uint256)`                                     | `1 << 0` (1)  | `proposedFee > owner.maxManagementFee`                          |
| **2**    | Performance Fee Ceiling   | `0x70897b23`                 | `setPerformanceFee(uint256)`                                    | `1 << 1` (2)  | `proposedFee > owner.maxPerformanceFee`                         |
| **3**    | Relative Cap Ceiling      | `0x2438525b`                 | `increaseRelativeCap(bytes,uint256)`                            | `1 << 2` (4)  | `newCap > owner.maxRelativeCap[keccak256(idData)]`              |
| **4**    | Adapter Allowlist         | `0x60d54d41`                 | `addAdapter(address)`                                           | `1 << 3` (8)  | `!approvedAdapterByMandate[mandateId][adapter]`                 |
| **5**    | Redemption Gate Allowlist | `0xc21ad028`<br>`0x04dbf0ce` | `setSendSharesGate(address)`<br>`setReceiveAssetsGate(address)` | `1 << 4` (16) | `newGate != address(0)` AND `!approvedGate[mandateId][newGate]` |

---

## 2. Policy Definitions & Exact Semantics

### Policy 1: Management-Fee Ceiling

- **Function**: `setManagementFee(uint256 newFee)`
- **Interpretation**: Fee on vault principal accrued per second.
- **Protocol Limit**: Upper bound enforced by Morpho at 5.0% annualized (`0.05e18 / 365 days`).
- **Trigger**: Proposing an annualized rate greater than the depositor's ceiling.

### Policy 2: Performance-Fee Ceiling

- **Function**: `setPerformanceFee(uint256 newFee)`
- **Interpretation**: Fee on vault earned interest/yield. Represented as a direct WAD fraction (`1e18 = 100%`).
- **Protocol Limit**: Upper bound enforced by Morpho at 50% (`0.5e18`).
- **Trigger**: Proposing a performance fee greater than the depositor's ceiling.

### Policy 3: Relative-Cap Ceiling

- **Function**: `increaseRelativeCap(bytes idData, uint256 newRelativeCap)`
- **Interpretation**: Constrains the maximum permitted allocation fraction for an allocator or market risk ID (`riskId = keccak256(idData)`).
- **Semantics**: An increased cap permits higher future allocation; it does _not_ assert capital has already moved.
- **Derisking Exemption**: `decreaseRelativeCap(bytes,uint256)` (`0x57975270`) lowers allowed risk and never triggers an exit.
- **Trigger**: Proposing an allocation cap above the owner's configured ceiling for a monitored risk ID.

### Policy 4: Adapter Allowlist

- **Function**: `addAdapter(address adapter)`
- **Interpretation**: Registers a new liquidity or yield adapter as callable by vault allocators.
- **Semantics**: Adding an adapter makes it available; it does _not_ imply assets are already allocated.
- **Trigger**: Proposing an adapter address that is not present in the depositor's explicit allowlist.

### Policy 5: Redemption-Gate Allowlist

- **Functions**:
  - `setSendSharesGate(address newGate)` (checks `canSendShares(owner)`)
  - `setReceiveAssetsGate(address newGate)` (checks `canReceiveAssets(receiver)`)
- **Interpretation**: Constrains the transferability of shares and redeemability of underlying assets.
- **Derisking Exemption**: Proposing `address(0)` un-gates the vault and is always deemed approved.
- **Trigger**: Proposing any non-zero gate contract that has not been explicitly pre-approved by the depositor.

---

## 3. Live Gauntlet USDC Prime Policy Surface Matrix

Direct onchain query against `0x050cE30b927Da55177A4914EC73480238BAD56f0` (recorded in `evidence/multi-policy/live-policy-surface.json`):

| Selector     | Function               | Live Timelock     | Abdicated        | Mainnet Status on Gauntlet Vault            |
| :----------- | :--------------------- | :---------------- | :--------------- | :------------------------------------------ |
| `0xfe56e232` | `setManagementFee`     | 259,200s (3 days) | No (`false`)     | **Active Reaction Window** (VETO Supported) |
| `0x70897b23` | `setPerformanceFee`    | 259,200s (3 days) | No (`false`)     | **Active Reaction Window** (VETO Supported) |
| `0x2438525b` | `increaseRelativeCap`  | 259,200s (3 days) | No (`false`)     | **Active Reaction Window** (VETO Supported) |
| `0x60d54d41` | `addAdapter`           | 604,800s (7 days) | No (`false`)     | **Active Reaction Window** (VETO Supported) |
| `0xc21ad028` | `setSendSharesGate`    | 604,800s (7 days) | **Yes (`true`)** | **Permanently Abdicated by Curator**        |
| `0x04dbf0ce` | `setReceiveAssetsGate` | 604,800s (7 days) | **Yes (`true`)** | **Permanently Abdicated by Curator**        |

> [!NOTE]
> **Why Official Fixtures Were Required for Gate Policies**:
> The Gauntlet USDC Prime curator permanently abdicated `setSendSharesGate` and `setReceiveAssetsGate`. Consequently, `vault.abdicated(selector)` returns `true` on mainnet, correctly causing `VetoExitGuardV2` to revert on gate calls for that specific vault. VETO implements the redemption-gate allowlist generally, proven via official-source Morpho Vault V2 fixtures.

---

## 4. Policy Test Matrix

| Policy                | Decoder Unit | Non-Breach Unit | Breach Unit | Revocation / TOCTOU | Scanner Unit | Worker Pipeline | Multi-Policy Combined |
| :-------------------- | :----------: | :-------------: | :---------: | :-----------------: | :----------: | :-------------: | :-------------------: |
| **Management Fee**    |     PASS     |      PASS       |    PASS     |        PASS         |     PASS     |      PASS       |         PASS          |
| **Performance Fee**   |     PASS     |      PASS       |    PASS     |        PASS         |     PASS     |      PASS       |         PASS          |
| **Relative Cap**      |     PASS     |      PASS       |    PASS     |        PASS         |     PASS     |      PASS       |         PASS          |
| **Adapter Allowlist** |     PASS     |      PASS       |    PASS     |        PASS         |     PASS     |      PASS       |         PASS          |
| **Redemption Gate**   |     PASS     |      PASS       |    PASS     |        PASS         |     PASS     |      PASS       |         PASS          |
