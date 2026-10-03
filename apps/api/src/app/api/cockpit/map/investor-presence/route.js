/**
 * GET /api/cockpit/map/investor-presence?bbox=w,s,e,n&zoom=z&months=12|24
 * Investor purchases and entity ownership as two separate components per
 * grid cell (never one score). Reads server-only mv_map_market_sales over
 * the direct Postgres connection; operator-gated. See investor-presence-service.
 */
import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureDashboardReadAuth } from '../../_shared.js'
import { getInvestorPresence } from '@/lib/domain/map/investor-presence-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  const auth = ensureDashboardReadAuth(request)
  if (!auth.ok) return auth.response
  const cors = corsHeaders(request)
  try {
    const { searchParams } = new URL(request.url)
    const result = await getInvestorPresence({ bbox: searchParams.get('bbox'), zoom: searchParams.get('zoom'), months: searchParams.get('months') })
    return NextResponse.json(result, { status: result.ok ? 200 : result.status || 400, headers: { ...cors, 'Cache-Control': 'private, max-age=300' } })
  } catch (error) {
    return NextResponse.json({ ok: false, error: 'investor_presence_failed', message: error?.message || String(error) }, { status: 500, headers: cors })
  }
}
