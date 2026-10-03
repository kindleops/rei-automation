/**
 * GET /api/cockpit/map/crime?bbox=w,s,e,n&zoom=z&days=7|30|90
 * Reported incidents from city open-data portals (Minneapolis, Dallas,
 * Chicago) — categories, days, source, coverage. Never a safety score.
 * Operator-gated; see crime-service.
 */
import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureDashboardReadAuth } from '../../_shared.js'
import { crimeCoverage, getCrimeInView } from '@/lib/domain/map/crime/crime-service.js'

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
    if (searchParams.get('coverage') === '1') return NextResponse.json({ ok: true, ...crimeCoverage() }, { headers: { ...cors, 'Cache-Control': 'private, max-age=600' } })
    const result = await getCrimeInView({ bbox: searchParams.get('bbox'), zoom: searchParams.get('zoom'), days: searchParams.get('days') })
    return NextResponse.json(result, { status: result.ok ? 200 : result.status || 400, headers: { ...cors, 'Cache-Control': 'private, max-age=120' } })
  } catch (error) {
    return NextResponse.json({ ok: false, error: 'crime_failed', message: error?.message || String(error) }, { status: 500, headers: cors })
  }
}
