/**
 * Sender Routing 2.0 wake sweep — POST /api/internal/sender-routing/wake (cron auth).
 * Body: { trigger?: 'periodic'|'number_activated'|'cooling_expired'|'block_removed'|
 *         'registration_changed'|'number_added'|'graph_changed'|'manual_retry',
 *         apply?: boolean, force?: boolean }
 * Does nothing unless SENDER_ROUTING_V2_ENABLED='true' AND
 * system_control.sender_routing_v2_enabled. Re-runs NORMAL sender selection for
 * parked sends; DRY RUN unless the separate wake-apply gate is also on and
 * apply=true. An applied wake only returns a parked row to queued/scheduled —
 * it never sends and never pins a number. Not scheduled by the Worker yet.
 */
import { NextResponse } from 'next/server.js'

import { requireScheduledMutationAuth } from '@/lib/security/cron-auth.js'
import { runSenderWakeSweep } from '@/lib/domain/routing/sender-routing/sender-routing-service.js'
import { child } from '@/lib/logging/logger.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

const logger = child({ module: 'api.internal.sender_routing.wake' })
export const ROUTE_NAME = 'internal/sender-routing/wake'

export async function POST(request) {
  const auth = requireScheduledMutationAuth(request, logger)
  if (!auth.authorized) return auth.response
  const body = await request.json().catch(() => ({}))
  try {
    const result = await runSenderWakeSweep({ trigger: body?.trigger || 'periodic', apply: body?.apply === true, force: body?.force === true })
    if (!result.skipped) logger.info('sender_routing.wake', { trigger: result.trigger, parked: result.parked, routable: result.routable, writes: result.writes, dry_run: result.dry_run })
    return NextResponse.json({ ok: true, route: ROUTE_NAME, ...result })
  } catch (error) {
    logger.error('sender_routing.wake_failed', { error: error?.message || 'unknown' })
    return NextResponse.json({ ok: false, route: ROUTE_NAME, error: 'sender_wake_failed', message: error?.message || 'failed' }, { status: 500 })
  }
}
