/**
 * COMMAND WALL — where a display credential can appear on a request.
 *
 * Edge-safe (no node: imports): apps/api/middleware.js uses it to refuse a
 * display credential on every route outside /api/wall/*, so a stolen display
 * token can never reach an operator or mutation API — even in a deployment
 * where the operator shared secret happened to be unset.
 */

export const DISPLAY_COOKIE = 'lc_wall_display'
export const DISPLAY_HEADER = 'x-lc-display-token'
const PREFIX = 'lcw_'

function readCookie(header, name) {
  if (!header) return null
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    if (part.slice(0, i).trim() === name) {
      const v = part.slice(i + 1).trim()
      try { return decodeURIComponent(v) } catch { return v }
    }
  }
  return null
}

/** The raw display token on a request, from the cookie, the header or a Bearer. */
export function extractDisplayToken(request) {
  const h = request?.headers
  if (!h?.get) return null
  const fromHeader = String(h.get(DISPLAY_HEADER) || '').trim()
  if (fromHeader) return fromHeader
  const bearer = /^Bearer\s+(.+)$/i.exec(String(h.get('authorization') || ''))?.[1]?.trim()
  if (bearer && bearer.startsWith(PREFIX)) return bearer
  const cookie = readCookie(h.get('cookie'), DISPLAY_COOKIE)
  return cookie ? cookie.trim() : null
}

/** True when ANY display credential is present (prefix or carrier), valid or not. */
export function hasDisplayCredential(request) {
  const h = request?.headers
  if (!h?.get) return false
  if (String(h.get(DISPLAY_HEADER) || '').trim()) return true
  const auth = String(h.get('authorization') || '')
  if (/^Bearer\s+lcw_/i.test(auth)) return true
  const cookie = readCookie(h.get('cookie'), DISPLAY_COOKIE)
  if (cookie) return true
  // A display token smuggled through any other operator credential header.
  for (const name of ['x-ops-dashboard-secret', 'x-internal-api-secret', 'x-cron-secret', 'x-queue-engine-secret', 'x-api-mutation-secret', 'x-cockpit-mutation-secret', 'x-internal-api-key']) {
    if (String(h.get(name) || '').trim().startsWith(PREFIX)) return true
  }
  return false
}

/** The wall's own namespace: the only place a display credential is accepted. */
export function isWallPath(pathname) {
  return pathname === '/api/wall' || String(pathname || '').startsWith('/api/wall/')
}
