# T3 Code, OpenCode and Executor clients

Connect T3 providers to the local adapter directly or through a personal Executor connection.

## Direct adapter

The adapter runs on your Mac at `http://127.0.0.1:4791/mcp` and authenticates with the owner key that `npm run setup` created. Per-client configs are in [client setup](CLIENTS.md#direct-adapter). This section covers what's specific to T3 Code and Executor.

### Verified route: T3 Code → Executor → adapter

This is the route tested live: a T3 Code session on the Codex provider, calling a personal Executor connection that points at the adapter. Reads, a bounded edit, transcript and notes saves, independent readbacks and same-artifact retries all passed through it. See the [evidence](RELEASE_REVIEW.md#observed-live-behavior).

1. Start the adapter with `npm start` on the same Mac as Executor.
2. In Executor, add a personal remote MCP connection (streamable HTTP) to `http://127.0.0.1:4791/mcp` with bearer or header authentication. Enter the key in Executor's private credential form, never in a chat. Keep it out of shared and organization catalogs.
3. Connect each T3 provider to Executor using Executor's own client instructions.
4. In a fresh T3 session, ask: "Through Executor, call the Spaces Context Bridge direct adapter's `bridge_direct_status` tool with `check_upstream: true` and report the actual response." Expect your configured allowlist and upstream availability. A connection showing up in a list isn't proof; the call has to succeed.
5. Add [the agent prompt](../prompts/DIRECT_AGENT_PROMPT.txt) to each provider's persistent instructions, or to the Executor connection notes if agents can see them.

### T3 providers without Executor

T3 Code runs providers in the selected environment. Configure the adapter where that provider runs, and set `SPACES_DIRECT_KEY` in that environment. Use the Codex, Claude Code or OpenCode config from [client setup](CLIENTS.md#direct-adapter). After changing config, use T3's **Settings > Providers > Refresh provider status**, start a fresh session and call `bridge_direct_status`. This path hasn't been tested live yet. See the [T3 documentation index](https://raw.githubusercontent.com/pingdotgg/t3code/main/docs/README.md) for provider-specific config directories.

T3's own MCP server, offered to outside agents, exposes T3 orchestration. Its URL isn't the adapter's.
