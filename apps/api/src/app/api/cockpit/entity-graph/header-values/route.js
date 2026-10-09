/**
 * ENTITY GRAPH — HEADER FILTER VALUES for one property column over the whole
 * filtered cohort (exact). See entity-graph-header-values.js.
 */
import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, corsHeaders } from '../../_shared.js'
import { getEntityGraphHeaderValues } from '@/lib/domain/entity-graph/entity-graph-header-values.js'

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
  const started = Date.now()
  try {
    const params = Object.fromEntries(new URL(request.url).searchParams.entries())
    const data = await getEntityGraphHeaderValues(params)
    return NextResponse.json({ ok: true, ...data, ms: Date.now() - started }, { status: 200, headers: { ...headers, 'cache-control': 'no-store' } })
  } catch (error) {
    if (error?.code === 'unsupported_entity_graph_filters') {
      return NextResponse.json({ ok: false, error: error.code, unsupported_filters: error.unsupported_filters || [] }, { status: 422, headers })
    }
    if (error?.code === 'facts_cohort_too_large') {
      return NextResponse.json({ ok: false, error: error.code, message: error.message, limit: error.limit }, { status: 422, headers })
    }
    if (error?.name === 'FacetUntranslatable') {
      return NextResponse.json({ ok: false, error: 'header_values_unavailable', message: error.message }, { status: 422, headers })
    }
    console.error('entity_graph.header_values_failed', error)
    return NextResponse.json({ ok: false, error: 'entity_graph_header_values_failed', message: error?.message || null }, { status: 500, headers })
  }
}
