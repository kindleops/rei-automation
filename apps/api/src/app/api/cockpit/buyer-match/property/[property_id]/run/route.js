import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, parseJsonSafe } from '../../../../../_shared.js'
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

export async function POST(request, { params }) {
  const cors = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) {
    return NextResponse.json(
      await auth.response.json().catch(() => ({ ok: false, error: 'unauthorized' })),
      { status: auth.response.status, headers: cors },
    )
  }

  const { property_id } = params
  const body = await parseJsonSafe(request)

  const {
    market,
    zip,
    state,
    county,
    asset_class,
    property_type,
    estimated_value,
    limit: rpcLimit = 100,
  } = body

  try {
    // Call RPC to get buyer match candidates
    const { data: candidates, error: rpcError } = await supabase.rpc('get_buyer_match_candidates', {
      p_market: market ?? null,
      p_zip: zip ?? null,
      p_state: state ?? null,
      p_county: county ?? null,
      p_asset_class: asset_class ?? null,
      p_property_type: property_type ?? null,
      p_estimated_value: estimated_value ?? null,
      p_limit: rpcLimit,
    })

    if (rpcError) throw rpcError

    const allCandidates = candidates ?? []
    const buyer_count = allCandidates.length
    const high_fit_count = allCandidates.filter(
      (c) => c.match_grade === 'A+' || c.match_grade === 'A',
    ).length

    // Create a buyer_match_runs row
    const { data: run, error: runError } = await supabase
      .from('buyer_match_runs')
      .insert({
        property_id,
        status: 'complete',
        candidate_count: buyer_count,
        high_fit_count,
        run_params: { market, zip, state, county, asset_class, property_type, estimated_value },
      })
      .select('*')
      .single()

    if (runError) throw runError

    // Bulk insert candidates linked to this run
    if (allCandidates.length > 0) {
      const candidateRows = allCandidates.map((c) => ({
        run_id: run.run_id,
        property_id,
        buyer_entity_id: c.buyer_entity_id,
        buyer_key: c.buyer_key,
        buyer_name: c.buyer_name,
        buyer_type: c.buyer_type,
        is_corporate_buyer: c.is_corporate_buyer,
        is_repeat_buyer: c.is_repeat_buyer,
        purchase_count: c.purchase_count,
        last_purchase_date: c.last_purchase_date,
        avg_purchase_price: c.avg_purchase_price,
        median_purchase_price: c.median_purchase_price,
        markets_active: c.markets_active,
        zips_active: c.zips_active,
        total_match_score: c.total_match_score,
        match_grade: c.match_grade,
        market_match_score: c.market_match_score,
        asset_match_score: c.asset_match_score,
        price_match_score: c.price_match_score,
        recency_score: c.recency_score,
        repeat_buyer_score: c.repeat_buyer_score,
        spread_fit_score: c.spread_fit_score,
        reason_for_match: c.reason_for_match,
        buyer_response_status: 'not_contacted',
        selected: false,
      }))

      await supabase.from('buyer_match_candidates').insert(candidateRows)
    }

    return NextResponse.json(
      {
        ok: true,
        data: {
          run_id: run.run_id,
          buyer_count,
          high_fit_count,
          candidates: allCandidates.slice(0, 25),
        },
      },
      { status: 200, headers: cors },
    )
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: 'run_failed', message: error?.message },
      { status: 500, headers: cors },
    )
  }
}
