# Official research and compatibility

Cloud-relay product research was reviewed October 15, 2026; direct-adapter documentation was checked October 16, 2026. These are source findings, not substitutes for the tests and limits in [release verification](RELEASE_REVIEW.md).

## Local direct runtime

OpenAI documents [Codex app-server](https://learn.chatgpt.com/docs/app-server), including `mcpServer/tool/call`, per-thread MCP inventory and tool approval requests. The local adapter uses that RPC with fixed native Spaces/Meetings tools and an ephemeral thread; it does not start an inference turn. The installed [Codex CLI](https://learn.chatgpt.com/docs/codex/cli) supplies the owner sign-in. The required connectors must be callable for that account; these docs do not guarantee eligibility for every new account. Upstream approvals are refused by this adapter and require human action.

Superwhisper is a separate local MCP source. The adapter saves selected text into actual Spaces Pages; neither route imports a native ChatGPT Meeting recording. The recommended runtime is local Node, not Sites or Cloudflare.

## ChatGPT Space, Meetings and Work

OpenAI describes [Space](https://learn.chatgpt.com/docs/space) as a home for pages, files and shared work. Content copied onto a Page is available to that Page's audience; linking a source does not transfer its permissions. This supports the destination model, not a public direct Spaces API for this relay.

[ChatGPT Work](https://learn.chatgpt.com/docs/enterprise/chatgpt-work-overview) uses the tools and access available to the authorized user. Availability depends on execution environment and workspace policy. The original 0.1.x cloud snapshot exposes Pages/Meeting-related tools through a ChatGPT-mediated workflow; public product docs reviewed here do not establish a native Meetings import API. Saving transcript text as a Page does not create a native recording. A Zoom follow-up workflow or a “My Meetings” label is not evidence of that capability.

OpenAI's [MCP Events guide](https://developers.openai.com/plugins/build/mcp-events) documents event discovery, subscription, callback verification, signed delivery, refresh and unsubscribe. It explicitly describes testing a plugin event in Work on web or Work Cloud on desktop. The bridge defines `request.created`; it is not a built-in trigger name. This documentation establishes a testable integration path, not that this account has activated it. Signed delivery, worker processing, and verified external effects remain distinct gates.

The separate [scheduled-task guide](https://learn.chatgpt.com/docs/automations) lists supported Gmail, Slack and GitHub triggers and surface-specific availability. Do not use that narrower list to claim custom MCP events are impossible, or use scheduled-task availability to claim they already work. Follow the plugin-specific events guide for this project.

[Connect and test a plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt) documents adding a custom MCP endpoint and configuring authentication. OAuth authenticates a role; it does not create a monitoring task. No live connection was changed during this research.

## Sites runtime feasibility

[Sites documentation](https://learn.chatgpt.com/docs/sites) establishes hosted web apps, runtime secrets, D1/R2 options, and HTTP/HTTPS/WebSockets. It also warns that some background services and hosting patterns are unsupported. A Site's audience access and application sign-in are separate controls.

**Inference:** a review dashboard may fit Sites, but these facts do not establish drop-in hosting for this Worker. Before proposing a port, prove the entrypoint/runtime, D1 binding and migration behavior, scheduled retry/cleanup execution, outbound signed callbacks, public OAuth metadata/consent routes and stable origin. Cloudflare remains the implemented cloud-relay host; the recommended direct adapter instead runs as a local Node process. No Sites project was created or deployed, and no automatic access to Space follows from hosting a Site.

## Superwhisper facts and naming

The official [changelog](https://superwhisper.com/changelog) dates **3.0.0 to October 15, 2026** and labels the new feature **Meetings**: recording, transcription, summaries, speaker identification, and a separate Meetings tab. It also lists 3.0.1 on that date. This research did not establish a separately named “Superwhisper Notes” product launch; use “Superwhisper meeting notes” descriptively.

The [Meetings page](https://superwhisper.com/meetings) describes a Mac-only launch, offline model options, local storage, and no bot joining calls. Those are vendor claims, not independent performance/privacy tests. Cloud models and sending content onward change the data flow.

The official [CLI and MCP announcement](https://superwhisper.com/blog/cli-mcp) is dated **July 16, 2026**. It documents history search/export and `superwhisper mcp`. The release predates Meetings 3.0; confirm new Meeting-record coverage in the installed CLI rather than assuming it. See [CLI installation](https://superwhisper.com/cli). No recordings were read during that product-source research. Subsequent local acceptance verified installed Superwhisper meeting listing and reading; no automatic export or sync is implemented.

## Client and hosting sources

Use Anthropic's [remote connector setup](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) and [Claude Code MCP guide](https://code.claude.com/docs/en/mcp) for client configuration. They establish available connection mechanisms, not this server's verified compatibility. Additional clients and optional aggregation are tracked in [T3/OpenCode/Executor](CLIENTS_T3_OPENCODE_EXECUTOR.md).

Cloudflare documents the [deployment button](https://developers.cloudflare.com/workers/platform/deploy-buttons/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [database export/import](https://developers.cloudflare.com/d1/best-practices/import-export-data/) and [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/). Check current account limits before relying on a free tier or a recovery window.

## Acceptance coverage

See [release review](RELEASE_REVIEW.md) for direct-adapter contracts, clean private setup, live synthetic Page acceptance and historical cloud evidence. Superwhisper source reads and synthetic destination writes are separate checks; they do not prove a real recording was imported end to end. ChatGPT Meetings returned no private notes, so successful real-note retrieval remains unverified. Public-button/fresh-human signup, additional live clients, long-running expiration and interrupted external-write recovery retain their stated limits. Support uses GitHub Issues and GitHub private vulnerability reporting. A fixture created through unrelated Pages tools is not evidence that the chosen MCP route performed the operation.
