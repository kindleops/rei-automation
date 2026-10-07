import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth } from '../../_shared.js'
import { runDiscovery } from '@/lib/domain/campaigns/ranking-v2/screener-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * CAMPAIGN DISCOVERY (Acquisition OS §16 / §68) — "best acquisition campaigns
 * right now" per ZIP. READ-ONLY, behind SELLER_SCREENER (default OFF).
 *   GET ?state=TX[&market=Dallas, TX][&asset=sfr|mf_2_4|mf_5_plus][&limit=25][&max_scan=30000]
 * A scope (state and/or market) is required. Never launches anything.
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
    const result = await runDiscovery({
      state: p.getAll('state').filter(Boolean),
      market: p.getAll('market').filter(Boolean),
      asset: p.get('asset') || null,
      limit: p.get('limit') || 25,
      max_scan: p.get('max_scan') || 30000,
    })
    return withCors(request, result, result.ok === false ? Number(result.status || 500) : 200)
  } catch (error) {
    console.error('campaigns.discovery_failed', error)
    return withCors(request, { ok: false, error: 'discovery_failed', message: error?.message || String(error) }, 500)
  }
}
