import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth } from '../../../../_shared.js'
import { buildCampaignTargetPage } from '@/lib/domain/campaigns/campaign-cockpit.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

const CAMPAIGN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function withCors(request, payload, status = 200) {
  return NextResponse.json(payload, { status, headers: corsHeaders(request) })
}

export async function OPTIONS(request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) })
}

/**
 * GET — one page of a campaign's targets with what the queue did with each
 * (latest live row, send/delivery times, release reason) and whether the
 * seller replied. Read-only; the page is capped at 100 targets.
 *   ?page=1&page_size=50&status=all|ready|planned|blocked|held&search=&reason=<block_reason>
 */
export async function GET(request, { params }) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  const resolved = await params
  const campaignId = resolved?.id || null
  if (!campaignId || !CAMPAIGN_ID_RE.test(campaignId)) {
    return withCors(request, { ok: false, error: 'invalid_campaign_id' }, 400)
  }

  const url = new URL(request.url)
  try {
    const result = await buildCampaignTargetPage(campaignId, {
      page: url.searchParams.get('page'),
      pageSize: url.searchParams.get('page_size'),
      status: url.searchParams.get('status'),
      search: url.searchParams.get('search'),
      reason: url.searchParams.get('reason'),
    })
    return withCors(request, result, 200)
  } catch (error) {
    console.error('campaigns.cockpit_targets_failed', error)
    return withCors(request, {
      ok: false,
      error: 'campaign_cockpit_targets_failed',
      message: error?.message || String(error),
    }, 500)
  }
}
