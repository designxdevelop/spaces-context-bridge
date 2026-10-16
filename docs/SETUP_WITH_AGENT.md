# Set up with your chosen agent or MCP host

Copy [the setup prompt](../prompts/SETUP_AGENT_PROMPT.txt) into the agent you want to perform setup. Fill the choices at the top, or let it ask for missing choices. Use an existing bridge endpoint, explicitly select Cloudflare, or name another backend host. Keep credentials out of the prompt.

The workflow stays the same: **other agent → bridge → ChatGPT → actual Spaces Page → verified result**. This setup does not introduce a copied-note store.

## Four roles

| Role | Purpose |
| --- | --- |
| Requester | Claude, Codex, OpenCode, a T3 provider or another MCP client submits agent-role requests. |
| Router (optional) | Executor or another router shares the agent connection across clients. |
| Backend | Runs the authenticated relay, durable queue, leases and signed event delivery. |
| Processor | ChatGPT connects directly as worker, receives events and uses authorized Spaces tools. |

The backend Worker relays and stores requests; the ChatGPT worker is the authorized cloud task that acts on Spaces. The cloud event route needs no local daemon. A local Superwhisper MCP connection serves selected local recordings and is a separate component.

An agent/client host and a backend host are different choices. Configuring MCP in a client does not deploy a server or provide that client with direct Spaces access.

## Backend choices

Cloudflare Worker + D1 is the **currently implemented backend**, with local and fresh hosted OAuth/protocol evidence. The [Cloudflare quickstart](DEPLOYMENT.md) is an optional concrete deployment route. The [release review](RELEASE_REVIEW.md) records the remaining event and full-workflow gates.

An existing deployment can be connected without provisioning anything. Another backend needs an adapter for runtime lifecycle, durable atomic storage and scheduled recovery, plus the same OAuth/protocol/security and workflow tests. **No alternative backend adapter is shipped yet.** The prompt inspects the chosen host and produces a scoped implementation plan rather than silently selecting Cloudflare or claiming compatibility.

## Example choices

Connect through an existing Executor:

```text
REQUESTER: T3 Code and OpenCode
CONNECTION: my existing Executor
BACKEND: existing bridge at <HTTPS_ORIGIN>/mcp
PROCESSOR: ChatGPT Work on web
Preserve my existing client entries until acceptance passes.
```

Choose your own deployment host:

```text
REQUESTER: <my client and version>
CONNECTION: <direct or my router>
BACKEND: <my chosen host>
PROCESSOR: ChatGPT Work on web
Inspect the host first. Identify required adapters and tests. Preserve the original ChatGPT-mediated lookup/edit/save workflow.
```

Paste the full prompt after those choices. The [client examples](CLIENTS_T3_OPENCODE_EXECUTOR.md) cover version-specific configuration; the [ChatGPT processor prompt](../prompts/CHATGPT_WORKER_PROMPT.txt) defines owner scope and processing rules.

## What counts as done

Verify actual requester tool calls, a host-created event subscription with signed callback verification, event-triggered processing, and the three synthetic bridge round trips. Independently check each source or Page effect. Preserve request IDs on timeout and reconcile prior effects before retries.

If ChatGPT exposes tools but lacks native event-task creation, report that exact blocker with the surface, version and sanitized evidence. Check current official [MCP Events requirements](https://developers.openai.com/plugins/build/mcp-events) and [event-task permissions](https://learn.chatgpt.com/docs/automations). Human sign-in, consent and any required workspace permission remain with the owner. A status call or direct Pages edit cannot substitute for the [acceptance gates](VERIFICATION.md).
