/**
 * ENTITY GRAPH · OVERVIEW CATALOG — the field registry (spec 9 §4.5): which
 * fields each Overview section charts, their kind, format and privacy. No
 * counts. GET ?tab=properties
 */
import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, corsHeaders } from '../../../_shared.js'
import { getOverviewCatalog } from '@/lib/domain/entity-graph/entity-graph-overview-catalog.js'

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
  const tab = new URL(request.url).searchParams.get('tab') || 'properties'
  return NextResponse.json({ ok: true, ...getOverviewCatalog(tab) }, { status: 200, headers })
}
