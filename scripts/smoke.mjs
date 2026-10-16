// Clean-checkout smoke test: real workerd + local D1 built from migrations/, driven over HTTPS.
// Covers OAuth+PKCE, role separation, queue/outbox, lease flow, cron handler, refresh and revocation.
// No Cloudflare account, network login or remote resource is used. Throwaway codes only.
import { spawn, spawnSync } from 'node:child_process';
import { request as httpsRequest } from 'node:https';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

process.env.WRANGLER_SEND_METRICS = 'false';
const root = new URL('..', import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), 'bridge-smoke-'));
const port = 20000 + Math.floor(Math.random() * 20000), base = `https://localhost:${port}`;
const b64u = b => Buffer.from(b).toString('base64url'), sha = s => createHash('sha256').update(s).digest('base64url');
const codes = { agent: b64u(randomBytes(24)), worker: b64u(randomBytes(24)) };
const wrangler = (...a) => spawnSync('npx', ['wrangler', ...a], { cwd: root, encoding: 'utf8', env: { ...process.env, CI: '1' } });
const d1 = sql => { const r = wrangler('d1', 'execute', 'DB', '--local', '--persist-to', tmp, '--json', '--command', sql); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout)[0].results; };

const envFile = join(tmp, 'smoke.env');
writeFileSync(envFile, `AGENT_LOGIN_HASH=${sha(codes.agent)}\nWORKER_LOGIN_HASH=${sha(codes.worker)}\nPUBLIC_ORIGIN=${base}\n`, { mode: 0o600 });
const mig = wrangler('d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', tmp);
assert.equal(mig.status, 0, mig.stderr + mig.stdout);

const dev = spawn('npx', ['wrangler', 'dev', '--local', '--local-protocol', 'https', '--port', String(port), '--persist-to', tmp, '--env-file', envFile, '--test-scheduled', '--show-interactive-dev-session=false'],
  { cwd: root, detached: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, CI: '1' } });
let devErr = ''; dev.stderr.on('data', d => { devErr += d; });
const stop = () => { try { process.kill(-dev.pid, 'SIGTERM'); } catch {} };
process.on('exit', stop);

async function ready() {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(base + '/health')).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('wrangler dev did not start\n' + devErr.slice(-2000));
}
const rpc = (token, method, params, id = 1) => fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', ...(token && { authorization: 'Bearer ' + token }) }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) }).then(async r => ({ status: r.status, headers: r.headers, body: await r.json() }));
const tool = async (token, name, args) => { const r = await rpc(token, 'tools/call', { name, arguments: args }); return r.body.result; };

async function connect(label, role, code) {
  const reg = await (await fetch(base + '/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: label, redirect_uris: ['http://localhost:9/cb'], token_endpoint_auth_method: 'none' }) })).json();
  const verifier = b64u(randomBytes(32)), challenge = sha(verifier), redirect = 'http://localhost:9/cb';
  const q = new URLSearchParams({ client_id: reg.client_id, redirect_uri: redirect, response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge, state: 's1', scope: role, resource: base + '/mcp' });
  const page = await fetch(base + '/authorize?' + q);
  assert.equal(page.status, 200);
  const consent = (await page.text()).match(/name="consent" value="([^"]+)"/)[1], cookie = page.headers.get('set-cookie').split(';')[0];
  const form = (secret) => fetch(base + '/authorize', { method: 'POST', headers: { origin: base, cookie }, body: new URLSearchParams({ consent, role, secret }) });
  const wrong = await form('wrong-code');
  assert.equal(wrong.status, 403, 'wrong connection code must be rejected');
  const ok = await form(code);
  assert.equal(ok.status, 302);
  const loc = new URL(ok.headers.get('location'));
  assert.equal(loc.searchParams.get('state'), 's1');
  const exchange = body => fetch(base + '/token', { method: 'POST', body: new URLSearchParams(body) });
  const grant = { grant_type: 'authorization_code', code: loc.searchParams.get('code'), client_id: reg.client_id, redirect_uri: redirect, code_verifier: verifier };
  const tokens = await (await exchange(grant)).json();
  assert.equal(tokens.scope, role);
  assert.equal((await exchange(grant)).status, 400, 'authorization code is single use');
  return { clientId: reg.client_id, ...tokens };
}

// wrangler dev serves a self-signed localhost cert. Certificate checks are skipped only for this
// localhost-only client; nothing else in the process (and nothing the Worker does) is affected.
const localAgent = { rejectUnauthorized: false };
function fetch(url, { method = 'GET', headers = {}, body } = {}) {
  const u = new URL(url);
  if (u.hostname !== 'localhost') throw new Error('smoke client only talks to localhost: ' + u.hostname);
  const payload = body instanceof URLSearchParams ? body.toString() : body;
  const h = { ...headers, ...(body instanceof URLSearchParams && { 'content-type': 'application/x-www-form-urlencoded' }) };
  return new Promise((resolve, reject) => {
    const req = httpsRequest(u, { method, headers: h, ...localAgent }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, ok: res.statusCode < 300, text: async () => text, json: async () => JSON.parse(text),
          headers: { get: n => { const v = res.headers[n.toLowerCase()]; return Array.isArray(v) ? v.join(', ') : v ?? null; } } }); });
    });
    req.on('error', reject); if (payload) req.write(payload); req.end();
  });
}

const steps = [];
const step = async (name, fn) => { await fn(); steps.push(name); console.log('ok  ' + name); };
try {
  await ready();
  await step('discovery documents', async () => {
    const meta = await (await fetch(base + '/.well-known/oauth-authorization-server')).json();
    assert.equal(meta.issuer, base); assert.deepEqual(meta.code_challenge_methods_supported, ['S256']);
    const res = await (await fetch(base + '/.well-known/oauth-protected-resource/mcp')).json();
    assert.equal(res.resource, base + '/mcp');
  });
  await step('unauthenticated MCP call is 401 with resource metadata', async () => {
    const r = await rpc(null, 'ping', {});
    assert.equal(r.status, 401); assert.match(r.headers.get('www-authenticate'), /resource_metadata=/);
  });
  const agent = await connect('smoke-agent', 'agent', codes.agent), worker = await connect('smoke-worker', 'worker', codes.worker);
  await step('OAuth + PKCE for both roles (wrong code rejected, code single use)', async () => assert.ok(agent.access_token && worker.access_token));
  await step('role separation of tools/list and cross-role denial', async () => {
    const names = async t => (await rpc(t.access_token, 'tools/list', {})).body.result.tools.map(x => x.name).sort();
    assert.deepEqual(await names(agent), ['bridge_status', 'get_result', 'lookup_context', 'request_document_edit', 'save_transcript']);
    assert.deepEqual(await names(worker), ['bridge_status', 'claim_request', 'complete_request', 'pending_requests']);
    const denied = await rpc(agent.access_token, 'tools/call', { name: 'claim_request', arguments: { request_id: 'x' } });
    assert.ok(denied.body.error || denied.body.result?.isError, 'agent must not reach worker tools');
  });
  await step('queue refuses work without a subscribed worker', async () => {
    assert.equal((await tool(agent.access_token, 'lookup_context', { query: 'q', idempotency_key: 'k0' })).isError, true);
  });
  // Event subscription needs a signed callback to chatgpt.com, which a local test cannot answer, so seed the row.
  // The subscribe/verify handshake is covered by bridge.test.mjs; the callback host never resolves here.
  d1(`INSERT INTO subscriptions(id,callback,secret,expires,created,client) VALUES('sub_smoke','https://bridge-smoke-nonexistent.chatgpt.com/hook','whsec_${Buffer.alloc(32, 7).toString('base64')}',${Date.now() + 3600000},${Date.now()},'${worker.clientId}')`);
  let requestId;
  await step('lookup is queued once per idempotency key and writes an outbox row', async () => {
    const a = (await tool(agent.access_token, 'lookup_context', { query: 'smoke query', idempotency_key: 'k1' })).structuredContent;
    const b = (await tool(agent.access_token, 'lookup_context', { query: 'smoke query', idempotency_key: 'k1' })).structuredContent;
    assert.equal(a.status, 'queued'); assert.equal(a.request_id, b.request_id);
    requestId = a.request_id;
    assert.equal(d1(`SELECT COUNT(*) n FROM deliveries WHERE request='${requestId}'`)[0].n, 1);
    assert.equal((await tool(agent.access_token, 'bridge_status', {})).structuredContent.worker_connected, true);
  });
  await step('worker lease flow completes the request and agent reads it', async () => {
    assert.ok((await tool(worker.access_token, 'pending_requests', {})).structuredContent.requests.some(r => r.id === requestId));
    const claim = (await tool(worker.access_token, 'claim_request', { request_id: requestId })).structuredContent;
    assert.equal(claim.payload.query, 'smoke query');
    assert.equal((await tool(worker.access_token, 'claim_request', { request_id: requestId })).isError, true, 'second claim blocked by lease');
    assert.equal((await tool(worker.access_token, 'complete_request', { request_id: requestId, lease_token: 'bad', status: 'completed', result: 'x' })).isError, true);
    await tool(worker.access_token, 'complete_request', { request_id: requestId, lease_token: claim.lease_token, status: 'completed', result: 'smoke result' });
    const got = (await tool(agent.access_token, 'get_result', { request_id: requestId })).structuredContent;
    assert.equal(got.status, 'completed'); assert.equal(got.result, 'smoke result');
  });
  await step('cron handler runs against D1 and failed delivery is counted for retry', async () => {
    const r = await fetch(`${base}/__scheduled?cron=*/5+*+*+*+*`);
    assert.equal(r.status, 200);
    for (let i = 0; i < 30 && d1(`SELECT attempts FROM deliveries WHERE request='${requestId}'`)[0].attempts < 1; i++) await new Promise(r => setTimeout(r, 1000));
    assert.ok(d1(`SELECT attempts FROM deliveries WHERE request='${requestId}'`)[0].attempts >= 1, 'failed delivery must be counted for retry');
  });
  let usedRefresh;
  await step('refresh rotation', async () => {
    const refresh = body => fetch(base + '/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: agent.clientId, refresh_token: body }) });
    usedRefresh = agent.refresh_token;
    const first = await refresh(agent.refresh_token); assert.equal(first.status, 200);
    Object.assign(agent, await first.json());
  });
  await step('revoking the worker removes its subscription and blocks new work', async () => {
    assert.equal((await fetch(base + '/revoke', { method: 'POST', body: new URLSearchParams({ token: worker.access_token, client_id: worker.clientId }) })).status, 200);
    assert.equal((await rpc(worker.access_token, 'ping', {})).status, 401);
    assert.equal((await tool(agent.access_token, 'lookup_context', { query: 'after', idempotency_key: 'k2' })).isError, true);
  });
  await step('replaying a used refresh token invalidates its replacement grant', async () => {
    const replay = await fetch(base + '/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: agent.clientId, refresh_token: usedRefresh }) });
    assert.equal(replay.status, 400);
    assert.equal((await rpc(agent.access_token, 'ping', {})).status, 401);
  });
  console.log(`\nSmoke passed: ${steps.length} checks against ${base} (local workerd + D1)`);
} catch (e) {
  console.error(e); console.error('--- wrangler dev stderr (tail) ---\n' + devErr.slice(-1500)); process.exitCode = 1;
} finally { stop(); rmSync(tmp, { recursive: true, force: true }); }
