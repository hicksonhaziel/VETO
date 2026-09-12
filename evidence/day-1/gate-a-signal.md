# Gate A — Glacient signal

Status: **IN PROGRESS — exact event coverage verified; real delivery still required**

Checked at: 2026-09-12T17:32:00Z

## What is verified

- Glacient publicly advertises Morpho Vault V2 monitoring and delivery to a user HTTPS webhook.
- Monitoring is read-only; Glacient is the notification source, not the transaction signer.
- The signed-in Risk Manager discovered two Base Vault V2 positions for Glacient's example wallet
  `0xa0894a415c4f246ce95bae718849579c099cc1d2`.
- The discovered positions include the independently selected Gauntlet USDC Prime vault
  (`0x050cE30b927Da55177A4914EC73480238BAD56f0`).
- The 22-alert catalog contains a dedicated **Management Fee Change Queued** monitor.
- Glacient labels this monitor medium severity and says it fires when the curator queues a change to
  the annual fee charged on total assets.
- The monitor explanation explicitly describes both increases and decreases. Its example is a fee
  rising from 1% to 2%, matching VETO's target scenario.
- Only **Management Fee Change Queued** was enabled for the Gauntlet USDC Prime position. Glacient
  reports the alert as active and set to auto-pause on 2027-09-12.
- The account-level HTTPS webhook is active with an HMAC secret configured. Saving the webhook did
  not send a verification delivery.
- Glacient's one-click Risk Manager alert exposes Webapp and Telegram delivery, not Webhook. The
  deployed frontend defines webhook delivery through a custom workflow whose terminal action is
  **Notify** with channel `webhook`; an **Alert** action cannot deliver to webhook.
- A real queued-management-fee delivery is still required. A test webhook is not sufficient.

## Current access constraint

The Codex environment has no connected browser session, so the operator is relaying screenshots
from the authenticated Glacient UI. The exact Risk Manager alert and account webhook are active,
but they are not connected to each other and no webhook delivery payload has been observed.

## Next action

Use Glacient's `/canvas` workflow builder to create a Gauntlet USDC Prime queued-management-fee
workflow ending in **Notify → Webhook**, then activate it and exercise its delivery path. VETO must
retain a redacted real delivery and resolve it to the canonical Morpho proposal. The onchain
`Submit`, `Revoke`, and `Accept` scanner remains the fallback and reconciliation source.

## Public references

- https://glacient.ai/
- https://docs.glacient.ai/
