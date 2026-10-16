// Streamable HTTP transport (LeadCommand MCP 1.x) — LOOPBACK ONLY, bearer-token gated.
//
// Purpose: let a local agent command center (Agntau) that speaks only Streamable HTTP reach
// the same read-only gateway the stdio transport serves. It is NOT a public endpoint:
//
//   bind        127.0.0.1 or ::1 only (config.mjs refuses anything else); the listening
//               address is re-checked after listen()
//   Host        must name the loopback listener exactly (127.0.0.1 | localhost | [::1] : port)
//               → 403 otherwise (DNS-rebinding protection)
//   Origin      absent (non-browser clients) or an exact entry of the loopback allowlist
//               → 403 otherwise (MCP spec: servers MUST validate Origin)
//   auth        `Authorization: Bearer <token>`; the token comes from a 0600 file; only its
//               SHA-256 digest is held and compared with crypto.timingSafeEqual → 401 otherwise.
//               Repeated failures are throttled (429). The token never appears in a log line,
//               an error, a response or a tool result.
//   principal   the host-configured operator (LEADCOMMAND_MCP_PRINCIPAL_USER_ID / ORG_ID), exactly
//               as on stdio. The token proves "this local client may connect"; it carries no
//               claims and never selects a user, org or scope.
//   limits      the gateway's rate / timeout / response-size budgets and its process-wide
//               concurrency gate are shared by every session; each session also has its own
//               concurrency cap (SESSION_CONCURRENCY_LIMIT). Sessions are bounded in number (at the
//               bound the least-recently-used IDLE session is evicted; all busy → 503) and expire
//               when idle. Request bodies are size-capped before parsing.
//   sessions    random UUIDs from the SDK; used only to route to the session's Server, never
//               as authentication (the bearer token is checked on every request).
import http from 'node:http'
import crypto from 'node:crypto'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { createConcurrencyGate, createRateLimiter } from '../safety/limits.mjs'

const AUTH_FAIL_PER_MIN = 30

const jsonRpcError = (res, status, code, message, headers = {}) => {
  if (res.headersSent) return
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers })
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }))
}

/** Host header values that name THIS loopback listener. */
export function allowedHostsFor(bind, port) {
  const names = bind === '::1' ? ['[::1]', 'localhost'] : ['127.0.0.1', 'localhost']
  return new Set(names.map((n) => `${n}:${port}`))
}

/** Constant-time bearer check against the stored digest. Never throws, never logs the value. */
export function bearerMatches(header, digest) {
  if (typeof header !== 'string') return false
  const m = /^Bearer[ ]+([^\s]{1,512})$/i.exec(header.trim())
  const presented = crypto.createHash('sha256').update(m ? m[1] : `\u0000invalid:${crypto.randomUUID()}`, 'utf8').digest()
  return crypto.timingSafeEqual(presented, digest) && Boolean(m)
}

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

/**
 * Start the loopback Streamable HTTP listener.
 * @param {{ app: Awaited<ReturnType<import('../app.mjs').buildApp>> }} deps
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void>, sessions: () => number }>}
 */
export async function startHttp({ app }) {
  const h = app.cfg.http
  if (!h) throw new Error('startHttp needs LEADCOMMAND_MCP_TRANSPORT=streamable-http')
  const digest = h.tokenDigest()
  const auditor = app.auditor
  const authFail = createRateLimiter()
  /** @type {Map<string, { transport: StreamableHTTPServerTransport, server: any, gate: { inFlight: number }, lastSeen: number }>} */
  const sessions = new Map()
  let allowedHosts = null
  let closing = false

  const refuse = (res, status, reason, code, message, headers, method = null) => {
    auditor.event('http_refused', { status, reason, ...(method ? { method } : {}) })
    jsonRpcError(res, status, code, message, headers)
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
    // 1 Host (DNS rebinding): must name this loopback listener exactly
    const host = String(req.headers.host || '').toLowerCase()
    if (!allowedHosts.has(host)) return refuse(res, 403, 'host', -32000, 'Forbidden: Host header does not name this loopback server')
    // 2 Origin: absent (non-browser client) or exactly allowlisted
    const origin = req.headers.origin
    if (origin !== undefined && !h.allowed_origins.includes(String(origin).toLowerCase())) return refuse(res, 403, 'origin', -32000, 'Forbidden: Origin not allowed')
    // 3 path
    const url = new URL(req.url || '/', 'http://loopback')
    if (url.pathname !== h.path || url.search) return refuse(res, 404, 'path', -32000, 'Not found')
    // 4 bearer token (every request; sessions are not credentials)
    if (!bearerMatches(req.headers.authorization, digest)) {
      try { authFail.take('auth', AUTH_FAIL_PER_MIN) } catch { return refuse(res, 429, 'auth_throttled', -32000, 'Too many failed authentication attempts', { 'retry-after': '60' }) }
      return refuse(res, 401, 'auth', -32001, 'Unauthorized', { 'www-authenticate': 'Bearer realm="leadcommand-mcp"' })
    }
    // 5 method
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
      if (!s) return refuse(res, 404, 'unknown_session', -32001, 'Session not found') // client re-initializes
      s.lastSeen = Date.now()
      await s.transport.handleRequest(req, res, body)
      return
    }
    if (req.method !== 'POST' || !(isInitializeRequest(body) || (Array.isArray(body) && body.some(isInitializeRequest)))) {
      return refuse(res, 400, 'no_session', -32000, 'Bad Request: no valid session; send initialize first', {}, `${req.method}${body && !Array.isArray(body) && typeof body.method === 'string' ? ` ${body.method.slice(0, 40)}` : ''}`)
    }
    if (sessions.size >= h.max_sessions) {
      // Clients that never DELETE their session (observed: Claude Code 2.1.x) would otherwise lock
      // the server out until the idle sweep. Evict the least-recently-used session with no call in
      // flight; refuse only when every session is busy. The bound itself never grows.
      const idle = [...sessions.entries()].filter(([, x]) => x.gate.inFlight === 0).sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0]
      if (!idle) return refuse(res, 503, 'session_cap', -32000, `Too many busy sessions (max ${h.max_sessions})`)
      await closeSession(idle[0], 'evicted_lru')
    }

    const sessionGate = createConcurrencyGate({ max: h.session_concurrency, code: 'SESSION_CONCURRENCY_LIMIT', label: 'concurrent calls on this connection' })
    const server = app.createServer({ transport: 'streamable-http', sessionGate })
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
      maxRequestBodySize: h.max_body_bytes,
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server, gate: sessionGate, lastSeen: Date.now() })
        auditor.event('http_session_open', { sessions: sessions.size })
      },
      onsessionclosed: (id) => { void closeSession(id, 'client_delete') },
    })
    transport.onclose = () => { if (transport.sessionId && sessions.has(transport.sessionId)) void closeSession(transport.sessionId, 'transport_closed') }
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
    // an initialize the SDK rejected never registers: release its Server now
    if (!transport.sessionId || !sessions.has(transport.sessionId)) { await transport.close().catch(() => {}); await server.close().catch(() => {}) }
  }

  const srv = http.createServer((req, res) => {
    handle(req, res).catch(() => jsonRpcError(res, 500, -32603, 'Internal error'))
  })
  srv.headersTimeout = 10_000
  srv.requestTimeout = 60_000
  srv.keepAliveTimeout = 5_000
  srv.maxHeadersCount = 64

  await new Promise((resolve, reject) => {
    srv.once('error', reject)
    srv.listen({ host: h.bind, port: h.port, exclusive: true }, resolve)
  })
  const addr = srv.address()
  if (!addr || typeof addr === 'string' || !['127.0.0.1', '::1'].includes(addr.address)) {
    srv.close()
    throw new Error('the HTTP listener is not on a loopback address; refusing to serve')
  }
  allowedHosts = allowedHostsFor(h.bind, addr.port)
  const hostLiteral = h.bind === '::1' ? '[::1]' : '127.0.0.1'
  const url = `http://${hostLiteral}:${addr.port}${h.path}`

  const sweeper = setInterval(() => {
    const cutoff = Date.now() - h.session_idle_ms
    for (const [id, s] of sessions) if (s.lastSeen < cutoff) void closeSession(id, 'idle')
  }, Math.min(60_000, Math.max(1000, Math.floor(h.session_idle_ms / 4))))
  sweeper.unref()

  auditor.event('http_listen', { bind: h.bind, port: addr.port, path: h.path, auth: 'bearer_token_file', max_sessions: h.max_sessions, session_concurrency: h.session_concurrency })

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
