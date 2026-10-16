# Spaces Context Bridge

Read and edit your ChatGPT Spaces from Claude Code, Codex, OpenCode and other MCP clients.

Spaces Context Bridge is an open-source MCP server that gives your other agents access to your ChatGPT Spaces. Search and read Pages, make bounded edits, and save selected notes or transcripts as new Pages in a Space you choose. The recommended adapter runs on your Mac and uses your signed-in Codex CLI for Spaces access, even when Claude Code or another client is doing the work. Connect each client directly or share the connection through Executor.

## Why it exists

My project context lives in ChatGPT Spaces, but I work with several agents. I wanted Claude and my other coding agents to consult those same Pages and update them without copying context between apps. Spaces stays the shared notebook; I can choose which agent works with it.

The first version sent every request through a queue to a ChatGPT cloud task, so each one took somewhere between 40 seconds and a few minutes. The direct adapter calls the same Spaces tools through the Codex CLI you're already signed in to, with no queue and no extra model turn. In testing, requests finished in seconds. See the [evidence](docs/PRODUCT.md#evidence).

## Quick start

You need macOS, Node.js 22.13 or newer, and the Codex CLI signed in with your ChatGPT account, with Spaces tools available to that account in Codex.

```sh
git clone https://github.com/designxdevelop/spaces-context-bridge.git
cd spaces-context-bridge
npm run direct:setup   # finds Codex, creates a private key and a read-only config
npm run direct:start   # serves http://127.0.0.1:4791/mcp in the foreground
```

Connect your agent with the key as a bearer token ([client configs](docs/CLIENTS.md#direct-adapter)). The T3 Code (Codex) → Executor route has been tested live; the other client configs are documented but not yet live-tested. Ask your agent to list your Spaces, then stop the server (Ctrl-C), allow writes to the Spaces you choose, and start it again:

```sh
npm run direct:setup -- --allow-space page_space_EXAMPLE
npm run direct:start
```

Once connected, ask your agent:

> Find the launch plan in my Product Space and summarize the open decisions with source links.

Or request a bounded edit:

> In the Launch Plan Page, replace “Target date: October 20” with “Target date: October 23”. Leave everything else unchanged.

[Direct setup](docs/DIRECT_SETUP.md) covers each step in detail. If you'd rather have your agent do the setup, use the [setup prompt](docs/SETUP_WITH_AGENT.md).

## What it does

- **Read.** List Spaces, list and search Pages, read a Page.
- **Edit.** Replace one exact span of text in one block of a Page, checked against a fresh read and verified afterward.
- **Save.** Create a Page with meeting notes or a transcript, verbatim, with a stable source ID so a retry doesn't create a duplicate.

It won't delete, share, publish, move or message anything. It won't write to a Space you haven't allowed, sync recordings in the background, or forward arbitrary tool calls.

## Optional: meeting notes

You can also use Spaces as a home for meeting notes. Connect Superwhisper's separate MCP server, then ask your agent to save selected notes or a transcript into a named Space. Superwhisper is optional; reading and editing existing Spaces Pages needs no recording app.

[The agent prompt](prompts/DIRECT_AGENT_PROMPT.txt) configures Superwhisper as the default meeting source and ChatGPT Meetings as an additional source when requested. ChatGPT Meetings list and fetch tools are included; fetching a real Meeting note remains unverified. Imports are on demand, with no automatic recording sync. See [meeting setup](docs/DIRECT_SETUP.md#meeting-sources).

## How it works

```mermaid
flowchart LR
  A["Claude Code / Codex / OpenCode / T3 Code"] -->|recommended| D["Direct adapter<br/>127.0.0.1:4791"]
  SW["Superwhisper MCP<br/>optional meeting source"] -.-> A
  D --> C["Codex CLI<br/>your sign-in"]
  C --> S["ChatGPT Spaces Pages"]
  A -.->|optional, async| W["Cloud relay<br/>Cloudflare Worker + D1"]
  W -.-> T["ChatGPT worker task"]
  T -.-> S
```

Your agent decides what to do and calls the adapter's tools. The adapter makes a fixed set of Codex tool calls (six Spaces Page operations plus ChatGPT Meetings list and fetch), checks the results and returns them. It never starts a model turn of its own.

## Privacy

Spaces Pages live at OpenAI. When your agent reads a Page, its content is returned to that agent and its model provider; edits and saves go through the local adapter and Codex back to Spaces. Optional meeting imports also send the selected recording text to your agent's provider and OpenAI. The adapter keeps only IDs, hashes and status in a local journal, and its logs contain short categories, not content. It relies on Codex's own sign-in and doesn't extract those credentials. Details are in [operations](docs/OPERATIONS.md#direct-adapter) and the [security policy](SECURITY.md).

## Optional: cloud relay

The original route is still here. A Cloudflare Worker with a D1 database queues requests, and a ChatGPT cloud task picks them up. It can process Spaces requests while your Mac is asleep and from remote clients; reading local Superwhisper recordings still needs your Mac. It's asynchronous (expect roughly 40 seconds to a few minutes per request), it stores request payloads, including transcripts, in your D1 database, and it takes more setup. Use it as a fallback, not as the default.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/designxdevelop/spaces-context-bridge)

The button deploys into your own Cloudflare account. The CLI deployment has been verified on fresh resources; the full browser-button flow hasn't yet. Then:

1. Follow [Cloudflare deployment](docs/DEPLOYMENT.md).
2. Connect your agent and the ChatGPT worker with [client setup](docs/CLIENTS.md#cloud-relay-clients-optional).
3. Set the owner scope in the [worker prompt](prompts/CHATGPT_WORKER_PROMPT.txt) and activate its `request.created` task.
4. Run the [acceptance checks](docs/VERIFICATION.md#cloud-relay-optional) with synthetic text before using real transcripts.

## Project status

MIT licensed, copyright 2026 Design X Develop. See [LICENSE](LICENSE). Every installation runs under its owner's accounts. The [product notes](docs/PRODUCT.md) cover how it works, what has been tested, and what hasn't. Spaces Context Bridge is independent of OpenAI, Anthropic, Superwhisper, Granola and Cloudflare.

## Support

Use [GitHub Issues](https://github.com/designxdevelop/spaces-context-bridge/issues/new/choose) for setup questions, bugs and feature requests. Include the version, client, setup step and a synthetic reproduction. Leave out keys, transcripts, notes and private links.

Report security vulnerabilities through [GitHub private vulnerability reporting](https://github.com/designxdevelop/spaces-context-bridge/security/advisories/new). See [SECURITY.md](SECURITY.md).
