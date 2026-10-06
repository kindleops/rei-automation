/**
 * POST /api/wall/heartbeat — the display's only write (§29, §63).
 * Persists last-seen at most once a minute, records build changes, rotates the
 * credential when it is 30 days old, and returns the current configuration
 * (so a config change or remote view command reaches the TV within one beat).
 */
import { parseJsonSafe } from '../../_shared.js'
import { recordHeartbeat } from '@/lib/domain/command-wall/wall-auth.js'
import { wallStore } from '@/lib/domain/command-wall/wall-store.js'
import { WALL_LIMITS } from '@/lib/domain/command-wall/wall-rate-limit.js'
import { wallJson, wallError, requireDisplay, setDisplayCookie, wallAuthenticator } from '@/lib/domain/command-wall/wall-http.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request) {
  try {
    const auth = await requireDisplay(request, { rule: WALL_LIMITS.heartbeat_per_display, bucket: 'heartbeat' })
    const body = await parseJsonSafe(request, {})
    const out = await recordHeartbeat(wallStore(), auth, body)
    const authenticator = wallAuthenticator()
    if (out.rotated) {
      authenticator.forget()
      const res = wallJson({ ok: true, display: out.session, rotated: true, ...(body.delivery === 'bearer' ? { token: out.rotated.token } : {}) })
      return setDisplayCookie(res, out.rotated.token, request)
    }
    if (out.written) authenticator.remember(auth.tokenHash, out.row)
    return wallJson({ ok: true, display: out.session, rotated: false })
  } catch (error) {
    return wallError(error)
  }
}
