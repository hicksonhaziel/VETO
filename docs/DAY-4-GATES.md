# Day 4 gates — operator screen

Day 4 turns the verified Day 3 pipeline record into one screen another person can read without
opening the source code. This checkpoint covers the useful operator screen and public execution
evidence. The hackathon demonstration and adverse demonstration cases remain explicitly deferred
at the builder's request; they have not been removed from `plan.md`.

## Gate status

| Gate                                | Status   | Evidence                                                                                                                        |
| ----------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Position is identifiable            | PASS     | Factory-verified vault, Base Sepolia chain ID, fixture asset, owner, and pre-exit shares are visible                            |
| Owner instruction is understandable | PASS     | Fee ceiling, exact shares, minimum return, expiry, safety window, finite approval, and cancellation authority are visible       |
| Waiting change is traceable         | PASS     | Current and proposed fees, rule match, source transaction, submission time, execution time, and remaining headroom are visible  |
| Outcome is independently verifiable | PASS     | KeeperHub ID, public receipt, inclusion time, block, gas, returned assets, zero guard balance, and duplicate result are visible |
| Claims are honest                   | PASS     | Screen says controlled testnet fixture, recorded evidence, no real value, and not Morpho mainnet or real USDC                   |
| Desktop and phone rendering         | PASS     | Browser screenshots and automated overflow/image checks passed                                                                  |
| Hackathon demonstration             | DEFERRED | Excluded from this checkpoint by the builder; the plan remains intact                                                           |

## User flow

1. Read the plain-language sentence explaining why the rule fired.
2. Confirm the vault, chain, fixture asset, and shares in **My position**.
3. Optionally connect a browser wallet to compare its address with the recorded owner. This is an
   address check only; the screen does not ask for a signature or transaction.
4. Read the bounded rule in **My instruction**, including the finite approval and owner-only
   cancellation behavior.
5. Follow the queued change to its public source transaction.
6. Compare the proposal's 2% fee with the 1% ceiling and see that the exit landed 59 minutes and
   48 seconds before the fee could first execute.
7. Open the exact exit receipt and independently verify the successful Base Sepolia transaction.

## Verification performed

- Next.js production build: PASS
- TypeScript strict check: PASS
- Desktop browser render: PASS
- Phone viewport at 390 by 844: PASS
- Framework error overlay: absent
- Browser errors and warnings: none
- Horizontal overflow at phone width: absent
- Evidence image: loaded with non-zero natural dimensions
- External evidence links rendered: five

The rendered page is static apart from the optional wallet-address comparison. It imports the
committed Day 3 evidence record and receipt screenshot at build time; it does not invent live worker
or database status.

## Deferred, not removed

- The adverse demonstration cases and four-minute hackathon walkthrough in plan section 13.
- A live database-backed intent view.
- Transaction creation, mandate arming, and cancellation from the web screen.
- A real Glacient delivery claim.
- Morpho mainnet asset movement or real USDC.

These items remain future work. The current screen is an honest evidence reader, not a control panel
that can move funds.
