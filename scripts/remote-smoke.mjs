#!/usr/bin/env node
// Hosted OAuth/protocol acceptance against a NEW review Worker + D1.
// This does not exercise a ChatGPT event subscription or a Spaces operation.
// Values are read from a protected local file and are never written to stdout.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

const base = process.env.BRIDGE_TEST_ORIGIN;
const resourceName = process.env.BRIDGE_TEST_RESOURCE_NAME;
const codesFile = process.env.BRIDGE_TEST_CODES_FILE;
assert.ok(base && resourceName && codesFile, 'Set BRIDGE_TEST_ORIGIN, BRIDGE_TEST_RESOURCE_NAME and BRIDGE_TEST_CODES_FILE.');
const target = new URL(base);
assert.ok(target.protocol === 'https:' && target.origin === base && !target.username && !target.password, 'Use a bare HTTPS origin.');
assert.match(resourceName, /^spaces-context-bridge-review-[a-z0-9-]+$/, 'Only newly created review resources are allowed.');
assert.ok(target.hostname.startsWith(resourceName + '.'), 'Review resource and origin must match.');
assert.equal(statSync(codesFile).mode & 0o077, 0, 'Connection-code file must not be readable by group or others.');
const codes = Object.fromEntries(readFileSync(codesFile, 'utf8').trim().split('\n').map(line => line.split('=')));
assert.ok(codes.AGENT_CODE && codes.WORKER_CODE && codes.AGENT_CODE !== codes.WORKER_CODE, 'Two separate review codes are required.');
const sha = s => createHash('sha256').update(s).digest('base64url');
const clients = [];
const request = (path, options = {}) => fetch(base + path, { redirect: 'manual', signal: AbortSignal.timeout(20000), ...options });
const rpc = async (token, method, params = {}, modern = false) => {
  const protocolHeaders = modern ? { 'mcp-protocol-version': '2026-07-28', 'mcp-method': method, ...(method === 'tools/call' ? { 'mcp-name': params.name } : {}) } : {};
  const parameters = modern ? { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } : params;
  const response = await request('/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...protocolHeaders, ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: parameters }),
  });
  return { response, data: await response.json() };
};
const call = async (client, name, args = {}) => (await rpc(client.access_token, 'tools/call', { name, arguments: args })).data;
async function connect(role, existingRegistration) {
  const redirect = 'http://127.0.0.1:19876/callback';
  let registration = existingRegistration;
  if (!registration) {
  const response = await request('/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Synthetic review ' + role, redirect_uris: [redirect], token_endpoint_auth_method: 'none' }) });
  assert.equal(response.status, 201, 'DCR must succeed against fresh D1.');
  registration = await response.json();
  }
  const verifier = randomBytes(32).toString('base64url'), state = randomBytes(16).toString('hex');
  const query = new URLSearchParams({ client_id: registration.client_id, redirect_uri: redirect, response_type: 'code', code_challenge_method: 'S256', code_challenge: sha(verifier), scope: role, state, resource: base + '/mcp' });
  const page = await request('/authorize?' + query);
  assert.equal(page.status, 200, 'Consent page must load.');
  const consent = (await page.text()).match(/name="consent" value="([^"]+)"/)?.[1];
  const cookie = page.headers.get('set-cookie')?.split(';')[0];
  assert.ok(consent && cookie, 'Consent needs a per-attempt CSRF cookie.');
  const submit = secret => request('/authorize', { method: 'POST', headers: { origin: base, cookie }, body: new URLSearchParams({ consent, role, secret }) });
  if (!existingRegistration) assert.equal((await submit('synthetic-wrong-code')).status, 403, 'Wrong connection code must fail.');
  const authorized = await submit(role === 'agent' ? codes.AGENT_CODE : codes.WORKER_CODE);
  assert.equal(authorized.status, 302, 'Synthetic owner consent must succeed.');
  const callback = new URL(authorized.headers.get('location'));
  assert.ok(callback.searchParams.get('state') === state, 'OAuth state must survive.');
  const grant = { grant_type: 'authorization_code', client_id: registration.client_id, code: callback.searchParams.get('code'), redirect_uri: redirect, code_verifier: verifier, resource: base + '/mcp' };
  const exchange = body => request('/token', { method: 'POST', body: new URLSearchParams(body) });
  if (!existingRegistration) assert.equal((await exchange({ ...grant, code_verifier: 'x'.repeat(43) })).status, 400, 'Wrong PKCE must fail without consuming the valid grant.');
  const tokens = await exchange(grant);
  assert.equal(tokens.status, 200, 'PKCE exchange must succeed.');
  const client = { client_id: registration.client_id, ...await tokens.json() };
  clients.push(client);
  assert.equal(client.scope, role);
  if (!existingRegistration) assert.equal((await exchange(grant)).status, 400, 'Authorization code must be single use.');
  return client;
}
async function revoke(client) {
  return request('/revoke', { method: 'POST', body: new URLSearchParams({ token: client.access_token, client_id: client.client_id }) });
}

const checks = [];
async function check(name, fn) { await fn(); checks.push(name); console.log('ok  ' + name); }
try {
  await check('hosted discovery and authentication challenge', async () => {
    const metadata = await (await request('/.well-known/oauth-authorization-server')).json();
    assert.equal(metadata.issuer, base);
    assert.ok(metadata.code_challenge_methods_supported.includes('S256'));
    const resource = await (await request('/.well-known/oauth-protected-resource/mcp')).json();
    assert.equal(resource.resource, base + '/mcp');
    const { response } = await rpc(null, 'ping');
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate'), /resource_metadata=/);
  });
  let [agent, worker] = await Promise.all([connect('agent'), connect('worker')]);
  await check('concurrent OAuth, CSRF, PKCE and one-use code exchange on remote D1', async () => assert.ok(agent.access_token && worker.access_token));
  await check('both protocol handshakes and agent tool catalog', async () => {
    const legacy = await rpc(agent.access_token, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'release-review', version: '1' } });
    assert.equal(legacy.data.result.protocolVersion, '2025-11-25');
    const modern = await rpc(agent.access_token, 'server/discover', {}, true);
    assert.ok(modern.data.result.supportedVersions.includes('2026-07-28'));
    const modernList = await rpc(agent.access_token, 'tools/list', {}, true);
    assert.equal(modernList.data.result.resultType, 'complete');
    assert.equal(modernList.data.result.tools.length, 5);
    const list = await rpc(agent.access_token, 'tools/list');
    assert.deepEqual(list.data.result.tools.map(t => t.name).sort(), ['bridge_status', 'get_result', 'lookup_context', 'request_document_edit', 'save_transcript']);
  });
  await check('server-side role boundaries and disconnected-worker refusal', async () => {
    const agentDenied = await call(agent, 'claim_request', { request_id: 'synthetic' });
    const workerDenied = await call(worker, 'lookup_context', { query: 'synthetic', idempotency_key: 'synthetic' });
    assert.ok(agentDenied.error || agentDenied.result?.isError, 'Agent cannot claim requests.');
    assert.ok(workerDenied.error || workerDenied.result?.isError, 'Worker cannot submit requests.');
    const status = (await call(agent, 'bridge_status')).result.structuredContent;
    assert.equal(status.role, 'agent');
    assert.equal(status.worker_connected, false, 'OAuth alone cannot activate the event worker.');
    assert.equal((await call(agent, 'lookup_context', { query: 'synthetic release fact', idempotency_key: 'synthetic-release-lookup' })).result.isError, true);
  });
  await check('foreign Origin is rejected', async () => {
    assert.equal((await request('/mcp', { method: 'POST', headers: { origin: 'https://foreign.example', 'content-type': 'application/json', authorization: 'Bearer ' + agent.access_token }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) })).status, 403);
  });
  await check('remote D1 refresh rotation, replay rejection and revocation', async () => {
    const rounds = Number(process.env.BRIDGE_TEST_LIFECYCLE_ROUNDS || 1);
    assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 10, 'Lifecycle rounds must be 1–10.');
    for (let round = 0; round < rounds; round++) {
    if (round) agent = await connect('agent', agent);
    const refresh = value => request('/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: agent.client_id, refresh_token: value }) });
    const previous = agent.refresh_token;
    const rotated = await refresh(previous);
    assert.equal(rotated.status, 200);
    Object.assign(agent, await rotated.json());
    assert.equal((await refresh(previous)).status, 400);
    assert.equal((await rpc(agent.access_token, 'ping')).response.status, 401, 'Replay must invalidate the newly rotated access token.');
    assert.equal((await refresh(agent.refresh_token)).status, 400);
    console.log('ok  refresh lifecycle round ' + (round + 1));
    }
    // Ordinary revocation is checked separately from replay-triggered revocation.
    assert.equal((await revoke(worker)).status, 200);
    assert.equal((await rpc(worker.access_token, 'ping')).response.status, 401, 'Revocation must invalidate the worker access token.');
    assert.equal((await request('/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: worker.client_id, refresh_token: worker.refresh_token }) })).status, 400);
  });
  console.log(JSON.stringify({ check: 'hosted-oauth-protocol', passed: checks.length, chatgptEventWorkflow: 'not-tested', spacesOperations: 'not-tested' }));
} catch (error) {
  console.error(JSON.stringify({ check: 'hosted-oauth-protocol', failed: true, reason: error.message }));
  process.exitCode = 1;
} finally {
  for (const client of clients) {
    try { await revoke(client); } catch { process.exitCode = 1; }
  }
}
