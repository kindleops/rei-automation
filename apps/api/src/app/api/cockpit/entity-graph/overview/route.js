/**
 * ENTITY GRAPH · OVERVIEW — every field's distribution for the filtered cohort
 * (spec 9 §4). Read-only, direct Postgres, exact; see
 * entity-graph-overview-service.js.
 *
 *   GET ?tab=properties&sections=pinned,headline&<the browse filter params>
 *
 * A filter this tab cannot execute is a 422 naming it — never a quiet
 * universe. A section that runs past its budget comes back in `unavailable`
 * ("retry"), never as an estimate.
 */
import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, corsHeaders } from '../../_shared.js'
import { buildEntityGraphOverview } from '@/lib/domain/entity-graph/entity-graph-overview-service.js'

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
    const overview = await buildEntityGraphOverview(params)
    return NextResponse.json({ ok: true, ...overview }, { status: 200, headers })
  } catch (error) {
    // the campaign scope chip could not be resolved / does not apply here — never a quiet universe
    if (error?.name === 'CampaignScopeError') {
      return NextResponse.json({ ok: false, error: error.code, message: error.message, results: [], total: null, sections: [] }, { status: error.code === 'campaign_scope_not_found' ? 404 : 422, headers })
    }
    if (error?.code === 'unsupported_entity_graph_filters') {
      return NextResponse.json({ ok: false, error: error.code, unsupported_filters: error.unsupported_filters || [], total: null, sections: [] }, { status: 422, headers })
    }
    if (error?.code === 'overview_filters_need_facts' || error?.code === 'overview_search_unsupported' || error?.name === 'FacetUntranslatable') {
      return NextResponse.json({ ok: false, error: error.code || 'overview_filters_untranslatable', message: error.message, columns: error.columns || [], total: null, sections: [] }, { status: 422, headers })
    }
    console.error('entity_graph.overview_failed', error)
    return NextResponse.json({ ok: false, error: 'entity_graph_overview_failed', message: error?.message || null }, { status: 500, headers })
  }
}
