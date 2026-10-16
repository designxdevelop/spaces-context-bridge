# Spaces Context Bridge

**0.1.5 — private release candidate; synthetic end-to-end workflow verified.** A self-hosted, single-owner MCP relay for asking a ChatGPT Work Cloud worker to look up context, edit an authorized Page, or save a selected transcript as a Page.

The bridge has **no direct Spaces access**. It stores requests in Cloudflare D1; a separately authorized ChatGPT worker uses the owner's available tools. OAuth authentication is not worker-event activation. A queued request is not a completed operation. There is no automatic transcript sync.

## Release status

Fresh Cloudflare CLI deployment, hosted OAuth/protocol checks, and all three synthetic bridge operations through **T3/Codex → Executor → bridge → ChatGPT cloud event task → actual Spaces Pages** have passed. Lookup sources, the bounded Page edit and the verbatim transcript Page were independently verified. No local daemon was needed for this cloud route. This does not establish production readiness, every client, automatic transcript sync or the public deployment button. See [evidence and remaining gates](docs/RELEASE_REVIEW.md). Licensed under MIT, copyright 2026 Design X Develop; see [LICENSE](LICENSE).

## What it is intended to do

- `lookup_context`: enqueue a question for authorized Spaces/Meeting sources; retrieve sources with `get_result`.
- `request_document_edit`: request a bounded edit to an exact Page ID or URL, within the owner's configured scope.
- `save_transcript`: enqueue a selected transcript and destination Space; creates a Page, not a native ChatGPT Meetings recording.
- `bridge_status`: report role and subscription state. `worker_connected: true` alone does not prove the worker processes requests.

Claude app and Claude Code are agent clients. See [T3 Code, OpenCode CLI, and optional Executor](docs/CLIENTS_T3_OPENCODE_EXECUTOR.md) for additional setups. Public users can keep direct individual-client connections; Executor is optional. For the release owner’s personal setup, consolidate agent access into Executor only after verification. Keep the ChatGPT worker direct because it needs separate worker permissions and events. The ChatGPT worker is a different role with queue-processing tools. Official Superwhisper MCP runs locally and is separate from this remote relay. “Private” means owner-operated and access-controlled, not local-only processing or end-to-end encryption.

## Choose your setup

Use the [setup prompt for your chosen agent or MCP host](docs/SETUP_WITH_AGENT.md) to connect an existing endpoint or plan a deployment on your chosen backend. Cloudflare Worker + D1 is the currently implemented backend; other hosts require adapters and acceptance testing. An MCP client/router is separate from the backend server. The original ChatGPT-mediated Spaces lookup/edit/save workflow stays the same.

## Cloudflare deployment option

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/designxdevelop/spaces-context-bridge)

**Prepared button, not a verified deployment path.** The repository is private during preparation. The button requires a public source repository, so it is inactive while this repo is private. It does not complete human authentication, worker activation, or acceptance testing. Cloudflare documents this [official button format and resource provisioning](https://developers.cloudflare.com/workers/platform/deploy-buttons/).

1. Follow [fresh deployment](docs/DEPLOYMENT.md) using a new Worker and D1 database.
2. Connect your agent client and ChatGPT worker using [client setup](docs/CLIENTS.md); enter connection codes only on the consent page.
3. Set the owner scope in the [worker prompt](prompts/CHATGPT_WORKER_PROMPT.txt), then activate `request.created`.
4. Run the disposable [acceptance checks](docs/VERIFICATION.md). Keep real transcripts out until they pass.

No publisher account ID, database ID, personal origin, Page ID, or connection code should be reused. The repository URL above identifies source code, not a running service.

## Architecture and privacy

An agent calls the HTTPS `/mcp` endpoint → the Worker authenticates and queues a request in D1 → a signed event wakes the ChatGPT worker → it claims the request and uses authorized tools → it records a verified result → the original client polls `get_result`.

The Worker stores payloads and results, including submitted transcript text. Event notifications contain a request ID and kind; the worker subsequently retrieves the payload. Returned context passes through D1 and the requesting model provider. See [data flow and operations](docs/OPERATIONS.md) and [security](SECURITY.md).

## Costs and limits

Cloudflare Workers and D1 have free allowances, but this project has no measured monthly cost. Workers Paid starts with a $5 monthly subscription plus applicable usage. D1 charges by rows read/written and storage beyond included limits. Check [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) before deployment. ChatGPT/Claude plans and usage, Superwhisper features, and optional domains are separate. No OpenAI API key is required by this relay's source; that does not make ChatGPT Work execution free.

One deployment represents one owner. It is not a tenant-isolated service for unrelated people. Page authorization is enforced by worker instructions and source permissions, not by a server-side Page allowlist. Cleanup currently removes requests by creation age after seven days when cron runs. Retries, leases, and request idempotency do not guarantee exactly-once Page edits.

[Research and compatibility](docs/RESEARCH.md) covers official product facts and access limits. [Optional companion design](docs/COMPANION_DESIGN.md) describes a future opt-in transcript sender; it is not implemented. [Contributing](CONTRIBUTING.md) explains local checks. This project is independent of OpenAI, Anthropic, Cloudflare, Superwhisper, and Granola.
