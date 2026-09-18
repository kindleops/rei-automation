import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth, parseJsonSafe } from '../../../_shared.js'
import { buildCampaignTargets } from '@/lib/domain/campaigns/campaign-automation-service.js'
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
     * §4/§5 — THE CANARY AUDIENCE NEEDS INTERNAL AUTHORIZATION, NOT THIS ONE.
     *
     * `ensureMutationAuth` is the ordinary Campaign Command operator secret. It
     * is the right gate for building a production cohort and the WRONG gate for
     * reaching internal proof infrastructure, so the canary source is granted
     * only by the separate internal secret. A body flag cannot grant it: the
     * value is derived from the request's own credentials here and overwrites
     * anything the caller sent under the same name.
     *
     * The practical effect is that an ordinary operator — and an ordinary
     * Campaign Command session — cannot select internal canary phones as a
     * targeting strategy at all. It is invisible, not merely discouraged.
     */
    const internalAuth = requireInternalSecret(request)
    const result = await buildCampaignTargets(campaignId, {
      ...body,
      internal_authorized: internalAuth.ok === true,
    })
    return withCors(request, result, result.ok === false ? Number(result.status || 423) : 200)
  } catch (error) {
    console.error('campaigns.build_targets_failed', error)
    return withCors(request, {
      ok: false,
      error: 'campaign_build_targets_failed',
      message: error?.message || String(error),
    }, 500)
  }
}
