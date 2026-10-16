# Product notes

Spaces Context Bridge lets coding agents use ChatGPT Spaces as a shared notebook. Your agent can read Pages, make careful edits, and save the meetings you pick into the Space you name.

## Who it's for

Developers who keep notes in ChatGPT Spaces, record meetings with Superwhisper (or ChatGPT Meetings), and want the agent they're coding with to use that context and add to it, without copying text between apps.

## The workflow

1. Record a meeting in Superwhisper on your Mac.
2. In your agent, ask something like "Save my latest meeting notes in Personal Notes" or "What did we decide about pricing? Check the Product Space."
3. The agent reads the recording through Superwhisper's MCP server, then calls the adapter to save a Page or read existing ones.
4. The Page sits in your Space alongside everything else, available to ChatGPT and to the Space's members like any other Page.

This came from wanting a Granola-style meeting workflow built from tools I already use. It doesn't try to match Granola feature for feature: there's no note-taking UI, no automatic capture and no calendar integration. Recording stays with Superwhisper, and Spaces holds the notes.

## Two routes

| | Direct adapter (recommended) | Cloud relay (optional) |
| --- | --- | --- |
| Where it runs | Your Mac | Your Cloudflare account and a ChatGPT cloud task |
| Response | Synchronous, usually seconds | Asynchronous, roughly 40 seconds to a few minutes |
| Needs | Mac awake, Codex signed in, server running | Worker, D1 database, ChatGPT worker event task |
| Who can connect | MCP clients on the same Mac | Remote MCP clients over OAuth |
| Content storage | No copies; the journal holds IDs, hashes and status | Request payloads and results stored in D1 |
| Write scope | Space allowlist enforced by the server | Worker prompt instructions and source permissions |
| Meeting sources | Superwhisper via your agent; ChatGPT Meetings via the adapter | Transcripts your agent submits; Spaces and Meetings sources the worker can access |

The direct adapter starts a Codex app-server process with your normal sign-in and calls a fixed set of tools: six `chatgpt_space` Page operations, plus `meetings.find_all` and `meetings.fetch`. Your agent does the reasoning. The adapter only validates, calls, checks and reports, so it adds no model turn of its own.

## Safety design

- **Owner key.** Every request needs the bearer key that setup generated. It's checked before anything upstream starts.
- **Loopback only.** The server binds `127.0.0.1`. Clients on another host can't reach it, and it isn't meant to be exposed.
- **Fixed tools.** Ten public tools map to eight fixed upstream tools. There's no general proxy, and unknown arguments are rejected before any upstream call.
- **Reads.** All Spaces you can access, current Pages only. Private-drive and trashed Pages are excluded. ChatGPT Meetings reads use your signed-in account's private Meetings access.
- **Writes.** Only Spaces on the allowlist you configure, which is separate from what you can read. Edits replace one exact span of text in one Markdown block, checked against a fresh hash and read back. New Pages are verified by an independent read.
- **No destructive actions.** No deleting, sharing, publishing, moving or messaging.
- **Retries.** Each saved artifact has a stable source ID. Retrying with the same ID and arguments returns the existing Page. Older IDs stay in use on retry. An uncertain write is never replayed blindly, and never retried on the other route before it's been checked.
- **Faithful saves.** Notes and transcripts are stored verbatim in labeled fenced blocks, capped at 200,000 UTF-8 bytes and characters. Text containing a line that would close the fence fails before writing. Line endings normalize to LF, with hashes of both versions recorded. Timestamped segments keep their timing and attribution.

## Privacy

On the direct route, content moves like this: Superwhisper on your Mac → your agent and its model provider → the local adapter → Codex, signed in as you → OpenAI, where your Spaces live. Your agent's provider sees whatever notes or transcripts you ask it to handle. Nothing goes to Cloudflare.

The adapter's journal stores IDs, hashes and status, not note text. Its logs are short categories and timings. It uses Codex's own sign-in and doesn't extract those credentials.

This isn't a local-only or end-to-end encrypted system, and it doesn't take AI out of the loop. It removes the extra hop and the stored cloud copy.

The cloud relay is different: it stores request payloads, including transcript text, in the D1 database in your Cloudflare account, and cleans them up by age. See [operations](OPERATIONS.md#cloud-relay-optional).

## Costs

The direct route doesn't need a Cloudflare account and doesn't start model turns of its own. Your ChatGPT plan, your agent provider's usage, and Superwhisper's own terms still apply. The cloud relay adds Cloudflare Workers and D1 usage, and each processed event uses your ChatGPT plan; see [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).

## Evidence

These are observations from single runs on the maintainer's machine. Personal-route observations used the predecessor private build; clean-install observations used the packaged public source. They aren't benchmarks or service levels.

- **Automated:** 102 direct-adapter tests passed as part of the complete project suite. The Worker dry-run build and all 11 local workerd/D1 smoke checks passed. See the [release review](RELEASE_REVIEW.md) for final counts.
- **Through Executor** (T3 Code with Codex → Executor → adapter): first read 2.8 s, 1.6 s warm. Bounded edit with readback 10.9 s. Transcript save 7.2 s. Notes save 6.1 s. A separate exact readback confirmed each write, and retrying the same artifact returned the same Page.
- **Superwhisper MCP:** listing took 40 ms and reading took 118 ms, returning a summary and 1,281 timestamped segments. No personal recording content was copied into the tests.
- **Large save:** a 148,536-byte synthetic transcript was saved and verified once Spaces' readback caught up.
- **Clean install:** a source copy without node_modules generated a new key and read-only config, refused an unauthenticated request and a read-only save, and read a Page in 3.1 s. Adding one explicit Space preserved the key; a synthetic notes save completed with readback in 7.5 s and an identical retry returned the same Page. This used existing owner sign-in, not a new human account.
- **Source/destination coverage:** Superwhisper reads and synthetic Spaces writes were tested separately. Importing a real recording end to end remains unverified.
- **ChatGPT Meetings:** listing works (the test account returned no notes). Fetching a real note hasn't been verified yet.
- **Cloud relay:** synthetic lookup, edit and transcript round trips completed in about 48 to 102 seconds. See the [release review](RELEASE_REVIEW.md) for that historical record.

## Not verified yet

- Direct client configs for Codex, Claude Code and OpenCode outside Executor. They follow each client's documented syntax but haven't been run live.
- Fetching a real ChatGPT Meetings note.
- Platforms other than macOS.
- Long-running sessions across Codex sign-in expiry.
- The Cloudflare Deploy button's full browser flow.

## License and independence

MIT licensed, copyright 2026 Design X Develop. You run every part under your own accounts. Each installation uses its owner's accounts and storage. Spaces Context Bridge is independent of OpenAI, Anthropic, Superwhisper, Granola and Cloudflare. Questions and bugs go to [GitHub Issues](https://github.com/designxdevelop/spaces-context-bridge/issues/new/choose); vulnerabilities go to [private reporting](../SECURITY.md).
