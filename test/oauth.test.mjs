// OAuth request lifecycle through the real HTTP handlers (local D1 emulation).
import test from 'node:test';
import assert from 'node:assert/strict';
import { worker, setup, oauthFlow, legacyRpc, useClock, ORIGIN, AGENT_CODE, WORKER_CODE } from '../support/harness.mjs';

const REDIRECT = 'http://localhost:12345/callback';
const form = params => ({ method: 'POST', body: new URLSearchParams(params) });

async function registerClient(h, body = { client_name: 'Fixture', redirect_uris: [REDIRECT] }) {
  const r = await h.fetch('/register', { method: 'POST', body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

async function authorizeQuery(clientId, overrides = {}) {
  return new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', code_challenge_method: 'S256',
    code_challenge: await worker.digest('v'.repeat(43)), state: 'st', ...overrides });
}

async function consentForm(h, clientId, overrides) {
  const r = await h.fetch('/authorize?' + await authorizeQuery(clientId, overrides));
  return { consent: (await r.text()).match(/name="consent" value="([^"]+)"/)[1], cookie: r.headers.get('set-cookie').split(';')[0] };
}

const submit = (h, { consent, cookie }, role = 'agent', secret = AGENT_CODE) =>
  h.fetch('/authorize', { method: 'POST', headers: { origin: ORIGIN, cookie }, body: new URLSearchParams({ consent, role, secret }) });

test('discovery metadata advertises PKCE, issuer response parameter and the MCP resource', async () => {
  const h = await setup();
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    const prm = await (await h.fetch(path)).json();
    assert.equal(prm.resource, ORIGIN + '/mcp');
    assert.deepEqual(prm.authorization_servers, [ORIGIN]);
  }
  const as = await (await h.fetch('/.well-known/oauth-authorization-server')).json();
  assert.equal(as.issuer, ORIGIN);
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(as.token_endpoint_auth_methods_supported, ['none']);
  assert.equal(as.authorization_response_iss_parameter_supported, true);
});

test('origin: inferred from HTTPS request when unpinned, enforced when pinned', async () => {
  const unpinned = await setup({ pinned: false });
  const meta = await (await worker.default.fetch(new Request('https://other.example.net/.well-known/oauth-authorization-server'), unpinned.env, unpinned.ctx)).json();
  assert.equal(meta.issuer, 'https://other.example.net');
  assert.equal((await worker.default.fetch(new Request('http://public.example.net/health'), unpinned.env, unpinned.ctx)).status, 421);
  assert.equal((await worker.default.fetch(new Request('http://localhost:8787/health'), unpinned.env, unpinned.ctx)).status, 200);

  const pinned = await setup();
  assert.equal((await worker.default.fetch(new Request('https://attacker.example/.well-known/oauth-authorization-server'), pinned.env, pinned.ctx)).status, 421);
  for (const bad of ['http://bridge.example.com', ORIGIN + '/path', ORIGIN + '/?q', ORIGIN + '/#frag', 'https://u:p@bridge.example.com']) {
    pinned.env.PUBLIC_ORIGIN = bad;
    assert.equal((await pinned.fetch('/health')).status, 503, bad);
  }
});

test('health reports configuration booleans without values', async () => {
  const h = await setup();
  h.env.WORKER_LOGIN_HASH = '';
  const body = await (await h.fetch('/health')).json();
  assert.deepEqual(body.configured, { database: true, public_origin_pinned: true, agent_code: true, worker_code: false });
  assert.ok(!JSON.stringify(body).includes(h.env.AGENT_LOGIN_HASH));
});

test('full lifecycle: register, consent, exchange, call, refresh, rotate, revoke', async () => {
  const h = await setup();
  const { clientId, location, tokens, status } = await oauthFlow(h);
  assert.equal(status, 200);
  assert.equal(location.searchParams.get('iss'), ORIGIN);
  assert.equal(location.searchParams.get('state'), 'fixture-state');
  assert.equal(tokens.scope, 'agent');
  assert.equal(tokens.token_type, 'Bearer');
  assert.equal((await legacyRpc(h, tokens.access_token, 'tools/list')).status, 200);

  const refreshed = await h.fetch('/token', form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId }));
  assert.equal(refreshed.status, 200);
  const next = await refreshed.json();
  assert.equal(next.scope, 'agent');
  assert.equal((await h.fetch('/revoke', form({ token: next.refresh_token, client_id: clientId }))).status, 200);
  const after = await legacyRpc(h, next.access_token, 'tools/list');
  assert.equal(after.status, 401);
  assert.match(after.response.headers.get('www-authenticate'), /error="invalid_token"/);
  // Reconnecting after revocation is a fresh sign-in with the same registration.
  const reconnect = await oauthFlow(h, { clientId });
  assert.equal(reconnect.status, 200);
});

test('worker code yields a worker-scoped token; roles are enforced server-side', async () => {
  const h = await setup();
  const worker = await oauthFlow(h, { code: WORKER_CODE, role: 'worker' });
  assert.equal(worker.tokens.scope, 'worker');
  const agent = await oauthFlow(h);
  const workerTools = (await legacyRpc(h, worker.tokens.access_token, 'tools/list')).body.result.tools.map(t => t.name);
  assert.ok(workerTools.includes('claim_request') && !workerTools.includes('lookup_context'));
  const denied = await legacyRpc(h, worker.tokens.access_token, 'tools/call', { name: 'lookup_context', arguments: { query: 'q', idempotency_key: 'k' } });
  assert.equal(denied.body.error.code, -32602);
  const agentClaim = await legacyRpc(h, agent.tokens.access_token, 'tools/call', { name: 'claim_request', arguments: { request_id: 'x' } });
  assert.equal(agentClaim.body.error.code, -32602);
});

test('consent rejects the wrong connection code, a mismatched role code, and reuse', async () => {
  const h = await setup();
  const { body } = await registerClient(h);
  const attempt = await consentForm(h, body.client_id);
  assert.equal((await submit(h, attempt, 'agent', 'wrong-code')).status, 403);
  assert.equal((await submit(h, attempt, 'worker', AGENT_CODE)).status, 403);
  assert.equal((await submit(h, attempt)).status, 302);
  assert.equal((await submit(h, attempt)).status, 403);
});

test('consent requires its own CSRF cookie, same-origin form and an unexpired consent', async t => {
  const clock = useClock(t);
  const h = await setup();
  const { body } = await registerClient(h);
  const a = await consentForm(h, body.client_id), b = await consentForm(h, body.client_id);
  assert.equal((await submit(h, { consent: a.consent, cookie: b.cookie })).status, 403);
  const noOrigin = await h.fetch('/authorize', { method: 'POST', headers: { cookie: a.cookie }, body: new URLSearchParams({ consent: a.consent, role: 'agent', secret: AGENT_CODE }) });
  assert.equal(noOrigin.status, 403);
  clock.advance(10 * 60 * 1000 + 1);
  assert.equal((await submit(h, a)).status, 403);
});

test('unconfigured role is reported as a server configuration problem', async () => {
  const h = await setup();
  delete h.env.WORKER_LOGIN_HASH;
  const { body } = await registerClient(h);
  assert.equal((await submit(h, await consentForm(h, body.client_id), 'worker', WORKER_CODE)).status, 503);
});

test('identical agent and worker codes are a configuration error: neither role is granted', async () => {
  const h = await setup();
  h.env.WORKER_LOGIN_HASH = ' ' + h.env.AGENT_LOGIN_HASH + '\n';
  const { body } = await registerClient(h);
  for (const role of ['agent', 'worker']) {
    const r = await submit(h, await consentForm(h, body.client_id), role, AGENT_CODE);
    assert.equal(r.status, 503, role);
    assert.match(await r.text(), /must be different/);
  }
  assert.equal(h.count('codes'), 0);
});

test('authorize errors: unknown client is shown, protocol errors redirect with state and iss', async () => {
  const h = await setup();
  const { body } = await registerClient(h);
  const unknown = await h.fetch('/authorize?' + await authorizeQuery('nope'));
  assert.equal(unknown.status, 400);
  assert.equal(unknown.headers.get('location'), null);
  const wrongRedirect = await h.fetch('/authorize?' + await authorizeQuery(body.client_id, { redirect_uri: 'http://localhost:9/other' }));
  assert.equal(wrongRedirect.status, 400);

  for (const [overrides, error] of [
    [{ code_challenge_method: 'plain' }, 'invalid_request'],
    [{ code_challenge: 'short' }, 'invalid_request'],
    [{ response_type: 'token' }, 'unsupported_response_type'],
    [{ resource: 'https://elsewhere.example/mcp' }, 'invalid_target'],
  ]) {
    const r = await h.fetch('/authorize?' + await authorizeQuery(body.client_id, overrides));
    assert.equal(r.status, 302);
    const location = new URL(r.headers.get('location'));
    assert.equal(location.searchParams.get('error'), error);
    assert.equal(location.searchParams.get('state'), 'st');
    assert.equal(location.searchParams.get('iss'), ORIGIN);
  }
  const duplicated = await h.fetch('/authorize?' + await authorizeQuery(body.client_id) + '&state=again');
  assert.equal(duplicated.status, 400);
});

test('PKCE and code binding negatives return RFC 6749 errors', async t => {
  const clock = useClock(t);
  const h = await setup();
  const { body } = await registerClient(h);
  const codeFor = async () => new URL((await submit(h, await consentForm(h, body.client_id))).headers.get('location')).searchParams.get('code');
  const exchange = async (code, overrides = {}) => {
    const r = await h.fetch('/token', form({ grant_type: 'authorization_code', code, client_id: body.client_id, redirect_uri: REDIRECT, code_verifier: 'v'.repeat(43), ...overrides }));
    return { status: r.status, error: (await r.json()).error };
  };
  const code = await codeFor();
  assert.deepEqual(await exchange(code, { code_verifier: 'w'.repeat(43) }), { status: 400, error: 'invalid_grant' });
  assert.deepEqual(await exchange(code, { code_verifier: 'short' }), { status: 400, error: 'invalid_request' });
  assert.deepEqual(await exchange(code, { client_id: 'another-client' }), { status: 400, error: 'invalid_grant' });
  assert.deepEqual(await exchange(code, { redirect_uri: 'http://localhost:12345/other' }), { status: 400, error: 'invalid_grant' });
  assert.deepEqual(await exchange(code, { resource: 'https://elsewhere.example/mcp' }), { status: 400, error: 'invalid_target' });
  assert.deepEqual(await exchange(code, { code_verifier: '' }), { status: 400, error: 'invalid_request' });
  assert.equal((await exchange(code)).status, 200);
  assert.deepEqual(await exchange(code), { status: 400, error: 'invalid_grant' });

  const expiring = await codeFor();
  clock.advance(5 * 60 * 1000 + 1);
  assert.deepEqual(await exchange(expiring), { status: 400, error: 'invalid_grant' });

  const unsupported = await h.fetch('/token', form({ grant_type: 'client_credentials' }));
  assert.equal((await unsupported.json()).error, 'unsupported_grant_type');
  assert.equal((await h.fetch('/token')).status, 405);
});

test('concurrent exchanges of one authorization code issue exactly one token pair', async () => {
  const h = await setup();
  const { body } = await registerClient(h);
  const code = new URL((await submit(h, await consentForm(h, body.client_id))).headers.get('location')).searchParams.get('code');
  const results = await Promise.all([1, 2, 3].map(() =>
    h.fetch('/token', form({ grant_type: 'authorization_code', code, client_id: body.client_id, redirect_uri: REDIRECT, code_verifier: 'v'.repeat(43) }))));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 400, 400]);
  assert.equal(h.count('tokens'), 2);
});

test('access and refresh expiry', async t => {
  const clock = useClock(t);
  const h = await setup();
  const { clientId, tokens } = await oauthFlow(h);
  clock.advance(60 * 60 * 1000 + 1);
  assert.equal((await legacyRpc(h, tokens.access_token, 'tools/list')).status, 401);
  const refreshed = await h.fetch('/token', form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId }));
  assert.equal(refreshed.status, 200);
  const next = await refreshed.json();
  clock.advance(30 * 24 * 60 * 60 * 1000 + 1);
  const expired = await h.fetch('/token', form({ grant_type: 'refresh_token', refresh_token: next.refresh_token, client_id: clientId }));
  assert.equal((await expired.json()).error, 'invalid_grant');
});

test('refresh tokens are bound to their client; revoke ignores other clients', async () => {
  const h = await setup();
  const a = await oauthFlow(h), b = await oauthFlow(h);
  const stolen = await h.fetch('/token', form({ grant_type: 'refresh_token', refresh_token: a.tokens.refresh_token, client_id: b.clientId }));
  assert.equal((await stolen.json()).error, 'invalid_grant');
  assert.equal((await h.fetch('/revoke', form({ token: a.tokens.access_token, client_id: b.clientId }))).status, 200);
  assert.equal((await legacyRpc(h, a.tokens.access_token, 'tools/list')).status, 200);
  assert.equal((await h.fetch('/revoke', form({ client_id: a.clientId }))).status, 400);
});

test('registration validates metadata with RFC 7591 errors', async () => {
  const h = await setup();
  for (const [metadata, error] of [
    [{ redirect_uris: ['javascript:alert(1)'] }, 'invalid_redirect_uri'],
    [{ redirect_uris: ['http://evil.example/cb'] }, 'invalid_redirect_uri'],
    [{ redirect_uris: ['https://app.example/cb#frag'] }, 'invalid_redirect_uri'],
    [{ redirect_uris: [] }, 'invalid_redirect_uri'],
    [{ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_basic' }, 'invalid_client_metadata'],
    [{ redirect_uris: [REDIRECT], grant_types: ['client_credentials'] }, 'invalid_client_metadata'],
    [{ redirect_uris: [REDIRECT], application_type: 'service' }, 'invalid_client_metadata'],
  ]) {
    const { status, body } = await registerClient(h, metadata);
    assert.equal(status, 400);
    assert.equal(body.error, error, JSON.stringify(metadata));
  }
  const bad = await h.fetch('/register', { method: 'POST', body: '{not json' });
  assert.equal((await bad.json()).error, 'invalid_client_metadata');
  const ok = await registerClient(h, { redirect_uris: ['https://app.example/cb'], application_type: 'web', client_name: '<b>x</b>' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.application_type, 'web');
  const page = await (await h.fetch('/authorize?' + new URLSearchParams({ client_id: ok.body.client_id, redirect_uri: 'https://app.example/cb', response_type: 'code', code_challenge_method: 'S256', code_challenge: 'a'.repeat(43) }))).text();
  assert.ok(page.includes('&lt;b&gt;x&lt;/b&gt;') && !page.includes('<b>x</b>'));
});

test('rate limits: registration, consent form, consent submit and failed token exchanges', async () => {
  const h = await setup();
  const ip = { 'cf-connecting-ip': '198.51.100.7' };
  let last;
  for (let i = 0; i < 21; i++) last = await h.fetch('/register', { method: 'POST', headers: ip, body: JSON.stringify({ redirect_uris: [REDIRECT] }) });
  assert.equal(last.status, 429);

  const { body } = await registerClient(h);
  const query = await authorizeQuery(body.client_id);
  for (let i = 0; i < 31; i++) last = await h.fetch('/authorize?' + query, { headers: ip });
  assert.equal(last.status, 429);
  assert.equal(h.count('consents', '1=1') <= 30 + 1, true);

  for (let i = 0; i < 31; i++) last = await h.fetch('/token', { method: 'POST', headers: ip, body: new URLSearchParams({ grant_type: 'authorization_code', code: 'guess' + i, client_id: 'c', redirect_uri: REDIRECT, code_verifier: 'v'.repeat(43) }) });
  assert.equal(last.status, 429);
  assert.equal((await last.json()).error, 'slow_down');
  // Another address is unaffected: successful clients behind other IPs keep working.
  const other = await oauthFlow(h);
  assert.equal(other.status, 200);
});

test('successful token exchanges are not charged against the failure budget', async () => {
  const h = await setup();
  const { clientId, tokens } = await oauthFlow(h);
  let refresh = tokens.refresh_token;
  for (let i = 0; i < 40; i++) {
    const r = await h.fetch('/token', form({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId }));
    assert.equal(r.status, 200);
    refresh = (await r.json()).refresh_token;
  }
});

test('cross-origin browser requests are rejected on every endpoint', async () => {
  const h = await setup();
  for (const path of ['/token', '/register', '/revoke', '/mcp']) {
    const r = await h.fetch(path, { method: 'POST', headers: { origin: 'https://evil.example' }, body: '' });
    assert.equal(r.status, 403, path);
  }
});

test('token failure budget is per client, so shared backend IPs cannot lock out the owner', async () => {
  const h = await setup();
  const victim = await oauthFlow(h);
  const attacker = await oauthFlow(h);
  for (let i = 0; i < 31; i++) {
    await h.fetch('/token', form({ grant_type: 'refresh_token', refresh_token: 'forged' + i, client_id: attacker.clientId }));
  }
  const blocked = await h.fetch('/token', form({ grant_type: 'refresh_token', refresh_token: attacker.tokens.refresh_token, client_id: attacker.clientId }));
  assert.equal(blocked.status, 429);
  const owner = await h.fetch('/token', form({ grant_type: 'refresh_token', refresh_token: victim.tokens.refresh_token, client_id: victim.clientId }));
  assert.equal(owner.status, 200);
});

const refresh = (h, refresh_token, client_id) => h.fetch('/token', form({ grant_type: 'refresh_token', refresh_token, client_id }));

test('refresh replay revokes the whole connection, including the stolen replacement', async () => {
  const h = await setup();
  const { clientId, tokens } = await oauthFlow(h);
  const other = await oauthFlow(h);
  const next = await (await refresh(h, tokens.refresh_token, clientId)).json();
  // Replaying the rotated token from a mismatched client is rejected without side effects.
  assert.equal((await (await refresh(h, tokens.refresh_token, other.clientId)).json()).error, 'invalid_grant');
  assert.equal((await legacyRpc(h, next.access_token, 'tools/list')).status, 200);
  // A replay bound to the right client is detected: everything the client holds dies.
  const replay = await refresh(h, tokens.refresh_token, clientId);
  assert.equal(replay.status, 400);
  assert.equal((await replay.json()).error, 'invalid_grant');
  assert.equal((await legacyRpc(h, next.access_token, 'tools/list')).status, 401);
  assert.equal((await (await refresh(h, next.refresh_token, clientId)).json()).error, 'invalid_grant');
  assert.equal(h.count('tokens', 'client=?', clientId), 0);
  // Other clients are untouched, and the victim can reconnect with a fresh sign-in.
  assert.equal((await legacyRpc(h, other.tokens.access_token, 'tools/list')).status, 200);
  const reconnect = await oauthFlow(h, { clientId });
  assert.equal(reconnect.status, 200);
  assert.equal((await refresh(h, reconnect.tokens.refresh_token, clientId)).status, 200);
});

test('guessed or other-client refresh tokens cannot revoke a valid grant', async () => {
  const h = await setup();
  const { clientId, tokens } = await oauthFlow(h);
  for (const guess of ['forged', tokens.access_token]) {
    assert.equal((await (await refresh(h, guess, clientId)).json()).error, 'invalid_grant');
  }
  const attacker = await oauthFlow(h);
  assert.equal((await (await refresh(h, tokens.refresh_token, attacker.clientId)).json()).error, 'invalid_grant');
  assert.equal((await legacyRpc(h, tokens.access_token, 'tools/list')).status, 200);
  assert.equal((await refresh(h, tokens.refresh_token, clientId)).status, 200);
});

test('concurrent rotation of one refresh token fails closed: no grant survives', async () => {
  const h = await setup();
  const { clientId, tokens } = await oauthFlow(h);
  const results = await Promise.all([1, 2, 3].map(() => refresh(h, tokens.refresh_token, clientId)));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 400, 400]);
  const winner = await results.find(r => r.status === 200).json();
  assert.equal((await legacyRpc(h, winner.access_token, 'tools/list')).status, 401);
  assert.equal((await refresh(h, winner.refresh_token, clientId)).status, 400);
  assert.equal(h.count('tokens', 'client=?', clientId), 0);
});

const DAY = 24 * 60 * 60 * 1000;

test('owner consent and successful refresh renew client activity; invalid refresh does not', async t => {
  const clock = useClock(t);
  const h = await setup();
  const { body } = await registerClient(h);
  assert.equal(h.count('client_activity'), 0);
  clock.advance(1000);
  assert.equal((await submit(h, await consentForm(h, body.client_id))).status, 302);
  assert.equal(h.db.prepare('SELECT last_used FROM client_activity').get().last_used, clock.now);
  const { tokens } = await oauthFlow(h, { clientId: body.client_id });
  clock.advance(DAY);
  assert.equal((await refresh(h, tokens.refresh_token, body.client_id)).status, 200);
  const used = clock.now;
  assert.equal(h.db.prepare('SELECT last_used FROM client_activity').get().last_used, used);
  clock.advance(DAY);
  assert.equal((await refresh(h, 'forged', body.client_id)).status, 400);
  assert.equal(h.db.prepare('SELECT last_used FROM client_activity').get().last_used, used);
});

test('old authorized registration survives revocation and replay cleanup and reconnects with its cached ID', async t => {
  const clock = useClock(t);
  for (const revoke of [true, false]) {
    const h = await setup();
    const { clientId, tokens } = await oauthFlow(h);
    clock.advance(8 * DAY);
    const next = await (await refresh(h, tokens.refresh_token, clientId)).json();
    if (revoke) await h.fetch('/revoke', form({ token: next.refresh_token, client_id: clientId }));
    else assert.equal((await refresh(h, tokens.refresh_token, clientId)).status, 400);
    await worker.cleanup(h.env);
    assert.equal(h.count('clients', 'id=?', clientId), 1);
    assert.equal((await oauthFlow(h, { clientId })).status, 200);
  }
});

test('cleanup retires only inactive tokenless registrations after their applicable grace period', async t => {
  const clock = useClock(t);
  const h = await setup();
  const insert = h.db.prepare('INSERT INTO clients VALUES(?,?,?,?)');
  for (const [id, age] of [['unused-old', 2 * 3600000], ['unused-new', 1000], ['authorized-old', 38 * DAY], ['authorized-recent', 8 * DAY], ['live-token', 38 * DAY]]) {
    insert.run(id, id, '[]', clock.now - age);
    if (id.startsWith('authorized') || id === 'live-token') h.db.prepare('INSERT INTO client_activity VALUES(?,?)').run(id, clock.now - age);
  }
  h.db.prepare("INSERT INTO tokens VALUES('live','live-token','agent',?,'refresh')").run(clock.now + DAY);
  await worker.cleanup(h.env);
  assert.deepEqual(h.db.prepare('SELECT id FROM clients ORDER BY id').all().map(r => r.id), ['authorized-recent', 'live-token', 'unused-new']);
  assert.equal(h.count('client_activity', "client='authorized-old'"), 0);
});

test('registration at capacity evicts only the oldest never-authorized client and concurrent inserts stay bounded', async () => {
  const h = await setup();
  const now = Date.now();
  const insert = h.db.prepare('INSERT INTO clients VALUES(?,?,?,?)');
  insert.run('cached-owner', 'Owner', '[]', now - 8 * DAY);
  h.db.prepare("INSERT INTO client_activity VALUES('cached-owner',?)").run(now);
  for (let i = 0; i < 999; i++) insert.run('unused-' + i, 'Unused', '[]', now - 1000 + i);
  const results = await Promise.all([1, 2, 3].map(() => registerClient(h)));
  assert.ok(results.every(r => r.status === 201));
  assert.equal(h.count('clients'), 1000);
  assert.equal(h.count('clients', "id='cached-owner'"), 1);
  for (let i = 0; i < 3; i++) assert.equal(h.count('clients', 'id=?', 'unused-' + i), 0);
});
