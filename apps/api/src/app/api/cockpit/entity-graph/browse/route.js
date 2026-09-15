import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, corsHeaders } from '../../_shared.js'
import { browseEntityGraph } from '@/lib/domain/entity-graph/entity-graph-service.js'

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
    const data = await browseEntityGraph(params)
    return NextResponse.json({ ok: true, ...data }, { status: 200, headers })
  } catch (error) {
    /**
     * A filter this tab cannot execute is a 422 naming the filter, never a
     * quiet unfiltered page. `results: []` and `total: 0` so a client that
     * ignores `ok` still cannot render the whole table as a cohort.
     */
    if (error?.code === 'unsupported_entity_graph_filters') {
      return NextResponse.json(
        {
          ok: false,
          error: error.code,
          unsupported_filters: error.unsupported_filters || [],
          results: [],
          total: 0,
        },
        { status: 422, headers },
      )
    }
    return NextResponse.json(
      { ok: false, error: error?.message || 'entity_graph_browse_failed' },
      { status: 500, headers },
    )
  }
}