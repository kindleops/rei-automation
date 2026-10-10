// Server-side Supabase session verification (Gate B). Lives OUTSIDE lib/agent:
// lib/agent performs no network I/O itself (static test); identity is injected.
//
// Asks the project's own auth service whether the access token is a live
// session (`GET /auth/v1/user`) — the same check the Cloudflare Worker runs, so
// it needs no extra secret and cannot drift from it. Unreachable ⇒ null (deny).
// SUPABASE_SERVICE_ROLE_KEY is sent only as the `apikey` header to Supabase;
// tokens are cached only as SHA-256 digests, ≤ 60 s and never past `exp`.
import { createHash } from 'node:crypto'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CACHE_MS = 60_000
const CACHE_MAX = 500
const clean = (v) => String(v ?? '').trim()

/**
 * Default authoritative verifier: Supabase Auth `GET /auth/v1/user`.
 * @returns {Promise<{ id: string, is_anonymous?: boolean }|null|'unconfigured'>}
 */
export function createSupabaseUserVerifier({ env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const cache = new Map()
  return async function verifyToken(token, { expMs = null } = {}) {
    const url = clean(env?.SUPABASE_URL)
    const key = clean(env?.SUPABASE_SERVICE_ROLE_KEY)
    if (!url || !key || typeof fetchImpl !== 'function') return 'unconfigured'
    const k = createHash('sha256').update(token).digest('hex')
    const hit = cache.get(k)
    if (hit && hit.expiresAt > now()) return hit.user
    let res
    try {
      res = await fetchImpl(`${url.replace(/\/$/, '')}/auth/v1/user`, { headers: { Authorization: `Bearer ${token}`, apikey: key } })
    } catch {
      return null // auth unreachable ⇒ deny (fail closed)
    }
    if (!res?.ok) return null
    const body = await res.json().catch(() => null)
    const id = clean(body?.id).toLowerCase()
    if (!UUID_RE.test(id)) return null
    const user = Object.freeze({ id, is_anonymous: body?.is_anonymous === true })
    if (cache.size >= CACHE_MAX) cache.clear()
    cache.set(k, { user, expiresAt: Math.min(now() + CACHE_MS, expMs ?? Infinity) })
    return user
  }
}

