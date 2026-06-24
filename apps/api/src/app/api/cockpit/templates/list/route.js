import { NextResponse } from 'next/server.js'
import { ensureMutationAuth } from '../../_shared.js'
import { supabase } from '@/lib/supabase/client.js'
import { createRequestTimer } from '@/lib/cockpit/server-timing.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TEMPLATE_COLUMNS = [
  'id', 'template_id', 'is_active', 'use_case', 'stage_code', 'language', 'template_body', 'updated_at',
].join(',')

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
  const limit = Math.max(1, Math.min(500, Number(searchParams.get('limit') || 200)))
  const includeInactive = ['1', 'true', 'yes'].includes(String(searchParams.get('includeInactive') || searchParams.get('include_inactive') || '').toLowerCase())

  try {
    let query = supabase
      .from('sms_templates')
      .select(TEMPLATE_COLUMNS)
      .order('updated_at', { ascending: false })
      .limit(limit)
    if (!includeInactive) query = query.eq('is_active', true)

    const { data, error } = await query
    timer.mark('supabase_query', { error: error?.message || null })
    if (error) throw error

    const templates = Array.isArray(data) ? data : []
    return NextResponse.json({
      ok: true,
      action: 'templates-list',
      templates,
      count: templates.length,
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