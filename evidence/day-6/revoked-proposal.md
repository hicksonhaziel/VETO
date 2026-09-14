# Public revoked-proposal guard rejection

- Recorded: 15 September 2026 (Africa/Lagos)
- Network: Base Sepolia (`84532`)
- Morpho Vault V2: `0x9019B1e26795E90825c567aD08c945C603e7F9B9`
- Result: **PASS**

## Why this proof matters

VETO must not trust an earlier alert after the underlying protocol state changes. This run queued a
real Morpho Vault V2 management-fee increase, let the production scanner create an exit intent, and
passed the exact exit through KeeperHub simulation. The curator then revoked the proposal before
execution. The guard re-read Morpho state and rejected the now-stale instruction with
`ProposalIsNotExecutable()`.

## Public sequence

| Step | Evidence |
|---|---|
| Deposit `10.000000 vfUSD` | [`0x59935b49…ca0b6`](https://base-sepolia.blockscout.com/tx/0x59935b492a78332a6203a12095b346473a1dd20ab2d17204d828e2bcc87ca0b6) |
| Arm mandate `1` | [`0x694757c3…4a917`](https://base-sepolia.blockscout.com/tx/0x694757c3627c5f391d6d77df4b755bb304e9fcae816b819a3d72aa799f64a917) |
| Queue 2% fee proposal | [`0xdd038a44…17d3e`](https://base-sepolia.blockscout.com/tx/0xdd038a4430df78dc427a72f207c91fcf26054454afb5f59be39c01d6b9717d3e) |
| Revoke exact proposal | [`0xc58f06bd…30854`](https://base-sepolia.blockscout.com/tx/0xc58f06bdf5f68a23f2f5a50ae0783952d5315da324f17f003df72c1fde330854) |
| Record exact guard rejection | [`0x5456da6a…226f0`](https://base-sepolia.blockscout.com/tx/0x5456da6a430874eece4ad7ec6dc8752bd8c6b56ba274c5842425be73a4d226f0) |

The proposal's `executableAt` value changed from `1789432530` to `0`, which is Morpho's on-chain
evidence that the exact proposal was cleared.

## KeeperHub behavior and public rejection proof

KeeperHub execution `bdcnl33bxkwcsowy2g2ze` rejected the direct stale call during its own
post-revocation preflight and therefore did not broadcast it. That is safe behavior, but it produces
no public transaction hash.

To make the on-chain guard decision independently inspectable, KeeperHub execution
`bqjr8pzwyx4sd6jcawhfd` called the testnet-only `GuardRejectionRecorder`. The recorder forwarded the
exact prepared guard calldata, required the call to fail with selector `0xc0ef4ad5`
(`ProposalIsNotExecutable()`), and emitted `GuardRejected` with the exact call hash. It would revert
itself if the guard accepted the call or returned a different error. The recorder has no custody or
administrative functions.

The outer recorder receipt is successful because it intentionally catches and records the inner
guard revert. It must not be described as a successful exit.

## Invariants after rejection

| Value | Before | After |
|---|---:|---:|
| Owner vault shares | `10000000000000000000` | `10000000000000000000` |
| Owner assets | `0` | `0` |
| Guard assets | `0` | `0` |
| Vault assets | `10000000` | `10000000` |
| Mandate active | `true` | `true` |

The worker recorded `BLOCKED` with `PROPOSAL_REVOKED_BEFORE_EXECUTION`. No shares or assets moved,
and the failed action did not consume the owner's mandate.

Machine-readable identifiers are in [`executions.json`](./executions.json).
