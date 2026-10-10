/**
 * ENTITY GRAPH · CAMPAIGN SCOPE — the "Campaign: <name>" chip's label and the
 * scope's exact counts (targets, distinct properties / owners / people, queue:
 * sent · delivered · failed · waiting). Read-only, direct Postgres, keyed on
 * the campaign id. GET ?campaign_id=<uuid>
 */
import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, corsHeaders } from '../../_shared.js'
import { getCampaignScopeSummary, isCampaignId } from '@/lib/domain/entity-graph/entity-graph-campaign-scope.js'

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
  const campaignId = new URL(request.url).searchParams.get('campaign_id') || ''
  if (!isCampaignId(campaignId)) return NextResponse.json({ ok: false, error: 'campaign_scope_invalid_id' }, { status: 422, headers })
  try {
    const scope = await getCampaignScopeSummary(campaignId)
    return NextResponse.json({ ok: true, scope }, { status: 200, headers })
  } catch (error) {
    if (error?.name === 'CampaignScopeError') {
      return NextResponse.json({ ok: false, error: error.code, message: error.message }, { status: error.code === 'campaign_scope_not_found' ? 404 : 422, headers })
    }
    console.error('entity_graph.campaign_scope_failed', error?.message)
    return NextResponse.json({ ok: false, error: 'entity_graph_campaign_scope_failed' }, { status: 500, headers })
  }
}
