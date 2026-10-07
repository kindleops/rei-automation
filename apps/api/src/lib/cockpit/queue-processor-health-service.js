import { supabase } from '@/lib/supabase/client.js'
import { readThroughCache } from '@/lib/dashboard/ops-cache.js'
import { createRequestTimer } from './server-timing.js'

const ACTIVE_CANONICAL_STATUSES = ['queued', 'pending', 'approval', 'scheduled', 'processing']

/*
 * OVERDUE, NOT MERELY OLD (2026-10-07). A row is a health problem when it is
 * past its due time and nothing has moved it — not because it was created or
 * last touched a while ago. The earlier definitions counted every
 * future-scheduled row as "stale" (85 rows due later that morning) and every
 * queued row created >15 min ago as "lag", so the machine badge read Degraded
 * permanently.
 *
 *   due_at              scheduled_for_utc, or created_at when it is null
 *   overdue_active      queued/pending/scheduled/processing, due_at < now - 15m
 *   lag_active          overdue_active ∩ queued/pending/processing
 *   stale_active        overdue_active ∩ updated_at < now - 15m
 *   refused_repeatedly  active rows the dispatcher refused >= 5 times in a row
 *                       (attention, never degraded; excluded from the three
 *                       counts above, which are about rows nothing is handling)
 *
 * Approval rows are held for a person by design: never overdue, never stale;
 * they keep their own count. The same definitions live in the RPC
 * (supabase/migrations/PROPOSED_20261007120000_queue_health_overdue_semantics.sql).
 */
export const OVERDUE_GRACE_MS = 15 * 60 * 1000
export const REFUSAL_ATTENTION_THRESHOLD = 5
const OVERDUE_STATUSES = ['queued', 'pending', 'scheduled', 'processing']
const LAG_STATUSES = new Set(['queued', 'pending', 'processing'])
const OVERDUE_ROW_PROBE_LIMIT = 2000

function asNumber(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function ms(value) {
  if (!value) return null
  const t = Date.parse(value)
  return Number.isFinite(t) ? t : null
}

export function refusalCount(row = {}) {
  const raw = row?.dispatch_refusal_count ?? row?.metadata?.dispatch_refusal_count
  const n = Math.trunc(Number(raw))
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** The row's due instant: scheduled_for_utc, else created_at. */
export function dueAtOf(row = {}) {
  return ms(row.scheduled_for_utc) ?? ms(row.created_at)
}

/**
 * Pure: the overdue/lag/stale/refused counts for a set of active rows.
 * @param {object[]} rows  send_queue rows (queue_status, created_at,
 *                         scheduled_for_utc, updated_at, metadata or
 *                         dispatch_refusal_count)
 * @param {number} now     epoch ms
 */
export function summarizeOverdue(rows = [], now = Date.now()) {
  const cutoff = now - OVERDUE_GRACE_MS
  let overdue = 0
  let lag = 0
  let stale = 0
  let refused = 0
  let oldest = null
  const refusedSample = []
  for (const row of rows || []) {
    const status = String(row?.queue_status || '')
    if (!ACTIVE_CANONICAL_STATUSES.includes(status)) continue
    const refusals = refusalCount(row)
    if (refusals >= REFUSAL_ATTENTION_THRESHOLD) {
      refused += 1
      if (refusedSample.length < 5) {
        refusedSample.push({
          id: row.id ?? null,
          queue_status: status,
          market: row.market ?? null,
          source: row.source ?? null,
          dispatch_refusal_count: refusals,
          skip_reason: row.skip_reason ?? row.metadata?.skip_reason ?? null,
          created_at: row.created_at ?? null,
        })
      }
      continue
    }
    if (!OVERDUE_STATUSES.includes(status)) continue // approval: held for a person
    const due = dueAtOf(row)
    if (due === null || due >= cutoff) continue
    overdue += 1
    if (LAG_STATUSES.has(status)) lag += 1
    const touched = ms(row.updated_at)
    if (touched !== null && touched < cutoff) stale += 1
    if (oldest === null || due < oldest) oldest = due
  }
  return {
    overdue_active: overdue,
    lag_active: lag,
    stale_active: stale,
    refused_repeatedly: refused,
    oldest_overdue_due_at: oldest === null ? null : new Date(oldest).toISOString(),
    refused_sample: refusedSample,
  }
}

export function deriveStatus(counts = {}) {
  const active = ACTIVE_CANONICAL_STATUSES.reduce((sum, status) => sum + asNumber(counts[status]), 0)
  if (active <= 0) return 'idle'
  if (asNumber(counts.lag_active) > 0 || asNumber(counts.stale_active) > 0) return 'degraded'
  if (
    asNumber(counts.failed_today) > 0
    || asNumber(counts.processing_lock_conflicts) > 0
    || asNumber(counts.refused_repeatedly) > 0
  ) return 'attention'
  return 'healthy'
}

/**
 * The overdue + refused rows, classified in JS (summarizeOverdue). Used by the
 * fallback and while the RPC still carries the pre-overdue definitions.
 */
async function fetchOverdueSummary(now = Date.now()) {
  const cutoffIso = new Date(now - OVERDUE_GRACE_MS).toISOString()
  const cols = 'id,queue_status,created_at,scheduled_for_utc,updated_at,market,source,dispatch_refusal_count:metadata->dispatch_refusal_count,skip_reason:metadata->>skip_reason'
  const [due, refused] = await Promise.all([
    supabase.from('send_queue').select(cols)
      .in('queue_status', OVERDUE_STATUSES)
      .or(`scheduled_for_utc.lt.${cutoffIso},and(scheduled_for_utc.is.null,created_at.lt.${cutoffIso})`)
      .limit(OVERDUE_ROW_PROBE_LIMIT),
    supabase.from('send_queue').select(cols)
      .in('queue_status', ACTIVE_CANONICAL_STATUSES)
      .not('metadata->dispatch_refusal_count', 'is', null)
      .limit(OVERDUE_ROW_PROBE_LIMIT),
  ])
  if (due.error) throw due.error
  if (refused.error) throw refused.error
  const byId = new Map()
  for (const row of [...(due.data || []), ...(refused.data || [])]) byId.set(row.id, row)
  return {
    ...summarizeOverdue([...byId.values()], now),
    lower_bound: (due.data || []).length >= OVERDUE_ROW_PROBE_LIMIT,
  }
}

async function countByStatus(status) {
  const { count, error } = await supabase
    .from('send_queue')
    .select('id', { count: 'exact', head: true })
    .eq('queue_status', status)
  if (error) throw error
  return Number(count || 0)
}

async function fetchQueueProcessorHealthFallback() {
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const todayIso = todayStart.toISOString()

  const [
    queued, pending, approval, scheduled, processing,
    overdue, sentToday, deliveredToday, failedToday,
    orphanedActive, retriedGtOne, processingLockConflicts,
    oldestQueuedProbe, latestSentProbe, latestWebhookProbe, issueProbe,
  ] = await Promise.all([
    countByStatus('queued'),
    countByStatus('pending'),
    countByStatus('approval'),
    countByStatus('scheduled'),
    countByStatus('processing'),
    fetchOverdueSummary(),
    supabase.from('send_queue').select('id', { count: 'exact', head: true }).gte('sent_at', todayIso),
    supabase.from('send_queue').select('id', { count: 'exact', head: true }).eq('queue_status', 'delivered').gte('delivered_at', todayIso),
    supabase.from('send_queue').select('id', { count: 'exact', head: true }).eq('queue_status', 'failed').gte('updated_at', todayIso),
    supabase.from('send_queue').select('id', { count: 'exact', head: true }).in('queue_status', ACTIVE_CANONICAL_STATUSES).is('to_phone_number', null),
    supabase.from('send_queue').select('id', { count: 'exact', head: true }).in('queue_status', ACTIVE_CANONICAL_STATUSES).gt('retry_count', 1),
    supabase.from('send_queue').select('id', { count: 'exact', head: true }).eq('queue_status', 'processing').or('is_locked.is.false,lock_token.is.null'),
    supabase.from('send_queue').select('created_at').eq('queue_status', 'queued').order('created_at', { ascending: true }).limit(1),
    supabase.from('send_queue').select('sent_at,updated_at,created_at').in('queue_status', ['sent', 'delivered']).order('sent_at', { ascending: false, nullsFirst: false }).limit(1),
    supabase.from('webhook_log').select('created_at').order('created_at', { ascending: false }).limit(1),
    supabase.from('send_queue').select('id,queue_status,created_at,updated_at,guard_reason,blocked_reason,failed_reason,market,property_address,to_phone_number,master_owner_id,property_id').in('queue_status', ['failed', 'blocked', 'processing']).order('updated_at', { ascending: false }).limit(10),
  ])

  const counts = {
    queued,
    pending,
    approval,
    scheduled,
    processing,
    lag_active: overdue.lag_active,
    overdue_active: overdue.overdue_active,
    refused_repeatedly: overdue.refused_repeatedly,
    sent_today: Number(sentToday.count || 0),
    delivered_today: Number(deliveredToday.count || 0),
    failed_today: Number(failedToday.count || 0),
    stale_active: overdue.stale_active,
    orphaned_active: Number(orphanedActive.count || 0),
    retried_gt_one: Number(retriedGtOne.count || 0),
    processing_lock_conflicts: Number(processingLockConflicts.count || 0),
  }

  return {
    counts,
    oldest_queued_at: oldestQueuedProbe.data?.[0]?.created_at || null,
    latest_sent_at: latestSentProbe.data?.[0]?.sent_at || latestSentProbe.data?.[0]?.updated_at || null,
    latest_webhook_at: latestWebhookProbe.data?.[0]?.created_at || null,
    issue_sample: issueProbe.data || [],
    oldest_overdue_due_at: overdue.oldest_overdue_due_at,
    refused_sample: overdue.refused_sample,
  }
}

async function loadQueueProcessorHealth() {
  const timer = createRequestTimer('queue-processor-health')
  const checkedAt = new Date().toISOString()

  let payload
  let sourceUsed = 'rpc:cockpit_queue_processor_health'
  const { data, error } = await supabase.rpc('cockpit_queue_processor_health')
  timer.mark('supabase_rpc', { error: error?.message || null })
  if (error) {
    payload = await fetchQueueProcessorHealthFallback()
    sourceUsed = 'fallback:parallel_counts'
    timer.mark('fallback')
  } else {
    payload = data && typeof data === 'object' ? data : {}
    // The RPC still carries the pre-overdue definitions until
    // PROPOSED_20261007120000_queue_health_overdue_semantics is applied:
    // recompute only the overdue counts here so the badge is right either way.
    if (!payload.counts || !Object.prototype.hasOwnProperty.call(payload.counts, 'overdue_active')) {
      const overdue = await fetchOverdueSummary()
      payload = {
        ...payload,
        counts: {
          ...(payload.counts || {}),
          lag_active: overdue.lag_active,
          stale_active: overdue.stale_active,
          overdue_active: overdue.overdue_active,
          refused_repeatedly: overdue.refused_repeatedly,
        },
        oldest_overdue_due_at: overdue.oldest_overdue_due_at,
        refused_sample: overdue.refused_sample,
      }
      sourceUsed = 'rpc:cockpit_queue_processor_health+js:overdue'
      timer.mark('overdue_overlay')
    }
  }

  const counts = payload.counts && typeof payload.counts === 'object' ? payload.counts : {}
  const response = {
    checkedAt,
    status: deriveStatus(counts),
    counts: {
      queued: asNumber(counts.queued),
      pending: asNumber(counts.pending),
      approval: asNumber(counts.approval),
      scheduled: asNumber(counts.scheduled),
      processing: asNumber(counts.processing),
      lagActive: asNumber(counts.lag_active),
      sentToday: asNumber(counts.sent_today),
      deliveredToday: asNumber(counts.delivered_today),
      failedToday: asNumber(counts.failed_today),
      staleActive: asNumber(counts.stale_active),
      orphanedActive: asNumber(counts.orphaned_active),
      retriedGtOne: asNumber(counts.retried_gt_one),
      processingLockConflicts: asNumber(counts.processing_lock_conflicts),
      overdueActive: asNumber(counts.overdue_active),
      refusedRepeatedly: asNumber(counts.refused_repeatedly),
    },
    oldestQueuedAt: payload.oldest_queued_at || null,
    oldestOverdueDueAt: payload.oldest_overdue_due_at || null,
    refusedSample: Array.isArray(payload.refused_sample) ? payload.refused_sample : [],
    latestSentAt: payload.latest_sent_at || null,
    latestWebhookAt: payload.latest_webhook_at || null,
    issueSample: Array.isArray(payload.issue_sample) ? payload.issue_sample : [],
    queryMs: timer.summary().totalMs,
    sourceUsed,
    timing: timer.summary(),
  }

  timer.mark('serialization')
  return response
}

export async function fetchQueueProcessorHealth() {
  return readThroughCache('cockpit:queue-processor-health', 5_000, loadQueueProcessorHealth)
}