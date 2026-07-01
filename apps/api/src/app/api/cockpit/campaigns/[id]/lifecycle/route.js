import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth, parseJsonSafe } from '../../../_shared.js'
import { applyCampaignLifecycleAction } from '@/lib/domain/campaigns/campaign-automation-service.js'
import { wrapCampaignActionResponse } from '@/lib/domain/campaigns/campaign-lifecycle-response.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

function withCors(request, payload, status = 200) {
  return NextResponse.json(payload, { status, headers: corsHeaders(request) })
}

function lifecycleHttpStatus(result = {}) {
  const error = String(result.error || '')
  if (error === 'campaign_not_found') return 404
  if (
    error === 'campaign_status_missing' ||
    error === 'illegal_campaign_transition' ||
    error === 'reschedule_requires_pause' ||
    error === 'restore_requires_archived'
  ) {
    return 409
  }
  return 400
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
    const payload = wrapCampaignActionResponse(result)
    if (!result.ok) {
      return withCors(request, payload, lifecycleHttpStatus(result))
    }
    return withCors(request, payload, 200)
  } catch (error) {
    console.error('campaigns.lifecycle_failed', error)
    return withCors(request, {
      ok: false,
      error: 'campaign_lifecycle_failed',
      message: error?.message || String(error),
      details: error?.details || error?.hint || null,
      code: error?.code || null,
    }, 500)
  }
}