import { NextResponse } from 'next/server.js'
import { supabase } from '@/lib/supabase/client.js'
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

export async function GET(request, { params }) {
  const cors = corsHeaders(request)
  const { property_id } = params

  try {
    // (a) Fetch latest property record
    const { data: property, error: propError } = await supabase
      .from('properties')
      .select('*')
      .eq('property_id', property_id)
      .maybeSingle()

    if (propError) throw propError

    if (!property) {
      return NextResponse.json(
        { ok: false, error: 'property_not_found' },
        { status: 404, headers: cors },
      )
    }

    // (b) Latest buyer_match_runs row for this property
    const { data: latest_run } = await supabase
      .from('buyer_match_runs')
      .select('*')
      .eq('property_id', property_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    // (c) Count of buyer_entities_v2 with property market in markets_active
    let entity_count = 0
    if (property.market) {
      const { count } = await supabase
        .from('buyer_entities_v2')
        .select('*', { count: 'exact', head: true })
        .contains('markets_active', [property.market])
      entity_count = count ?? 0
    }

    const match_count = latest_run?.candidate_count ?? 0

    return NextResponse.json(
      {
        ok: true,
        data: {
          property,
          latest_run,
          demand_summary: {
            entity_count,
            match_count,
          },
        },
      },
      { status: 200, headers: cors },
    )
  } catch (error) {
    return NextResponse.json(
      buyerMatchErrorResponse(error?.message, { error: 'fetch_failed' }),
      { status: 500, headers: cors },
    )
  }
}
