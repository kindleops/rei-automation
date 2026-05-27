import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, parseJsonSafe } from '../../../../_shared.js'
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
  if (auth && auth.status >= 400) {
    return auth
  }

  const { property_id } = params
  const snapshot = await parseJsonSafe(request)

  try {
    const { data, error } = await supabase
      .from('property_valuation_snapshots')
      .insert({
        property_id,
        master_owner_id: snapshot.master_owner_id,
        valuation_type: snapshot.valuation_type,
        estimated_arv: snapshot.estimated_arv,
        estimated_value: snapshot.estimated_value,
        arv_confidence_score: snapshot.arv_confidence_score,
        comp_confidence_score: snapshot.comp_confidence_score,
        median_sale_price: snapshot.median_sale_price,
        median_ppsf: snapshot.median_ppsf,
        median_ppu: snapshot.median_ppu,
        low_value: snapshot.low_value,
        high_value: snapshot.high_value,
        repair_estimate: snapshot.repair_estimate,
        conservative_offer: snapshot.conservative_offer,
        target_offer: snapshot.target_offer,
        max_allowable_offer: snapshot.max_allowable_offer,
        expected_assignment_low: snapshot.expected_assignment_low,
        expected_assignment_high: snapshot.expected_assignment_high,
        buyer_exit_price: snapshot.buyer_exit_price,
        buyer_demand_score: snapshot.buyer_demand_score,
        included_comp_count: snapshot.included_comp_count,
        excluded_comp_count: snapshot.excluded_comp_count,
        radius_miles: snapshot.radius_miles,
        lookback_months: snapshot.lookback_months,
        asset_class: snapshot.asset_class,
        valuation_notes: snapshot.valuation_notes,
        comp_methodology: snapshot.comp_methodology || {},
        included_comps: snapshot.included_comps || [],
        excluded_comps: snapshot.excluded_comps || []
      })
      .select()
      .single()

    if (error) throw error

    return NextResponse.json({ ok: true, data }, { status: 200, headers: cors })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: 'snapshot_failed', message: error?.message },
      { status: 500, headers: cors }
    )
  }
}

export async function GET(request, { params }) {
  const cors = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (auth && auth.status >= 400) {
    return auth
  }

  const { property_id } = params

  try {
    const { data, error } = await supabase
      .from('property_valuation_snapshots')
      .select('*')
      .eq('property_id', property_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) throw error

    if (!data) {
      return NextResponse.json({
        ok: true,
        data: null,
        warnings: ["valuation_snapshot_missing"]
      }, { status: 200, headers: cors })
    }

    return NextResponse.json({ ok: true, data }, { status: 200, headers: cors })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: 'snapshot_fetch_failed', message: error?.message },
      { status: 500, headers: cors }
    )
  }
}
