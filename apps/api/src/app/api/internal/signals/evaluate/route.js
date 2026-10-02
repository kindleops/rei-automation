/**
 * Signal evaluator tick — POST /api/internal/signals/evaluate (cron auth).
 * Does nothing unless SIGNAL_CENTER_ENABLED='true' (Worker ceiling) AND
 * system_control.signal_center_enabled='true' AND the Signal Center schema
 * exists; then evaluates only ARMED rules. Writes signals + notification_events
 * (domain 'signals') + its own state/checkpoints. Sends nothing.
 * Scheduled by the Worker's CRON_SIGNAL_EVALUATE_ENABLED job (default OFF).
 */
import { NextResponse } from 'next/server.js'

import { requireScheduledMutationAuth } from '@/lib/security/cron-auth.js'
import { runSignalEvaluation } from '@/lib/domain/signals/signal-service.js'
import { child } from '@/lib/logging/logger.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

const logger = child({ module: 'api.internal.signals.evaluate' })
export const ROUTE_NAME = 'internal/signals/evaluate'

export async function POST(request) {
  const auth = requireScheduledMutationAuth(request, logger)
  if (!auth.authorized) return auth.response
  try {
    const result = await runSignalEvaluation()
    if (!result.skipped) logger.info('signals.evaluate', { armed: result.armed, events: result.events, metrics: result.metrics, states: result.states })
    return NextResponse.json({ ok: true, route: ROUTE_NAME, ...result })
  } catch (error) {
    logger.error('signals.evaluate_failed', { error: error?.message || 'unknown' })
    return NextResponse.json({ ok: false, route: ROUTE_NAME, error: 'signal_evaluation_failed', message: error?.message || 'failed' }, { status: 500 })
  }
}
