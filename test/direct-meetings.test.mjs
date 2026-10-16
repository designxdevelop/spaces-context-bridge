import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createBridge, createCodexUpstream, UPSTREAM_ALLOWLIST, UPSTREAM_TOOL_NAMES, VERSION } from '../direct/adapter.mjs';
import { RpcError } from '../direct/rpc.mjs';

const NOTE = 'note_synthetic_1';
const NOTE_RESULT = {
  id: NOTE, source_meeting_id: 'meeting_synthetic_1', title: 'Synthetic sync',
  source_urls: ['https://example.invalid/permalink/1', 'https://example.invalid/permalink/1?alt=1'],
  summary_page_status: 'unavailable', transcript_status: 'unavailable', notes: 'Pageless synthetic notes', transcript: null,
};
function fixture(t, { handler } = {}) {
  const calls = [];
  const logs = [];
  const upstream = {
    async callTool(tool, args, opts) {
      calls.push({ tool, args: structuredClone(args), opts: structuredClone(opts) });
      if (handler) { const r = await handler(tool, args, calls.length); if (r !== undefined) return r; }
      return { structuredContent: tool === 'meetings.fetch' ? structuredClone(NOTE_RESULT) : { items: [structuredClone(NOTE_RESULT)], next_cursor: 'cursor_next' } };
    },
    async inventory() { return { ok: true }; },
  };
  const bridge = createBridge({ upstream, env: {}, log: m => logs.push(m) });
  const call = async (name, args) => (await bridge.callTool(name, args)).structuredContent;
  return { calls, logs, bridge, call };
}
const bad = (r) => { assert.equal(r.ok, false); assert.equal(r.error.code, 'invalid_arguments'); };

test('meetings tools are advertised read-only with strict schemas and 0.1.1', t => {
  const f = fixture(t);
  assert.equal(VERSION, '0.1.1');
  const tools = Object.fromEntries(f.bridge.listTools().map(x => [x.name, x]));
  for (const name of ['meetings_find_all', 'meetings_fetch']) {
    assert.equal(tools[name].annotations.readOnlyHint, true);
    assert.equal(tools[name].annotations.destructiveHint, false);
    assert.equal(tools[name].inputSchema.additionalProperties, false);
    assert.match(tools[name].description, /For explicitly requested ChatGPT Meetings notes/);
    assert.match(tools[name].description, /codex:\/\/mcp-app\/chatgpt-meetings@openai-curated-remote\/meetings\.open\/meeting\/<note-id>/);
    assert.match(tools[name].description, /no model turn, no event queue/);
  }
  assert.match(tools.meetings_find_all.description, /then call meetings_fetch/);
  assert.equal(tools.meetings_find_all.inputSchema.properties.limit.maximum, 500);
  assert.deepEqual(UPSTREAM_ALLOWLIST, ['read_page', 'find_pages', 'list_spaces', 'list_pages', 'patch_page', 'create_page']);
});

test('fixed mapping: Pages keep prefix, Meetings use exact native names, no caller routing', () => {
  assert.equal(UPSTREAM_TOOL_NAMES.read_page, 'chatgpt_space.read_page');
  assert.equal(UPSTREAM_TOOL_NAMES['meetings.find_all'], 'meetings.find_all');
  assert.equal(UPSTREAM_TOOL_NAMES['meetings.fetch'], 'meetings.fetch');
  assert.equal(Object.keys(UPSTREAM_TOOL_NAMES).length, 8);
});

test('transport sends exact meetings.* on codex_apps and chatgpt_space.* for Pages; inventory maps both', async t => {
  const sent = [];
  const spawn = () => {
    const stdin = new Writable({ write(chunk, _e, cb) {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        const m = JSON.parse(line); sent.push(m);
        if (m.id === undefined) continue;
        const reply = (result) => child.stdout.write(JSON.stringify({ id: m.id, result }) + '\n');
        if (m.method === 'initialize') reply({});
        else if (m.method === 'thread/start') reply({ thread: { id: 'synthetic-thread', ephemeral: true } });
        else if (m.method === 'mcpServerStatus/list') reply({ data: [{ name: 'codex_apps', authStatus: 'ok', tools: { 'meetings.fetch': {}, 'meetings.find_all': {}, 'chatgpt_space.read_page': {} } }] });
        else reply({ structuredContent: { ok: true } });
      }
      cb();
    } });
    const child = Object.assign(new EventEmitter(), { stdin, stdout: new PassThrough(), stderr: new PassThrough(), kill() { child.emit('exit', 0, null); return true; }, pid: 1 });
    return child;
  };
  const upstream = createCodexUpstream({ spawn, env: { PATH: process.env.PATH }, startTimeoutMs: 200 });
  t.after(() => upstream.close());
  await assert.rejects(upstream.callTool('meetings.delete', {}), e => e.code === 'protocol' && e.sent === false);
  await assert.rejects(upstream.callTool('constructor', {}), e => e.code === 'protocol' && e.sent === false);
  await upstream.callTool('meetings.find_all', { limit: 5 }, { timeoutMs: 200 });
  await upstream.callTool('meetings.fetch', { note_id: NOTE }, { timeoutMs: 200 });
  await upstream.callTool('read_page', { page_id: 'p' }, { timeoutMs: 200 });
  const calls = sent.filter(m => m.method === 'mcpServer/tool/call').map(m => [m.params.server, m.params.tool]);
  assert.deepEqual(calls, [['codex_apps', 'meetings.find_all'], ['codex_apps', 'meetings.fetch'], ['codex_apps', 'chatgpt_space.read_page']]);
  assert.equal(sent.some(m => m.method === 'turn/start'), false);
  const inv = await upstream.inventory();
  assert.equal(inv.tools['meetings.find_all'], true);
  assert.equal(inv.tools['meetings.fetch'], true);
  assert.equal(inv.tools.read_page, true);
  assert.equal(inv.tools.patch_page, false);
});

test('find_all passes cursor, limit, attendees and dates through unchanged without widening or defaults', async t => {
  const f = fixture(t);
  const args = { attendee_names: ['Ada Synthetic'], attendee_emails: ['ada@example.invalid'], start_time: '2026-10-01T00:00:00-07:00', end_time: '2026-10-16T23:59:59.5Z', limit: 500, cursor: 'cursor_prev' };
  const r = await f.call('meetings_find_all', args);
  assert.deepEqual(f.calls[0].args, args);
  assert.equal(f.calls[0].tool, 'meetings.find_all');
  assert.equal(f.calls[0].opts.kind, 'read');
  assert.deepEqual(r, { items: [NOTE_RESULT], next_cursor: 'cursor_next' });
  await f.call('meetings_find_all', {});
  assert.deepEqual(f.calls[1].args, {});
  await f.call('meetings_find_all', { start_time: '2026-10-01T00:00:00Z' });
  assert.deepEqual(f.calls[2].args, { start_time: '2026-10-01T00:00:00Z' });
  await f.call('meetings_find_all', { start_time: '2026-10-01T00:00:00Z', end_time: '2026-10-01T00:00:00Z' });
  assert.equal(f.calls.length, 4);
});

test('find_all invalid input fails before any upstream call', async t => {
  const f = fixture(t);
  const long = 'x'.repeat(321);
  const cases = [
    { limit: 0 }, { limit: 501 }, { limit: '10' }, { limit: 1.5 }, { limit: null },
    { start_time: '2026-10-01' }, { start_time: '2026-10-01T00:00:00' }, { start_time: 'not a date at all!!!' },
    { start_time: '2026-02-30T00:00:00Z' }, { end_time: '2026-10-16T24:00:00Z' }, { end_time: null },
    { start_time: '2026-10-16T00:00:00Z', end_time: '2026-10-15T23:59:59Z' },
    { start_time: '2026-10-16T01:00:00+02:00', end_time: '2026-10-15T22:00:00Z' },
    { attendee_names: [] }, { attendee_names: 'Ada' }, { attendee_emails: [1] }, { attendee_emails: [long] },
    { attendee_names: Array.from({ length: 51 }, (_, i) => `n${i}`) }, { attendee_names: ['bad\u0000'] },
    { cursor: '' }, { cursor: 'a\nb' }, { cursor: 5 },
    { query: 'topic' }, { title: 'x' }, { server: 'codex_apps' }, { tool: 'meetings.delete' }, { namespace: 'x' },
    JSON.parse('{"__proto__":"x"}'), JSON.parse('{"constructor":"x"}'),
  ];
  for (const args of cases) bad(await f.call('meetings_find_all', args));
  assert.deepEqual(f.calls, []);
});

test('fetch requires exactly one selector and rejects bad input before upstream', async t => {
  const f = fixture(t);
  for (const args of [{}, { note_id: NOTE, meeting_id: 'meeting_synthetic_1' }, { note_id: null }, { note_id: '' }, { note_id: 'has space' }, { note_id: 'a\nb' },
    { note_id: 5 }, { note_id: 'x'.repeat(257) }, { meeting_id: ['m'] }, { note_id: NOTE, extra: 1 }, { page_id: 'p' }, JSON.parse('{"__proto__":"x"}')]) {
    bad(await f.call('meetings_fetch', args));
  }
  assert.deepEqual(f.calls, []);
  await f.call('meetings_fetch', { note_id: NOTE });
  await f.call('meetings_fetch', { meeting_id: 'meeting_synthetic_1' });
  assert.deepEqual(f.calls.map(c => [c.tool, c.args]), [['meetings.fetch', { note_id: NOTE }], ['meetings.fetch', { meeting_id: 'meeting_synthetic_1' }]]);
});

test('fetch returns native ids, source URLs, status, notes and transcript unchanged, including pageless/unavailable', async t => {
  const full = { id: NOTE, source_meeting_id: 'm1', source_urls: ['https://example.invalid/a'], summary_page_status: 'available', page_id: null, transcript_status: 'available',
    notes: '# Notes\nline', transcript: [{ speaker: 'Ada', text: 'synthetic hi', start: 0.5 }], extra_native_field: { nested: [1, 2] } };
  const f = fixture(t, { handler: (tool, args) => (args.note_id === 'full' ? { structuredContent: structuredClone(full) } : undefined) });
  assert.deepEqual(await f.call('meetings_fetch', { note_id: 'full' }), full);
  assert.deepEqual(await f.call('meetings_fetch', { note_id: NOTE }), NOTE_RESULT);
});

test('meetings results are not filtered by Pages Space scope', async t => {
  const f = fixture(t, { handler: () => ({ structuredContent: { items: [{ id: 'n1', drive_scope: 'personal', deleted_at: '2026-01-01T00:00:00Z' }] } }) });
  const r = await f.call('meetings_find_all', {});
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].drive_scope, 'personal');
});

test('upstream errors and approval requests fail closed; reads retry once after crash; logs carry no content', async t => {
  let n = 0;
  const f = fixture(t, { handler: (tool) => {
    if (tool === 'meetings.fetch') { n++; if (n === 1) throw new RpcError('exited', 'gone', { sent: true }); }
    if (tool === 'meetings.find_all') throw new RpcError('owner_interaction_required', 'approve?', { sent: true });
  } });
  const ok = await f.call('meetings_fetch', { note_id: NOTE });
  assert.equal(ok.id, NOTE);
  assert.equal(f.calls.length, 2);
  const denied = await f.call('meetings_find_all', { attendee_names: ['Secret Person'] });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'owner_interaction_required');
  const upstreamError = fixture(t, { handler: () => ({ structuredContent: { error: { code: 'meeting_not_found', message: 'no such note' } } }) });
  const e = await upstreamError.call('meetings_fetch', { note_id: 'missing' });
  assert.equal(e.ok, false);
  assert.equal(e.error.code, 'upstream_error');
  const all = [...f.logs, ...upstreamError.logs].join('\n');
  for (const secret of ['Secret Person', 'Pageless synthetic notes', NOTE, 'missing']) assert.ok(!all.includes(secret));
  assert.ok(f.logs.every(l => /^(tool_ok|tool_error):meetings_|^read_retry/.test(l)));
});

test('meetings path never reaches write tools or sends write kind', async t => {
  const f = fixture(t);
  await f.call('meetings_find_all', { limit: 3 });
  await f.call('meetings_fetch', { note_id: NOTE });
  assert.ok(f.calls.every(c => c.opts.kind === 'read' && c.tool.startsWith('meetings.')));
  await assert.rejects(f.bridge.callTool('meetings.fetch', {}), e => e.rpcCode === -32602);
  await assert.rejects(f.bridge.callTool('meetings_delete', {}), e => e.rpcCode === -32602);
});

test('text-only native read errors preserve bounded diagnostic without uncertain-write status', async t => {
  const f = fixture(t, { handler: () => ({ isError: true, content: [{ type: 'text', text: 'Note not found: synthetic_note' }] }) });
  const r = await f.call('meetings_fetch', { note_id: NOTE });
  assert.equal(r.error.code, 'upstream_error');
  assert.equal(r.error.message, 'Note not found: synthetic_note');
  assert.equal(Object.hasOwn(r.error, 'commit_status'), false);
  assert.equal(f.logs.some(l => l.includes('synthetic_note')), false);
});

test('Meetings result cap counts UTF-8 bytes and reports no unsupported Page-selection workaround', async t => {
  const f = fixture(t, { handler: () => ({ structuredContent: { id: NOTE, transcript: '\u4e2d'.repeat(360000) } }) });
  const r = await f.call('meetings_fetch', { note_id: NOTE });
  assert.equal(r.error.code, 'result_too_large');
  assert.match(r.error.message, /1 MiB/);
  assert.doesNotMatch(r.error.message, /read_page/);
  assert.equal(Object.hasOwn(r.error, 'commit_status'), false);
});

test('structured native read errors retain an available diagnostic without uncertain-write status', async t => {
  const f = fixture(t, { handler: () => ({ isError: true, structuredContent: { message: 'Synthetic note unavailable' } }) });
  const r = await f.call('meetings_fetch', { note_id: NOTE });
  assert.equal(r.error.message, 'Synthetic note unavailable');
  assert.equal(Object.hasOwn(r.error, 'commit_status'), false);
});
