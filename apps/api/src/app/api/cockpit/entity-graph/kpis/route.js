import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, corsHeaders } from '../../_shared.js'
import { getEntityGraphKpis } from '@/lib/domain/entity-graph/entity-graph-kpis.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

/** Entity Graph header KPIs (read-only, exact counts; a failed count is null). */
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
    const kpis = await getEntityGraphKpis()
    return NextResponse.json({ ok: true, kpis }, { status: 200, headers: { ...headers, 'Cache-Control': 'private, max-age=60' } })
  } catch (error) {
    return NextResponse.json({ ok: false, error: error?.message || 'entity_graph_kpis_failed' }, { status: 500, headers })
  }
}
