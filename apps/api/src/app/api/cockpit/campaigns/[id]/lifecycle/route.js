import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth, parseJsonSafe } from '../../../_shared.js'
import { applyCampaignLifecycleAction } from '@/lib/domain/campaigns/campaign-automation-service.js'

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

export async function POST(request, { params }) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  const campaignId = await campaignIdFromParams(params)
  if (!campaignId) {
    return withCors(request, { ok: false, error: 'campaign_id_required' }, 400)
  }

  try {
    const body = await parseJsonSafe(request)
    const result = await applyCampaignLifecycleAction(campaignId, body)
    if (!result.ok) {
      const status = result.error === 'illegal_campaign_transition' ? 409 : 400
      return withCors(request, result, status)
    }
    return withCors(request, result, 200)
  } catch (error) {
    console.error('campaigns.lifecycle_failed', error)
    return withCors(request, {
      ok: false,
      error: 'campaign_lifecycle_failed',
      message: error?.message || String(error),
    }, 500)
  }
}
