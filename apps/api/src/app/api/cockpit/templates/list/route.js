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
  /*
   * A SEARCH MUST BE ABLE TO REACH TEMPLATES THE LIST DOES NOT LOAD.
   *
   * There are 8,782 active templates. Without a use_case the cap here is 500,
   * so the mobile browser was showing 5.7% of them and filtering that subset
   * client-side -- a search that reports "no templates match" while thousands
   * of matches sit unloaded. Pulling all 8,782 full rows to a phone is not the
   * answer either (select('*') on this table is heavy).
   *
   * So a search term is pushed down to the database and allowed a larger
   * ceiling than the unfiltered browse. Narrow query, bounded result.
   */
  const q = String(searchParams.get('q') || searchParams.get('query') || '').trim()
  const defaultLimit = useCase ? 5000 : 200
  const maxLimit = useCase ? 5000 : (q ? 2000 : 500)
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
      if (q) {
        // Escape PostgREST's or() delimiters before interpolation.
        const safe = q.replace(/[(),*]/g, ' ').trim()
        if (safe) {
          // Column names verified against information_schema: the body column
          // is `template_body`. An earlier draft said `template_text`, which
          // does not exist -- and one unknown column makes PostgREST reject the
          // WHOLE query, so every search silently returned zero results.
          // Values are quoted because they contain spaces.
          query = query.or(
            [
              `use_case.ilike."*${safe}*"`,
              `stage_code.ilike."*${safe}*"`,
              `stage_label.ilike."*${safe}*"`,
              `template_name.ilike."*${safe}*"`,
              `template_body.ilike."*${safe}*"`,
            ].join(','),
          )
        }
      }
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