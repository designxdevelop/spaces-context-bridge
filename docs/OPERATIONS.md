# Data flow and operations

## What leaves the device

A selected local transcript passes from Superwhisper to the local MCP client and its model provider, then to the Cloudflare Worker/D1 when the client submits it. The ChatGPT worker retrieves it and may write the authorized Page. Results return through D1 to the submitting client. Ordinary context lookup and edit instructions also pass through these systems. Local transcription does not make the later workflow local-only.

D1 contains request payloads/results, client registrations and last-authorization times, authorization state, token digests, subscriptions, webhook signing secrets, and delivery metadata. Signing secrets must remain usable for delivery. There is no application-layer encryption of transcript payloads. Cloudflare account access and database exports are therefore sensitive. Source Pages, provider conversations, and local recordings have independent retention policies.

The code's seven-day request cleanup uses **creation time**, applies even to unfinished requests, and runs only when scheduled cleanup executes. It is not a seven-day deletion guarantee across backups, logs, client histories, or Spaces. Subscription expiry and token expiry can stop processing earlier. The default five-minute cron is a retry/cleanup cadence, not a completion SLA.

## Backup and restore

1. Pause request producers and the ChatGPT worker before a consistent backup. Record the code version and schema/migration state without credentials.
2. Export only the intended database using `npx wrangler d1 export DB --remote --output /private/backup/bridge.sql`, substituting a protected directory. Treat the dump as credentials plus user content; encrypt it and exclude it from Git/cloud shares unless explicitly approved.
3. Restore first into an isolated, newly created database with no active delivery cron or clients. Follow [D1 import/export](https://developers.cloudflare.com/d1/best-practices/import-export-data/) and validate schema and counts before switching a binding.
4. Before activating the isolated restored copy, inspect [quarantine-restored-copy.sql](../maintenance/quarantine-restored-copy.sql). With its own `DB` binding selected, run `npx wrangler d1 execute DB --remote --file maintenance/quarantine-restored-copy.sql`. This deletes restored credentials, registrations, subscriptions and outbox rows, and marks unfinished requests failed to prevent automatic replay. Completed results and payloads remain. Run this only on the restored copy with producers, worker and cron paused. Rotate both connection codes, re-register/reconnect clients, and inspect external Pages before submitting replacement work.
5. Keep the old deployment paused until rollback is no longer needed. Test a synthetic operation before allowing real traffic.

Do not paste a whole dump into an issue or an agent chat. Wrangler secrets are separate from SQL exports; recover or rotate them through your secret-management process. D1 [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) is another recovery option within the plan's retention window, not a backup of Spaces or local recordings. Restoring an old database can resurrect authorization state and replayable work.

## Upgrade

Back up, pause producers/worker, review release notes and migrations, apply migrations to a restored test copy, then run local and hosted synthetic checks. Apply reviewed production migrations only to the intended binding. A code rollback does not undo a schema migration or Page edit; use a tested compatible code/schema pair. Keep version 0.1.5 until the release owner approves a version change.

Migration `0002` adds registration activity in a separate table, preserving the old client schema for code rollback. Apply numbered migrations through Wrangler once; existing registrations receive one 37-day grace period at upgrade. No authorization or token is granted by that backfill. New unused registrations expire after one hour and may be evicted at the 1,000-client cap. Owner-authorized registrations remain for 37 days after the last consent/token issuance, or while a token row remains. Revocation does not immediately remove the cached registration. After the idle retention window, remove and re-add the MCP connection so its host registers again; signing in with an expired cached client ID is insufficient.

## Revoke access and uninstall

Stop the ChatGPT event task and unsubscribe, disconnect/revoke both client roles, then remove the client configuration entries you created. Remove the Worker and cron after deciding whether to retain a protected backup; separately delete D1 and associated secrets/resources if permanent deletion is intended. Do not assume removing the Worker deletes the database. Delete copied Pages, local exports, backups, and provider history separately if desired and authorized.

Changing a login hash blocks future consent with the old code; it does **not** revoke existing tokens. Use token/client revocation or a reviewed maintenance operation, then verify old credentials fail. For a compromise, stop delivery and processing first, revoke sessions/subscriptions, rotate codes, and inspect destinations for unintended changes.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| OAuth connected, `worker_connected: false` | Worker-role event subscription, expiry and authorization; do not repeat agent setup |
| Callback verification fails | Official callback host, challenge/signature, exact protocol response and account capability; do not widen host trust casually |
| Request stays queued | Delivery state, worker activation, subscription/token expiry and source tools |
| Request stays processing | Lease expiry and previous external effects before retrying |
| Save returned an ID | Poll `get_result`; independently verify the destination before reporting a saved Page |

Keep diagnostics to status codes and identifiers. Avoid payload logging, credential-store scraping, or exporting personal histories for debugging.

## Refresh replay and recovery timing

Clients must serialize OAuth refreshes. Concurrent event wake-ups or multiple coding clients sharing one Executor connection must use a host that coordinates refresh. A lost refresh response followed by a retry also disconnects the client; there is no grace window. These real-client scenarios remain release acceptance gates. Presenting a used refresh token again ends every token and subscription for that client registration, including a replacement token, and requires signing in again. Unknown or another client’s tokens do not revoke a grant. Used-refresh digests remain until their original expiration (up to 30 days); they grant no access. Tokens rotated before this upgrade have no replay marker.

Cron re-announces stalled queued requests and expired processing leases after about 30 minutes, for up to 24 hours from creation, using a fresh webhook ID. A recovered claim requires reconciliation before any external write. This is bounded recovery, not exactly-once execution or a completion SLA.

## Duplicate prevention and input limits

Request idempotency is scoped to a client registration and retained request history. `source_id` is metadata, not a database-wide unique key. A new key, a different OAuth client or seven-day cleanup can produce a new request for the same recording. The ChatGPT worker must inspect source markers before creating a Page; cross-system duplicate prevention is best effort until verified in the hosted acceptance flow.

The HTTP body cap is 256 KiB of serialized UTF-8 JSON, including all fields, metadata and escaping. Oversized requests return 413; split a selected transcript into explicitly identified parts rather than silently truncate it. Transcript and completion-result fields are capped at 40,000 UTF-16 code units; auxiliary fields have smaller limits. A callback returning 410 disconnects that subscription and blocks new requests when no other worker is connected. Reconnect/re-verify the worker callback to resume stalled requests. A 413 rejects only that delivery; a normal TTL refresh leaves it terminal until the subscription is re-verified or its signing secret is rotated.

Automatic recovery can re-announce an unclaimed request approximately 48 times during its first day per active subscription, in addition to up to five delivery attempts per announcement. Each accepted event may consume ChatGPT usage. Stop monitoring/unsubscribe if processing cannot run. Worker traces default to disabled; query strings are redacted in invocation logging. Do not enable payload or D1-bind logging for transcript traffic. Provider/account log retention settings are separate from request cleanup.
