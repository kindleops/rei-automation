import { NextResponse } from 'next/server.js'
import { parseJsonSafe, ensureMutationAuth, corsHeaders } from '../../_shared.js'
import { runInboxAction } from '@/lib/cockpit/cockpit-service.js'
import { child } from '@/lib/logging/logger.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const logger = child({ module: 'api.cockpit.inbox.send_now' })

// ── Handlers ──────────────────────────────────────────────────────────────────

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

export async function POST(request) {
  const cors = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  const payload = await parseJsonSafe(request)


  logger.info('cockpit_send_now.route_request', {
    thread_key: String(payload?.thread_key ?? payload?.metadata?.thread_key ?? payload?.to_phone_number ?? '').trim() || null,
    to_phone_number: String(payload?.to_phone_number ?? payload?.phone ?? '').trim() || null,
    from_phone_number: String(payload?.from_phone_number ?? payload?.our_number ?? '').trim() || null,
    message_body_length: String(payload?.message_body ?? payload?.message_text ?? '').trim().length,
  })
  
  try {
    const result = await runInboxAction({ action: 'send-now', payload: { ...payload, dry_run: false } })
    const status = result.ok ? 200 : Number(result.status || (result.reason === 'invalid_canonical_thread_key' ? 400 : 423))
    logger.info('cockpit_send_now.route_response', {
      ok: result.ok,
      status,
      reason: result.reason || null,
      queue_inserted: result.queue_inserted === true,
      queue_row_id: result.queue_row_id || null,
      queue_id: result.queue_id || null,
    })
    return NextResponse.json(result, { status, headers: cors })
  } catch (error) {
    logger.error('cockpit_send_now.route_failed', { error: error?.message || 'unknown_error' })
    return NextResponse.json(
      { ok: false, error: 'send_now_failed', message: error?.message },
      { status: 500, headers: cors }
    )
  }
}
