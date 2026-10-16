#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridge, createCodexUpstream, VERSION } from './adapter.mjs';
import { mcpDispatch } from './rpc.mjs';
import { createLoopbackServer } from './http.mjs';
import { parseOptions, resolveConfigPath, validateConfig, privateFile, validateToken, validateState } from './config.mjs';

export const SERVER_HELP = `Usage: node direct/http-server.mjs [--config FILE]
Config: --config, then BRIDGE_DIRECT_CONFIG, then $XDG_CONFIG_HOME/spaces-context-bridge/direct/config.json
(XDG_CONFIG_HOME defaults to ~/.config). Run npm run direct:setup first.
`;

export async function startServer({ args = process.argv.slice(2), env = process.env, home,
  output = process.stdout, log = category => process.stderr.write(`[spaces-context-bridge-direct] ${category}\n`) } = {}) {
  const options = parseOptions(args);
  if (options.help) { output.write(SERVER_HELP); return; }
  const configFile = resolveConfigPath(options, env, home);
  const config = validateConfig(JSON.parse(await privateFile(configFile)));
  const token = validateToken((await privateFile(config.tokenFile)).trim());
  await validateState(config.stateDir);
  const bridgeEnv = { ...env, BRIDGE_ALLOWED_SPACE_IDS: config.allowedSpaceIds.join(','),
    BRIDGE_ALLOWED_PAGE_IDS: config.allowedPageIds?.join(',') ?? '', BRIDGE_STATE_DIR: config.stateDir };
  const upstream = createCodexUpstream({ codexBin: config.codexBin, env: bridgeEnv, log });
  const bridge = createBridge({ upstream, env: bridgeEnv, stateDir: config.stateDir, log });
  const local = createLoopbackServer({ token, handleMessage: message => mcpDispatch(message, {
    serverInfo: { name: 'spaces-context-bridge-direct', version: VERSION },
    instructions: 'Direct route for the owner’s ChatGPT Spaces requests. Supported tools use the local Codex app-server with no model turn or event queue. Use the separately connected Superwhisper MCP as the default source for meeting recordings and notes; this adapter is the Spaces destination. Save selected meeting notes with save_meeting_notes and raw transcripts with save_transcript. Use meetings_find_all then meetings_fetch only when the owner asks for ChatGPT Meetings as a source; preserve source links and unavailable statuses. Read a Page and its instructions before a bounded edit. Saves require an explicit destination and stable source_id. Report unavailable or unsupported operations to the owner. Never replay an uncertain write through another route; reconcile it first.',
    listTools: bridge.listTools, callTool: bridge.callTool,
  }) });
  try { await local.listen(config.port); }
  catch (error) { await bridge.close(); throw error; }
  log('loopback_ready');
  return { configFile, config, server: local.server, close: async () => { await local.close(); await bridge.close(); } };
}

async function main() {
  const instance = await startServer();
  if (!instance) return;
  let quitting = false;
  const quit = async () => {
    if (quitting) return;
    quitting = true;
    const force = setTimeout(() => process.exit(1), 10000); force.unref();
    await instance.close(); process.exit(0);
  };
  process.on('SIGINT', quit); process.on('SIGTERM', quit);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(() => { process.stderr.write('[spaces-context-bridge-direct] startup_failed\n'); process.exit(1); });
}
