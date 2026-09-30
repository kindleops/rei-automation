/**
 * GET /api/cockpit/map/cameras?bbox=w,s,e,n&zoom=z[&coverage=1]
 * Public roadway cameras in a viewport (read-only). The server decides the
 * semantic zoom — none / coverage cells / points — so no client can ask for a
 * continent of cameras. See camera-network-service.
 */
import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureDashboardReadAuth } from '../../_shared.js'
import { getCamerasInView } from '@/lib/domain/map/cameras/camera-network-service.js'

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
    const result = await getCamerasInView({ bbox: searchParams.get('bbox'), zoom: searchParams.get('zoom'), coverage: searchParams.get('coverage') === '1' })
    return NextResponse.json(result, { status: result.ok ? 200 : result.status || 400, headers: { ...cors, 'Cache-Control': 'private, max-age=20' } })
  } catch (error) {
    return NextResponse.json({ ok: false, error: 'cameras_failed', message: error?.message || String(error) }, { status: 500, headers: cors })
  }
}
