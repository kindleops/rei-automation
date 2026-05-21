import dotenv from 'dotenv'
import path from 'path'
import { createClient } from '@supabase/supabase-js'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

// SAFETY GUARD: Backend mutation scripts must run from real-estate-automation, not nexus-dashboard.
if (process.env.NEXUS_ALLOW_BACKEND_MUTATION !== 'true') {
  console.error('BLOCKED: Backend mutation scripts must run from real-estate-automation, not nexus-dashboard.')
  console.error('Set NEXUS_ALLOW_BACKEND_MUTATION=true only for authorized incident response.')
  process.exit(1)
}

const BAD_BATCH_SCHEDULED_FOR = process.argv[2] || '2026-05-19T19:13:26.479Z'

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !serviceKey) {
  console.error('Missing SUPABASE URL or SUPABASE_SERVICE_ROLE_KEY in env.')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

const ACTIVE_STATUSES = ['queued', 'scheduled', 'ready', 'pending', 'approved', 'sending', 'failed']

async function main() {
  const now = new Date().toISOString()

  const { data: beforeRows, error: beforeErr } = await supabase
    .from('send_queue')
    .select('id,queue_status,scheduled_for,sent_at,failed_reason,blocked_reason,retry_count,metadata,to_phone_number,master_owner_id,touch_number,provider_message_id,textgrid_message_id')
    .eq('scheduled_for', BAD_BATCH_SCHEDULED_FOR)

  if (beforeErr) throw beforeErr
  const rows = beforeRows || []

  const toPause = rows.filter((r) => ACTIVE_STATUSES.includes(String(r.queue_status || '').toLowerCase()))
  const sentAlready = rows.filter((r) => ['sent', 'delivered'].includes(String(r.queue_status || '').toLowerCase()))

  let pausedCount = 0
  if (toPause.length > 0) {
    const ids = toPause.map((r) => r.id)
    const { data: updatedRows, error: updateErr } = await supabase
      .from('send_queue')
      .update({
        queue_status: 'paused_review',
        paused_reason: 'incident_freeze_2026_05_19_batch',
        guard_reason: 'INCIDENT_NO_AUTO_RETRY',
        blocked_reason: 'incident_review_hold',
        updated_at: now,
      })
      .in('id', ids)
      .select('id')
    if (updateErr) throw updateErr
    pausedCount = (updatedRows || []).length
  }

  let deliveredFlaggedCount = 0
  if (sentAlready.length > 0) {
    const sentIds = sentAlready.map((r) => r.id)
    const { data: sentFlaggedRows, error: sentFlagErr } = await supabase
      .from('send_queue')
      .update({
        blocked_reason: 'incident_review_delivered_from_bad_batch',
        guard_reason: 'INCIDENT_NO_AUTO_RETRY',
        updated_at: now,
      })
      .in('id', sentIds)
      .select('id')
    if (sentFlagErr) throw sentFlagErr
    deliveredFlaggedCount = (sentFlaggedRows || []).length
  }

  const { data: finalRows, error: finalErr } = await supabase
    .from('send_queue')
    .select('id,queue_status,scheduled_for,sent_at,failed_reason,blocked_reason,retry_count,metadata,to_phone_number,master_owner_id,touch_number,provider_message_id,textgrid_message_id,created_at,updated_at')
    .eq('scheduled_for', BAD_BATCH_SCHEDULED_FOR)
    .order('created_at', { ascending: true })

  if (finalErr) throw finalErr

  const grouped = {}
  for (const row of finalRows || []) {
    const s = String(row.queue_status || 'unknown')
    grouped[s] = (grouped[s] || 0) + 1
  }

  const providerIds = (finalRows || []).map((r) => String(r.provider_message_id || '').trim()).filter(Boolean)
  const windowStart = '2026-05-19T19:10:00.000Z'
  const windowEnd = '2026-05-19T19:20:00.000Z'
  const { data: eventRows, error: eventErr } = await supabase
    .from('message_events')
    .select('id,provider_message_sid,direction,delivery_status,provider_delivery_status,error_message,failure_reason,failure_bucket,from_phone_number,to_phone_number,thread_key,event_timestamp,created_at,metadata')
    .gte('created_at', windowStart)
    .lte('created_at', windowEnd)
    .order('created_at', { ascending: true })
  if (eventErr) throw eventErr

  const batchEvents = (eventRows || []).filter((e) => providerIds.includes(String(e.provider_message_sid || '').trim()))
  const eventStatusGroups = {}
  const failureReasonGroups = {}
  for (const e of batchEvents) {
    const statusKey = `${String(e.delivery_status || 'null')}|${String(e.provider_delivery_status || 'null')}`
    eventStatusGroups[statusKey] = (eventStatusGroups[statusKey] || 0) + 1
    const reasonKey = String(e.failure_reason || e.error_message || 'none')
    failureReasonGroups[reasonKey] = (failureReasonGroups[reasonKey] || 0) + 1
  }

  const detail = (finalRows || []).map((row) => ({
    id: row.id,
    queue_status: row.queue_status,
    to_phone_number: row.to_phone_number,
    master_owner_id: row.master_owner_id,
    touch_number: row.touch_number,
    retry_count: row.retry_count,
    failed_reason: row.failed_reason,
    blocked_reason: row.blocked_reason,
    provider_message_id: row.provider_message_id,
    textgrid_message_id: row.textgrid_message_id,
    metadata_error: row.metadata?.error || row.metadata?.provider_error || row.metadata?.textgrid_error || null,
    metadata_response_body:
      row.metadata?.response_body ||
      row.metadata?.provider_response_body ||
      row.metadata?.textgrid_response_body ||
      null,
  }))

  console.log(
    JSON.stringify(
      {
        batch_scheduled_for: BAD_BATCH_SCHEDULED_FOR,
        total_rows: rows.length,
        paused_count: pausedCount,
        already_sent_or_delivered: sentAlready.length,
        delivered_or_sent_flagged_count: deliveredFlaggedCount,
        grouped_by_queue_status: grouped,
        message_events_window_start: windowStart,
        message_events_window_end: windowEnd,
        message_events_matched_by_provider_message_sid_count: batchEvents.length,
        message_events_grouped_delivery_status: eventStatusGroups,
        message_events_grouped_failure_reason: failureReasonGroups,
        rows: detail,
      },
      null,
      2,
    ),
  )
}

main().catch((err) => {
  console.error('[incident-batch-freeze] error:', err)
  process.exit(1)
})
