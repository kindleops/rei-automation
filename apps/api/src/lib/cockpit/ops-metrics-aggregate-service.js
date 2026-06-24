import { supabase } from '@/lib/supabase/client.js'
import { buildTextGridSenderHealth } from '@/lib/domain/messaging/textgrid-sender-health.js'
import { createRequestTimer } from './server-timing.js'

function clean(value) {
  return String(value ?? '').trim()
}

function lower(value) {
  return clean(value).toLowerCase()
}

function startOfWindow(window = 'today') {
  const now = new Date()
  if (window === 'today') {
    const start = new Date(now)
    start.setHours(0, 0, 0, 0)
    return { start, end: now }
  }
  if (window === '24h') {
    return { start: new Date(now.getTime() - 24 * 60 * 60 * 1000), end: now }
  }
  if (window === '48h') {
    return { start: new Date(now.getTime() - 48 * 60 * 60 * 1000), end: now }
  }
  if (window === '7d') {
    return { start: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), end: now }
  }
  if (window === '30d') {
    return { start: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000), end: now }
  }
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  return { start, end: now }
}

function safeRate(numerator, denominator) {
  return Number(((numerator / Math.max(denominator, 1)) * 100).toFixed(1))
}

function emptySection() {
  return {
    queued: 0, scheduled: 0, processing: 0, sent: 0, delivered: 0, failed: 0,
    failed_queue: 0, cancelled: 0, expired: 0, content_blocked: 0, duplicate_blocked: 0,
    invalid_number: 0, opted_out: 0, replies: 0, opt_outs: 0, positive_replies: 0,
    negative_replies: 0, unclear_replies: 0, delivery_rate: null, failure_rate: null,
    reply_rate: null, opt_out_rate: null, positive_rate: null, negative_rate: null,
  }
}

function buildQueueHealthFromSnapshot(snapshot = {}, activeQueueRows = 0) {
  return {
    queued_active: Number(snapshot.queued_count || 0),
    scheduled_future: 0,
    processing: 0,
    stale_active: 0,
    content_blocked_today: 0,
    duplicate_blocked: 0,
    expired: 0,
    cancelled: 0,
    failed_total: Number(snapshot.queue_failed_today_count || 0),
    failed_by_reason: {},
    active_total: activeQueueRows,
  }
}

export async function fetchOpsMetricsAggregate(window = 'today') {
  const timer = createRequestTimer('ops-metrics')
  const { start, end } = startOfWindow(window)
  const startIso = start.toISOString()
  const endIso = end.toISOString()

  timer.mark('auth_config')

  let snapshot = {}
  let sourceUsed = 'rpc:cockpit_ops_metrics_snapshot'
  const { data, error } = await supabase.rpc('cockpit_ops_metrics_snapshot', {
    p_window_start: startIso,
    p_window_end: endIso,
  })
  timer.mark('supabase_rpc', { error: error?.message || null })

  if (error) {
    const [msgRes, queueRes, activeRes] = await Promise.all([
      supabase.from('message_events').select('id,direction,delivery_status,provider_delivery_status,is_opt_out,detected_intent,is_final_failure,from_phone_number,failure_bucket,failure_reason', { count: 'exact' }).gte('created_at', startIso).lte('created_at', endIso).limit(1),
      supabase.from('send_queue').select('id,queue_status', { count: 'exact' }).gte('created_at', startIso).lte('created_at', endIso).limit(1),
      supabase.from('send_queue').select('id', { count: 'exact', head: true }).in('queue_status', ['queued', 'pending', 'scheduled', 'processing', 'sending', 'approval']),
    ])
    if (msgRes.error || queueRes.error || activeRes.error) throw error
    snapshot = {
      window_start: startIso,
      window_end: endIso,
      message_rows: Number(msgRes.count || 0),
      queue_rows: Number(queueRes.count || 0),
      active_queue_rows: Number(activeRes.count || 0),
      sent_count: 0,
      delivered_count: 0,
      failed_count: 0,
      received_count: 0,
      opt_out_count: 0,
      positive_count: 0,
      negative_count: 0,
      pending_count: 0,
      queued_count: 0,
      queue_waiting_count: 0,
      queue_failed_today_count: 0,
      sender_performance: [],
    }
    sourceUsed = 'fallback:head_counts'
    timer.mark('fallback')
  } else {
    snapshot = data && typeof data === 'object' ? data : {}
  }
  const sentCount = Number(snapshot.sent_count || 0)
  const deliveredCount = Number(snapshot.delivered_count || 0)
  const failedCount = Number(snapshot.failed_count || 0)
  const inboundReplyCount = Number(snapshot.received_count || 0)
  const optOutCount = Number(snapshot.opt_out_count || 0)
  const positiveCount = Number(snapshot.positive_count || 0)
  const negativeCount = Number(snapshot.negative_count || 0)
  const queueWaitingCount = Number(snapshot.queue_waiting_count || 0)
  const queueFailedTodayCount = Number(snapshot.queue_failed_today_count || 0)
  const activeQueueRows = Number(snapshot.active_queue_rows || 0)

  const senderPerformance = Array.isArray(snapshot.sender_performance)
    ? snapshot.sender_performance.map((row) => ({
      sender: row.sender,
      sent_count: Number(row.sent_count || 0),
      delivered_count: Number(row.delivered_count || 0),
      failed_count: Number(row.failed_count || 0),
      content_filter_count: Number(row.content_filter_count || 0),
      invalid_to_count: Number(row.invalid_to_count || 0),
      inbound_reply_count: 0,
      opt_out_count: 0,
      delivery_rate: safeRate(Number(row.delivered_count || 0), Number(row.sent_count || 0)),
      failure_rate: safeRate(Number(row.failed_count || 0), Number(row.sent_count || 0)),
      reply_rate: 0,
      opt_out_rate: 0,
    }))
    : []

  const response = {
    window,
    generated_at: new Date().toISOString(),
    sent_count: sentCount,
    delivered_count: deliveredCount,
    failed_count: failedCount,
    pending_count: Number(snapshot.pending_count || 0),
    queued_count: Number(snapshot.queued_count || 0),
    received_count: inboundReplyCount,
    reply_rate: safeRate(inboundReplyCount, deliveredCount),
    positive_rate: safeRate(positiveCount, inboundReplyCount),
    negative_rate: safeRate(negativeCount, inboundReplyCount),
    delivery_rate: safeRate(deliveredCount, sentCount),
    failure_rate: safeRate(failedCount, sentCount),
    opt_out_rate: safeRate(optOutCount, deliveredCount),
    queue_processor_status: queueWaitingCount > 0 ? 'Running' : 'Idle / Needs Run',
    queue_last_run_at: null,
    queue_waiting_count: queueWaitingCount,
    queue_failed_today_count: queueFailedTodayCount,
    automation_hard_failure_count: queueFailedTodayCount,
    sender_performance: senderPerformance.length ? senderPerformance : buildTextGridSenderHealth([], []),
    sections: {
      first_touch: emptySection(),
      auto_replies: { stage_1: emptySection(), stage_2: emptySection(), stage_3: emptySection() },
      manual_replies: emptySection(),
      follow_up: emptySection(),
      unknown: emptySection(),
      queue_health: buildQueueHealthFromSnapshot(snapshot, activeQueueRows),
      failure_reasons: { total: queueFailedTodayCount, by_reason: {} },
      template_outliers: { top: [] },
      number_outliers: { top: senderPerformance.slice(0, 10) },
    },
    metric_source_debug: {
      transport_source: 'cockpit_ops_metrics_snapshot',
      queue_source: 'cockpit_ops_metrics_snapshot',
      window_start: startIso,
      window_end: endIso,
      message_rows: Number(snapshot.message_rows || 0),
      queue_rows: Number(snapshot.queue_rows || 0),
      active_queue_rows: activeQueueRows,
      aggregation_runtime_ms: timer.summary().totalMs,
      cached: false,
    },
    queryMs: timer.summary().totalMs,
    sourceUsed,
    timing: timer.summary(),
  }

  timer.mark('serialization')
  return response
}