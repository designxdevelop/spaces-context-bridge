# Architecture and limits

The adapter calls the owner's signed-in Codex app-server from a local Node process. It validates arguments and verifies writes; the requesting agent does the reasoning. The adapter never starts a model turn.

## Tool boundary

Ten public tools map to eight fixed upstream tools: six `chatgpt_space` Page operations and `meetings.find_all` / `meetings.fetch`. There is no arbitrary tool proxy or shell endpoint.

- Reads list Spaces, list/search/read current Space Pages, and optionally list/fetch private ChatGPT Meeting notes. Private-drive and trashed Pages are excluded from Page reads.
- Edits replace one exact span in one Markdown block. A fresh hash guards the change and an independent read verifies it.
- Saves create a Page containing verbatim notes or a transcript in an explicitly allowed Space. They do not create native Meeting recordings or provide unrestricted Page composition.

Every HTTP request needs the owner bearer key, checked before an upstream process starts. The server binds to `127.0.0.1`; it is for trusted clients on the same machine. Space write permissions are enforced by the adapter, with an optional Page allowlist for further edit restrictions. Reads cover the owner's accessible current Space Pages.

Upstream approval and elicitation requests fail closed. Sign-in, connector enablement and consent require the owner. No deletion, sharing, publishing, moving or messaging tools are exposed.

## Saves and recovery

Each saved artifact has a stable source ID. Retrying with identical arguments returns the existing Page. Older source IDs must remain in use on retries. The private journal stores IDs, hashes and status rather than note text; losing it weakens reconciliation and duplicate protection.

Notes and transcripts are separate artifacts, saved verbatim in labeled fenced blocks. Each save is capped at 200,000 UTF-8 bytes and characters. Closing-fence lines are rejected before writing; line endings normalize to LF, with original and stored hashes recorded.

A creation receipt with temporarily unavailable readback is reported as `saved_verification_pending`. It is saved but not yet verified. Repeat the identical call to reconcile it rather than changing IDs or creating another Page. Changed or trashed saved Pages are not recreated. This is not an exactly-once guarantee across unrelated hosts or lost journals.

## Optional meeting sources

Superwhisper is a separate MCP connection used by the requesting agent. The adapter does not record meetings, read Superwhisper's database or sync recordings automatically. The user selects what to save and names the destination Space. ChatGPT Meetings tools are an additional source when requested.

Superwhisper reads and synthetic Spaces writes were verified separately. A real recording import end to end and successful retrieval of a real ChatGPT Meeting note remain unverified. See [release evidence](RELEASE_REVIEW.md).

## Runtime and privacy

The runtime needs Node.js 22.13+, an installed Codex CLI signed in with a ChatGPT account, and callable Spaces tools for that account. Live use was verified on macOS with Codex CLI 0.163.0, through T3 Code/Codex and Executor. Other client configurations and fresh-account access remain unverified.

The Mac must stay awake and the server must keep running. Long-running sessions across sign-in expiry and platforms other than macOS remain unverified. Source-tool changes can affect compatibility; the adapter reports upstream failures instead of silently switching execution paths.

Pages are stored by OpenAI. Content returned to an agent is visible to its model provider, and selected saves pass through that provider and Codex to OpenAI. This is not local-only or end-to-end encrypted processing. The adapter itself starts no additional inference, but the requesting agent's usage, ChatGPT plan and optional recording provider's terms still apply.

See [client setup](CLIENTS.md), [operations](OPERATIONS.md) and [security](../SECURITY.md).
