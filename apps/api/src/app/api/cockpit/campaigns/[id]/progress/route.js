import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth } from '../../../_shared.js'
import {
  getCampaignRuntimeSummary,
  recomputeCampaignProgress,
} from '@/lib/domain/campaigns/campaign-progress.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

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
  if (!campaignId) return withCors(request, { ok: false, error: 'campaign_id_required' }, 400)

  try {
    const url = new URL(request.url)
    if (url.searchParams.get('recompute') === '1' || url.searchParams.get('recompute') === 'true') {
      const recomputed = await recomputeCampaignProgress(campaignId)
      if (!recomputed.ok) return withCors(request, recomputed, 400)
    }
    const result = await getCampaignRuntimeSummary(campaignId)
    return withCors(request, result, result.ok ? 200 : 404)
  } catch (error) {
    console.error('campaigns.progress_failed', error)
    return withCors(request, {
      ok: false,
      error: 'campaign_progress_failed',
      message: error?.message || String(error),
    }, 500)
  }
}

// POST forces a recompute then returns the fresh summary.
export async function POST(request, { params }) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  const campaignId = await campaignIdFromParams(params)
  if (!campaignId) return withCors(request, { ok: false, error: 'campaign_id_required' }, 400)

  try {
    const recomputed = await recomputeCampaignProgress(campaignId)
    if (!recomputed.ok) return withCors(request, recomputed, 400)
    const result = await getCampaignRuntimeSummary(campaignId)
    return withCors(request, { ...result, recomputed: true }, result.ok ? 200 : 404)
  } catch (error) {
    console.error('campaigns.progress_recompute_failed', error)
    return withCors(request, {
      ok: false,
      error: 'campaign_progress_recompute_failed',
      message: error?.message || String(error),
    }, 500)
  }
}
