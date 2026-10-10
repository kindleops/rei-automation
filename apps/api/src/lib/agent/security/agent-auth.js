// Named-user authentication for every agent API route (Gate B, owner D1 10-10).
//
// Replaces the stub identity provider on the agent routes. Every request is
// bound to an authenticated Supabase user, verified SERVER-SIDE here — the
// Worker's own check and the worker-asserted `x-ops-user-id` header are never
// trusted on their own:
//
//   1. Bearer token required (the Worker forwards the browser's Supabase access
//      token unchanged in `Authorization`). None → 401 SESSION_REQUIRED.
//   2. Local claim checks on the JWT: three segments, `exp` in the future,
//      `role` = `aud` = authenticated, `sub` is a UUID, `iss` is this project's
//      auth issuer, not an anonymous sign-in. A service-role / anon key is
//      refused outright (SERVICE_IDENTITY_REFUSED). → 401
//   3. Optional HS256 signature check when AGENT_SUPABASE_JWT_SECRET is set.
//   4. Authoritative verification with Supabase Auth (`GET /auth/v1/user`, the
//      same check the Worker runs): the token must still be a live session and
//      its user id must equal `sub`. Unreachable auth → refused (fail closed).
//   5. Operator allowlist (OPS_ALLOWED_USER_IDS — the list the Worker uses):
//      FAIL CLOSED, an empty list authorizes nobody. Not listed → 403.
//   6. A present `x-ops-user-id` that differs from the verified user → 403
//      OPERATOR_MISMATCH (a spoofed or stale header is evidence, not identity).
//
// The result is a VerifiedIdentity (security/identity.js contract) with
// verified=true, named=true, method='supabase_jwt'. There is no shared or
// service fallback: no path yields an identity without a verified user.
//
// Secrets: SUPABASE_SERVICE_ROLE_KEY is used only as the `apikey` header of the
// server-to-auth call. No secret is ever placed in a response, an event or a
// log line; tokens are cached only as SHA-256 digests.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { createSupabaseUserVerifier } from '@/lib/security/supabase-session-verifier.js'

export { createSupabaseUserVerifier }

export const AGENT_AUTH_CODES = Object.freeze({
  SESSION_REQUIRED: 401,
  SESSION_INVALID: 401,
  SESSION_EXPIRED: 401,
  SERVICE_IDENTITY_REFUSED: 401,
  OPERATOR_NOT_ALLOWLISTED: 403,
  OPERATOR_MISMATCH: 403,
  IDENTITY_VERIFIER_UNCONFIGURED: 503,
})

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const B64URL_RE = /^[A-Za-z0-9_-]+$/
const CLOCK_SKEW_S = 30

const clean = (v) => String(v ?? '').trim()

function header(request, name) {
  const h = request?.headers
  return h && typeof h.get === 'function' ? clean(h.get(name)) : ''
}

function b64urlJson(segment) {
  try {
    return JSON.parse(Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
  } catch {
    return null
  }
}

/** Parse (never trust) a compact JWT. @returns {{ header, claims, signingInput, signature }|null} */
export function decodeJwt(token) {
  const parts = String(token || '').split('.')
  if (parts.length !== 3 || parts.some((p) => !p || !B64URL_RE.test(p)) || token.length > 8192) return null
  const header = b64urlJson(parts[0])
  const claims = b64urlJson(parts[1])
  if (!header || !claims || typeof claims !== 'object') return null
  return { header, claims, signingInput: `${parts[0]}.${parts[1]}`, signature: parts[2] }
}

/** The operator allowlist (OPS_ALLOWED_USER_IDS). Empty ⇒ nobody (fail closed). */
export function operatorAllowlist(env = process.env) {
  return new Set(clean(env?.OPS_ALLOWED_USER_IDS).split(',').map(clean).filter(Boolean))
}

/**
 * Pure claim checks. @returns {{ ok: true, sub: string } | { ok: false, code: string, reason: string }}
 */
export function checkClaims(decoded, { env = process.env, nowS = Math.floor(Date.now() / 1000) } = {}) {
  if (!decoded) return { ok: false, code: 'SESSION_INVALID', reason: 'not_a_jwt' }
  const c = decoded.claims
  const role = clean(c.role)
  if (role === 'service_role' || role === 'anon' || role === 'supabase_admin') return { ok: false, code: 'SERVICE_IDENTITY_REFUSED', reason: `role_${role}` }
  if (clean(decoded.header?.alg).toLowerCase() === 'none') return { ok: false, code: 'SESSION_INVALID', reason: 'alg_none' }
  if (role !== 'authenticated') return { ok: false, code: 'SESSION_INVALID', reason: 'role' }
  const aud = Array.isArray(c.aud) ? c.aud.map(clean) : [clean(c.aud)]
  if (!aud.includes('authenticated')) return { ok: false, code: 'SESSION_INVALID', reason: 'aud' }
  if (!UUID_RE.test(clean(c.sub))) return { ok: false, code: 'SESSION_INVALID', reason: 'sub' }
  if (c.is_anonymous === true) return { ok: false, code: 'SESSION_INVALID', reason: 'anonymous' }
  const exp = Number(c.exp)
  if (!Number.isFinite(exp)) return { ok: false, code: 'SESSION_INVALID', reason: 'exp' }
  if (exp + CLOCK_SKEW_S <= nowS) return { ok: false, code: 'SESSION_EXPIRED', reason: 'expired' }
  const base = clean(env?.SUPABASE_URL).replace(/\/$/, '')
  if (base && clean(c.iss) && clean(c.iss) !== `${base}/auth/v1`) return { ok: false, code: 'SESSION_INVALID', reason: 'iss' }
  return { ok: true, sub: clean(c.sub).toLowerCase() }
}

/** Optional local HS256 check (AGENT_SUPABASE_JWT_SECRET). @returns {boolean|null} null = not configured */
export function verifyHs256(decoded, secret) {
  const s = clean(secret)
  if (!s) return null
  if (clean(decoded?.header?.alg) !== 'HS256') return false
  const expected = createHmac('sha256', s).update(decoded.signingInput).digest()
  let got
  try { got = Buffer.from(decoded.signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64') } catch { return false }
  return got.length === expected.length && timingSafeEqual(got, expected)
}

/**
 * @param {{ env?: object, verifyToken?: Function, now?: () => number }} [deps]
 *   verifyToken(token, { expMs }) → { id, is_anonymous } | null | 'unconfigured'
 */
export function createAgentIdentityProvider({ env = process.env, verifyToken = null, now = () => Date.now() } = {}) {
  const verify = verifyToken || createSupabaseUserVerifier({ env, now })

  const refuse = (code, reason = null) => ({ ok: false, status: AGENT_AUTH_CODES[code] || 401, code, reason })

  /**
   * @param {Request} request
   * @returns {Promise<{ ok: true, identity: import('./identity.js').VerifiedIdentity } | { ok: false, status: number, code: string, reason: string|null }>}
   */
  async function authenticate(request) {
    const bearer = /^Bearer\s+(.+)$/i.exec(header(request, 'authorization'))?.[1]?.trim() || ''
    if (!bearer) return refuse('SESSION_REQUIRED', 'no_bearer')
    const decoded = decodeJwt(bearer)
    const claims = checkClaims(decoded, { env, nowS: Math.floor(now() / 1000) })
    if (!claims.ok) return refuse(claims.code, claims.reason)
    const hs = verifyHs256(decoded, env?.AGENT_SUPABASE_JWT_SECRET)
    if (hs === false) return refuse('SESSION_INVALID', 'signature')
    const user = await verify(bearer, { expMs: Number(decoded.claims.exp) * 1000 })
    if (user === 'unconfigured') return refuse('IDENTITY_VERIFIER_UNCONFIGURED', 'supabase_auth_not_configured')
    if (!user || !user.id) return refuse('SESSION_INVALID', 'auth_rejected')
    if (user.is_anonymous) return refuse('SESSION_INVALID', 'anonymous')
    if (String(user.id).toLowerCase() !== claims.sub) return refuse('SESSION_INVALID', 'sub_mismatch')
    const allowed = operatorAllowlist(env)
    if (!allowed.has(claims.sub) && ![...allowed].some((a) => a.toLowerCase() === claims.sub)) return refuse('OPERATOR_NOT_ALLOWLISTED', allowed.size ? 'not_listed' : 'allowlist_empty')
    const claimed = header(request, 'x-ops-user-id')
    if (claimed && claimed.toLowerCase() !== claims.sub) return refuse('OPERATOR_MISMATCH', 'header_differs_from_session')
    const iat = Number(decoded.claims.iat)
    return {
      ok: true,
      identity: Object.freeze({
        verified: true,
        named: true,
        user_id: claims.sub,
        display_name: null,
        authenticated_at: Number.isFinite(iat) ? new Date(iat * 1000).toISOString() : null, // token issue time; NOT fresh-auth evidence (S4.2)
        method: 'supabase_jwt',
        reason: null,
      }),
    }
  }

  return Object.freeze({ available: true, method: 'supabase_jwt', authenticate })
}
