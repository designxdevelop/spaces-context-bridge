#!/usr/bin/env node
import { promises as fs, constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT, parseOptions, resolveConfigPath, validateConfig, privateDirectory,
  privateFile, validateToken, validateState, resolveCodexBinary } from './config.mjs';

export const SETUP_HELP = `Usage: node direct/setup.mjs [--config FILE] [--allow-space SPACE_ID]... [--port PORT] [--codex-bin ABSOLUTE_PATH]
No --allow-space flags: a new config is read-only; an existing write allowlist is preserved.
--allow-space adds only the explicitly supplied Space IDs to the existing allowlist.
Config: --config, then BRIDGE_DIRECT_CONFIG, then $XDG_CONFIG_HOME/spaces-context-bridge/direct/config.json
(XDG_CONFIG_HOME defaults to ~/.config). Port defaults to 4791. Codex CLI must be installed and signed in.
`;

async function writeNew(file, content) {
  const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(content); await handle.sync(); }
  finally { await handle.close(); }
}

export async function setup({ args = process.argv.slice(2), env = process.env, home, output = process.stdout } = {}) {
  const options = parseOptions(args, { setup: true });
  if (options.help) { output.write(SETUP_HELP); return; }
  const configFile = resolveConfigPath(options, env, home);
  const directory = path.dirname(configFile);
  await privateDirectory(directory, { create: true });
  // Serialize setup so simultaneous invocations cannot lose explicit allowlist additions.
  const lockFile = path.join(directory, '.setup.lock');
  let lock;
  try { lock = await fs.open(lockFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw Object.assign(new Error('setup_locked'), { code: 'EEXIST', lockFile });
    throw error;
  }
  try {
    let config;
    let original;
    try { original = await privateFile(configFile); config = validateConfig(JSON.parse(original)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const existing = Boolean(config);
    if (existing) {
      // Never regenerate a missing key for an established config.
      validateToken((await privateFile(config.tokenFile)).trim());
      await validateState(config.stateDir);
      config = { ...config };
    } else {
      config = { port: DEFAULT_PORT, tokenFile: path.join(directory, 'owner-key'),
        stateDir: path.join(directory, 'state'), codexBin: '', allowedSpaceIds: [] };
    }
    const codexBin = await resolveCodexBinary(options.codexBin ?? (existing ? config.codexBin : undefined), env);
    // Preserve an existing path verbatim unless the owner explicitly changes it.
    if (!existing || options.codexBin !== undefined) config.codexBin = codexBin;
    if (options.port !== undefined) config.port = options.port;
    if (options.allowSpaces.length) config.allowedSpaceIds = [...new Set([...config.allowedSpaceIds, ...options.allowSpaces])];
    validateConfig(config);
    if (!existing) {
      await privateDirectory(config.stateDir, { create: true });
      await validateState(config.stateDir);
      try { validateToken((await privateFile(config.tokenFile)).trim()); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await writeNew(config.tokenFile, randomBytes(32).toString('base64url') + '\n');
      }
    }
    if (!existing) await writeNew(configFile, JSON.stringify(config, null, 2) + '\n');
    else if (JSON.stringify(JSON.parse(original)) !== JSON.stringify(config)) {
      const temp = path.join(directory, `.config-${randomBytes(12).toString('hex')}.tmp`);
      try { await writeNew(temp, JSON.stringify(config, null, 2) + '\n'); await fs.rename(temp, configFile); }
      finally { await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    }
    output.write(`Config: ${configFile}\nOwner key file: ${config.tokenFile}\nState directory: ${config.stateDir}\n`);
    output.write(`Next: ensure Codex CLI is signed in, then run npm run direct:start${options.config ? ' with -- --config FILE using the config path above' : ''}.\n`);
    return { configFile, config };
  } finally { await lock.close(); await fs.unlink(lockFile); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  setup().catch(error => {
    if (error.message === 'setup_locked') {
      process.stderr.write(`[direct-setup] setup_locked\nLock file: ${error.lockFile}\nNext: finish any running setup. If none is running, remove this stale lock file and retry.\n`);
      process.exitCode = 1; return;
    }
    // Do not echo file contents, tokens, or parser exception messages.
    const known = new Set(['invalid_arguments', 'invalid_space_id', 'invalid_port', 'codex_bin_must_be_absolute',
      'invalid_config_path', 'config_home_must_be_absolute', 'invalid_config', 'unsafe_directory',
      'unsafe_private_directory', 'unsafe_private_file', 'unsafe_state_file', 'invalid_local_credential', 'codex_not_found']);
    process.stderr.write(`[direct-setup] ${known.has(error.message) ? error.message : 'setup_failed'}\n`);
    process.exitCode = 1;
  });
}
