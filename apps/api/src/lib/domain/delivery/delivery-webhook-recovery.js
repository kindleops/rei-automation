import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { syncDeliveryEvent, markWebhookLogProcessed } from '@/lib/supabase/sms-engine.js'

function clean(value) {
  return String(value ?? '').trim()
}

function extractDeliveryPayload(logRow = {}) {
  const payload = logRow.payload && typeof logRow.payload === 'object' ? logRow.payload : {}
  const raw = payload.raw && typeof payload.raw === 'object' ? payload.raw : {}
  return {
    message_id:
      clean(payload.message_id) ||
      clean(raw.MessageSid) ||
      clean(raw.SmsSid) ||
      clean(logRow.provider_message_sid),
    status:
      clean(payload.status) ||
      clean(raw.MessageStatus) ||
      clean(raw.SmsStatus),
    raw,
    ...payload,
  }
}

export async function recoverUnprocessedDeliveryWebhooks(options = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const limit = Math.max(Number(options.limit ?? 25), 1)
  const now = options.now || new Date().toISOString()

  const { data: rows, error } = await supabase
    .from('webhook_log')
    .select('id,provider_message_sid,payload,event_type,processed,created_at')
    .eq('processed', false)
    .in('event_type', ['delivery', 'status', 'outbound'])
    .order('created_at', { ascending: true })
    .limit(limit)
  if (error) throw error

  let recovered = 0
  let failed = 0
  const results = []

  for (const row of rows || []) {
    const payload = extractDeliveryPayload(row)
    if (!payload.message_id || !payload.status) {
      failed += 1
      results.push({ webhook_log_id: row.id, ok: false, reason: 'missing_message_or_status' })
      continue
    }

    try {
      const result = await syncDeliveryEvent(
        {
          ...payload,
          provider_message_sid: payload.message_id,
          webhook_log_id: row.id,
        },
        { supabase, now, force_local_delivery_reconcile: false }
      )

      if (Number(result?.send_queue_count || 0) > 0 || Number(result?.message_events_count || 0) > 0) {
        await markWebhookLogProcessed(row.id, { supabase, now })
        recovered += 1
        results.push({
          webhook_log_id: row.id,
          ok: true,
          provider_message_sid: payload.message_id,
          final_delivery_status: result.final_delivery_status || null,
        })
      } else {
        await markWebhookLogProcessed(row.id, { supabase, now })
        recovered += 1
        results.push({
          webhook_log_id: row.id,
          ok: true,
          provider_message_sid: payload.message_id,
          note: 'marked_processed_without_queue_match',
        })
      }
    } catch (recoveryError) {
      failed += 1
      results.push({
        webhook_log_id: row.id,
        ok: false,
        reason: recoveryError?.message || 'recovery_failed',
      })
    }
  }

  return {
    ok: true,
    scanned: (rows || []).length,
    recovered,
    failed,
    results: results.slice(0, 25),
  }
}