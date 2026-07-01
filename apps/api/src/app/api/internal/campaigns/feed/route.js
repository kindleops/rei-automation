import { NextResponse } from 'next/server.js'
import { child } from '@/lib/logging/logger.js'
import { requireInternalSecret } from '@/lib/security/require-internal-secret.js'
import { runCampaignOutboundFeeder } from '@/lib/domain/campaigns/run-campaign-outbound-feeder.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const logger = child({ module: 'api.internal.campaigns.feed' })

/**
 * Production cadence: every 5 minutes via apps/api/vercel.json cron.
 * Replenishes active production campaigns under configured caps.
 */
export async function GET(request) {
  const auth = requireInternalSecret(request)
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status ?? 401 })
  }

  logger.info('campaign_feed.started')
  try {
    const result = await runCampaignOutboundFeeder()
    logger.info('campaign_feed.completed', {
      processed: result.processed,
      total_inserted: result.total_inserted,
    })
    return NextResponse.json({
      ok: true,
      route: 'internal/campaigns/feed',
      cadence: '*/5 * * * *',
      ...result,
    })
  } catch (error) {
    const message = error?.message || String(error)
    logger.error('campaign_feed.failed', { error: message })
    return NextResponse.json({ ok: false, error: 'campaign_feed_failed', message }, { status: 500 })
  }
}

export async function POST(request) {
  return GET(request)
}