/**
 * ENTITY GRAPH — COMPOSITION OF THE COHORT ON SCREEN.
 *
 * Any dimension, under every filter the list honours (record and buyer
 * filters included). Every bucket is an exact count built by the list's own
 * query builder — see entity-graph-composition.js.
 *
 *   GET ?tab=properties&catalog=1           the dimensions a tab offers
 *   GET ?tab=properties&dimension=equity&…  one dimension, counted
 */
import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, corsHeaders } from '../../_shared.js'
import { buildEntityGraphComposition, getCompositionCatalog } from '@/lib/domain/entity-graph/entity-graph-composition.js'

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
  const params = Object.fromEntries(new URL(request.url).searchParams.entries())
  if (params.catalog) return NextResponse.json({ ok: true, ...getCompositionCatalog(params.tab || 'properties') }, { status: 200, headers })
  try {
    const composition = await buildEntityGraphComposition(params)
    return NextResponse.json({ ok: true, composition }, { status: 200, headers })
  } catch (error) {
    if (error?.code === 'unsupported_entity_graph_filters') {
      return NextResponse.json({ ok: false, error: error.code, unsupported_filters: error.unsupported_filters || [] }, { status: 422, headers })
    }
    console.error('entity_graph.composition_failed', error)
    return NextResponse.json({ ok: false, error: 'entity_graph_composition_failed', message: error?.message || null }, { status: 500, headers })
  }
}
