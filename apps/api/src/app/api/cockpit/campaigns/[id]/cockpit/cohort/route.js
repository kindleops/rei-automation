import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth } from '../../../../_shared.js'
import { buildCampaignCohortPoints } from '@/lib/domain/campaigns/campaign-cockpit.js'

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
 * GET — the campaign's exact cohort as map points (the pinned property-id list
 * for a Map-area / Entity Graph campaign; the built audience otherwise).
 * Read-only, capped at the Map focus-set ceiling of 5,000 points.
 */
export async function GET(request, { params }) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  const resolved = await params
  const campaignId = resolved?.id || null
  if (!campaignId || !CAMPAIGN_ID_RE.test(campaignId)) {
    return withCors(request, { ok: false, error: 'invalid_campaign_id' }, 400)
  }

  try {
    const result = await buildCampaignCohortPoints(campaignId)
    if (!result.ok) return withCors(request, result, result.status || 404)
    return withCors(request, result, 200)
  } catch (error) {
    console.error('campaigns.cockpit_cohort_failed', error)
    return withCors(request, {
      ok: false,
      error: 'campaign_cockpit_cohort_failed',
      message: error?.message || String(error),
    }, 500)
  }
}
