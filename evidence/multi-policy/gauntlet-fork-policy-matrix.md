# Gauntlet Fork Policy Compatibility Matrix

This document provides the canonical verification matrix for VETO's 5 supported policy families against live Base mainnet Morpho Vault V2 contracts, specifically evaluating the production **Gauntlet USDC Prime** vault (`0x050cE30b927Da55177A4914EC73480238BAD56f0`) pinned at block `51221130` and observed at block `51460446`.

---

## 1. Executive Summary

VETO provides programmable depositor governance protection across five Morpho Vault V2 policy families. On live production Morpho vaults, vault curators configure timelocks and abdication states per selector to balance flexibility and security.

- **4 of 5 policy families** are active governance surfaces on Gauntlet USDC Prime (retaining active timelocks without abdication).
- **1 policy family** (Redemption Gates) has been permanently abdicated on Gauntlet USDC Prime to guarantee un-gated depositor redemptions; VETO verifies this policy family against full-specification Morpho Vault V2 fixtures.

---

## 2. Pinned Fork & Live Chain Parameters

| Parameter | Value | Reference |
| :--- | :--- | :--- |
| **Network** | Base Mainnet (`chainId: 8453`) | `viem/chains: base` |
| **Pinned Fork Block** | `51,221,130` | `apps/worker/test/scanner-integration.test.ts` |
| **Observed Chain Block** | `51,460,446` | `evidence/multi-policy/live-policy-surface.json` |
| **Target Vault** | `0x050cE30b927Da55177A4914EC73480238BAD56f0` | Gauntlet USDC Prime (`gtusdcp`) |
| **Underlying Asset** | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | USDC (6 decimals) |
| **Morpho V2 Factory** | `0x4501125508079A99ebBebCE205DeC9593C2b5857` | Canonical Base Factory (`isVaultV2 == true`) |
| **Vault Curator** | `0x9E33faAE38ff641094fa68c65c2cE600b3410585` | Gauntlet Governance |
| **Vault Owner** | `0x5a4E19842e09000a582c20A4f524C26Fb48Dd4D0` | Gauntlet Multisig |
| **Fee Recipient** | `0x34702F5F789196A723B8DF6334922f145A7db1b2` | Gauntlet Fee Collector |

---

## 3. Five-Policy Verification Matrix

| # | Policy Family | Method & Selector | Timelock (Live/Fork) | Abdicated? | Governance Status on Gauntlet | Verification Method & Test File |
|---|:---|:---|:---|:---|:---|:---|
| **1** | **Management Fee Ceiling** | `setManagementFee(uint256)`<br>`0xfe56e232` | 259,200s (3 days) | `false` | **Active Surface**<br>Curator can propose fee changes up to protocol max | **Exact Fork Proof**<br>`apps/worker/test/scanner-integration.test.ts`<br>`apps/worker/test/performance-fee-pipeline.test.ts` (Finding 5 test) |
| **2** | **Performance Fee Ceiling** | `setPerformanceFee(uint256)`<br>`0x70897b23` | 259,200s (3 days) | `false` | **Active Surface**<br>Curator can propose performance fee up to 50% WAD | **Dual Proof (Fork Query + E2E Pipeline)**<br>Fork surface verified + `apps/worker/test/performance-fee-pipeline.test.ts` |
| **3** | **Relative Cap Ceiling** | `increaseRelativeCap(bytes,uint256)`<br>`0x2438525b` | 259,200s (3 days) | `false` | **Active Surface**<br>Curator reallocates market weights via timelock | **Dual Proof (Fork Query + E2E Pipeline)**<br>Fork surface verified + `apps/worker/test/relative-cap-pipeline.test.ts` |
| **4** | **Adapter Allowlist** | `addAdapter(address)`<br>`0x60d54d41` | 604,800s (7 days) | `false` | **Active Surface**<br>Curator can introduce new protocol adapters via timelock | **Dual Proof (Fork Query + E2E Pipeline)**<br>Fork surface verified + `apps/worker/test/adapter-allowlist-pipeline.test.ts` |
| **5** | **Redemption Gate Allowlist** | `setSendSharesGate(address)` (`0xc21ad028`)<br>`setReceiveAssetsGate(address)` (`0x04dbf0ce`) | 604,800s (7 days) | `true` | **Permanently Abdicated**<br>Curator voluntarily gave up gate authority | **Controlled Test Deployment / Fixture Proof**<br>`apps/worker/test/redemption-gate-pipeline.test.ts` |

---

## 4. Technical Analysis by Policy

### Policy 1: Management Fee Ceiling
- **Function Signature:** `setManagementFee(uint256 newFee)`
- **Live State:** Rate per second currently `0` (annualized `0.00%`). Fee recipient is set to `0x34702F5F789196A723B8DF6334922f145A7db1b2`.
- **Live Timelock:** 259,200 seconds (72 hours).
- **VETO Guard Enforcement:** Reverts on execution if proposal exceeds owner's configured per-second rate cap or if protocol max is exceeded.
- **Proof Mechanism:** Anvil fork test simulates curator `0x9E33faAE38ff641094fa68c65c2cE600b3410585` submitting a 5% annualized proposal. VETO worker scanner parses Morpho events, evaluates against owner mandate, and enqueues a `READY` exit intent. Finding 5 test confirms that if bit 0 is disabled on a V2 mandate, the scanner records `policy-disabled` with 0 ready intents.

### Policy 2: Performance Fee Ceiling
- **Function Signature:** `setPerformanceFee(uint256 newFee)`
- **Live State:** Current performance fee is `0`. Fee recipient is `0x34702F5F789196A723B8DF6334922f145A7db1b2`.
- **Live Timelock:** 259,200 seconds (72 hours).
- **VETO Guard Enforcement:** Reverts on execution if proposed performance fee exceeds owner's WAD threshold (up to 50% WAD protocol limit).
- **Proof Mechanism:** `performance-fee-pipeline.test.ts` validates non-breaching proposal recording (no intent), breaching proposal intent creation, and zero-broadcast under KeeperHub conditional failure.

### Policy 3: Relative Cap Ceiling
- **Function Signature:** `increaseRelativeCap(bytes id, uint256 newCap)`
- **Live State:** Active timelocked governance function for market allocation adjustments.
- **Live Timelock:** 259,200 seconds (72 hours).
- **VETO Guard Enforcement:** Onchain guard reads `hasRelativeCapByMandateRisk(mandateId, riskId)` and `maxRelativeCapByMandateRisk(mandateId, riskId)`. Only explicitly configured risk IDs whose proposed cap exceeds the configured ceiling breach policy and permit emergency exit; unconfigured risk IDs do NOT trigger an exit (`CapDoesNotBreachLimit`).
- **Proof Mechanism:** `relative-cap-pipeline.test.ts` proves exact decoding of arbitrary bytes/bytes32 market risk identifiers and conditional KeeperHub exit triggering upon cap breach.

### Policy 4: Adapter Allowlist
- **Function Signature:** `addAdapter(address adapter)`
- **Live State:** Active timelocked function. Current live adapter is `0x2fEcd40f436CA170D2478a58Da898FcE93988eef`.
- **Live Timelock:** 604,800 seconds (7 days / 168 hours).
- **VETO Guard Enforcement:** Onchain guard queries `approvedAdapterByMandate(mandateId, adapter)`. Unapproved adapter proposals immediately breach policy.
- **Proof Mechanism:** `adapter-allowlist-pipeline.test.ts` verifies that proposals adding unapproved adapters trigger VETO exit intents while approved adapters generate `adapter-allowlisted` records without triggering an exit.

### Policy 5: Redemption Gate Allowlist
- **Function Signatures:** `setSendSharesGate(address)` / `setReceiveAssetsGate(address)`
- **Live State on Gauntlet USDC Prime:** `abdicated == true`. Both send and receive gates are permanently set to `address(0)`.
- **Protocol Rationale for Abdication:** To offer strong depositor guarantees, institutional curators like Gauntlet often permanently abdicate redemption gate setters (`abdicated(selector) == true`). This guarantees depositors that their shares cannot be gated or locked at the protocol level by curator intervention.
- **Why Fixture Proof is Required:** Because the live contract has abdicated the selector, any attempt by governance to call `submit(setSendSharesGate(...))` on the production vault reverts at the contract level (`AlreadyAbdicated()`). Therefore, simulating gate breach attacks must be conducted on canonical Morpho Vault V2 instances where gate setters are intact.
- **Proof Mechanism:** `redemption-gate-pipeline.test.ts` deploys a canonical Morpho Vault V2 instance, configures separate send-shares and receive-assets gate allowlists in a VETO V2 mandate, and verifies end-to-end detection and exit generation when an unauthorized gate address is proposed.
