/**
 * GET /api/cockpit/map/cameras/nearby?lat=&lng=[&radius=&limit=] — the public
 * cameras nearest a point (a selected property). Physical-world context only:
 * proximity to a road camera is not evidence about the property.
 */
import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureDashboardReadAuth } from '../../../_shared.js'
import { getNearbyCameras } from '@/lib/domain/map/cameras/camera-network-service.js'

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
    const q = new URL(request.url).searchParams
    const result = await getNearbyCameras({ lat: q.get('lat'), lng: q.get('lng'), radiusM: q.get('radius'), limit: q.get('limit') })
    return NextResponse.json(result, { status: result.ok ? 200 : result.status || 400, headers: { ...cors, 'Cache-Control': 'private, max-age=30' } })
  } catch (error) {
    return NextResponse.json({ ok: false, error: 'nearby_cameras_failed', message: error?.message || String(error) }, { status: 500, headers: cors })
  }
}
