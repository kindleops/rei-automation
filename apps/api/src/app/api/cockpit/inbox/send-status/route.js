import { NextResponse } from 'next/server.js'
import { ensureDashboardReadAuth, corsHeaders } from '../../_shared.js'
import { lookupManualSendOutcome } from '@/lib/domain/inbox/send-now-outcome.js'
import { child } from '@/lib/logging/logger.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const logger = child({ module: 'api.cockpit.inbox.send_status' })

/**
 * GET /api/cockpit/inbox/send-status?client_send_id=<uuid>&thread_key=<+1XXXXXXXXXX>
 *
 * READ ONLY. Lets the composer confirm what happened to a send whose response it
 * never received (dropped connection / timed-out request) instead of reporting a
 * possibly-delivered message as failed. See send-now-outcome.js.
 */
export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function GET(request) {
  const headers = { ...corsHeaders(request), 'Cache-Control': 'no-store' }
  const auth = ensureDashboardReadAuth(request)
  if (!auth.ok) return auth.response

  const url = new URL(request.url)
  try {
    const result = await lookupManualSendOutcome({
      client_send_id: url.searchParams.get('client_send_id'),
      thread_key: url.searchParams.get('thread_key'),
    })
    return NextResponse.json(result, { status: result.status || (result.ok ? 200 : 500), headers })
  } catch (error) {
    logger.error('cockpit_send_status.failed', { error: error?.message || 'unknown_error' })
    return NextResponse.json(
      { ok: false, status: 503, error: 'send_outcome_lookup_failed' },
      { status: 503, headers }
    )
  }
}
