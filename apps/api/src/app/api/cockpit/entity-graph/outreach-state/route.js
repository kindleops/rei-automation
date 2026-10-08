/**
 * ENTITY GRAPH — outreach state for one page of properties: last contact,
 * stage, status, SMS eligibility (+ blocking reason, from the campaign target
 * builder's own readiness rule), conversation and campaign membership.
 * Read-only keyed reads; see lib/domain/entity-graph/entity-graph-outreach-state.js.
 */
import { NextResponse } from 'next/server.js'
import { getEntityGraphOutreachState } from '@/lib/domain/entity-graph/entity-graph-outreach-state.js'
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
    const data = await getEntityGraphOutreachState(params)
    return NextResponse.json({ ok: true, ...data }, { status: 200, headers })
  } catch (error) {
    console.error('entity_graph.outreach_state_failed', error)
    return NextResponse.json({ ok: false, errorType: 'query_failed', error: 'entity_graph_outreach_state_failed', message: error?.message || null, retryable: true }, { status: 500, headers })
  }
}
