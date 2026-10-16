// Shared test harness: loads worker.mjs with its internals exported and emulates the D1
// binding with node:sqlite. This is a local emulation, not a Cloudflare interoperability test:
// node:sqlite is synchronous, so "concurrent" tests only interleave at await points.
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';

const source = readFileSync(new URL('../worker.mjs', import.meta.url), 'utf8');
export const worker = await import('data:text/javascript;base64,' + Buffer.from(
  source + '\nexport {events,queue,callTool,digest,signedFetch,rateLimit,issueTokens,deliveries,cleanup,recoverStalled};').toString('base64'));

// Tests run against the real D1 migrations, so a migration that drifts from the code fails here.
function schemaSql() {
  const dir = new URL('../migrations/', import.meta.url);
  return readdirSync(dir).filter(f => f.endsWith('.sql')).sort().map(f => readFileSync(new URL(f, dir), 'utf8')).join('\n');
}

export const ORIGIN = 'https://bridge.example.com';
export const AGENT_CODE = 'fixture-agent-code';
export const WORKER_CODE = 'fixture-worker-code';
export const CALLBACK = 'https://chatgpt.com/hooks/fixture';
export const webhookSecret = (fill = 1) => 'whsec_' + Buffer.alloc(32, fill).toString('base64');

export async function setup({ pinned = true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(schemaSql());
  const run = (s, params) => {
    const stmt = db.prepare(s);
    // D1 reports changes in result.meta; RETURNING statements still return rows via first().
    const info = stmt.run(...params);
    return { meta: { changes: Number(info.changes) } };
  };
  const DB = {
    prepare(s) {
      return { bind(...params) {
        return {
          first: async () => db.prepare(s).get(...params) || null,
          all: async () => ({ results: db.prepare(s).all(...params) }),
          run: async () => run(s, params),
          _sync: () => run(s, params),
        };
      } };
    },
    async batch(statements) {
      db.exec('BEGIN');
      try { const out = statements.map(s => s._sync()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
  const env = {
    DB,
    AGENT_LOGIN_HASH: await worker.digest(AGENT_CODE),
    WORKER_LOGIN_HASH: await worker.digest(WORKER_CODE),
    ...(pinned ? { PUBLIC_ORIGIN: ORIGIN } : {}),
  };
  const background = [];
  const ctx = { waitUntil: p => background.push(p) };
  const count = (table, where = '1=1', ...params) => db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`).get(...params).n;
  return { db, env, ctx, background, count, fetch: (path, init) => worker.default.fetch(new Request(ORIGIN + path, init), env, ctx) };
}

export async function insertToken(h, { client = 'agent-a', role = 'agent', secret = 'test-access', kind = 'access', ttl = 3600000 } = {}) {
  h.db.prepare('INSERT INTO tokens VALUES(?,?,?,?,?)').run(await worker.digest(secret), client, role, Date.now() + ttl, kind);
  return secret;
}

export function insertSubscription(h, { client = 'worker-a', id = 'sub-test', expires = Date.now() + 3600000 } = {}) {
  h.db.prepare('INSERT INTO subscriptions(id,callback,secret,expires,created,client) VALUES(?,?,?,?,?,?)')
    .run(id, CALLBACK, webhookSecret(), expires, Date.now(), client);
}

// A worker that is subscribed and authorized, as needed before agents can queue requests.
export async function connectWorker(h, client = 'worker-a') {
  await insertToken(h, { client, role: 'worker', secret: 'worker-access-' + client });
  insertSubscription(h, { client, id: 'sub-' + client });
}

// Initialization-era JSON-RPC call (no _meta, no protocol headers).
export async function legacyRpc(h, token, method, params, { id = 1, notification = false, headers = {} } = {}) {
  const response = await h.fetch('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, ...(params ? { params } : {}) }),
  });
  return { status: response.status, response, body: response.status === 202 ? null : await response.json() };
}

// MCP 2026-07-28 call with the required per-request _meta and mirrored headers.
export async function modernRpc(h, token, method, params = {}, { id = 1, headers = {}, meta = {} } = {}) {
  const body = { jsonrpc: '2.0', id, method, params: { ...params, _meta: {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {},
    'io.modelcontextprotocol/clientInfo': { name: 'fixture-client', version: '1.0.0' },
    ...meta,
  } } };
  const mirrored = { 'mcp-protocol-version': '2026-07-28', 'mcp-method': method, ...(params.name ? { 'mcp-name': params.name } : {}) };
  const response = await h.fetch('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + token, ...mirrored, ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, response, body: await response.json() };
}

export const toolResult = rpc => rpc.body.result.structuredContent;

// Runs the real register -> authorize -> consent -> token flow and returns the token pair.
export async function oauthFlow(h, { code = AGENT_CODE, role = 'agent', redirect = 'http://localhost:12345/callback', verifier = 'v'.repeat(43), state = 'fixture-state', clientId } = {}) {
  if (!clientId) {
    const registered = await h.fetch('/register', { method: 'POST', body: JSON.stringify({ client_name: 'Fixture', redirect_uris: [redirect] }) });
    clientId = (await registered.json()).client_id;
  }
  const query = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', code_challenge_method: 'S256', code_challenge: await worker.digest(verifier), state, scope: role });
  const form = await h.fetch('/authorize?' + query);
  const consent = (await form.text()).match(/name="consent" value="([^"]+)"/)[1];
  const cookie = form.headers.get('set-cookie').split(';')[0];
  const approved = await h.fetch('/authorize', { method: 'POST', headers: { origin: ORIGIN, cookie }, body: new URLSearchParams({ consent, role, secret: code }) });
  const location = new URL(approved.headers.get('location'));
  const exchange = await h.fetch('/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code: location.searchParams.get('code'), client_id: clientId, redirect_uri: redirect, code_verifier: verifier }) });
  return { clientId, location, tokens: await exchange.json(), status: exchange.status };
}

// Standard Webhooks verification as a receiver would do it.
export function verifySignature(headers, body, secret) {
  const key = Buffer.from(secret.slice(6), 'base64');
  const expected = 'v1,' + createHmac('sha256', key).update(`${headers['webhook-id']}.${headers['webhook-timestamp']}.${body}`).digest('base64');
  return headers['webhook-signature'].split(' ').includes(expected);
}

// A ChatGPT callback stub. `reply(body, headers)` returns the Response to send.
export function mockCallback(t, reply = body => {
  const parsed = JSON.parse(body);
  return new Response(JSON.stringify(parsed.type === 'verification' ? { challenge: parsed.challenge } : {}), { status: 200 });
}) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body, parsed: JSON.parse(init.body), redirect: init.redirect });
    return reply(init.body, init.headers);
  });
  return calls;
}

// Freezes Date.now so expiry, leases and backoff can be stepped deterministically.
export function useClock(t, start = Date.now()) {
  const clock = { now: start, advance(ms) { clock.now += ms; } };
  t.mock.method(Date, 'now', () => clock.now);
  return clock;
}
