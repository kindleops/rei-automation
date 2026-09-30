/**
 * BUYER MATCH — observed-behaviour buyer workspace for one subject.
 * Read-only; ranks and explains W8C-resolved buyers (Entity Graph identity).
 * `?include=transactions` adds the located purchases behind the evidence.
 */
import { NextResponse } from 'next/server.js'
import { getBuyerMatchWorkspace } from '@/lib/domain/buyer-match/buyer-match-workspace-service.js'
import { corsHeaders, ensureDashboardReadAuth } from '../../_shared.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SAFE = /^[\w+:.@-]{1,120}$/

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  const headers = corsHeaders(request)
  const auth = ensureDashboardReadAuth(request)
  if (!auth.ok) return NextResponse.json({ ok: false, errorType: 'auth_error', error: 'unauthorized' }, { status: auth.response?.status || 401, headers })
  const url = new URL(request.url)
  const propertyId = (url.searchParams.get('property_id') || '').trim()
  if (!propertyId || !SAFE.test(propertyId)) return NextResponse.json({ ok: false, error: 'invalid_property_id' }, { status: 400, headers })
  try {
    const data = await getBuyerMatchWorkspace({
      propertyId,
      radius: url.searchParams.get('radius'),
      months: url.searchParams.get('months'),
      // opt-in: `transactions` adds the located purchases behind the evidence
      include: (url.searchParams.get('include') || '').slice(0, 64),
    })
    if (!data) return NextResponse.json({ ok: false, error: 'property_not_found' }, { status: 404, headers })
    return NextResponse.json({ ok: true, data }, { status: 200, headers })
  } catch (error) {
    console.error('buyer_match.workspace_failed', error)
    return NextResponse.json({ ok: false, errorType: 'query_failed', error: 'buyer_match_workspace_failed', message: error?.message || null, retryable: true }, { status: 500, headers })
  }
}
