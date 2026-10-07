import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth, parseJsonSafe } from '../../_shared.js'
import { readScreenerCatalog, runScreener } from '@/lib/domain/campaigns/ranking-v2/screener-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * SELLER SCREENER (Acquisition OS §69) — READ-ONLY, behind SELLER_SCREENER
 * (default OFF → 404 seller_screener_disabled, nothing read).
 *   GET              metric catalog with measured production coverage (§17)
 *   POST {expression, max_scan?, seller_limit?}   run the screener
 * POST is a read (the body carries the expression); it never writes.
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
  try {
    const result = await readScreenerCatalog()
    return withCors(request, result, result.ok === false ? Number(result.status || 500) : 200)
  } catch (error) {
    console.error('campaigns.screener_catalog_failed', error)
    return withCors(request, { ok: false, error: 'screener_catalog_failed', message: error?.message || String(error) }, 500)
  }
}

export async function POST(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response
  try {
    const body = await parseJsonSafe(request)
    const result = await runScreener(body || {})
    return withCors(request, result, result.ok === false ? Number(result.status || 500) : 200)
  } catch (error) {
    console.error('campaigns.screener_failed', error)
    return withCors(request, { ok: false, error: 'screener_failed', message: error?.message || String(error) }, 500)
  }
}
