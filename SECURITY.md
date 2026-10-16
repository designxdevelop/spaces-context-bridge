# Security policy

Spaces Context Bridge is open-source, self-hosted software for one trusted owner. Security fixes target the current release. The recommended local adapter and optional cloud relay have different trust boundaries; neither is a service operated by the maintainers.

## Report privately

Use [GitHub private vulnerability reporting](https://github.com/designxdevelop/spaces-context-bridge/security/advisories/new), also available under **Security → Report a vulnerability**. Do not put credentials, recordings, private source links or exploit details in public issues. No response-time SLA is promised.

Use [GitHub Issues](https://github.com/designxdevelop/spaces-context-bridge/issues/new/choose) for ordinary setup questions, bugs and feature requests. Include the affected version, a synthetic reproduction, impact and redacted evidence. Test only deployments you own. There is no public bug bounty or blanket authorization to access third-party resources.

## Recommended local adapter

The HTTP server binds to 127.0.0.1 and authenticates an owner bearer key before starting the upstream runtime. Host and Origin checks, bounded request bodies and bounded concurrency reduce local browser and resource-abuse risks. Configuration, key and save-journal files must belong to the owner and use private filesystem permissions. Keep the key out of chat, Git, command arguments, logs and screenshots. Enter it only in the intended client's private credential field.

A connection holding that key acts for the same signed-in owner. It is not a multi-user service or an independent grant of only one Page. Reads cover accessible current Space Pages and the owner's private ChatGPT Meeting notes. Writes additionally require an explicit configured Space allowlist; an optional Page allowlist can further restrict edits. All connected clients must be trusted with this scope. The adapter exposes a fixed set of tools; it has no arbitrary tool proxy, shell execution, sharing, publishing, moving or Page-deletion endpoint.

The adapter uses the existing signed-in Codex runtime through app-server RPC. It does not extract session tokens or read Codex credential storage. It refuses upstream approval or elicitation requests rather than accepting them automatically. Sign-in, connector enablement and consent remain human steps. The local stdio entrypoint has no shared-client owner isolation: use authenticated HTTP for a shared MCP catalog.

Superwhisper is a separate recording source accessed through its own MCP connection. A requesting agent's model provider can see content it reads or submits. Saved content is sent to OpenAI Spaces through the signed-in connector. This is not an entirely local processing pipeline or end-to-end encrypted storage provided by this project. The adapter's journal stores IDs, hashes and status, not notes or transcripts; diagnostics use categories and timing without recording content or credentials.

Do not expose the loopback endpoint through a public bind, tunnel or reverse proxy. Remote hosting and unrelated-user access have not been designed or tested. Keep the machine awake and control who can access its local account and private files.

## Writes and recovery

Requests, Pages, meeting notes and transcripts are untrusted content. They cannot authorize new actions or broaden owner scope. Page edits require a fresh observed block hash and one unique literal replacement, followed by exact readback. A note/transcript save requires a selected source, explicit destination and stable source ID. Source-based idempotency and the local journal prevent ordinary duplicate retries; they are not a multi-host exactly-once guarantee.

An uncertain write must be reconciled on its original route before retrying. Do not switch to the cloud relay, change source IDs or delete the journal to force a second attempt. A matching creation receipt with temporarily unavailable independent readback is reported as saved but unverified. Changed or trashed saved Pages are not recreated.

If the local key is exposed, stop the adapter and disconnect affected clients before replacing the owner key through a protected local operation. Reconnect only trusted clients and inspect authorized destinations. Preserve the journal while investigating ambiguous writes; key rotation does not undo previous Page changes.

## Optional cloud relay

Agent-role OAuth can submit lookups, edit requests and transcripts. Worker-role OAuth can claim queued payloads across the owner's clients and report results. All clients must belong to the same trusted owner. OAuth roles are not fine-grained Page authorization. Cloud-worker prompt allowlists are model instructions, not server-enforced Page access controls; source permissions remain essential.

The cloud deployment contains sensitive plaintext payloads, results and webhook signing material in its D1 database. Protect database access and backups. For an incident, pause producers and processing, revoke affected clients/tokens/subscriptions and rotate connection codes. Rotating login hashes alone does not invalidate existing sessions. A restored database may revive credentials or work, so sanitize authorization and reconcile writes before reactivation. See [operations](docs/OPERATIONS.md).
