import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth } from '../../_shared.js'
import { parseAdvancedFiltersParam } from '@/lib/domain/inbox/inbox-advanced-filters.js'
import { queryInboxFilterOptions } from '@/lib/domain/inbox/inbox-hydrated-filter-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const cors = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  try {
    const { searchParams } = new URL(request.url)
    const field = searchParams.get('field')
    if (!field) {
      return NextResponse.json({ ok: false, error: 'field_required' }, { status: 400, headers: cors })
    }
    const entries = Object.fromEntries(searchParams.entries())
    const context = {
      ...parseAdvancedFiltersParam(entries),
      filter: entries.filter || entries.inbox_bucket || undefined,
      inbox_bucket: entries.inbox_bucket || entries.filter || undefined,
    }
    const search = searchParams.get('search') || ''
    const result = await queryInboxFilterOptions({ field, filters: context, search })
    return NextResponse.json({ ok: true, ...result }, { status: 200, headers: cors })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error?.message || 'filter_options_failed' },
      { status: 500, headers: cors },
    )
  }
}

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}