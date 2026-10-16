// Newline-delimited JSON-RPC plumbing: a persistent child-process client (for
// `codex app-server --listen stdio://`) and a minimal MCP stdio server loop.
// Node builtins only. Nothing here writes to stdout except serveMcp's `output`.
import { spawn as nodeSpawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export class RpcError extends Error {
  // code: timeout | exited | not_running | spawn_failed | protocol | owner_interaction_required | upstream_error
  // sent: true when the request bytes may have reached the peer (so a write may have happened)
  constructor(code, message, { sent = true, rpcCode } = {}) {
    super(message ?? code);
    this.name = 'RpcError';
    this.code = code;
    this.sent = sent;
    this.rpcCode = rpcCode;
  }
}

const OWNER_INTERACTION = { code: -32000, message: 'owner_interaction_required: this adapter never approves upstream requests' };

// Splits a byte stream into newline-terminated JSON messages.
function lineSplitter(maxLineChars, onLine, onOverflow) {
  const decoder = new StringDecoder('utf8');
  let buf = '';
  return (chunk) => {
    buf += decoder.write(chunk);
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.length > maxLineChars) { onOverflow(); continue; } // complete-but-oversized frame: drop just that frame
      if (line.trim()) onLine(line);
    }
    if (buf.length > maxLineChars) { buf = ''; onOverflow(); }
  };
}

export function createLineClient({
  command, args = [], env, cwd, spawn = nodeSpawn,
  maxLineChars = 16 * 1024 * 1024, log = () => {},
}) {
  let child = null;
  let nextId = 0;
  const pending = new Map();
  let alive = false;

  const failAll = (err) => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err); }
    pending.clear();
  };

  const onMessage = (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.method !== undefined && msg.id !== undefined) {
      // Upstream asked us for something (approval, elicitation, ...). Fail closed.
      log(`upstream_request_rejected:${/^[A-Za-z0-9/_.]{1,80}$/.test(String(msg.method)) ? msg.method : 'unprintable'}`); // method name only, never params
      try { child.stdin.write(JSON.stringify({ id: msg.id, error: OWNER_INTERACTION }) + '\n'); } catch {}
      failAll(new RpcError('owner_interaction_required', 'Upstream requested owner interaction; request failed closed', { sent: true }));
      kill();
      return;
    }
    if (msg.method !== undefined) return; // notification: ignored
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new RpcError('upstream_error', String(msg.error.message ?? 'error').slice(0, 300), { rpcCode: msg.error.code }));
    else p.resolve(msg.result);
  };

  function start() {
    if (alive) return;
    child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], env, cwd });
    alive = true;
    const mine = child;
    mine.stdout.on('data', lineSplitter(maxLineChars, onMessage, () => {
      log('upstream_line_overflow');
      failAll(new RpcError('protocol', 'upstream line too large'));
      kill();
    }));
    mine.stdin.on('error', () => {}); // EPIPE surfaces via exit
    mine.on('error', () => { if (child === mine) { alive = false; failAll(new RpcError('spawn_failed', 'could not start upstream', { sent: false })); } });
    mine.on('exit', () => { if (child === mine) { alive = false; log('upstream_exited'); failAll(new RpcError('exited', 'upstream exited')); } });
  }

  function request(method, params, timeoutMs) {
    if (!alive) return Promise.reject(new RpcError('not_running', 'upstream not running', { sent: false }));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new RpcError('timeout', `upstream timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { child.stdin.write(JSON.stringify({ id, method, params }) + '\n'); }
      catch { pending.delete(id); clearTimeout(timer); reject(new RpcError('exited', 'upstream stdin closed', { sent: false })); }
    });
  }

  function notify(method, params) {
    if (alive) try { child.stdin.write(JSON.stringify(params === undefined ? { method } : { method, params }) + '\n'); } catch {}
  }

  function kill() {
    const c = child;
    if (!c || !alive) return Promise.resolve();
    alive = false;
    failAll(new RpcError('exited', 'upstream killed'));
    return new Promise((resolve) => {
      const hard = setTimeout(() => { try { c.kill('SIGKILL'); } catch {} resolve(); }, 3000);
      hard.unref?.();
      c.once('exit', () => { clearTimeout(hard); resolve(); });
      try { c.kill('SIGTERM'); } catch { clearTimeout(hard); resolve(); }
    });
  }

  return { start, request, notify, kill, get alive() { return alive; }, get child() { return child; } };
}

// ---- MCP stdio server -------------------------------------------------------

export const MCP_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const rpcErr = (code, message) => Object.assign(new Error(message), { rpcCode: code });

// Returns the JSON-RPC response for one parsed message (or undefined for notifications).
export async function mcpDispatch(msg, { serverInfo, instructions, listTools, callTool }) {
  const isObj = msg && typeof msg === 'object' && !Array.isArray(msg);
  const id = isObj && (typeof msg.id === 'string' || typeof msg.id === 'number') ? msg.id : undefined;
  if (!isObj || typeof msg.method !== 'string') {
    return { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Invalid Request' } };
  }
  if (id === undefined) return undefined; // notification (initialized, cancelled, ...)
  try {
    let result;
    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params?.protocolVersion;
        result = {
          protocolVersion: MCP_PROTOCOLS.includes(asked) ? asked : MCP_PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo,
          ...(instructions ? { instructions } : {}),
        };
        break;
      }
      case 'ping': result = {}; break;
      case 'tools/list': result = { tools: listTools() }; break;
      case 'tools/call': {
        const p = msg.params;
        if (!p || typeof p.name !== 'string') throw rpcErr(-32602, 'tools/call requires a tool name');
        result = await callTool(p.name, p.arguments ?? {});
        break;
      }
      default: throw rpcErr(-32601, 'Method not found');
    }
    return { jsonrpc: '2.0', id, result };
  } catch (e) {
    const code = typeof e?.rpcCode === 'number' ? e.rpcCode : -32603;
    return { jsonrpc: '2.0', id, error: { code, message: code === -32603 ? 'Internal error' : e.message } };
  }
}

// Reads newline JSON-RPC from `input`, writes responses to `output`. Handlers run
// concurrently (ordering/serialization of tool calls is the caller's job). Resolves
// after input ends and all in-flight requests have answered.
export function serveMcp({ input, output, dispatch, maxLineChars = 8 * 1024 * 1024 }) {
  return new Promise((resolve) => {
    const inflight = new Set();
    const send = (obj) => { try { output.write(JSON.stringify(obj) + '\n'); } catch {} };
    const handle = (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
      const p = Promise.resolve(dispatch(msg)).then((r) => { if (r) send(r); }, () => send({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } }));
      inflight.add(p);
      p.finally(() => inflight.delete(p));
    };
    const onData = lineSplitter(maxLineChars, handle, () => send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request too large' } }));
    input.on('data', onData);
    input.on('end', async () => { while (inflight.size) await Promise.allSettled([...inflight]); resolve(); });
    input.on('error', () => resolve());
  });
}
