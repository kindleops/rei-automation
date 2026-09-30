/**
 * GET /api/cockpit/map/world?lat=&lng= — the place under the map centre, its
 * canonical timezone and the seller contact-window state there (read-only).
 */
import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureDashboardReadAuth } from '../../_shared.js'
import { getMapWorld } from '@/lib/domain/map/map-world-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  const auth = ensureDashboardReadAuth(request)
  if (!auth.ok) return auth.response
  const cors = corsHeaders(request)
  try {
    const { searchParams } = new URL(request.url)
    const result = await getMapWorld({ lat: searchParams.get('lat'), lng: searchParams.get('lng') })
    return NextResponse.json(result, { status: result.ok ? 200 : result.status || 400, headers: { ...cors, 'Cache-Control': 'private, max-age=30' } })
  } catch (error) {
    return NextResponse.json({ ok: false, error: 'map_world_failed', message: error?.message || String(error) }, { status: 500, headers: cors })
  }
}
