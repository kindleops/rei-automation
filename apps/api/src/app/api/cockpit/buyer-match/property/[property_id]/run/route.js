import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, parseJsonSafe } from '../../../../../_shared.js'
import { supabase } from '@/lib/supabase/client.js'
import { buildBuyerMatchIntel } from '@/lib/intel/buyer-match-engine.js'
import { buyerMatchErrorResponse } from '@/lib/intel/buyer-match-api-errors.js'

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
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401, headers: cors })
  }

  const { property_id } = await params
  const body = await parseJsonSafe(request)

  try {
    const result = await buildBuyerMatchIntel({
      supabase,
      persist: true,
      limit: body.limit ?? 25,
      subject: {
        property_id,
        address: body.address,
        lat: body.lat ?? body.latitude,
        lng: body.lng ?? body.longitude,
        zip: body.zip,
        market: body.market,
        state: body.state,
        city: body.city,
        county: body.county,
        asset_class: body.asset_class,
        property_type: body.property_type,
        estimated_value: body.estimated_value,
        arv: body.arv,
        radius_miles: body.radius_miles,
      },
    })

    return NextResponse.json(
      {
        ok: true,
        data: {
          run_id: result.run_id,
          buyer_count: result.buyer_count,
          high_fit_count: result.high_fit_count,
          demand_score: result.demand_score,
          liquidity_score: result.liquidity_score,
          confidence: result.confidence,
          fallback_level: result.fallback_level,
          best_buyer_grade: result.best_buyer_grade,
          candidates: result.top_buyers,
          buyer_rollup: result.buyer_rollup,
          comps: result.comps,
          source_counts: result.source_counts,
          buyer_demand: result.buyer_demand,
          cached: result.cached ?? false,
          model_version: result.model_version,
          generated_at: result.generated_at,
        },
      },
      { status: 200, headers: cors },
    )
  } catch (error) {
    console.error('[BUYER_MATCH_RUN_ERROR]', { property_id, error: error?.message, stack: error?.stack })
    return NextResponse.json(
      buyerMatchErrorResponse(error?.message, { property_id }),
      { status: 500, headers: cors },
    )
  }
}
