import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth, unauthorizedJson } from '../_shared.js'
import { getClosingPortfolio } from '@/lib/domain/closings/closing-execution-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

/**
 * GET /api/cockpit/closing-desk/execution?sort=most_urgent|next_closing|recently_updated|recently_closed[&view=summary]
 * The closing portfolio: every live closing + recent closed/cancelled, each
 * derived by closing-execution-model.js. Read-only. `view=summary` returns the
 * portfolio row projection (the desktop navigation); the room loads by id.
 */
export async function GET(request) {
  const headers = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return unauthorizedJson(auth.response, headers)
  try {
    const params = new URL(request.url).searchParams
    const sort = params.get('sort') || 'most_urgent'
    const view = params.get('view') === 'summary' ? 'summary' : 'full'
    const data = await getClosingPortfolio({ sort, view })
    return NextResponse.json({ ok: true, data }, { status: 200, headers })
  } catch (error) {
    return NextResponse.json({ ok: false, error: error?.message || 'closing_portfolio_failed' }, { status: 500, headers })
  }
}
