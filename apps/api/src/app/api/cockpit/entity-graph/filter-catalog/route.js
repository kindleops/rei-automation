import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, corsHeaders } from '../../_shared.js'
import {
  ENTITY_GRAPH_FILTERABLE_TABS,
  getEntityGraphFilterCatalog,
} from '@/lib/domain/entity-graph/entity-graph-field-filters.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

/**
 * The filter fields a tab can actually execute, derived from the campaign field
 * catalog -- the same definitions the campaign builder targets from. The list
 * is intentionally NOT a second catalog: adding a field to FIELD_GROUPS gives
 * Entity Graph the filter, and removing one takes it away from both.
 */
export async function GET(request) {
  const headers = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) {
    return NextResponse.json(
      await auth.response.json().catch(() => ({ ok: false, error: 'unauthorized' })),
      { status: auth.response.status, headers },
    )
  }

  const { searchParams } = new URL(request.url)
  const tab = (searchParams.get('tab') || 'properties').trim().toLowerCase()
  const catalog = getEntityGraphFilterCatalog(tab)

  if (!catalog.source) {
    return NextResponse.json(
      {
        ok: false,
        error: 'tab_does_not_support_field_filters',
        tab,
        filterable_tabs: ENTITY_GRAPH_FILTERABLE_TABS,
      },
      { status: 422, headers },
    )
  }

  return NextResponse.json(
    { ok: true, ...catalog, filterable_tabs: ENTITY_GRAPH_FILTERABLE_TABS },
    { status: 200, headers },
  )
}
