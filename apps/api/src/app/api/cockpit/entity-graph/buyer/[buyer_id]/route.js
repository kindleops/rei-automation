/**
 * ENTITY GRAPH — ONE BUYER ENTITY.
 *
 * Served from public.eg_buyer_profile (service-role only, SECURITY DEFINER
 * over comp_private). comp_private is never reachable from the browser; this
 * authenticated route is the narrowest projection of it. Person entities come
 * back with an opaque id and no name, individual_key or raw entity id.
 */
import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, corsHeaders } from '../../../_shared.js'
import { getBuyerProfile } from '@/lib/domain/entity-graph/entity-graph-buyer-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request, { params }) {
  const headers = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) {
    return NextResponse.json(
      await auth.response.json().catch(() => ({ ok: false, error: 'unauthorized' })),
      { status: auth.response.status, headers },
    )
  }
  const { buyer_id: raw } = await params
  const buyerId = decodeURIComponent(String(raw || '')).trim()
  if (!/^(company|person):[A-Za-z0-9_:.-]{3,80}$/.test(buyerId)) {
    return NextResponse.json({ ok: false, error: 'invalid_buyer_id' }, { status: 400, headers })
  }
  try {
    const profile = await getBuyerProfile(buyerId)
    if (!profile) return NextResponse.json({ ok: false, error: 'buyer_not_found' }, { status: 404, headers })
    return NextResponse.json({ ok: true, profile }, { status: 200, headers })
  } catch (error) {
    console.error('entity_graph.buyer_failed', error)
    return NextResponse.json({ ok: false, error: 'entity_graph_buyer_failed', message: error?.message || null }, { status: 500, headers })
  }
}
