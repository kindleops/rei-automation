import { supabase } from '@/lib/supabase/client.js'
import { evaluateContactWindow } from '@/lib/supabase/sms-engine.js'
import { evaluateQueueSendRuntimeBrakes } from '@/lib/domain/queue/queue-control-safety.js'
import { evaluateSmsHealthGuard } from '@/lib/domain/delivery/sms-health-guard.js'
import { getSystemValue } from '@/lib/system-control.js'

const now = new Date()
const nowIso = now.toISOString()

const { data: rows, error } = await supabase
  .from('send_queue')
  .select('id,queue_status,scheduled_for,scheduled_for_utc,to_phone_number,from_phone_number,master_owner_id,property_id,message_type,metadata,retry_count,provider_status,updated_at')
  .in('queue_status', ['scheduled', 'queued', 'pending'])
  .order('scheduled_for_utc', { ascending: true, nullsFirst: false })
  .limit(5)

if (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2))
  process.exit(1)
}

const row = rows?.[0]
if (!row) {
  console.log(JSON.stringify({ ok: true, message: 'no_scheduled_rows_found', now: nowIso }, null, 2))
  process.exit(0)
}

const scheduledFor = row.scheduled_for_utc || row.scheduled_for
const due = scheduledFor ? new Date(scheduledFor) <= now : null
const contactWindow = await evaluateContactWindow(row, { now: nowIso })
const brakes = await evaluateQueueSendRuntimeBrakes({ now: nowIso })
const smsHealth = await evaluateSmsHealthGuard({ now: nowIso })
const processorMode = await getSystemValue('queue_processor_mode').catch(() => null)
const outboundEnabled = await getSystemValue('outbound_enabled').catch(() => null)

console.log(JSON.stringify({
  ok: true,
  now: nowIso,
  row: {
    id: row.id,
    queue_status: row.queue_status,
    scheduled_for: scheduledFor,
    to_phone_number: row.to_phone_number,
    from_phone_number: row.from_phone_number,
    master_owner_id: row.master_owner_id,
    property_id: row.property_id,
    retry_count: row.retry_count,
    provider_status: row.provider_status,
  },
  chain: {
    due_evaluation: due,
    contact_window: contactWindow,
    queue_processor_mode: processorMode,
    outbound_enabled: outboundEnabled,
    runtime_brakes: brakes,
    sms_health_guard: smsHealth,
    claim_eligible_statuses: ['scheduled', 'queued', 'pending'].includes(String(row.queue_status || '').toLowerCase()),
    transmission_blocked_reason: !due
      ? 'waiting_for_scheduled_time'
      : contactWindow?.ok === false
        ? `contact_window:${contactWindow?.reason || 'blocked'}`
        : brakes?.ok === false
          ? `runtime_brake:${brakes?.reason || 'blocked'}`
          : smsHealth?.ok === false
            ? `sms_health:${smsHealth?.reason || 'blocked'}`
            : outboundEnabled === false || outboundEnabled === 'false'
              ? 'outbound_disabled'
              : 'eligible_for_claim_evaluation',
  },
}, null, 2))