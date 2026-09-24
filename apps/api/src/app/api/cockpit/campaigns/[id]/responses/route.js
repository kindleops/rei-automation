import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth } from '../../../_shared.js'
import { fetchCampaignResponses } from '@/lib/domain/campaigns/campaign-responses.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

function withCors(request, payload, status = 200) {
  return NextResponse.json(payload, { status, headers: corsHeaders(request) })
}

async function campaignIdFromParams(params) {
  const resolved = await params
  return resolved?.id || resolved?.campaign_id || null
}

export async function OPTIONS(request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) })
}

/** GET — read-only. */
export async function GET(request, { params }) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  const campaignId = await campaignIdFromParams(params)
  if (!campaignId) {
    return withCors(request, { ok: false, error: 'campaign_id_required' }, 400)
  }

  try {
    const result = await fetchCampaignResponses(campaignId)
    return withCors(request, result, 200)
  } catch (error) {
    console.error('campaigns.responses_failed', error)
    return withCors(request, {
      ok: false,
      error: 'campaign_responses_failed',
      message: error?.message || String(error),
    }, 500)
  }
}
