/**
 * Closing automation tick — POST|GET /api/internal/closings/automation
 *
 * Runs closing-automation.js over every open closing: requests routine
 * title / buyer emails (into closing_email_requests — the email system sends),
 * cancels requests whose condition is satisfied, escalates exhausted loops to
 * the operator, and raises closing notifications. Never sends email itself,
 * never changes a stage, never touches money.
 *
 * Gates: requireScheduledMutationAuth (cron secret + production identity);
 * system_control `closing_automation_enabled` (read inside the run — a
 * disabled run still writes its heartbeat so a stopped lane is visible).
 * GET is a dry run.
 */
import { NextResponse } from 'next/server.js'
import { requireScheduledMutationAuth } from '@/lib/security/cron-auth.js'
import { runClosingAutomation } from '@/lib/domain/closings/closing-automation.js'
import { child } from '@/lib/logging/logger.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const logger = child({ module: 'api.internal.closings.automation' })
export const ROUTE_NAME = 'internal/closings/automation'

async function handle(request, { dryRun }) {
  const auth = requireScheduledMutationAuth(request, logger)
  if (!auth.authorized) return auth.response
  try {
    const result = await runClosingAutomation({ dryRun })
    // Quiet when healthy and idle; a line only when something happened or failed.
    if (result.requested || result.escalated || result.cancelled || result.errors?.length) {
      logger.info('closing_automation.tick', { scanned: result.scanned, requested: result.requested, cancelled: result.cancelled, escalated: result.escalated, errors: result.errors?.length || 0 })
    }
    return NextResponse.json({ route: ROUTE_NAME, dry_run: dryRun, ...result }, { status: result.ok ? 200 : 500 })
  } catch (error) {
    logger.error('closing_automation.failed', { error: error?.message || 'unknown' })
    return NextResponse.json({ ok: false, route: ROUTE_NAME, error: 'closing_automation_failed', message: error?.message || 'failed' }, { status: 500 })
  }
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}))
  return handle(request, { dryRun: body?.dry_run === true })
}

export async function GET(request) {
  return handle(request, { dryRun: true })
}
