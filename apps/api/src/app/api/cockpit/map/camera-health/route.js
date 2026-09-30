/**
 * GET /api/cockpit/map/camera-health — internal adapter heartbeat: per
 * provider cameras / live / stale / offline, last success, failures, next
 * refresh, recent refresh runs. Operator tooling; never shown on the Map
 * unless an outage affects what the operator asked to see.
 */
import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureDashboardReadAuth } from '../../_shared.js'
import { getCameraHealth } from '@/lib/domain/map/cameras/camera-network-service.js'

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
    const result = await getCameraHealth()
    return NextResponse.json(result, { status: result.ok ? 200 : result.status || 502, headers: { ...cors, 'Cache-Control': 'no-store' } })
  } catch (error) {
    return NextResponse.json({ ok: false, error: 'camera_health_failed', message: error?.message || String(error) }, { status: 500, headers: cors })
  }
}
