import { NextResponse } from 'next/server.js'
import { ensureMutationAuth } from '../../_shared.js'
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

function clean(value) {
  return String(value ?? '').trim()
}

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  const cors = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) {
    return NextResponse.json(
      await auth.response.json().catch(() => ({ ok: false, error: 'unauthorized' })),
      { status: auth.response.status, headers: cors },
    )
  }

  try {
    const { searchParams } = new URL(request.url)
    const offset = Math.max(0, Number.parseInt(clean(searchParams.get('cursor') ?? searchParams.get('offset')) || '0', 10) || 0)
    const pageLimit = Math.min(200, Math.max(1, Number.parseInt(clean(searchParams.get('limit')) || '100', 10) || 100))
    const queryText = clean(searchParams.get('q'))

    let query = supabase
      .from('v_inbox_enriched')
      .select('*', { count: 'exact' })
      .order('latest_message_at', { ascending: false, nullsFirst: false })
      .range(offset, offset + pageLimit - 1)

    if (queryText) {
      const q = `%${queryText}%`
      query = query.or([
        `prospect_full_name.ilike.${q}`,
        `owner_display_name.ilike.${q}`,
        `seller_display_name.ilike.${q}`,
        `property_address_full.ilike.${q}`,
        `best_phone.ilike.${q}`,
        `seller_phone.ilike.${q}`,
        `thread_key.ilike.${q}`,
        `detected_intent.ilike.${q}`,
        `filter_market.ilike.${q}`,
      ].join(','))
    }

    const [{ data, error, count }, countsRes] = await Promise.all([
      query,
      supabase.from('inbox_category_counts').select('*').limit(1),
    ])

    if (error) throw error
    const rows = Array.isArray(data) ? data : []
    const total = Number.isFinite(Number(count)) ? Number(count) : rows.length
    const pageThreads = rows
    const nextOffset = offset + pageThreads.length
    const countsRow = Array.isArray(countsRes.data) && countsRes.data.length > 0 ? countsRes.data[0] : null
    const counts = countsRow || { all: total }
    const diagnostics = {
      threads: pageThreads,
      counts,
      pagination: {
        cursor: String(offset),
        next_cursor: nextOffset < total ? String(nextOffset) : null,
        has_more: nextOffset < total,
        limit: pageLimit,
        total,
      },
    }
    return NextResponse.json({ ok: true, action: 'inbox-threads', diagnostics }, { status: 200, headers: cors })
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        action: 'inbox-threads',
        error: 'inbox_threads_failed',
        message: error?.message || 'Unknown inbox threads error',
      },
      { status: 500, headers: cors },
    )
  }
}
