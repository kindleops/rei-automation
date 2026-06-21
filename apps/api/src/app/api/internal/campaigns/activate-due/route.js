import { NextResponse } from 'next/server.js'
import { child } from '@/lib/logging/logger.js'
import { requireInternalSecret } from '@/lib/security/require-internal-secret.js'
import { runDueScheduledCampaignActivations } from '@/lib/domain/campaigns/campaign-activation-orchestrator.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

const logger = child({ module: 'api.internal.campaigns.activate-due' })

/**
 * Production cadence: every 5 minutes via apps/api/vercel.json cron.
 * Activates scheduled campaigns whose scheduled_for <= now() using the
 * canonical activation orchestrator (same path as Activate Now).
 */
export async function GET(request) {
  const auth = requireInternalSecret(request)
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status ?? 401 })
  }

  logger.info('activate_due.started')
  try {
    const result = await runDueScheduledCampaignActivations()
    logger.info('activate_due.completed', { processed: result.processed })
    return NextResponse.json({
      ok: true,
      route: 'internal/campaigns/activate-due',
      cadence: '*/5 * * * *',
      ...result,
    })
  } catch (error) {
    const message = error?.message || String(error)
    logger.error('activate_due.failed', { error: message })
    return NextResponse.json({ ok: false, error: 'activate_due_failed', message }, { status: 500 })
  }
}

export async function POST(request) {
  return GET(request)
}