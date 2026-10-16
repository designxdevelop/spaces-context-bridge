// MCP transport and protocol behavior. Result shapes are checked against the official
// 2026-07-28 schema.json (required keys and enums only; not a full JSON Schema validator).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setup, insertToken, connectWorker, legacyRpc, modernRpc, toolResult } from '../support/harness.mjs';

const defs = JSON.parse(readFileSync(new URL('../mcp-2026-07-28.schema.json', import.meta.url), 'utf8')).$defs;

function conforms(value, defName) {
  const def = defs[defName];
  for (const key of def.required || []) assert.ok(Object.hasOwn(value, key), `${defName} requires ${key}`);
  for (const [key, prop] of Object.entries(def.properties || {})) {
    if (value[key] !== undefined && prop.enum) assert.ok(prop.enum.includes(value[key]), `${defName}.${key}=${value[key]}`);
  }
}

async function agent() {
  const h = await setup();
  await insertToken(h);
  return h;
}

test('2026-07-28 results conform to the official schema', async () => {
  const h = await agent();
  const discover = await modernRpc(h, 'test-access', 'server/discover');
  conforms(discover.body, 'JSONRPCResultResponse');
  conforms(discover.body.result, 'DiscoverResult');
  assert.deepEqual(discover.body.result.supportedVersions, ['2026-07-28']);
  assert.equal(discover.body.result._meta['io.modelcontextprotocol/serverInfo'].name, 'Spaces Context Bridge');
  assert.equal(discover.body.result.capabilities.events, undefined, 'agents are not offered events');

  const list = await modernRpc(h, 'test-access', 'tools/list');
  conforms(list.body.result, 'ListToolsResult');
  for (const tool of list.body.result.tools) conforms(tool, 'Tool');
  assert.deepEqual(list.body.result.tools.map(t => t.name), ['bridge_status', 'lookup_context', 'request_document_edit', 'save_transcript', 'get_result']);

  const call = await modernRpc(h, 'test-access', 'tools/call', { name: 'bridge_status', arguments: {} });
  conforms(call.body.result, 'CallToolResult');
  assert.equal(toolResult(call).role, 'agent');
  for (const block of call.body.result.content) conforms(block, 'TextContent');
});

test('worker discovery advertises the draft events capability', async () => {
  const h = await setup();
  await insertToken(h, { client: 'w', role: 'worker', secret: 'worker-access' });
  const discover = await modernRpc(h, 'worker-access', 'server/discover');
  assert.deepEqual(discover.body.result.capabilities.events, {});
});

test('2026-07-28 header rules: version, method and name must match the body', async () => {
  const h = await agent();
  const cases = [
    [{ headers: { 'mcp-protocol-version': '2025-11-25' } }, 'server/discover', {}, -32020],
    [{ headers: { 'mcp-method': 'tools/list' } }, 'server/discover', {}, -32020],
    [{ headers: { 'mcp-name': 'get_result' } }, 'tools/call', { name: 'bridge_status', arguments: {} }, -32020],
    [{ headers: { 'mcp-protocol-version': '2099-01-01' }, meta: { 'io.modelcontextprotocol/protocolVersion': '2099-01-01' } }, 'server/discover', {}, -32022],
  ];
  for (const [options, method, params, code] of cases) {
    const r = await modernRpc(h, 'test-access', method, params, options);
    assert.equal(r.status, 400, JSON.stringify(options));
    conforms(r.body, 'JSONRPCErrorResponse');
    assert.equal(r.body.error.code, code);
  }
  const unsupported = await modernRpc(h, 'test-access', 'server/discover', {}, { headers: { 'mcp-protocol-version': '2099-01-01' }, meta: { 'io.modelcontextprotocol/protocolVersion': '2099-01-01' } });
  conforms(unsupported.body, 'UnsupportedProtocolVersionError');
  assert.deepEqual(unsupported.body.error.data, { requested: '2099-01-01', supported: ['2026-07-28'] });
});

test('2026-07-28 requires Mcp-Method and Mcp-Name; base64 sentinel names are decoded', async () => {
  const h = await agent();
  const missing = async (header, method, params) => {
    const headers = { 'mcp-protocol-version': '2026-07-28', 'mcp-method': method, ...(params.name ? { 'mcp-name': params.name } : {}) };
    delete headers[header];
    const body = { jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } };
    const r = await h.fetch('/mcp', { method: 'POST', headers: { authorization: 'Bearer test-access', ...headers }, body: JSON.stringify(body) });
    return { status: r.status, code: (await r.json()).error?.code };
  };
  assert.deepEqual(await missing('mcp-method', 'tools/list', {}), { status: 400, code: -32020 });
  assert.deepEqual(await missing('mcp-name', 'tools/call', { name: 'bridge_status', arguments: {} }), { status: 400, code: -32020 });
  assert.deepEqual(await missing('mcp-protocol-version', 'tools/list', {}), { status: 400, code: -32020 });

  const encoded = '=?base64?' + Buffer.from('bridge_status').toString('base64') + '?=';
  const ok = await modernRpc(h, 'test-access', 'tools/call', { name: 'bridge_status', arguments: {} }, { headers: { 'mcp-name': encoded } });
  assert.equal(ok.status, 200);
});

test('unknown methods: 404 for 2026-07-28, JSON-RPC error for initialization-era clients', async () => {
  const h = await agent();
  const modern = await modernRpc(h, 'test-access', 'resources/list');
  assert.equal(modern.status, 404);
  assert.equal(modern.body.error.code, -32601);
  const legacy = await legacyRpc(h, 'test-access', 'resources/list');
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.error.code, -32601);
});

test('initialization-era negotiation keeps supported versions and falls back to the newest', async () => {
  const h = await agent();
  for (const version of ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']) {
    const r = await legacyRpc(h, 'test-access', 'initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'c', version: '1' } });
    assert.equal(r.body.result.protocolVersion, version);
    assert.equal(r.body.result.serverInfo.name, 'Spaces Context Bridge');
  }
  const future = await legacyRpc(h, 'test-access', 'initialize', { protocolVersion: '2030-01-01', capabilities: {} });
  assert.equal(future.body.result.protocolVersion, '2025-11-25');
  assert.equal((await legacyRpc(h, 'test-access', 'notifications/initialized', undefined, { notification: true })).status, 202);
  const after = await legacyRpc(h, 'test-access', 'tools/list', {}, { headers: { 'mcp-protocol-version': '2025-06-18' } });
  assert.equal(after.status, 200);
  const bogus = await legacyRpc(h, 'test-access', 'tools/list', {}, { headers: { 'mcp-protocol-version': '1999-01-01' } });
  assert.equal(bogus.status, 400);
  assert.equal(bogus.body.error.code, -32022);
  const modernWithoutMeta = await legacyRpc(h, 'test-access', 'tools/list', {}, { headers: { 'mcp-protocol-version': '2026-07-28' } });
  assert.equal(modernWithoutMeta.body.error.code, -32020);
});

test('transport: GET/DELETE are 405, notifications 202, malformed bodies get JSON-RPC errors', async () => {
  const h = await agent();
  for (const method of ['GET', 'DELETE']) {
    const r = await h.fetch('/mcp', { method, headers: { authorization: 'Bearer test-access' } });
    assert.equal(r.status, 405);
    assert.equal(r.headers.get('allow'), 'POST');
  }
  const post = body => h.fetch('/mcp', { method: 'POST', headers: { authorization: 'Bearer test-access' }, body });
  const parse = await post('{');
  assert.equal(parse.status, 400);
  assert.deepEqual((await parse.json()).error.code, -32700);
  for (const body of ['[{"jsonrpc":"2.0","id":1,"method":"ping"}]', '{"jsonrpc":"1.0","id":1,"method":"ping"}', '{"jsonrpc":"2.0","id":{},"method":"ping"}', '{"jsonrpc":"2.0","id":1,"method":"ping","params":[]}']) {
    const r = await post(body);
    assert.equal(r.status, 400, body);
    assert.equal((await r.json()).error.code, -32600, body);
  }
  const big = await h.fetch('/mcp', { method: 'POST', headers: { authorization: 'Bearer test-access' }, body: 'x'.repeat(300 * 1024) });
  assert.equal(big.status, 413);
});

test('unauthenticated requests get a discoverable 401 before any body parsing', async () => {
  const h = await agent();
  const r = await h.fetch('/mcp', { method: 'POST', body: '{' });
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('www-authenticate'), 'Bearer resource_metadata="https://bridge.example.com/.well-known/oauth-protected-resource/mcp"');
  const wrong = await legacyRpc(h, 'not-a-token', 'tools/list');
  assert.equal(wrong.status, 401);
  assert.match(wrong.response.headers.get('www-authenticate'), /invalid_token/);
});

test('client-specific _meta such as session IDs is accepted but never used or stored', async () => {
  const h = await agent();
  await insertToken(h, { client: 'worker-a', role: 'worker', secret: 'w' });
  h.db.prepare('INSERT INTO subscriptions(id,callback,secret,expires,created,client) VALUES(?,?,?,?,?,?)').run('s', 'https://chatgpt.com/x', 'whsec_x', Date.now() + 60000, Date.now(), 'worker-a');
  const marker = 'session-marker-7f3a';
  const r = await modernRpc(h, 'test-access', 'tools/call', { name: 'lookup_context', arguments: { query: 'q', idempotency_key: 'k' } }, { meta: { 'ai.opencode/sessionID': marker } });
  assert.equal(r.status, 200);
  assert.equal(toolResult(r).status, 'queued');
  // A session ID is not a credential: without a bearer token the same request is rejected.
  const anonymous = await h.fetch('/mcp', { method: 'POST', headers: { 'mcp-session-id': marker }, body: '{}' });
  assert.equal(anonymous.status, 401);
  const dump = JSON.stringify(['requests', 'deliveries', 'tokens', 'clients'].map(t => h.db.prepare(`SELECT * FROM ${t}`).all()));
  assert.ok(!dump.includes(marker));
});

test('tool argument problems are tool errors the model can see; unknown tools are protocol errors', async () => {
  const h = await agent();
  const call = (name, args) => legacyRpc(h, 'test-access', 'tools/call', { name, arguments: args });
  for (const args of [{}, { query: 'q', idempotency_key: 'k', extra: 'x' }, { query: 7, idempotency_key: 'k' }, { query: '', idempotency_key: 'k' }, { query: 'x'.repeat(12001), idempotency_key: 'k' }]) {
    const r = await call('lookup_context', args);
    assert.equal(r.body.result.isError, true, JSON.stringify(args).slice(0, 80));
  }
  const edit = await call('request_document_edit', { page: 'https://evil.example/page_1', instructions: 'x', idempotency_key: 'k' });
  assert.equal(edit.body.result.isError, true);
  const ingest = await call('save_transcript', { title: 't', transcript: 'x', space_id: 'page_space_abc', recorded_at: '2026-10-15T10:00:00', source_id: 's', idempotency_key: 'k' });
  assert.match(ingest.body.result.content[0].text, /timezone/);
  const unknown = await call('drop_tables', {});
  assert.equal(unknown.body.error.code, -32602);
  assert.equal(unknown.body.error.message, 'Unknown tool');
});

test('free text is capped so a worst-case JSON body still fits the 256 KiB request limit', async () => {
  const h = await agent();
  await insertToken(h, { client: 'w', role: 'worker', secret: 'worker-access' });
  const tools = [...(await legacyRpc(h, 'test-access', 'tools/list')).body.result.tools, ...(await legacyRpc(h, 'worker-access', 'tools/list')).body.result.tools];
  for (const tool of tools) {
    // \u0001 is the costliest JSON escape (6 bytes per UTF-16 unit); unbounded strings default to 1000.
    const args = Object.fromEntries(Object.entries(tool.inputSchema.properties).map(([k, p]) => [k, '\u0001'.repeat(p.maxLength ?? 1000)]));
    const body = JSON.stringify({ jsonrpc: '2.0', id: 'x'.repeat(64), method: 'tools/call', params: { name: tool.name, arguments: args, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } });
    assert.ok(Buffer.byteLength(body) <= 256 * 1024 - 1024, `${tool.name}: ${Buffer.byteLength(body)} bytes`);
  }
  // Actual boundary over HTTP: the longest all-escaped transcript is queued, one more unit is rejected.
  await connectWorker(h);
  const save = transcript => legacyRpc(h, 'test-access', 'tools/call', { name: 'save_transcript',
    arguments: { title: 't', transcript, space_id: 'page_space_abc', recorded_at: '2026-10-15T10:00:00Z', source_id: 's', idempotency_key: 'k' } });
  const longest = await save('\u0001'.repeat(40000));
  assert.equal(longest.body.result.isError, undefined, longest.body.result.content[0].text);
  assert.match(toolResult(longest).request_id, /./);
  assert.match((await save('x'.repeat(40001))).body.result.content[0].text, /Invalid transcript/);
});

test('tool annotations describe each tool; document edits are destructive', async () => {
  const h = await agent();
  await insertToken(h, { client: 'w', role: 'worker', secret: 'worker-access' });
  const tools = [...(await legacyRpc(h, 'test-access', 'tools/list')).body.result.tools, ...(await legacyRpc(h, 'worker-access', 'tools/list')).body.result.tools];
  const hints = Object.fromEntries(tools.map(t => [t.name, t.annotations]));
  for (const t of tools) conforms(t.annotations, 'ToolAnnotations');
  assert.equal(hints.request_document_edit.destructiveHint, true);
  assert.equal(hints.request_document_edit.openWorldHint, true);
  assert.equal(hints.lookup_context.readOnlyHint, false);
  assert.equal(hints.save_transcript.destructiveHint, false);
  for (const name of ['bridge_status', 'get_result', 'pending_requests']) assert.equal(hints[name].readOnlyHint, true, name);
});
