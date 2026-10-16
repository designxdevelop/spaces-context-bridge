import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const examples = new URL('../examples/clients/', import.meta.url);
const read = (file) => readFile(new URL(file, examples), 'utf8');
const json = async (file) => JSON.parse(await read(file));

test('OpenCode examples keep major-version formats separate and request agent scope', async () => {
  const v1 = await json('opencode-v1.json');
  const v2 = await json('opencode-v2.json');
  assert.equal(v1.mcp.servers, undefined);
  assert.equal(v1.mcp.spaces_context.enabled, false);
  assert.equal(v2.mcp.spaces_context, undefined);
  const server = v2.mcp.servers.spaces_context;
  assert.equal(server.enabled, undefined);
  assert.equal(server.disabled, true);
  assert.equal(server.protocol, 'auto');
  for (const config of [v1.mcp.spaces_context, server]) {
    assert.equal(config.type, 'remote');
    assert.deepEqual(config.oauth, { scope: 'agent' });
  }
});

test('client examples use only placeholder endpoints and no embedded credentials', async () => {
  const files = ['opencode-v1.json', 'opencode-v2.json', 'codex.toml', 'claude.mcp.json', 'executor-add-server.json'];
  for (const file of files) {
    const content = await read(file);
    const urls = content.match(/https:\/\/[^"\s]+/g).filter((url) => !url.endsWith('/config.json'));
    assert.deepEqual(urls, ['https://bridge.example.invalid/mcp'], file);
    assert.doesNotMatch(content, /Bearer\s|client[_]?secret|access[_]?token|refresh[_]?token|WORKER_LOGIN_HASH/i, file);
  }
  const claude = await json('claude.mcp.json');
  assert.equal(claude.mcpServers.spaces_context.type, 'http');
  assert.match(await read('codex.toml'), /\[mcp_servers\.spaces_context\]/);
});

test('Executor example registers an agent-only remote OAuth integration', async () => {
  const config = await json('executor-add-server.json');
  assert.equal(config.transport, 'remote');
  assert.equal(config.remoteTransport, 'streamable-http');
  assert.equal(config.versionNegotiation, 'auto');
  assert.deepEqual(config.authenticationTemplate, [{ slug: 'agent-oauth', kind: 'oauth2', scopes: ['agent'] }]);
  assert.equal(config.headers, undefined);
});

// Opt in: no model call, OAuth/browser launch, or connection to a live bridge.
test('installed OpenCode 2 parses the example using isolated config/data/cache/state', {
  skip: process.env.BRIDGE_CHECK_OPENCODE !== '1',
}, async (t) => {
  // macOS's default TMPDIR can exceed Unix-domain socket path limits.
  const root = await mkdtemp(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'bridge-oc-'));
  try {
    const dirs = Object.fromEntries(['config', 'data', 'cache', 'state', 'work'].map((name) => [name, join(root, name)]));
    await Promise.all(Object.values(dirs).map((dir) => mkdir(dir, { recursive: true })));
    const configDir = join(dirs.config, 'opencode');
    await mkdir(configDir);
    // Use a private helper instead of starting a persistent background service.
    await writeFile(join(configDir, 'service.json'), JSON.stringify({ disabled: true }));
    // Allowlist the environment so real provider/API/OAuth variables cannot leak in.
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USER: process.env.USER,
      LOGNAME: process.env.LOGNAME,
      SHELL: process.env.SHELL,
      OPENCODE_EXPERIMENTAL: process.env.OPENCODE_EXPERIMENTAL,
      ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE,
      LANG: 'en_US.UTF-8',
      NO_COLOR: '1',
      XDG_CONFIG_HOME: dirs.config,
      XDG_DATA_HOME: dirs.data,
      XDG_CACHE_HOME: dirs.cache,
      XDG_STATE_HOME: dirs.state,
      OPENCODE_CONFIG_DIR: configDir,
      OPENCODE_CONFIG: join(dirs.work, 'opencode.json'),
      OPENCODE_DISABLE_MODELS_FETCH: 'true',
      OPENCODE_DISABLE_AUTOUPDATE: 'true',
    };
    const run = (args) => spawnSync('opencode', args, { cwd: dirs.work, env, encoding: 'utf8', timeout: 30_000 });
    const version = run(['--version']);
    assert.equal(version.error, undefined, 'OpenCode binary must be on PATH');
    assert.equal(version.status, 0);
    assert.match(version.stdout, /\bv2\./, 'this integration check requires OpenCode 2');
    t.diagnostic(version.stdout.trim());
    await writeFile(join(dirs.work, 'opencode.json'), await read('opencode-v2.json'));
    const accepted = run(['debug', 'config']);
    assert.equal(accepted.error, undefined);
    assert.equal(accepted.status, 0, 'OpenCode rejected the isolated V2 config');
    const sources = JSON.parse(accepted.stdout);
    const loaded = sources.find((source) => source.info?.mcp?.servers?.spaces_context);
    assert.ok(loaded, 'CLI must report the example as a configuration source');
    assert.deepEqual(loaded.info.mcp.servers.spaces_context, (await json('opencode-v2.json')).mcp.servers.spaces_context);

    // A negative control proves the CLI loaded this file, rather than empty defaults.
    const invalid = await json('opencode-v2.json');
    invalid.mcp.servers.spaces_context.protocol = 'unsupported-revision';
    await writeFile(join(dirs.work, 'opencode.json'), JSON.stringify(invalid));
    const rejected = run(['debug', 'config']);
    assert.equal(rejected.error, undefined);
    // V2 debug config may exit 0 while dropping an invalid config section.
    // Assert the parsed server itself disappears, rather than trusting exit code.
    if (rejected.status === 0) {
      const invalidSources = JSON.parse(rejected.stdout);
      assert.equal(invalidSources.some((source) => source.info?.mcp?.servers?.spaces_context), false);
    } else {
      assert.match(rejected.stdout + rejected.stderr, /protocol|unsupported-revision/i);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
