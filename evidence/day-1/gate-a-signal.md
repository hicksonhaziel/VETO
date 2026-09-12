# Gate A — Glacient signal

Status: **FALLBACK — exact event exists, but webhook workflow access requires Glacient Premium**

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
- The signed-in `/canvas` screen identifies the account as Standard and disables new nodes, AI
  workflow creation, and workflow import behind **Premium Only**. The Morpho V2 upgrade path is
  presented as **Talk to us**, so there is no authorized, immediate self-service path to a webhook
  workflow.
- No plan was purchased and no vendor request was submitted. A real queued-management-fee delivery
  therefore could not be obtained on Day 1.

## Current access constraint

The Standard account can monitor the exact event in Glacient, but cannot connect that monitor to
the configured account webhook. This is a product entitlement constraint, not an event-coverage or
receiver-transport failure.

## Next action

Use Morpho Vault V2's canonical `Submit`, `Revoke`, and `Accept` events as VETO's primary signal
source. Keep the active Glacient in-app monitor as product evidence, but do not claim a completed
Glacient integration. Revisit **Notify → Webhook** only if Premium access is explicitly approved.

The fallback scanner is implemented in `@veto/morpho-v2`. A live Base read matched the selected
vault's historical `setManagementFee(0)` submission in transaction
`0x5b1aa3c141f9ef9189946e823f07eb02ea6ee578f2253b90758ddff1e1bdfcfd` to its acceptance in
`0xdb86b4c03ab78c33b2ee4fe68dc4baa50f67165e950ba49b5ed515c00879160a`. This validates event
decoding and lifecycle correlation; it is not evidence of a harmful fee proposal.

## Public references

- https://glacient.ai/
- https://docs.glacient.ai/
