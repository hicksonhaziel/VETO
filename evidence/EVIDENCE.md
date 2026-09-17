# VETO Canonical Evidence Index

> **Quick Evaluation Guide for Hackathon Judges**
> This index summarizes VETO's primary proofs of correctness across **autonomous public execution**, **real Morpho Vault V2 compatibility**, **cryptographic TOCTOU safety**, and **durable financial lifecycle handling**.
> Every claim is backed by an onchain transaction, pinned fork test, or live query script in this repository.

---

## Architecture & Proof Separation

```
LIVE MORPHO
Gauntlet USDC Prime
Base Mainnet (0x050c...56f0)
        │
        │ exact production deployment & state
        ▼
PINNED MAINNET FORK
(Base Block 51,221,130)
VETO compatibility proven against real $3.07M depositor

PUBLIC EXECUTION
VETO-controlled Base Sepolia
unmodified official Morpho V2 code
        │
        ▼
KeeperHub read (executableAt)
        │
        ▼
KeeperHub conditional (check-and-execute)
        │
        ▼
VetoExitGuard
        │
        ▼
Morpho redeem
        │
        ▼
owner (zero custody)
```

---

## A. Public Successful Exit (Base Sepolia)

Full end-to-end autonomous exit executed through KeeperHub's official `check-and-execute` conditional endpoint and reconciled into PostgreSQL.

| Metric | Onchain Fact |
| :--- | :--- |
| **Network** | Base Sepolia (`chainId: 84532`) |
| **KeeperHub Execution ID** | `35o448zta7uy9dun9j6py` |
| **Exit Transaction Hash** | [`0x24bafbb926788884dee9160f4ad723a107b3159e4f5ea03b5b78cf07045c3d6e`](https://base-sepolia.blockscout.com/tx/0x24bafbb926788884dee9160f4ad723a107b3159e4f5ea03b5b78cf07045c3d6e) |
| **Block Number** | `46889242` |
| **Morpho Vault V2 Address** | [`0x9019B1e26795E90825c567aD08c945C603e7F9B9`](https://base-sepolia.blockscout.com/address/0x9019B1e26795E90825c567aD08c945C603e7F9B9) |
| **VetoExitGuard Address** | [`0xF23824d2ce4e43fA1073896D1F2E898fE47BBE0F`](https://base-sepolia.blockscout.com/address/0xF23824d2ce4e43fA1073896D1F2E898fE47BBE0F) |
| **Owner Address** | `0x3E7A055F59c662987Ae68240Fd713195C30C0497` |
| **Queued Protocol Change** | `setManagementFee` proposal to 2.0% annualized |
| **Mandate ID** | `2` (Depositor set fee ceiling at 1.0% annualized) |
| **Pre / Post Shares** | `10,000,000,000,000,000,000` (10 shares) ➔ `0` |
| **Owner Assets Returned** | `0` ➔ `10,000,000` (+10.000000 fixture USD) |
| **Relayer Asset Balance** | `0` (Zero custody; funds delivered directly to owner) |
| **Guard Asset Balance** | `0` (Zero retained funds) |
| **Mandate State** | `active = false` (Consumed; single-use guarantee) |
| **Worker State** | `EXITED` (Confirmed via onchain `Exited` log reconciliation) |
| **Raw Execution Data** | [`evidence/day-8/conditional-success.json`](day-8/conditional-success.json) |

---

## B. Public Conditional Block (Base Sepolia)

Proves that when a proposal is revoked before execution, KeeperHub's conditional preflight evaluates `false`, safely blocking execution without broadcasting a financial transaction.

| Metric | Onchain Fact |
| :--- | :--- |
| **Network** | Base Sepolia (`chainId: 84532`) |
| **Expected `executableAt`** | `1789551002` (Persisted target timestamp) |
| **Observed `executableAt`** | `0` (Proposal was revoked onchain by curator) |
| **Curator Revocation Tx** | [`0x60e539ddf306f6803ec9dd6b76c8745e7f77dc20661d2359a73df5f6967f15e5`](https://base-sepolia.blockscout.com/tx/0x60e539ddf306f6803ec9dd6b76c8745e7f77dc20661d2359a73df5f6967f15e5) |
| **Conditional Precheck** | `0 == 1789551002` evaluates to `false` |
| **KeeperHub Action** | Execution withheld; `executed: false`; zero transaction broadcast |
| **Depositor Position** | 100% untouched; zero shares or assets moved |
| **Mandate State** | `active = true` (Remains armed and ready for future proposals) |
| **Worker State** | `BLOCKED / PROPOSAL_NOT_PENDING_AT_EXECUTION` |
| **Raw Execution Data** | [`evidence/day-8/conditional-false.json`](day-8/conditional-false.json) |

---

## C. TOCTOU Safety (Time-of-Check to Time-of-Use)

> [!NOTE]
> **Source:** Pinned Base Mainnet fork test ([`contracts/test/base-fork.test.mjs`](../contracts/test/base-fork.test.mjs)).

Offchain or relayer preflight checks are necessary for gas efficiency, but **they cannot guarantee safety against onchain race conditions**. If a curator revokes a proposal in the same block or between check and execution:

1. **The Scenario:** Relayer simulates execution successfully at $T_1$. Before the transaction is mined, the curator calls `revoke(proposal)` at $T_2$.
2. **The Guard Guarantee:** `VetoExitGuard.execute` performs an atomic, in-line check:
   ```solidity
   if (IVaultV2(vault).executableAt(proposalData) != expectedExecutableAt)
       revert ProposalIsNotExecutable();
   ```
3. **The Proof:** On real Morpho Vault V2 code, the transaction **atomically reverts**. Zero shares are redeemed, zero assets are transferred, and the mandate remains untouched.

---

## D. Live Morpho Vault V2 Compatibility

Proves compatibility with the actual production Gauntlet USDC Prime vault deployed on Base Mainnet.

| Metric | Mainnet Onchain Fact |
| :--- | :--- |
| **Target Vault** | Gauntlet USDC Prime ([`0x050cE30b927Da55177A4914EC73480238BAD56f0`](https://basescan.org/address/0x050cE30b927Da55177A4914EC73480238BAD56f0)) |
| **Factory Address** | [`0x4501125508079A99ebBebCE205DeC9593C2b5857`](https://basescan.org/address/0x4501125508079A99ebBebCE205DeC9593C2b5857) |
| **Factory Recognition** | The referenced Base Morpho Vault V2 factory returns `isVaultV2(vault) == true` |
| **Total Assets / TVL** | **$171,843,621.78 USDC** *(Note: Total assets in vault; redemptions depend on market liquidity)* |
| **Management Fee Timelock** | **259,200 seconds (3.0 days)** scheduled reaction window before fee change becomes executable |
| **Redemption Gate Assessment** | Ungated for redemption (`sendSharesGate = 0x0`, `receiveAssetsGate = 0x0`) |
| **Recent Submissions Window** | Checked recent 2,000 blocks: zero `setManagementFee` submit events emitted in window |
| **Live Read Evidence** | [`evidence/live-morpho/live-read-gauntlet-usdc-prime.json`](live-morpho/live-read-gauntlet-usdc-prime.json) |
| **Live Read Command** | `pnpm live:morpho` |
| **Pinned Fork Test** | Pinned Base Block `51,221,130` (`contracts/test/base-fork.test.mjs`) |
| **Real Depositor Position** | Depositor `0xA0894A415c4F246CE95BaE718849579c099Cc1d2` holding `2,956,324.55` shares (~$3.07M USDC) |
| **Fork Execution Outcome** | Full redemption: $3,077,821.28 USDC returned to depositor with zero relayer custody |

For the complete breakdown of real mainnet state vs. fork simulation controls, see [`docs/LIVE-MORPHO-EVIDENCE.md`](../docs/LIVE-MORPHO-EVIDENCE.md).

---

## E. Lifecycle & Reconciler Correctness

VETO enforces rigorous safety invariants across asynchronous relayer and chain environments:

1. **Multi-Proposal Support Under Single Mandate:**
   A mandate is decoupled from specific proposal hashes. If Proposal A resolves to `BLOCKED`, the depositor's mandate remains armed; when a subsequent Proposal B appears, a new attempt record is created and executed.
2. **Proposal Serialization:**
   `PostgresIntentStore.claimNext` uses PostgreSQL `FOR UPDATE SKIP LOCKED` with a `NOT EXISTS` constraint ensuring that **only one unresolved attempt** may be active under a mandate at any time.
3. **Chain Authoritative Truth:**
   Platform reporting never overrides EVM state. If KeeperHub reports `failed` but a transaction was mined with an `Exited` event, VETO records `EXITED` and logs the platform disagreement as evidence.
4. **Bounded Recovery to `DISPUTED`:**
   When KeeperHub reports `failed` without a transaction hash, VETO enters `RECONCILING` with a durable grace window (default 60s). If the window expires without an onchain event or hash, the attempt settles to `DISPUTED` (`BROADCAST_OUTCOME_UNPROVEN`), never falsely asserting `economicEffect: none`.
5. **Operator Quarantine of `DISPUTED`:**
   Normal workers do not auto-claim `DISPUTED` intents, preventing auto-churning. Subsequent proposals under the same mandate remain strictly blocked until manual operator resolution.

### Verified Test Metrics

Run full monorepo tests with disposable PostgreSQL:
```bash
TEST_DATABASE_URL=postgresql://user:password@127.0.0.1:5432/veto_test pnpm test
```
- **Contracts (`base-fork`, `guard-authority`, `live-evidence-hygiene`):** 3 passed, 0 failed
- **Morpho Adapter & Scanner (`@veto/morpho-v2`):** 7 passed, 0 failed
- **Core State Machine (`@veto/core`):** 3 passed, 0 failed
- **KeeperHub Integration (`@veto/keeperhub`):** 5 passed, 0 failed
- **Worker Pipeline & Anti-Churn (`@veto/worker`):** 35 passed, 0 failed
- **Total:** **53 passing tests, 0 failures**
