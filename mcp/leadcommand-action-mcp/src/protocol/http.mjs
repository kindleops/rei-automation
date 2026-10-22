// Streamable HTTP transport — LOOPBACK ONLY, one bearer credential PER AGENT. The same hardened pattern as the
// read-only server (mcp/leadcommand-mcp/src/protocol/http.mjs), with one difference: the bearer token IS the
// agent's credential (lcag_…), verified by the Action Gateway against the principal registry.
//
//   bind        127.0.0.1 or ::1 only (config refuses anything else); re-checked after listen()
//   Host        must name this loopback listener exactly → 403 (DNS-rebinding protection)
//   Origin      absent (non-browser clients) or an exact loopback allowlist entry → 403
//   auth        Authorization: Bearer <agent credential> on EVERY request. Initialize verifies it with the
//               gateway (registry lookup: active, unexpired, in the served tenant, sponsor still a member)
//               → 401 otherwise; repeated failures are throttled (429). A session is BOUND to the credential
//               that opened it (SHA-256 compare, constant time): another bearer on that session → 401. Each
//               tool call is authenticated again by the gateway (a revoked agent stops mid-session). The
//               credential never appears in a log line, an error or a result.
//   limits      a process-wide concurrency gate + a per-session gate; bounded sessions (LRU idle eviction;
//               all busy → 503); idle expiry; body size cap before parsing; header / request timeouts
//   sessions    random UUIDs from the SDK; routing only, never authentication
import http from 'node:http'
import crypto from 'node:crypto'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { createConcurrencyGate, createRateLimiter } from '../../../leadcommand-mcp/src/safety/limits.mjs'
import { AGENT_CREDENTIAL_RE } from '@/lib/domain/action-gateway/credentials.js'

const AUTH_FAIL_PER_MIN = 30

const jsonRpcError = (res, status, code, message, headers = {}) => {
  if (res.headersSent) return
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers })
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }))
}

export function allowedHostsFor(bind, port) {
  const names = bind === '::1' ? ['[::1]', 'localhost'] : ['127.0.0.1', 'localhost']
  return new Set(names.map((n) => `${n}:${port}`))
}

/** The presented agent credential, or null (never throws, never logs the value). */
export function bearerCredential(header) {
  if (typeof header !== 'string') return null
  const m = /^Bearer[ ]+([^\s]{1,512})$/i.exec(header.trim())
  return m && AGENT_CREDENTIAL_RE.test(m[1]) ? m[1] : null
}
const sha = (v) => crypto.createHash('sha256').update(String(v), 'utf8').digest()
const sameCredential = (a, digest) => Boolean(a) && crypto.timingSafeEqual(sha(a), digest)

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > max) return reject(Object.assign(new Error('too large'), { status: 413 }))
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > max) { req.destroy(); reject(Object.assign(new Error('too large'), { status: 413 })) } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** @param {{ app: Awaited<ReturnType<import('../app.mjs').buildApp>> }} deps */
export async function startHttp({ app }) {
  const h = app.cfg.http
  if (!h) throw new Error('startHttp needs LEADCOMMAND_ACTION_MCP_TRANSPORT=streamable-http')
  const auditor = app.auditor
  const authFail = createRateLimiter()
  const processGate = createConcurrencyGate({ max: app.cfg.limits.max_concurrency })
  /** @type {Map<string, { transport, server, gate, lastSeen: number, credentialDigest: Buffer, agent_id: string }>} */
  const sessions = new Map()
  let allowedHosts = null
  let closing = false

  const refuse = (res, status, reason, code, message, headers, extra = {}) => {
    auditor.event('http_refused', { status, reason, ...extra })
    jsonRpcError(res, status, code, message, headers)
  }
  const authRefuse = (res, reason) => {
    try { authFail.take('auth', AUTH_FAIL_PER_MIN) } catch { return refuse(res, 429, 'auth_throttled', -32000, 'Too many failed authentication attempts', { 'retry-after': '60' }) }
    return refuse(res, 401, reason, -32001, 'Unauthorized', { 'www-authenticate': 'Bearer realm="leadcommand-action-mcp"' })
  }

  async function closeSession(id, reason) {
    const s = sessions.get(id)
    if (!s) return
    sessions.delete(id)
    auditor.event('http_session_closed', { reason, sessions: sessions.size })
    await s.transport.close().catch(() => {})
    await s.server.close().catch(() => {})
  }

  async function handle(req, res) {
    const host = String(req.headers.host || '').toLowerCase()
    if (!allowedHosts.has(host)) return refuse(res, 403, 'host', -32000, 'Forbidden: Host header does not name this loopback server')
    const origin = req.headers.origin
    if (origin !== undefined && !h.allowed_origins.includes(String(origin).toLowerCase())) return refuse(res, 403, 'origin', -32000, 'Forbidden: Origin not allowed')
    const url = new URL(req.url || '/', 'http://loopback')
    if (url.pathname !== h.path || url.search) return refuse(res, 404, 'path', -32000, 'Not found')
    const credential = bearerCredential(req.headers.authorization)
    if (!credential) return authRefuse(res, 'auth')
    if (!['POST', 'GET', 'DELETE'].includes(req.method)) return refuse(res, 405, 'method', -32000, 'Method not allowed', { allow: 'POST, GET, DELETE' })
    if (closing) return refuse(res, 503, 'closing', -32000, 'Server shutting down')
    const sid = req.headers['mcp-session-id']
    let body
    if (req.method === 'POST') {
      try { body = JSON.parse(await readBody(req, h.max_body_bytes)) } catch (e) {
        if (e?.status === 413) return refuse(res, 413, 'body_too_large', -32000, `Request body exceeds ${h.max_body_bytes} bytes`)
        return refuse(res, 400, 'parse', -32700, 'Parse error')
      }
    }
    if (typeof sid === 'string' && sid) {
      const s = sessions.get(sid)
      if (!s) return refuse(res, 404, 'unknown_session', -32001, 'Session not found')
      if (!sameCredential(credential, s.credentialDigest)) return authRefuse(res, 'session_credential_mismatch')
      s.lastSeen = Date.now()
      await s.transport.handleRequest(req, res, body)
      return
    }
    if (req.method !== 'POST' || !(isInitializeRequest(body) || (Array.isArray(body) && body.some(isInitializeRequest)))) {
      return refuse(res, 400, 'no_session', -32000, 'Bad Request: no valid session; send initialize first')
    }
    // the session opens only for a credential the gateway resolves to an active principal of the served tenant
    const who = await app.gateway.whoami(credential)
    if (!who.ok) return authRefuse(res, `credential_${String(who.error?.code || 'refused').toLowerCase().slice(0, 40)}`)
    if (sessions.size >= h.max_sessions) {
      const idle = [...sessions.entries()].filter(([, x]) => x.gate.inFlight === 0).sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0]
      if (!idle) return refuse(res, 503, 'session_cap', -32000, `Too many busy sessions (max ${h.max_sessions})`)
      await closeSession(idle[0], 'evicted_lru')
    }
    const gate = createConcurrencyGate({ max: h.session_concurrency, code: 'SESSION_CONCURRENCY_LIMIT', label: 'concurrent calls on this connection' })
    const digest = sha(credential)
    const server = app.createServer({ transport: 'streamable-http', sessionGate: gate, processGate, credentialOf: () => credential })
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
      maxRequestBodySize: h.max_body_bytes,
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server, gate, lastSeen: Date.now(), credentialDigest: digest, agent_id: who.agent_id })
        auditor.event('http_session_open', { sessions: sessions.size, agent_id: who.agent_id })
      },
      onsessionclosed: (id) => { void closeSession(id, 'client_delete') },
    })
    transport.onclose = () => { if (transport.sessionId && sessions.has(transport.sessionId)) void closeSession(transport.sessionId, 'transport_closed') }
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
    if (!transport.sessionId || !sessions.has(transport.sessionId)) { await transport.close().catch(() => {}); await server.close().catch(() => {}) }
  }

  const srv = http.createServer((req, res) => { handle(req, res).catch(() => jsonRpcError(res, 500, -32603, 'Internal error')) })
  srv.headersTimeout = 10_000
  srv.requestTimeout = 90_000
  srv.keepAliveTimeout = 5_000
  srv.maxHeadersCount = 64
  await new Promise((resolve, reject) => { srv.once('error', reject); srv.listen({ host: h.bind, port: h.port, exclusive: true }, resolve) })
  const addr = srv.address()
  if (!addr || typeof addr === 'string' || !['127.0.0.1', '::1'].includes(addr.address)) { srv.close(); throw new Error('the HTTP listener is not on a loopback address; refusing to serve') }
  allowedHosts = allowedHostsFor(h.bind, addr.port)
  const url = `http://${h.bind === '::1' ? '[::1]' : '127.0.0.1'}:${addr.port}${h.path}`
  const sweeper = setInterval(() => { const cutoff = Date.now() - h.session_idle_ms; for (const [id, s] of sessions) if (s.lastSeen < cutoff) void closeSession(id, 'idle') }, Math.min(60_000, Math.max(1000, Math.floor(h.session_idle_ms / 4))))
  sweeper.unref()
  auditor.event('http_listen', { bind: h.bind, port: addr.port, path: h.path, auth: 'per_agent_bearer_credential', max_sessions: h.max_sessions })
  return {
    url,
    port: addr.port,
    sessions: () => sessions.size,
    async close() {
      closing = true
      clearInterval(sweeper)
      await Promise.all([...sessions.keys()].map((id) => closeSession(id, 'shutdown')))
      srv.closeAllConnections?.()
      await new Promise((r) => srv.close(() => r()))
    },
  }
}
