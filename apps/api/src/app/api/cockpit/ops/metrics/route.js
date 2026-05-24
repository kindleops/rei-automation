import { NextResponse } from 'next/server.js'
import { ensureMutationAuth } from '../../_shared.js'
import { supabase, hasSupabaseConfig } from '@/lib/supabase/client.js'
import { getSystemFlags } from '@/lib/system-control.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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

function isDeliveredStatus(value) {
  const v = lower(value)
  return v === 'delivered'
}

function isFailedStatus(value) {
  const v = lower(value)
  return ['failed', 'undelivered', 'rejected', 'error'].includes(v)
}

function isAcceptedOutbound(row) {
  if (lower(row.direction) !== 'outbound') return false
  const provider = lower(row.provider_delivery_status)
  const delivery = lower(row.delivery_status)
  if (isDeliveredStatus(provider) || isDeliveredStatus(delivery)) return true
  if (isFailedStatus(provider) || isFailedStatus(delivery)) return true
  return ['sent', 'accepted', 'queued', 'sending'].includes(provider) ||
    ['sent', 'queued', 'sending', 'accepted'].includes(delivery)
}

function safeRate(numerator, denominator) {
  return Number(((numerator / Math.max(denominator, 1)) * 100).toFixed(1))
}

function deriveQueueProcessorStatus({
  queueRunnerEnabled,
  queueWaitingCount,
  queueLastRunAt,
  hasRecentSuccess,
  hasRecentError,
}) {
  if (!queueRunnerEnabled) return 'Off'
  if (queueWaitingCount <= 0) return 'Running'
  if (hasRecentError) return 'Processor blocked'
  if (hasRecentSuccess) return 'Running'
  if (queueLastRunAt) {
    const minutesSince = (Date.now() - new Date(queueLastRunAt).getTime()) / 60000
    if (minutesSince >= 10) return 'Idle / Needs Run'
  }
  return 'Idle / Needs Run'
}

function buildSenderPerformance(messageRows = []) {
  const bySender = new Map()
  for (const row of messageRows) {
    if (lower(row.direction) !== 'outbound') continue
    const sender = clean(row.from_phone_number) || 'unknown'
    const entry = bySender.get(sender) || {
      sender,
      sent_count: 0,
      delivered_count: 0,
      failed_count: 0,
      inbound_reply_count: 0,
      opt_out_count: 0,
      delivery_rate: 0,
      failure_rate: 0,
      reply_rate: 0,
      opt_out_rate: 0,
    }
    if (isAcceptedOutbound(row)) entry.sent_count += 1
    if (isDeliveredStatus(row.provider_delivery_status) || isDeliveredStatus(row.delivery_status)) entry.delivered_count += 1
    if (isFailedStatus(row.provider_delivery_status) || isFailedStatus(row.delivery_status) || row.is_final_failure === true) entry.failed_count += 1
    bySender.set(sender, entry)
  }

  // inbound replies counted by to_phone_number matching sender
  for (const row of messageRows) {
    if (lower(row.direction) !== 'inbound') continue
    const target = clean(row.to_phone_number)
    if (!target || !bySender.has(target)) continue
    const entry = bySender.get(target)
    entry.inbound_reply_count += 1
    if (row.is_opt_out === true || lower(row.detected_intent) === 'opt_out') entry.opt_out_count += 1
  }

  const performance = [...bySender.values()]
    .map((entry) => ({
      ...entry,
      delivery_rate: safeRate(entry.delivered_count, entry.sent_count),
      failure_rate: safeRate(entry.failed_count, entry.sent_count),
      reply_rate: safeRate(entry.inbound_reply_count, entry.delivered_count),
      opt_out_rate: safeRate(entry.opt_out_count, entry.delivered_count),
    }))
    .filter((entry) => entry.sent_count > 0)
    .sort((a, b) => b.sent_count - a.sent_count)

  return performance
}

export async function GET(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response
  if (!hasSupabaseConfig()) {
    return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 500 })
  }

  const { searchParams } = new URL(request.url)
  const window = clean(searchParams.get('window') || 'today') || 'today'
  const { start, end } = startOfWindow(window)
  const startIso = start.toISOString()
  const endIso = end.toISOString()

  const [
    flags,
    messageRes,
    queueRes,
  ] = await Promise.all([
    getSystemFlags(['queue_runner_enabled']),
    supabase
      .from('message_events')
      .select('direction, delivery_status, provider_delivery_status, detected_intent, is_opt_out, is_final_failure, from_phone_number, to_phone_number, created_at')
      .gte('created_at', startIso)
      .lte('created_at', endIso),
    supabase
      .from('send_queue')
      .select('queue_status, failed_reason, blocked_reason, metadata, updated_at, created_at')
      .gte('created_at', startIso)
      .lte('created_at', endIso),
  ])

  if (messageRes.error) throw messageRes.error
  if (queueRes.error) throw queueRes.error

  const messageRows = messageRes.data || []
  const queueRows = queueRes.data || []

  const outboundRows = messageRows.filter((row) => lower(row.direction) === 'outbound')
  const inboundRows = messageRows.filter((row) => lower(row.direction) === 'inbound')

  const sentCount = outboundRows.filter((row) => isAcceptedOutbound(row)).length
  const deliveredCount = outboundRows.filter((row) => isDeliveredStatus(row.provider_delivery_status) || isDeliveredStatus(row.delivery_status)).length
  const failedCount = outboundRows.filter((row) =>
    isFailedStatus(row.provider_delivery_status) ||
    isFailedStatus(row.delivery_status) ||
    row.is_final_failure === true
  ).length
  const receivedCount = inboundRows.length
  const inboundReplyCount = inboundRows.length
  const optOutCount = inboundRows.filter((row) => row.is_opt_out === true || lower(row.detected_intent) === 'opt_out').length
  const positiveCount = inboundRows.filter((row) => ['seller_interested', 'asking_price_provided', 'asks_offer', 'ownership_confirmed', 'price_anchor'].includes(lower(row.detected_intent))).length
  const negativeCount = inboundRows.filter((row) => ['negative', 'not_interested', 'opt_out', 'wrong_number', 'hostile', 'hostile_or_legal'].includes(lower(row.detected_intent))).length

  const waitingStatuses = new Set(['queued', 'pending', 'scheduled'])
  const pendingCount = queueRows.filter((row) => lower(row.queue_status) === 'pending').length
  const queuedCount = queueRows.filter((row) => lower(row.queue_status) === 'queued').length
  const queueWaitingCount = queueRows.filter((row) => waitingStatuses.has(lower(row.queue_status))).length
  const queueFailedTodayCount = queueRows.filter((row) => lower(row.queue_status) === 'failed').length
  const automationHardFailureCount = queueRows.filter((row) => {
    if (lower(row.queue_status) !== 'failed') return false
    const reason = lower(row.failed_reason || row.blocked_reason || row.metadata?.failure_category || '')
    return !reason.includes('carrier') && !reason.includes('delivery')
  }).length

  const lastRunCandidate = [...queueRows].sort((a, b) => new Date(b.updated_at || b.created_at || 0).getTime() - new Date(a.updated_at || a.created_at || 0).getTime())[0] || null
  const queueLastRunAt = lastRunCandidate ? clean(lastRunCandidate.updated_at || lastRunCandidate.created_at) : null
  const hasRecentSuccess = queueRows.some((row) => {
    const status = lower(row.queue_status)
    const ts = new Date(row.updated_at || row.created_at || 0).getTime()
    return ['sent', 'delivered'].includes(status) && Date.now() - ts <= 5 * 60 * 1000
  })
  const hasRecentError = queueRows.some((row) => {
    const status = lower(row.queue_status)
    const ts = new Date(row.updated_at || row.created_at || 0).getTime()
    return status === 'failed' && Date.now() - ts <= 5 * 60 * 1000
  })

  const queueProcessorStatus = deriveQueueProcessorStatus({
    queueRunnerEnabled: flags.queue_runner_enabled !== false,
    queueWaitingCount,
    queueLastRunAt,
    hasRecentSuccess,
    hasRecentError,
  })

  const response = {
    window,
    sent_count: sentCount,
    delivered_count: deliveredCount,
    failed_count: failedCount,
    pending_count: pendingCount,
    queued_count: queuedCount,
    received_count: receivedCount,
    reply_rate: safeRate(inboundReplyCount, deliveredCount),
    positive_rate: safeRate(positiveCount, inboundReplyCount),
    negative_rate: safeRate(negativeCount, inboundReplyCount),
    delivery_rate: safeRate(deliveredCount, sentCount),
    failure_rate: safeRate(failedCount, sentCount),
    opt_out_rate: safeRate(optOutCount, deliveredCount),
    queue_processor_status: queueProcessorStatus,
    queue_last_run_at: queueLastRunAt,
    queue_waiting_count: queueWaitingCount,
    queue_failed_today_count: queueFailedTodayCount,
    automation_hard_failure_count: automationHardFailureCount,
    sender_performance: buildSenderPerformance(messageRows),
    metric_source_debug: {
      transport_source: 'message_events',
      queue_source: 'send_queue',
      window_start: startIso,
      window_end: endIso,
      message_rows: messageRows.length,
      queue_rows: queueRows.length,
      queue_runner_enabled: flags.queue_runner_enabled !== false,
    },
  }

  return NextResponse.json({ ok: true, action: 'ops-metrics', diagnostics: response }, { status: 200 })
}

