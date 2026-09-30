/**
 * GET /api/cockpit/map/world/zones — every US zone's clock + seller
 * contact-window state, and each market's canonical zone (read-only).
 */
import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureDashboardReadAuth } from '../../../_shared.js'
import { getMapWorldZones } from '@/lib/domain/map/map-world-service.js'

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
    const result = await getMapWorldZones({})
    return NextResponse.json(result, { status: 200, headers: { ...cors, 'Cache-Control': 'private, max-age=60' } })
  } catch (error) {
    return NextResponse.json({ ok: false, error: 'map_world_zones_failed', message: error?.message || String(error) }, { status: 500, headers: cors })
  }
}
