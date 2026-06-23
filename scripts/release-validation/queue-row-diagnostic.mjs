#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const API_ROOT = path.join(ROOT, 'apps/api')

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const normalized = line.startsWith('export ') ? line.slice(7).trim() : line
    const idx = normalized.indexOf('=')
    if (idx <= 0) continue
    const key = normalized.slice(0, idx).trim()
    const value = normalized.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '')
    if (!process.env[key]) process.env[key] = value
  }
}

loadEnvFile(path.join(API_ROOT, '.env.local'))

const { supabase } = await import(path.join(API_ROOT, 'src/lib/supabase/client.js'))
const { evaluateContactWindow } = await import(path.join(API_ROOT, 'src/lib/supabase/sms-engine.js'))
const { evaluateQueueSendRuntimeBrakes } = await import(path.join(API_ROOT, 'src/lib/domain/queue/queue-control-safety.js'))
const { evaluateSmsHealthGuard } = await import(path.join(API_ROOT, 'src/lib/domain/delivery/sms-health-guard.js'))
const { getSystemValue } = await import(path.join(API_ROOT, 'src/lib/system-control.js'))

const now = new Date()
const nowIso = now.toISOString()

const { data: rows, error } = await supabase
  .from('send_queue')
  .select('id,queue_status,status,scheduled_for,scheduled_for_utc,to_phone_number,from_phone_number,master_owner_id,property_id,message_type,metadata,retry_count,provider_status,updated_at')
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

const diagnosis = {
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
}

console.log(JSON.stringify(diagnosis, null, 2))