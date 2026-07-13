import { NextResponse } from 'next/server.js'
import { ensureMutationAuth } from '../../_shared.js'
import { supabase } from '@/lib/supabase/client.js'
import { createRequestTimer } from '@/lib/cockpit/server-timing.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function corsHeaders(_request) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-ops-dashboard-secret, X-Requested-With, Accept',
    'Access-Control-Max-Age': '86400',
  }
}

export async function GET(request) {
  const cors = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  const timer = createRequestTimer('templates-list')
  const { searchParams } = new URL(request.url)
  const useCase = String(searchParams.get('use_case') || searchParams.get('useCase') || '').trim()
  const language = String(searchParams.get('language') || searchParams.get('lang') || '').trim()
  const defaultLimit = useCase ? 5000 : 200
  const maxLimit = useCase ? 5000 : 500
  const limit = Math.max(1, Math.min(maxLimit, Number(searchParams.get('limit') || defaultLimit)))
  const includeInactive = ['1', 'true', 'yes'].includes(String(searchParams.get('includeInactive') || searchParams.get('include_inactive') || '').toLowerCase())

  try {
    const buildQuery = () => {
      let query = supabase
        .from('sms_templates')
        .select('*')
        .order('updated_at', { ascending: false })
      if (!includeInactive) query = query.eq('is_active', true)
      if (useCase) query = query.eq('use_case', useCase)
      if (language) query = query.eq('language', language)
      return query
    }

    const pageSize = Math.min(limit, 1000)
    const templates = []
    let from = 0
    while (templates.length < limit) {
      const to = Math.min(from + pageSize - 1, from + limit - templates.length - 1)
      const { data, error } = await buildQuery().range(from, to)
      timer.mark('supabase_query', { error: error?.message || null, from, to })
      if (error) throw error
      const page = Array.isArray(data) ? data : []
      templates.push(...page)
      if (page.length < pageSize) break
      from += pageSize
    }

    const trimmedTemplates = templates.slice(0, limit)
    return NextResponse.json({
      ok: true,
      action: 'templates-list',
      templates: trimmedTemplates,
      count: trimmedTemplates.length,
      queryMs: timer.summary().totalMs,
      sourceUsed: 'api:templates-list',
      timing: timer.summary(),
    }, { status: 200, headers: cors })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error?.message || 'templates_list_failed' },
      { status: 500, headers: cors },
    )
  }
}

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}