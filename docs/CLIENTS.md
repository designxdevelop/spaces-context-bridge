# Client setup

**Status:** setup instructions, not a claim of verified interoperability. Use your own HTTPS origin, with `/mcp` appended. Agent and worker connections use separate high-entropy connection codes. The deployment stores their SHA-256 base64url digests as `AGENT_LOGIN_HASH` and `WORKER_LOGIN_HASH`; do not paste codes into chats or configuration files. A human must sign in and approve each connection on the correct origin.

For **T3 Code, OpenCode CLI, and optional Executor**, see [the dedicated guide](CLIENTS_T3_OPENCODE_EXECUTOR.md). Public users retain these direct setups. The release owner’s personal agent connections should consolidate through Executor only after its verification; the ChatGPT worker stays direct with its separate role and event subscription.

## Claude app

In Customize → Connectors, add a custom remote connector with your `/mcp` URL. Select OAuth; this bridge implements dynamic registration, so choose **Register automatically** if a client identity choice is shown. Authenticate with the **agent** code and enable the connector in the conversation. Workspace administrators may need to add the connector first. Check `bridge_status` returns `role: agent`.

Follow Anthropic's [current connector instructions](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp). UI labels and plan access can differ. Never use the worker code in a general agent connector.

## Claude Code

Replace the example origin, then run from the project you want to authorize:

```sh
claude mcp add --transport http --scope local spaces-context https://bridge.example.com/mcp
```

Run `/mcp` inside Claude Code and complete browser authentication with the agent code. Local scope limits configuration to the current project; use user scope only if you deliberately want it across projects. Verify the role via `bridge_status`. See [official MCP setup](https://code.claude.com/docs/en/mcp).

## ChatGPT Work Cloud worker

1. In ChatGPT Plugins, add a custom MCP server at your `/mcp` endpoint with OAuth, install it, and authenticate using the **worker** code. Review the discovered tools. See [OpenAI's connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt).
2. Start an authorized Work chat on the web, or Work with Cloud selected in the desktop app. Enable the bridge and the available Spaces/Meetings tools. Confirm `bridge_status` returns `role: worker`.
3. Fill in the scope block in [the prompt](../prompts/CHATGPT_WORKER_PROMPT.txt). Leave writes disabled until you have named exact destinations and allowed actions. Submit the prompt and request a subscription to `request.created` with empty filter arguments.
4. Confirm the server receives `events/subscribe`, verifies the signed callback, and stores the subscription. Then verify a synthetic event wakes the worker and completes a request. Follow [acceptance checks](VERIFICATION.md).

This follows the [MCP Events test workflow](https://developers.openai.com/plugins/build/mcp-events). `request.created` is this bridge's event name, not a built-in OpenAI event. The host supplies the callback and signing secret; do not invent either. If the account cannot discover or subscribe to custom events, stop at **activation blocked**. Authentication, tools/list, a manually executed pending-request call, and ordinary scheduled-task support are not substitutes for event activation.

## Official Superwhisper MCP (optional, local)

Superwhisper's [official CLI/MCP announcement](https://superwhisper.com/blog/cli-mcp) documents the local `superwhisper mcp` server. Install using the vendor's [CLI instructions](https://superwhisper.com/cli), review the installer before running it, and locate the executable with `command -v superwhisper`.

For Claude Code, substitute that absolute executable path:

```sh
claude mcp add --transport stdio --scope local superwhisper -- /absolute/path/to/superwhisper mcp
```

For Claude Desktop, use its local MCP configuration facility (see [Anthropic’s local-server guidance](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)) and merge this entry without replacing existing servers:

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

This is a local stdio server, not a remote URL for the cloud connector form. Confirm initialization and tool discovery without reading history. Only retrieve recordings the owner selects; review content and destination before calling `save_transcript`. The official July CLI announcement predates the October Meetings release, so it does not establish coverage of every new Meetings record. Verify supported records in the installed CLI before promising import. Installing MCP does not upload anything to this bridge or grant a cloud worker access to a Mac.
