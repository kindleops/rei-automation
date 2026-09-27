import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, corsHeaders } from '../../_shared.js'
import { getTopEntityNetworks } from '@/lib/domain/entity-graph/entity-network-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

/** The largest ownership networks (landing). Read-only. */
export async function GET(request) {
  const headers = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response
  const { searchParams } = new URL(request.url)
  try {
    const rows = await getTopEntityNetworks({ limit: Number(searchParams.get('limit')) || 16, market: searchParams.get('market') || '' })
    return NextResponse.json({ ok: true, data: rows }, { headers: { ...headers, 'Cache-Control': 'private, max-age=120' } })
  } catch (error) {
    return NextResponse.json({ ok: false, error: error?.message || 'entity_networks_failed' }, { status: 500, headers })
  }
}
