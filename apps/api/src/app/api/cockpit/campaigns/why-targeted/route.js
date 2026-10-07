import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth } from '../../_shared.js'
import { readWhyTargeted } from '@/lib/domain/campaigns/ranking-v2/screener-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * WHY TARGETED (Acquisition OS §18) + Seller Intelligence (§79) read model.
 * READ-ONLY, behind SELLER_SCREENER (default OFF).
 *   GET ?property_id=…[&property_id=…]  (≤ 200; one `= ANY($1)` read + set-based context)
 * Internal evidence: never rendered to sellers.
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
  const ids = [...p.getAll('property_id'), ...(p.get('ids') || '').split(',')].map((s) => s.trim()).filter(Boolean)
  try {
    const result = await readWhyTargeted(ids)
    return withCors(request, result, result.ok === false ? Number(result.status || 500) : 200)
  } catch (error) {
    console.error('campaigns.why_targeted_failed', error)
    return withCors(request, { ok: false, error: 'why_targeted_failed', message: error?.message || String(error) }, 500)
  }
}
