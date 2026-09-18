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

/**
 * THE SUBJECT IS HYDRATED FROM THE PROPERTY RECORD, NOT ONLY FROM THE CALLER.
 *
 * This route built its entire subject out of the POST body — `zip: body.zip`,
 * `lat: body.lat`, `estimated_value: body.estimated_value` — and never read the
 * property it was given the canonical id for. The dashboard happens to send all
 * of it, so the product path worked. Any other caller did not:
 *
 *   POST /buyer-match/property/2130387643/run  {}
 *     -> subject.zip undefined -> subject_incomplete: true
 *     -> run "succeeds" with 25 candidates whose total_match_score is 74.4 for
 *        EVERY buyer, price_match_score pinned at 45 for a $173k buyer and a
 *        $2.0M buyer alike, on a $219k property.
 *
 * The zip was never missing — `properties.property_address_zip` held '77051' the
 * whole time. A degraded ranking that still reports ok:true is worse than a
 * refusal, because nothing downstream can tell the difference.
 *
 * Body values still win where supplied: a caller analysing a hypothetical ARV or
 * a corrected address must be able to say so. The record is the floor, not a
 * cage.
 */
async function hydrateSubjectFromRecord(db, property_id, body) {
  const pick = (bodyValue, recordValue) =>
    bodyValue === undefined || bodyValue === null || bodyValue === '' ? recordValue : bodyValue

  let record = null
  try {
    const { data } = await db
      .from('properties')
      .select(
        'property_id,property_address_full,property_address_city,property_address_state,' +
        'property_address_zip,property_address_county_name,market,latitude,longitude,' +
        'property_type,normalized_asset_class,estimated_value'
      )
      .eq('property_id', property_id)
      .limit(1)
    record = Array.isArray(data) && data.length > 0 ? data[0] : null
  } catch {
    // A failed read is not a reason to refuse: the caller may have supplied
    // everything. It only means we cannot improve on what they sent.
    record = null
  }

  return {
    property_id,
    address: pick(body.address, record?.property_address_full),
    lat: pick(body.lat ?? body.latitude, record?.latitude),
    lng: pick(body.lng ?? body.longitude, record?.longitude),
    zip: pick(body.zip, record?.property_address_zip),
    market: pick(body.market, record?.market),
    state: pick(body.state, record?.property_address_state),
    city: pick(body.city, record?.property_address_city),
    county: pick(body.county, record?.property_address_county_name),
    asset_class: pick(body.asset_class, record?.normalized_asset_class),
    property_type: pick(body.property_type, record?.property_type),
    estimated_value: pick(body.estimated_value, record?.estimated_value),
    arv: body.arv,
    radius_miles: body.radius_miles,
  }
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
      subject: await hydrateSubjectFromRecord(supabase, property_id, body),
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
