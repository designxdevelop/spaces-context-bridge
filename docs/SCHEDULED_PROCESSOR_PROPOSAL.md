# Proposed scheduled ChatGPT processor

**Not implemented or enabled. The native event route is now verified, so this fallback is not needed for the tested setup. Implementation would require explicit owner approval.** This is an opt-in fallback for the original relay when native MCP event-task creation fails. It is not a replacement note store.

## Behavior

A ChatGPT Work cloud task checks the existing bridge queue on an owner-selected interval, claims each request and uses the same authorized Spaces tools to perform lookup, edit or ingestion. It completes the original request with verified sources/receipts. Other agents continue submitting through the same direct MCP or Executor route. No laptop daemon is needed for a cloud task.

The event-driven processor remains the default. Scheduled processing introduces latency up to the task interval, consumes scheduled-run usage even when the queue is empty, and still depends on successful ChatGPT task creation and tool access. The host's actual supported cadence and execution must be tested; a saved schedule is not proof that it runs.

## Isolated implementation scope

- Add explicit `PROCESSOR_MODE=polling`, defaulting to `events`; reject unknown values. Only set it on the synthetic review deployment during testing.
- Keep the existing four worker tools and all agent/worker permissions. In polling mode, an authenticated worker's `pending_requests` call refreshes a 15-minute presence record. OAuth alone and agent calls cannot establish readiness.
- Add one additive, idempotent migration for processor presence. A presence record is usable only while that client has a valid worker access/refresh grant. Expiration, revocation or refresh-replay revocation stops readiness. Preserve existing queue, lease, result and idempotency behavior.
- Keep `worker_connected` as event-subscription status. Expose `processor_mode` and `processor_ready` separately so polling cannot masquerade as a verified webhook connection.
- Add a dedicated scoped prompt and explicit timer setup. The event prompt continues to require events; no silent fallback or invented subscriptions.

## Acceptance and rollback

Test default event behavior unchanged, no readiness before a worker check-in, agent denial, durable presence, expiry and revocation, request ownership and the full claim/completion contract. Deploy only after local review/tests and apply the migration only to fresh synthetic review resources.

Verify native ChatGPT timer creation first. Submit synthetic lookup, one bounded disposable Page edit and one synthetic transcript from Executor; observe an unattended run and independently verify each actual Page effect. Retry identical ingestion and test out-of-scope refusal. If the host cannot create/run the timer, report scheduled activation blocked rather than weaken readiness or fabricate a worker.

At the end of the test, pause the owned timer and return the review deployment to event mode unless the owner explicitly chooses to retain the test. The additive table can remain unused; no existing data or personal deployment is changed. Public deployment and personal migration still require their existing review gates.
