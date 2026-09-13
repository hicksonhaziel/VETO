# Day 4 gates — operator screen

Day 4 turns the verified Day 3 pipeline record into a product-shaped operator console another
person can use without opening the source code. This checkpoint covers the overview, exit-rule
workspace, activity trail, public execution evidence, and responsive product shell. The hackathon
demonstration and adverse demonstration cases remain explicitly deferred at the builder's request;
they have not been removed from `plan.md`.

## Gate status

| Gate                                | Status   | Evidence                                                                                                                        |
| ----------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Position is identifiable            | PASS     | Factory-verified vault, Base Sepolia chain ID, fixture asset, owner, and pre-exit shares are visible                            |
| Owner instruction is understandable | PASS     | Fee ceiling, exact shares, minimum return, expiry, safety window, finite approval, and cancellation authority are visible       |
| Waiting change is traceable         | PASS     | Current and proposed fees, rule match, source transaction, submission time, execution time, and remaining headroom are visible  |
| Outcome is independently verifiable | PASS     | KeeperHub ID, public receipt, inclusion time, block, gas, returned assets, zero guard balance, and duplicate result are visible |
| Claims are honest                   | PASS     | Screen says controlled testnet fixture, recorded evidence, no real value, and not Morpho mainnet or real USDC                   |
| Product navigation                  | PASS     | Overview, Exit rules, Activity, and Evidence views switch in place; rule details open in a keyboard-dismissable drawer          |
| Desktop and phone rendering         | PASS     | Browser screenshots and narrow-phone overflow/image checks passed                                                               |
| Hackathon demonstration             | DEFERRED | Excluded from this checkpoint by the builder; the plan remains intact                                                           |

## User flow

1. Open **Overview** and read the completed outcome, testnet boundary, returned amount, and exit
   headroom.
2. Compare the proposal's 2% fee with the owner's 1% ceiling, then open **Review rule** for the
   full immutable mandate.
3. Open **Exit rules** to inspect the consumed rule or prepare a new-rule draft. Activation is
   truthfully disabled until a supported owner position and deployed guard are connected.
4. Open **Activity** to follow all nine KeeperHub-submitted transactions from deployment through
   exit.
5. Open **Evidence** to inspect the receipt and follow the exact transaction to Blockscout.
6. Optionally connect a browser wallet. The current screen only identifies the address; it does not
   request a signature or create a transaction.

## Verification performed

- Next.js production build: PASS
- TypeScript strict check: PASS
- Desktop browser render: PASS
- Narrow phone-class viewport: PASS
- Framework error overlay: absent
- Browser errors and warnings: none
- Horizontal overflow at phone width: absent
- Evidence image: loaded with non-zero natural dimensions
- Exit-rules navigation: PASS
- Rule drawer opens and closes with Escape: PASS
- Unsupported new-rule submission remains disabled: PASS
- Activity rows linked to public receipts: nine

The rendered evidence is static apart from navigation, the rule drawer, editable draft fields, and
optional wallet connection. It imports the committed Day 3 evidence record and receipt screenshot
at build time; it does not invent live worker or database status.

## Deferred, not removed

- The adverse demonstration cases and four-minute hackathon walkthrough in plan section 13.
- A live database-backed intent view.
- Transaction creation, mandate arming, and cancellation from the web screen.
- A real Glacient delivery claim.
- Morpho mainnet asset movement or real USDC.

These items remain future work. The current console is a high-fidelity product shell and honest
evidence reader, not yet a control panel that can move funds.
