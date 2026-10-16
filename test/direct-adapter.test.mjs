import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBridge, createCodexUpstream, saveKey, buildTranscriptBlocks, chunkTranscript, fenced, countOccurrences, LIMITS } from '../direct/adapter.mjs';
import { RpcError } from '../direct/rpc.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

const hash = text => createHash('sha256').update(text).digest('hex');
const clone = value => structuredClone(value);
const PAGE = 'page_synthetic';
const SPACE = 'space_synthetic';
const ORIGINAL = 'Header\nOld text\nUnrelated text';
const PATCH = { page_id: PAGE, block_id: 'block_synthetic', expected_hash: hash(ORIGINAL), old: 'Old text', new: 'New text' };
const SAVE = { space_id: SPACE, title: 'Synthetic transcript', recorded_at: '2026-10-16T12:00:00Z', source_id: 'synthetic-source-1', transcript: 'Speaker: synthetic private content\nSecond line ``` with fence\n' };
function page(id = PAGE, space = SPACE, title = 'Synthetic page', markdown = [ORIGINAL, 'Untouched sibling']) {
  return { metadata: { page_id: id, url: `https://example.invalid/${id}`, drive_scope: 'space', drive_space_id: space, stream_kind: 'content', deleted_at: null, access: { can_write: true } }, content: { page_id: id, title, schema_version: 1, title_hash: hash(title), through_sequence: 7, blocks: markdown.map((text, index) => ({ id: index === 0 && id === PAGE ? 'block_synthetic' : `${id}_block_${index}`, kind: 'markdown', markdown: text, hash: hash(text), metadata: {} })) }, selection: { page_block_count: markdown.length, selection_complete: true } };
}
async function fixture(t, options = {}) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-direct-tests-'));
  await fs.chmod(stateDir, 0o700);
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const calls = [];
  const pages = new Map([[PAGE, page()]]);
  const keys = new Map();
  const hooks = {};
  const upstream = {
    async callTool(tool, args, opts) {
      calls.push({ tool, args: clone(args), opts: clone(opts) });
      if (hooks[tool]) { const result = await hooks[tool](args); if (result !== undefined) return result; }
      if (tool === 'read_page') {
        const p = pages.get(args.page_id);
        if (!p) return { structuredContent: { error: { code: 'not_found', message: 'synthetic missing page' } } };
        const result = clone(p);
        if (args.block_ids) result.content.blocks = result.content.blocks.filter(b => args.block_ids.includes(b.id));
        return { structuredContent: result };
      }
      if (tool === 'patch_page') {
        const p = pages.get(args.page_id);
        const change = args.changes[0];
        const b = p.content.blocks.find(b => b.id === change.block_id);
        if (b.hash !== change.expected_hash) return { structuredContent: { error: { code: 'hash_mismatch', message: 'stale', commit_status: 'not_committed' } } };
        const r = change.replacements[0];
        b.markdown = b.markdown.replace(r.old, r.new); b.hash = hash(b.markdown);
        return { structuredContent: { new_sequence: 8, operation_results: [{ status: 'applied', affected_blocks: [{ block_id: b.id, hash: b.hash }] }] } };
      }
      if (tool === 'create_page') {
        let p = keys.get(args.idempotency_key);
        if (!p) { p = page(`page_created_${keys.size + 1}`, args.space_id, args.title, args.initial_blocks); keys.set(args.idempotency_key, p); pages.set(p.metadata.page_id, p); }
        return { structuredContent: clone(p) };
      }
      return { structuredContent: { items: [] } };
    },
    async inventory() { return { ok: true }; },
  };
  const logs = [];
  const bridge = createBridge({ upstream, stateDir, env: { BRIDGE_ALLOWED_SPACE_IDS: `${SPACE},space_second`, ...options.env }, log: message => logs.push(message) });
  const call = async (name, args) => (await bridge.callTool(name, args)).structuredContent;
  return { stateDir, calls, pages, keys, hooks, upstream, bridge, call, logs };
}
function errorIs(result, code) { assert.equal(result.ok, false); assert.equal(result.error.code, code); }
const writes = f => f.calls.filter(c => ['patch_page', 'create_page'].includes(c.tool));

test('adapter rejects unknown tools, extra arguments and caller upstream routing injection', async t => {
  const f = await fixture(t);
  for (const tool of ['turn/start', 'mcpServer/tool/call', 'create_page', 'delete_page', 'chatgpt_space.read_page']) {
    await assert.rejects(f.bridge.callTool(tool, {}), error => error.rpcCode === -32602);
  }
  for (const args of [{ page_id: PAGE, tool: 'delete_page' }, { page_id: PAGE, server: 'arbitrary' }, { page_id: PAGE, stream_kind: 'scratch' }]) {
    errorIs(await f.call('read_page', args), 'invalid_arguments');
  }
  assert.deepEqual(f.calls, []);
});

test('adapter additionalProperties false also rejects prototype-named JSON keys', async t => {
  const f = await fixture(t);
  for (const key of ['constructor', '__proto__', 'toString']) {
    const args = JSON.parse(`{"${key}":"synthetic"}`);
    errorIs(await f.call('list_spaces', args), 'invalid_arguments');
  }
  assert.deepEqual(f.calls, []);
});

test('adapter reads directly with exact bounded selectors and denies conflicting selectors', async t => {
  const f = await fixture(t);
  const result = await f.call('read_page', { page_id: PAGE, block_ids: [PATCH.block_id] });
  assert.equal(result.content.blocks.length, 1);
  assert.deepEqual(f.calls[0].args, { page_id: PAGE, block_ids: [PATCH.block_id] });
  assert.equal(f.calls[0].opts.kind, 'read');
  errorIs(await f.call('read_page', { page_id: PAGE, block_ids: [PATCH.block_id], search: ['Old'] }), 'invalid_arguments');
  errorIs(await f.call('read_page', { page_id: PAGE, block_ids: [] }), 'invalid_arguments');
  assert.equal(f.calls.length, 1);
});

test('patch writes exactly one guarded literal replacement, omits legacy sequence and verifies sibling preservation', async t => {
  const f = await fixture(t);
  const result = await f.call('patch_page', PATCH);
  assert.equal(result.verified, true);
  assert.deepEqual(writes(f).map(c => c.tool), ['patch_page']);
  assert.deepEqual(writes(f)[0].args, { page_id: PAGE, stream_kind: 'content', changes: [{ block_id: PATCH.block_id, expected_hash: PATCH.expected_hash, replacements: [{ old: PATCH.old, new: PATCH.new }] }] });
  assert.equal(f.pages.get(PAGE).content.blocks[1].markdown, 'Untouched sibling');
  assert.equal(f.pages.get(PAGE).content.blocks[0].markdown, ORIGINAL.replace(PATCH.old, PATCH.new));
  assert.equal(f.calls.filter(c => c.tool === 'read_page').length, 2);
  const patchState = await fs.readFile(path.join(f.stateDir, 'patches.jsonl'), 'utf8');
  assert.ok(!patchState.includes(PATCH.old));
  assert.ok(!patchState.includes(PATCH.new));
  assert.equal((await fs.stat(path.join(f.stateDir, 'patches.jsonl'))).mode & 0o777, 0o600);
});

test('patch destination allowlist, missing membership, deleted pages and unwritable pages fail before write', async t => {
  const cases = [
    ['space_not_allowed', { drive_space_id: 'space_other' }],
    ['space_not_allowed', { drive_scope: 'personal' }],
    ['space_membership_unverified', { drive_space_id: undefined }],
    ['page_deleted', { deleted_at: '2026-10-16T12:00:00Z' }],
    ['page_not_writable', { access: { can_write: false } }],
    ['stream_not_allowed', { stream_kind: 'scratch' }],
  ];
  for (const [expected, changes] of cases) {
    const f = await fixture(t);
    Object.assign(f.pages.get(PAGE).metadata, changes);
    errorIs(await f.call('patch_page', PATCH), expected);
    assert.equal(writes(f).length, 0);
  }
});

test('patch optional page allowlist and absent write configuration deny writes', async t => {
  for (const [env, expected] of [[{ BRIDGE_ALLOWED_PAGE_IDS: 'page_other' }, 'page_not_allowed'], [{ BRIDGE_ALLOWED_SPACE_IDS: '' }, 'writes_not_configured']]) {
    const f = await fixture(t, { env });
    errorIs(await f.call('patch_page', PATCH), expected);
    assert.equal(writes(f).length, 0);
  }
});

test('patch stale hash, absent old text, ambiguous overlapping old text and nonmarkdown blocks deny write', async t => {
  const cases = [
    [{ ...PATCH, expected_hash: 'stale' }, null, 'hash_mismatch'],
    [{ ...PATCH, old: 'missing' }, null, 'old_text_not_found'],
    [{ ...PATCH, old: 'aa', expected_hash: hash('aaa') }, { markdown: 'aaa', hash: hash('aaa') }, 'old_text_ambiguous'],
    [PATCH, { kind: 'instruction' }, 'block_kind_not_allowed'],
  ];
  for (const [args, changes, expected] of cases) {
    const f = await fixture(t);
    Object.assign(f.pages.get(PAGE).content.blocks[0], changes);
    errorIs(await f.call('patch_page', args), expected);
    assert.equal(writes(f).length, 0);
  }
  assert.equal(countOccurrences('aaa', 'aa'), 2);
});

test('patch per-operation rejection and stale upstream guards are errors with no write retry', async t => {
  for (const [response, expected] of [
    [{ error: { code: 'hash_mismatch', message: 'stale', commit_status: 'not_committed' } }, 'upstream_hash_mismatch'],
    [{ operation_results: [{ status: 'rejected', error_code: 'stale_hash' }] }, 'patch_not_applied'],
  ]) {
    const f = await fixture(t);
    f.hooks.patch_page = () => ({ structuredContent: response });
    errorIs(await f.call('patch_page', PATCH), expected);
    assert.equal(writes(f).length, 1);
  }
});

test('patch uncertain transport outcomes reconcile with reads and never retry write', async t => {
  const f = await fixture(t);
  f.hooks.patch_page = () => { throw new RpcError('timeout', 'synthetic timeout'); };
  const result = await f.call('patch_page', PATCH);
  errorIs(result, 'upstream_timeout');
  assert.equal(result.error.commit_status, 'unknown');
  assert.equal(result.error.reconciliation, 'unchanged');
  assert.equal(writes(f).length, 1);
  assert.equal(f.calls.filter(c => c.tool === 'read_page').length, 2);
});

test('reads get one crash recovery retry while write validation remains local', async t => {
  const f = await fixture(t);
  let attempts = 0;
  f.hooks.read_page = () => { if (attempts++ === 0) throw new RpcError('exited', 'synthetic crash'); };
  assert.equal((await f.call('read_page', { page_id: PAGE })).content.page_id, PAGE);
  assert.equal(attempts, 2);
  errorIs(await f.call('patch_page', { ...PATCH, old: 'x'.repeat(LIMITS.patchTextChars + 1) }), 'invalid_arguments');
  assert.equal(writes(f).length, 0);
});

test('transcript save uses deterministic native identity, exact fence blocks and private hash-only journal', async t => {
  const f = await fixture(t);
  const result = await f.call('save_transcript', SAVE);
  assert.equal(result.status, 'created');
  assert.equal(result.verified, true);
  const saved = writes(f)[0];
  assert.equal(saved.tool, 'create_page');
  assert.equal(saved.args.idempotency_key, saveKey(SAVE.source_id));
  assert.deepEqual(saved.args.initial_blocks, buildTranscriptBlocks(SAVE));
  assert.ok(saved.args.initial_blocks.at(-1).startsWith('```text\n'));
  const stateFile = path.join(f.stateDir, 'saves', `${saved.args.idempotency_key}.json`);
  assert.equal((await fs.stat(stateFile)).mode & 0o777, 0o600);
  const text = await fs.readFile(stateFile, 'utf8');
  assert.ok(!text.includes(SAVE.transcript));
  assert.ok(!text.includes(SAVE.title));
  assert.ok(!text.includes(SAVE.source_id));
  assert.ok(!JSON.stringify(f.logs).includes(SAVE.transcript));
});

test('same transcript retries return original page and never recreate a trashed or missing page', async t => {
  const f = await fixture(t);
  const created = await f.call('save_transcript', SAVE);
  const retry = await f.call('save_transcript', SAVE);
  assert.equal(retry.status, 'already_saved');
  assert.equal(retry.page_id, created.page_id);
  assert.equal(writes(f).length, 1);
  f.pages.get(created.page_id).metadata.deleted_at = '2026-10-16T12:00:00Z';
  errorIs(await f.call('save_transcript', SAVE), 'saved_page_unavailable_no_recreate');
  errorIs(await f.call('save_transcript', { ...SAVE, retry_uncertain: true }), 'invalid_arguments');
  f.pages.delete(created.page_id);
  errorIs(await f.call('save_transcript', SAVE), 'saved_page_unavailable_no_recreate');
  assert.equal(writes(f).length, 1);
});

test('transcript source identity rejects changed content, title, timestamp and destination', async t => {
  const f = await fixture(t);
  await f.call('save_transcript', SAVE);
  for (const change of [{ transcript: 'changed' }, { title: 'Changed title' }, { recorded_at: '2026-10-17T12:00:00Z' }, { space_id: 'space_second' }]) {
    errorIs(await f.call('save_transcript', { ...SAVE, ...change }), 'source_conflict');
  }
  assert.equal(writes(f).length, 1);
});

test('transcript uncertain writes never replay even if the caller supplies a retry flag', async t => {
  const f = await fixture(t);
  f.hooks.create_page = args => {
    const committed = page('page_committed_before_timeout', args.space_id, args.title, args.initial_blocks);
    f.keys.set(args.idempotency_key, committed);
    f.pages.set(committed.metadata.page_id, committed);
    throw new RpcError('timeout', 'synthetic timeout');
  };
  const first = await f.call('save_transcript', SAVE);
  errorIs(first, 'upstream_timeout');
  assert.equal(first.error.commit_status, 'unknown');
  errorIs(await f.call('save_transcript', SAVE), 'write_outcome_unknown');
  assert.equal(writes(f).length, 1);
  delete f.hooks.create_page;
  errorIs(await f.call('save_transcript', { ...SAVE, retry_uncertain: true }), 'invalid_arguments');
  errorIs(await f.call('save_transcript', SAVE), 'write_outcome_unknown');
  assert.equal(f.keys.size, 1);
  assert.equal(writes(f).length, 1);
});

test('transcript destination allowlist and invalid provenance deny creation', async t => {
  const f = await fixture(t);
  for (const [change, expected] of [[{ space_id: 'space_other' }, 'space_not_allowed'], [{ recorded_at: 'yesterday' }, 'invalid_arguments'], [{ title: ' leading' }, 'invalid_arguments'], [{ transcript: '' }, 'invalid_arguments'], [{ parent_page_id: 'page_untrusted' }, 'invalid_arguments']]) {
    errorIs(await f.call('save_transcript', { ...SAVE, ...change }), expected);
  }
  assert.equal(writes(f).length, 0);
});

test('transcript readback without confirmed space membership fails closed', async t => {
  const f = await fixture(t);
  f.hooks.read_page = args => {
    const p = clone(f.pages.get(args.page_id));
    delete p.metadata.drive_space_id;
    return { structuredContent: p };
  };
  const result = await f.call('save_transcript', SAVE);
  assert.equal(result.ok, false);
  assert.equal(result.error.commit_status, 'committed');
  assert.equal(writes(f).length, 1);
});

test('real upstream wrapper pins server and tools, creates no inference turn and strips BRIDGE env', async t => {
  const children = [];
  const messages = [];
  const launches = [];
  const spawn = (command, args, options) => {
    launches.push({ command, args, options });
    const child = new EventEmitter(); children.push(child);
    child.stdout = new PassThrough();
    child.kill = () => { queueMicrotask(() => child.emit('exit', 0)); return true; };
    child.stdin = new Writable({ write(chunk, encoding, done) {
      const message = JSON.parse(chunk.toString()); messages.push(message); done();
      if (!Object.hasOwn(message, 'id')) return;
      const result = message.method === 'thread/start' ? { thread: { id: 'synthetic-thread', ephemeral: true } } : message.method === 'mcpServer/tool/call' ? { structuredContent: { ok: true } } : {};
      queueMicrotask(() => child.stdout.write(JSON.stringify({ id: message.id, result }) + '\n'));
    } });
    return child;
  };
  const upstream = createCodexUpstream({ spawn, env: { PATH: process.env.PATH, HOME: '/synthetic/home', CODEX_HOME: '/synthetic/codex', LANG: 'en_US.UTF-8', HTTPS_PROXY: 'http://synthetic.invalid:8080', SSL_CERT_FILE: '/synthetic/ca.pem', BRIDGE_LOCAL_TOKEN: 'synthetic-secret', OPENAI_API_KEY: 'synthetic-api-key', AWS_SECRET_ACCESS_KEY: 'synthetic-aws-key', NODE_OPTIONS: '--require=/synthetic/injected.js', NODE_PATH: '/synthetic/modules', PYTHONPATH: '/synthetic/python' }, startTimeoutMs: 100 });
  t.after(() => upstream.close());
  await assert.rejects(upstream.callTool('delete_page', {}), error => error.code === 'protocol' && error.sent === false);
  assert.equal(launches.length, 0);
  await upstream.callTool('read_page', { page_id: PAGE }, { timeoutMs: 100 });
  assert.deepEqual(launches[0].args, ['app-server', '--listen', 'stdio://']);
  for (const key of ['BRIDGE_LOCAL_TOKEN', 'OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH']) assert.equal(launches[0].options.env[key], undefined);
  assert.equal(launches[0].options.env.PATH, process.env.PATH);
  assert.equal(launches[0].options.env.HOME, '/synthetic/home');
  assert.equal(launches[0].options.env.CODEX_HOME, '/synthetic/codex');
  assert.equal(launches[0].options.env.LANG, 'en_US.UTF-8');
  assert.equal(launches[0].options.env.HTTPS_PROXY, 'http://synthetic.invalid:8080');
  assert.equal(launches[0].options.env.SSL_CERT_FILE, '/synthetic/ca.pem');
  assert.equal(messages.some(m => m.method === 'turn/start'), false);
  const direct = messages.find(m => m.method === 'mcpServer/tool/call');
  assert.deepEqual(direct.params, { threadId: 'synthetic-thread', server: 'codex_apps', tool: 'chatgpt_space.read_page', arguments: { page_id: PAGE } });
  const thread = messages.find(m => m.method === 'thread/start');
  assert.equal(thread.params.ephemeral, true);
  assert.equal(thread.params.sandbox, 'read-only');
});


test('transcript chunks preserve every character across newline, hard and Unicode boundaries', () => {
  for (const text of ['line one\nline two\nline three\n', 'x'.repeat(31), '1234567😀\nαβγ\nend', '\n\nstart\nend\n']) {
    const chunks = chunkTranscript(text, 8);
    assert.equal(chunks.join(''), text);
    assert.ok(chunks.every(chunk => Buffer.byteLength(chunk, 'utf8') <= 8));
    assert.ok(chunks.every(chunk => !/[\ud800-\udbff]$/.test(chunk)));
  }
});

test('transcript creation metadata-only response discovers complete block IDs by readback', async t => {
  const f = await fixture(t);
  f.hooks.create_page = args => {
    const created = page('page_metadata_only', args.space_id, args.title, args.initial_blocks);
    f.pages.set(created.metadata.page_id, created);
    return { structuredContent: { metadata: created.metadata } };
  };
  const result = await f.call('save_transcript', SAVE);
  assert.equal(result.verified, true);
  assert.equal(result.page_id, 'page_metadata_only');
  assert.equal(writes(f).length, 1);
  assert.ok(f.calls.some(call => call.tool === 'read_page' && call.args.page_id === 'page_metadata_only'));
  const retry = await f.call('save_transcript', SAVE);
  assert.equal(retry.status, 'already_saved');
  assert.equal(retry.page_id, 'page_metadata_only');
  assert.equal(writes(f).length, 1);
});


test('transcript journal preserves original-page identity across bridge process recreation', async t => {
  const f = await fixture(t);
  const created = await f.call('save_transcript', SAVE);
  const restarted = createBridge({ upstream: f.upstream, stateDir: f.stateDir, env: { BRIDGE_ALLOWED_SPACE_IDS: SPACE } });
  const result = (await restarted.callTool('save_transcript', SAVE)).structuredContent;
  assert.equal(result.status, 'already_saved');
  assert.equal(result.page_id, created.page_id);
  errorIs((await restarted.callTool('save_transcript', { ...SAVE, transcript: 'changed after restart' })).structuredContent, 'source_conflict');
  assert.equal(writes(f).length, 1);
});


test('transcript uncertain saves may reconcile by reads without replaying creation', async t => {
  const f = await fixture(t);
  f.hooks.create_page = args => {
    const p = page('page_reconciled', args.space_id, args.title, args.initial_blocks);
    f.keys.set(args.idempotency_key, p);
    f.pages.set(p.metadata.page_id, p);
    throw new RpcError('timeout', 'synthetic timeout');
  };
  errorIs(await f.call('save_transcript', SAVE), 'upstream_timeout');
  f.hooks.find_pages = () => ({ structuredContent: { items: [{ page_id: 'page_reconciled', title: SAVE.title, url: 'https://example.invalid/page_reconciled', deleted_at: null }] } });
  const result = await f.call('save_transcript', SAVE);
  assert.equal(result.page_id, 'page_reconciled');
  assert.equal(result.verified, true);
  assert.equal(result.reconciled, true);
  assert.equal(writes(f).length, 1);
});

test('transcript created in unexpected space is never recreated on retry', async t => {
  const f = await fixture(t);
  f.hooks.create_page = args => {
    const p = page('page_wrong_space', 'space_unexpected', args.title, args.initial_blocks);
    f.pages.set(p.metadata.page_id, p);
    return { structuredContent: { metadata: p.metadata } };
  };
  errorIs(await f.call('save_transcript', SAVE), 'unexpected_space');
  const result = await f.call('save_transcript', SAVE);
  assert.equal(result.ok, false);
  assert.equal(writes(f).length, 1);
});


test('transcript UTF-8 byte bound rejects multibyte input before upstream creation', async t => {
  const f = await fixture(t);
  const transcript = '☃'.repeat(Math.floor(LIMITS.transcriptBytes / 3) + 1);
  assert.ok(transcript.length < LIMITS.transcriptChars);
  errorIs(await f.call('save_transcript', { ...SAVE, transcript }), 'transcript_too_large');
  assert.equal(writes(f).length, 0);
});


test('read privacy excludes private drives, missing Space membership and deleted pages', async t => {
  for (const change of [{ drive_scope: 'personal' }, { drive_scope: 'workspace_private' }, { drive_scope: null }, { drive_space_id: undefined }, { drive_space_id: null }, { deleted_at: '2026-10-16T12:00:00Z' }]) {
    const f = await fixture(t);
    Object.assign(f.pages.get(PAGE).metadata, change);
    const response = await f.bridge.callTool('read_page', { page_id: PAGE });
    assert.equal(response.isError, true);
    assert.equal(response.structuredContent.ok, false);
    assert.equal(response.structuredContent.content, undefined);
    assert.ok(!JSON.stringify(response).includes(ORIGINAL));
    assert.equal(writes(f).length, 0);
  }
});

test('read permission includes owner-accessible Spaces outside the write allowlist', async t => {
  const f = await fixture(t);
  f.pages.get(PAGE).metadata.drive_space_id = 'space_readable_not_write_allowed';
  const result = await f.call('read_page', { page_id: PAGE });
  assert.equal(result.content.page_id, PAGE);
  assert.equal(result.metadata.drive_space_id, 'space_readable_not_write_allowed');
  errorIs(await f.call('patch_page', PATCH), 'space_not_allowed');
  assert.equal(writes(f).length, 0);
});

test('find requires explicit Space while owner-accessible Space listing remains broad', async t => {
  const f = await fixture(t);
  errorIs(await f.call('find_pages', { query: 'synthetic' }), 'invalid_arguments');
  assert.equal(f.calls.length, 0);
  f.hooks.find_pages = () => ({ structuredContent: { items: [{ page_id: 'page_other_readable', drive_scope: 'space', drive_space_id: 'space_readable_not_write_allowed', deleted_at: null }, { page_id: 'page_personal_hidden', drive_scope: 'personal' }, { page_id: 'page_deleted_hidden', drive_scope: 'space', deleted_at: '2026-10-16T12:00:00Z' }] } });
  const found = await f.call('find_pages', { query: 'synthetic', space_id: 'space_readable_not_write_allowed' });
  assert.deepEqual(found.items.map(item => item.page_id), ['page_other_readable']);
  assert.deepEqual(f.calls[0].args, { query: 'synthetic', space_id: 'space_readable_not_write_allowed' });
  const allSpaces = [{ id: SPACE }, { id: 'space_readable_not_write_allowed' }];
  f.hooks.list_spaces = () => ({ structuredContent: { items: allSpaces } });
  assert.deepEqual((await f.call('list_spaces', {})).items, allSpaces);
});

test('generic post-create exceptions remain uncertain and cannot replay a committed save', async t => {
  const f = await fixture(t);
  f.hooks.create_page = args => {
    const p = page('page_generic_exception', args.space_id, args.title, args.initial_blocks);
    f.pages.set(p.metadata.page_id, p);
    throw new Error('synthetic-sensitive-upstream-exception');
  };
  const failed = await f.call('save_transcript', SAVE);
  assert.equal(failed.ok, false);
  assert.ok(!JSON.stringify(failed).includes('synthetic-sensitive-upstream-exception'));
  const stateFile = path.join(f.stateDir, 'saves', `${saveKey(SAVE.source_id)}.json`);
  assert.equal(JSON.parse(await fs.readFile(stateFile, 'utf8')).state, 'unknown');
  errorIs(await f.call('save_transcript', SAVE), 'write_outcome_unknown');
  assert.equal(writes(f).length, 1);
});

test('upstream refuses a non-ephemeral thread before any account tool call', async t => {
  for (const ephemeral of [false, undefined]) {
    const messages = [];
    const spawn = () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.kill = () => { queueMicrotask(() => child.emit('exit', 0)); return true; };
      child.stdin = new Writable({ write(chunk, encoding, done) {
        const message = JSON.parse(chunk.toString()); messages.push(message); done();
        if (!Object.hasOwn(message, 'id')) return;
        const result = message.method === 'thread/start' ? { thread: { id: 'synthetic-non-ephemeral', ...(ephemeral === undefined ? {} : { ephemeral }) } } : {};
        queueMicrotask(() => child.stdout.write(JSON.stringify({ id: message.id, result }) + '\n'));
      } });
      return child;
    };
    const upstream = createCodexUpstream({ spawn, env: { PATH: process.env.PATH }, startTimeoutMs: 100 });
    t.after(() => upstream.close());
    await assert.rejects(upstream.callTool('read_page', { page_id: PAGE }, { timeoutMs: 100 }), error => error instanceof RpcError && error.code === 'protocol' && error.sent === false);
    assert.equal(messages.some(m => m.method === 'mcpServer/tool/call'), false);
    assert.equal(messages.some(m => m.method === 'turn/start'), false);
  }
});

test('large metadata-only transcript creation uses full-view fallback then retained block IDs', async t => {
  const f = await fixture(t);
  const input = { ...SAVE, transcript: 'Synthetic large transcript line.\n'.repeat(4400) };
  assert.ok(Buffer.byteLength(input.transcript) > 128_000);
  assert.ok(Buffer.byteLength(input.transcript) < LIMITS.transcriptBytes);
  f.hooks.create_page = args => {
    const p = page('page_large_full_view', args.space_id, args.title, args.initial_blocks);
    f.pages.set(p.metadata.page_id, p);
    return { structuredContent: { metadata: p.metadata } };
  };
  f.hooks.read_page = args => {
    const result = clone(f.pages.get(args.page_id));
    if (args.block_ids) result.content.blocks = result.content.blocks.filter(block => args.block_ids.includes(block.id));
    if (args.view === 'full' || args.block_ids) return { structuredContent: result };
    return { structuredContent: { error: { code: 'page_read_selection_required', message: 'synthetic editing view too large' } } };
  };
  const result = await f.call('save_transcript', input);
  assert.equal(result.verified, true);
  assert.equal(result.page_id, 'page_large_full_view');
  const retry = await f.call('save_transcript', input);
  assert.equal(retry.status, 'already_saved');
  assert.equal(retry.page_id, result.page_id);
  assert.equal(writes(f).length, 1);
  const reads = f.calls.filter(c => c.tool === 'read_page').map(c => c.args);
  assert.deepEqual(reads.slice(0, 2), [{ page_id: result.page_id }, { page_id: result.page_id, view: 'full' }]);
  assert.ok(reads.slice(2).every(args => args.block_ids?.length > 0 && args.block_ids.length <= 16 && args.view === undefined));
  assert.deepEqual(reads.slice(2).flatMap(args => args.block_ids), f.pages.get(result.page_id).content.blocks.map(block => block.id));
});

test('unsupported fence or JSON expansion fails preflight before creating or claiming source', async t => {
  for (const [transcript, code] of [['`'.repeat(2000) + '~'.repeat(2000), 'unsupported_transcript_format'], ['\u0001'.repeat(50_000), 'transcript_too_large']]) {
    const f = await fixture(t);
    assert.ok(Buffer.byteLength(transcript) < LIMITS.transcriptBytes);
    errorIs(await f.call('save_transcript', { ...SAVE, transcript }), code);
    assert.equal(writes(f).length, 0);
    assert.deepEqual(await fs.readdir(f.stateDir), []);
  }
});

test('independent bridge instances atomically claim one source before any create', async t => {
  const f = await fixture(t);
  const second = createBridge({ upstream: f.upstream, stateDir: f.stateDir, env: { BRIDGE_ALLOWED_SPACE_IDS: SPACE } });
  let release;
  let entered;
  const began = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  f.hooks.create_page = async () => { entered(); await pending; };
  const calls = [f.call('save_transcript', SAVE), second.callTool('save_transcript', SAVE).then(result => result.structuredContent)];
  await began;
  let early;
  try {
    early = await Promise.race(calls);
    assert.equal(early.ok, false);
    assert.ok(['write_in_progress', 'write_outcome_unknown'].includes(early.error.code));
    assert.equal(writes(f).length, 1);
  } finally { release(); }
  const results = await Promise.all(calls);
  assert.equal(results.filter(result => result.verified).length, 1);
  assert.equal(writes(f).length, 1);
});


test('UTF-8 transcript chunks stay within native byte budget without splitting text', () => {
  for (const text of ['😀'.repeat(4000), 'αβγ☃😀\n'.repeat(2000), 'x'.repeat(3999) + '😀' + 'end']) {
    const chunks = chunkTranscript(text);
    assert.equal(chunks.join(''), text);
    assert.ok(chunks.every(chunk => Buffer.byteLength(chunk, 'utf8') <= 4000));
    assert.ok(chunks.every(chunk => Buffer.byteLength(fenced(chunk), 'utf8') < 7000));
    assert.ok(chunks.every(chunk => !/[\ud800-\udbff]$/.test(chunk)));
  }
});

test('triple fences preserve inline backticks and blank lines verbatim', async t => {
  const f = await fixture(t);
  const transcript = 'Speaker: inline ``` marker and ~~~ text.\n\nNext paragraph: inline ```` marker.\nTab\tand trailing spaces  \n';
  const input = { ...SAVE, transcript };
  const blocks = buildTranscriptBlocks(input).slice(3);
  assert.ok(blocks.every(block => block.startsWith('```text\n') && block.endsWith('\n```') && Buffer.byteLength(block) < 7000));
  assert.equal(blocks.map(block => block.slice(block.indexOf('\n') + 1, block.lastIndexOf('\n'))).join(''), transcript);
  const saved = await f.call('save_transcript', input);
  assert.equal(saved.verified, true);
  assert.equal((await f.call('save_transcript', input)).page_id, saved.page_id);
  assert.equal(writes(f).length, 1);
});

test('native line-ending normalization preserves words and whitespace with original and stored hashes', async t => {
  const f = await fixture(t);
  const transcript = 'First \t  \r\nSecond\t \rThird  \r\n';
  const normalized = transcript.replace(/\r\n?/g, '\n');
  const input = { ...SAVE, transcript };
  const blocks = buildTranscriptBlocks(input);
  assert.ok(blocks[2].includes(hash(transcript)));
  assert.ok(blocks[2].includes(hash(normalized)));
  assert.ok(blocks[2].includes('Line endings normalized to LF'));
  const stored = blocks.slice(3).map(block => block.slice(block.indexOf('\n') + 1, block.lastIndexOf('\n'))).join('');
  assert.equal(stored, normalized);
  assert.equal(chunkTranscript(transcript).join(''), transcript);
  const saved = await f.call('save_transcript', input);
  assert.equal(saved.verified, true);
  assert.equal(saved.lineEndingsNormalized, true);
  assert.equal((await f.call('save_transcript', input)).page_id, saved.page_id);
  assert.equal(writes(f).length, 1);
  const lfOnly = buildTranscriptBlocks({ ...SAVE, transcript: normalized });
  assert.ok(!lfOnly[2].includes('Original source SHA-256'));
});

test('large creation with known block IDs immediately verifies through sixteen-ID batches', async t => {
  const f = await fixture(t);
  const input = { ...SAVE, transcript: '😀 Large known-id transcript line.\n'.repeat(2600) };
  f.hooks.read_page = args => {
    assert.ok(args.block_ids?.length > 0 && args.block_ids.length <= 16);
    assert.equal(args.view, undefined);
    const result = clone(f.pages.get(args.page_id));
    result.content.blocks = result.content.blocks.filter(block => args.block_ids.includes(block.id)).reverse();
    return { structuredContent: result };
  };
  const saved = await f.call('save_transcript', input);
  assert.equal(saved.verified, true);
  const reads = f.calls.filter(call => call.tool === 'read_page');
  assert.ok(reads.length > 1);
  assert.deepEqual(reads.flatMap(call => call.args.block_ids), f.pages.get(saved.page_id).content.blocks.map(block => block.id));
  assert.equal(writes(f).length, 1);
});

test('failed metadata-only full fallback surfaces actual upstream failure and never recreates', async t => {
  const f = await fixture(t);
  const input = { ...SAVE, transcript: 'Large fallback failure line.\n'.repeat(4500) };
  f.hooks.create_page = args => {
    const created = page('page_full_fallback_failure', args.space_id, args.title, args.initial_blocks);
    f.pages.set(created.metadata.page_id, created);
    return { structuredContent: { metadata: created.metadata } };
  };
  f.hooks.read_page = args => ({ structuredContent: { error: { code: args.view === 'full' ? 'native_read_unavailable' : 'page_read_selection_required', message: 'synthetic bounded failure' } } });
  const first = await f.call('save_transcript', input);
  errorIs(first, 'readback_mismatch');
  assert.equal(first.error.detail, 'native_read_unavailable');
  assert.equal(first.error.commit_status, 'committed');
  const retry = await f.call('save_transcript', input);
  errorIs(retry, 'readback_mismatch');
  assert.equal(retry.error.detail, 'native_read_unavailable');
  assert.equal(writes(f).length, 1);
});


test('find and list Page previews include only current Space results and keep pagination', async t => {
  const f = await fixture(t);
  const allowed = { page_id: 'page_allowed_preview', drive_scope: 'space', drive_space_id: 'space_readable_not_write_allowed', deleted_at: null, preview: 'Synthetic allowed preview' };
  const hidden = [
    { page_id: 'page_personal', drive_scope: 'personal' },
    { page_id: 'page_workspace_private', drive_scope: 'workspace_private' },
    { page_id: 'page_scope_null', drive_scope: null },
    { page_id: 'page_scope_missing' },
    { page_id: 'page_trashed', drive_scope: 'space', deleted_at: '2026-10-16T12:00:00Z' },
  ].map(item => ({ ...item, preview: 'synthetic_hidden_preview_' + item.page_id }));
  for (const tool of ['find_pages', 'list_pages']) {
    f.hooks[tool] = () => ({ structuredContent: { items: [hidden[0], allowed, ...hidden.slice(1)], next_cursor: 'synthetic-next-cursor', partial_results: true } });
    const response = await f.bridge.callTool(tool, { space_id: 'space_readable_not_write_allowed', ...(tool === 'find_pages' ? { query: 'synthetic' } : {}) });
    assert.deepEqual(response.structuredContent.items, [allowed]);
    assert.equal(response.structuredContent.next_cursor, 'synthetic-next-cursor');
    assert.equal(response.structuredContent.partial_results, true);
    assert.ok(!JSON.stringify(response).includes('synthetic_hidden_preview_'));
  }
  assert.equal(writes(f).length, 0);
});


test('closing backtick fence lines reject before journal claim or Page creation', async t => {
  for (const transcript of ['```', 'Before\n```after\nEnd', 'Before\n \t````text\nEnd', 'Before\r\n\t```\rEnd', '`'.repeat(12000)]) {
    const f = await fixture(t);
    errorIs(await f.call('save_transcript', { ...SAVE, transcript }), 'unsupported_transcript_format');
    assert.equal(writes(f).length, 0);
    assert.deepEqual(await fs.readdir(f.stateDir), []);
  }
});


test('exact creation receipt permits truthful freshness-pending status then read-only verification', async t => {
  const f = await fixture(t);
  const input = { ...SAVE, transcript: 'Synthetic receipt-confirmed transcript.\n'.repeat(2200) };
  f.hooks.read_page = () => ({ structuredContent: { error: { code: 'page_freshness_unavailable', message: 'synthetic temporarily stale projection' } } });
  const saved = await f.call('save_transcript', input);
  assert.equal(saved.ok, true);
  assert.equal(saved.status, 'saved_verification_pending');
  assert.equal(saved.saved, true);
  assert.equal(saved.verified, false);
  assert.ok(saved.url.includes(saved.page_id));
  const stateFile = path.join(f.stateDir, 'saves', `${saveKey(input.source_id)}.json`);
  const entry = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  assert.equal(entry.creationReceiptMatches, true);
  assert.equal(entry.state, 'created');
  assert.ok(!JSON.stringify(entry).includes(input.transcript));
  const pendingRetry = await f.call('save_transcript', input);
  assert.equal(pendingRetry.status, 'saved_verification_pending');
  assert.equal(pendingRetry.verified, false);
  assert.equal(pendingRetry.page_id, saved.page_id);
  assert.equal(pendingRetry.url, saved.url);
  assert.equal(writes(f).length, 1);
  delete f.hooks.read_page;
  const verified = await f.call('save_transcript', input);
  assert.equal(verified.status, 'already_saved');
  assert.equal(verified.verified, true);
  assert.equal(verified.page_id, saved.page_id);
  assert.equal(verified.url, saved.url);
  assert.equal(writes(f).length, 1);
});

test('missing or incorrect creation receipt cannot claim pending freshness success', async t => {
  const variants = [
    receipt => { delete receipt.content; },
    receipt => { receipt.metadata.drive_space_id = 'space_receipt_wrong'; },
    receipt => { receipt.content.page_id = 'page_receipt_wrong'; },
    receipt => { receipt.content.title = 'Wrong receipt title'; },
    receipt => { receipt.content.blocks[0].markdown = 'Wrong receipt text'; },
    receipt => { receipt.content.blocks.pop(); },
  ];
  for (const mutate of variants) {
    const f = await fixture(t);
    const input = { ...SAVE, transcript: 'Synthetic receipt contract transcript.\n'.repeat(2200) };
    f.hooks.create_page = args => {
      const created = page('page_bad_receipt', args.space_id, args.title, args.initial_blocks);
      f.pages.set(created.metadata.page_id, created);
      const receipt = clone(created);
      mutate(receipt);
      return { structuredContent: receipt };
    };
    f.hooks.read_page = () => ({ structuredContent: { error: { code: 'page_freshness_unavailable', message: 'synthetic stale projection' } } });
    const failed = await f.call('save_transcript', input);
    assert.equal(failed.ok, false);
    assert.notEqual(failed.status, 'saved_verification_pending');
    const stateFile = path.join(f.stateDir, 'saves', `${saveKey(input.source_id)}.json`);
    assert.equal(JSON.parse(await fs.readFile(stateFile, 'utf8')).creationReceiptMatches, false);
    assert.equal((await f.call('save_transcript', input)).ok, false);
    assert.equal(writes(f).length, 1);
  }
});

test('exact receipt never hides actual content mismatch or a different readback error', async t => {
  for (const mismatch of [true, false]) {
    const f = await fixture(t);
    const input = { ...SAVE, transcript: 'Synthetic content mismatch transcript.\n'.repeat(2200) };
    f.hooks.read_page = args => {
      if (!mismatch) return { structuredContent: { error: { code: 'native_read_unavailable', message: 'synthetic real read error' } } };
      const got = clone(f.pages.get(args.page_id));
      if (args.block_ids) got.content.blocks = got.content.blocks.filter(block => args.block_ids.includes(block.id));
      got.content.blocks[0].markdown = 'Actual content differs';
      return { structuredContent: got };
    };
    const failed = await f.call('save_transcript', input);
    errorIs(failed, 'readback_mismatch');
    assert.equal(failed.error.commit_status, 'committed');
    assert.equal(failed.error.reason, mismatch ? 'content_mismatch' : 'readback_failed');
    if (!mismatch) assert.equal(failed.error.detail, 'native_read_unavailable');
    assert.equal((await f.call('save_transcript', input)).ok, false);
    assert.equal(writes(f).length, 1);
  }
});

test('small exact-receipt save can be freshness-pending and later verify without recreation', async t => {
  const f = await fixture(t);
  f.hooks.read_page = () => ({ structuredContent: { error: { code: 'page_freshness_unavailable', retryable: true, message: 'synthetic small-page projection delay' } } });
  const saved = await f.call('save_transcript', SAVE);
  assert.equal(saved.status, 'saved_verification_pending');
  assert.equal(saved.saved, true);
  assert.equal(saved.verified, false);
  assert.equal(f.calls.filter(call => call.tool === 'read_page').length, 2);
  const pendingRetry = await f.call('save_transcript', SAVE);
  assert.equal(pendingRetry.status, 'saved_verification_pending');
  assert.equal(pendingRetry.page_id, saved.page_id);
  assert.equal(pendingRetry.url, saved.url);
  assert.equal(writes(f).length, 1);
  delete f.hooks.read_page;
  const verified = await f.call('save_transcript', SAVE);
  assert.equal(verified.status, 'already_saved');
  assert.equal(verified.verified, true);
  assert.equal(verified.page_id, saved.page_id);
  assert.equal(writes(f).length, 1);
});

test('string-shaped upstream errors preserve diagnostic and top-level metadata', async t => {
  const f = await fixture(t);
  f.hooks.read_page = () => ({ structuredContent: { error: 'Synthetic native diagnostic', error_code: 'synthetic_native_error', error_data: { commit_status: 'not_committed', retryable: false } } });
  const result = await f.call('read_page', { page_id: PAGE });
  errorIs(result, 'upstream_error');
  assert.equal(result.error.message, 'Synthetic native diagnostic');
  assert.deepEqual(result.error.upstream, { code: 'synthetic_native_error', message: 'Synthetic native diagnostic', commit_status: 'not_committed', retryable: false });
  assert.equal(f.calls.length, 1);
});

test('closed-session read restarts the owned upstream once and succeeds on second attempt', async t => {
  const f = await fixture(t);
  let closed = 0;
  let attempts = 0;
  f.upstream.close = async () => { closed++; };
  f.hooks.read_page = () => {
    if (attempts++ === 0) return { structuredContent: { error: 'Sheep MCP session closed: RPC INTERNAL', error_code: 'synthetic_session_error' } };
  };
  const result = await f.call('read_page', { page_id: PAGE });
  assert.equal(result.content.page_id, PAGE);
  assert.equal(attempts, 2);
  assert.equal(closed, 1);
  assert.equal(writes(f).length, 0);
});

test('persistent closed-session errors stop after two read attempts', async t => {
  const f = await fixture(t);
  let closed = 0;
  f.upstream.close = async () => { closed++; };
  f.hooks.read_page = () => ({ structuredContent: { error: 'Sheep MCP session closed: RPC INTERNAL', error_code: 'synthetic_session_error' } });
  const failed = await f.call('read_page', { page_id: PAGE });
  errorIs(failed, 'upstream_error');
  assert.equal(failed.error.message, 'Sheep MCP session closed: RPC INTERNAL');
  assert.equal(f.calls.filter(call => call.tool === 'read_page').length, 2);
  assert.equal(closed, 1);
  assert.equal(writes(f).length, 0);
});

test('freshness read retry requires explicit retryable=true and never closes session', async t => {
  for (const retryable of [true, false, undefined]) {
    const f = await fixture(t);
    let closed = 0;
    let attempts = 0;
    f.upstream.close = async () => { closed++; };
    f.hooks.read_page = () => {
      if (attempts++ === 0) return { structuredContent: { error: { code: 'page_freshness_unavailable', message: 'Synthetic projection delay', ...(retryable === undefined ? {} : { retryable }) } } };
    };
    const result = await f.call('read_page', { page_id: PAGE });
    if (retryable === true) { assert.equal(result.content.page_id, PAGE); assert.equal(attempts, 2); }
    else { errorIs(result, 'upstream_error'); assert.equal(attempts, 1); }
    assert.equal(closed, 0);
    assert.equal(writes(f).length, 0);
  }
});

test('string-shaped writer session errors remain UNKNOWN with exactly one write', async t => {
  for (const tool of ['save_transcript', 'patch_page']) {
    const f = await fixture(t);
    let closed = 0;
    f.upstream.close = async () => { closed++; };
    f.hooks[tool === 'save_transcript' ? 'create_page' : 'patch_page'] = () => ({ structuredContent: { error: 'Sheep MCP session closed: RPC INTERNAL', error_code: 'synthetic_session_error', error_data: { retryable: true } } });
    const result = await f.call(tool, tool === 'save_transcript' ? SAVE : PATCH);
    errorIs(result, 'upstream_synthetic_session_error');
    assert.equal(result.error.message, 'Sheep MCP session closed: RPC INTERNAL');
    assert.equal(result.error.commit_status, 'unknown');
    assert.equal(writes(f).length, 1);
    assert.equal(closed, 0);
    if (tool === 'save_transcript') {
      errorIs(await f.call(tool, SAVE), 'write_outcome_unknown');
      assert.equal(writes(f).length, 1);
    }
  }
});
