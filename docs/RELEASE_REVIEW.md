# Release evidence — 0.3.0

This release ships the local Spaces MCP adapter. Cloud relay source, deployment configuration, dependencies, examples and guides have been retired from the current tree. The historical [v0.1.5 release](https://github.com/designxdevelop/spaces-context-bridge/releases/tag/v0.1.5) remains available. Existing deployments are unaffected; nothing here migrates or deletes their data.

## Current package

The direct runtime and its six test files are unchanged from the reviewed 0.2.0 package. Project version 0.3.0 identifies the simplified distribution; the adapter's component version remains 0.1.1. Setup, configuration, owner-key handling, write restrictions and journal format are unchanged. Standard `setup`/`start` scripts point at the same entrypoints as the retained `direct:setup`/`direct:start` aliases.

All 104 remaining automated tests pass: 102 adapter/setup/transport/meeting contracts and two release-hygiene tests. Cloud-specific tests were removed alongside their implementation, rather than counted as coverage for the local adapter. CI runs the same verification command on Node 22 and 24, with no npm dependencies.

A fresh dependency-free source copy also passed all 104 tests and both canonical setup/start commands. It generated new private configuration on a separate temporary port, refused unauthenticated access and exposed all ten tools. This 0.3.0 check made no upstream calls and changed no personal configuration.

## Observed live behavior

The owner's T3 Code/Codex → Executor → authenticated loopback adapter → Codex app-server → Spaces path completed sourced Page reads, a bounded edit, transcript and meeting-note creation, independent readback and duplicate protection. The adapter started no additional model turn.

Observed calls included a 2.8-second Page read, 10.9-second edit, 7.2-second transcript save and 6.1-second notes save. These are individual observations, not benchmarks or latency guarantees. A 148,536-byte synthetic transcript was verified after upstream readback freshness recovered. Temporarily unavailable readback is reported as saved but unverified.

Before the 0.2.0 release, a clean public-source copy without node_modules created a fresh key and read-only config on a separate local port. It rejected unauthenticated requests and a read-only save. A Page read completed in about 3.1 seconds. Adding one explicit Space preserved the key, enabled a synthetic notes save verified in about 7.5 seconds, and an identical retry returned the same Page. An independent read checked exact notes, title and destination. The test service was stopped without changing the real personal service. This used existing owner sign-in, not a fresh human account. The runtime tested there is unchanged in 0.3.0.

Superwhisper MCP listing and a selected recording read were verified separately. The result included a summary and timestamped segments. No real recording content was copied into test Pages; destination writes used synthetic fixtures. This establishes source-read and destination-write behavior, not a real recording import end to end.

ChatGPT Meetings tools were available and listing returned no private notes. Successful retrieval of a real note remains unverified.

## Reviews and limits

Earlier independent Claude Sonnet/Opus reviews covered meeting-tool contracts, notes/transcript separation, old-journal compatibility and uncertain-write handling. Astra reviewed public packaging and authorization boundaries. Opus wrote the 0.2.0 documentation; a final Sol review caught a key-rotation runbook issue, now corrected to preserve all configuration and journal state.

Live verification covers macOS with Codex CLI 0.163.0 through T3/Codex and Executor. Other client configurations are documented, not universally live-tested. Fresh-human connector eligibility, successful real Meeting fetch, long-running sign-in expiry and platforms other than macOS remain unverified. The server requires the Mac awake, the process running and callable source tools for the signed-in account.

A source-based journal protects ordinary retries, not unrelated hosts or lost journal state. Reconcile uncertain writes before retrying through any connection. Remote exposure, automatic recording sync and destructive Page operations are not provided.
