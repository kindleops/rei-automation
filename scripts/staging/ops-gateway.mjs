/**
 * Staging mirror of the production ops worker's trust boundary
 * (infra/cloudflare/worker/index.ts handleBrowserApi), for dashboard QA.
 *
 *   node scripts/staging/ops-gateway.mjs      → http://localhost:5180 → API :3201
 *
 * For every /api/* request: strip any inbound privileged header; verify the
 * Bearer session against STAGING Supabase Auth; require the user to be an
 * allowlisted operator (public.ops_operators); only then attach the ops
 * credential and x-ops-user-id. No session, no credential. Refuses to start
 * without proven staging identity.
 */
import http from 'node:http'
import path from 'node:path'
import { assertStaging, readEnvFile } from './guard.mjs'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
const env = readEnvFile(path.join(ROOT, 'apps/api/.env.scheduling-staging.local'))
await assertStaging({ url: env.STAGING_SUPABASE_URL, serviceKey: env.STAGING_SUPABASE_SERVICE_ROLE_KEY })
const SUPA = env.STAGING_SUPABASE_URL, SKEY = env.STAGING_SUPABASE_SERVICE_ROLE_KEY, API = 'http://localhost:3201'

async function operatorFor(auth) {
  const token = /^Bearer\s+(.+)$/i.exec(auth || '')?.[1]
  if (!token) return null
  const u = await fetch(`${SUPA}/auth/v1/user`, { headers: { authorization: `Bearer ${token}`, apikey: SKEY } }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
  if (!u?.id) return null
  const rows = await fetch(`${SUPA}/rest/v1/ops_operators?user_id=eq.${u.id}&select=user_id`, { headers: { apikey: SKEY, authorization: `Bearer ${SKEY}` } }).then((r) => r.json()).catch(() => [])
  return rows.length ? u.id : null
}

const server = http.createServer(async (req, res) => {
  req.on('error', () => {}); res.on('error', () => {})
  try {
  const headers = { ...req.headers }
  delete headers['x-ops-dashboard-secret']; delete headers['x-internal-api-secret']; delete headers['x-ops-user-id']; delete headers.host
  if (req.method !== 'OPTIONS') {
    const uid = await operatorFor(req.headers.authorization)
    if (!uid) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"ok":false,"error":"unauthorized"}'); return }
    headers['x-ops-dashboard-secret'] = env.STAGING_OPS_SECRET
    headers['x-ops-user-id'] = uid
  }
  const chunks = []; for await (const c of req) chunks.push(c)
  const upstream = await fetch(API + req.url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks), redirect: 'manual' }).catch(() => null)
  if (!upstream) { res.writeHead(502); res.end(); return }
  const out = {}; upstream.headers.forEach((v, k) => { if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(k)) out[k] = v })
  res.writeHead(upstream.status, out); res.end(Buffer.from(await upstream.arrayBuffer()))
  } catch {
    // A client that went away mid-response must never take the gateway down.
    if (!res.headersSent) { res.writeHead(502); } res.end()
  }
})
server.on('clientError', (_e, socket) => socket.destroy())
process.on('uncaughtException', (e) => console.error('gateway: recovered from', e.code || e.message))
server.listen(5180, () => console.log('ops gateway (staging) on :5180 → :3201'))
