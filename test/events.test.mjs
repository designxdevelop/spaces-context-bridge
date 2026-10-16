// Draft MCP Events (webhook) subscription, delivery, request queue, leases and retention.
// ChatGPT is replaced by a fetch stub; this proves server behavior, not ChatGPT interop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { worker, setup, insertToken, insertSubscription, connectWorker, modernRpc, legacyRpc, toolResult,
  mockCallback, useClock, verifySignature, webhookSecret, CALLBACK } from '../support/harness.mjs';

const MINUTE = 60 * 1000;
const subscribeParams = (overrides = {}) => ({ name: 'request.created', arguments: {}, delivery: { mode: 'webhook', url: CALLBACK, secret: webhookSecret(), ...overrides.delivery }, ...overrides.top });

async function workerHarness() {
  const h = await setup();
  await insertToken(h, { client: 'worker-a', role: 'worker', secret: 'worker-access' });
  await insertToken(h, { client: 'agent-a', role: 'agent', secret: 'agent-access' });
  return h;
}

const lookup = (h, key = 'k1', query = 'q') =>
  legacyRpc(h, 'agent-access', 'tools/call', { name: 'lookup_context', arguments: { query, idempotency_key: key } });

test('subscribe verifies the callback with a signed single-use challenge', async t => {
  const calls = mockCallback(t);
  const h = await workerHarness();
  const r = await modernRpc(h, 'worker-access', 'events/subscribe', subscribeParams({ top: { ttlMs: 10 * MINUTE } }));
  assert.equal(r.status, 200);
  assert.match(r.body.result.id, /^sub_/);
  assert.equal(r.body.result.resultType, 'complete');
  assert.ok(Date.parse(r.body.result.refreshBefore) > Date.now());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].parsed.type, 'verification');
  assert.match(calls[0].headers['webhook-id'], /^msg_verification_/);
  assert.ok(verifySignature(calls[0].headers, calls[0].body, webhookSecret()));
  assert.equal(calls[0].headers['X-MCP-Subscription-Id'], r.body.result.id);

  // Refreshing a live subscription skips re-verification and rotates the secret with a grace window.
  const refreshed = await modernRpc(h, 'worker-access', 'events/subscribe', subscribeParams({ delivery: { secret: webhookSecret(2) } }));
  assert.equal(refreshed.body.result.id, r.body.result.id);
  assert.equal(calls.length, 1);
  const row = h.db.prepare('SELECT secret,previous_secret,rotate_until FROM subscriptions').get();
  assert.equal(row.secret, webhookSecret(2));
  assert.equal(row.previous_secret, webhookSecret());
  assert.ok(row.rotate_until > Date.now());
});

test('callback verification failures map to draft CallbackEndpointError reasons', async t => {
  const h = await workerHarness();
  for (const [reply, reason] of [
    [() => new Response('{}', { status: 200 }), 'challenge_failed'],
    [() => new Response('not json', { status: 200 }), 'challenge_failed'],
    [() => new Response('', { status: 404 }), 'http_4xx'],
    [() => new Response('', { status: 503 }), 'http_5xx'],
    [() => { throw new TypeError('fetch failed'); }, 'connection_refused'],
    [() => { throw new DOMException('timed out', 'TimeoutError'); }, 'timeout'],
  ]) {
    t.mock.restoreAll();
    mockCallback(t, reply);
    const r = await legacyRpc(h, 'worker-access', 'events/subscribe', subscribeParams());
    assert.equal(r.body.error.code, -32027);
    assert.equal(r.body.error.data.reason, reason);
  }
  assert.equal(h.count('subscriptions'), 0);
});

test('subscribe validation: role, event name, callback host, delivery mode and secret', async t => {
  const calls = mockCallback(t);
  const h = await workerHarness();
  const agentTry = await legacyRpc(h, 'agent-access', 'events/subscribe', subscribeParams());
  assert.equal(agentTry.body.error.code, -32024);
  assert.equal((await legacyRpc(h, 'agent-access', 'events/list')).body.error.code, -32024);
  const cases = [
    [subscribeParams({ top: { name: 'other.event' } }), -32023],
    [subscribeParams({ top: { arguments: { filter: 'x' } } }), -32602],
    [subscribeParams({ delivery: { url: 'https://attacker.example/hook' } }), -32602],
    [subscribeParams({ delivery: { url: 'https://chatgpt.com.attacker.example/hook' } }), -32602],
    [subscribeParams({ delivery: { url: 'https://chatgpt.com:8443/hook' } }), -32602],
    [subscribeParams({ delivery: { url: 'http://chatgpt.com/hook' } }), -32602],
    [subscribeParams({ delivery: { mode: 'poll' } }), -32026],
    [subscribeParams({ delivery: { secret: 'whsec_' + Buffer.alloc(8).toString('base64') } }), -32602],
    [subscribeParams({ delivery: { secret: 'not-a-secret' } }), -32602],
  ];
  for (const [params, code] of cases) {
    assert.equal((await legacyRpc(h, 'worker-access', 'events/subscribe', params)).body.error.code, code, JSON.stringify(params));
  }
  assert.equal(calls.length, 0, 'no callback is contacted for invalid subscriptions');
});

test('draft-shaped unsubscribe (delivery.url only) removes only the caller subscription', async t => {
  mockCallback(t);
  const h = await workerHarness();
  await legacyRpc(h, 'worker-access', 'events/subscribe', subscribeParams());
  const params = { name: 'request.created', arguments: {}, delivery: { url: CALLBACK } };
  const r = await legacyRpc(h, 'worker-access', 'events/unsubscribe', params);
  assert.deepEqual(r.body.result.resultType, 'complete');
  assert.equal(h.count('subscriptions'), 0);
  assert.equal((await legacyRpc(h, 'worker-access', 'events/unsubscribe', params)).body.error.code, -32023);
});

test('end to end: agent request is delivered as a signed event, claimed, completed and read back', async t => {
  const calls = mockCallback(t);
  const h = await workerHarness();
  const sub = await legacyRpc(h, 'worker-access', 'events/subscribe', subscribeParams());
  const queued = toolResult(await lookup(h));
  assert.equal(queued.status, 'queued');
  await Promise.all(h.background);

  const event = calls.at(-1);
  assert.equal(event.parsed.name, 'request.created');
  assert.deepEqual(event.parsed.data, { request_id: queued.request_id, kind: 'lookup' });
  assert.equal(event.headers['webhook-id'], event.parsed.eventId);
  assert.equal(event.headers['X-MCP-Subscription-Id'], sub.body.result.id);
  assert.ok(verifySignature(event.headers, event.body, webhookSecret()));
  assert.ok(!event.body.includes('"q"'), 'event carries IDs only, never request text');

  const pending = toolResult(await legacyRpc(h, 'worker-access', 'tools/call', { name: 'pending_requests', arguments: {} }));
  assert.deepEqual(pending.requests.map(r => r.id), [queued.request_id]);
  const claim = toolResult(await legacyRpc(h, 'worker-access', 'tools/call', { name: 'claim_request', arguments: { request_id: queued.request_id } }));
  assert.deepEqual(claim.payload, { query: 'q' });
  const done = await legacyRpc(h, 'worker-access', 'tools/call', { name: 'complete_request', arguments: { request_id: queued.request_id, lease_token: claim.lease_token, status: 'completed', result: 'answer with sources' } });
  assert.equal(toolResult(done).status, 'completed');
  const result = toolResult(await legacyRpc(h, 'agent-access', 'tools/call', { name: 'get_result', arguments: { request_id: queued.request_id } }));
  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'answer with sources');
});

test('queueing requires a subscribed, authorized worker; an idle worker with only a refresh token still counts', async () => {
  const h = await setup();
  await insertToken(h, { client: 'agent-a', role: 'agent', secret: 'agent-access' });
  assert.match((await lookup(h)).body.result.content[0].text, /No ChatGPT worker/);
  // A used-refresh marker is not authorization.
  await insertToken(h, { client: 'worker-a', role: 'worker', secret: 'worker-used', kind: 'refresh_used', ttl: 30 * 24 * 60 * MINUTE });
  insertSubscription(h);
  assert.match((await lookup(h)).body.result.content[0].text, /No ChatGPT worker/);
  await insertToken(h, { client: 'worker-a', role: 'worker', secret: 'worker-refresh', kind: 'refresh', ttl: 30 * 24 * 60 * MINUTE });
  assert.equal(toolResult(await lookup(h)).status, 'queued');
  assert.equal(toolResult(await legacyRpc(h, 'agent-access', 'tools/call', { name: 'bridge_status', arguments: {} })).worker_connected, true);
});

test('idempotency is scoped per client and rejects changed input', async () => {
  const h = await setup();
  await connectWorker(h);
  const a = await worker.queue(h.env, { client: 'a' }, 'lookup', { query: 'x' }, 'same-key');
  const b = await worker.queue(h.env, { client: 'b' }, 'lookup', { query: 'x' }, 'same-key');
  assert.notEqual(a.request_id, b.request_id);
  await assert.rejects(worker.queue(h.env, { client: 'a' }, 'edit', { query: 'x' }, 'same-key'), /different input/);
  assert.equal((await worker.queue(h.env, { client: 'a' }, 'lookup', { query: 'x' }, 'same-key')).request_id, a.request_id);
});

test('hourly per-client request limit', async () => {
  const h = await setup();
  await connectWorker(h);
  for (let i = 0; i < 100; i++) await worker.queue(h.env, { client: 'a' }, 'lookup', { query: 'x' }, 'k' + i);
  await assert.rejects(worker.queue(h.env, { client: 'a' }, 'lookup', { query: 'x' }, 'k-over'), /Hourly request limit/);
  await worker.queue(h.env, { client: 'b' }, 'lookup', { query: 'x' }, 'k-other');
});

test('leases: one claimant, expiry allows recovery, stale leases cannot complete', async t => {
  const clock = useClock(t);
  const h = await setup();
  await connectWorker(h);
  const w = { client: 'worker-a', role: 'worker' };
  const { request_id } = await worker.queue(h.env, { client: 'a' }, 'edit', { page: 'page_abc', instructions: 'x' }, 'k');
  const first = await worker.callTool(h.env, w, 'claim_request', { request_id });
  await assert.rejects(worker.callTool(h.env, w, 'claim_request', { request_id }), /already leased/);

  clock.advance(15 * MINUTE + 1);
  const pending = await worker.callTool(h.env, w, 'pending_requests', {});
  assert.deepEqual(pending.requests.map(r => r.status), ['processing']);
  await assert.rejects(worker.callTool(h.env, w, 'complete_request', { request_id, lease_token: first.lease_token, status: 'completed', result: 'r' }), /expired lease/);
  const second = await worker.callTool(h.env, w, 'claim_request', { request_id });
  await assert.rejects(worker.callTool(h.env, w, 'complete_request', { request_id, lease_token: first.lease_token, status: 'completed', result: 'r' }), /expired lease/);
  await worker.callTool(h.env, w, 'complete_request', { request_id, lease_token: second.lease_token, status: 'failed', result: 'needs clarification' });
  await assert.rejects(worker.callTool(h.env, w, 'claim_request', { request_id }), /unavailable/);
});

test('delivery retries back off, stop after five attempts, and treat 410 as final', async t => {
  const clock = useClock(t);
  let status = 500;
  const calls = mockCallback(t, () => new Response('', { status }));
  const h = await setup();
  await connectWorker(h);
  await worker.queue(h.env, { client: 'a' }, 'lookup', { query: 'x' }, 'k');
  const delivery = () => h.db.prepare('SELECT attempts,status,due FROM deliveries').get();

  const gaps = [];
  for (let i = 0; i < 5; i++) {
    const before = delivery().due;
    clock.now = Math.max(clock.now, before);
    await worker.deliveries(h.env);
    gaps.push(delivery().due - clock.now);
  }
  assert.equal(calls.length, 5);
  assert.deepEqual(gaps.slice(0, 4), [30000, 60000, 120000, 240000]);
  assert.deepEqual({ attempts: delivery().attempts, status: delivery().status }, { attempts: 5, status: 'failed' });
  assert.ok(new Set(calls.map(c => c.headers['webhook-id'])).size === 1, 'retries reuse the event id for receiver dedupe');

  status = 410;
  await worker.queue(h.env, { client: 'a' }, 'lookup', { query: 'y' }, 'k2');
  await worker.deliveries(h.env);
  assert.equal(h.db.prepare("SELECT status FROM deliveries WHERE attempts=0").get().status, 'gone');
});

test('recovery never retries a 410/413 refusal until the subscription is reconfigured', async t => {
  const clock = useClock(t);
  const status = {};
  const calls = mockCallback(t, body => {
    const { challenge, data } = JSON.parse(body);
    return new Response(JSON.stringify({ challenge }), { status: status[data?.request_id] ?? 200 });
  });
  const h = await workerHarness();
  await modernRpc(h, 'worker-access', 'events/subscribe', subscribeParams());
  const queued = await Promise.all(['k410', 'k413', 'k503', 'ok'].map(async k => (await worker.queue(h.env, { client: 'a' }, 'lookup', { query: k }, k)).request_id));
  [status[queued[0]], status[queued[1]], status[queued[2]]] = [410, 413, 503];
  const sent = id => calls.filter(c => c.parsed.data?.request_id === id).length;
  const keepAlive = () => {
    h.db.prepare("UPDATE tokens SET expires=? WHERE role='worker'").run(clock.now + 3600000);
    h.db.prepare('UPDATE subscriptions SET expires=?').run(clock.now + 3600000);
  };
  for (let i = 0; i < 4 * 12; i++) { clock.advance(5 * MINUTE); keepAlive(); await cronTick(h.env); }
  assert.deepEqual(queued.map(sent).slice(0, 2), [1, 1], 'terminal refusals are sent once');
  assert.ok(sent(queued[2]) > 5, 'transient failures keep recovering');
  assert.ok(sent(queued[3]) > 1, 'a delivered but unclaimed request is re-announced');

  // A TTL refresh with the same secret is not a reconfiguration.
  await modernRpc(h, 'worker-access', 'events/subscribe', subscribeParams());
  clock.advance(31 * MINUTE); keepAlive(); await cronTick(h.env);
  assert.equal(sent(queued[0]), 1);
  // A new secret is: the refused deliveries get one recovery attempt.
  delete status[queued[0]];
  await modernRpc(h, 'worker-access', 'events/subscribe', subscribeParams({ delivery: { secret: webhookSecret(2) } }));
  clock.advance(MINUTE); keepAlive(); await cronTick(h.env);
  assert.deepEqual(queued.map(sent).slice(0, 2), [2, 2]);
  assert.equal(calls.at(-1).parsed.data.recovery, true);
});

test('concurrent delivery runs send each event once', async t => {
  const calls = mockCallback(t);
  const h = await setup();
  await connectWorker(h);
  await worker.queue(h.env, { client: 'a' }, 'lookup', { query: 'x' }, 'k');
  await Promise.all([worker.deliveries(h.env), worker.deliveries(h.env), worker.deliveries(h.env)]);
  assert.equal(calls.length, 1);
  assert.equal(h.db.prepare('SELECT status FROM deliveries').get().status, 'delivered');
});

test('revoked or expired worker access stops pending deliveries', async t => {
  const calls = mockCallback(t);
  const h = await setup();
  await connectWorker(h);
  await worker.queue(h.env, { client: 'a' }, 'lookup', { query: 'x' }, 'k');
  h.db.prepare("DELETE FROM tokens WHERE role='worker'").run();
  await worker.deliveries(h.env);
  assert.equal(calls.length, 0);
  assert.equal(h.db.prepare('SELECT status FROM deliveries').get().status, 'expired');
});

test('retention cleanup removes expired credentials and week-old requests only', async t => {
  const clock = useClock(t);
  const h = await setup();
  await connectWorker(h);
  await worker.queue(h.env, { client: 'a' }, 'ingest', { transcript: 'old synthetic transcript' }, 'old');
  h.db.prepare('INSERT INTO rate_limits VALUES(?,?,?)').run('k', 1, clock.now + MINUTE);
  clock.advance(7 * 24 * 60 * MINUTE + 1);
  await insertToken(h, { client: 'worker-a', role: 'worker', secret: 'fresh' });
  insertSubscription(h, { client: 'worker-a', id: 'sub-fresh' });
  await worker.queue(h.env, { client: 'a' }, 'lookup', { query: 'new' }, 'new');
  await worker.cleanup(h.env);
  assert.deepEqual(h.db.prepare('SELECT idem FROM requests').all().map(r => r.idem), ['new']);
  assert.equal(h.count('deliveries', "request NOT IN (SELECT id FROM requests)"), 0);
  assert.equal(h.count('tokens', 'expires<?', clock.now), 0);
  assert.equal(h.count('rate_limits'), 0);
  assert.deepEqual(h.db.prepare('SELECT id FROM subscriptions').all().map(r => r.id), ['sub-fresh']);
});

// Runs one cron tick the way scheduled() does.
const cronTick = async env => { await worker.recoverStalled(env); await worker.deliveries(env); };

test('recovery: a delivered but unclaimed request is re-announced with a new event id, bounded', async t => {
  const clock = useClock(t);
  const calls = mockCallback(t);
  const h = await setup();
  await connectWorker(h);
  const { request_id } = await worker.queue(h.env, { client: 'a' }, 'lookup', { query: 'x' }, 'k');
  await cronTick(h.env);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].parsed.data.recovery, undefined);

  clock.advance(10 * MINUTE);
  await cronTick(h.env);
  assert.equal(calls.length, 1, 'no recovery before the interval');

  clock.advance(25 * MINUTE);
  await cronTick(h.env);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].parsed.data, { request_id, kind: 'lookup', recovery: true });
  assert.notEqual(calls[1].headers['webhook-id'], calls[0].headers['webhook-id']);
  assert.equal(h.count('deliveries'), 1, 'recovery reuses the delivery row');

  // Bounded: keep the worker authorized and tick every 5 minutes for two days.
  for (let i = 0; i < 2 * 24 * 12; i++) {
    clock.advance(5 * MINUTE);
    h.db.prepare("UPDATE tokens SET expires=? WHERE role='worker'").run(clock.now + 3600000);
    h.db.prepare('UPDATE subscriptions SET expires=?').run(clock.now + 3600000);
    await cronTick(h.env);
  }
  assert.ok(calls.length <= 2 + 24 * 60 / 30, `sent ${calls.length}`);
  assert.equal(new Set(calls.map(c => c.headers['webhook-id'])).size, calls.length);
});

test('recovery: an expired lease is re-announced and the reclaim carries a reconciliation notice', async t => {
  const clock = useClock(t);
  const calls = mockCallback(t);
  const h = await setup();
  await connectWorker(h);
  const w = { client: 'worker-a', role: 'worker' };
  const { request_id } = await worker.queue(h.env, { client: 'a' }, 'edit', { page: 'page_abc', instructions: 'x' }, 'k');
  await cronTick(h.env);
  const first = await worker.callTool(h.env, w, 'claim_request', { request_id });
  assert.equal(first.recovery, undefined);

  clock.advance(10 * MINUTE);
  await cronTick(h.env);
  assert.equal(calls.length, 1, 'an active lease is not interrupted');
  clock.advance(25 * MINUTE);
  await cronTick(h.env);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].parsed.data.recovery, true);

  const second = await worker.callTool(h.env, w, 'claim_request', { request_id });
  assert.equal(second.recovery, true);
  assert.match(second.notice, /reconcile the current Page before any write/i);
  await worker.callTool(h.env, w, 'complete_request', { request_id, lease_token: second.lease_token, status: 'completed', result: 'done' });
  clock.advance(60 * MINUTE);
  await cronTick(h.env);
  assert.equal(calls.length, 2, 'completed requests are never re-announced');
});

test('recovery: failed deliveries and later subscriptions get a fresh chance; unauthorized workers do not', async t => {
  const clock = useClock(t);
  let status = 503;
  const calls = mockCallback(t, () => new Response('', { status }));
  const h = await setup();
  await connectWorker(h);
  await worker.queue(h.env, { client: 'a' }, 'lookup', { query: 'x' }, 'k');
  for (let i = 0; i < 5; i++) { clock.advance(5 * MINUTE); await cronTick(h.env); }
  assert.equal(h.db.prepare('SELECT status FROM deliveries').get().status, 'failed');

  // A second subscription created later (for example a new callback URL) is notified too.
  h.db.prepare('INSERT INTO subscriptions(id,callback,secret,expires,created,client) VALUES(?,?,?,?,?,?)').run('sub-new', CALLBACK + '/v2', webhookSecret(), clock.now + 3600000, clock.now, 'worker-a');
  h.db.prepare("UPDATE tokens SET expires=? WHERE role='worker'").run(clock.now + 3600000);
  h.db.prepare("UPDATE subscriptions SET expires=?").run(clock.now + 3600000);
  status = 200;
  const before = calls.length;
  clock.advance(31 * MINUTE);
  await cronTick(h.env);
  const recovered = calls.slice(before);
  assert.deepEqual(recovered.map(c => c.parsed.data.recovery).sort(), [true, true]);
  assert.deepEqual(new Set(recovered.map(c => c.url)), new Set([CALLBACK, CALLBACK + '/v2']));

  h.db.prepare("DELETE FROM tokens WHERE role='worker'").run();
  clock.advance(31 * MINUTE);
  const after = calls.length;
  await cronTick(h.env);
  assert.equal(calls.length, after);
});

test('recovery: deliveries expired while the worker was signed out resume after it reconnects', async t => {
  const clock = useClock(t);
  const calls = mockCallback(t);
  const h = await setup();
  await connectWorker(h);
  await worker.queue(h.env, { client: 'a' }, 'lookup', { query: 'x' }, 'k');
  h.db.prepare("DELETE FROM tokens WHERE role='worker'").run();
  await cronTick(h.env);
  assert.equal(h.db.prepare('SELECT status FROM deliveries').get().status, 'expired');
  await insertToken(h, { client: 'worker-a', role: 'worker', secret: 'reconnected' });
  // The interval counts from the delivery claim, which is up to two minutes after the tick.
  clock.advance(33 * MINUTE);
  await cronTick(h.env);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].parsed.data.recovery, true);
});

test('recovery: a dead callback costs one attempt per interval', async t => {
  const clock = useClock(t);
  const calls = mockCallback(t, () => new Response('', { status: 503 }));
  const h = await setup();
  await connectWorker(h);
  await worker.queue(h.env, { client: 'a' }, 'lookup', { query: 'x' }, 'k');
  for (let i = 0; i < 5; i++) { clock.advance(5 * MINUTE); await cronTick(h.env); }
  assert.equal(calls.length, 5);
  for (let i = 0; i < 24; i++) {
    clock.advance(5 * MINUTE);
    h.db.prepare("UPDATE tokens SET expires=? WHERE role='worker'").run(clock.now + 3600000);
    h.db.prepare('UPDATE subscriptions SET expires=?').run(clock.now + 3600000);
    await cronTick(h.env);
  }
  // Two hours of 5-minute ticks: one extra attempt per 30+ minute interval.
  assert.ok(calls.length >= 7 && calls.length <= 9, `sent ${calls.length}`);
});
