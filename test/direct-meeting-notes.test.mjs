import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBridge, saveFingerprint, LIMITS } from '../direct/adapter.mjs';
import { RpcError } from '../direct/rpc.mjs';

const hash = (s) => createHash('sha256').update(s).digest('hex');
const SPACE = 'space_synthetic';
const NOTES = { space_id: SPACE, title: 'Synthetic sync', recorded_at: '2026-10-16T12:00:00Z', source_id: 'superwhisper:rec-1:notes', notes: '## Summary\n- Decided: ship `v1` Friday\n- Owner: Sam\n\nInline ``` mid-line is fine\n' };
const TRANSCRIPT = { space_id: SPACE, title: 'Synthetic sync', recorded_at: '2026-10-16T12:00:00Z', source_id: 'superwhisper:rec-1:transcript', transcript: 'Sam: hello\nAda: hi\n' };

function pageOf(id, space, title, blocks) {
  return { metadata: { page_id: id, url: `https://example.invalid/${id}`, drive_scope: 'space', drive_space_id: space, stream_kind: 'content', deleted_at: null, access: { can_write: true } },
    content: { page_id: id, title, schema_version: 1, blocks: blocks.map((m, i) => ({ id: `${id}_b${i}`, kind: 'markdown', markdown: m, hash: hash(m), metadata: {} })) }, selection: { page_block_count: blocks.length, selection_complete: true } };
}
async function fixture(t) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-notes-tests-'));
  await fs.chmod(stateDir, 0o700);
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const calls = [], pages = new Map(), keys = new Map(), hooks = {};
  const upstream = {
    async callTool(tool, args) {
      calls.push({ tool, args: structuredClone(args) });
      if (hooks[tool]) { const r = await hooks[tool](args); if (r !== undefined) return r; }
      if (tool === 'read_page') {
        const p = pages.get(args.page_id);
        return { structuredContent: p ? structuredClone(p) : { error: { code: 'not_found', message: 'missing' } } };
      }
      if (tool === 'create_page') {
        let p = keys.get(args.idempotency_key);
        if (!p) { p = pageOf(`page_${keys.size + 1}`, args.space_id, args.title, args.initial_blocks); keys.set(args.idempotency_key, p); pages.set(p.metadata.page_id, p); }
        return { structuredContent: structuredClone(p) };
      }
      return { structuredContent: { items: [] } };
    },
    async inventory() { return { ok: true }; },
  };
  const bridge = createBridge({ upstream, stateDir, env: { BRIDGE_ALLOWED_SPACE_IDS: SPACE } });
  const call = async (name, args) => (await bridge.callTool(name, args)).structuredContent;
  return { stateDir, calls, pages, keys, hooks, bridge, call, creates: () => calls.filter((c) => c.tool === 'create_page') };
}
const errorIs = (r, code) => { assert.equal(r.ok, false); assert.equal(r.error.code, code); };

test('one source_id cannot be saved as both notes and transcript; distinct artifact IDs coexist', async (t) => {
  for (const order of [['notes', 'transcript'], ['transcript', 'notes']]) {
    const f = await fixture(t);
    const same = 'superwhisper:rec-9';
    const call = (kind) => f.call(kind === 'notes' ? 'save_meeting_notes' : 'save_transcript',
      kind === 'notes' ? { ...NOTES, source_id: same } : { ...TRANSCRIPT, source_id: same, transcript: NOTES.notes, title: NOTES.title });
    assert.equal((await call(order[0])).ok, true);
    errorIs(await call(order[1]), 'source_conflict');
    assert.equal(f.creates().length, 1);
  }
  const f = await fixture(t);
  assert.equal((await f.call('save_meeting_notes', NOTES)).ok, true);
  assert.equal((await f.call('save_transcript', TRANSCRIPT)).ok, true);
  assert.equal(f.creates().length, 2);
});

test('kind is not caller-controlled and tools reject each other\'s argument', async (t) => {
  const f = await fixture(t);
  errorIs(await f.call('save_meeting_notes', { ...NOTES, kind: 'transcript' }), 'invalid_arguments');
  errorIs(await f.call('save_meeting_notes', { ...NOTES, transcript: 'x' }), 'invalid_arguments');
  const { notes, ...rest } = NOTES;
  errorIs(await f.call('save_meeting_notes', { ...rest, transcript: notes }), 'invalid_arguments');
  errorIs(await f.call('save_transcript', { ...TRANSCRIPT, notes: 'x' }), 'invalid_arguments');
  errorIs(await f.call('save_meeting_notes', { ...NOTES, metadata: {} }), 'invalid_arguments');
  assert.equal(f.creates().length, 0);
});

test('transcript fingerprints retain the pre-notes journal identity', () => {
  // Existing journals must remain usable after adding notes as a distinct artifact.
  assert.equal(saveFingerprint(TRANSCRIPT), hash(JSON.stringify([TRANSCRIPT.space_id, TRANSCRIPT.title, TRANSCRIPT.recorded_at, TRANSCRIPT.source_id, TRANSCRIPT.transcript])));
});

test('notes: disallowed Space, size and unsupported fences fail before any write or journal claim', async (t) => {
  const multibyte = '€'.repeat(Math.floor(LIMITS.transcriptBytes / 3) + 1);
  assert.ok(multibyte.length <= LIMITS.transcriptChars && Buffer.byteLength(multibyte) > LIMITS.transcriptBytes);
  for (const [change, code] of [
    [{ space_id: 'space_other' }, 'space_not_allowed'],
    [{ notes: multibyte }, 'notes_too_large'],
    [{ notes: 'x'.repeat(LIMITS.transcriptChars + 1) }, 'invalid_arguments'],
    [{ notes: 'a\n```js\ncode\n```\n' }, 'unsupported_notes_format'],
    [{ notes: '`'.repeat(2000) + '~'.repeat(2000) }, 'unsupported_notes_format'],
    [{ recorded_at: 'yesterday' }, 'invalid_arguments'],
    [{ title: ' padded ' }, 'invalid_arguments'],
  ]) {
    const f = await fixture(t);
    errorIs(await f.call('save_meeting_notes', { ...NOTES, ...change }), code);
    assert.equal(f.creates().length, 0);
    assert.deepEqual(await fs.readdir(f.stateDir), []);
  }
});

test('notes: uncertain create is never replayed, even after a later healthy retry', async (t) => {
  const f = await fixture(t);
  f.hooks.create_page = (args) => {
    const p = pageOf('page_committed', args.space_id, args.title, args.initial_blocks);
    f.keys.set(args.idempotency_key, p); f.pages.set('page_committed', p);
    throw new RpcError('timeout', 'synthetic timeout');
  };
  const first = await f.call('save_meeting_notes', NOTES);
  errorIs(first, 'upstream_timeout'); assert.equal(first.error.commit_status, 'unknown');
  delete f.hooks.create_page;
  errorIs(await f.call('save_meeting_notes', NOTES), 'write_outcome_unknown');
  assert.equal(f.creates().length, 1);
});
