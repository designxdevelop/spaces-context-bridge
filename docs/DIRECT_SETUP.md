# Direct setup

The direct adapter is the recommended way to run Spaces Context Bridge. It's a small MCP server on your Mac at `http://127.0.0.1:4791/mcp`. Your agent calls it, and it reads and writes ChatGPT Spaces Pages through the Codex CLI you're already signed in to. There's no queue, no extra model turn, and no cloud copy of your notes.

## What you need

- A Mac that stays awake while you use it. The adapter has been verified on macOS; other platforms are untested.
- Node.js 22.13 or newer.
- The [Codex CLI](https://developers.openai.com/codex/cli), installed and signed in with your own ChatGPT account. Sign in yourself with `codex login`. The adapter uses Codex's sign-in as-is; it never asks for your password or extracts Codex credentials.
- Spaces available to that ChatGPT account in Codex. The `bridge_direct_status` tool, called with `check_upstream: true`, tells you whether the upstream tools are reachable.
- An MCP client on the same Mac that can send an `Authorization` header: Codex, Claude Code, OpenCode, T3 Code, or Executor. See [clients](CLIENTS.md#direct-adapter).
- Optional: [Superwhisper](https://superwhisper.com) and its MCP server, if you want to save meeting recordings.

## 1. Install

```sh
git clone https://github.com/designxdevelop/spaces-context-bridge.git
cd spaces-context-bridge
```

The direct adapter uses Node built-ins and your installed Codex CLI; `npm ci` is only needed for development checks or the cloud relay.

## 2. Create a private, read-only config

```sh
npm run direct:setup
```

Setup finds your Codex CLI, then creates three owner-only items and prints their paths (never the key itself):

```text
~/.config/spaces-context-bridge/direct/
├── config.json   Codex path and writable Space IDs
├── owner-key     the bearer key your clients send
└── state/        the save journal: IDs, hashes and status, no note text
```

The location follows `XDG_CONFIG_HOME` if you set it. To put the config somewhere else, run `npm run direct:setup -- --config /absolute/path/config.json` and `npm run direct:start -- --config /absolute/path/config.json`, or set `BRIDGE_DIRECT_CONFIG`.

A newly created config is read-only. Rerunning setup preserves any existing write allowlist. Your agent can read every Space you have access to, but it can't write anywhere until you allow a Space in step 5.

If `codex` isn't on your `PATH`, or you want a specific install, pass its absolute path:

```sh
npm run direct:setup -- --codex-bin /absolute/path/to/codex
```

## 3. Start the server

```sh
npm run direct:start
```

The server runs in the foreground on `127.0.0.1:4791`. Leave that terminal open and press Ctrl-C to stop it. Setup doesn't install a background service; if you want one, set it up with your own process manager.

Every request must carry the owner key as a bearer token. The server checks it before it starts Codex or calls anything upstream.

## 4. Connect your agent

Load the key into an environment variable without printing it. If you used a custom location, use the `Owner key file` path that setup printed:

```sh
export SPACES_DIRECT_KEY="$(cat ~/.config/spaces-context-bridge/direct/owner-key)"
```

Start your client from that shell. For Claude Code, add this to a project `.mcp.json`:

```json
{
  "mcpServers": {
    "spaces_direct": {
      "type": "http",
      "url": "http://127.0.0.1:4791/mcp",
      "headers": { "Authorization": "Bearer ${SPACES_DIRECT_KEY}" }
    }
  }
}
```

Codex, OpenCode, T3 Code and Executor configs are in [clients](CLIENTS.md#direct-adapter). The route verified so far is T3 Code (Codex) through Executor to the adapter. The other configs follow each client's documented syntax but haven't been tested live yet.

Keep the key out of chats, prompts, issue reports and committed files. The configs in these docs hold only a variable name.

## 5. Pick the Spaces your agent may write to

Ask your agent:

> List my ChatGPT Spaces.

Copy the IDs (`page_space_…`) of the Spaces you want it to write to. Run setup again with one `--allow-space` per Space, then stop the server (Ctrl-C) and start it again:

```sh
npm run direct:setup -- --allow-space page_space_EXAMPLE --allow-space page_space_EXAMPLE2
npm run direct:start
```

`--allow-space` adds to the existing allowlist, and rerunning setup without it leaves the allowlist alone. To remove a Space, delete its ID from `allowedSpaceIds` in `config.json` and restart. Rerunning setup never replaces your key.

Ask your agent to call `bridge_direct_status` and check that `allowedSpaceIds` matches. The allowlist controls writes only; reads still cover every Space you can access.

## 6. Give your agent standing instructions

Paste [the agent prompt](../prompts/DIRECT_AGENT_PROMPT.txt) into your host's persistent instructions, such as `AGENTS.md`, `CLAUDE.md`, OpenCode rules, or Executor connection notes. It makes Superwhisper the default meeting source, makes the adapter the destination, and spells out the write boundary.

Now you can ask in plain language, without naming tools:

> Save my latest meeting notes in Personal Notes.

The agent finds the recording in Superwhisper, reads its notes, and saves them as a new Page in that Space.

## Meeting sources

**Superwhisper (default).** Superwhisper records on your Mac and runs its own MCP server, separate from this adapter. The adapter doesn't record anything or proxy Superwhisper. Install the Superwhisper CLI using the [vendor's instructions](https://superwhisper.com/cli) and add `superwhisper mcp` to your client ([example](CLIENTS.md#superwhisper-mcp)). Your agent lists or searches meetings, then reads the one you meant with `read_meeting`: transcript off for notes, on for the raw transcript. Raw transcripts often come back as timestamped segments.

**ChatGPT Meetings (when you ask for it).** Say "from ChatGPT Meetings" and the agent uses the adapter's `meetings_find_all` and `meetings_fetch` to read private Meeting notes from your signed-in account. You can save them into a Space like any other notes. That creates a regular Page, not a native Meetings recording.

## What gets saved

- Notes and transcripts are saved verbatim in a labeled fenced block. Notes and transcript stay separate.
- Each save is capped at 200,000 UTF-8 bytes and 200,000 characters.
- Text with a line that would close a code fence (a line of backticks) is rejected before anything is written.
- Line endings are normalized to LF. Hashes of the original and stored text are both recorded.
- Timestamped segments keep their timings and speaker attribution where the source has them. Missing names or text are never filled in.
- Each artifact gets a stable source ID, such as `superwhisper:<recording-id>:notes`. Retrying with the same ID and arguments returns the same Page instead of a duplicate.

## Tools

| Tool | What it does |
| --- | --- |
| `bridge_direct_status` | Config, limits and whether upstream tools are reachable |
| `list_spaces` | Spaces you can access |
| `list_pages` | Current Pages in one Space |
| `find_pages` | Search within one Space |
| `read_page` | Read a Page, or selected blocks of it |
| `meetings_find_all` | List your ChatGPT Meetings notes by date or attendee |
| `meetings_fetch` | Read one selected Meeting note and any available transcript |
| `patch_page` | Replace one exact span of text in one block, then read it back |
| `save_meeting_notes` | Create a Page with selected meeting notes |
| `save_transcript` | Create a Page with a selected transcript |

Each tool maps to fixed Codex tools: six `chatgpt_space` Page operations, plus `meetings.find_all` and `meetings.fetch`. There's no generic proxy and no way to call anything else.

## Limits

- **Same machine only.** The server listens on `127.0.0.1`. Clients on another host, and cloud connectors such as ChatGPT app connectors, can't reach it. Don't expose the port publicly. Tunnels aren't supported.
- **Your Mac has to be on.** The Mac must be awake, Codex signed in, and the server running.
- **No background sync.** Nothing is polled or uploaded automatically. A save happens when you ask, for the recording you pick.
- **Current Pages only.** Reads skip private-drive and trashed Pages.
- **Narrow writes.** Bounded edits and new Pages in allowed Spaces. No deleting, sharing, publishing, moving or messaging.

## Next

- Something not working: [troubleshooting](OPERATIONS.md#troubleshooting).
- Backups, upgrades and uninstalling: [operations](OPERATIONS.md#direct-adapter).
- Checking your install: [verification](VERIFICATION.md#direct-adapter).
- Need a route that works while your Mac is asleep? The [cloud relay](../README.md#optional-cloud-relay) is still available as an asynchronous fallback.

## Versions

The project release is 0.2.0. The direct adapter reports its component version, 0.1.1, in MCP initialization and status; the unchanged cloud relay runtime reports 0.1.5.
