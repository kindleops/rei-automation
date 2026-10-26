// Streamable HTTP transport (loopback only), FIXTURE data. Raw node:http requests control the
// Host / Origin / Authorization headers exactly; the official SDK Client exercises the protocol.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.mjs'
import { loadConfig } from '../src/config.mjs'
import { startHttp, bearerMatches } from '../src/protocol/http.mjs'
import { FIXTURE, FIXTURE_NOW } from '../fixtures/dataset.mjs'
import { fixtureEnv } from './helpers.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-mcp-http-'))
const TOKEN = crypto.randomBytes(32).toString('base64url')
const TOKEN_FILE = path.join(DIR, 'token')
fs.writeFileSync(TOKEN_FILE, `${TOKEN}\n`, { mode: 0o600 })
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }))

const httpEnv = (over = {}) => fixtureEnv({ LEADCOMMAND_MCP_TRANSPORT: 'streamable-http', LEADCOMMAND_MCP_HTTP_BIND: '127.0.0.1', LEADCOMMAND_MCP_HTTP_PORT: '0', LEADCOMMAND_MCP_HTTP_TOKEN_FILE: TOKEN_FILE, ...over })

async function serve({ env = httpEnv(), faults = {} } = {}) {
  const audit = []
  const events = []
  const app = await buildApp({ env, fixture: FIXTURE, faults, auditSink: (r) => (r.event === 'tool_call' ? audit : events).push(r), now: () => FIXTURE_NOW })
  const listener = await startHttp({ app })
  return { app, listener, audit, events, async close() { await listener.close(); await app.close() } }
}

/** Raw request with full header control (fetch cannot set Host). */
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
const bearer = (t = TOKEN) => ({ authorization: `Bearer ${t}` })

async function client(url, token = TOKEN) {
  const c = new Client({ name: 'http-test', version: '1.0.0' })
  const t = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } })
  await c.connect(t)
  return { c, t }
}

test('http auth: 401 without a token, with a wrong token, with a non-Bearer scheme; the token never appears in logs or bodies', async () => {
  const s = await serve()
  try {
    const none = await raw(s.listener.port, { body: INIT })
    assert.equal(none.status, 401)
    assert.match(none.headers['www-authenticate'], /^Bearer realm="leadcommand-mcp"/)
    const wrong = await raw(s.listener.port, { body: INIT, headers: bearer(crypto.randomBytes(32).toString('base64url')) })
    assert.equal(wrong.status, 401)
    const prefix = await raw(s.listener.port, { body: INIT, headers: bearer(TOKEN.slice(0, -1)) })
    assert.equal(prefix.status, 401, 'a prefix of the token is not the token')
    const basic = await raw(s.listener.port, { body: INIT, headers: { authorization: `Basic ${Buffer.from(`x:${TOKEN}`).toString('base64')}` } })
    assert.equal(basic.status, 401)
    const raw2 = await raw(s.listener.port, { body: INIT, headers: { authorization: TOKEN } })
    assert.equal(raw2.status, 401, 'the bare token without the Bearer scheme is refused')
    const ok = await raw(s.listener.port, { body: INIT, headers: bearer() })
    assert.equal(ok.status, 200)
    assert.ok(ok.headers['mcp-session-id'])
    for (const r of [none, wrong, prefix, basic, raw2, ok]) assert.equal(r.text.includes(TOKEN), false)
    const logged = JSON.stringify([...s.events, ...s.audit])
    assert.equal(logged.includes(TOKEN), false)
    assert.equal(s.events.filter((e) => e.event === 'http_refused' && e.reason === 'auth').length, 5)
    // constant-time compare helper: right token, wrong token, malformed header
    const d = crypto.createHash('sha256').update(TOKEN).digest()
    assert.equal(bearerMatches(`Bearer ${TOKEN}`, d), true)
    assert.equal(bearerMatches(`Bearer ${TOKEN}x`, d), false)
    assert.equal(bearerMatches(undefined, d), false)
    assert.equal(bearerMatches('Bearer ', d), false)
  } finally { await s.close() }
})

test('http auth: repeated failures are throttled (429) and a valid token still needs to be exact', async () => {
  const s = await serve()
  try {
    const rs = []
    for (let i = 0; i < 32; i++) rs.push((await raw(s.listener.port, { body: INIT, headers: bearer('x'.repeat(40)) })).status)
    assert.equal(rs.filter((x) => x === 401).length, 30)
    assert.deepEqual(rs.slice(30), [429, 429])
  } finally { await s.close() }
})

test('http bind: only 127.0.0.1 / ::1 boot; every other address (wildcard, LAN, public, hostname) refuses to boot', () => {
  for (const bind of ['0.0.0.0', '::', '192.168.1.10', '10.0.0.5', '8.8.8.8', 'localhost', 'example.com', '127.0.0.2', '::ffff:127.0.0.1', '']) {
    if (bind === '') continue // empty → default 127.0.0.1
    assert.throws(() => loadConfig(httpEnv({ LEADCOMMAND_MCP_HTTP_BIND: bind })), /must be 127\.0\.0\.1 or ::1/, bind)
  }
  assert.equal(loadConfig(httpEnv({ LEADCOMMAND_MCP_HTTP_BIND: '' })).http.bind, '127.0.0.1')
  assert.equal(loadConfig(httpEnv({ LEADCOMMAND_MCP_HTTP_BIND: '::1' })).http.bind, '::1')
})

test('http token file: required, regular, 0600, well-formed; only a digest is kept (not enumerable, not in the summary)', () => {
  assert.throws(() => loadConfig(httpEnv({ LEADCOMMAND_MCP_HTTP_TOKEN_FILE: '' })), /TOKEN_FILE is required/)
  const loose = path.join(DIR, 'loose')
  fs.writeFileSync(loose, TOKEN, { mode: 0o644 })
  fs.chmodSync(loose, 0o644)
  assert.throws(() => loadConfig(httpEnv({ LEADCOMMAND_MCP_HTTP_TOKEN_FILE: loose })), /must be mode 0600/)
  const short = path.join(DIR, 'short')
  fs.writeFileSync(short, 'abc', { mode: 0o600 })
  assert.throws(() => loadConfig(httpEnv({ LEADCOMMAND_MCP_HTTP_TOKEN_FILE: short })), /32–512/)
  assert.throws(() => loadConfig(httpEnv({ LEADCOMMAND_MCP_HTTP_TOKEN_FILE: DIR })), /not a regular file/)
  const cfg = loadConfig(httpEnv())
  assert.equal(JSON.stringify(cfg).includes(TOKEN), false)
  assert.equal(Object.keys(cfg.http).includes('tokenDigest'), false)
  assert.equal(cfg.http.tokenDigest().length, 32)
  assert.throws(() => loadConfig(httpEnv({ LEADCOMMAND_MCP_HTTP_ALLOWED_ORIGINS: 'https://evil.example' })), /loopback origins only/)
})

test('http listener: binds loopback only (address re-checked), URL is the loopback literal', async () => {
  const s = await serve()
  try {
    assert.match(s.listener.url, /^http:\/\/127\.0\.0\.1:[0-9]+\/mcp$/)
    const listen = s.events.find((e) => e.event === 'http_listen')
    assert.equal(listen.bind, '127.0.0.1')
    assert.equal(JSON.stringify(listen).includes(TOKEN), false)
  } finally { await s.close() }
})

test('http DNS-rebinding: a foreign or mismatched Host is 403 even with the right token; a foreign Origin is 403; no Origin or an allowlisted one passes', async () => {
  const s = await serve({ env: httpEnv({ LEADCOMMAND_MCP_HTTP_ALLOWED_ORIGINS: 'http://127.0.0.1:5173' }) })
  try {
    const p = s.listener.port
    for (const host of ['evil.example', `evil.example:${p}`, `127.0.0.1:${p + 1}`, `localhost.evil.example:${p}`, `[::1]:${p}`, '127.0.0.1', null]) {
      const r = await raw(p, { body: INIT, headers: bearer(), host })
      // a missing Host is already refused by node:http itself (400, requireHostHeader) before our check
      assert.equal(r.status, host === null ? 400 : 403, `host ${host}`)
      assert.equal(r.headers['mcp-session-id'], undefined)
    }
    for (const origin of ['http://evil.example', 'null', `http://127.0.0.1:${p}.evil.example`, 'https://127.0.0.1:5173']) {
      const r = await raw(p, { body: INIT, headers: { ...bearer(), origin } })
      assert.equal(r.status, 403, `origin ${origin}`)
    }
    assert.equal((await raw(p, { body: INIT, headers: bearer(), host: `localhost:${p}` })).status, 200)
    assert.equal((await raw(p, { body: INIT, headers: { ...bearer(), origin: 'http://127.0.0.1:5173' } })).status, 200)
    // the Host check runs before auth: a rebinding page learns nothing about the token
    assert.equal((await raw(p, { body: INIT, host: 'evil.example' })).status, 403)
    // other paths and query strings
    assert.equal((await raw(p, { body: INIT, headers: bearer(), pathname: '/' })).status, 404)
    assert.equal((await raw(p, { body: INIT, headers: bearer(), pathname: '/mcp?x=1' })).status, 404)
    assert.equal((await raw(p, { method: 'PUT', body: INIT, headers: bearer() })).status, 405)
  } finally { await s.close() }
})

test('http protocol: SDK client over Streamable HTTP — initialize, tools/list (19 read tools), a call, typed scope denial, audit transport', async () => {
  const s = await serve({ env: httpEnv({ LEADCOMMAND_MCP_SCOPES: 'leadcommand.properties.read leadcommand.scores.read leadcommand.market.read' }) })
  const { c } = await client(s.listener.url)
  try {
    assert.equal(c.getServerVersion().name, 'leadcommand-mcp')
    const { tools } = await c.listTools()
    assert.equal(tools.length, 19)
    assert.ok(tools.every((t) => t.annotations.readOnlyHint === true && t.annotations.destructiveHint === false))
    const r = await c.callTool({ name: 'leadcommand_get_property', arguments: { property_id: 'FX1001' } })
    assert.equal(r.isError, false)
    assert.equal(r.structuredContent.data_mode, 'fixture')
    const denied = await c.callTool({ name: 'leadcommand_get_lead_contact_status', arguments: { property_id: 'FX1001' } })
    assert.equal(denied.isError, true)
    assert.equal(denied.structuredContent.error.class, 'forbidden')
    assert.equal(denied.structuredContent.error.code, 'SCOPE_NOT_GRANTED')
    const forged = await c.callTool({ name: 'leadcommand_get_property', arguments: { property_id: 'FX1001', org_id: '00000000-0000-4000-8000-000000000999' } })
    assert.equal(forged.structuredContent.error.code, 'FORGED_CONTEXT')
    assert.deepEqual(s.audit.map((a) => [a.tool, a.outcome, a.transport]), [
      ['leadcommand_get_property', 'ok', 'streamable-http'],
      ['leadcommand_get_lead_contact_status', 'refused', 'streamable-http'],
      ['leadcommand_get_property', 'refused', 'streamable-http'],
    ])
    assert.ok(s.audit.every((a) => /^#[0-9a-f]{12}$/.test(a.principal)), 'principal hashed, from host config')
  } finally { await c.close(); await s.close() }
})

test('http concurrency: per-connection cap refuses the excess (SESSION_CONCURRENCY_LIMIT) while another connection still runs; session count is capped', async () => {
  const s = await serve({ env: httpEnv({ LEADCOMMAND_MCP_HTTP_SESSION_CONCURRENCY: '2', LEADCOMMAND_MCP_MAX_CONCURRENCY: '4', LEADCOMMAND_MCP_HTTP_MAX_SESSIONS: '2' }), faults: { delayMs: 150 } })
  const a = await client(s.listener.url)
  const b = await client(s.listener.url)
  try {
    const q = { name: 'leadcommand_get_property', arguments: { property_id: 'FX1001' } }
    const [ra, rb] = await Promise.all([
      Promise.all(Array.from({ length: 5 }, () => a.c.callTool(q))),
      Promise.all(Array.from({ length: 2 }, () => b.c.callTool(q))),
    ])
    assert.equal(ra.filter((r) => !r.isError).length, 2)
    assert.equal(ra.filter((r) => r.structuredContent?.error?.code === 'SESSION_CONCURRENCY_LIMIT').length, 3)
    assert.ok(rb.every((r) => !r.isError), 'the other connection is unaffected')
    assert.equal(s.app.gateway.inFlight, 0)
    assert.equal(s.audit.filter((x) => x.error_code === 'SESSION_CONCURRENCY_LIMIT' && x.outcome === 'refused').length, 3)
  } finally { await a.c.close(); await b.c.close(); await s.close() }
})

test('http session cap: at the bound the least-recently-used IDLE session is evicted (it then gets 404); when every session is busy the new one is refused (503)', async () => {
  const s = await serve({ env: httpEnv({ LEADCOMMAND_MCP_HTTP_MAX_SESSIONS: '2' }), faults: { delayMs: 400 } })
  try {
    const p = s.listener.port
    const open = async () => (await raw(p, { body: INIT, headers: bearer() })).headers['mcp-session-id']
    const list = (sid) => raw(p, { body: { jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }, headers: { ...bearer(), 'mcp-session-id': sid, 'mcp-protocol-version': '2025-06-18' } })
    const s1 = await open()
    await new Promise((r) => setTimeout(r, 5))
    const s2 = await open()
    assert.equal((await list(s1)).status, 200) // s1 is now the most recently used
    const s3 = await open()
    assert.ok(s3)
    assert.equal(s.listener.sessions(), 2)
    assert.equal((await list(s2)).status, 404, 'LRU idle session (s2) was evicted')
    assert.equal((await list(s1)).status, 200)
    assert.ok(s.events.some((e) => e.event === 'http_session_closed' && e.reason === 'evicted_lru'))
    // both remaining sessions busy (a slow call in flight on each) → a new session is refused
    const callOn = (sid) => raw(p, { body: { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'leadcommand_get_property', arguments: { property_id: 'FX1001' } } }, headers: { ...bearer(), 'mcp-session-id': sid, 'mcp-protocol-version': '2025-06-18' } })
    const busy = [callOn(s1), callOn(s3)]
    await new Promise((r) => setTimeout(r, 100))
    assert.equal((await raw(p, { body: INIT, headers: bearer() })).status, 503)
    const done = await Promise.all(busy)
    assert.ok(done.every((r) => r.status === 200))
  } finally { await s.close() }
})

test('http sessions: unknown session → 404, no session on a non-initialize → 400, DELETE ends the session, oversized body → 413', async () => {
  const s = await serve()
  try {
    const p = s.listener.port
    const list = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }
    assert.equal((await raw(p, { body: list, headers: { ...bearer(), 'mcp-session-id': crypto.randomUUID(), 'mcp-protocol-version': '2025-06-18' } })).status, 404)
    assert.equal((await raw(p, { body: list, headers: bearer() })).status, 400)
    const init = await raw(p, { body: INIT, headers: bearer() })
    const sid = init.headers['mcp-session-id']
    assert.equal(s.listener.sessions(), 1)
    const ok = await raw(p, { body: list, headers: { ...bearer(), 'mcp-session-id': sid, 'mcp-protocol-version': '2025-06-18' } })
    assert.equal(ok.status, 200)
    assert.equal(JSON.parse(ok.text).result.tools.length, 19)
    // the session id is not a credential
    assert.equal((await raw(p, { body: list, headers: { 'mcp-session-id': sid, 'mcp-protocol-version': '2025-06-18' } })).status, 401)
    assert.equal((await raw(p, { method: 'DELETE', headers: { ...bearer(), 'mcp-session-id': sid, 'mcp-protocol-version': '2025-06-18' } })).status, 200)
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(s.listener.sessions(), 0)
    assert.equal((await raw(p, { body: list, headers: { ...bearer(), 'mcp-session-id': sid, 'mcp-protocol-version': '2025-06-18' } })).status, 404)
    const big = { ...INIT, params: { ...INIT.params, clientInfo: { name: 'x'.repeat(70_000), version: '1' } } }
    assert.equal((await raw(p, { body: big, headers: bearer() })).status, 413)
  } finally { await s.close() }
})

test('http disconnect / recover (real subprocess): kill the server → the client call fails; relaunch → a fresh client is served', async () => {
  const launch = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', path.join(ROOT, 'bin/leadcommand-mcp.mjs')], { cwd: ROOT, env: { PATH: process.env.PATH, ...httpEnv() }, stdio: ['ignore', 'ignore', 'pipe'] })
    let buf = ''
    child.stderr.on('data', (d) => {
      buf += d
      const m = /"event":"http_listen","bind":"127\.0\.0\.1","port":([0-9]+)/.exec(buf)
      if (m) resolve({ child, url: `http://127.0.0.1:${m[1]}/mcp`, stderr: () => buf })
    })
    child.on('exit', (code) => reject(new Error(`server exited ${code}: ${buf.slice(-300)}`)))
  })
  const a = await launch()
  const ca = await client(a.url)
  assert.ok(!(await ca.c.callTool({ name: 'leadcommand_get_market_intelligence', arguments: { zip: '75001' } })).isError)
  a.child.kill('SIGTERM')
  await new Promise((r) => a.child.once('exit', r))
  await assert.rejects(() => ca.c.callTool({ name: 'leadcommand_get_property', arguments: { property_id: 'FX1001' } }))
  await ca.c.close().catch(() => {})
  assert.equal(a.stderr().includes(TOKEN), false, 'token never logged')
  const b = await launch()
  try {
    const cb = await client(b.url)
    assert.ok(!(await cb.c.callTool({ name: 'leadcommand_get_property', arguments: { property_id: 'FX1001' } })).isError)
    await cb.c.close()
  } finally { b.child.kill('SIGTERM'); await new Promise((r) => b.child.once('exit', r)) }
  assert.equal(b.stderr().includes(TOKEN), false)
})

test('stdio path unchanged: stdio boots with no HTTP config and a protocol Server; HTTP-only settings are ignored', async () => {
  const app = await buildApp({ env: fixtureEnv({ LEADCOMMAND_MCP_HTTP_BIND: '0.0.0.0' }), fixture: FIXTURE, auditSink: () => {} })
  try {
    assert.equal(app.cfg.transport, 'stdio')
    assert.equal(app.cfg.http, null)
    assert.ok(app.server)
  } finally { await app.close() }
})
