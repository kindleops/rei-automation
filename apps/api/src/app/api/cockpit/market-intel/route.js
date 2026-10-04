/**
 * GET /api/cockpit/market-intel?op=<op>&…   Market Intelligence (read-only).
 *
 *   op=status | registry
 *   op=search&q=55411
 *   op=geography&id=zip:55411
 *   op=dossier&id=market:dallas-tx&period=1y&asset=all
 *   op=rank&level=zip&within=state:TX&metric=investor_purchase_count&period=1y&asset=all&min_sales=0&dir=desc
 *   op=screen&level=zip&within=state:TX&filters=[{"metric":"sales_count","op":"gte","value":100}]&match=all
 *   op=compare&ids=market:dallas-tx,market:houston-tx&period=1y&asset=all
 *   op=trends&ids=zip:55411&asset=all
 *   op=heat&metric=investor_purchase_count&bbox=w,s,e,n&zoom=9.5&period=1y&asset=all
 *   op=recent_sales&id=zip:55411&asset=mf
 *   op=universe_load&states=TX|all     (reads the campaign graph per state, sequentially)
 *
 * Operator-gated like every cockpit read. No writes, no sends, no routing. See
 * lib/domain/market-intelligence/mi-service.js.
 */
import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureDashboardReadAuth } from '../_shared.js'
import { marketIntelService } from '@/lib/domain/market-intelligence/mi-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PARAMS = ['q', 'id', 'ids', 'level', 'within', 'metric', 'period', 'asset', 'min_sales', 'dir', 'limit', 'filters', 'match', 'sort', 'bbox', 'zoom', 'states', 'load_universe']

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  const auth = ensureDashboardReadAuth(request)
  if (!auth.ok) return auth.response
  const cors = corsHeaders(request)
  try {
    const { searchParams } = new URL(request.url)
    const op = String(searchParams.get('op') || 'status')
    const params = Object.fromEntries(PARAMS.map((k) => [k, searchParams.get(k)]).filter(([, v]) => v !== null))
    const result = await marketIntelService().run(op, params)
    const warming = typeof result?.status === 'string' && result.status !== 'ready'
    const cache = result?.ok && !warming && op !== 'status' && op !== 'universe_load' ? 'private, max-age=60' : 'no-store'
    const http = result?.ok ? 200 : (typeof result?.status === 'number' ? result.status : 400)
    return NextResponse.json(result, { status: http, headers: { ...cors, 'Cache-Control': cache } })
  } catch (error) {
    return NextResponse.json({ ok: false, error: 'market_intel_failed', message: error?.message || String(error) }, { status: 500, headers: cors })
  }
}
