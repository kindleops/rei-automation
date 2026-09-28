/**
 * COMPS INTELLIGENCE — valuation-evidence workspace for one subject.
 * Read-only; the engine's stored comp set stays canonical.
 */
import { NextResponse } from 'next/server.js'
import { getCompsWorkspace } from '@/lib/domain/comp-intelligence/comps-workspace-service.js'
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
    const data = await getCompsWorkspace({
      propertyId,
      radius: url.searchParams.get('radius'),
      months: url.searchParams.get('months'),
    })
    if (!data) return NextResponse.json({ ok: false, error: 'property_not_found' }, { status: 404, headers })
    return NextResponse.json({ ok: true, data }, { status: 200, headers })
  } catch (error) {
    console.error('comps.workspace_failed', error)
    return NextResponse.json({ ok: false, errorType: 'query_failed', error: 'comps_workspace_failed', message: error?.message || null, retryable: true }, { status: 500, headers })
  }
}
