# T3 Code, OpenCode, and Executor clients

These are agent-side integration instructions for Spaces Context Bridge 0.1.5.
Replace `https://bridge.example.invalid/mcp` with your own deployment's `/mcp`
endpoint. Each deployment belongs to one owner and uses that owner's Cloudflare
resources. The bridge queues work for ChatGPT; it does not access Spaces directly.

## Choose an agent connection path

Both paths are supported public setup options:

- **Direct:** configure the bridge in each individual client and authorize each
  connection with the **agent** role.
- **Through Executor:** connect the bridge once in your own Executor host using
  per-user OAuth, then expose that Executor connection to your coding clients.

For the maintainer's personal setup, consolidate all agent access through the
existing Executor **after verification**. Keep existing direct connections until
the Executor route passes the acceptance checks below. Public users can choose
either path without depending on the maintainer's Executor or personal resources.

The **ChatGPT worker always connects directly to the bridge**, using its separate
worker role and event subscription. Never put a worker connection code or worker
OAuth credential into Executor or a coding client. Agent access cannot claim or
complete requests and cannot subscribe as the worker.

Executor is an optional tool router, not a central note service. Request text,
transcripts, and returned context pass through whichever Executor host you
configure, as well as the bridge and ChatGPT. Choose its operator and retention
settings accordingly. This setup does not upload the Cloudflare Worker source to
Executor. A local transcript MCP server alone does not sync recordings to ChatGPT.

## Direct OpenCode CLI setup

Check `opencode --version` before choosing a file. The examples start disabled so
copying an example does not initiate a connection. Merge only the bridge entry
into an existing configuration; never replace a global config that contains
provider logins or other servers.

### OpenCode 2

Use [opencode-v2.json](../examples/clients/opencode-v2.json) in your project's
`opencode.json` (or merge it into `opencode.jsonc`). Replace the URL and set
`disabled` to `false`. Run:

```sh
opencode mcp auth spaces_context
opencode mcp list
```

On the bridge consent page choose **Agent** and enter your private agent connection
code there. Do not paste the code into a prompt, config file, or command line.

V2 nests connections under `mcp.servers`, uses `disabled`, and names OAuth fields
in snake_case, such as `client_id` and `callback_port`. This bridge supports dynamic
registration; the example needs no pre-registered ID or client secret.
`protocol: "auto"` permits the newer discovery handshake; `legacy` uses the older
handshake, and `2026-07-28` requires the newer revision. Test each mode you intend
to support against your deployment.

Code Mode is enabled by default. Tools may appear through `execute` as
`tools.spaces_context.bridge_status(...)` rather than as individual top-level
tools. If a consumer requires individual tools, set `codemode: false` on this
server and recheck discovery. See the [official V2 MCP reference](https://opencode.ai/v2/docs/mcp-servers/).

### OpenCode 1

Use [opencode-v1.json](../examples/clients/opencode-v1.json), replace the URL, and
set `enabled` to `true`. Run `opencode mcp auth spaces_context` and then
`opencode mcp list`; authorize the agent role in the browser.

V1 places the server directly under `mcp` and uses `enabled`. Its optional OAuth
client fields are `clientId` and `clientSecret`. Do not copy V2's nesting, protocol
selection, or Code Mode settings into V1. The minimal V1 example uses the older MCP
handshake and dynamic registration. See the [official V1 MCP reference](https://opencode.ai/docs/mcp-servers/).

Do not run V1 and V2 against the same user data: V2 migrates OpenCode's database.
The automated CLI check below targets V2 only; V1 runtime compatibility remains
unverified.

## T3 Code: configure the selected provider

T3 Code runs providers in the selected environment. Configure and authenticate the
bridge where that provider runs, with its actual config directory and account.
An MCP connection in another desktop app or provider does not establish this
provider's access. See the [T3 documentation index](https://raw.githubusercontent.com/pingdotgg/t3code/main/docs/README.md).

### Codex provider

Merge [codex.toml](../examples/clients/codex.toml) into the chosen Codex home's
`config.toml`, replace the URL, and set `enabled = true`. Then, with `CODEX_HOME`
set to the home used by that T3 provider instance if it is customized, run:

```sh
codex mcp login spaces_context --scopes agent
codex mcp list
```

Choose Agent on the bridge consent page. Alternatively, for a new entry use
`codex mcp add spaces_context --url https://bridge.example.invalid/mcp` after
replacing the placeholder, followed by the login command. Restart or reconnect
the provider session and verify an actual bridge tool call in T3.

T3's [Codex provider guide](https://raw.githubusercontent.com/pingdotgg/t3code/main/docs/user/providers-codex.md)
explains shared and shadow homes; select the configured shared home rather than
copying credentials between directories. See [Codex MCP configuration](https://developers.openai.com/codex/mcp)
for the CLI and TOML format.

### Claude provider

Merge [claude.mcp.json](../examples/clients/claude.mcp.json) into a project
`.mcp.json`, replace the URL, and approve that project server when prompted.
For user-scoped setup instead, run this with the provider's `CLAUDE_CONFIG_DIR`
if customized:

```sh
claude mcp add --transport http --scope user spaces_context https://bridge.example.invalid/mcp
```

Replace the placeholder before running. Start Claude Code with that same
configuration, use `/mcp` to authenticate, and choose Agent on the consent page.
Reconnect the T3 provider session and verify `bridge_status` from T3.
The [T3 Claude guide](https://raw.githubusercontent.com/pingdotgg/t3code/main/docs/user/providers-claude.md)
describes configuration directories and remote environments;
[Claude's MCP reference](https://code.claude.com/docs/en/mcp) covers project approval
and OAuth. Claude app connectors and Claude Code project/user entries have
separate setup paths; check the one used by the running provider.

### OpenCode provider

Use the version-matched OpenCode setup above on the environment hosting OpenCode.
T3 currently documents support for OpenCode 1.14.19+ and V2 2.0.18+, with limited
support for V1. An external OpenCode server reads its own configuration, not the
config on the machine displaying T3.

After changes, use T3's documented **Settings > Providers > Refresh provider
status** for that environment. Native OpenCode config can remain cached in the
local helper: allow 30 seconds without catalog refreshes or generation, then
refresh again. An external server may need its own restart. Start a fresh session
and check bridge tools. See the [T3 OpenCode guide](https://raw.githubusercontent.com/pingdotgg/t3code/main/docs/user/providers-opencode.md).

T3's MCP server offered to outside agents exposes T3 orchestration; its URL is
**not** the Spaces Context Bridge endpoint. These instructions add the bridge to
the provider or to its existing Executor connection. They do not configure a
second T3 orchestration server.

## Optional Executor route

This repository supplies a setup request, not a hosted connection. The following
tool names and fields were checked against the installed Executor catalog.
Rediscover their schemas on your host before running setup:

1. Read Executor's `skills({ name: "execute" })`. Search for and describe
   `executor.mcp.addServer`, `executor.coreTools.oauth.probe`,
   `executor.coreTools.oauth.clients.registerDynamic`, and
   `executor.coreTools.oauth.start` using `tools.search` and `tools.describe.tool`.
2. Inspect existing registrations/connections first. For a new integration, pass
   [executor-add-server.json](../examples/clients/executor-add-server.json) to
   `tools.executor.mcp.addServer` after replacing `endpoint`. Keep the returned
   `data.slug`; the authentication template is `agent-oauth`. Check `result.ok`
   after each tool call, rather than treating a returned object as success.
3. Call `tools.executor.coreTools.oauth.probe({ url: endpoint })`. Register a
   public OAuth client with `oauth.clients.registerDynamic`: use `owner: "user"`,
   a unique client `slug`, `scopes: ["agent"]`, `originIntegration` set to the
   integration slug, and the probe's `issuer`, `registrationEndpoint`,
   `authorizationUrl`, `tokenUrl`, `resource`, and
   `tokenEndpointAuthMethodsSupported`. Let Executor choose its callback unless
   your host requires an explicit one; register and use the same exact URI.
4. Call `oauth.start` with that returned `data.client`, `clientOwner: "user"`,
   `owner: "user"`, a unique connection `name`, `integration` set to the returned
   integration slug, and `template: "agent-oauth"`. Follow the authorization
   handoff privately and select Agent. A `status: "redirect"` response is a
   sign-in step, not a connected result. Finish the host's callback/resume flow
   and confirm a saved connection before continuing. Never print OAuth state,
   authorization URLs, tokens, or full connection objects into diagnostic logs.
5. Search the resulting connection for `bridge_status` and describe its exact
   returned tool path. Call through that path with `{}`. Do not guess connection
   addresses. Repeat the acceptance matrix through Executor, then through every
   provider intended to use it.

The bridge registration uses `versionNegotiation: "auto"`; Executor also supports
`legacy`. Selecting a negotiation option is not evidence of successful protocol
interoperation. If discovery fails, preserve the error without credentials and
test the older handshake before changing the deployment.

Connect each coding provider to your **existing Executor** using that host's own
client setup instructions. No universal Executor URL or transport is assumed
here. Do not add a second direct bridge entry when choosing this route.

For personal consolidation, first verify this route in an isolated test setup.
Then verify the existing personal Executor connection with an authorized
disposable Page and synthetic transcript. Only after it passes, remove the
individual direct agent entries and their client OAuth grants using each client's
documented removal/logout flow. Do not remove the separate ChatGPT worker
connection or unrelated MCP servers. Inventory the intended provider sessions
again to confirm the bridge is reached through Executor exactly once.

## Acceptance matrix: connection is not completion

Run this matrix independently for direct clients and the Executor route. Record
client version, provider instance/environment, handshake mode, time, request ID,
final status, and source/receipt link. Keep secrets and transcript content out of
test logs. Use a fresh deployment and an owner-authorized disposable Page.

| Check | Required evidence | Status of these examples |
| --- | --- | --- |
| Config parse | CLI reads the intended file and preserves every server field; invalid-protocol control does not load that server | V2 2.0.22 checked locally; V1/T3 runtime pending |
| Agent OAuth | Consent finishes; `bridge_status.role` is `agent` | Executor review connection returned `role: agent`; direct provider runtime checks pending |
| Discovery | Authenticated `tools/list` contains exactly `bridge_status`, `lookup_context`, `request_document_edit`, `save_transcript`, `get_result` | Executor discovered all five agent tools; other clients pending |
| Role denial | Agent call to `pending_requests` and agent `events/subscribe` are rejected; no worker operations exposed | Live negative check pending; use a protocol harness if the client hides unlisted tools |
| Worker readiness | Separate ChatGPT connection has role `worker`; actual `request.created` subscription and signed callback are verified | ChatGPT worker OAuth verified; after rescan, review worker tool call verified; host subscription capability still absent |
| Lookup/edit/ingest | Submit via the agent route, retrieve that ID with `get_result` to a terminal state, then independently verify the source or Page result | Full bridge E2E pending |

`worker_connected: true` reports a current authorized subscription; it does not
prove callback delivery or successful processing. A returned request ID or a
`queued`/`processing` result is not completion. A terminal `failed` result is not a
successful lookup, edit, or save. A direct Pages tool test bypasses the bridge and
cannot satisfy this matrix. Transcript ingestion creates a Page, not a native
ChatGPT Meetings recording.

## Verify from any Executor-connected client

Ask the client: “Through Executor, find my Spaces Context Bridge connection and call `bridge_status`. Report the actual response.” The client must discover and call the connection, rather than infer success from the saved-connection list. Expect `role: agent`; `worker_connected: false` means the separate ChatGPT event worker is not ready. A successful status call proves routing and authenticated tool execution only. Once the worker is active, run the synthetic lookup/edit/ingest checks above from that same client.

## Repeatable local config checks

From the repository root:

```sh
node --test test/client-config.test.mjs
BRIDGE_CHECK_OPENCODE=1 node --test test/client-config.test.mjs
```

The opt-in check requires an installed OpenCode 2 binary on `PATH`. It creates a
temporary project plus separate `XDG_CONFIG_HOME`, `XDG_DATA_HOME`,
`XDG_CACHE_HOME`, `XDG_STATE_HOME`, and `OPENCODE_CONFIG_DIR`. It passes an
allowlisted environment, disables the background service in that temporary
profile, and loads the disabled V2 example with `opencode debug config`. It
compares the actual parsed server fields with the example, then checks an invalid
protocol value as a negative control. OpenCode 2.0.22 can exit successfully while
omitting an invalid MCP section, so exit code alone does not prove a valid config.
Automatic model-catalog fetches and updates are disabled. The check does not read
or overwrite the user's global config, launch OAuth, call a model, or connect to
a deployed bridge. The short-lived private helper exits with the command;
temporary files are deleted afterward.

These checks establish example/config compatibility only. No new live bridge E2E,
personal Executor migration, or paid model/API call is claimed by this document.
