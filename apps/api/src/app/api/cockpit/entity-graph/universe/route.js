/**
 * ENTITY GRAPH · UNIVERSE OVERVIEW PAGE — one scope's cards (total, KPIs,
 * charts) for the global filters. Read-only, direct Postgres, exact; see
 * entity-graph-universe-service.js.
 *
 *   GET ?scope=properties&markets=["Miami, FL"]&states=["FL"]
 */
import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, corsHeaders } from '../../_shared.js'
import { buildEntityGraphUniverse } from '@/lib/domain/entity-graph/entity-graph-universe-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  const headers = { ...corsHeaders(request), 'Cache-Control': 'no-store' }
  const auth = ensureMutationAuth(request)
  if (!auth.ok) {
    return NextResponse.json(
      await auth.response.json().catch(() => ({ ok: false, error: 'unauthorized' })),
      { status: auth.response.status, headers },
    )
  }
  const params = Object.fromEntries(new URL(request.url).searchParams.entries())
  try {
    return NextResponse.json(await buildEntityGraphUniverse(params), { status: 200, headers })
  } catch (error) {
    if (error?.code === 'universe_scope_unknown') return NextResponse.json({ ok: false, error: error.code, message: error.message, cards: [] }, { status: 422, headers })
    if (error?.code === 'unsupported_entity_graph_filters' || error?.name === 'FacetUntranslatable') {
      return NextResponse.json({ ok: false, error: error.code || 'universe_filters_untranslatable', message: error.message, cards: [] }, { status: 422, headers })
    }
    console.error('entity_graph.universe_failed', error)
    return NextResponse.json({ ok: false, error: 'entity_graph_universe_failed', message: error?.message || null, cards: [] }, { status: 500, headers })
  }
}
