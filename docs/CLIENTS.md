# Client setup

This page covers three things: connecting agents to the direct adapter (recommended), adding Superwhisper's MCP server as a meeting source, and connecting clients to the optional cloud relay.

## Direct adapter

The adapter listens on `http://127.0.0.1:4791/mcp` and expects `Authorization: Bearer <owner key>` on every request. Any MCP client on the same Mac that supports streamable HTTP with a custom header can use it. Clients on another host, and cloud connectors such as ChatGPT app connectors, can't reach it.

**Status:** the T3 Code (Codex) → Executor → adapter route has been verified live. The other configs below follow each client's documented syntax but haven't been tested live yet.

Every example reads the key from an environment variable, so config files never hold it. Load the variable from the key file without echoing it. This is the default path; if you used a custom location, use the `Owner key file` path that `npm run direct:setup` printed:

```sh
export SPACES_DIRECT_KEY="$(cat ~/.config/spaces-context-bridge/direct/owner-key)"
```

The variable must be set in the environment the client starts from. If you'd rather not keep it in a shell profile, launch the client from a shell where you've just set it. Avoid passing the key as a command-line argument, which can end up in shell history and process listings.

### Codex

Add to `~/.codex/config.toml`, or the `config.toml` in your `CODEX_HOME`:

```toml
[mcp_servers.spaces_direct]
url = "http://127.0.0.1:4791/mcp"
bearer_token_env_var = "SPACES_DIRECT_KEY"
```

Run `codex mcp list` to confirm the entry, then ask Codex to call `bridge_direct_status`.

Not tested yet: the adapter starts its own Codex app-server with your default Codex home, so that process reads this same `config.toml`, including this entry. It may try to connect back to the adapter and fail without the key. Until this is verified, reaching the adapter from Codex through Executor (the tested route) is the safer choice. See [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

### Claude Code

Add to a project `.mcp.json`. Claude Code expands `${VAR}` in headers, so the file holds only the variable name:

```json
{
  "mcpServers": {
    "spaces_direct": {
      "type": "http",
      "url": "http://127.0.0.1:4791/mcp",
      "headers": {
        "Authorization": "Bearer ${SPACES_DIRECT_KEY}"
      }
    }
  }
}
```

Keep a custom variable name like `SPACES_DIRECT_KEY`: Claude Code leaves some reserved credential names empty in remote server headers. Approve the project server when prompted and check it with `/mcp`. Avoid `claude mcp add --header "Authorization: Bearer …"`, which puts the key on the command line. See [Claude Code MCP](https://code.claude.com/docs/en/mcp).

### OpenCode

Check `opencode --version`, then merge the matching entry. `oauth: false` tells OpenCode to use the header instead of looking for OAuth. Write `{env:NAME}` inside the JSON string; shell-style `$NAME` isn't expanded.

OpenCode 2 nests servers under `mcp.servers`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "spaces_direct": {
        "type": "remote",
        "url": "http://127.0.0.1:4791/mcp",
        "oauth": false,
        "headers": { "Authorization": "Bearer {env:SPACES_DIRECT_KEY}" }
      }
    }
  }
}
```

OpenCode 1 puts the server directly under `mcp`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "spaces_direct": {
      "type": "remote",
      "url": "http://127.0.0.1:4791/mcp",
      "oauth": false,
      "headers": { "Authorization": "Bearer {env:SPACES_DIRECT_KEY}" }
    }
  }
}
```

Check with `opencode mcp list`. See the [OpenCode 2](https://opencode.ai/v2/docs/mcp-servers/) and [OpenCode 1](https://opencode.ai/docs/mcp-servers/) MCP references.

### T3 Code

T3 Code runs Codex, Claude Code or OpenCode as providers. The verified route is through Executor (below). To configure a provider directly instead, use that provider's config above in the environment where T3 runs it, and make sure `SPACES_DIRECT_KEY` is set there. More detail is in [T3 Code, OpenCode and Executor](CLIENTS_T3_OPENCODE_EXECUTOR.md#direct-adapter).

### Executor

Executor is optional. It's useful if you want one connection shared by several agents.

1. Add a remote MCP server using streamable HTTP at `http://127.0.0.1:4791/mcp`, with bearer or header authentication.
2. Enter the key in Executor's private credential form so Executor stores it. Never paste it into a prompt or an agent chat.
3. Keep the connection personal (user-owned). Don't add it to a shared or organization catalog: anyone who can use the connection can read your Spaces and write to your allowed ones.
4. Executor must run on the same Mac, because the adapter only listens on loopback.
5. If your Executor shows connection notes to agents, add a short version of [the agent prompt](../prompts/DIRECT_AGENT_PROMPT.txt) there.

This key isn't related to the cloud relay's agent or worker connection codes. Don't mix them up.

### ChatGPT app

ChatGPT's app connectors run in the cloud and can't reach a server on your Mac's loopback address. Use the [cloud relay](#cloud-relay-clients-optional) if you need ChatGPT itself to process requests.

## Superwhisper MCP

Superwhisper's [CLI/MCP announcement](https://superwhisper.com/blog/cli-mcp) documents the local `superwhisper mcp` server. Install the CLI using the vendor's [instructions](https://superwhisper.com/cli) after reviewing the installer, then find the executable with `command -v superwhisper`.

For Claude Code, substitute that absolute path:

```sh
claude mcp add --transport stdio --scope local superwhisper -- /absolute/path/to/superwhisper mcp
```

For Codex, add to `config.toml`:

```toml
[mcp_servers.superwhisper]
command = "/absolute/path/to/superwhisper"
args = ["mcp"]
```

For Claude Desktop, use its local MCP configuration (see [Anthropic's local-server guide](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)) and merge this entry without replacing existing servers:

```json
{
  "mcpServers": {
    "superwhisper": {
      "command": "/absolute/path/to/superwhisper",
      "args": ["mcp"]
    }
  }
}
```

This is a local stdio server, separate from Spaces Context Bridge. Confirm it starts and lists its tools without reading your history. Have your agent fetch only the recordings you pick, and review the content and destination before saving. Installing it doesn't upload anything by itself. Check which meeting records your installed version supports before relying on it.

## Cloud relay clients (optional)

**Status:** setup instructions, not a claim of verified interoperability. Use your own HTTPS origin with `/mcp` appended. Agent and worker connections use separate high-entropy connection codes. The deployment stores their SHA-256 base64url digests as `AGENT_LOGIN_HASH` and `WORKER_LOGIN_HASH`; don't paste codes into chats or configuration files. A human must sign in and approve each connection on the correct origin.

For T3 Code, OpenCode CLI and Executor with the cloud relay, see [the dedicated guide](CLIENTS_T3_OPENCODE_EXECUTOR.md#cloud-relay-optional). The ChatGPT worker always connects directly, with its separate role and event subscription.

### Claude app

In Customize → Connectors, add a custom remote connector with your `/mcp` URL. Select OAuth; this bridge implements dynamic registration, so choose **Register automatically** if a client identity choice is shown. Authenticate with the **agent** code and enable the connector in the conversation. Workspace administrators may need to add the connector first. Check that `bridge_status` returns `role: agent`.

Follow Anthropic's [current connector instructions](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp). UI labels and plan access can differ. Never use the worker code in a general agent connector.

### Claude Code

Replace the example origin, then run from the project you want to authorize:

```sh
claude mcp add --transport http --scope local spaces-context https://bridge.example.com/mcp
```

Run `/mcp` inside Claude Code and complete browser authentication with the agent code. Local scope limits configuration to the current project; use user scope only if you deliberately want it across projects. Verify the role via `bridge_status`. See [official MCP setup](https://code.claude.com/docs/en/mcp).

### ChatGPT Work Cloud worker

1. In ChatGPT Plugins, add a custom MCP server at your `/mcp` endpoint with OAuth, install it, and authenticate using the **worker** code. Review the discovered tools. See [OpenAI's connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt).
2. Start an authorized Work chat on the web, or Work with Cloud selected in the desktop app. Enable the bridge and the available Spaces/Meetings tools. Confirm `bridge_status` returns `role: worker`.
3. Fill in the scope block in [the worker prompt](../prompts/CHATGPT_WORKER_PROMPT.txt). Leave writes disabled until you have named exact destinations and allowed actions. Submit the prompt and explicitly ask: "Create an event-triggered task for this bridge's `request.created` event with empty filters. Use the supplied owner scope and processing instructions. Do not add a timer." Confirm the task is saved and enabled.
4. Confirm the server receives `events/subscribe`, verifies the signed callback, and stores the subscription. Then verify a synthetic event wakes the worker and completes a request. Follow the [acceptance checks](VERIFICATION.md#cloud-relay-optional).

If the installed plugin is absent from the chat's tools, refresh its tools in plugin settings and explicitly select it in the Work chat before testing status.

This follows the [MCP Events test workflow](https://developers.openai.com/plugins/build/mcp-events). `request.created` is this bridge's event name, not a built-in OpenAI event. The host supplies the callback and signing secret; don't invent either. If the account can't discover or subscribe to custom events, stop at **activation blocked**. Authentication, `tools/list`, a manually executed pending-request call, and ordinary scheduled-task support are not substitutes for event activation.
