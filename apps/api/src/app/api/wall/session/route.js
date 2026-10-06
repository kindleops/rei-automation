/**
 * GET /api/wall/session — who this display is and how it should look.
 * Display credential only. No operator identity, no hashes.
 */
import { displaySession } from '@/lib/domain/command-wall/wall-auth.js'
import { wallJson, wallError, requireDisplay } from '@/lib/domain/command-wall/wall-http.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  try {
    const auth = await requireDisplay(request)
    return wallJson({ ok: true, display: displaySession(auth.display), server_time: new Date().toISOString() })
  } catch (error) {
    return wallError(error)
  }
}
