import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth, parseJsonSafe } from '../../../_shared.js'
import { createCampaignQueuePlan } from '@/lib/domain/campaigns/campaign-automation-service.js'
import { requireInternalSecret } from '@/lib/security/require-internal-secret.js'

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

export async function POST(request, { params }) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  const campaignId = await campaignIdFromParams(params)
  if (!campaignId) {
    return withCors(request, { ok: false, error: 'campaign_id_required' }, 400)
  }

  try {
    const body = await parseJsonSafe(request)
    /**
     * Internal authorization is DERIVED from the request's own credentials and
     * overwrites anything the caller sent under the same name. A body flag must
     * never be able to grant the canary recontact override — that is the whole
     * point of the gate.
     */
    const internalAuth = requireInternalSecret(request)
    const result = await createCampaignQueuePlan(campaignId, {
      ...body,
      internal_authorized: internalAuth.ok === true,
    })
    return withCors(request, result, result.ok === false && !result.dry_run ? 423 : 200)
  } catch (error) {
    console.error('campaigns.queue_plan_failed', error)
    return withCors(request, {
      ok: false,
      error: 'campaign_queue_plan_failed',
      message: error?.message || String(error),
    }, 500)
  }
}
