import { NextResponse } from 'next/server.js'
import { ensureMutationAuth } from '../../../../_shared.js'
import { supabase } from '@/lib/supabase/client.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_ORIGINS = new Set([
  'https://ops.leadcommand.ai',
  'https://nexus-dashboard.vercel.app',
  'http://localhost:5173',
])

function resolveAllowedOrigin(origin) {
  if (!origin) return null
  if (ALLOWED_ORIGINS.has(origin)) return origin
  if (/^https:\/\/nexus-dashboard(-[a-z0-9]+)*\.vercel\.app$/.test(origin)) return origin
  return null
}

function corsHeaders(request) {
  const origin = request.headers.get('origin')
  const allowedOrigin = resolveAllowedOrigin(origin)
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-ops-dashboard-secret, X-Requested-With, Accept',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
  if (allowedOrigin) headers['Access-Control-Allow-Origin'] = allowedOrigin
  return headers
}

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request, { params }) {
  const cors = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) {
    return NextResponse.json(
      await auth.response.json().catch(() => ({ ok: false, error: 'unauthorized' })),
      { status: auth.response.status, headers: cors },
    )
  }

  const { property_id } = params
  const { searchParams } = new URL(request.url)
  const radius = parseFloat(searchParams.get('radius') || '1.0')
  const monthsBack = parseInt(searchParams.get('monthsBack') || '12', 10)
  const limit = parseInt(searchParams.get('limit') || '50', 10)
  const assetClass = searchParams.get('assetClass')

  try {
    const { data, error } = await supabase.rpc('get_comp_candidates_for_subject', {
      p_subject_property_id: property_id,
      p_radius_miles: radius,
      p_months_back: monthsBack,
      p_limit: limit
    })

    if (error) throw error

    let results = data || []
    if (assetClass) {
      results = results.filter(r => (r.normalized_asset_class || r.asset_class) === assetClass)
    }

    return NextResponse.json({ ok: true, data: results }, { status: 200, headers: cors })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: 'comps_fetch_failed', message: error?.message },
      { status: 500, headers: cors }
    )
  }
}
