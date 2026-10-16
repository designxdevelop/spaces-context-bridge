// Generates the two connection codes locally and derives the hashes the Worker stores as secrets.
// Codes go to a 0600 file and are never printed. Usage:
//   node scripts/setup.mjs [--rotate] [--origin https://host] [--print-hashes] [--upload]
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const dir = join(root, '.bridge-secrets'), codesFile = join(dir, 'connection-codes.txt'), devVars = join(root, '.dev.vars');
const args = process.argv.slice(2), has = f => args.includes(f);
const originArg = args.includes('--origin') ? args[args.indexOf('--origin') + 1] : undefined;
// Must match digest() in worker.mjs: SHA-256, base64url, no padding.
const hash = s => createHash('sha256').update(s).digest('base64url');

const bareOrigin = value => {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.pathname !== '/' || u.search || u.hash || u.username || u.password) throw new Error('--origin must be a bare https origin such as https://bridge.example.com');
  return u.origin;
};
// Reruns (e.g. `npm run secrets:upload`) keep a previously chosen origin instead of silently dropping it.
const kept = existsSync(devVars) ? readFileSync(devVars, 'utf8').match(/^PUBLIC_ORIGIN=(\S+)$/m)?.[1] : undefined;
const origin = originArg ? bareOrigin(originArg) : kept && bareOrigin(kept);

mkdirSync(dir, { recursive: true, mode: 0o700 });
let codes;
if (existsSync(codesFile) && !has('--rotate')) {
  const text = readFileSync(codesFile, 'utf8');
  codes = { AGENT: text.match(/^AGENT_CODE=(\S+)$/m)?.[1], WORKER: text.match(/^WORKER_CODE=(\S+)$/m)?.[1] };
  if (!codes.AGENT || !codes.WORKER) throw new Error(`${codesFile} is malformed; delete it or pass --rotate.`);
} else {
  codes = { AGENT: randomBytes(24).toString('base64url'), WORKER: randomBytes(24).toString('base64url') };
  writeFileSync(codesFile, `AGENT_CODE=${codes.AGENT}\nWORKER_CODE=${codes.WORKER}\n`, { mode: 0o600 });
  chmodSync(codesFile, 0o600);
}
const secrets = { AGENT_LOGIN_HASH: hash(codes.AGENT), WORKER_LOGIN_HASH: hash(codes.WORKER), ...(origin && { PUBLIC_ORIGIN: origin }) };
writeFileSync(devVars, Object.entries(secrets).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
chmodSync(devVars, 0o600);

console.log(`Connection codes: ${codesFile} (mode 600, not printed). Local hashes: .dev.vars`);
console.log('Enter the agent code in your agent client or Executor; use the worker code only in the ChatGPT worker connection.');
if (has('--print-hashes')) for (const k of ['AGENT_LOGIN_HASH', 'WORKER_LOGIN_HASH']) console.log(`${k}=${secrets[k]}`);

if (has('--upload')) {
  // Single `secret bulk` deployment from a temporary protected file; run after the first deploy.
  const guard = spawnSync(process.execPath, [join(root, 'scripts/guard.mjs')], { stdio: 'inherit' });
  if (guard.status) process.exit(guard.status);
  const tmp = join(dir, 'upload.json');
  writeFileSync(tmp, JSON.stringify(secrets), { mode: 0o600 });
  try {
    const r = spawnSync('npx', ['--no-install', 'wrangler', 'secret', 'bulk', tmp], { cwd: root, stdio: 'inherit' });
    if (r.status) process.exit(r.status);
  } finally { rmSync(tmp, { force: true }); }
}
