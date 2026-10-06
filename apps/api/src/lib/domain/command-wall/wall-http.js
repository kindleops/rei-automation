/**
 * COMMAND WALL — shared HTTP plumbing for /api/wall/* (display) and
 * /api/cockpit/wall/* (operator) routes.
 */
import { NextResponse } from 'next/server.js'
import { WallAuthError, createDisplayAuthenticator, TOKEN_TTL_MS } from './wall-auth.js'
import { WallStoreUnprovisioned, wallStore } from './wall-store.js'
import { wallRateLimiter, WALL_LIMITS } from './wall-rate-limit.js'
import { DISPLAY_COOKIE, extractDisplayToken } from './wall-credential.js'

const NO_STORE = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' }

export function wallJson(body, status = 200, headers = {}) {
  return NextResponse.json(body, { status, headers: { ...NO_STORE, ...headers } })
}

export function wallError(error) {
  if (error instanceof WallStoreUnprovisioned) {
    return wallJson({ ok: false, error: 'display_registry_unprovisioned', message: 'Command Wall display registry is not provisioned (proposed migration not applied).' }, 503)
  }
  if (error instanceof WallAuthError) {
    const headers = error.retryAfterMs ? { 'Retry-After': String(Math.ceil(error.retryAfterMs / 1000)) } : {}
    const res = wallJson({ ok: false, error: error.code, ...(error.retryAfterMs ? { retry_after_ms: error.retryAfterMs } : {}) }, error.status, headers)
    // A dead credential is cleared so the TV falls back to its pairing screen.
    if (error.status === 401 && /^display_/.test(error.code)) clearDisplayCookie(res)
    return res
  }
  return wallJson({ ok: false, error: 'wall_failed' }, 500)
}

const isSecure = (request) => {
  const proto = request.headers.get('x-forwarded-proto') || new URL(request.url).protocol.replace(':', '')
  return proto === 'https'
}

/**
 * The display credential lives in an HttpOnly, SameSite=Strict cookie scoped
 * to /api/wall: page JavaScript can't read it (an XSS on the wall can't
 * exfiltrate it) and the browser never sends it to any other API path.
 */
export function setDisplayCookie(res, token, request) {
  const parts = [`${DISPLAY_COOKIE}=${encodeURIComponent(token)}`, 'Path=/api/wall', 'HttpOnly', 'SameSite=Strict', `Max-Age=${Math.floor(TOKEN_TTL_MS / 1000)}`]
  if (isSecure(request)) parts.push('Secure')
  res.headers.append('Set-Cookie', parts.join('; '))
  return res
}

export function clearDisplayCookie(res) {
  res.headers.append('Set-Cookie', `${DISPLAY_COOKIE}=; Path=/api/wall; HttpOnly; SameSite=Strict; Max-Age=0`)
  return res
}

let authenticator = null
export function wallAuthenticator() {
  if (!authenticator) authenticator = createDisplayAuthenticator(wallStore())
  return authenticator
}
export function _resetWallAuthenticatorForTests() { authenticator = null }

/** Authenticates a display read; throws WallAuthError. */
export async function requireDisplay(request, { rule = WALL_LIMITS.read_per_display, bucket = 'read' } = {}) {
  const token = extractDisplayToken(request)
  if (!token) throw new WallAuthError(401, 'display_unpaired')
  const auth = await wallAuthenticator().authenticate(token)
  const r = wallRateLimiter().take(`wall:${bucket}:${auth.display.id}`, rule)
  if (!r.ok) throw new WallAuthError(429, 'rate_limited', { retryAfterMs: r.retryAfterMs })
  return auth
}

/** The verified operator from the Worker (x-ops-user-id), or the dev placeholder locally. */
export function operatorIdFrom(request) {
  const id = String(request.headers.get('x-ops-user-id') || '').trim()
  if (id) return id
  const production = process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production'
  return production ? null : 'local-operator'
}
