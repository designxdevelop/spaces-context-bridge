import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setup } from '../direct/setup.mjs';
import { parseOptions, resolveConfigPath, validateConfig } from '../direct/config.mjs';
import { startServer } from '../direct/http-server.mjs';

const setupScript = fileURLToPath(new URL('../direct/setup.mjs', import.meta.url));
const serverScript = fileURLToPath(new URL('../direct/http-server.mjs', import.meta.url));
const SPACE_A = 'page_space_EXAMPLE';
const SPACE_B = 'page_space_SECOND';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'direct-setup-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin, { mode: 0o700 });
  const codex = path.join(bin, 'codex');
  const invoked = path.join(root, 'unexpected-upstream-invocation');
  await fs.writeFile(codex, `#!/bin/sh\nprintf invoked > '${invoked}'\nexit 99\n`, { mode: 0o700 });
  const env = { PATH: bin, XDG_CONFIG_HOME: path.join(root, 'config-home') };
  const home = path.join(root, 'isolated-home');
  let output = '';
  const run = (args = [], overrides = {}) => setup({ args, env, home, output: { write: text => { output += text; } }, ...overrides });
  return { root, env, home, codex, invoked, run, output: () => output };
}

async function writeConfig(result, update) {
  const config = { ...result.config, ...update };
  await fs.writeFile(result.configFile, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  return config;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function request(port, token, message) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(message);
    const req = http.request({ hostname: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: {
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...(token ? { Authorization: `Bearer ${token}` } : {}),
    } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject); req.end(body);
  });
}

test('fresh setup creates a private read-only config, random owner key and state without executing Codex', async t => {
  const f = await fixture(t);
  const result = await f.run();
  assert.equal(result.configFile, path.join(f.env.XDG_CONFIG_HOME, 'spaces-context-bridge/direct/config.json'));
  assert.equal(result.config.port, 4791);
  assert.equal(result.config.codexBin, f.codex);
  assert.deepEqual(result.config.allowedSpaceIds, []);
  const token = (await fs.readFile(result.config.tokenFile, 'utf8')).trim();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  for (const file of [result.configFile, result.config.tokenFile]) assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  for (const directory of [path.dirname(result.configFile), result.config.stateDir]) assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  assert.ok(!f.output().includes(token));
  assert.match(f.output(), /npm run direct:start/);
  await assert.rejects(fs.stat(f.invoked), { code: 'ENOENT' });
});

test('repeat setup preserves config bytes, key, write permissions and journal', async t => {
  const f = await fixture(t);
  const result = await f.run(['--allow-space', SPACE_A, '--allow-space', SPACE_B]);
  const config = await writeConfig(result, { allowedPageIds: ['page_EXAMPLE'], customSetting: { preserved: true } });
  const journal = path.join(config.stateDir, 'saves');
  await fs.mkdir(journal, { mode: 0o700 });
  const entry = path.join(journal, 'synthetic.json');
  await fs.writeFile(entry, '{"status":"unknown","synthetic":true}\n', { mode: 0o600 });
  const before = await Promise.all([result.configFile, config.tokenFile, entry].map(file => fs.readFile(file, 'utf8')));
  await f.run();
  const after = await Promise.all([result.configFile, config.tokenFile, entry].map(file => fs.readFile(file, 'utf8')));
  assert.deepEqual(after, before);
  assert.deepEqual(JSON.parse(after[0]), config);
});

test('explicit repeated Space flags add exactly those IDs, deduplicate, and preserve other settings and key', async t => {
  const f = await fixture(t);
  const result = await f.run(['--allow-space', SPACE_A]);
  const beforeKey = await fs.readFile(result.config.tokenFile, 'utf8');
  await writeConfig(result, { allowedPageIds: ['page_EXAMPLE'], customSetting: true });
  const updated = await f.run(['--allow-space', SPACE_B, '--allow-space', SPACE_A, '--allow-space', SPACE_B]);
  assert.deepEqual(updated.config.allowedSpaceIds, [SPACE_A, SPACE_B]);
  assert.deepEqual(updated.config.allowedPageIds, ['page_EXAMPLE']);
  assert.equal(updated.config.customSetting, true);
  assert.equal(await fs.readFile(result.config.tokenFile, 'utf8'), beforeKey);
  assert.equal((await fs.stat(result.configFile)).mode & 0o777, 0o600);
});

test('config resolution uses CLI, environment, XDG, then isolated home; server preserves positional config', () => {
  const home = path.resolve('synthetic-home');
  assert.equal(resolveConfigPath({}, {}, home), path.join(home, '.config/spaces-context-bridge/direct/config.json'));
  assert.equal(resolveConfigPath({}, { XDG_CONFIG_HOME: '/synthetic-config' }, home), '/synthetic-config/spaces-context-bridge/direct/config.json');
  assert.equal(resolveConfigPath({}, { BRIDGE_DIRECT_CONFIG: 'env-config' }, home), path.resolve('env-config'));
  assert.equal(resolveConfigPath({ config: 'cli-config' }, { BRIDGE_DIRECT_CONFIG: 'env-config' }, home), path.resolve('cli-config'));
  assert.deepEqual(parseOptions(['original-config']), { config: 'original-config', allowSpaces: [] });
  assert.throws(() => resolveConfigPath({}, { XDG_CONFIG_HOME: 'relative' }, home), /config_home_must_be_absolute/);
});

test('custom config, absolute executable override, PATH symlinks and explicit port updates work', async t => {
  const f = await fixture(t);
  const configFile = path.join(f.root, 'custom', 'direct.json');
  const result = await f.run(['--config', configFile, '--codex-bin', f.codex, '--port', '5800'], { env: { PATH: '' } });
  assert.equal(result.configFile, configFile);
  assert.equal(result.config.port, 5800);
  const updated = await f.run(['--port', '5801'], { env: { BRIDGE_DIRECT_CONFIG: configFile, PATH: '' } });
  assert.equal(updated.config.port, 5801);
  assert.deepEqual(updated.config.allowedSpaceIds, []);
  const otherBin = path.join(f.root, 'linked-bin');
  await fs.mkdir(otherBin, { mode: 0o700 });
  await fs.symlink(f.codex, path.join(otherBin, 'codex'));
  const linked = await f.run([], { env: { XDG_CONFIG_HOME: path.join(f.root, 'other-config'), PATH: otherBin } });
  assert.equal(linked.config.codexBin, path.join(otherBin, 'codex'));
  const upgraded = path.join(f.root, 'upgraded-codex');
  await fs.rename(f.codex, upgraded);
  await fs.unlink(path.join(otherBin, 'codex'));
  await fs.symlink(upgraded, path.join(otherBin, 'codex'));
  const repeated = await f.run([], { env: { BRIDGE_DIRECT_CONFIG: linked.configFile, PATH: '' } });
  assert.equal(repeated.config.codexBin, path.join(otherBin, 'codex'));
  const explicit = await f.run(['--config', path.join(f.root, 'explicit-link', 'config.json'), '--codex-bin', path.join(otherBin, 'codex')]);
  assert.equal(explicit.config.codexBin, path.join(otherBin, 'codex'));
});

test('invalid args and ports fail before creating config files', async t => {
  const f = await fixture(t);
  for (const args of [ ['constructor', 'ignored'], ['__proto__', 'ignored'], ['toString', 'ignored'], ['--unknown'], ['--config'], ['--config', 'x', '--config', 'y'], ['--allow-space'],
    ['--allow-space', 'page_space_'], ['--allow-space', 'page_space_one,two'], ['--allow-space', 'page_space_A\n'],
    ['--codex-bin', 'codex'], ['--port', '1023'], ['--port', '65536'], ['--port', '1e4'], ['--port', '4791x'],
    ['--port', '4791.5'], ['--port', ''], ['--port', '4791', '--port', '4792'], ['--config', 'x\0y'] ]) {
    await assert.rejects(f.run(args));
  }
  await assert.rejects(fs.stat(f.env.XDG_CONFIG_HOME), { code: 'ENOENT' });
  for (const port of [1024, 65535]) assert.equal(parseOptions(['--port', String(port)], { setup: true }).port, port);
});

test('missing or non-executable Codex never creates a credential or config', async t => {
  const f = await fixture(t);
  await fs.chmod(f.codex, 0o600);
  await assert.rejects(f.run(), /codex_not_found/);
  const directory = path.join(f.env.XDG_CONFIG_HOME, 'spaces-context-bridge/direct');
  assert.deepEqual(await fs.readdir(directory), []);
  await assert.rejects(f.run(['--codex-bin', path.join(f.root, 'missing')]), /codex_not_found/);
  await fs.chmod(f.codex, 0o700);
  await assert.rejects(f.run([], { env: { ...f.env, PATH: 'relative-bin:' } }), /codex_not_found/);
});

test('existing config with missing key refuses regeneration and leaves config and journal intact', async t => {
  const f = await fixture(t);
  const result = await f.run(['--allow-space', SPACE_A]);
  const before = await fs.readFile(result.configFile, 'utf8');
  await fs.unlink(result.config.tokenFile);
  await assert.rejects(f.run(['--allow-space', SPACE_B]), { code: 'ENOENT' });
  assert.equal(await fs.readFile(result.configFile, 'utf8'), before);
  await assert.rejects(fs.stat(result.config.tokenFile), { code: 'ENOENT' });
});

test('an interrupted initial setup reuses its existing safe key and state', async t => {
  const f = await fixture(t);
  const result = await f.run();
  const key = await fs.readFile(result.config.tokenFile, 'utf8');
  await fs.unlink(result.configFile);
  const sentinel = path.join(result.config.stateDir, 'sentinel.json');
  await fs.writeFile(sentinel, '{"preserved":true}', { mode: 0o600 });
  await f.run();
  assert.equal(await fs.readFile(result.config.tokenFile, 'utf8'), key);
  assert.equal(await fs.readFile(sentinel, 'utf8'), '{"preserved":true}');
});

test('unsafe existing config, key and directory permissions are refused rather than repaired', async t => {
  for (const kind of ['config', 'key', 'directory', 'state', 'journal']) {
    const f = await fixture(t);
    const result = await f.run();
    const key = await fs.readFile(result.config.tokenFile, 'utf8');
    let target = { config: result.configFile, key: result.config.tokenFile, directory: path.dirname(result.configFile), state: result.config.stateDir }[kind];
    if (kind === 'journal') { target = path.join(result.config.stateDir, 'journal.json'); await fs.writeFile(target, '{}', { mode: 0o600 }); }
    const unsafeMode = ['directory', 'state'].includes(kind) ? 0o755 : 0o644;
    await fs.chmod(target, unsafeMode);
    await assert.rejects(f.run(['--allow-space', SPACE_A]), /unsafe/);
    assert.equal((await fs.stat(target)).mode & 0o777, unsafeMode);
    assert.equal(await fs.readFile(result.config.tokenFile, 'utf8'), key);
  }
});

test('symlinked config, key, state, journal and parent directories are refused without changing targets', async t => {
  for (const kind of ['config', 'key', 'state', 'journal', 'parent']) {
    const f = await fixture(t);
    const result = await f.run();
    let target = { config: result.configFile, key: result.config.tokenFile, state: result.config.stateDir, parent: path.dirname(result.configFile) }[kind];
    if (kind === 'journal') { target = path.join(result.config.stateDir, 'journal.json'); await fs.writeFile(target, '{}', { mode: 0o600 }); }
    const moved = target + '.original';
    await fs.rename(target, moved);
    await fs.symlink(moved, target);
    const before = (await fs.lstat(moved)).isFile() ? await fs.readFile(moved, 'utf8') : await fs.readdir(moved);
    await assert.rejects(f.run(['--allow-space', SPACE_A]));
    assert.equal((await fs.lstat(target)).isSymbolicLink(), true);
    const after = (await fs.lstat(moved)).isFile() ? await fs.readFile(moved, 'utf8') : await fs.readdir(moved);
    assert.deepEqual(after, before);
  }
});

test('hardlinked credentials and a concurrent setup lock fail closed', async t => {
  const f = await fixture(t);
  const result = await f.run();
  const before = await fs.readFile(result.configFile, 'utf8');
  const linked = path.join(path.dirname(result.configFile), 'linked-key');
  await fs.link(result.config.tokenFile, linked);
  await assert.rejects(f.run(), /unsafe_private_file/);
  await fs.unlink(linked);
  const lockFile = path.join(path.dirname(result.configFile), '.setup.lock');
  await fs.writeFile(lockFile, 'synthetic concurrent setup', { mode: 0o600 });
  await assert.rejects(f.run(['--allow-space', SPACE_A]), { code: 'EEXIST' });
  assert.equal(await fs.readFile(lockFile, 'utf8'), 'synthetic concurrent setup');
  const locked = spawnSync(process.execPath, [setupScript, '--config', result.configFile], { env: f.env, encoding: 'utf8' });
  assert.equal(locked.status, 1);
  assert.match(locked.stderr, /setup_locked/);
  assert.ok(locked.stderr.includes(lockFile));
  assert.match(locked.stderr, /If none is running, remove this stale lock file and retry/);
  assert.equal(await fs.readFile(result.configFile, 'utf8'), before);
});

test('invalid existing config and invalid keys fail without overwriting either file', async t => {
  const f = await fixture(t);
  const result = await f.run();
  for (const text of ['{invalid', JSON.stringify({ ...result.config, allowedSpaceIds: ['invalid'] })]) {
    await fs.writeFile(result.configFile, text);
    await assert.rejects(f.run());
    assert.equal(await fs.readFile(result.configFile, 'utf8'), text);
  }
  await writeConfig(result, {});
  await fs.writeFile(result.config.tokenFile, 'short-key\n');
  await assert.rejects(f.run(), /invalid_local_credential/);
  assert.equal(await fs.readFile(result.config.tokenFile, 'utf8'), 'short-key\n');
  for (const patch of [{ allowedPageIds: null }, { allowedSpaceIds: null }, { port: 0 }, { tokenFile: 'relative' }]) {
    assert.throws(() => validateConfig({ ...result.config, ...patch }), /invalid_config/);
  }
});

test('CLI help has no side effects and failures never echo a private config or key', async t => {
  const f = await fixture(t);
  for (const script of [setupScript, serverScript]) {
    const help = spawnSync(process.execPath, [script, '--help'], { env: f.env, encoding: 'utf8' });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Usage:/);
  }
  await assert.rejects(fs.stat(f.env.XDG_CONFIG_HOME), { code: 'ENOENT' });
  const result = await f.run();
  const privateMarker = 'SYNTHETIC_PRIVATE_CONFIG_MARKER';
  await fs.writeFile(result.configFile, privateMarker);
  const failed = spawnSync(process.execPath, [setupScript, '--config', result.configFile], { env: f.env, encoding: 'utf8' });
  assert.equal(failed.status, 1);
  assert.equal(failed.stdout, '');
  assert.ok(!failed.stderr.includes(privateMarker));
  assert.match(failed.stderr, /setup_failed/);
});

test('foreground server uses the default config and owner auth, without contacting upstream for local metadata', async t => {
  const f = await fixture(t);
  const port = await freePort();
  const result = await f.run(['--port', String(port)]);
  const token = (await fs.readFile(result.config.tokenFile, 'utf8')).trim();
  const local = await startServer({ args: [], env: f.env, home: f.home, log: () => {} });
  t.after(() => local.close());
  assert.equal(local.server.address().address, '127.0.0.1');
  const message = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  assert.equal((await request(port, null, message)).status, 401);
  const tools = await request(port, token, message);
  assert.equal(tools.status, 200);
  assert.ok(tools.body.result.tools.some(tool => tool.name === 'save_meeting_notes'));
  const status = await request(port, token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bridge_direct_status', arguments: {} } });
  assert.equal(status.status, 200);
  assert.equal(status.body.result.isError, undefined);
  await assert.rejects(fs.stat(f.invoked), { code: 'ENOENT' });
});

test('foreground server accepts environment and CLI config overrides and rejects unsafe keys before listening', async t => {
  const f = await fixture(t);
  const configFile = path.join(f.root, 'custom-config', 'config.json');
  const result = await f.run(['--config', configFile, '--port', String(await freePort())]);
  for (const options of [{ args: [], env: { BRIDGE_DIRECT_CONFIG: configFile } }, { args: ['--config', configFile], env: { BRIDGE_DIRECT_CONFIG: '/missing/ignored' } }, { args: [configFile], env: {} }]) {
    const local = await startServer({ ...options, log: () => {} });
    assert.equal(local.configFile, configFile);
    await local.close();
  }
  await fs.chmod(result.config.tokenFile, 0o644);
  await assert.rejects(startServer({ args: ['--config', configFile], env: {}, log: () => {} }), /unsafe_private_file/);
  await assert.rejects(startServer({ args: ['--port', '4791'], env: {}, log: () => {} }), /invalid_arguments/);
});
