/**
 * GET /api/cockpit/map/boundaries?level=state|zip&bbox=w,s,e,n&zoom=z — the
 * Map's administrative boundary overlay (US Census state / ZCTA outlines from
 * risk_private.geography_authoritative). Read-only, viewport-bounded,
 * simplified, cached. A refusal or a missing source answers 200 with
 * { available: false, reason } so the Map simply draws nothing.
 */
import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureDashboardReadAuth } from '../../_shared.js'
import { readMapBoundaries } from '@/lib/domain/map/map-boundaries-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  const auth = ensureDashboardReadAuth(request)
  if (!auth.ok) return auth.response
  const cors = corsHeaders(request)
  const { searchParams } = new URL(request.url)
  const t0 = Date.now()
  const result = await readMapBoundaries({ level: searchParams.get('level'), bbox: searchParams.get('bbox'), zoom: searchParams.get('zoom') })
  return NextResponse.json({ ok: true, ...result }, {
    status: 200,
    headers: { ...cors, 'Cache-Control': result.available ? 'private, max-age=600' : 'private, no-store', 'Server-Timing': `boundaries;dur=${Date.now() - t0}` },
  })
}
