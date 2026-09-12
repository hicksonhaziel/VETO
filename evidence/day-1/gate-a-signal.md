# Gate A — Glacient signal

Status: **BLOCKED — account session unavailable to the build environment**

Checked at: 2026-09-12T16:48:10Z

## What is verified

- Glacient publicly advertises Morpho Vault V2 monitoring and delivery to a user HTTPS webhook.
- Monitoring is read-only; Glacient is the notification source, not the transaction signer.
- A real queued-management-fee delivery is still required. A test webhook is not sufficient.

## Current blocker

The operator has created a Glacient account, but this Codex environment has no connected browser
session. Its browser inventory is empty and the local browser automation executable is unavailable.
No authenticated dashboard, monitor catalog, or delivery payload has been inspected.

## Exact unblock action

The operator must provide either a connected signed-in browser session or screenshots of:

1. the Glacient dashboard after login;
2. the Morpho Vault V2 monitor/metric picker;
3. the delivery-channel or webhook configuration screen.

After access is available, VETO must confirm that `setManagementFee` proposal coverage exists,
configure a controlled HTTPS receiver, retain a redacted real delivery, and resolve it to the
canonical Morpho proposal. If that coverage is absent, Gate A falls back to the onchain `Submit`,
`Revoke`, and `Accept` event scanner.

## Public references

- https://glacient.ai/
- https://docs.glacient.ai/
