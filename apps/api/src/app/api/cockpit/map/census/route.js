/**
 * GET /api/cockpit/map/census?zip=55411 | ?lat=..&lng=.. | ?bbox=w,s,e,n&level=zip|county|city|state
 * ACS 5-year cells from exchange_market_fundamentals_cells (server-only),
 * with margins of error. Operator-gated. See census-cells-service.
 */
import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureDashboardReadAuth } from '../../_shared.js'
import { getCensusCells } from '@/lib/domain/map/census-cells-service.js'

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
    const result = await getCensusCells({ zip: searchParams.get('zip'), lat: searchParams.get('lat'), lng: searchParams.get('lng'), bbox: searchParams.get('bbox'), level: searchParams.get('level') })
    return NextResponse.json(result, { status: result.ok ? 200 : result.status || 400, headers: { ...cors, 'Cache-Control': 'private, max-age=600' } })
  } catch (error) {
    return NextResponse.json({ ok: false, error: 'census_failed', message: error?.message || String(error) }, { status: 500, headers: cors })
  }
}
