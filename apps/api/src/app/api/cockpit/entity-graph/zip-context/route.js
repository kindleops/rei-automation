/**
 * ENTITY GRAPH — ZIP market context (MI rollup sales, investor / cash share,
 * medians, buyers active in the zip). Read-only keyed reads; see
 * lib/domain/entity-graph/entity-graph-zip-context.js.
 */
import { NextResponse } from 'next/server.js'
import { getEntityGraphZipContext } from '@/lib/domain/entity-graph/entity-graph-zip-context.js'
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
    const data = await getEntityGraphZipContext(params)
    return NextResponse.json({ ok: true, ...data }, { status: 200, headers })
  } catch (error) {
    console.error('entity_graph.zip_context_failed', error)
    return NextResponse.json({ ok: false, errorType: 'query_failed', error: 'entity_graph.zip_context_failed', message: error?.message || null, retryable: true }, { status: 500, headers })
  }
}
