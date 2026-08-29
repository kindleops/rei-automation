import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth } from '../../_shared.js'
import { supabase } from '@/lib/supabase/client.js'

/**
 * Global READY inventory by market, plus the canonical routing split.
 *
 * Read-only and deliberately separate from GET /api/cockpit/campaigns: the list
 * endpoint is on the mobile critical path at ~1.3s and this aggregate should
 * never be able to slow it down.
 *
 * SCOPE: the whole campaign_target_graph — every seller property we could work
 * — NOT the targets inside existing campaigns. The two differ by more than two
 * orders of magnitude, so the caller must label which one it is showing.
 */
export const dynamic = 'force-dynamic'

function withCors(request, payload, status = 200) {
  return NextResponse.json(payload, { status, headers: corsHeaders(request) })
}

export async function OPTIONS(request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  const limit = Number(new URL(request.url).searchParams.get('limit') || 12)

  try {
    const [marketRes, inventoryRes] = await Promise.all([
      supabase.rpc('campaign_market_inventory', { p_limit: limit }),
      supabase.rpc('campaign_global_inventory'),
    ])
    if (marketRes.error) throw marketRes.error
    if (inventoryRes.error) throw inventoryRes.error
    const data = marketRes.data
    const inv = (inventoryRes.data || [])[0] || {}

    const markets = (data || []).map((row) => ({
      market: row.market,
      universe: Number(row.universe || 0),
      ready: Number(row.ready || 0),
      local_route: Number(row.local_route || 0),
      cross_state: Number(row.cross_state || 0),
      unrouted: Number(row.unrouted || 0),
    }))

    return withCors(request, {
      ok: true,
      scope: 'campaign_target_graph_global',
      scope_label: 'Global READY inventory',
      // The scope ladder. Every level is a different universe — the caller must
      // never render one of these next to a campaign-scoped figure unlabelled.
      inventory: {
        universe_properties: Number(inv.universe_properties || 0),
        contact_resolved: Number(inv.contact_resolved || 0),
        sms_eligible: Number(inv.sms_eligible || 0),
        ready: Number(inv.ready || 0),
        route_local: Number(inv.route_local || 0),
        route_cross_state: Number(inv.route_cross_state || 0),
        route_none: Number(inv.route_none || 0),
      },
      markets,
    })
  } catch (error) {
    console.error('campaigns.market_inventory_failed', error)
    return withCors(request, { ok: false, error: 'market_inventory_failed' }, 500)
  }
}
