/**
 * DEAL DECISION — one property's underwriting read model (decision · evidence
 * · model). Read-only: never runs the engine, never writes, never offers.
 */
import { NextResponse } from 'next/server.js'
import { getDealDecision } from '@/lib/domain/deal-intelligence/deal-decision-service.js'
import { corsHeaders, ensureDashboardReadAuth } from '../../_shared.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SAFE = /^[\w+:.@-]{1,120}$/

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  const headers = corsHeaders(request)
  const auth = ensureDashboardReadAuth(request)
  if (!auth.ok) {
    return NextResponse.json({ ok: false, errorType: 'auth_error', error: 'unauthorized' }, { status: auth.response?.status || 401, headers })
  }
  const url = new URL(request.url)
  const propertyId = (url.searchParams.get('property_id') || '').trim()
  const threadKey = (url.searchParams.get('thread_key') || '').trim()
  const opportunityId = (url.searchParams.get('opportunity_id') || '').trim()
  if (!propertyId && !threadKey && !opportunityId) {
    return NextResponse.json({ ok: false, error: 'subject_required' }, { status: 400, headers })
  }
  if ((propertyId && !SAFE.test(propertyId)) || (threadKey && !SAFE.test(threadKey)) || (opportunityId && !UUID.test(opportunityId))) {
    return NextResponse.json({ ok: false, error: 'invalid_subject' }, { status: 400, headers })
  }
  try {
    const data = await getDealDecision({ propertyId, threadKey, opportunityId: opportunityId || null })
    if (!data) return NextResponse.json({ ok: false, error: 'property_not_found' }, { status: 404, headers })
    return NextResponse.json({ ok: true, data }, { status: 200, headers })
  } catch (error) {
    console.error('deal_intelligence.decision_failed', error)
    return NextResponse.json({ ok: false, errorType: 'query_failed', error: 'deal_decision_failed', message: error?.message || null, retryable: true }, { status: 500, headers })
  }
}
