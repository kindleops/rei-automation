import { NextResponse } from 'next/server.js'
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
  const { property_id } = params
  const { searchParams } = new URL(request.url)

  const grade = searchParams.get('grade') // A+, A, B, C, D
  const status = searchParams.get('status') // not_contacted, interested, passed, package_sent
  const selectedParam = searchParams.get('selected') // true/false
  const limit = parseInt(searchParams.get('limit') ?? '50', 10)
  const offset = parseInt(searchParams.get('offset') ?? '0', 10)

  try {
    // Find latest run for this property
    const { data: latest_run } = await supabase
      .from('buyer_match_runs')
      .select('run_id')
      .eq('property_id', property_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!latest_run) {
      return NextResponse.json(
        { ok: true, data: { candidates: [], total: 0, run_id: null } },
        { status: 200, headers: cors },
      )
    }

    let query = supabase
      .from('buyer_match_candidates')
      .select('*, buyer_entities_v2(*)', { count: 'exact' })
      .eq('run_id', latest_run.run_id)
      .eq('property_id', property_id)
      .order('total_match_score', { ascending: false })
      .range(offset, offset + limit - 1)

    if (grade) query = query.eq('match_grade', grade)
    if (status) query = query.eq('buyer_response_status', status)
    if (selectedParam !== null) query = query.eq('selected', selectedParam === 'true')

    const { data: candidates, count, error } = await query

    if (error) throw error

    return NextResponse.json(
      {
        ok: true,
        data: {
          run_id: latest_run.run_id,
          candidates: candidates ?? [],
          total: count ?? 0,
          limit,
          offset,
        },
      },
      { status: 200, headers: cors },
    )
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: 'fetch_failed', message: error?.message },
      { status: 500, headers: cors },
    )
  }
}
