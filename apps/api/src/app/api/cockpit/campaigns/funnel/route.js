import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth } from '../../_shared.js'
import { runFunnel } from '@/lib/domain/campaigns/ranking-v2/screener-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * TARGETING FUNNEL — delivered → replied → owner → interested → price →
 * realistic → negotiation → deal, by targeting signal, with Wilson CIs.
 * READ-ONLY, behind SELLER_SCREENER (default OFF → 404, nothing read).
 *   GET ?campaign_id=<uuid>[&campaign_id=…][&since=ISO][&conditional_on=owner]
 */
function withCors(request, payload, status = 200) {
  return NextResponse.json(payload, { status, headers: corsHeaders(request) })
}

export async function OPTIONS(request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response
  const p = new URL(request.url).searchParams
  try {
    const result = await runFunnel({ campaign_ids: p.getAll('campaign_id'), since: p.get('since'), conditional_on: p.get('conditional_on') })
    return withCors(request, result, result.ok === false ? Number(result.status || 500) : 200)
  } catch (error) {
    console.error('campaigns.funnel_failed', error)
    return withCors(request, { ok: false, error: 'funnel_failed', message: error?.message || String(error) }, 500)
  }
}
