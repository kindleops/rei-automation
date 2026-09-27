/**
 * ENTITY GRAPH — EVERY PROPERTY ID IN THE COHORT (bounded).
 *
 * Powers "select all matching": a campaign draft gets explicit property ids, so
 * record and buyer filters the campaign builder does not know still carry
 * exactly. Read-only; caps at 5,000 and says when it truncated.
 */
import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, corsHeaders } from '../../_shared.js'
import { listEntityGraphPropertyIds } from '@/lib/domain/entity-graph/entity-graph-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  const headers = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) {
    return NextResponse.json(
      await auth.response.json().catch(() => ({ ok: false, error: 'unauthorized' })),
      { status: auth.response.status, headers },
    )
  }
  try {
    const params = Object.fromEntries(new URL(request.url).searchParams.entries())
    const result = await listEntityGraphPropertyIds(params)
    return NextResponse.json({ ok: true, ...result }, { status: 200, headers })
  } catch (error) {
    if (error?.code === 'unsupported_entity_graph_filters') {
      return NextResponse.json({ ok: false, error: error.code, unsupported_filters: error.unsupported_filters || [] }, { status: 422, headers })
    }
    return NextResponse.json({ ok: false, error: error?.message || 'entity_graph_property_ids_failed' }, { status: 500, headers })
  }
}
