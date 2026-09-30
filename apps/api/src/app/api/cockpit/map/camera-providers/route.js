/**
 * GET /api/cockpit/map/camera-providers — connected camera sources and
 * coverage by state, as it is ("No public camera source connected" — never
 * "0 cameras" — for a state we have not connected). No keys, no hosts.
 */
import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureDashboardReadAuth } from '../../_shared.js'
import { getCameraProviders } from '@/lib/domain/map/cameras/camera-network-service.js'

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
    const result = await getCameraProviders()
    return NextResponse.json(result, { status: 200, headers: { ...cors, 'Cache-Control': 'private, max-age=120' } })
  } catch (error) {
    return NextResponse.json({ ok: false, error: 'camera_providers_failed', message: error?.message || String(error) }, { status: 500, headers: cors })
  }
}
