import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth } from '../../../_shared.js'
import { buildCampaignCommandSummary } from '@/lib/domain/campaigns/campaign-command-summary.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

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

export async function GET(request, { params }) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  const campaignId = await campaignIdFromParams(params)
  if (!campaignId) {
    return withCors(request, { ok: false, error: 'campaign_id_required' }, 400)
  }

  try {
    const summary = await buildCampaignCommandSummary(campaignId)
    if (!summary.ok) {
      return withCors(request, summary, summary.error === 'campaign_not_found' ? 404 : 400)
    }
    return withCors(request, summary, 200)
  } catch (error) {
    console.error('campaigns.summary_failed', error)
    return withCors(request, {
      ok: false,
      error: 'campaign_summary_failed',
      message: error?.message || String(error),
    }, 500)
  }
}