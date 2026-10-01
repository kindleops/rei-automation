import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth } from '../../../../_shared.js'
import { readCampaignGeo } from '@/lib/domain/campaigns/campaign-command-intel.js'

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
 * GET — one campaign's targets as points with how far each got (held → replied
 * → opportunity), plus the audience by county. Bounded at 5,000 targets.
 * Read-only: selects and head counts only.
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
    const result = await readCampaignGeo(campaignId)
    if (!result.ok) return withCors(request, result, result.status || 404)
    return withCors(request, result, 200)
  } catch (error) {
    const timedOut = error?.code === 'read_timeout'
    if (!timedOut) console.error('campaigns.cockpit_geo_failed', error)
    return withCors(request, { ok: false, error: timedOut ? 'campaign_cockpit_geo_timeout' : 'campaign_cockpit_geo_failed', message: error?.message || String(error) }, timedOut ? 503 : 500)
  }
}
