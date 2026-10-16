import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createLineClient, mcpDispatch, serveMcp } from '../direct/rpc.mjs';

function fakeSpawn() {
  const child = new EventEmitter();
  const requests = [];
  const starts = [];
  const kills = [];
  child.stdout = new PassThrough();
  child.stdin = new Writable({ write(chunk, encoding, done) { requests.push(JSON.parse(chunk.toString())); done(); } });
  child.kill = signal => { kills.push(signal); queueMicrotask(() => child.emit('exit', 0, signal)); return true; };
  const spawn = (...args) => { starts.push(args); return child; };
  const send = value => child.stdout.write(JSON.stringify(value) + '\n');
  return { child, requests, starts, kills, spawn, send };
}
function fixture(t, options = {}) {
  const f = fakeSpawn();
  const logs = [];
  const client = createLineClient({ command: 'synthetic-command', args: ['synthetic-arg'], spawn: f.spawn, log: message => logs.push(message), ...options });
  t.after(() => client.kill());
  return { ...f, client, logs };
}

test('RPC does not start implicitly and marks unsent requests safe to distinguish', async t => {
  const f = fixture(t);
  await assert.rejects(f.client.request('write', {}, 50), error => error.code === 'not_running' && error.sent === false);
  assert.equal(f.starts.length, 0);
  f.client.start();
  f.client.start();
  assert.equal(f.starts.length, 1);
  assert.deepEqual(f.starts[0][2].stdio, ['pipe', 'pipe', 'ignore']);
  assert.equal(f.starts[0][2].shell, undefined);
});

test('RPC routes fragmented unicode replies by exact ID and ignores notifications', async t => {
  const f = fixture(t);
  f.client.start();
  const first = f.client.request('one', { text: 'synthetic' }, 500);
  const second = f.client.request('two', {}, 500);
  f.child.stdout.write('not json\n');
  f.send({ method: 'notification', params: { private_text: 'synthetic-private' } });
  f.send({ id: 999, result: 'unrelated' });
  f.send({ id: f.requests[1].id, result: 'second' });
  const bytes = Buffer.from(JSON.stringify({ id: f.requests[0].id, result: '☃' }) + '\n');
  for (const byte of bytes) f.child.stdout.write(Buffer.from([byte]));
  assert.equal(await first, '☃');
  assert.equal(await second, 'second');
  assert.equal(f.requests.length, 2);
});

test('RPC approval or elicitation fails all in-flight calls closed and kills peer', async t => {
  const f = fixture(t);
  f.client.start();
  const pending = f.client.request('mcpServer/tool/call', { tool: 'chatgpt_space.patch_page' }, 500);
  const rejected = assert.rejects(pending, error => error.code === 'owner_interaction_required' && error.sent === true);
  f.send({ id: 'approval-synthetic', method: 'item/commandExecution/requestApproval', params: { secret: 'synthetic-private' } });
  await rejected;
  assert.equal(f.client.alive, false);
  assert.deepEqual(f.kills, ['SIGTERM']);
  assert.equal(f.requests[1].id, 'approval-synthetic');
  assert.equal(f.requests[1].error.code, -32000);
  assert.equal(Object.hasOwn(f.requests[1], 'result'), false);
  assert.ok(!JSON.stringify(f.logs).includes('synthetic-private'));
});

test('RPC timeout and peer crash never retry a sent write', async t => {
  const f = fixture(t);
  f.client.start();
  await assert.rejects(f.client.request('mcpServer/tool/call', { tool: 'chatgpt_space.create_page' }, 10), error => error.code === 'timeout' && error.sent === true);
  assert.equal(f.requests.length, 1);
  const crashed = f.client.request('mcpServer/tool/call', { tool: 'chatgpt_space.patch_page' }, 500);
  const rejected = assert.rejects(crashed, error => error.code === 'exited' && error.sent === true);
  f.child.emit('exit', 1);
  await rejected;
  assert.equal(f.requests.length, 2);
  assert.equal(f.starts.length, 1);
  assert.equal(f.client.alive, false);
});

test('RPC spawn failure distinguishes requests that did not reach peer', async t => {
  const f = fixture(t);
  f.client.start();
  const pending = f.client.request('initialize', {}, 500);
  const rejected = assert.rejects(pending, error => error.code === 'spawn_failed' && error.sent === false);
  f.child.emit('error', new Error('synthetic-private'));
  await rejected;
  assert.equal(f.client.alive, false);
});

test('RPC preserves upstream error code and bounds upstream messages', async t => {
  const f = fixture(t);
  f.client.start();
  const pending = f.client.request('read', {}, 500);
  const rejected = assert.rejects(pending, error => error.code === 'upstream_error' && error.rpcCode === 123 && error.message.length === 300);
  f.send({ id: f.requests[0].id, error: { code: 123, message: 'x'.repeat(1000) } });
  await rejected;
});

test('RPC rejects an oversized unterminated frame', async t => {
  const f = fixture(t, { maxLineChars: 64 });
  f.client.start();
  const pending = f.client.request('read', {}, 500);
  const rejected = assert.rejects(pending, error => error.code === 'protocol');
  f.child.stdout.write('x'.repeat(65));
  await rejected;
  assert.equal(f.client.alive, false);
});

test('RPC rejects an oversized complete frame rather than bypassing line bound', async t => {
  const f = fixture(t, { maxLineChars: 64 });
  f.client.start();
  const pending = f.client.request('read', {}, 500);
  const rejected = assert.rejects(pending, error => error.code === 'protocol');
  f.send({ id: f.requests[0].id, result: 'x'.repeat(100) });
  await rejected;
});

test('MCP dispatch exposes only defined methods and never starts arbitrary upstream calls', async () => {
  const calls = [];
  const options = { serverInfo: { name: 'synthetic', version: '1' }, listTools: () => [{ name: 'read_page' }], callTool: async (...args) => { calls.push(args); return { ok: true }; } };
  const invoke = message => mcpDispatch({ jsonrpc: '2.0', id: 1, ...message }, options);
  assert.equal((await invoke({ method: 'turn/start', params: { input: 'synthetic' } })).error.code, -32601);
  assert.equal((await invoke({ method: 'mcpServer/tool/call', params: { tool: 'arbitrary' } })).error.code, -32601);
  assert.equal((await invoke({ method: 'tools/call', params: {} })).error.code, -32602);
  assert.deepEqual(calls, []);
  assert.equal((await invoke({ method: 'initialize', params: { protocolVersion: '2025-03-26' } })).result.protocolVersion, '2025-03-26');
  assert.equal((await invoke({ method: 'tools/list' })).result.tools[0].name, 'read_page');
  await invoke({ method: 'tools/call', params: { name: 'read_page', arguments: { page_id: 'synthetic' } } });
  assert.deepEqual(calls, [['read_page', { page_id: 'synthetic' }]]);
  assert.equal(await mcpDispatch({ jsonrpc: '2.0', method: 'notifications/initialized' }, options), undefined);
});

test('MCP stdio loop returns parse errors and waits for in-flight handlers', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', chunk => { text += chunk; });
  const serving = serveMcp({ input, output, dispatch: async message => ({ jsonrpc: '2.0', id: message.id, result: { ok: true } }) });
  input.end('{\n' + JSON.stringify({ id: 7, method: 'ping' }) + '\n');
  await serving;
  const replies = text.trim().split('\n').map(JSON.parse);
  assert.equal(replies[0].error.code, -32700);
  assert.equal(replies[1].id, 7);
  assert.deepEqual(replies[1].result, { ok: true });
});
