import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = new URL('../', import.meta.url).pathname;
const read = p => readFileSync(join(root, p), 'utf8');
const config = JSON.parse(read('wrangler.jsonc').replace(/^\s*\/\/.*$/gm, ''));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const cleanEnv = extra => { const e = { ...process.env, ...extra }; for (const k of ['CI', 'WORKERS_CI', 'CLOUDFLARE_ACCOUNT_ID', 'BRIDGE_ALLOWED_ACCOUNT_IDS', 'BRIDGE_PROTECTED_ACCOUNT_IDS', 'BRIDGE_WRANGLER']) if (!(k in (extra || {}))) delete e[k]; return e; };

test('wrangler.jsonc is generic and deployable by a stranger', () => {
  for (const key of ['account_id', 'routes', 'route', 'zone_id', 'vars', 'kv_namespaces', 'r2_buckets']) assert.ok(!(key in config), `${key} must not be committed`);
  assert.ok(existsSync(join(root, config.main)), 'main entry exists');
  assert.match(config.compatibility_date, /^\d{4}-\d\d-\d\d$/);
  assert.ok(config.compatibility_date <= new Date().toISOString().slice(0, 10));
  assert.ok(config.compatibility_flags.includes('nodejs_compat'), 'worker imports node:crypto');
  assert.deepEqual(config.triggers.crons, ['*/5 * * * *']);
  assert.equal(config.observability.enabled, true);
  assert.equal(config.observability.traces?.enabled, false);
  assert.equal(config.observability.redact_query_string, true, 'OAuth codes travel in query strings');
});

test('D1 binding auto-provisions: named DB, no database_id, migrations directory present', () => {
  assert.equal(config.d1_databases.length, 1);
  const [db] = config.d1_databases;
  assert.equal(db.binding, 'DB');
  assert.ok(db.database_name);
  assert.ok(!('database_id' in db), 'a committed database_id would point strangers at someone else\'s database');
  assert.ok(readdirSync(join(root, db.migrations_dir)).some(f => f.endsWith('.sql')));
});

test('Wrangler is exactly pinned and locked', () => {
  const v = pkg.devDependencies.wrangler;
  assert.match(v, /^\d+\.\d+\.\d+$/, 'no ^ or ~ range');
  assert.equal(lock.packages['node_modules/wrangler'].version, v);
  assert.ok(pkg.engines.node);
  assert.match(read('.node-version').trim(), /^\d+/);
});

test('package scripts route every remote operation through scripts/deploy.mjs and the Deploy button gets no build script', () => {
  assert.equal(pkg.scripts.deploy, 'node scripts/deploy.mjs');
  assert.equal(pkg.scripts['db:migrate:remote'], 'node scripts/deploy.mjs --migrate-only');
  assert.ok(!('build' in pkg.scripts), 'a build script would be pre-filled into the Deploy button');
  assert.ok(!('secrets' in config), 'secrets.required makes the first deploy of a new Worker fail unless secrets are supplied at that moment');
});

// Real ordering: a stub Wrangler records argv. Runs a copy of the scripts against a throwaway config.
function deployRun({ dbs = [], database_id, env = {}, failOn, devVars } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'deploy-test-'));
  try {
    mkdirSync(join(tmp, 'scripts'));
    for (const f of ['deploy.mjs', 'guard.mjs']) cpSync(join(root, 'scripts', f), join(tmp, 'scripts', f));
    const cfg = JSON.parse(JSON.stringify(config)); if (database_id) cfg.d1_databases[0].database_id = database_id;
    const text = '// comment that must survive\n' + JSON.stringify(cfg, null, 2);
    writeFileSync(join(tmp, 'wrangler.jsonc'), text);
    if (devVars) writeFileSync(join(tmp, '.dev.vars'), devVars);
    const log = join(tmp, 'argv.log');
    writeFileSync(join(tmp, 'stub.mjs'), `import { appendFileSync, writeFileSync } from 'node:fs';
const a = process.argv.slice(2).join(' '); appendFileSync(${JSON.stringify(log)}, a + '\\n');
if (a.startsWith('d1 list')) console.log(JSON.stringify(${JSON.stringify(dbs.map(name => ({ uuid: 'id-' + name, name })))}));
if (${JSON.stringify(failOn || null)} && a.startsWith(${JSON.stringify(failOn || '')})) process.exit(3);
if (a === 'deploy' || a.startsWith('deploy ')) writeFileSync(${JSON.stringify(join(tmp, 'wrangler.jsonc'))}, 'MUTATED');`);
    const r = spawnSync(process.execPath, [join(tmp, 'scripts/deploy.mjs')], { encoding: 'utf8', env: cleanEnv({ CLOUDFLARE_ACCOUNT_ID: 'acct-a', BRIDGE_WRANGLER: join(tmp, 'stub.mjs'), ...env }) });
    return { status: r.status, calls: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [], config: readFileSync(join(tmp, 'wrangler.jsonc'), 'utf8'), original: text, stderr: r.stderr };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
const name = config.d1_databases[0].database_name;

test('fresh account: creates the database, then migrates, then deploys', () => {
  const r = deployRun();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls, ['d1 list --json', `d1 create ${name} --update-config=false`, 'd1 migrations apply DB --remote', 'deploy']);
  assert.equal(r.config, r.original, 'Wrangler writeback into wrangler.jsonc is reverted');
});

test('existing database (upgrade): no create, migrations still run before deploy', () => {
  const r = deployRun({ dbs: ['other', name] });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls, ['d1 list --json', 'd1 migrations apply DB --remote', 'deploy']);
});

test('pinned database_id skips lookup and creation', () => {
  assert.deepEqual(deployRun({ database_id: '00000000-0000-0000-0000-000000000000' }).calls, ['d1 migrations apply DB --remote', 'deploy']);
});

test('connection-code hashes ride the first deploy via --secrets-file only when setup produced them', () => {
  assert.deepEqual(deployRun({ dbs: [name], devVars: 'AGENT_LOGIN_HASH=a\n' }).calls.at(-1), 'deploy --secrets-file .dev.vars');
  assert.equal(deployRun({ dbs: [name] }).calls.at(-1), 'deploy');
});

test('failures stop the sequence: lookup error never creates, failed migration never deploys', () => {
  const lookup = deployRun({ failOn: 'd1 list' });
  assert.notEqual(lookup.status, 0); assert.deepEqual(lookup.calls, ['d1 list --json']);
  const mig = deployRun({ dbs: [name], failOn: 'd1 migrations' });
  assert.notEqual(mig.status, 0); assert.ok(!mig.calls.includes('deploy'));
});

test('Workers Builds never lists or creates a database; the guard blocks before any Wrangler call', () => {
  assert.deepEqual(deployRun({ env: { WORKERS_CI: '1', CLOUDFLARE_ACCOUNT_ID: '' } }).calls, ['d1 migrations apply DB --remote', 'deploy']);
  const blocked = deployRun({ env: { BRIDGE_PROTECTED_ACCOUNT_IDS: 'acct-a' } });
  assert.notEqual(blocked.status, 0); assert.deepEqual(blocked.calls, []);
});

test('Deploy button prompts describe every secret in .dev.vars.example', () => {
  const keys = read('.dev.vars.example').split('\n').filter(l => /^[A-Z_]+=/.test(l)).map(l => l.split('=')[0]);
  assert.deepEqual(keys.sort(), ['AGENT_LOGIN_HASH', 'WORKER_LOGIN_HASH']);
  for (const k of keys) assert.ok(pkg.cloudflare.bindings[k].description.length > 20, k);
  assert.ok(pkg.cloudflare.bindings.DB.description);
  assert.ok(!/^[A-Z_]+=.+/m.test(read('.dev.vars.example').replace(/^#.*$/gm, '')), 'example file carries no values');
});

test('.gitignore keeps local secrets out', () => {
  const ignored = read('.gitignore');
  for (const p of ['.dev.vars', '.bridge-secrets/', 'node_modules/', '.wrangler/']) assert.ok(ignored.includes(p), p);
  assert.ok(ignored.includes('!.dev.vars.example'));
});

test('setup script writes protected files, never prints codes, hashes like the Worker', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'setup-test-'));
  try {
    mkdirSync(join(tmp, 'scripts')); cpSync(join(root, 'scripts/setup.mjs'), join(tmp, 'scripts/setup.mjs'));
    const run = (...a) => spawnSync(process.execPath, [join(tmp, 'scripts/setup.mjs'), ...a], { encoding: 'utf8', env: cleanEnv() });
    const first = run('--print-hashes');
    assert.equal(first.status, 0, first.stderr);
    const codesPath = join(tmp, '.bridge-secrets/connection-codes.txt');
    assert.equal(statSync(codesPath).mode & 0o777, 0o600);
    assert.equal(statSync(join(tmp, '.dev.vars')).mode & 0o777, 0o600);
    const codes = Object.fromEntries(readFileSync(codesPath, 'utf8').trim().split('\n').map(l => l.split('=')));
    assert.notEqual(codes.AGENT_CODE, codes.WORKER_CODE);
    assert.ok(codes.AGENT_CODE.length >= 32);
    for (const c of Object.values(codes)) assert.ok(!first.stdout.includes(c) && !first.stderr.includes(c), 'code leaked to output');
    const sha = s => createHash('sha256').update(s).digest('base64url'); // same as digest() in worker.mjs
    const vars = Object.fromEntries(readFileSync(join(tmp, '.dev.vars'), 'utf8').trim().split('\n').map(l => l.split('=')));
    assert.equal(vars.AGENT_LOGIN_HASH, sha(codes.AGENT_CODE));
    assert.equal(vars.WORKER_LOGIN_HASH, sha(codes.WORKER_CODE));
    assert.ok(first.stdout.includes(vars.AGENT_LOGIN_HASH));
    assert.ok(!run().stdout.includes(vars.AGENT_LOGIN_HASH), 'hashes only printed on request');
    assert.equal(readFileSync(codesPath, 'utf8').includes(codes.AGENT_CODE), true, 'rerun keeps existing codes');
    run('--rotate');
    assert.notEqual(readFileSync(codesPath, 'utf8').split('\n')[0], `AGENT_CODE=${codes.AGENT_CODE}`);
    assert.notEqual(run('--origin', 'http://insecure.example.com').status, 0);
    assert.notEqual(run('--origin', 'https://example.com/path').status, 0);
    assert.equal(run('--origin', 'https://bridge.example.com').status, 0);
    assert.match(readFileSync(join(tmp, '.dev.vars'), 'utf8'), /^PUBLIC_ORIGIN=https:\/\/bridge\.example\.com$/m);
    assert.equal(run().status, 0);
    assert.match(readFileSync(join(tmp, '.dev.vars'), 'utf8'), /^PUBLIC_ORIGIN=https:\/\/bridge\.example\.com$/m, 'rerun (secrets:upload) keeps the chosen origin');
    assert.match(readFileSync(join(tmp, '.dev.vars'), 'utf8'), /^AGENT_LOGIN_HASH=/m);
    assert.equal(run('--origin', 'https://other.example.com').status, 0);
    assert.match(readFileSync(join(tmp, '.dev.vars'), 'utf8'), /^PUBLIC_ORIGIN=https:\/\/other\.example\.com$/m, 'explicit --origin replaces it');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('remote guard blocks unintended targets and passes explicit ones', () => {
  const guard = env => spawnSync(process.execPath, [join(root, 'scripts/guard.mjs')], { encoding: 'utf8', env: cleanEnv(env) }).status;
  assert.equal(guard({}), 1, 'account must be explicit');
  assert.equal(guard({ CLOUDFLARE_ACCOUNT_ID: 'acct-a' }), 0);
  assert.equal(guard({ CLOUDFLARE_ACCOUNT_ID: 'acct-a', BRIDGE_PROTECTED_ACCOUNT_IDS: 'acct-b,acct-a' }), 1);
  assert.equal(guard({ CLOUDFLARE_ACCOUNT_ID: 'acct-a', BRIDGE_ALLOWED_ACCOUNT_IDS: 'acct-b' }), 1);
  assert.equal(guard({ CLOUDFLARE_ACCOUNT_ID: 'acct-b', BRIDGE_ALLOWED_ACCOUNT_IDS: 'acct-b' }), 0);
  assert.equal(guard({ CI: '1' }), 1, 'generic CI gets no exemption');
  assert.equal(guard({ WORKERS_CI: '1' }), 0, 'Workers Builds is bound to the owner\'s account');
  assert.equal(guard({ WORKERS_CI: '1', CLOUDFLARE_ACCOUNT_ID: 'acct-a', BRIDGE_PROTECTED_ACCOUNT_IDS: 'acct-a' }), 1, 'lists still apply in Workers Builds');
});

test('smoke harness never disables TLS validation process-wide', () => {
  assert.ok(!/NODE_TLS_REJECT_UNAUTHORIZED/.test(read('scripts/smoke.mjs').replace(/\/\/.*$/gm, '')));
});
