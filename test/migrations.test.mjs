import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const migrations = readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort();
const fresh = () => { const db = new DatabaseSync(':memory:'); for (const f of migrations) db.exec(read('migrations/' + f)); return db; };
const shape = db => Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
  .map(({ name }) => [name, db.prepare(`PRAGMA table_info(${name})`).all().map(c => `${c.name}:${c.type}:${c.pk}:${c.notnull}`)]));

// The 0.1.0 pre-release schema (before client-owned subscriptions, rotation and rate limits).
const v010 = `CREATE TABLE clients(id TEXT PRIMARY KEY,name TEXT,redirects TEXT,created INTEGER);
CREATE TABLE consents(id TEXT PRIMARY KEY,csrf TEXT,data TEXT,expires INTEGER);
CREATE TABLE codes(hash TEXT PRIMARY KEY,client TEXT,redirect TEXT,challenge TEXT,role TEXT,expires INTEGER);
CREATE TABLE tokens(hash TEXT PRIMARY KEY,client TEXT,role TEXT,expires INTEGER,kind TEXT);
CREATE TABLE requests(id TEXT PRIMARY KEY,client TEXT,idem TEXT,kind TEXT,payload TEXT,status TEXT,result TEXT,created INTEGER,updated INTEGER,lease TEXT,lease_expires INTEGER,UNIQUE(client,idem));
CREATE TABLE subscriptions(id TEXT PRIMARY KEY,callback TEXT,secret TEXT,expires INTEGER,created INTEGER);
CREATE TABLE deliveries(id TEXT PRIMARY KEY,subscription TEXT,request TEXT,attempts INTEGER DEFAULT 0,due INTEGER,status TEXT DEFAULT 'pending',UNIQUE(subscription,request));`;

test('migrations are numbered contiguously', () => {
  assert.ok(migrations.length > 0);
  migrations.forEach((f, i) => assert.ok(f.startsWith(String(i + 1).padStart(4, '0') + '_'), `${f} is out of sequence`));
});

test('fresh database has every table the Worker writes to', () => {
  const tables = Object.keys(shape(fresh()));
  const written = new Set([...read('worker.mjs').matchAll(/(?:INSERT (?:OR IGNORE )?INTO|DELETE FROM|UPDATE)\s+([a-z_]+)/g)].map(m => m[1]));
  assert.ok(written.size >= 6);
  for (const t of written) assert.ok(tables.includes(t), `Worker writes to ${t}, which no migration creates`);
});

test('positional INSERT ... VALUES in the Worker match column counts', () => {
  const cols = shape(fresh());
  const inserts = [...read('worker.mjs').matchAll(/INSERT INTO ([a-z_]+) VALUES\(([?,]+)\)/g)];
  assert.ok(inserts.length >= 4);
  for (const [, table, marks] of inserts) assert.equal(marks.split(',').length, cols[table].length, `${table} positional insert arity`);
});

test('migrations are idempotent and preserve existing data', () => {
  const db = fresh();
  db.prepare("INSERT INTO tokens VALUES('h','c','agent',1,'access')").run();
  db.prepare("INSERT INTO requests(id,client,idem,kind,payload,status,created,updated) VALUES('r','c','i','lookup','{}','queued',1,1)").run();
  db.prepare("INSERT INTO subscriptions(id,callback,secret,expires,created,client) VALUES('s','https://chatgpt.com/x','whsec_x',1,1,'c')").run();
  const before = shape(db);
  for (const f of migrations) db.exec(read('migrations/' + f));
  assert.deepEqual(shape(db), before);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tokens').get().n, 1);
  assert.equal(db.prepare('SELECT status FROM requests').get().status, 'queued');
  assert.equal(db.prepare('SELECT client FROM subscriptions').get().client, 'c');
});

test('restore quarantine invalidates credentials and prevents replay while preserving completed results', () => {
  const db = fresh();
  db.exec("INSERT INTO tokens VALUES('hash','client','worker',9999999999999,'access'); INSERT INTO clients VALUES('client','fixture','[]',1);");
  for (const status of ['queued', 'processing', 'completed']) {
    db.prepare('INSERT INTO requests(id,client,idem,kind,payload,status,result,created,updated,lease,lease_expires) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(status, 'client', status, 'lookup', '{}', status, status === 'completed' ? 'retained result' : null, 1, 1, 'old-lease', 9999999999999);
  }
  db.exec(read('maintenance/quarantine-restored-copy.sql'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tokens').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM clients').get().n, 0);
  for (const id of ['queued', 'processing']) {
    const request = db.prepare('SELECT status,lease,lease_expires FROM requests WHERE id=?').get(id);
    assert.deepEqual({ ...request }, { status: 'failed', lease: null, lease_expires: null });
  }
  assert.equal(db.prepare("SELECT result FROM requests WHERE id='completed'").get().result, 'retained result');
});

test('legacy 0.1.0 database upgrades to the same schema and keeps rows', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(v010);
  db.prepare("INSERT INTO subscriptions VALUES('s','https://chatgpt.com/x','whsec_x',1,1)").run();
  db.exec(read('legacy-migrations/0.1.0-to-0.1.2.sql'));
  for (const f of migrations) db.exec(read('migrations/' + f));
  assert.deepEqual(shape(db), shape(fresh()));
  assert.equal(db.prepare('SELECT id FROM subscriptions').get().id, 's');
});

test('regression-test schema in bridge.test.mjs has not drifted from migrations', () => {
  const m = read('bridge.test.mjs').match(/const schema=`([^`]+)`/);
  if (!m) return; // test now loads migrations directly
  const db = new DatabaseSync(':memory:'); db.exec(m[1]);
  assert.deepEqual(shape(db), shape(fresh()));
});
