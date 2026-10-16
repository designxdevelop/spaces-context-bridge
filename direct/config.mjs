import { promises as fs, constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_PORT = 4791;
export const SPACE_ID = /^page_space_[a-zA-Z0-9]+$/;
const owned = st => !process.getuid || st.uid === process.getuid();
const fail = code => { throw new Error(code); };

export function parseOptions(args, { setup = false } = {}) {
  const options = { allowSpaces: [] };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') { options.help = true; continue; }
    const flags = { '--config': 'config', ...(setup ? { '--allow-space': 'allowSpaces', '--port': 'port', '--codex-bin': 'codexBin' } : {}) };
    const key = Object.hasOwn(flags, arg) ? flags[arg] : undefined;
    // Keep the original foreground server's single positional config path working.
    if (!setup && args.length === 1 && !arg.startsWith('-')) { options.config = arg; continue; }
    if (!key || (key !== 'allowSpaces' && seen.has(key))) fail('invalid_arguments');
    const value = args[++i];
    if (!value || value.startsWith('--') || value.includes('\0')) fail('invalid_arguments');
    seen.add(key);
    if (key === 'allowSpaces') {
      if (!SPACE_ID.test(value)) fail('invalid_space_id');
      options.allowSpaces.push(value);
    } else if (key === 'port') {
      if (!/^[0-9]+$/.test(value) || Number(value) < 1024 || Number(value) > 65535) fail('invalid_port');
      options.port = Number(value);
    } else if (key === 'codexBin') {
      if (!path.isAbsolute(value)) fail('codex_bin_must_be_absolute');
      options.codexBin = value;
    } else options[key] = value;
  }
  return options;
}

export function resolveConfigPath(options = {}, env = process.env, home = os.homedir()) {
  const explicit = options.config ?? env.BRIDGE_DIRECT_CONFIG;
  if (explicit !== undefined) {
    if (typeof explicit !== 'string' || !explicit || explicit.includes('\0')) fail('invalid_config_path');
    return path.resolve(explicit);
  }
  const base = env.XDG_CONFIG_HOME || path.join(home, '.config');
  if (!path.isAbsolute(base)) fail('config_home_must_be_absolute');
  return path.join(base, 'spaces-context-bridge', 'direct', 'config.json');
}

export function validateConfig(config) {
  const absolute = value => typeof value === 'string' && !value.includes('\0') && path.isAbsolute(value);
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 ||
      !absolute(config.tokenFile) || !absolute(config.stateDir) || !absolute(config.codexBin) ||
      !Array.isArray(config.allowedSpaceIds) || !config.allowedSpaceIds.every(id => typeof id === 'string' && SPACE_ID.test(id)) ||
      (config.allowedPageIds !== undefined && (!Array.isArray(config.allowedPageIds) ||
        !config.allowedPageIds.every(id => typeof id === 'string' && /^page_[a-zA-Z0-9]+$/.test(id))))) fail('invalid_config');
  return config;
}

// Check every ancestor: O_NOFOLLOW alone only protects the final component.
// System sticky temp directories are allowed as ancestors for isolated setups.
export async function privateDirectory(directory, { create = false } = {}) {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let st;
    try { st = await fs.lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error;
      try { await fs.mkdir(current, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      st = await fs.lstat(current);
    }
    if (!st.isDirectory() || st.isSymbolicLink() || ((st.mode & 0o022) && !(st.mode & 0o1000))) fail('unsafe_directory');
  }
  const st = await fs.lstat(absolute);
  if (!owned(st) || (st.mode & 0o077) || (st.mode & 0o700) !== 0o700) fail('unsafe_private_directory');
}

export async function privateFile(file) {
  await privateDirectory(path.dirname(file));
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.nlink !== 1 || (st.mode & 0o077) || (st.mode & 0o100) || !owned(st)) fail('unsafe_private_file');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}

export function validateToken(token) {
  if (typeof token !== 'string' || token.length < 40 || /\s/.test(token)) fail('invalid_local_credential');
  return token;
}

// Inspect metadata only; never read journal content or change existing modes.
export async function validateState(directory) {
  await privateDirectory(directory);
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    const st = await fs.lstat(file);
    if (st.isDirectory()) await validateState(file);
    else if (!st.isFile() || st.nlink !== 1 || (st.mode & 0o177) || !owned(st)) fail('unsafe_state_file');
  }
}

export async function resolveCodexBinary(override, env = process.env) {
  if (override !== undefined && !path.isAbsolute(override)) fail('codex_bin_must_be_absolute');
  const candidates = override ? [override] : (env.PATH ?? '').split(path.delimiter)
    .filter(directory => path.isAbsolute(directory)).map(directory => path.join(directory, 'codex'));
  for (const candidate of candidates) {
    try {
      // npm-installed CLI entry points may themselves be symlinks.
      const resolved = await fs.realpath(candidate);
      if (!(await fs.stat(resolved)).isFile()) continue;
      await fs.access(resolved, constants.X_OK);
      // Keep a stable launcher (for example a package-manager symlink) across upgrades.
      return path.resolve(candidate);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error;
    }
  }
  fail('codex_not_found');
}
