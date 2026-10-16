// Regression tests carried over from 0.1.5. Newer coverage lives in oauth.test.mjs,
// mcp.test.mjs and events.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { worker as mod, setup, insertToken, insertSubscription, legacyRpc, ORIGIN, CALLBACK } from './support/harness.mjs';

test('unauthenticated and malformed RPC fail closed', async () => {
  const h = await setup();
  assert.equal((await legacyRpc(h, null, 'ping')).status, 401);
  await insertToken(h);
  const r = await h.fetch('/mcp', { method: 'POST', headers: { authorization: 'Bearer test-access' }, body: 'null' });
  assert.equal(r.status, 400);
});

test('agent cannot discover worker events or call worker tools', async () => {
  const h = await setup();
  await insertToken(h);
  assert.ok((await legacyRpc(h, 'test-access', 'events/list')).body.error);
  const list = await legacyRpc(h, 'test-access', 'tools/list');
  assert.equal(list.body.result.tools.length, 5);
  assert.ok(!list.body.result.tools.some(t => t.name === 'claim_request'));
});

test('queue requires a currently authorized worker', async () => {
  const h = await setup();
  insertSubscription(h);
  await assert.rejects(mod.queue(h.env, { client: 'a' }, 'lookup', { query: 'test' }, 'test-key'), /No ChatGPT worker/);
  await insertToken(h, { client: 'worker-a', role: 'worker' });
  assert.equal((await mod.queue(h.env, { client: 'a' }, 'lookup', { query: 'test' }, 'test-key')).status, 'queued');
  assert.equal(h.count('deliveries'), 1);
});

test('concurrent idempotency produces one request and delivery', async () => {
  const h = await setup();
  insertSubscription(h);
  await insertToken(h, { client: 'worker-a', role: 'worker' });
  const out = await Promise.all([1, 2].map(() => mod.queue(h.env, { client: 'a' }, 'lookup', { query: 'test' }, 'key')));
  assert.equal(out[0].request_id, out[1].request_id);
  assert.equal(h.count('requests'), 1);
  assert.equal(h.count('deliveries'), 1);
  await assert.rejects(mod.queue(h.env, { client: 'a' }, 'lookup', { query: 'different' }, 'key'), /different input/);
});

test('request results isolated between clients', async () => {
  const h = await setup();
  insertSubscription(h);
  await insertToken(h, { client: 'worker-a', role: 'worker' });
  const r = await mod.queue(h.env, { client: 'a' }, 'lookup', { query: 'test' }, 'key');
  await assert.rejects(mod.callTool(h.env, { client: 'b', role: 'agent' }, 'get_result', { request_id: r.request_id }), /not found/);
});

test('unsubscribe cannot remove another client subscription', async () => {
  const h = await setup();
  const id = 'sub_' + await mod.digest(`owner|${CALLBACK}|request.created|{}`);
  h.db.prepare('INSERT INTO subscriptions(id,callback,secret,expires,created,client) VALUES(?,?,?,?,?,?)').run(id, CALLBACK, 'secret', Date.now() + 60000, Date.now(), 'owner');
  const params = { name: 'request.created', arguments: {}, delivery: { url: CALLBACK } };
  await assert.rejects(mod.events(h.env, { client: 'other', role: 'worker' }, 'events/unsubscribe', params), /not found/);
  assert.equal(h.count('subscriptions'), 1);
  await mod.events(h.env, { client: 'owner', role: 'worker' }, 'events/unsubscribe', params);
  assert.equal(h.count('subscriptions'), 0);
});

test('revocation stops that worker subscriptions', async () => {
  const h = await setup();
  const access = await insertToken(h, { client: 'worker-a', role: 'worker' });
  insertSubscription(h);
  const r = await h.fetch('/revoke', { method: 'POST', body: new URLSearchParams({ token: access, client_id: 'worker-a' }) });
  assert.equal(r.status, 200);
  assert.equal(h.count('subscriptions'), 0);
});

test('rotation sends signatures verifiable with old and new keys', async () => {
  let captured;
  const old = Buffer.alloc(32, 1), current = Buffer.alloc(32, 2);
  await mod.signedFetch({ id: 'sub-test', callback: CALLBACK, secret: 'whsec_' + current.toString('base64'), previous_secret: 'whsec_' + old.toString('base64'), rotate_until: Date.now() + 60000 },
    { eventId: 'event-test', name: 'request.created' }, async (url, opts) => { captured = opts; return new Response('{}'); });
  for (const key of [old, current]) {
    const h = captured.headers;
    const sig = createHmac('sha256', key).update(h['webhook-id'] + '.' + h['webhook-timestamp'] + '.' + captured.body).digest('base64');
    assert.ok(h['webhook-signature'].split(' ').includes('v1,' + sig));
  }
  assert.equal(captured.redirect, 'error');
  await assert.rejects(mod.signedFetch({ callback: 'https://evil.example/callback' }, {}), /not allowed/);
});

test('registration rate limit rejects excessive attempts', async () => {
  const h = await setup();
  const req = new Request(ORIGIN + '/register', { headers: { 'cf-connecting-ip': '192.0.2.1' } });
  await mod.rateLimit(req, h.env, 'test', 2, 60000);
  await mod.rateLimit(req, h.env, 'test', 2, 60000);
  await assert.rejects(mod.rateLimit(req, h.env, 'test', 2, 60000), /Too many attempts/);
});

test('revocation invalidates access and refresh siblings', async () => {
  const h = await setup();
  const pair = await mod.issueTokens(h.env, 'worker-a', 'worker', null, ORIGIN);
  insertSubscription(h);
  const r = await h.fetch('/revoke', { method: 'POST', body: new URLSearchParams({ token: pair.access_token, client_id: 'worker-a' }) });
  assert.equal(r.status, 200);
  assert.equal(h.count('tokens'), 0);
  assert.equal(h.count('subscriptions'), 0);
});

test('concurrent rotation consumes once and leaves a used-refresh marker', async () => {
  const h = await setup();
  const pair = await mod.issueTokens(h.env, 'worker-a', 'worker', null, ORIGIN);
  const hash = await mod.digest(pair.refresh_token);
  const results = await Promise.all([1, 2].map(() => mod.issueTokens(h.env, 'worker-a', 'worker', hash, ORIGIN)));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(h.count('tokens', "hash=? AND kind='refresh_used'", hash), 1);
  assert.equal(h.count('tokens', "kind='refresh'"), 1);
});

test('OAuth form preserves same-origin POST Origin while rejecting foreign origins', async () => {
  const h = await setup();
  h.db.prepare('INSERT INTO clients VALUES(?,?,?,?)').run('client-test', 'test', '["http://localhost:12345/callback"]', Date.now());
  const q = new URLSearchParams({ client_id: 'client-test', redirect_uri: 'http://localhost:12345/callback', response_type: 'code', code_challenge_method: 'S256', code_challenge: 'a'.repeat(43) });
  const r = await h.fetch('/authorize?' + q);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('referrer-policy'), 'same-origin');
  const denied = await h.fetch('/authorize', { method: 'POST', headers: { origin: 'https://foreign.example' }, body: '' });
  assert.equal(denied.status, 403);
});

test('simultaneous OAuth attempts keep independent CSRF cookies and permit registered callback', async () => {
  const h = await setup();
  h.env.AGENT_LOGIN_HASH = await mod.digest('fixture-code');
  const redirect = 'http://localhost:12345/callback', verifier = 'v'.repeat(43), challenge = await mod.digest(verifier);
  h.db.prepare('INSERT INTO clients VALUES(?,?,?,?)').run('client-test', 'test', JSON.stringify([redirect]), Date.now());
  const q = new URLSearchParams({ client_id: 'client-test', redirect_uri: redirect, response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge, state: 'fixture-state' });
  const flows = [];
  for (let i = 0; i < 2; i++) {
    const r = await h.fetch('/authorize?' + q);
    assert.ok(r.headers.get('content-security-policy').includes("form-action 'self' http://localhost:12345"));
    const consent = (await r.text()).match(/name="consent" value="([^"]+)"/)[1];
    flows.push({ consent, cookie: r.headers.get('set-cookie').split(';')[0] });
  }
  assert.notEqual(flows[0].cookie.split('=')[0], flows[1].cookie.split('=')[0]);
  const cookies = flows.map(f => f.cookie).join('; ');
  for (const f of flows) {
    const r = await h.fetch('/authorize', { method: 'POST', headers: { origin: ORIGIN, cookie: cookies }, body: new URLSearchParams({ consent: f.consent, role: 'agent', secret: 'fixture-code' }) });
    assert.equal(r.status, 302);
    const location = new URL(r.headers.get('location'));
    assert.equal(location.origin, 'http://localhost:12345');
    assert.equal(location.searchParams.get('state'), 'fixture-state');
    const exchange = await h.fetch('/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code: location.searchParams.get('code'), client_id: 'client-test', redirect_uri: redirect, code_verifier: verifier }) });
    assert.equal(exchange.status, 200);
    const pair = await exchange.json();
    assert.equal(pair.scope, 'agent');
    assert.ok(pair.access_token);
  }
});

test('MCP responses include required result discriminant and cache fields', async () => {
  const h = await setup();
  await insertToken(h);
  for (const method of ['server/discover', 'tools/list', 'tools/call', 'ping']) {
    const { body } = await legacyRpc(h, 'test-access', method, method === 'tools/call' ? { name: 'bridge_status', arguments: {} } : {});
    assert.equal(body.result.resultType, 'complete');
    if (method === 'server/discover' || method === 'tools/list') {
      assert.equal(body.result.cacheScope, 'private');
      assert.ok(Number.isInteger(body.result.ttlMs));
    }
  }
});
