// `npm run deploy` (also what the Deploy to Cloudflare button runs): guard -> ensure D1 exists -> migrate -> deploy.
// Why not just `wrangler d1 migrations apply`: it resolves the database by name and fails on a fresh account.
// Why not `wrangler deploy` first: new code would run on the old schema, and a local deploy can write database_id into wrangler.jsonc.
//   node scripts/deploy.mjs [--migrate-only]
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const configPath = join(root, 'wrangler.jsonc');
const original = readFileSync(configPath, 'utf8');
const db = JSON.parse(original.replace(/^\s*\/\/.*$/gm, '')).d1_databases?.find(d => d.binding === 'DB');
const die = msg => { console.error(msg); process.exit(1); };
if (!db) die('wrangler.jsonc has no d1_databases binding named DB.');

// BRIDGE_WRANGLER is a test seam: a script path run with node instead of the pinned Wrangler.
const [cmd, ...pre] = process.env.BRIDGE_WRANGLER ? [process.execPath, process.env.BRIDGE_WRANGLER] : ['npx', '--no-install', 'wrangler'];
const wrangler = (args, capture) => spawnSync(cmd, [...pre, ...args], { cwd: root, encoding: 'utf8', stdio: ['inherit', capture ? 'pipe' : 'inherit', 'inherit'] });
const must = (r, what) => { if (r.status !== 0) die(`${what} failed (exit ${r.status}); nothing further was run.`); return r; };

must(spawnSync(process.execPath, [join(root, 'scripts/guard.mjs')], { stdio: 'inherit' }), 'Account guard');

// Workers Builds (WORKERS_CI) provisions the database before the build runs; never create a second one there.
if (!db.database_id && !process.env.WORKERS_CI) {
  const list = must(wrangler(['d1', 'list', '--json'], true), 'Listing D1 databases');
  let names;
  try { names = JSON.parse(list.stdout).map(d => d.name); } catch { die('Could not parse `wrangler d1 list --json`; refusing to create a database blindly.'); }
  if (!names.includes(db.database_name)) {
    console.log(`Creating D1 database "${db.database_name}" (first deploy).`);
    // --update-config=false: otherwise an interactive run offers to rewrite the DB binding in wrangler.jsonc.
    must(wrangler(['d1', 'create', db.database_name, '--update-config=false']), 'Creating the D1 database');
  }
}

must(wrangler(['d1', 'migrations', 'apply', 'DB', '--remote']), 'D1 migrations');
if (process.argv.includes('--migrate-only')) process.exit(0);

// .dev.vars (written by `npm run setup`) ships the connection-code hashes with the first deploy, so a new
// Worker is never live without them. Secrets are additive: nothing already set is deleted.
const deploy = ['deploy'];
if (existsSync(join(root, '.dev.vars'))) deploy.push('--secrets-file', '.dev.vars');
const result = wrangler(deploy);
if (readFileSync(configPath, 'utf8') !== original) { writeFileSync(configPath, original); console.warn('Restored wrangler.jsonc (Wrangler tried to write resource IDs into it).'); }
process.exit(result.status ?? 1);
