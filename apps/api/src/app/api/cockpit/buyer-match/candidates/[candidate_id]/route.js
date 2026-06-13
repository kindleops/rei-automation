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

export async function GET(request, { params }) {
  const cors = corsHeaders(request)
  const { candidate_id } = params

  try {
    const { data: candidate, error } = await supabase
      .from('buyer_match_candidates')
      .select('*, buyer_entities_v2(*)')
      .eq('candidate_id', candidate_id)
      .maybeSingle()

    if (error) throw error

    if (!candidate) {
      return NextResponse.json(
        { ok: false, error: 'candidate_not_found' },
        { status: 404, headers: cors },
      )
    }

    return NextResponse.json(
      { ok: true, data: candidate },
      { status: 200, headers: cors },
    )
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: 'fetch_failed', message: error?.message },
      { status: 500, headers: cors },
    )
  }
}

export async function PATCH(request, { params }) {
  const cors = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) {
    return NextResponse.json(
      await auth.response.json().catch(() => ({ ok: false, error: 'unauthorized' })),
      { status: auth.response.status, headers: cors },
    )
  }

  const { candidate_id } = params
  const body = await parseJsonSafe(request)

  const allowedFields = ['notes', 'buyer_response_status', 'selected', 'package_sent_at']
  const updates = {}
  for (const field of allowedFields) {
    if (body[field] !== undefined) updates[field] = body[field]
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json(
      { ok: false, error: 'no_valid_fields' },
      { status: 400, headers: cors },
    )
  }

  try {
    const { data: updated, error } = await supabase
      .from('buyer_match_candidates')
      .update(updates)
      .eq('candidate_id', candidate_id)
      .select('*')
      .single()

    if (error) throw error

    return NextResponse.json(
      { ok: true, data: updated },
      { status: 200, headers: cors },
    )
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: 'update_failed', message: error?.message },
      { status: 500, headers: cors },
    )
  }
}
