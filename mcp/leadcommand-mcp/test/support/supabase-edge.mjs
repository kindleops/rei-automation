// A REAL PostgREST in front of a DISPOSABLE PostgreSQL (tests only, never production), with Supabase's API gateway
// emulated minimally, as Supabase routes it:
//   /rest/v1/*    → PostgREST /*                                                   (no apikey → 401, as Kong answers)
//   /graphql/v1   → PostgREST POST /rpc/graphql with Content-Profile: graphql_public (pg_graphql's resolver)
// PostgREST binds 127.0.0.1 only and connects AS authenticator with the given exposed schemas and JWT secret.
// Shared by mcp/leadcommand-action-mcp/test/pg-net-exposure-e2e.test.mjs and test/graphql-access-e2e.test.mjs.
import net from 'node:net'
import http from 'node:http'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'

export async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.unref()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
  })
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
/** HS256 JWT signed with `secret` (a real signature PostgREST verifies). */
export const mintJwt = (secret, payload) => { const h = b64({ alg: 'HS256', typ: 'JWT' }); const p = b64(payload); return `${h}.${p}.${crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')}` }

/**
 * @param {{ postgrestBin: string, dbUrl: string, schemas: string, secret: string }} o   dbUrl: postgres://user@host:port/db (TCP)
 * @returns {Promise<{ url: string, upstream: string, stop: () => Promise<void> }>}
 */
export async function startSupabaseEdge({ postgrestBin, dbUrl, schemas, secret }) {
  const u = new URL(dbUrl)
  const port = await freePort()
  const child = spawn(postgrestBin, [], {
    env: {
      PATH: process.env.PATH,
      PGRST_DB_URI: `postgres://authenticator@${u.hostname}:${u.port}${u.pathname}`,
      PGRST_DB_SCHEMAS: schemas, PGRST_DB_ANON_ROLE: 'anon', PGRST_JWT_SECRET: secret,
      PGRST_SERVER_HOST: '127.0.0.1', PGRST_SERVER_PORT: String(port), PGRST_DB_POOL: '4', PGRST_LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let errOut = ''
  child.stderr.on('data', (d) => { errOut = (errOut + d).slice(-2000) })
  const stopChild = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise((r) => child.once('exit', r))
    child.kill('SIGTERM')
    await exited
  }
  const upstream = `http://127.0.0.1:${port}`
  try {
    for (let i = 0; ; i++) {
      try { const r = await fetch(`${upstream}/`); if (r.status < 500) break } catch { /* not up yet */ }
      if (i > 150) throw new Error(`PostgREST did not start: ${errOut}`)
      await new Promise((r) => setTimeout(r, 100))
    }
  } catch (e) {
    await stopChild()
    throw e
  }
  const forward = async (req, res, target, extra = {}) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const headers = { ...Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'connection', 'content-length', 'apikey'].includes(k))), ...extra }
    const r = await fetch(target, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) })
    const out = Buffer.from(await r.arrayBuffer())
    res.writeHead(r.status, Object.fromEntries([...r.headers].filter(([k]) => !['content-length', 'transfer-encoding', 'connection', 'content-encoding'].includes(k))))
    res.end(out)
  }
  const gateway = http.createServer(async (req, res) => {
    try {
      if (!req.headers.apikey) { res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'No API key found in request' })); return }
      if (req.url.startsWith('/rest/v1/')) return await forward(req, res, `${upstream}${req.url.slice('/rest/v1'.length)}`)
      if (req.url === '/graphql/v1' && req.method === 'POST') return await forward(req, res, `${upstream}/rpc/graphql`, { 'content-profile': 'graphql_public', 'content-type': 'application/json' })
      res.writeHead(404).end()
    } catch (e) {
      res.writeHead(502).end(String(e?.message || e))
    }
  })
  const gwPort = await new Promise((resolve) => gateway.listen(0, '127.0.0.1', () => resolve(gateway.address().port)))
  return {
    url: `http://127.0.0.1:${gwPort}`,
    upstream,
    async stop() {
      await new Promise((r) => gateway.close(r))
      await stopChild()
    },
  }
}
