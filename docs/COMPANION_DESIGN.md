# Optional local companion — design only

**Not implemented. No automatic sync exists.** The smallest useful companion is a user-invoked sender for selected recordings, not a background upload of all history.

1. Let the owner select recordings via the official local Superwhisper CLI/MCP. Display title/date and preview locally; verify the installed CLI supports the selected record type. Never infer permission from microphone access.
2. Require explicit approval of text, destination Space, and sending account. Offer redaction and summary-only export. Explain that sending moves data to cloud services. Keep recording/participant consent separate from export consent.
3. Store a local journal keyed by source-system identifier, stable recording ID, content revision hash, destination and bridge origin. Submit a stable `source_id` plus an idempotency key for that exact operation; retain the returned request ID.
4. Retry transient failures with bounded exponential backoff and jitter. Poll the original request after an ambiguous response. On authentication/scope errors pause for the owner. Never manufacture a new key to bypass an uncertain result.
5. Mark success only after a completed receipt and destination verification. Provide pause/cancel for unsent work and a review queue for failures. Explain that canceling locally cannot undo an already queued remote write.

The current bridge deduplicates request keys within a client and its retained request history; `source_id` is metadata, not a database-wide uniqueness guarantee. The worker must check source markers before creating a Page, especially after lease expiry, seven-day cleanup, restored backups, or changed client identity. Revisions need explicit update-versus-new-copy decisions. Exactly-once cross-system writes are not promised.

A later opt-in watcher would need narrowly selected folders/records, visible upload status, start-at-current-time behavior, an explicit backfill preview, secure local token storage, and tested shutdown/recovery. Do not ship it as a launch capability without implementation and acceptance evidence.
