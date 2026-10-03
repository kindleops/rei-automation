/**
 * Notification story projector tick — POST /api/internal/notifications/stories/project (cron auth).
 *   (default)   incremental pass: only what changed since the projector's cursor
 *   ?rebuild=1  backfill / repair with the snapshot builder's full-window read
 * Writes ONLY the projection tables (notification_stories, notification_story_inputs,
 * notification_story_projector). A no-op that says so until the PROPOSED migration
 * is applied. Sends nothing; touches no seller, campaign or alert state.
 */
import { NextResponse } from 'next/server.js'

import { requireScheduledMutationAuth } from '@/lib/security/cron-auth.js'
import { projectStories, rebuildProjection } from '@/lib/domain/notifications/stories/story-projector.js'
import { child } from '@/lib/logging/logger.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const logger = child({ module: 'api.internal.notifications.stories.project' })
export const ROUTE_NAME = 'internal/notifications/stories/project'

// Single flight per process: the Worker fires this every 30 s, so a pass that
// runs long must not overlap the next tick (both would read the same cursor).
let inFlight = null

export async function POST(request) {
  const auth = requireScheduledMutationAuth(request, logger)
  if (!auth.authorized) return auth.response
  const rebuild = new URL(request.url).searchParams.get('rebuild') === '1'
  if (inFlight) return NextResponse.json({ ok: true, route: ROUTE_NAME, rebuild, skipped: 'in_flight' })
  const started = Date.now()
  try {
    inFlight = rebuild ? rebuildProjection() : projectStories()
    const result = await inFlight
    const ms = Date.now() - started
    if (result.available) logger.info('notifications.stories.projected', { rebuild, ms, inputs: result.inputs, partitions: result.partitions, upserts: result.upserts, deletes: result.deletes })
    if (result.refused) {
      logger.warn('notifications.stories.rebuild_refused', { degraded: result.degraded })
      return NextResponse.json({ route: ROUTE_NAME, rebuild, ms, ...result, message: 'A source is degraded; nothing was written. Retry when it reads clean.' }, { status: 409 })
    }
    return NextResponse.json({ ok: true, route: ROUTE_NAME, rebuild, ms, ...result })
  } catch (error) {
    logger.error('notifications.stories.project_failed', { rebuild, error: error?.message || 'unknown' })
    return NextResponse.json({ ok: false, route: ROUTE_NAME, error: 'story_projection_failed', message: error?.message || 'failed' }, { status: 500 })
  } finally {
    inFlight = null
  }
}
