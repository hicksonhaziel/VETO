# Gate C — KeeperHub execution

Status: **IN PROGRESS — authenticated reads pass; no redemption broadcast yet**

Checked at: 2026-09-12T16:48:10Z

## Checks completed

- `GET /api/keys` returned HTTP `200` with the configured organization API key.
- The active key is named `veto-dev`, has no expiry, and reports no scope restriction.
- `GET /api/user` returned HTTP `200`.
- KeeperHub organization wallet: `0x3e7a055f59c662987ae68240fd713195c30c0497`.
- The live chain catalog includes enabled Base Sepolia (`84532`) and Ethereum Sepolia (`11155111`).
- A KeeperHub contract read on Base mainnet returned `true` for the selected Morpho factory's
  `isVaultV2` check.

## Test balances

| Network | Asset | Balance |
|---|---|---|
| Base Sepolia | Native ETH | `129227533622046` wei |
| Base Sepolia | Test USDC | `0` base units |
| Ethereum Sepolia | Native ETH | `0` wei |
| Ethereum Sepolia | Test USDC | `0` base units |

## Secret handling

The real API key is stored only in the ignored local `.env`. This evidence file and `.env.example`
contain no secret value. The disclosed development key must be rotated before production use.

## Remaining work before PASS

1. Deploy a controlled Vault V2 fixture and hardened candidate guard on Base Sepolia.
2. Obtain a small amount of Base Sepolia test USDC for the depositor.
3. Deposit, register a mandate, and grant a finite vault-share allowance.
4. Queue a fee proposal above the mandate ceiling.
5. Simulate the exact guard call through KeeperHub and independently with `eth_call`.
6. Broadcast once with a persisted idempotency key.
7. Save the execution ID and transaction hash, then independently verify the successful receipt,
   consumed mandate, shares burned, owner asset receipt, and deadline.
8. Prove duplicate delivery and proposal revocation cannot create another economic effect.

An authenticated read is useful integration evidence but does not pass Gate C. Only a real
KeeperHub-submitted redemption does.
