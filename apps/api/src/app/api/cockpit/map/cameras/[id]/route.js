/**
 * GET /api/cockpit/map/cameras/:id — one camera: road, direction, place,
 * local timezone, freshness against its provider's cadence, how its media may
 * be shown (proxied still / direct still / stream / official page only),
 * attribution, and its position along the corridor (previous / next).
 */
import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureDashboardReadAuth } from '../../../_shared.js'
import { getCameraDetail } from '@/lib/domain/map/cameras/camera-network-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const decodeId = (raw) => {
  const s = String(raw || '')
  if (!s.includes('%')) return s
  try { return decodeURIComponent(s) } catch { return s }
}

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request, { params }) {
  const auth = ensureDashboardReadAuth(request)
  if (!auth.ok) return auth.response
  const cors = corsHeaders(request)
  try {
    const result = await getCameraDetail(decodeId(params?.id))
    return NextResponse.json(result, { status: result.ok ? 200 : result.status || 400, headers: { ...cors, 'Cache-Control': 'private, max-age=10' } })
  } catch (error) {
    return NextResponse.json({ ok: false, error: 'camera_failed', message: error?.message || String(error) }, { status: 500, headers: cors })
  }
}
