/**
 * POST /api/wall/pair — the TV side of pairing (unauthenticated by design).
 *
 *   { action: 'start', client: {browser,width,height,dpr,render_mode} }
 *       → { pairing_id, code, poll_secret, expires_at, poll_interval_ms }
 *   { action: 'poll', pairing_id, poll_secret, delivery?: 'cookie'|'bearer' }
 *       → { paired: false } while waiting, or once (single use) { paired: true, display }
 *         with the display credential set as an HttpOnly cookie on /api/wall.
 *         `delivery: 'bearer'` (TV browsers that drop cookies) also returns the
 *         token in the body — see docs/command-wall/ARCHITECTURE.md §Token storage.
 *
 * Neither action can read business data. Codes are claimed only by a signed-in
 * operator through POST /api/cockpit/wall/displays.
 */
import { parseJsonSafe } from '../../_shared.js'
import { startPairing, pollPairing, WallAuthError } from '@/lib/domain/command-wall/wall-auth.js'
import { wallStore } from '@/lib/domain/command-wall/wall-store.js'
import { wallRateLimiter } from '@/lib/domain/command-wall/wall-rate-limit.js'
import { clientKey } from '@/lib/domain/command-wall/wall-crypto.js'
import { wallJson, wallError, setDisplayCookie } from '@/lib/domain/command-wall/wall-http.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request) {
  try {
    const body = await parseJsonSafe(request, {})
    const deps = { limiter: wallRateLimiter() }
    if (body.action === 'start') {
      const out = await startPairing(wallStore(), { clientKey: clientKey(request), hint: body.client }, deps)
      return wallJson({ ok: true, ...out })
    }
    if (body.action === 'poll') {
      const out = await pollPairing(wallStore(), { pairingId: body.pairing_id, pollSecret: body.poll_secret }, deps)
      if (!out.paired) return wallJson({ ok: true, paired: false, expires_at: out.expires_at, poll_interval_ms: out.poll_interval_ms })
      const res = wallJson({ ok: true, paired: true, display: out.display, token_expires_at: out.token_expires_at, ...(body.delivery === 'bearer' ? { token: out.token } : {}) })
      return setDisplayCookie(res, out.token, request)
    }
    throw new WallAuthError(400, 'bad_action')
  } catch (error) {
    return wallError(error)
  }
}
