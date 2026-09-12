# Gate A — Glacient signal

Status: **IN PROGRESS — exact event coverage verified; real delivery still required**

Checked at: 2026-09-12T16:48:10Z

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
- A real queued-management-fee delivery is still required. A test webhook is not sufficient.

## Current access constraint

The Codex environment has no connected browser session, so the operator is relaying screenshots
from the authenticated Glacient UI. The dashboard and monitor catalog have now been inspected, but
no alert has been enabled and no webhook delivery payload has been observed.

## Next action

Enable only **Management Fee Change Queued** for the Gauntlet USDC Prime example position, inspect
the available delivery channels and plan requirements, then configure a controlled HTTPS receiver.
VETO must retain a redacted real delivery and resolve it to the canonical Morpho proposal. The
onchain `Submit`, `Revoke`, and `Accept` scanner remains the fallback and reconciliation source.

## Public references

- https://glacient.ai/
- https://docs.glacient.ai/
