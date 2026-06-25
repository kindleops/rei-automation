import { supabase } from '@/lib/supabase/client.js'
import { readThroughCache } from '@/lib/dashboard/ops-cache.js'
import { createRequestTimer } from './server-timing.js'

const ACTIVE_CANONICAL_STATUSES = ['queued', 'pending', 'approval', 'scheduled', 'processing']

function asNumber(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function deriveStatus(counts = {}) {
  const active = ACTIVE_CANONICAL_STATUSES.reduce((sum, status) => sum + asNumber(counts[status]), 0)
  if (active <= 0) return 'idle'
  if (asNumber(counts.lag_active) > 0 || asNumber(counts.stale_active) > 0) return 'degraded'
  if (asNumber(counts.failed_today) > 0 || asNumber(counts.processing_lock_conflicts) > 0) return 'attention'
  return 'healthy'
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
  const lagCutoffIso = new Date(Date.now() - 15 * 60 * 1000).toISOString()

  const [
    queued, pending, approval, scheduled, processing,
    lagActive, sentToday, deliveredToday, failedToday,
    staleActive, orphanedActive, retriedGtOne, processingLockConflicts,
    oldestQueuedProbe, latestSentProbe, latestWebhookProbe, issueProbe,
  ] = await Promise.all([
    countByStatus('queued'),
    countByStatus('pending'),
    countByStatus('approval'),
    countByStatus('scheduled'),
    countByStatus('processing'),
    supabase.from('send_queue').select('id', { count: 'exact', head: true }).in('queue_status', ['queued', 'pending', 'processing']).lt('created_at', lagCutoffIso),
    supabase.from('send_queue').select('id', { count: 'exact', head: true }).gte('sent_at', todayIso),
    supabase.from('send_queue').select('id', { count: 'exact', head: true }).eq('queue_status', 'delivered').gte('delivered_at', todayIso),
    supabase.from('send_queue').select('id', { count: 'exact', head: true }).eq('queue_status', 'failed').gte('updated_at', todayIso),
    supabase.from('send_queue').select('id', { count: 'exact', head: true }).in('queue_status', ACTIVE_CANONICAL_STATUSES).lt('updated_at', lagCutoffIso),
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
    lag_active: Number(lagActive.count || 0),
    sent_today: Number(sentToday.count || 0),
    delivered_today: Number(deliveredToday.count || 0),
    failed_today: Number(failedToday.count || 0),
    stale_active: Number(staleActive.count || 0),
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
    },
    oldestQueuedAt: payload.oldest_queued_at || null,
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