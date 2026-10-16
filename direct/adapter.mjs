#!/usr/bin/env node
// Local stdio MCP adapter: fast direct Spaces read / literal-edit / transcript-save
// through `codex app-server` (mcpServer/tool/call). No model turn, no token reads, no generic proxy.
// Runtime: Node 22+, builtins only. stdout is MCP protocol only; stderr carries sanitized categories.
import { createHash } from 'node:crypto';
import { promises as fs, constants as fsc } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RpcError, createLineClient, mcpDispatch, serveMcp } from './rpc.mjs';

export const VERSION = '0.1.1';
export const UPSTREAM_SERVER = 'codex_apps';
export const UPSTREAM_PREFIX = 'chatgpt_space.';
// The only upstream tools this process can ever call (defense in depth; not a proxy).
export const UPSTREAM_ALLOWLIST = Object.freeze(['read_page', 'find_pages', 'list_spaces', 'list_pages', 'patch_page', 'create_page']);
// Read-only private ChatGPT Meetings tools; exact native names on the same codex_apps server (no chatgpt_space. prefix).
export const MEETINGS_UPSTREAM_ALLOWLIST = Object.freeze(['meetings.find_all', 'meetings.fetch']);
// Fixed internal-name -> native-name map. Callers never supply a server, namespace or tool name.
export const UPSTREAM_TOOL_NAMES = Object.freeze({
  ...Object.fromEntries(UPSTREAM_ALLOWLIST.map((t) => [t, UPSTREAM_PREFIX + t])),
  ...Object.fromEntries(MEETINGS_UPSTREAM_ALLOWLIST.map((t) => [t, t])),
});
const isUpstreamTool = (tool) => typeof tool === 'string' && Object.hasOwn(UPSTREAM_TOOL_NAMES, tool);

export const LIMITS = Object.freeze({
  patchTextChars: 16384, // each of old/new
  transcriptChars: 200_000,
  transcriptBytes: 200_000, // oversized editing reads use the supported full-view fallback
  chunkChars: 4000, // UTF-8 byte budget per transcript fence body; stays below native block splitting
  maxResultBytes: 1_048_576,
  readTimeoutMs: 30_000,
  writeTimeoutMs: 90_000,
  startTimeoutMs: 30_000,
});

export class ToolError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; this.extra = extra; }
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const tmsg = (s, n = 300) => String(s ?? '').slice(0, n);

// ---- tiny JSON-Schema subset validator (advertised schema == enforced schema) ----

const ID = '^[A-Za-z0-9_.:-]{1,256}$';
const PRINTABLE = '^[^\\u0000-\\u001f\\u007f]+$';
const str = (extra = {}) => ({ type: 'string', ...extra });
const optCursor = str({ minLength: 1, maxLength: 20000, pattern: PRINTABLE });
const MEETING_ID = '^[^\\s\\u0000-\\u001f\\u007f]{1,256}$';
const meetingTime = str({ minLength: 20, maxLength: 40 });
const attendees = { type: 'array', minItems: 1, maxItems: 50, items: str({ minLength: 1, maxLength: 320, pattern: PRINTABLE }) };
const MEETINGS_FIRST = 'For explicitly requested ChatGPT Meetings notes: direct read-only call to the signed-in private ChatGPT Meetings tool, no model turn, no event queue. Generic meeting recordings and notes use the separately connected Superwhisper MCP by default. ';
const MEETING_CITE = 'Cite a meeting as the exact id codex://mcp-app/chatgpt-meetings@openai-curated-remote/meetings.open/meeting/<note-id> using the returned note id; keep any HTTPS permalinks separately.';

export const TOOL_DEFS = [
  { name: 'bridge_direct_status', readOnly: true,
    description: 'Report adapter configuration (write allowlist counts, limits) and optionally verify the upstream app-server is reachable. Never returns credentials.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { check_upstream: { type: 'boolean' } } } },
  { name: 'read_page', readOnly: true,
    description: 'Read one Page by exact page_id (content stream). Optionally select blocks by observed block_ids OR literal search strings (needed for pages over ~128 KiB). Returns upstream structuredContent including block ids and hashes.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['page_id'], properties: {
      page_id: str({ pattern: ID }),
      block_ids: { type: 'array', minItems: 1, maxItems: 64, items: str({ minLength: 1, maxLength: 256, pattern: PRINTABLE }) },
      search: { type: 'array', minItems: 1, maxItems: 16, items: str({ minLength: 1, maxLength: 4096 }) } } } },
  { name: 'find_pages', readOnly: true,
    description: 'Search Pages by query text within one explicitly identified Space (space_id is required).',
    inputSchema: { type: 'object', additionalProperties: false, required: ['query', 'space_id'], properties: {
      query: str({ minLength: 1, maxLength: 512 }), space_id: str({ pattern: ID }), cursor: optCursor } } },
  { name: 'list_spaces', readOnly: true,
    description: 'List Drive-backed Spaces available to the signed-in account.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: optCursor } } },
  { name: 'list_pages', readOnly: true,
    description: 'List Pages in one explicitly named Space (space_id is required).',
    inputSchema: { type: 'object', additionalProperties: false, required: ['space_id'], properties: {
      space_id: str({ pattern: ID }), parent_page_id: str({ pattern: ID }), top_level_only: { type: 'boolean' },
      limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: optCursor } } },
  { name: 'meetings_find_all', readOnly: true,
    description: MEETINGS_FIRST + 'List the signed-in user\'s private ChatGPT Meeting notes, filtered ONLY by attendee names/emails, ISO-8601 start_time/end_time (with timezone; both bound meeting start time) and cursor. Find by dates/attendees, then call meetings_fetch with the selected result id as note_id. Topic/title matching is done by you on the returned results; do not send topics as filters. limit is an integer 1-500 (native default 100). ' + MEETING_CITE,
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      attendee_names: attendees, attendee_emails: attendees,
      start_time: meetingTime, end_time: meetingTime,
      limit: { type: 'integer', minimum: 1, maximum: 500 }, cursor: optCursor } } },
  { name: 'meetings_fetch', readOnly: true,
    description: MEETINGS_FIRST + 'Read one private ChatGPT Meeting note (notes, transcript, status, source URLs, returned unchanged) by exactly one selector: note_id (preferred durable id from meetings_find_all) or meeting_id (temporary source-Meeting compatibility id). Pageless notes and unavailable sources are returned as native reports them. ' + MEETING_CITE,
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      note_id: str({ pattern: MEETING_ID }), meeting_id: str({ pattern: MEETING_ID }) } } },
  { name: 'patch_page', readOnly: false, destructive: true,
    description: `Replace one literal text span inside ONE ordinary Markdown block of an existing Page in an allowlisted Space. Provide the block_id and expected_hash from a prior read_page, plus exact old and new text (old must occur exactly once in the block; each <= ${LIMITS.patchTextChars} chars). Rereads the block, verifies the hash and uniqueness, writes with upstream guards, then reads back. Never retried automatically. Requires BRIDGE_ALLOWED_SPACE_IDS.`,
    inputSchema: { type: 'object', additionalProperties: false, required: ['page_id', 'block_id', 'expected_hash', 'old', 'new'], properties: {
      page_id: str({ pattern: ID }), block_id: str({ minLength: 1, maxLength: 256, pattern: PRINTABLE }),
      expected_hash: str({ minLength: 1, maxLength: 256, pattern: PRINTABLE }),
      old: str({ minLength: 1, maxLength: LIMITS.patchTextChars }), new: str({ minLength: 0, maxLength: LIMITS.patchTextChars }) } } },
  { name: 'save_transcript', readOnly: false, destructive: false, idempotent: true,
    description: `Create one new Page holding a verbatim transcript (fenced blocks, no summarization) in an allowlisted Space, with source_id/recorded_at/SHA-256 provenance. Native create_page idempotency key derives from source_id alone (one source, one destination Space); a local private journal enforces identical content/destination on retry, reads back the saved Page, and never recreates a trashed Page. Uncertain outcomes are never retried: the adapter only read-reconciles, otherwise returns write_outcome_unknown for the owner to resolve. For notes/summaries use save_meeting_notes instead. transcript <= ${LIMITS.transcriptBytes} UTF-8 bytes (and chars). Requires BRIDGE_ALLOWED_SPACE_IDS.`,
    inputSchema: { type: 'object', additionalProperties: false, required: ['space_id', 'title', 'recorded_at', 'source_id', 'transcript'], properties: {
      space_id: str({ pattern: ID }), title: str({ minLength: 1, maxLength: 200, pattern: PRINTABLE }),
      recorded_at: str({ minLength: 20, maxLength: 40 }), source_id: str({ minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9_.:@/+=~-]{1,200}$' }),
      transcript: str({ minLength: 1, maxLength: LIMITS.transcriptChars }) } } },
  { name: 'save_meeting_notes', readOnly: false, destructive: false, idempotent: true,
    description: `Preferred Spaces destination for a selected meeting's notes/summary (Superwhisper, or ChatGPT Meetings when requested): create one new Page holding the notes verbatim (fenced blocks), labelled as meeting notes, NOT a transcript, with source_id/recorded_at/SHA-256 provenance. Use save_transcript only for raw transcripts. Same engine as save_transcript: source_id (convention superwhisper:<recordingUUID>:notes, chatgpt-meetings:<noteId>:notes) maps to one destination Space and one artifact kind (reusing it for a transcript is a source_conflict), private journal, readback, and no replay of uncertain outcomes. notes <= ${LIMITS.transcriptBytes} UTF-8 bytes (and chars). Requires BRIDGE_ALLOWED_SPACE_IDS.`,
    inputSchema: { type: 'object', additionalProperties: false, required: ['space_id', 'title', 'recorded_at', 'source_id', 'notes'], properties: {
      space_id: str({ pattern: ID }), title: str({ minLength: 1, maxLength: 200, pattern: PRINTABLE }),
      recorded_at: str({ minLength: 20, maxLength: 40 }), source_id: str({ minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9_.:@/+=~-]{1,200}$' }),
      notes: str({ minLength: 1, maxLength: LIMITS.transcriptChars }) } } },
];

export function validateArgs(schema, args) {
  const bad = (m) => { throw new ToolError('invalid_arguments', m); };
  const check = (s, v, p) => {
    if (s.type === 'string') {
      if (typeof v !== 'string') bad(`${p} must be a string`);
      if (v.length < (s.minLength ?? 0) || v.length > (s.maxLength ?? Infinity)) bad(`${p} length out of bounds`);
      if (s.pattern && !new RegExp(s.pattern, 'u').test(v)) bad(`${p} has unsupported characters`);
      if (v.includes('\u0000')) bad(`${p} contains NUL`);
    } else if (s.type === 'integer') {
      if (!Number.isInteger(v) || v < (s.minimum ?? -Infinity) || v > (s.maximum ?? Infinity)) bad(`${p} must be an integer in range`);
    } else if (s.type === 'boolean') { if (typeof v !== 'boolean') bad(`${p} must be a boolean`); }
    else if (s.type === 'array') {
      if (!Array.isArray(v) || v.length < (s.minItems ?? 0) || v.length > (s.maxItems ?? Infinity)) bad(`${p} must be an array within bounds`);
      v.forEach((x, i) => check(s.items, x, `${p}[${i}]`));
    } else if (s.type === 'object') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) bad(`${p} must be an object`);
      const own = (o, k) => Object.hasOwn(o, k); // never walk the prototype chain ("constructor", "__proto__", ...)
      for (const k of Object.keys(v)) if (!own(s.properties ?? {}, k)) bad(`unexpected property ${k}`);
      for (const k of s.required ?? []) if (!own(v, k)) bad(`missing property ${k}`);
      for (const [k, sub] of Object.entries(s.properties ?? {})) if (own(v, k)) check(sub, v[k], k);
    }
  };
  check(schema, args ?? {}, 'arguments');
  return args ?? {};
}

// ---- helpers (exported for tests) ----

export function parseList(v) {
  const l = String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return l.length ? l : null;
}

export function countOccurrences(hay, needle) { // overlapping, matching upstream uniqueness rule
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) n++;
  return n;
}

export function saveKey(sourceId) { // source-only: the same source can never be saved to a second Space
  return `sbd2.${sha256(sourceId).slice(0, 48)}`;
}

export function saveFingerprint({ space_id, title, recorded_at, source_id, transcript, notes }) {
  // transcript fingerprints are unchanged; notes are kind-separated so one source_id can never alias both.
  return sha256(JSON.stringify(notes === undefined ? [space_id, title, recorded_at, source_id, transcript] : ['notes', space_id, title, recorded_at, source_id, notes]));
}

// Deterministic verbatim chunks: chunks.join('') === text. Soft-cuts after a newline inside the
// window (newline stays at the end of its chunk), otherwise hard-splits. Fence content is exactly
// the chunk text (a chunk ending in "\n" shows a trailing blank line, recording the newline).
export function chunkTranscript(text, max = LIMITS.chunkChars) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    let end = i, used = 0;
    for (const char of text.slice(i)) {
      const bytes = Buffer.byteLength(char, 'utf8');
      if (used + bytes > max) break;
      used += bytes; end += char.length;
    }
    if (end === i) throw new ToolError('transcript_too_large', 'transcript chunk byte budget is too small');
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end - 1);
      if (nl >= i) end = nl + 1;
      else if (/[\ud800-\udbff]/.test(text[end - 1])) end -= 1; // never split a surrogate pair
    }
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

export function fenced(chunk, noun = 'transcript') {
  // Native Pages round-trips three-backtick blocks, including inline backticks.
  // Longer/tilde fences split at blank lines in real large saves. Reject unsafe
  // closing-fence lines before any Page creation rather than corrupt the text.
  if (/(?:^|\n)[ \t]*`{3}/.test(chunk)) throw new ToolError(`unsupported_${noun}_format`, `${noun} contains a backtick fence line; supply plain ${noun} text without Markdown code fences`);
  const fence = '```';
  return `${fence}text\n${chunk}\n${fence}`;
}

export function buildTranscriptBlocks({ recorded_at, source_id, transcript, notes }) {
  const isNotes = notes !== undefined, noun = isNotes ? 'notes' : 'transcript';
  const original = isNotes ? notes : transcript;
  const text = original.replace(/\r\n?/g, '\n');
  return [
    `Recorded at: ${recorded_at}`,
    `Source ID: \`${source_id}\``,
    `${isNotes ? 'Meeting notes (saved notes/summary, not a verbatim transcript)' : 'Verbatim transcript'}. Length ${text.length} characters, SHA-256: \`${sha256(text)}\`` +
      (original !== text ? ` Line endings normalized to LF. Original source SHA-256: \`${sha256(original)}\`.` : ''),
    ...chunkTranscript(text).map((c) => fenced(c, noun)),
  ];
}

// ISO 8601 with explicit timezone and a real calendar date/time (Date.parse alone rolls Feb 30 over).
function meetingTimeMs(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.exec(s);
  const ms = m ? Date.parse(s) : NaN;
  if (!m || Number.isNaN(ms)) return NaN;
  const [y, mo, d, h] = [m[1], m[2], m[3], m[4]].map(Number);
  const day = new Date(Date.UTC(y, mo - 1, d));
  return day.getUTCMonth() === mo - 1 && day.getUTCDate() === d && h < 24 && Number(m[5]) < 60 && Number(m[6]) < 60 ? ms : NaN;
}

function checkRecordedAt(s) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(s) || Number.isNaN(Date.parse(s))) {
    throw new ToolError('invalid_arguments', 'recorded_at must be an ISO 8601 timestamp with timezone, e.g. 2026-10-16T14:30:00Z');
  }
}

// ---- private journal (no transcript content, 0600 files in a 0700 dir) ----

export function createJournal(stateDir) {
  const savesDir = path.join(stateDir, 'saves');
  const patchLog = path.join(stateDir, 'patches.jsonl');
  let ready = null;
  const init = () => (ready ??= (async () => {
    await fs.mkdir(savesDir, { recursive: true, mode: 0o700 });
    for (const d of [stateDir, savesDir]) {
      const st = await fs.stat(d);
      if ((st.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && st.uid !== process.getuid())) {
        throw new ToolError('state_dir_unsafe', 'BRIDGE_STATE_DIR must be owned by the current user with mode 0700');
      }
    }
  })());
  const fileFor = (key) => path.join(savesDir, `${key}.json`);

  async function writeTmp(file, obj) {
    const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    const fh = await fs.open(tmp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL, 0o600);
    try { await fh.writeFile(JSON.stringify(obj)); await fh.sync(); } finally { await fh.close(); }
    return tmp;
  }
  async function syncDir() {
    try { const d = await fs.open(savesDir, 'r'); try { await d.sync(); } finally { await d.close(); } } catch {}
  }
  return {
    init,
    async read(key) {
      await init();
      try { return JSON.parse(await fs.readFile(fileFor(key), 'utf8')); }
      catch (e) { if (e.code === 'ENOENT') return null; throw new ToolError('journal_unreadable', 'save journal entry unreadable; refusing to write'); }
    },
    // Atomic create-if-absent (link fails with EEXIST); returns false if another writer won.
    async createIfAbsent(key, entry) {
      await init();
      const tmp = await writeTmp(fileFor(key), entry);
      try { await fs.link(tmp, fileFor(key)); await syncDir(); return true; }
      catch (e) { if (e.code === 'EEXIST') return false; throw e; }
      finally { await fs.unlink(tmp).catch(() => {}); }
    },
    async replace(key, entry) {
      await init();
      const tmp = await writeTmp(fileFor(key), entry);
      await fs.rename(tmp, fileFor(key));
      await syncDir();
    },
    async appendPatch(rec) {
      await init();
      const fh = await fs.open(patchLog, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_APPEND, 0o600);
      try { await fh.writeFile(JSON.stringify(rec) + '\n'); await fh.sync(); } finally { await fh.close(); }
    },
  };
}

// ---- upstream result unwrapping ----

export function unwrap(res, kind = 'write') {
  if (!res || typeof res !== 'object') throw new ToolError('bad_upstream_result', 'upstream returned no result');
  let sc = res.structuredContent;
  if (!sc) {
    const t = res.content?.find?.((c) => c?.type === 'text')?.text;
    try { sc = t ? JSON.parse(t) : null; } catch { sc = null; }
  }
  if (!sc || typeof sc !== 'object') {
    if (res.isError) {
      const text = res.content?.filter?.(c => c?.type === 'text').map(c => c.text).join('\n');
      throw new ToolError('upstream_error', kind === 'read' && text ? tmsg(text) : 'upstream reported an error',
        kind === 'write' ? { commit_status: 'unknown' } : {});
    }
    throw new ToolError('bad_upstream_result', 'upstream result not structured');
  }
  return sc;
}

function upstreamErrorOf(sc) {
  const e = sc?.error;
  if (!e) return null;
  if (typeof e === 'string') return { code: tmsg(sc.error_code ?? 'upstream_error', 80),
    commit_status: sc.error_data?.commit_status, retryable: sc.error_data?.retryable, message: tmsg(e) };
  return { code: tmsg(e.code ?? 'upstream_error', 80), commit_status: e.commit_status ?? undefined, retryable: e.retryable, message: tmsg(e.message) };
}

// ---- bridge core ----

export function createBridge({ upstream, env = {}, stateDir, log = () => {}, journal } = {}) {
  if (!upstream) throw new Error('upstream required');
  const allowedSpaces = parseList(env.BRIDGE_ALLOWED_SPACE_IDS);
  const allowedPages = parseList(env.BRIDGE_ALLOWED_PAGE_IDS);
  const readMs = Number(env.BRIDGE_READ_TIMEOUT_MS) || LIMITS.readTimeoutMs;
  const writeMs = Number(env.BRIDGE_WRITE_TIMEOUT_MS) || LIMITS.writeTimeoutMs;
  const jr = journal ?? (stateDir ? createJournal(stateDir) : null);

  // Raw upstream call with error classification. Reads get one crash-recovery retry; writes never.
  async function up(tool, args, kind) {
    if (!isUpstreamTool(tool)) throw new ToolError('tool_not_allowed', 'upstream tool not allowlisted');
    const opts = { kind, timeoutMs: kind === 'write' ? writeMs : readMs };
    for (let attempt = 0; ; attempt++) {
      try { return await upstream.callTool(tool, args, opts); }
      catch (e) {
        if (!(e instanceof RpcError)) throw new ToolError('upstream_error', 'upstream call failed', kind === 'write' ? { commit_status: 'unknown' } : {});
        const crashed = e.code === 'exited' || e.code === 'not_running' || e.code === 'protocol';
        if (kind === 'read' && crashed && attempt === 0) { log('read_retry_after_crash'); continue; }
        const unknown = kind === 'write' && e.sent !== false;
        throw new ToolError(e.code === 'owner_interaction_required' ? 'owner_interaction_required' : `upstream_${e.code}`,
          e.code === 'owner_interaction_required' ? 'Upstream asked for owner interaction; nothing was approved.' : tmsg(e.message),
          kind === 'write' ? { commit_status: unknown ? 'unknown' : 'not_committed' } : {});
      }
    }
  }
  const readUp = async (tool, args) => {
    for (let attempt = 0; ; attempt++) {
    const res = await up(tool, args, 'read');
    const sc = unwrap(res, 'read');
    const err = upstreamErrorOf(sc);
    const closedSession = err && /Sheep MCP session closed|RPC INTERNAL|session (?:closed|expired)/i.test(err.message);
    const retryFreshness = err?.code === 'page_freshness_unavailable' && err.retryable === true;
    if (attempt === 0 && (closedSession || retryFreshness)) {
      log('read_retry_after_upstream_session_or_freshness_error');
      if (closedSession) await upstream.close?.();
      await new Promise(resolve => setTimeout(resolve, 150));
      continue;
    }
    if (err || res.isError) {
      const nativeDiagnostic = sc.message ?? res.content?.filter?.(c => c?.type === 'text').map(c => c.text).join('\n');
      throw new ToolError('upstream_error', err?.message ?? (nativeDiagnostic ? tmsg(nativeDiagnostic) : 'upstream error'), { upstream: err });
    }
    return sc;
    }
  };

  function requireWrites() {
    if (!allowedSpaces) throw new ToolError('writes_not_configured', 'BRIDGE_ALLOWED_SPACE_IDS is required for writes');
    if (!jr) throw new ToolError('writes_not_configured', 'BRIDGE_STATE_DIR is required for writes');
  }

  // ---- tool handlers ----
  const handlers = {
    async bridge_direct_status(a) {
      const out = {
        ok: true, version: VERSION, writesEnabled: Boolean(allowedSpaces && jr),
        allowedSpaceIds: allowedSpaces ?? [], allowedPageIdCount: allowedPages ? allowedPages.length : null,
        upstreamTools: [...UPSTREAM_ALLOWLIST], meetingsUpstreamTools: [...MEETINGS_UPSTREAM_ALLOWLIST], limits: { ...LIMITS, readTimeoutMs: readMs, writeTimeoutMs: writeMs },
      };
      if (a.check_upstream) {
        try { out.upstream = await upstream.inventory(); } catch (e) { out.upstream = { ok: false, error: e instanceof RpcError ? `upstream_${e.code}` : 'upstream_unavailable' }; }
      }
      return out;
    },

    async read_page(a) {
      if (a.block_ids && a.search) throw new ToolError('invalid_arguments', 'block_ids and search are mutually exclusive');
      const args = { page_id: a.page_id };
      if (a.block_ids) args.block_ids = a.block_ids;
      if (a.search) args.search = a.search;
      const result = await readUp('read_page', args);
      if (result.metadata?.drive_scope !== 'space' || !result.metadata?.drive_space_id || result.metadata?.deleted_at) {
        throw new ToolError('read_scope_not_allowed', 'only current Pages within accessible Spaces may be read');
      }
      return result;
    },
    async find_pages(a) {
      const result = await readUp('find_pages', a);
      return { ...result, items: (result.items ?? []).filter(item => item.drive_scope === 'space' && !item.deleted_at) };
    },
    list_spaces: (a) => readUp('list_spaces', a),
    // Meetings are signed-in private data: no Pages Space-scope filter applies; results pass through unchanged.
    async meetings_find_all(a) {
      const start = a.start_time === undefined ? undefined : meetingTimeMs(a.start_time);
      const end = a.end_time === undefined ? undefined : meetingTimeMs(a.end_time);
      if (Number.isNaN(start) || Number.isNaN(end)) throw new ToolError('invalid_arguments', 'start_time/end_time must be ISO 8601 timestamps with timezone, e.g. 2026-10-16T14:30:00Z');
      if (start !== undefined && end !== undefined && start > end) throw new ToolError('invalid_arguments', 'start_time must not be after end_time');
      return readUp('meetings.find_all', a);
    },
    async meetings_fetch(a) {
      if (Object.hasOwn(a, 'note_id') === Object.hasOwn(a, 'meeting_id')) throw new ToolError('invalid_arguments', 'provide exactly one of note_id (preferred) or meeting_id');
      return readUp('meetings.fetch', a);
    },
    async list_pages(a) {
      const result = await readUp('list_pages', a);
      return { ...result, items: (result.items ?? []).filter(item => item.drive_scope === 'space' && !item.deleted_at) };
    },

    async patch_page(a) {
      requireWrites();
      if (a.old === a.new) throw new ToolError('invalid_arguments', 'old and new are identical');
      if (allowedPages && !allowedPages.includes(a.page_id)) throw new ToolError('page_not_allowed', 'page_id is not in BRIDGE_ALLOWED_PAGE_IDS');

      const readBlock = async () => {
        const sc = await readUp('read_page', { page_id: a.page_id, block_ids: [a.block_id] });
        const meta = sc.metadata ?? {};
        const content = sc.content;
        if (!content) throw new ToolError('page_unreadable', 'upstream returned no content');
        if (meta.page_id !== a.page_id || content.page_id !== a.page_id) throw new ToolError('page_mismatch', 'upstream returned a different page');
        if ((meta.stream_kind ?? 'content') !== 'content') throw new ToolError('stream_not_allowed', 'only the content stream may be edited');
        const block = (content.blocks ?? []).find((b) => b.id === a.block_id);
        return { sc, meta, content, block };
      };

      const pre = await readBlock();
      if (!pre.meta.drive_space_id) throw new ToolError('space_membership_unverified', 'read metadata lacks drive_space_id; refusing edit');
      if (pre.meta.drive_scope !== 'space' || !allowedSpaces.includes(pre.meta.drive_space_id)) throw new ToolError('space_not_allowed', 'page is not in an allowlisted Space');
      if (pre.meta.deleted_at) throw new ToolError('page_deleted', 'page is deleted');
      if (pre.meta.access?.can_write === false) throw new ToolError('page_not_writable', 'account cannot write this page');
      const b = pre.block;
      if (!b) throw new ToolError('block_not_found', 'block_id not found in page');
      if (b.kind !== 'markdown') throw new ToolError('block_kind_not_allowed', 'only ordinary markdown blocks may be patched');
      if (b.hash !== a.expected_hash) throw new ToolError('hash_mismatch', 'block changed since it was read; reread and rebuild', { current_hash: b.hash });
      const n = countOccurrences(b.markdown, a.old);
      if (n !== 1) throw new ToolError(n === 0 ? 'old_text_not_found' : 'old_text_ambiguous', `old text occurs ${n} times in the block; it must occur exactly once`);
      const i = b.markdown.indexOf(a.old);
      const expectedMarkdown = b.markdown.slice(0, i) + a.new + b.markdown.slice(i + a.old.length);
      if (!expectedMarkdown.trim()) throw new ToolError('destructive_edit_rejected', 'edit would leave the block empty; block removal is not supported');
      const beforeBlocks = pre.sc.selection?.page_block_count;

      const args = { page_id: a.page_id, stream_kind: 'content',
        changes: [{ block_id: a.block_id, expected_hash: b.hash, replacements: [{ old: a.old, new: a.new }] }] };

      const rec = { t: new Date().toISOString(), tool: 'patch_page', page_id: a.page_id, block_id: a.block_id,
        old_sha256: sha256(a.old), new_sha256: sha256(a.new), hash_before: b.hash };
      await jr.appendPatch({ ...rec, state: 'attempting' });

      // Reconcile helper for uncertain/failed outcomes: read-only, reports, never writes.
      const reconcile = async () => {
        try {
          const post = await readBlock();
          const m = post.block?.markdown;
          return m === expectedMarkdown ? 'edit_present' : post.block?.hash === b.hash ? 'unchanged' : 'block_changed_differently';
        } catch { return 'readback_failed'; }
      };

      let sc;
      try {
        const res = await up('patch_page', args, 'write');
        sc = unwrap(res);
        if (res.isError && !sc.error && !sc.operation_results) throw new ToolError('upstream_error', 'upstream reported an error', { commit_status: 'unknown' });
      } catch (e) {
        const unknown = !(e instanceof ToolError) || e.extra.commit_status !== 'not_committed';
        await jr.appendPatch({ ...rec, state: unknown ? 'unknown' : 'not_committed', code: e.code }).catch(() => {});
        if (unknown && e instanceof ToolError) { e.extra.commit_status = 'unknown'; e.extra.reconciliation = await reconcile(); }
        throw e;
      }
      const uerr = upstreamErrorOf(sc);
      if (uerr) {
        const unknown = uerr.commit_status !== 'not_committed';
        await jr.appendPatch({ ...rec, state: unknown ? 'unknown' : 'not_committed', code: uerr.code }).catch(() => {});
        throw new ToolError(`upstream_${uerr.code}`, uerr.message, { commit_status: uerr.commit_status ?? 'unknown', recovery: sc.error?.recovery?.action,
          ...(unknown ? { reconciliation: await reconcile() } : {}) });
      }
      const r = (sc.operation_results ?? [])[0];
      const applied = r && (r.status ?? 'applied') === 'applied' && !r.ignored_reason && !r.error_code && sc.operation_results.length === 1;
      if (!applied) {
        await jr.appendPatch({ ...rec, state: 'rejected', code: tmsg(r?.error_code ?? r?.ignored_reason ?? 'not_applied', 80) }).catch(() => {});
        throw new ToolError('patch_not_applied', tmsg(r?.rejection_reason ?? sc.recovery?.message ?? 'upstream did not apply the patch'),
          { commit_status: 'not_committed_or_partial', error_code: r?.error_code, ignored_reason: r?.ignored_reason, recovery: sc.recovery?.action,
            reconciliation: await reconcile() });
      }

      const post = await readBlock().catch(() => null);
      const verified = Boolean(post?.block && post.block.markdown === expectedMarkdown && JSON.stringify(post.block.metadata ?? null) === JSON.stringify(b.metadata ?? null));
      const warnings = [];
      const afterBlocks = post?.sc.selection?.page_block_count;
      if (beforeBlocks !== undefined && afterBlocks !== undefined && beforeBlocks !== afterBlocks) warnings.push('page_block_count_changed');
      await jr.appendPatch({ ...rec, state: verified ? 'verified' : 'applied_unverified', hash_after: post?.block?.hash }).catch(() => {});
      if (!verified) throw new ToolError('readback_mismatch', 'patch reported applied but readback does not match the expected block; do not retry blindly', { commit_status: 'committed', new_sequence: sc.new_sequence });
      return { ok: true, verified: true, page_id: a.page_id, block_id: a.block_id, hash_before: b.hash, hash_after: post.block.hash,
        new_sequence: sc.new_sequence, space_id: pre.meta.drive_space_id, warnings };
    },

    save_transcript: (a) => saveContent(a, 'transcript'),
    save_meeting_notes: (a) => saveContent(a, 'notes'),
  };

  // Shared private write engine; kind is fixed by the handler and is never a caller argument.
  async function saveContent(a, kind) {
      const noun = kind, text = a[noun];
      requireWrites();
      checkRecordedAt(a.recorded_at);
      if (a.title !== a.title.trim()) throw new ToolError('invalid_arguments', 'title must not have leading/trailing whitespace');
      if (!allowedSpaces.includes(a.space_id)) throw new ToolError('space_not_allowed', 'space_id is not in BRIDGE_ALLOWED_SPACE_IDS');
      if (Buffer.byteLength(text, 'utf8') > LIMITS.transcriptBytes) throw new ToolError(`${noun}_too_large`, `${noun} exceeds ${LIMITS.transcriptBytes} UTF-8 bytes`);
      const key = saveKey(a.source_id);
      const fingerprint = saveFingerprint({ ...a, [noun]: text });
      const blocks = buildTranscriptBlocks({ ...a, [noun]: text });
      if (blocks.length > 100) throw new ToolError(`${noun}_too_large`, `${noun} exceeds the 100 block create limit`);
      if (blocks.some(block => Buffer.byteLength(block, 'utf8') > 7000)) throw new ToolError(`${noun}_too_large`, `a formatted ${noun} block exceeds the safe native block budget`);
      if (Buffer.byteLength(JSON.stringify({ title: a.title, initial_blocks: blocks }), 'utf8') > 240_000) {
        throw new ToolError(`${noun}_too_large`, `encoded ${noun} exceeds the safe Page creation budget`);
      }

      const now = () => new Date().toISOString();
      const summary = (e, extra = {}) => ({ ok: true, page_id: e.pageId, url: e.url, space_id: a.space_id, idempotency_key: key, blocks: blocks.length, lineEndingsNormalized: /\r/.test(text), ...(kind === 'notes' ? { kind } : {}), ...extra });
      const pendingFreshness = (v, entry) => v.detail === 'page_freshness_unavailable' && entry.creationReceiptMatches === true;
      const pendingSummary = entry => summary(entry, { status: 'saved_verification_pending', saved: true, verified: false,
        verification: 'Pages has acknowledged the exact saved content; independent readback is temporarily unavailable. Retry the same source and arguments to verify without creating another Page.' });

      // Read-only verification of a saved page against the expected blocks. Never writes.
      // Plain read first; only if the page is too big for one read, fall back to journaled block ids.
      const verifySaved = async (entry) => {
        let sc;
        if (entry.blockIds?.length === blocks.length && Buffer.byteLength(JSON.stringify(blocks), 'utf8') > 60000) {
          const byId = new Map(); let meta, content;
          for (let i = 0; i < entry.blockIds.length; i += 16) {
            try { sc = await readUp('read_page', { page_id: entry.pageId, block_ids: entry.blockIds.slice(i, i + 16) }); }
            catch (e) { return { ok: false, reason: 'readback_failed', detail: e.extra?.upstream?.code }; }
            meta = sc.metadata; content = sc.content;
            if (meta?.page_id !== entry.pageId || meta?.drive_space_id !== a.space_id || meta?.deleted_at) return { ok: false, reason: 'unexpected_space_or_unavailable' };
            for (const bl of content?.blocks ?? []) byId.set(bl.id, bl.markdown);
          }
          sc = { metadata: meta, content: { ...content, blocks: entry.blockIds.map(id => ({ id, markdown: byId.get(id) })) } };
        }
        if (!sc) {
        try { sc = await readUp('read_page', { page_id: entry.pageId }); }
        catch (e) {
          const upCode = e.extra?.upstream?.code;
          let full = null, fullError;
          if (upCode === 'page_read_selection_required') {
            try { full = await readUp('read_page', { page_id: entry.pageId, view: 'full' }); }
            catch (error) { fullError = error; }
          }
          if (full) sc = full;
          else if (upCode === 'page_read_selection_required' && entry.blockIds?.length === blocks.length) {
            const byId = new Map(); let meta, content;
            for (let i = 0; i < entry.blockIds.length; i += 32) {
              try { sc = await readUp('read_page', { page_id: entry.pageId, block_ids: entry.blockIds.slice(i, i + 32) }); }
              catch (e2) { return { ok: false, reason: 'readback_failed', detail: e2.extra?.upstream?.code }; }
              meta = sc.metadata; content = sc.content;
              for (const bl of content?.blocks ?? []) byId.set(bl.id, bl.markdown);
            }
            sc = { metadata: meta, content: { ...content, blocks: entry.blockIds.map((id) => ({ id, markdown: byId.get(id) })) } };
          } else return { ok: false, reason: fullError ? 'readback_failed' : (upCode === 'page_read_selection_required' ? 'page_too_large_to_verify' : (e.code === 'upstream_error' ? 'saved_page_unavailable' : e.code)), detail: fullError?.extra?.upstream?.code ?? upCode };
        }
        }
        const meta = sc.metadata ?? {}, content = sc.content ?? {};
        if (meta.page_id !== entry.pageId) return { ok: false, reason: 'page_mismatch' };
        if (meta.deleted_at) return { ok: false, reason: 'saved_page_trashed' };
        if (content.title !== a.title) return { ok: false, reason: 'title_mismatch' };
        if (meta.drive_space_id !== a.space_id) return { ok: false, reason: 'unexpected_space', space_id: meta.drive_space_id ?? null };
        const got = content.blocks ?? [];
        if (got.length !== blocks.length) return { ok: false, reason: 'block_count_mismatch', expected: blocks.length, actual: got.length };
        for (let i = 0; i < blocks.length; i++) if (got[i].markdown !== blocks[i]) return { ok: false, reason: 'content_mismatch', block_index: i };
        return { ok: true, blockIds: got.map((x) => x.id) };
      };
      const unavailable = (v, entry) => new ToolError(v.reason === 'saved_page_trashed' || v.reason === 'saved_page_unavailable' ? 'saved_page_unavailable_no_recreate' : 'readback_mismatch',
        'previously saved page is unavailable or differs; not recreating', { page_id: entry.pageId, ...v });

      let entry = await jr.read(key);
      if (entry) {
        if (entry.fingerprint !== fingerprint) throw new ToolError('source_conflict', 'this source_id was already submitted with different content, title, timestamp or destination Space; refusing');
        if (entry.pageId && ['verified', 'created'].includes(entry.state)) {
          const v = await verifySaved(entry);
          if (pendingFreshness(v, entry)) return pendingSummary(entry);
          if (!v.ok) throw unavailable(v, entry);
          if (entry.state !== 'verified') await jr.replace(key, { ...entry, state: 'verified', blockIds: v.blockIds, updatedAt: now() });
          return summary(entry, { status: 'already_saved', verified: true });
        }
        if (entry.state === 'attempting' || entry.state === 'unknown') {
          // Possible earlier commit. Read-only reconcile: look for a matching saved Page; never write.
          let adopted = null;
          try {
            const found = await readUp('find_pages', { query: a.source_id, space_id: a.space_id });
            for (const it of (found.items ?? []).filter((x) => x.page_id && !x.deleted_at && x.title === a.title).slice(0, 5)) {
              const v = await verifySaved({ pageId: it.page_id });
              if (v.ok) { adopted = { ...entry, state: 'verified', pageId: it.page_id, url: it.url, blockIds: v.blockIds, updatedAt: now() }; break; }
            }
          } catch {}
          if (!adopted) throw new ToolError('write_outcome_unknown', 'a previous save attempt for this source may or may not have committed and no matching saved Page was found; owner must inspect the Space (to permit a fresh attempt after confirming nothing exists, delete this source\'s journal entry)', { idempotency_key: key, commit_status: 'unknown' });
          await jr.replace(key, adopted);
          return summary(adopted, { status: 'already_saved', verified: true, reconciled: true });
        }
        if (entry.state !== 'not_committed') throw new ToolError('saved_page_needs_owner_review', 'a Page exists for this source in an unexpected state; not recreating', { page_id: entry.pageId, state: entry.state, commit_status: 'committed' });
        // state not_committed: definitively nothing was written; attempt again with the same native key
        await jr.replace(key, { ...entry, state: 'attempting', updatedAt: now() });
      } else {
        entry = { version: 2, idempotencyKey: key, spaceId: a.space_id, sourceIdSha256: sha256(a.source_id), titleSha256: sha256(a.title), [`${noun}Sha256`]: sha256(text), kind,
          fingerprint, state: 'attempting', createdAt: now(), updatedAt: now() };
        if (!(await jr.createIfAbsent(key, entry))) throw new ToolError('write_in_progress', 'another save for this source is already recorded; retry later');
      }

      let sc;
      try {
        const res = await up('create_page', { title: a.title, space_id: a.space_id, idempotency_key: key, initial_blocks: blocks }, 'write');
        sc = unwrap(res);
        if (res.isError && !sc.error && !sc.metadata && !sc.content) throw new ToolError('upstream_error', 'upstream reported an error', { commit_status: 'unknown' });
      } catch (e) {
        const unknown = !(e instanceof ToolError) || e.extra.commit_status !== 'not_committed';
        await jr.replace(key, { ...entry, state: unknown ? 'unknown' : 'not_committed', lastError: e.code, updatedAt: now() }).catch(() => {});
        throw e;
      }
      const uerr = upstreamErrorOf(sc);
      if (uerr) {
        const unknown = uerr.commit_status !== 'not_committed';
        await jr.replace(key, { ...entry, state: unknown ? 'unknown' : 'not_committed', lastError: uerr.code, updatedAt: now() }).catch(() => {});
        throw new ToolError(`upstream_${uerr.code}`, uerr.message, { commit_status: uerr.commit_status ?? 'unknown', retryable: uerr.retryable });
      }
      const pageId = sc.metadata?.page_id ?? sc.content?.page_id;
      if (!pageId) {
        await jr.replace(key, { ...entry, state: 'unknown', lastError: 'no_page_id', updatedAt: now() }).catch(() => {});
        throw new ToolError('write_outcome_unknown', 'create_page returned no page id', { commit_status: 'unknown' });
      }
      // Block ids only as a fallback for pages too big for one read; verification itself is a real read.
      const receiptBlocks = sc.content?.blocks ?? [];
      const creationReceiptMatches = sc.metadata?.drive_space_id === a.space_id && sc.content?.page_id === pageId &&
        sc.content?.title === a.title && receiptBlocks.length === blocks.length && receiptBlocks.every((b, i) => b.markdown === blocks[i]);
      entry = { ...entry, state: 'created', pageId, url: sc.metadata?.url, blockIds: receiptBlocks.map((x) => x.id), creationReceiptMatches, updatedAt: now() };
      await jr.replace(key, entry);
      const v = await verifySaved(entry);
      if (pendingFreshness(v, entry)) return pendingSummary(entry);
      if (!v.ok) {
        if (v.reason === 'unexpected_space') await jr.replace(key, { ...entry, state: 'created_unexpected_space', updatedAt: now() }).catch(() => {});
        throw new ToolError(v.reason === 'unexpected_space' ? 'unexpected_space' : 'readback_mismatch', 'page was created but readback did not verify; do not retry blindly', { page_id: pageId, url: entry.url, commit_status: 'committed', ...v });
      }
      entry = { ...entry, state: 'verified', blockIds: v.blockIds, updatedAt: now() };
      await jr.replace(key, entry);
      return summary(entry, { status: 'created', verified: true });
  }

  // ---- MCP surface ----
  const tools = TOOL_DEFS.map((d) => ({
    name: d.name, description: (d.name.startsWith('meetings_') || d.name === 'save_meeting_notes' ? '' : 'Preferred default fast route for ChatGPT Spaces requests; no model turn or event queue. ') + d.description, inputSchema: d.inputSchema,
    annotations: { readOnlyHint: Boolean(d.readOnly), destructiveHint: Boolean(d.destructive), idempotentHint: Boolean(d.idempotent), openWorldHint: false },
  }));

  let chain = Promise.resolve(); // serialize every tool call
  function callTool(name, args) {
    const def = TOOL_DEFS.find((d) => d.name === name);
    if (!def) return Promise.reject(Object.assign(new Error(`Unknown tool: ${name}`), { rpcCode: -32602 }));
    const run = async () => {
      const t0 = Date.now();
      try {
        validateArgs(def.inputSchema, args);
        const out = await handlers[name](args ?? {});
        const text = JSON.stringify(out);
        if (Buffer.byteLength(text, 'utf8') > LIMITS.maxResultBytes) throw new ToolError('result_too_large',
          name.startsWith('meetings_') ? 'Meeting result exceeds the 1 MiB limit; native fetch has no transcript selection or pagination. Narrow meeting lists when possible; no content was returned.'
            : 'result too large; use read_page block_ids/search or smaller pages');
        log(`tool_ok:${name}:${Date.now() - t0}ms`);
        return { content: [{ type: 'text', text }], structuredContent: out };
      } catch (e) {
        const te = e instanceof ToolError ? e : new ToolError('internal_error', 'unexpected adapter error');
        log(`tool_error:${name}:${te.code}`);
        const body = { ok: false, error: { code: te.code, message: te.message, ...te.extra } };
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body };
      }
    };
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    return p;
  }

  const serverInfo = { name: 'spaces-context-bridge-direct', version: VERSION };
  const instructions = 'Direct Spaces read/edit/save and read-only ChatGPT Meetings (meetings_find_all, then meetings_fetch by note_id) via the local Codex app-server; no model turn or event queue. Writes require an allowlisted Space. Write outcomes marked unknown must be reconciled, not replayed.';
  const handleJsonRpc = (msg) => mcpDispatch(msg, { serverInfo, instructions, listTools: () => tools, callTool });
  return { tools, listTools: () => tools, callTool, handleJsonRpc, handlers, close: () => upstream.close?.() };
}

// ---- real upstream: persistent `codex app-server --listen stdio://` ----

export function createCodexUpstream({ codexBin = 'codex', env = process.env, spawn, startTimeoutMs = LIMITS.startTimeoutMs, log = () => {}, tmpRoot = os.tmpdir() } = {}) {
  let client = null;
  let threadId = null;
  let cwd = null;
  let restarts = 0;
  const environmentKeys = new Set(['PATH', 'HOME', 'CODEX_HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR']);
  const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => environmentKeys.has(key)));

  async function reset() {
    const c = client; client = null; threadId = null;
    await c?.kill();
    if (cwd) { await fs.rm(cwd, { recursive: true, force: true }).catch(() => {}); cwd = null; }
  }

  async function ensure() {
    if (client?.alive && threadId) return;
    await reset();
    cwd = await fs.mkdtemp(path.join(tmpRoot, 'bridge-direct-'));
    await fs.chmod(cwd, 0o700);
    client = createLineClient({ command: codexBin, args: ['app-server', '--listen', 'stdio://'], env: childEnv, cwd, spawn, log });
    try {
      client.start();
      await client.request('initialize', { clientInfo: { name: 'spaces-context-bridge-direct', version: VERSION }, capabilities: { explicitGatewayOauth: true } }, startTimeoutMs);
      client.notify('initialized');
      const t = await client.request('thread/start', { ephemeral: true, cwd, sandbox: 'read-only', approvalPolicy: 'on-request' }, startTimeoutMs);
      threadId = t?.thread?.id;
      if (!threadId || t.thread.ephemeral !== true) throw new RpcError('protocol', 'ephemeral thread unavailable', { sent: false });
      restarts++;
      log('upstream_ready');
    } catch (e) {
      await reset();
      if (e instanceof RpcError) e.sent = false; // nothing user-visible was sent yet
      throw e;
    }
  }

  return {
    async callTool(tool, args, { timeoutMs } = {}) {
      if (!isUpstreamTool(tool)) throw new RpcError('protocol', 'tool not allowlisted', { sent: false });
      await ensure();
      try {
        return await client.request('mcpServer/tool/call', { threadId, server: UPSTREAM_SERVER, tool: UPSTREAM_TOOL_NAMES[tool], arguments: args }, timeoutMs ?? LIMITS.readTimeoutMs);
      } catch (e) {
        // After any transport-level failure the process state is unknown: restart fresh next call.
        if (e instanceof RpcError) await reset();
        throw e;
      }
    },
    async inventory() {
      await ensure();
      const r = await client.request('mcpServerStatus/list', { threadId, serverName: UPSTREAM_SERVER, detail: 'toolsAndAuthOnly' }, LIMITS.readTimeoutMs);
      const srv = (r?.data ?? []).find((s) => s.name === UPSTREAM_SERVER);
      const names = Object.keys(srv?.tools ?? {});
      return { ok: true, authStatus: srv?.authStatus, restarts, tools: Object.fromEntries(Object.entries(UPSTREAM_TOOL_NAMES).map(([t, native]) => [t, names.includes(native)])) };
    },
    close: reset,
  };
}

// ---- entrypoint ----

export async function main({ env = process.env, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
  const log = (cat) => { try { stderr.write(`[direct-adapter] ${cat}\n`); } catch {} };
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) { log('node_22_required'); process.exitCode = 1; return; }
  const stateDir = env.BRIDGE_STATE_DIR;
  const upstream = createCodexUpstream({ codexBin: env.BRIDGE_CODEX_BIN || 'codex', env, log });
  const bridge = createBridge({ upstream, env, stateDir, log });
  const quit = async () => { await bridge.close(); process.exit(0); };
  process.on('SIGINT', quit); process.on('SIGTERM', quit);
  process.on('exit', () => { try { upstream.close(); } catch {} });
  log('ready');
  await serveMcp({
    input: stdin, output: stdout,
    dispatch: bridge.handleJsonRpc,
  });
  await bridge.close();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(() => { process.stderr.write('[direct-adapter] fatal\n'); process.exit(1); });
}
