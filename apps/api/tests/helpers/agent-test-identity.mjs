// Test-only Gate B identity: real JWT-shaped tokens + an injected verifier that
// stands in for Supabase Auth (`/auth/v1/user`). No network. The production
// path (security/agent-auth.js) runs unchanged on top of it: claim checks,
// allowlist, header-mismatch refusal, rate limits.
import { createAgentIdentityProvider } from '../../src/lib/agent/security/agent-auth.js'
import { createUserRateLimiter } from '../../src/lib/agent/security/rate-limit.js'

export const OP = '0a0a0a0a-0000-4000-8000-00000000a0a0'
export const OTHER = '0b0b0b0b-0000-4000-8000-00000000b0b0'
export const OUTSIDER = '0c0c0c0c-0000-4000-8000-00000000c0c0'

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')

/** A JWT-shaped token (unsigned test signature) with Supabase-like claims. */
export function makeToken(sub = OP, claims = {}) {
  const now = Math.floor(Date.now() / 1000)
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, role: 'authenticated', aud: 'authenticated', exp: now + 3600, iat: now, ...claims })}.c2lnbmF0dXJl`
}

export const bearer = (sub = OP, claims = {}) => `Bearer ${makeToken(sub, claims)}`

/** Headers the Worker would forward: shared secret + the user's own session token (+ its x-ops-user-id). */
export function authHeaders(sub = OP, { header = sub, claims = {} } = {}) {
  return { 'x-ops-dashboard-secret': 'test', authorization: bearer(sub, claims), ...(header ? { 'x-ops-user-id': header } : {}) }
}

/**
 * Route opts for Gate B: { identity, limiter }.
 * @param {{ allow?: string[], live?: Set<string>|null, limits?: object, calls?: string[] }} [o]
 *   live: users whose sessions Supabase still accepts (default: every allowlisted + OUTSIDER)
 */
export function gateB({ allow = [OP, OTHER], live = null, limits = { mutation_per_min: 1000, read_per_min: 100000, daily_runs: 100 }, calls = [] } = {}) {
  const accepted = live || new Set([...allow, OUTSIDER])
  const identity = createAgentIdentityProvider({
    env: { OPS_ALLOWED_USER_IDS: allow.join(',') },
    verifyToken: async (token) => {
      calls.push(token)
      const sub = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).sub
      return accepted.has(sub) ? { id: sub, is_anonymous: false } : null
    },
  })
  return { identity, limiter: createUserRateLimiter({ limits }) }
}
