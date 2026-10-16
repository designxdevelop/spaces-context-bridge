# Set up with your agent

If you'd rather not run the steps yourself, copy [the setup prompt](../prompts/SETUP_AGENT_PROMPT.txt) into the coding agent you want to use. Fill in the choices at the top, or let the agent ask. It sets up the direct adapter by default and only touches the cloud relay if you choose it.

You still do the parts that need a human: signing in to Codex, Superwhisper, Executor or Cloudflare, entering keys into private credential forms, and choosing which Spaces are writable. The agent should never ask you to paste a key into the chat.

## Example: direct adapter (recommended)

```text
Checkout: https://github.com/designxdevelop/spaces-context-bridge
Route: direct
Agent clients on this Mac: Codex and Claude Code
Connection: per client
Writable Spaces: decide after listing them
Meeting sources: Superwhisper
```

The agent checks prerequisites, runs `npm run direct:setup` for a read-only config, starts the server, connects your clients using an environment variable for the key, and checks that `bridge_direct_status` and `list_spaces` work. Once you pick Spaces, it reruns setup with `--allow-space`, restarts the server, and adds [the agent prompt](../prompts/DIRECT_AGENT_PROMPT.txt) to your standing instructions.

## Example: through Executor

```text
Route: direct
Agent clients on this Mac: T3 Code with Codex and OpenCode
Connection: my existing Executor
Writable Spaces: NONE for now
Meeting sources: Superwhisper, plus ChatGPT Meetings when I ask
```

The agent adds a personal Executor connection to `http://127.0.0.1:4791/mcp` and asks you to enter the key in Executor's private credential form. It keeps the connection out of shared catalogs and leaves existing connections in place.

## What counts as done (direct)

- `bridge_direct_status` and `list_spaces` return real results through each client you connected, not just a saved connection.
- `bridge_direct_status` shows the agreed allowlist. A fresh setup with none is read-only; existing permissions are preserved unless you explicitly remove them from `allowedSpaceIds` and restart.
- The agent prompt is in each host's standing instructions.
- Optionally, the [live acceptance checks](VERIFICATION.md#direct-adapter) pass with a disposable Space and synthetic text.

## Cloud relay (optional)

Pick `Route: cloud relay` only if you need requests to run while your Mac is asleep or from clients on another machine. It's asynchronous, stores payloads in your own Cloudflare D1 database, and needs a ChatGPT worker event task. The direct adapter and the cloud relay can coexist; keep the relay as a fallback if you already have it.

The cloud relay has four roles:

| Role | Purpose |
| --- | --- |
| Requester | Claude, Codex, OpenCode, a T3 provider or another MCP client submits agent-role requests. |
| Router (optional) | Executor or another router shares the agent connection across clients. |
| Backend | Runs the authenticated relay, durable queue, leases and signed event delivery. |
| Processor | ChatGPT connects directly as worker, receives events and uses authorized Spaces tools. |

Cloudflare Worker + D1 is the only implemented backend. See [Cloudflare deployment](DEPLOYMENT.md). An existing deployment can be connected without provisioning anything. Another backend would need an adapter for runtime lifecycle, durable atomic storage and scheduled recovery, plus the same OAuth, protocol, security and workflow tests. No alternative backend adapter ships today.

```text
Route: cloud relay
Agent clients: T3 Code and OpenCode
Connection: my existing Executor
Backend: existing relay at <HTTPS_ORIGIN>/mcp
ChatGPT processor: Work on web
Preserve my existing client entries until acceptance passes.
```

For the relay, done means actual requester tool calls, a host-created event subscription with signed callback verification, event-triggered processing, and the three synthetic round trips (lookup, edit, transcript), each independently checked. Keep request IDs on timeout and reconcile earlier effects before any retry. If ChatGPT exposes the tools but can't create the event task, report that exact blocker. Check the current [MCP Events requirements](https://developers.openai.com/plugins/build/mcp-events) and [event-task permissions](https://learn.chatgpt.com/docs/automations). A status call or a direct Pages edit can't substitute for the [cloud acceptance checks](VERIFICATION.md#cloud-relay-optional).
