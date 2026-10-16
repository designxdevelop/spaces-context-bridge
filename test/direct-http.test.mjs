import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createLoopbackServer } from '../direct/http.mjs';

const TOKEN = 'synthetic-test-token-'.repeat(3);
const MESSAGE = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_page', arguments: { page_id: 'page_synthetic' } } };

async function fixture(t, options = {}) {
  const calls = [];
  const instance = createLoopbackServer({ token: TOKEN, handleMessage: async message => { calls.push(message); return { jsonrpc: '2.0', id: message.id, result: { ok: true } }; }, ...options });
  const port = await instance.listen();
  t.after(() => instance.close());
  return { ...instance, calls, port };
}
function request(port, { method = 'POST', path = '/mcp', body = MESSAGE, headers = {}, authenticated = true } = {}) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json', ...(!Object.hasOwn(headers, 'Transfer-Encoding') ? { 'Content-Length': Buffer.byteLength(payload) } : {}), ...(authenticated ? { Authorization: `Bearer ${TOKEN}` } : {}), ...headers } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('HTTP binds only loopback and authentication precedes handler invocation', async t => {
  const f = await fixture(t);
  assert.equal(f.server.address().address, '127.0.0.1');
  for (const options of [{ authenticated: false }, { headers: { Authorization: 'Bearer wrong' } }, { headers: { Authorization: `Basic ${TOKEN}` } }]) {
    const result = await request(f.port, options);
    assert.equal(result.status, 401);
    assert.equal(result.headers.connection, 'close');
    assert.equal(result.body.error, 'unauthorized');
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.ok(!result.text.includes(TOKEN));
  }
  assert.deepEqual(f.calls, []);
});

test('HTTP rejects foreign Host and Origin even with valid credentials', async t => {
  const f = await fixture(t);
  for (const headers of [{ Host: 'evil.example' }, { Origin: 'https://evil.example' }, { Origin: 'null' }]) {
    const result = await request(f.port, { headers });
    assert.equal(result.status, 403);
    assert.equal(result.headers.connection, 'close');
  }
  assert.equal(f.calls.length, 0);
  const response = await request(f.port, { headers: { Origin: `http://127.0.0.1:${f.port}` } });
  assert.equal(response.status, 200);
  assert.deepEqual(f.calls, [MESSAGE]);
});

test('HTTP accepts one JSON RPC message and returns notifications as 202', async t => {
  const f = await fixture(t);
  assert.deepEqual((await request(f.port)).body, { jsonrpc: '2.0', id: 1, result: { ok: true } });
  const notification = { jsonrpc: '2.0', method: 'notifications/initialized' };
  const result = await request(f.port, { body: notification });
  assert.equal(result.status, 202);
  assert.equal(result.text, '');
  assert.deepEqual(f.calls, [MESSAGE, notification]);
});

test('HTTP rejects batches, malformed messages, wrong method and content type', async t => {
  const f = await fixture(t);
  for (const body of [[MESSAGE], { method: 'tools/list' }, null, { ...MESSAGE, id: {} }]) {
    assert.equal((await request(f.port, { body })).status, 400);
  }
  const malformed = await request(f.port, { body: '{' });
  assert.equal(malformed.body.error.code, -32700);
  assert.equal((await request(f.port, { method: 'GET' })).status, 405);
  assert.equal((await request(f.port, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await request(f.port, { path: '/other' })).status, 404);
  assert.equal(f.calls.length, 0);
});

test('HTTP body bounds reject declared and streamed payloads before handler', async t => {
  const f = await fixture(t, { maxBodyBytes: 64 });
  const payload = JSON.stringify({ ...MESSAGE, private_text: 'synthetic-private-value' });
  for (const headers of [{ 'Content-Length': Buffer.byteLength(payload) }, { 'Transfer-Encoding': 'chunked' }]) {
    const result = await request(f.port, { body: payload, headers });
    assert.equal(result.status, 413);
    assert.equal(result.headers.connection, 'close');
    assert.ok(!result.text.includes('synthetic-private-value'));
  }
  assert.equal(f.calls.length, 0);
});

test('HTTP hides handler exception details and enforces active concurrency bound', async t => {
  let release;
  let entered;
  const began = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const f = await fixture(t, { maxConcurrent: 1, handleMessage: async () => { calls++; entered(); await pending; throw new Error('synthetic-private-error'); } });
  const first = request(f.port);
  await began;
  assert.equal((await request(f.port)).status, 503);
  release();
  const failed = await first;
  assert.equal(failed.status, 500);
  assert.ok(!failed.text.includes('synthetic-private-error'));
  assert.equal(calls, 1);
});

test('HTTP credential setup rejects short or whitespace credentials', () => {
  for (const token of ['', 'short', 'a'.repeat(40) + ' ']) {
    assert.throws(() => createLoopbackServer({ token, handleMessage() {} }), /invalid_local_credential/);
  }
});


test('HTTP rejects a missing response for an identified RPC request with 500', async t => {
  for (const missing of [undefined, null]) {
    const f = await fixture(t, { handleMessage: async () => missing });
    const failed = await request(f.port);
    assert.equal(failed.status, 500);
    assert.equal(failed.body.id, MESSAGE.id);
    assert.equal(failed.body.error.code, -32603);
    const notification = await request(f.port, { body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
    assert.equal(notification.status, 202);
  }
});
