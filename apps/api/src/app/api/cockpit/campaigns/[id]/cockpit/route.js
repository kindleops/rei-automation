import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth } from '../../../_shared.js'
import { buildCampaignCockpit } from '@/lib/domain/campaigns/campaign-cockpit.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const CAMPAIGN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function withCors(request, payload, status = 200) {
  return NextResponse.json(payload, { status, headers: corsHeaders(request) })
}

export async function OPTIONS(request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) })
}

/**
 * GET — the live-execution read for one campaign (Campaign Command desktop).
 * Read-only: selects, head counts and read-only aggregate RPCs only.
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
    const result = await buildCampaignCockpit(campaignId)
    if (!result.ok) return withCors(request, result, result.status || 404)
    return withCors(request, result, 200)
  } catch (error) {
    console.error('campaigns.cockpit_failed', error)
    return withCors(request, {
      ok: false,
      error: 'campaign_cockpit_failed',
      message: error?.message || String(error),
    }, 500)
  }
}
