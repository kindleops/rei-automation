import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth, parseJsonSafe } from '../../_shared.js'
import {
  getCampaign,
  updateCampaign,
} from '@/lib/domain/campaigns/campaign-automation-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

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
    const result = await getCampaign(campaignId)
    return withCors(request, result, 200)
  } catch (error) {
    const message = error?.message || String(error)
    return withCors(request, {
      ok: false,
      error: message.includes('0 rows') ? 'campaign_not_found' : 'campaign_get_failed',
      message,
    }, message.includes('0 rows') ? 404 : 500)
  }
}

export async function PATCH(request, { params }) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  const campaignId = await campaignIdFromParams(params)
  if (!campaignId) {
    return withCors(request, { ok: false, error: 'campaign_id_required' }, 400)
  }

  try {
    const payload = await parseJsonSafe(request)
    const result = await updateCampaign(campaignId, payload)
    return withCors(request, result, result.ok === false ? Number(result.status || 423) : 200)
  } catch (error) {
    console.error('campaigns.patch_failed', error)
    return withCors(request, {
      ok: false,
      error: 'campaign_patch_failed',
      message: error?.message || String(error),
    }, 500)
  }
}
