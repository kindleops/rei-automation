import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, corsHeaders } from '../../_shared.js'
import { searchEntityGraph } from '@/lib/domain/entity-graph/entity-graph-service.js'

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
    const params = Object.fromEntries(searchParams.entries())
    const data = await searchEntityGraph(params)
    return NextResponse.json({ ok: true, ...data }, { status: 200, headers })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error?.message || 'entity_graph_search_failed' },
      { status: 500, headers },
    )
  }
}