import { NextResponse } from 'next/server.js'
import { ensureDashboardReadAuth, corsHeaders } from '../../_shared.js'
import { getInboxLedgerFacts, parseLedgerFactKeys } from '@/lib/domain/inbox/inbox-ledger-facts.js'
import { createRequestTimer } from '@/lib/cockpit/server-timing.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/cockpit/inbox/ledger-facts?keys=<thread_key>,<thread_key>,…
 *
 * Read-only. The desktop Inbox ledger's per-row state for the rows it is
 * showing (see inbox-ledger-facts.js). The list endpoint's compact contract
 * is unchanged; this is the explicit opt-in for the richer projection.
 */
export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  const cors = corsHeaders(request)
  const auth = ensureDashboardReadAuth(request)
  if (!auth.ok) return auth.response

  const timer = createRequestTimer('inbox-ledger-facts')
  try {
    const { searchParams } = new URL(request.url)
    const keys = parseLedgerFactKeys(searchParams.get('keys') || searchParams.get('thread_keys') || '')
    timer.mark('auth_config')
    const { facts, missing } = await getInboxLedgerFacts(keys)
    timer.mark('supabase_query')
    const timing = timer.summary()
    return NextResponse.json(
      { ok: true, facts, missing, requested: keys.length, queryMs: timing.totalMs, timing },
      { status: 200, headers: cors },
    )
  } catch (error) {
    // A failed enrichment is not a failed Inbox: the ledger keeps its rows and
    // simply shows no derived state for them.
    return NextResponse.json(
      { ok: false, error: 'ledger_facts_failed', message: error?.message || String(error), facts: {} },
      { status: 200, headers: cors },
    )
  }
}
