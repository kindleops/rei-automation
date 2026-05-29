import { NextResponse } from 'next/server.js'
import { ensureMutationAuth } from '../../../_shared.js'
import { getDealContextByThread } from '@/lib/domain/deal-context/deal-context-service.js'
import { corsHeaders, unauthorizedJson } from '../../_shared.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request, { params }) {
  const headers = corsHeaders(request)

  try {
    const auth = ensureMutationAuth(request)
    if (!auth.ok) return unauthorizedJson(auth.response, headers)

    const thread_key = String(params.thread_key || '').trim()
    console.log('[DEAL_CONTEXT_ROUTE_START]', { thread_key })

    let row = null
    let routeError = null
    let partial = false

    try {
      row = await getDealContextByThread(thread_key)
    } catch (error) {
      routeError = error?.message || 'deal_context_thread_fetch_failed'
      console.error('[DEAL_CONTEXT_ROUTE_ERROR]', { thread_key, error: routeError })
    }

    if (!row && routeError) {
      return NextResponse.json(
        {
          ok: false,
          fallback: true,
          error: routeError,
          diagnostics: { thread_key, stage: 'primary_and_fallback_failed' },
        },
        { status: 200, headers },
      )
    }

    if (!row) {
      console.warn('[DEAL_CONTEXT_ROUTE_DONE]', { ok: false, thread_key, reason: 'not_found' })
      return NextResponse.json(
        {
          ok: false,
          fallback: true,
          error: 'deal_context_not_found',
          diagnostics: { thread_key },
        },
        { status: 200, headers },
      )
    }

    partial = Boolean(row._partial)
    if (partial) {
      console.log('[DEAL_CONTEXT_ROUTE_PARTIAL_FALLBACK]', { thread_key, propertyId: row.property_id, masterOwnerId: row.master_owner_id })
    }

    console.log('[DEAL_CONTEXT_ROUTE_DONE]', {
      ok: true,
      thread_key,
      propertyId: row.property_id || null,
      prospectId: row.prospect_id || null,
      masterOwnerId: row.master_owner_id || null,
      coordsResolved: Boolean(row.latitude && row.longitude),
      partial,
    })

    return NextResponse.json(
      { ok: true, data: row, partial },
      { status: 200, headers },
    )
  } catch (fatal) {
    const errMsg = fatal?.message || 'deal_context_route_fatal'
    console.error('[DEAL_CONTEXT_ROUTE_FATAL]', { error: errMsg })
    return NextResponse.json(
      { ok: false, fallback: true, error: errMsg },
      { status: 200, headers },
    )
  }
}
