/**
 * GET /api/wall/events?after=<seq>&epoch=<epoch> — new wall events since a cursor.
 * One shared tick serves every display (wall-feed-service); this route only
 * slices the in-memory log and applies the display's privacy projection.
 * A different `epoch` (server restart / deploy) means the cursor is from an
 * older log: the response resends the window and the client replaces its list.
 */
import { resolveDisplayConfig } from '@/lib/domain/command-wall/wall-config.js'
import { projectEvent } from '@/lib/domain/command-wall/wall-privacy.js'
import { wallFeed } from '@/lib/domain/command-wall/wall-feed-service.js'
import { wallJson, wallError, requireDisplay } from '@/lib/domain/command-wall/wall-http.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  try {
    const auth = await requireDisplay(request)
    const config = resolveDisplayConfig(auth.display)
    const url = new URL(request.url)
    const feed = wallFeed()
    const sameEpoch = url.searchParams.get('epoch') === feed.epoch
    const after = sameEpoch ? Math.max(0, Number(url.searchParams.get('after')) || 0) : 0
    const out = await feed.read(after)
    return wallJson({
      ok: true,
      epoch: out.epoch,
      reset: !sameEpoch,
      head: out.head,
      events: out.events.map((e) => projectEvent(e, config.privacy_mode)),
      status: out.status,
      config_version: Number(auth.display.config_version) || 0,
      server_time: new Date().toISOString(),
    })
  } catch (error) {
    return wallError(error)
  }
}
