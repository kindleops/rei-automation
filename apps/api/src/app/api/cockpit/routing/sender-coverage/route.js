import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth, parseJsonSafe } from '../../_shared.js'
import { previewMarketRoutes, readSenderCoverage, saveMarketRoutes } from '@/lib/domain/routing/sender-routing/sender-routing-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

function withCors(request, payload, status = 200) {
  return NextResponse.json(payload, { status, headers: corsHeaders(request) })
}

export async function OPTIONS(request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) })
}

/**
 * GET — Sender Coverage (Sender Routing 2.0). READ-ONLY: markets x ordered
 * pools x health, LOCAL / REGIONAL / DEGRADED / UNCOVERED, metrics. Shows the
 * PROPOSED graph (labelled) until the routing schema is applied.
 */
export async function GET(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response
  try {
    return withCors(request, await readSenderCoverage())
  } catch (error) {
    console.error('routing.sender_coverage_read_failed', error)
    return withCors(request, { ok: false, error: 'sender_coverage_read_failed', message: error?.message || String(error) }, 500)
  }
}

/**
 * POST — { action: 'preview', market_id, routes }            READ-ONLY impact preview
 *        { action: 'save', market_id, routes, reason }        GATED write (graph-writes gate),
 *                                                              audited + versioned, operator-only
 */
export async function POST(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response
  const body = await parseJsonSafe(request)
  const action = String(body?.action || '')
  const operator = auth.auth?.email || auth.auth?.user_id || auth.auth?.operator || null
  try {
    let result
    if (action === 'preview') result = await previewMarketRoutes(body)
    else if (action === 'save') result = await saveMarketRoutes(body, { operator })
    else return withCors(request, { ok: false, error: 'unknown_action' }, 400)
    return withCors(request, result, result.ok === false ? Number(result.status || 409) : 200)
  } catch (error) {
    console.error('routing.sender_coverage_write_failed', action, error)
    return withCors(request, { ok: false, error: 'sender_coverage_action_failed', action, message: error?.message || String(error) }, 500)
  }
}
