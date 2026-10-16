# Operations

How to run, back up, upgrade and remove the local Spaces Context Bridge adapter.

## Direct adapter

### What runs where

`npm start` runs one Node process bound to `127.0.0.1:4791`. It starts a Codex app-server child using your Codex install and sign-in, and stops it when the server exits. Calls are handled one at a time.

`npm run setup` creates three items in `~/.config/spaces-context-bridge/direct/` (or under `XDG_CONFIG_HOME`, `--config` or `BRIDGE_DIRECT_CONFIG`) and prints their paths:

| Item | Contents | Sensitivity |
| --- | --- | --- |
| `config.json` | Port, Codex path and writable Space IDs | Private |
| `owner-key` | The bearer key clients send | Secret; treat it like a password |
| `state/` | The save journal | Private; IDs, hashes and status, no note text |

The server refuses to start if any of them can be read by other users: directories must be `0700` and files `0600`. Logs contain short categories and timings, never Page, meeting or transcript content, filters or credentials.

### Where content goes

Page reads and edits pass through your agent and its model provider, the adapter, and Codex to OpenAI, where your Spaces live. An optional meeting save also passes the selected source text through this path. Your agent's provider sees whatever you ask it to handle, under its own retention settings. The adapter uses Codex's sign-in as-is and doesn't extract those credentials.

### Day to day

- Keep the server's terminal open and the Mac awake while you work.
- If Codex signs out, sign in again with `codex login`, then call `bridge_direct_status`.
- To allow another Space, run `npm run setup -- --allow-space <id>` (it adds to the list), then restart the server. To remove one, delete its ID from `allowedSpaceIds` in `config.json` and restart.

### Uncertain writes

A save or edit can end without a clear answer, for example after a timeout or a dropped connection. Treat that as unknown, not failed.

- **`saved_verification_pending`** means Spaces acknowledged the new Page but the independent readback isn't available yet (`saved: true`, `verified: false`). Repeat the identical call later; it reads and verifies instead of creating another Page.
- **Timeouts and other unknowns:** read the destination, or repeat the identical call. Don't change the source ID, title, destination or text to force a retry.
- Never repeat an uncertain write with a different tool before confirming what happened.
- The adapter doesn't recreate a saved Page that was later changed or moved to Trash.

### Back up and restore

1. Stop the server.
2. Copy `config.json` and `state/` together to a private location with permissions preserved (for example `cp -Rp`). They hold no note text, but the journal reveals Page IDs and timing, so keep it private.
3. Store the key in your password manager if you want to restore without reconnecting clients. Otherwise skip it and follow [replace the key](#replace-the-key) after restoring.
4. To restore, put the files back at the same paths with owner-only permissions, start the server and call `bridge_direct_status`.

An older journal doesn't know about saves made after the backup. Check the destination Space before retrying any of those. Your Pages live in ChatGPT, so back them up with ChatGPT's own tools; this backup doesn't include them.

### Upgrade

Stop the server, pull and review the new version, then start the server and call `bridge_direct_status`. The package has no npm dependencies; no dependency installation is required. Run `npm run verify` before restarting after an upgrade. Keep the existing config, key and journal. Pulling code doesn't change a running server until you restart it.

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
| `startup_failed` | Port 4791 is already in use (often a previous server still running), or the server couldn't load its config or key. Stop the other server, or run `npm run setup` to check the files without deleting the journal. |
| `bridge_direct_status` with `check_upstream: true` reports upstream unavailable | Codex isn't signed in, Spaces isn't available to the account in Codex, or setup points at the wrong Codex binary (`--codex-bin`). |
| `space_not_allowed` | The Space isn't on the allowlist. Run setup with `--allow-space`, then restart. |
| `saved_verification_pending` | Repeat the identical call later to verify. |
| Rejected for a closing code fence | The text contains a line that would end the fenced block. Ask the user how to handle it; don't edit the source silently. |
| Rejected as too large | Over 200,000 UTF-8 bytes or characters. Ask how to split it; never truncate silently. |
| Agent can't find the adapter | Check the client config and that the agent prompt is in its standing instructions. |

For a GitHub issue, include versions, the tool name and the error category. Leave out keys, Page links and content.
