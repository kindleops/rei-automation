import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, corsHeaders } from '../../../../_shared.js'
import { getEntityNetwork } from '@/lib/domain/entity-graph/entity-network-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TYPES = new Set(['property', 'owner', 'person'])

export function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

/** One relationship network (read-only). */
export async function GET(request, { params }) {
  const headers = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response
  const { type, id } = (await params) || {}
  if (!TYPES.has(type) || !id) {
    return NextResponse.json({ ok: false, error: 'invalid_network_request' }, { status: 400, headers })
  }
  try {
    const network = await getEntityNetwork(type, decodeURIComponent(id))
    if (!network) return NextResponse.json({ ok: false, error: 'entity_not_found' }, { status: 404, headers })
    return NextResponse.json({ ok: true, data: network }, { headers: { ...headers, 'Cache-Control': 'private, max-age=30' } })
  } catch (error) {
    return NextResponse.json({ ok: false, error: error?.message || 'entity_network_failed' }, { status: 500, headers })
  }
}
