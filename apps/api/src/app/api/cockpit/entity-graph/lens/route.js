/**
 * ENTITY GRAPH — UNIVERSE / DISTRIBUTION LENS.
 *
 * THE GAP THIS CLOSES. The mobile Universe Lens has existed on the client for
 * some time and called `/api/cockpit/entity-graph/lens`, which was never built.
 * Every call 404'd, so the lens rendered nothing and the saved-cohort and
 * compare features built on its payload were unreachable. The frontend already
 * failed correctly — it hid rather than shimmering — and it latched the 404 for
 * the session specifically so that deploying this route makes the lens work on
 * the next load with no client change. This is that route.
 *
 * WHAT IT ANSWERS. Not "how is this owner connected" (that is the relationship
 * graph, which this does not touch) but "what does our whole universe look
 * like" — distribution across geography, property type and ownership.
 *
 * THE SOURCE IS `properties`, NOT `campaign_target_graph`. The graph is an
 * SMS-REACHABLE PROJECTION answering "who can we text"; the universe is
 * "everything we have visibility into". They currently differ by 5 rows and
 * could diverge arbitrarily, and conflating them would make a distribution
 * chart silently mean deliverability.
 *
 * AGGREGATION IS SERVER-SIDE, ALWAYS. 169,802 rows are grouped by
 * `entity_graph_lens_aggregate` and the client receives buckets. Nothing here
 * can return a raw row set.
 *
 * EVERY COUNT IS REAL OR ABSENT. There is no fallback fixture, no synthetic
 * bucket and no invented dimension. A dimension with no data returns an empty
 * bucket list and says so; a failed query returns an error the UI can show.
 */
import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, corsHeaders } from '../../_shared.js'
import { buildEntityGraphLens } from '@/lib/domain/entity-graph/entity-graph-lens.js'

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
    const { searchParams } = new URL(request.url)
    const lens = await buildEntityGraphLens({
      tab: searchParams.get('tab'),
      part: searchParams.get('part'),
      state: searchParams.get('state'),
      market: searchParams.get('market'),
      city: searchParams.get('city'),
      county: searchParams.get('county'),
      property_type: searchParams.get('asset_type') || searchParams.get('property_type'),
      owner_type: searchParams.get('owner_type'),
    })
    return NextResponse.json({ ok: true, lens }, { status: 200, headers })
  } catch (error) {
    // An unreadable universe is reported as unreadable. It is never an empty
    // graph — the whole point of the lens is that its numbers are trustworthy.
    console.error('entity_graph.lens_failed', error)
    return NextResponse.json(
      { ok: false, error: 'entity_graph_lens_failed', message: error?.message || null },
      { status: 500, headers },
    )
  }
}
