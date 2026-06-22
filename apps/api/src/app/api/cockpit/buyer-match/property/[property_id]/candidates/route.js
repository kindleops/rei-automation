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

/** Flatten a persisted candidate row (+ its metadata blob) back into the rich
 *  BuyerMatchCandidate shape the cockpit UI renders. */
function shapeCandidate(c) {
  const m = c.metadata || {}
  return {
    buyer_match_candidate_id: c.buyer_match_candidate_id,
    buyer_match_run_id: c.buyer_match_run_id,
    buyer_entity_id: c.buyer_entity_id,
    buyer_key: m.buyer_key ?? null,
    buyer_name: c.buyer_display_name,
    buyer_type: c.buyer_type,
    is_corporate_buyer: m.is_corporate_buyer ?? false,
    is_repeat_buyer: m.is_repeat_buyer ?? false,
    mailing_city: m.mailing_city ?? null,
    mailing_state: m.mailing_state ?? null,
    mailing_zip: m.mailing_zip ?? null,
    markets_active: m.markets_active ?? [],
    zips_active: m.zips_active ?? [],
    counties_active: m.counties_active ?? [],
    preferred_asset_classes: m.preferred_asset_classes ?? [],
    purchase_count: m.purchase_count ?? 0,
    purchase_count_180d: m.purchase_count_180d ?? 0,
    purchase_count_365d: m.purchase_count_365d ?? 0,
    first_purchase_date: m.first_purchase_date ?? null,
    last_purchase_date: m.last_purchase_date ?? null,
    avg_purchase_price: m.avg_purchase_price ?? null,
    median_purchase_price: m.median_purchase_price ?? null,
    max_purchase_price: m.max_purchase_price ?? null,
    avg_ppsf: m.avg_ppsf ?? null,
    velocity_score: m.velocity_score ?? null,
    investor_score: m.investor_score ?? null,
    avg_potential_spread: m.avg_potential_spread ?? null,
    distance_miles: m.distance_miles ?? null,
    matched_purchase_count: m.matched_purchase_count ?? null,
    likely_exit_low: m.likely_exit_low ?? null,
    likely_exit_high: m.likely_exit_high ?? null,
    market_match_score: c.market_match_score,
    asset_match_score: c.asset_match_score,
    price_match_score: c.price_match_score,
    recency_score: c.recency_score,
    repeat_buyer_score: c.repeat_buyer_score,
    spread_fit_score: c.spread_fit_score,
    institutional_score: m.institutional_score ?? null,
    total_match_score: c.match_score,
    match_grade: c.match_grade,
    reason_for_match: c.reason_for_match,
    buyer_response_status: c.buyer_response_status,
    package_sent_at: c.package_sent_at,
    selected: c.selected,
    notes: c.notes,
  }
}

export async function GET(request, { params }) {
  const cors = corsHeaders(request)
  const { property_id } = await params
  const { searchParams } = new URL(request.url)

  const grade = searchParams.get('grade')
  const status = searchParams.get('status')
  const selectedParam = searchParams.get('selected')
  const limit = parseInt(searchParams.get('limit') ?? '50', 10)
  const offset = parseInt(searchParams.get('offset') ?? '0', 10)

  try {
    const { data: latest_run } = await supabase
      .from('buyer_match_runs')
      .select('buyer_match_run_id')
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
      .select('*', { count: 'exact' })
      .eq('buyer_match_run_id', latest_run.buyer_match_run_id)
      .eq('property_id', property_id)
      .order('match_score', { ascending: false })
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
          run_id: latest_run.buyer_match_run_id,
          candidates: (candidates ?? []).map(shapeCandidate),
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
