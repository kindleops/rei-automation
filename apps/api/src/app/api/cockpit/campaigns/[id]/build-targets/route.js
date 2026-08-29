import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth, parseJsonSafe } from '../../../_shared.js'
import { buildCampaignTargets } from '@/lib/domain/campaigns/campaign-automation-service.js'

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
    const result = await buildCampaignTargets(campaignId, body)
    return withCors(request, result, result.ok === false ? Number(result.status || 423) : 200)
  } catch (error) {
    console.error('campaigns.build_targets_failed', JSON.stringify({
      message: error?.message,
      code: error?.code,
      details: error?.details,
      hint: error?.hint,
      stack: error?.stack,
    }))
    // Supabase throws PostgrestError-shaped objects, whose `message` is not
    // always a string — the operator was shown a literal "[object Object]",
    // which says nothing about what actually failed.
    const message = typeof error?.message === 'string'
      ? error.message
      : [error?.code, error?.details, error?.hint].filter(Boolean).join(' · ')
        || (() => { try { return JSON.stringify(error) } catch { return String(error) } })()
    return withCors(request, {
      ok: false,
      error: 'campaign_build_targets_failed',
      message,
      code: error?.code ?? null,
      details: error?.details ?? null,
      hint: error?.hint ?? null,
    }, 500)
  }
}
