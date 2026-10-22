// Streamable HTTP (loopback only, one bearer credential per agent) over a fake gateway. Raw node:http requests
// control Host / Origin / Authorization exactly; the official SDK Client exercises the protocol.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.mjs'
import { startHttp, bearerCredential } from '../src/protocol/http.mjs'
import { baseEnv, fakeGateway, CRED_A, CRED_B } from './helpers.mjs'

const httpEnv = (over = {}) => baseEnv({ LEADCOMMAND_ACTION_MCP_TRANSPORT: 'streamable-http', LEADCOMMAND_ACTION_MCP_HTTP_BIND: '127.0.0.1', LEADCOMMAND_ACTION_MCP_HTTP_PORT: '0', LEADCOMMAND_ACTION_MCP_AGENT_CREDENTIAL_FILE: '', ...over })

async function serve({ env = httpEnv(), gateway = fakeGateway() } = {}) {
  const events = []
  const app = await buildApp({ env, gateway, auditSink: (r) => events.push(r), scrub: false })
  const listener = await startHttp({ app })
  return { app, listener, events, gateway, async close() { await listener.close(); await app.close() } }
}

function raw(port, { method = 'POST', headers = {}, body, host = `127.0.0.1:${port}`, pathname = '/mcp' } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, setHost: false, headers: { ...(host === null ? {} : { host }), 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}), ...headers } }, (res) => {
      let d = ''
      res.on('data', (c) => { d += c })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: d }))
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } }
const auth = (t) => ({ authorization: `Bearer ${t}` })
async function client(url, token) {
  const c = new Client({ name: 'http-test', version: '1.0.0' })
  const t = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } })
  await c.connect(t)
  return { c, t }
}

test('bearerCredential: only an lcag_ credential is a credential', () => {
  assert.equal(bearerCredential(`Bearer ${CRED_A}`), CRED_A)
  for (const h of [undefined, '', 'Bearer', `Basic ${CRED_A}`, 'Bearer eyJhbGciOi.x.y', `Bearer ${CRED_A} extra`]) assert.equal(bearerCredential(h), null, String(h))
})

test('HTTP: Host / Origin / path / method / body refusals; a missing, malformed or unknown credential is 401; failures are throttled; nothing reaches the gateway', async () => {
  const s = await serve()
  try {
    const port = s.listener.port
    assert.equal((await raw(port, { body: INIT, headers: auth(CRED_A), host: 'evil.example.com' })).status, 403)
    assert.equal((await raw(port, { body: INIT, headers: { ...auth(CRED_A), origin: 'https://evil.example.com' } })).status, 403)
    assert.equal((await raw(port, { body: INIT, headers: auth(CRED_A), pathname: '/other' })).status, 404)
    assert.equal((await raw(port, { body: INIT })).status, 401)
    assert.equal((await raw(port, { body: INIT, headers: auth('not-a-credential') })).status, 401)
    assert.equal((await raw(port, { body: INIT, headers: auth(`lcag_${'Q'.repeat(43)}`) })).status, 401, 'well-formed but unknown to the registry')
    assert.equal((await raw(port, { method: 'PUT', body: INIT, headers: auth(CRED_A) })).status, 405)
    assert.equal((await raw(port, { body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers: auth(CRED_A) })).status, 400)
    assert.equal((await raw(port, { body: 'x'.repeat(70_000), headers: auth(CRED_A) })).status, 413)
    let throttled = false
    for (let i = 0; i < 40 && !throttled; i += 1) throttled = (await raw(port, { body: INIT, headers: auth('bad') })).status === 429
    assert.ok(throttled, 'repeated authentication failures are throttled')
    assert.equal(s.gateway.calls.length, 0)
    assert.ok(!JSON.stringify(s.events).includes(CRED_A), 'the credential never reaches an audit line')
  } finally { await s.close() }
})

test('HTTP: a session is BOUND to the credential that opened it; every call carries that credential to the gateway; two agents, two sessions', async () => {
  const s = await serve()
  try {
    const a = await client(s.listener.url, CRED_A)
    const b = await client(s.listener.url, CRED_B)
    const { tools } = await a.c.listTools()
    assert.ok(tools.length >= 22)
    await a.c.callTool({ name: 'create_operator_task', arguments: { client_request_id: 'http-0000001', title: 'from A' } })
    await b.c.callTool({ name: 'create_operator_task', arguments: { client_request_id: 'http-0000002', title: 'from B' } })
    assert.deepEqual(s.gateway.calls.map((c) => [c.credential === CRED_A ? 'A' : c.credential === CRED_B ? 'B' : '?', c.transport]), [['A', 'streamable-http'], ['B', 'streamable-http']])
    // B's credential on A's session: refused
    const sid = a.t.sessionId
    const hijack = await raw(s.listener.port, { body: { jsonrpc: '2.0', id: 9, method: 'tools/list' }, headers: { ...auth(CRED_B), 'mcp-session-id': sid, 'mcp-protocol-version': '2025-06-18' } })
    assert.equal(hijack.status, 401)
    await a.c.close()
    await b.c.close()
  } finally { await s.close() }
})

test('HTTP: refuses a non-loopback bind at boot', async () => {
  await assert.rejects(buildApp({ env: httpEnv({ LEADCOMMAND_ACTION_MCP_HTTP_BIND: '0.0.0.0' }), gateway: fakeGateway(), scrub: false }), /loopback|127\.0\.0\.1/)
})
