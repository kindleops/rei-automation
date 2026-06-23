import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, corsHeaders } from '../../_shared.js'
import { getEntityGraphCounts } from '@/lib/domain/entity-graph/entity-graph-service.js'

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
    const counts = await getEntityGraphCounts()
    return NextResponse.json({ ok: true, counts }, { status: 200, headers })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error?.message || 'entity_graph_counts_failed' },
      { status: 500, headers },
    )
  }
}