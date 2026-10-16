# Operations

How to run, back up, upgrade and remove Spaces Context Bridge. The [direct adapter](#direct-adapter) comes first; the [cloud relay](#cloud-relay-optional) section keeps its full database runbook.

## Direct adapter

### What runs where

`npm run direct:start` runs one Node process bound to `127.0.0.1:4791`. It starts a Codex app-server child using your Codex install and sign-in, and stops it when the server exits. Calls are handled one at a time.

`npm run direct:setup` creates three items in `~/.config/spaces-context-bridge/direct/` (or under `XDG_CONFIG_HOME`, `--config` or `BRIDGE_DIRECT_CONFIG`) and prints their paths:

| Item | Contents | Sensitivity |
| --- | --- | --- |
| `config.json` | Port, Codex path and writable Space IDs | Private |
| `owner-key` | The bearer key clients send | Secret; treat it like a password |
| `state/` | The save journal | Private; IDs, hashes and status, no note text |

The server refuses to start if any of them can be read by other users: directories must be `0700` and files `0600`. Logs contain short categories and timings, never Page, meeting or transcript content, filters or credentials.

### Where content goes

A save moves text from Superwhisper on your Mac to your agent and its model provider, then through the adapter and Codex to OpenAI, where your Spaces live. Your agent's provider sees whatever you ask it to handle, under its own retention settings. Nothing goes to Cloudflare on this route. The adapter uses Codex's sign-in as-is and doesn't extract those credentials.

### Day to day

- Keep the server's terminal open and the Mac awake while you work.
- If Codex signs out, sign in again with `codex login`, then call `bridge_direct_status`.
- To allow another Space, run `npm run direct:setup -- --allow-space <id>` (it adds to the list), then restart the server. To remove one, delete its ID from `allowedSpaceIds` in `config.json` and restart.

### Uncertain writes

A save or edit can end without a clear answer, for example after a timeout or a dropped connection. Treat that as unknown, not failed.

- **`saved_verification_pending`** means Spaces acknowledged the new Page but the independent readback isn't available yet (`saved: true`, `verified: false`). Repeat the identical call later; it reads and verifies instead of creating another Page.
- **Timeouts and other unknowns:** read the destination, or repeat the identical call. Don't change the source ID, title, destination or text to force a retry.
- **Never switch routes mid-write.** Don't retry an uncertain direct write through the cloud relay, or the other way around, until you've confirmed what happened.
- The adapter doesn't recreate a saved Page that was later changed or moved to Trash.

### Back up and restore

1. Stop the server.
2. Copy `config.json` and `state/` together to a private location with permissions preserved (for example `cp -Rp`). They hold no note text, but the journal reveals Page IDs and timing, so keep it private.
3. Store the key in your password manager if you want to restore without reconnecting clients. Otherwise skip it and follow [replace the key](#replace-the-key) after restoring.
4. To restore, put the files back at the same paths with owner-only permissions, start the server and call `bridge_direct_status`.

An older journal doesn't know about saves made after the backup. Check the destination Space before retrying any of those. Your Pages live in ChatGPT, so back them up with ChatGPT's own tools; this backup doesn't include them.

### Upgrade

Stop the server, pull and review the new version, then start the server and call `bridge_direct_status`. The direct runtime needs no npm dependencies; run `npm ci` if you also use the cloud relay or development checks. Keep the existing config, key and journal. Pulling code doesn't change a running server until you restart it.

### Replace the key

Do this if the key leaks or you lose it. Rerunning setup on its own never replaces an existing key, so:

1. Stop the server and disconnect affected clients. Preserve `config.json` and the entire journal at its configured `stateDir`.
2. Generate a fresh cryptographically random 32-byte base64url key in a protected local operation, without displaying it. Replace only the file named by `tokenFile` in your existing config, retaining owner-only permissions (`0600`) and ownership. Never delete or regenerate the config to rotate a key: that can lose Page restrictions, a custom port, or the journal path.
3. Update `SPACES_DIRECT_KEY` and every client and Executor connection privately, then start the server.
4. Call `bridge_direct_status` to confirm the original write restrictions, and check that the config still names the original `stateDir`.

If the key leaked, check your allowed Spaces for edits or Pages you didn't make.

### Uninstall and delete your data

1. Make sure no write is still uncertain. If any recent save or edit ended without a verified result, resolve it first (see [uncertain writes](#uncertain-writes)).
2. Stop the server.
3. Remove the adapter entry from each client and from Executor, and unset `SPACES_DIRECT_KEY` wherever you set it.
4. Delete `~/.config/spaces-context-bridge/direct/` (or the paths setup printed), then delete the checkout.
5. Pages you saved stay in your Spaces. Delete them in ChatGPT if you want them gone. Superwhisper recordings and your agent provider's history have their own retention and deletion controls.
6. Your Codex sign-in isn't touched. Sign out in Codex if you want to.

To clear only the journal, first make sure every save is verified. Once it's gone, the adapter can't check a retry of an old save against its earlier Page, so don't retry old saves afterward.

### Troubleshooting

| Symptom | Check |
| --- | --- |
| `401` or unauthorized | The client isn't sending the key. Check that `SPACES_DIRECT_KEY` is set in the environment the client started from. |
| Connection refused | The server isn't running, or the client is on another machine. The adapter only accepts loopback connections. |
| `403` with `invalid_host` or `invalid_origin` | The client must address `127.0.0.1` or `localhost` on the configured port. Requests from web pages and other origins are refused. |
| `codex_not_found` during setup | Install the Codex CLI, or pass `--codex-bin /absolute/path/to/codex`. |
| `unsafe_private_file` or `unsafe_private_directory` | Something in the config directory is readable by other users, or is a link. Fix permissions to `0700` for directories and `0600` for files. |
| `setup_locked` | Another setup is running. If none is, remove the stale lock file it names and retry. |
| `startup_failed` | Port 4791 is already in use (often a previous server still running), or the server couldn't load its config or key. Stop the other server, or run `npm run direct:setup` to check the files without deleting the journal. |
| `bridge_direct_status` with `check_upstream: true` reports upstream unavailable | Codex isn't signed in, Spaces isn't available to the account in Codex, or setup points at the wrong Codex binary (`--codex-bin`). |
| `space_not_allowed` | The Space isn't on the allowlist. Run setup with `--allow-space`, then restart. |
| `saved_verification_pending` | Repeat the identical call later to verify. |
| Rejected for a closing code fence | The text contains a line that would end the fenced block. Ask the user how to handle it; don't edit the source silently. |
| Rejected as too large | Over 200,000 UTF-8 bytes or characters. Ask how to split it; never truncate silently. |
| Agent can't find the adapter | Check the client config and that the agent prompt is in its standing instructions. |

For a GitHub issue, include versions, the tool name and the error category. Leave out keys, Page links and content.

## Cloud relay (optional)

### What leaves the device

A selected local transcript passes from Superwhisper to the local MCP client and its model provider, then to the Cloudflare Worker/D1 when the client submits it. The ChatGPT worker retrieves it and may write the authorized Page. Results return through D1 to the submitting client. Ordinary context lookup and edit instructions also pass through these systems. Local transcription does not make the later workflow local-only.

D1 contains request payloads/results, client registrations and last-authorization times, authorization state, token digests, subscriptions, webhook signing secrets, and delivery metadata. Signing secrets must remain usable for delivery. There is no application-layer encryption of transcript payloads. Cloudflare account access and database exports are therefore sensitive. Source Pages, provider conversations, and local recordings have independent retention policies.

The code's seven-day request cleanup uses **creation time**, applies even to unfinished requests, and runs only when scheduled cleanup executes. It is not a seven-day deletion guarantee across backups, logs, client histories, or Spaces. Subscription expiry and token expiry can stop processing earlier. The default five-minute cron is a retry/cleanup cadence, not a completion SLA.

### Backup and restore

1. Pause request producers and the ChatGPT worker before a consistent backup. Record the code version and schema/migration state without credentials.
2. Export only the intended database using `npx wrangler d1 export DB --remote --output /private/backup/bridge.sql`, substituting a protected directory. Treat the dump as credentials plus user content; encrypt it and exclude it from Git/cloud shares unless explicitly approved.
3. Restore first into an isolated, newly created database with no active delivery cron or clients. Follow [D1 import/export](https://developers.cloudflare.com/d1/best-practices/import-export-data/) and validate schema and counts before switching a binding.
4. Before activating the isolated restored copy, inspect [quarantine-restored-copy.sql](../maintenance/quarantine-restored-copy.sql). With its own `DB` binding selected, run `npx wrangler d1 execute DB --remote --file maintenance/quarantine-restored-copy.sql`. This deletes restored credentials, registrations, subscriptions and outbox rows, and marks unfinished requests failed to prevent automatic replay. Completed results and payloads remain. The script also handles backups with only migration `0001`; after quarantine, apply the current numbered migrations before activating the copy. Run this only on the restored copy with producers, worker and cron paused. Rotate both connection codes, re-register/reconnect clients, and inspect external Pages before submitting replacement work.
5. Keep the old deployment paused until rollback is no longer needed. Test a synthetic operation before allowing real traffic.

Do not paste a whole dump into an issue or an agent chat. Wrangler secrets are separate from SQL exports; recover or rotate them through your secret-management process. D1 [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) is another recovery option within the plan's retention window, not a backup of Spaces or local recordings. Restoring an old database can resurrect authorization state and replayable work.

### Upgrade

Back up, pause producers/worker, review release notes and migrations, apply migrations to a restored test copy, then run local and hosted synthetic checks. Apply reviewed production migrations only to the intended binding. A code rollback does not undo a schema migration or Page edit; use a tested compatible code/schema pair. Keep the current version number until the release owner approves a change.

Migration `0002` adds registration activity in a separate table, preserving the old client schema for code rollback. Apply numbered migrations through Wrangler once; existing registrations receive one 37-day grace period at upgrade. No authorization or token is granted by that backfill. New unused registrations expire after one hour and may be evicted at the 1,000-client cap. Owner-authorized registrations remain for 37 days after the last consent/token issuance, or while a token row remains. Revocation does not immediately remove the cached registration. After the idle retention window, remove and re-add the MCP connection so its host registers again; signing in with an expired cached client ID is insufficient.

Migration `0002` backfills **every** legacy client because prior authorization history cannot be inferred from missing tokens. A pre-upgrade registration flood at the 1,000-client cap can therefore keep new registration blocked for the 37-day grace period. Do not blanket-delete tokenless registrations: an owner may still cache one after revocation or token expiry.

If capacity must be recovered sooner, pause registrations, keep a protected backup, and have the owner review candidate IDs against their actual client configurations. This query lists tokenless/code-free candidates; it does **not** prove that a client was never authorized or is unused:

```sql
SELECT c.id,c.name,c.created,a.last_used
FROM clients c LEFT JOIN client_activity a ON a.client=c.id
WHERE NOT EXISTS (SELECT 1 FROM tokens t WHERE t.client=c.id)
  AND NOT EXISTS (SELECT 1 FROM codes k WHERE k.client=c.id)
ORDER BY c.created;
```

Only after the owner confirms a specific ID is unused, substitute that reviewed ID in the example below and execute it against the intended binding. Preserve all cached owner IDs. The checks prevent deleting a client that acquired token or code rows since review; they cannot establish owner intent.

```sql
DELETE FROM clients
WHERE id='REVIEWED_UNUSED_CLIENT_ID'
  AND NOT EXISTS (SELECT 1 FROM tokens WHERE client=clients.id)
  AND NOT EXISTS (SELECT 1 FROM codes WHERE client=clients.id);
DELETE FROM client_activity
WHERE NOT EXISTS (SELECT 1 FROM clients WHERE id=client_activity.client);
```

### Revoke access and uninstall

Stop the ChatGPT event task and unsubscribe, disconnect/revoke both client roles, then remove the client configuration entries you created. Remove the Worker and cron after deciding whether to retain a protected backup; separately delete D1 and associated secrets/resources if permanent deletion is intended. Do not assume removing the Worker deletes the database. Delete copied Pages, local exports, backups, and provider history separately if desired and authorized.

Changing a login hash blocks future consent with the old code; it does **not** revoke existing tokens. Use token/client revocation or a reviewed maintenance operation, then verify old credentials fail. For a compromise, stop delivery and processing first, revoke sessions/subscriptions, rotate codes, and inspect destinations for unintended changes.

### Cloud relay troubleshooting

| Symptom | Check |
| --- | --- |
| OAuth connected, `worker_connected: false` | Worker-role event subscription, expiry and authorization; do not repeat agent setup |
| Callback verification fails | Official callback host, challenge/signature, exact protocol response and account capability; do not widen host trust casually |
| Request stays queued | Delivery state, worker activation, subscription/token expiry and source tools |
| Request stays processing | Lease expiry and previous external effects before retrying |
| Save returned an ID | Poll `get_result`; independently verify the destination before reporting a saved Page |

Keep diagnostics to status codes and identifiers. Avoid payload logging, credential-store scraping, or exporting personal histories for debugging.

### Refresh replay and recovery timing

Clients must serialize OAuth refreshes. Concurrent event wake-ups or multiple coding clients sharing one Executor connection must use a host that coordinates refresh. A lost refresh response followed by a retry also disconnects the client; there is no grace window. These real-client scenarios remain release acceptance gates. Presenting a used refresh token again ends every token and subscription for that client registration, including a replacement token, and requires signing in again. Unknown or another client’s tokens do not revoke a grant. Used-refresh digests remain until their original expiration (up to 30 days); they grant no access. Tokens rotated before this upgrade have no replay marker.

Cron re-announces stalled queued requests and expired processing leases after about 30 minutes, for up to 24 hours from creation, using a fresh webhook ID. A recovered claim requires reconciliation before any external write. This is bounded recovery, not exactly-once execution or a completion SLA.

### Duplicate prevention and input limits

Request idempotency is scoped to a client registration and retained request history. `source_id` is metadata, not a database-wide unique key. A new key, a different OAuth client or seven-day cleanup can produce a new request for the same recording. The ChatGPT worker must inspect source markers before creating a Page; cross-system duplicate prevention is best effort until verified in the hosted acceptance flow.

The HTTP body cap is 256 KiB of serialized UTF-8 JSON, including all fields, metadata and escaping. Oversized requests return 413; split a selected transcript into explicitly identified parts rather than silently truncate it. Transcript and completion-result fields are capped at 40,000 UTF-16 code units; auxiliary fields have smaller limits. A callback returning 410 disconnects that subscription and blocks new requests when no other worker is connected. Reconnect/re-verify the worker callback to resume eligible stalled requests created within the last 24 hours. Older requests are outside automatic recovery: inspect `get_result` and reconcile external Pages before deciding whether replacement work is needed. Do not blindly submit a fresh idempotency key. A 413 rejects only that delivery; a normal TTL refresh leaves it terminal until the subscription is re-verified or its signing secret is rotated.

Automatic recovery can re-announce an unclaimed request approximately 48 times during its first day per active subscription, in addition to up to five delivery attempts per announcement. Each accepted event may consume ChatGPT usage. Stop monitoring/unsubscribe if processing cannot run. Worker traces default to disabled; query strings are redacted in invocation logging. Do not enable payload or D1-bind logging for transcript traffic. Provider/account log retention settings are separate from request cleanup.
