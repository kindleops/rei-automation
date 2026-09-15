import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth, parseJsonSafe } from '../../../_shared.js'
import { supabase } from '@/lib/supabase/client.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function withCors(request, payload, status = 200) {
  return NextResponse.json(payload, { status, headers: corsHeaders(request) })
}

async function campaignIdFromParams(params) {
  const resolved = await params
  return resolved?.id || null
}

export async function OPTIONS(request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request, { params }) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  const campaignId = await campaignIdFromParams(params)
  if (!campaignId) return withCors(request, { ok: false, error: 'campaign_id_required' }, 400)

  const url = new URL(request.url)
  const page = Math.max(1, Number(url.searchParams.get('page') || 1))
  const pageSize = Math.min(200, Math.max(10, Number(url.searchParams.get('page_size') || 50)))
  const status = url.searchParams.get('status')
  const market = url.searchParams.get('market')
  const search = url.searchParams.get('search')
  const orderBy = url.searchParams.get('order_by') || 'priority_score'
  const orderDir = url.searchParams.get('order_dir') === 'asc'

  let query = supabase
    .from('campaign_targets')
    .select('*', { count: 'exact' })
    .eq('campaign_id', campaignId)

  if (status && status !== 'all') query = query.eq('target_status', status)
  if (market) query = query.ilike('market', `%${market}%`)
  if (search) {
    query = query.or(`owner_name.ilike.%${search}%,property_address.ilike.%${search}%,to_phone_number.ilike.%${search}%`)
  }

  const ascending = orderDir
  query = query.order(orderBy, { ascending, nullsFirst: false })
  /**
   * STABLE TIEBREAKER — required, not cosmetic.
   *
   * `priority_score` (the default sort) is not unique, and Postgres gives no
   * ordering guarantee among equal keys across separate LIMIT/OFFSET queries.
   * Paging this endpoint therefore returned some rows twice and skipped others:
   * an audit of campaign df0671fa read all 984 rows but found only 812 distinct
   * property ids where 984 exist. Any per-page consumer — the Targets tab, or a
   * containment audit — silently gets a wrong answer.
   */
  query = query.order('id', { ascending: true })

  const from = (page - 1) * pageSize
  const to = from + pageSize - 1
  query = query.range(from, to)

  const { data, error, count } = await query
  if (error) return withCors(request, { ok: false, error: error.message }, 500)

  return withCors(request, {
    ok: true,
    campaign_id: campaignId,
    page,
    page_size: pageSize,
    total_count: count ?? 0,
    total_pages: count ? Math.ceil(count / pageSize) : 0,
    targets: data || [],
  })
}