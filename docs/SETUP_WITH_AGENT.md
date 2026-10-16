# Set up with your agent

If you'd rather not run the steps yourself, copy [the setup prompt](../prompts/SETUP_AGENT_PROMPT.txt) into the coding agent you want to use. Fill in the choices at the top, or let the agent ask. It sets up the local adapter for Spaces reads and bounded edits; meeting sources are optional.

You still do the parts that need a human: signing in to Codex, optional Superwhisper or Executor, entering keys into private credential forms, and choosing which Spaces are writable. The agent should never ask you to paste a key into the chat.

## Example: per-client connection

```text
Checkout: https://github.com/designxdevelop/spaces-context-bridge
Agent clients on this Mac: Codex and Claude Code
Connection: per client
Writable Spaces: decide after listing them
Meeting sources: NONE
```

The agent checks prerequisites, runs `npm run setup` for a read-only config, starts the server, connects your clients using an environment variable for the key, and checks that `bridge_direct_status` and `list_spaces` work. Once you pick Spaces, it reruns setup with `--allow-space`, restarts the server, and adds [the agent prompt](../prompts/DIRECT_AGENT_PROMPT.txt) to your standing instructions.

## Example: through Executor

```text
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
