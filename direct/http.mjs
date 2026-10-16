import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest();

// Loopback only. Authentication is checked before the adapter is invoked.
export function createLoopbackServer({ token, handleMessage, maxBodyBytes = 524288, maxConcurrent = 8 }) {
  if (typeof token !== 'string' || token.length < 40 || /\s/.test(token)) throw new Error('invalid_local_credential');
  if (typeof handleMessage !== 'function') throw new Error('missing_message_handler');
  const expected = digest(`Bearer ${token}`);
  let active = 0;
  const server = http.createServer(async (req, res) => {
    const reply = (status, body) => {
      if ([401, 403, 413].includes(status)) res.setHeader('Connection', 'close');
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    const port = server.address()?.port;
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host)) return reply(403, { error: 'invalid_host' });
    if (req.headers.origin && ![ `http://127.0.0.1:${port}`, `http://localhost:${port}` ].includes(req.headers.origin)) return reply(403, { error: 'invalid_origin' });
    const supplied = req.headers.authorization;
    if (typeof supplied !== 'string' || supplied.length > 1024 || !timingSafeEqual(digest(supplied), expected)) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="spaces-context-bridge-direct"');
      return reply(401, { error: 'unauthorized' });
    }
    if (req.url !== '/mcp') return reply(404, { error: 'not_found' });
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return reply(405, { error: 'method_not_allowed' }); }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) return reply(415, { error: 'json_required' });
    if (active >= maxConcurrent) return reply(503, { error: 'busy' });
    if (Number(req.headers['content-length'] ?? 0) > maxBodyBytes) return reply(413, { error: 'request_too_large' });
    active++;
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBodyBytes) { reply(413, { error: 'request_too_large' }); return; }
        chunks.push(chunk);
      }
      let message;
      try { message = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return reply(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
      if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' ||
          (Object.hasOwn(message, 'id') && typeof message.id !== 'string' && typeof message.id !== 'number')) {
        return reply(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
      }
      const result = await handleMessage(message);
      if (!Object.hasOwn(message, 'id')) return reply(202);
      if (result === undefined || result === null) return reply(500, { jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Local adapter returned no response' } });
      return reply(200, result);
    } catch {
      if (!res.headersSent) reply(500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Local adapter request failed' } });
    } finally { active--; }
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  return {
    server,
    listen(port = 0) { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(server.address().port); }); }); },
    close() { return new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }); },
  };
}
