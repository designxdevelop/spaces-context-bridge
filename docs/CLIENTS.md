# Client setup

Connect agents to the local adapter to read and edit ChatGPT Spaces Pages. Add Superwhisper only if you want an optional meeting source.

## Direct adapter

The adapter listens on `http://127.0.0.1:4791/mcp` and expects `Authorization: Bearer <owner key>` on every request. Any MCP client on the same Mac that supports streamable HTTP with a custom header can use it. Clients on another host, and cloud connectors such as ChatGPT app connectors, can't reach it.

**Status:** the T3 Code (Codex) → Executor → adapter route has been verified live. The other configs below follow each client's documented syntax but haven't been tested live yet.

Every example reads the key from an environment variable, so config files never hold it. Load the variable from the key file without echoing it. This is the default path; if you used a custom location, use the `Owner key file` path that `npm run setup` printed:

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

### ChatGPT app

ChatGPT's app connectors run in the cloud and can't reach a server on your Mac's loopback address. This client is unsupported by the local adapter.

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
