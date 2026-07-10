import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth, parseJsonSafe } from '../../_shared.js'
import {
  getCampaign,
  updateCampaign,
  deleteCampaign,
} from '@/lib/domain/campaigns/campaign-automation-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

function withCors(request, payload, status = 200) {
  return NextResponse.json(payload, { status, headers: corsHeaders(request) })
}

const CAMPAIGN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function invalidCampaignIdResponse(request, campaignId) {
  return withCors(request, {
    ok: false,
    errorType: 'invalid_campaign_id',
    error: 'invalid_campaign_id',
    message: `Campaign id must be a UUID (received "${campaignId}"). List campaigns via GET /api/cockpit/campaigns.`,
    retryable: false,
  }, 400)
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
  if (!CAMPAIGN_ID_RE.test(campaignId)) {
    return invalidCampaignIdResponse(request, campaignId)
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
  if (!CAMPAIGN_ID_RE.test(campaignId)) {
    return invalidCampaignIdResponse(request, campaignId)
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

export async function DELETE(request, { params }) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  const campaignId = await campaignIdFromParams(params)
  if (!campaignId) {
    return withCors(request, { ok: false, error: 'campaign_id_required' }, 400)
  }
  if (!CAMPAIGN_ID_RE.test(campaignId)) {
    return invalidCampaignIdResponse(request, campaignId)
  }

  try {
    const url = new URL(request.url)
    const forceDelete = url.searchParams.get('force_delete') === '1'
      || url.searchParams.get('force_delete') === 'true'
    const result = await deleteCampaign(campaignId, { force_delete: forceDelete })
    return withCors(request, result, result.ok === false ? 400 : 200)
  } catch (error) {
    console.error('campaigns.delete_failed', error)
    return withCors(request, {
      ok: false,
      error: 'campaign_delete_failed',
      message: error?.message || String(error),
    }, 500)
  }
}
