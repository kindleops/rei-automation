/**
 * ENTITY GRAPH — table column enrichment. Read-only keyed reads of the
 * VISIBLE property columns for one page of rows. See
 * lib/domain/entity-graph/entity-graph-column-enrichment.js for the load rules.
 */
import { NextResponse } from 'next/server.js'
import { getEntityGraphColumnEnrichment } from '@/lib/domain/entity-graph/entity-graph-column-enrichment.js'
import { corsHeaders, ensureDashboardReadAuth } from '../../_shared.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  const headers = corsHeaders(request)
  const auth = ensureDashboardReadAuth(request)
  if (!auth.ok) {
    return NextResponse.json({ ok: false, errorType: 'auth_error', error: 'unauthorized' }, { status: auth.response?.status || 401, headers })
  }
  try {
    const params = Object.fromEntries(new URL(request.url).searchParams.entries())
    const data = await getEntityGraphColumnEnrichment(params)
    return NextResponse.json({ ok: true, ...data }, { status: 200, headers })
  } catch (error) {
    console.error('entity_graph.columns_failed', error)
    return NextResponse.json({ ok: false, errorType: 'query_failed', error: 'entity_graph_columns_failed', message: error?.message || null, retryable: true }, { status: 500, headers })
  }
}
