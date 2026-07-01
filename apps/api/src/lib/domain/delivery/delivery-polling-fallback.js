import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import ENV from '@/lib/config/env.js'
import { syncDeliveryEvent } from '@/lib/supabase/sms-engine.js'
import { buildSyncPayloadFromTerminalEvent, normalizeProviderEventPayload } from '@/lib/domain/webhooks/provider-event-state-machine.js'
import { warn, info } from '@/lib/logging/logger.js'

const POLL_AFTER_MS = 30 * 60 * 1000
const MAX_POLL_BATCH = 50

function clean(value) {
  return String(value ?? '').trim()
}

function getCredentials() {
  const account_sid = clean(ENV.TEXTGRID_ACCOUNT_SID || process.env.TEXTGRID_ACCOUNT_SID)
  const auth_token = clean(ENV.TEXTGRID_AUTH_TOKEN || process.env.TEXTGRID_AUTH_TOKEN)
  return { account_sid, auth_token, configured: Boolean(account_sid && auth_token) }
}

export async function lookupTextgridMessageStatus(provider_message_sid, deps = {}) {
  const sid = clean(provider_message_sid)
  if (!sid) return { ok: false, reason: 'missing_provider_message_sid' }

  const { account_sid, auth_token, configured } = getCredentials()
  if (!configured) {
    return { ok: false, reason: 'textgrid_credentials_missing', skipped: true }
  }

  const url = `https://api.textgrid.com/2010-04-01/Accounts/${encodeURIComponent(account_sid)}/Messages/${encodeURIComponent(sid)}.json`
  const token = Buffer.from(`${account_sid}:${auth_token}`, 'utf8').toString('base64')

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(15_000),
  })

  if (!response.ok) {
    return {
      ok: false,
      reason: 'provider_lookup_failed',
      status: response.status,
    }
  }

  const data = await response.json().catch(() => ({}))
  return {
    ok: true,
    status: clean(data.status || data.message_status || data.MessageStatus).toLowerCase() || null,
    error_code: clean(data.error_code || data.ErrorCode) || null,
    error_message: clean(data.error_message || data.ErrorMessage) || null,
    date_updated: data.date_updated || data.DateUpdated || null,
    raw: data,
  }
}

/**
 * Poll sent rows missing terminal delivery callbacks after POLL_AFTER_MS.
 */
export async function pollMissingDeliveryCallbacks(options = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const now = options.now || new Date().toISOString()
  const poll_after_ms = Number(options.poll_after_ms ?? POLL_AFTER_MS)
  const limit = Math.min(Math.max(Number(options.limit ?? MAX_POLL_BATCH), 1), 200)
  const cutoff = new Date(Date.now() - poll_after_ms).toISOString()

  const { data: candidates, error } = await supabase
    .from('send_queue')
    .select('id,provider_message_id,textgrid_message_id,sent_at,queue_status,delivery_confirmed,campaign_id')
    .eq('queue_status', 'sent')
    .not('provider_message_id', 'is', null)
    .lte('sent_at', cutoff)
    .order('sent_at', { ascending: true })
    .limit(limit)

  if (error) throw error

  const results = []
  for (const row of candidates || []) {
    const sid = clean(row.provider_message_id || row.textgrid_message_id)
    if (!sid) continue

    const { data: terminal_webhook } = await supabase
      .from('webhook_log')
      .select('id,processed')
      .eq('provider_message_sid', sid)
      .in('event_type', ['delivery', 'status', 'outbound'])
      .eq('processed', false)
      .limit(1)
      .maybeSingle()

    if (terminal_webhook?.id) {
      results.push({ queue_row_id: row.id, sid, action: 'skipped_pending_webhook' })
      continue
    }

    const lookup = await lookupTextgridMessageStatus(sid, deps)
    if (!lookup.ok) {
      if (lookup.skipped) {
        results.push({ queue_row_id: row.id, sid, action: 'polling_unavailable' })
        break
      }
      results.push({ queue_row_id: row.id, sid, action: 'lookup_failed', reason: lookup.reason })
      continue
    }

    if (!lookup.status || ['queued', 'pending', 'sending', 'accepted'].includes(lookup.status)) {
      results.push({ queue_row_id: row.id, sid, action: 'still_in_flight', status: lookup.status })
      continue
    }

    const synthetic = normalizeProviderEventPayload({
      provider_message_sid: sid,
      payload: {
        message_id: sid,
        status: lookup.status,
        error_message: lookup.error_message,
        error_status: lookup.error_code,
        delivered_at: lookup.date_updated,
        raw: lookup.raw,
      },
    })

    const sync_payload = buildSyncPayloadFromTerminalEvent(synthetic)
    const sync_result = await syncDeliveryEvent(sync_payload, { supabase, now })

    info('delivery_polling_fallback.reconciled', {
      queue_row_id: row.id,
      provider_message_sid: sid,
      status: lookup.status,
      send_queue_count: sync_result?.send_queue_count || 0,
    })

    results.push({
      queue_row_id: row.id,
      sid,
      action: 'reconciled_via_poll',
      status: lookup.status,
      send_queue_count: sync_result?.send_queue_count || 0,
    })
  }

  return {
    ok: true,
    scanned: (candidates || []).length,
    results: results.slice(0, 50),
  }
}