import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, parseJsonSafe } from '../../../../_shared.js'
import { supabase } from '@/lib/supabase/client.js'
import { buildBuyerMatchDiagnostics } from '@/lib/domain/buyers/match-engine.js'

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

  try {
    // 1. Fetch latest valuation snapshot
    const { data: snapshot } = await supabase
      .from('property_valuation_snapshots')
      .select('*')
      .eq('property_id', property_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    // 2. Fetch property info
    const { data: property } = await supabase
      .from('properties')
      .select('*')
      .eq('property_id', property_id)
      .maybeSingle()

    if (!property) {
      return NextResponse.json({ ok: false, error: 'property_not_found' }, { status: 404, headers: cors })
    }

    // 3. Run match engine (Podio-based)
    // Note: This currently expects Podio item IDs, so it might fail for Supabase-only properties
    // We'll return the snapshot data for local matching in the UI as well.
    const matchResult = await buildBuyerMatchDiagnostics({
      property_id: property.item_id || property_id,
    })

    return NextResponse.json({ 
      ok: true, 
      action: 'run-buyer-match',
      data: {
        snapshot,
        matches: matchResult
      } 
    }, { status: 200, headers: cors })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: 'buyer_match_failed', message: error?.message },
      { status: 500, headers: cors }
    )
  }
}
