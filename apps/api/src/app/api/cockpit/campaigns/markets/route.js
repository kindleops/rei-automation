import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth } from '../../_shared.js'
import { buildCampaignMarketIndex } from '@/lib/domain/campaigns/campaign-cockpit.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

function withCors(request, payload, status = 200) {
  return NextResponse.json(payload, { status, headers: corsHeaders(request) })
}

export async function OPTIONS(request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) })
}

/** GET — the markets each non-archived campaign's audience is in. Read-only. */
export async function GET(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response
  try {
    return withCors(request, await buildCampaignMarketIndex(), 200)
  } catch (error) {
    console.error('campaigns.market_index_failed', error)
    return withCors(request, { ok: false, error: 'campaign_market_index_failed', message: error?.message || String(error) }, 500)
  }
}
