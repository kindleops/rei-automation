import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, corsHeaders } from '../../_shared.js'
import { supabase } from '@/lib/supabase/client.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function clean(value) {
  return String(value ?? '').trim()
}

const DIMENSION_MAP = {
  template: 'template_performance_kpis_v',
  number: 'number_performance_kpis_v',
  market: 'market_performance_kpis_v',
  property_type: 'property_type_performance_kpis_v',
  seller_signal: 'seller_signal_performance_kpis_v',
  property_signal: 'property_signal_performance_kpis_v',
  owner_type: 'owner_type_performance_kpis_v',
  stage: 'stage_performance_kpis_v',
  touch: 'touch_performance_kpis_v',
  language: 'language_performance_kpis_v',
  trends: 'performance_trends_v',
  outliers: 'performance_outliers_v',
  attribution: 'performance_message_events_v',
}

const FILTER_COLUMN_MAP = {
  template: 'template_key',
  number: 'textgrid_number_key',
  market: 'market',
  property_type: 'property_type',
  seller_signal: 'seller_signal',
  property_signal: 'podio_tags',
  owner_type: 'owner_type',
  stage: 'current_stage',
  touch: 'touch_number',
  language: 'language',
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
    const dimension = clean(searchParams.get('dimension'))
    const time_window = clean(searchParams.get('time_window'))
    const limit = parseInt(searchParams.get('limit') ?? '100', 10)
    const view = DIMENSION_MAP[dimension]

    if (!view) {
      return NextResponse.json({ ok: false, error: 'invalid_dimension' }, { status: 400, headers: cors })
    }

    let query = supabase.from(view).select('*')

    if (time_window && dimension !== 'trends' && dimension !== 'outliers' && dimension !== 'attribution') {
      query = query.eq('time_window', time_window)
    }

    const filterCol = FILTER_COLUMN_MAP[dimension]
    const filterVal = searchParams.get('filter_value')
    if (filterCol && filterVal) {
      query = query.eq(filterCol, filterVal)
    }

    // Special case for number view which also has market
    if (dimension === 'number' && searchParams.get('market')) {
        query = query.eq('market', searchParams.get('market'))
    }

    if (dimension === 'trends') {
      query = query.order('trend_date', { ascending: false })
    } else if (dimension !== 'outliers' && dimension !== 'attribution') {
      query = query.order('sends', { ascending: false })
    }

    if (dimension === 'attribution') {
        const type = searchParams.get('type') // 'total' or 'known'
        query = query.eq('direction', 'outbound')
        if (type === 'known') {
            query = query.neq('template_key', 'unknown')
        }
        const { count, error } = await query.select('*', { count: 'exact', head: true })
        if (error) throw error
        return NextResponse.json({ ok: true, count: count ?? 0 }, { status: 200, headers: cors })
    }

    const { data, error } = await query.limit(limit)
    if (error) throw error

    return NextResponse.json({ ok: true, data }, { status: 200, headers: cors })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500, headers: cors }
    )
  }
}
