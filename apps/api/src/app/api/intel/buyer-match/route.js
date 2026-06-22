import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, parseJsonSafe } from '../../_shared.js'
import { supabase } from '@/lib/supabase/client.js'
import { buildBuyerMatchIntel } from '@/lib/intel/buyer-match-engine.js'

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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

function subjectFromSearchParams(sp) {
  const get = (k) => {
    const v = sp.get(k)
    return v === null || v === '' ? undefined : v
  }
  return {
    property_id: get('property_id'),
    address: get('address'),
    lat: get('lat') ?? get('latitude'),
    lng: get('lng') ?? get('longitude'),
    zip: get('zip'),
    market: get('market'),
    state: get('state'),
    city: get('city'),
    county: get('county'),
    asset_class: get('asset_class') ?? get('normalized_asset_class'),
    property_type: get('property_type'),
    estimated_value: get('estimated_value'),
    arv: get('arv'),
    beds: get('beds'),
    baths: get('baths'),
    sqft: get('sqft'),
    units: get('units'),
    radius_miles: get('radius_miles'),
  }
}

async function run(request, { subject, persist }) {
  const cors = corsHeaders(request)
  const startedAt = Date.now()
  try {
    const result = await buildBuyerMatchIntel({ supabase, subject, persist })
    return NextResponse.json(
      { ok: true, degraded: false, ...result },
      { status: 200, headers: cors },
    )
  } catch (error) {
    console.error('[INTEL_BUYER_MATCH_ERROR]', {
      property_id: subject?.property_id,
      error: error?.message,
    })
    return NextResponse.json(
      {
        ok: true,
        degraded: true,
        error_code: 'buyer_match_failed',
        error: error?.message || 'buyer_match_failed',
        subject,
        top_buyers: [],
        buyer_matches: [],
        buyer_rollup: null,
        comps: [],
        demand_score: null,
        liquidity_score: null,
        confidence: 0,
        fallback_level: 'none',
        source_counts: { buyers: 0, matches: 0, comps: 0, fallback_level: 'none' },
        generated_at: new Date().toISOString(),
        query_ms: Date.now() - startedAt,
      },
      { status: 200, headers: cors },
    )
  }
}

export async function GET(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: 'unauthorized' },
      { status: 401, headers: corsHeaders(request) },
    )
  }
  const sp = new URL(request.url).searchParams
  const persist = sp.get('persist') !== 'false'
  return run(request, { subject: subjectFromSearchParams(sp), persist })
}

export async function POST(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: 'unauthorized' },
      { status: 401, headers: corsHeaders(request) },
    )
  }
  const body = await parseJsonSafe(request)
  const subject = body?.subject ?? body ?? {}
  const persist = body?.persist !== false
  return run(request, { subject, persist })
}
