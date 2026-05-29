import { NextResponse } from 'next/server.js'
import { ensureMutationAuth } from '../../_shared.js'
import { supabase, hasSupabaseConfig } from '@/lib/supabase/client.js'
import { getSystemFlags } from '@/lib/system-control.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function corsHeaders(_request) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-ops-dashboard-secret, X-Requested-With, Accept',
    'Access-Control-Max-Age': '86400',
  }
}

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
  return lower(value) === 'delivered'
}

function isFailedStatus(value) {
  return ['failed', 'undelivered', 'rejected', 'error'].includes(lower(value))
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

// Returns null when denominator is 0 — caller should display "No data"
function safeRateOrNull(numerator, denominator) {
  if (!denominator) return null
  return Number(((numerator / denominator) * 100).toFixed(1))
}

// ── Classification ─────────────────────────────────────────────────────────

const POSITIVE_INTENTS = new Set([
  'seller_interested', 'asking_price_provided', 'asks_offer', 'ownership_confirmed', 'price_anchor',
])
const NEGATIVE_INTENTS = new Set([
  'negative', 'not_interested', 'opt_out', 'wrong_number', 'hostile', 'hostile_or_legal',
  'wrong_person', 'not_owner', 'legal_threat', 'already_sold',
])

function classifyQueueRow(row) {
  const queueKey = lower(row.queue_key || '')
  const messageType = lower(row.message_type || '')
  const useCaseTemplate = lower(row.use_case_template || '')
  const currentStage = lower(row.current_stage || '')
  const metadata = row.metadata || {}
  const touchNumber = row.touch_number ?? metadata.touch_number ?? null
  const metadataAction = lower(metadata.action || metadata.cockpit_action || '')

  if (
    messageType === 'manual_reply' ||
    messageType === 'manual_scheduled_reply' ||
    queueKey.startsWith('inbox:send_now') ||
    metadataAction === 'send_now' ||
    metadataAction === 'queue_reply'
  ) return 'manual_reply'

  if (
    queueKey.startsWith('feed:') ||
    messageType === 'first_touch' ||
    messageType === 'outbound' ||
    useCaseTemplate === 'ownership_check' ||
    Number(touchNumber) === 1
  ) return 'first_touch'

  if (
    messageType === 'follow_up' ||
    useCaseTemplate.startsWith('follow_up') ||
    useCaseTemplate === 'recycle' ||
    queueKey.startsWith('followup:') ||
    queueKey.startsWith('recycle:')
  ) return 'follow_up'

  if (
    messageType === 'auto_reply' ||
    useCaseTemplate.startsWith('auto_reply') ||
    useCaseTemplate.startsWith('stage')
  ) {
    if (
      currentStage === 's1_ownership' ||
      useCaseTemplate.includes('stage1') ||
      useCaseTemplate.includes('ownership')
    ) return 'auto_reply_stage_1'
    if (
      currentStage === 's2_interest' ||
      useCaseTemplate.includes('stage2') ||
      useCaseTemplate.includes('interest') ||
      useCaseTemplate.includes('selling')
    ) return 'auto_reply_stage_2'
    if (
      currentStage === 's3_pricing' ||
      useCaseTemplate.includes('stage3') ||
      useCaseTemplate.includes('pric')
    ) return 'auto_reply_stage_3'
    return 'auto_reply_stage_1'
  }

  return 'unknown'
}

function classifyBlockReason(row) {
  const blocked = lower(row.blocked_reason || '')
  const failed = lower(row.failed_reason || '')
  const metadata = row.metadata || {}
  const meta = lower(metadata.failure_category || metadata.blocked_reason || metadata.block_reason || '')
  const combined = blocked || failed || meta

  if (combined.includes('content') || combined.includes('filter')) return 'content_blocked'
  if (combined.includes('duplicate')) return 'duplicate_blocked'
  if (combined.includes('invalid_number') || combined === 'invalid number') return 'invalid_number'
  if (combined.includes('opt') && (combined.includes('out') || combined.includes('stop'))) return 'opted_out'
  if (combined.includes('carrier') || combined.includes('transport') || combined.includes('gateway')) return 'transport_failed'
  if (combined.includes('delivery') || combined.includes('undeliver')) return 'delivery_failed'
  if (combined) return combined.slice(0, 40)
  return 'unknown'
}

// ── Section builders ───────────────────────────────────────────────────────

function buildMessageTypeSection(type, queueRows, outboundMsgRows, inboundRows, threadToType) {
  const rows = queueRows.filter((r) => classifyQueueRow(r) === type)
  const statusIs = (statuses, r) => statuses.includes(lower(r.queue_status))

  const queued = rows.filter((r) => statusIs(['queued', 'pending'], r)).length
  const scheduled = rows.filter((r) => statusIs(['scheduled'], r)).length
  const processing = rows.filter((r) => statusIs(['processing', 'sending'], r)).length
  const sent_queue = rows.filter((r) => statusIs(['sent', 'delivered'], r)).length
  const failed_queue = rows.filter((r) => statusIs(['failed'], r)).length
  const cancelled = rows.filter((r) => statusIs(['cancelled'], r)).length
  const expired = rows.filter((r) => statusIs(['expired'], r)).length

  const blockedRows = rows.filter((r) => statusIs(['blocked', 'duplicate_blocked'], r))
  const content_blocked = blockedRows.filter((r) => classifyBlockReason(r) === 'content_blocked').length
  const duplicate_blocked = rows.filter((r) => statusIs(['duplicate_blocked'], r)).length
  const invalid_number = rows.filter((r) => statusIs(['failed'], r) && classifyBlockReason(r) === 'invalid_number').length
  const opted_out = rows.filter((r) => classifyBlockReason(r) === 'opted_out').length

  // Transport-layer delivery (from message_events outbound) classified by thread_key
  const myOutbound = outboundMsgRows.filter((r) => {
    const thread = clean(r.thread_key || r.to_phone_number || '')
    return thread && threadToType.get(thread) === type
  })
  const sent = myOutbound.filter((r) => isAcceptedOutbound(r)).length
  const delivered = myOutbound.filter((r) =>
    isDeliveredStatus(r.provider_delivery_status) || isDeliveredStatus(r.delivery_status)
  ).length
  const failed = myOutbound.filter((r) =>
    isFailedStatus(r.provider_delivery_status) || isFailedStatus(r.delivery_status) || r.is_final_failure === true
  ).length

  // Inbound replies classified by thread_key
  const myInbound = inboundRows.filter((r) => {
    const thread = clean(r.thread_key || r.to_phone_number || '')
    return thread && threadToType.get(thread) === type
  })
  const replies = myInbound.length
  const opt_outs = myInbound.filter(
    (r) => r.is_opt_out === true || lower(r.detected_intent) === 'opt_out'
  ).length
  const positive_replies = myInbound.filter((r) => POSITIVE_INTENTS.has(lower(r.detected_intent || ''))).length
  const negative_replies = myInbound.filter((r) => NEGATIVE_INTENTS.has(lower(r.detected_intent || ''))).length
  const unclear_replies = Math.max(0, replies - positive_replies - negative_replies)

  const sentOrDelivered = sent || sent_queue

  return {
    queued,
    scheduled,
    processing,
    sent: sentOrDelivered,
    delivered,
    failed,
    failed_queue,
    cancelled,
    expired,
    content_blocked,
    duplicate_blocked,
    invalid_number,
    opted_out,
    replies,
    opt_outs,
    positive_replies,
    negative_replies,
    unclear_replies,
    delivery_rate: safeRateOrNull(delivered, sentOrDelivered),
    failure_rate: safeRateOrNull(failed, sentOrDelivered),
    reply_rate: safeRateOrNull(replies, delivered || sentOrDelivered),
    opt_out_rate: safeRateOrNull(opt_outs, delivered || sentOrDelivered),
    positive_rate: safeRateOrNull(positive_replies, replies),
    negative_rate: safeRateOrNull(negative_replies, replies),
  }
}

function buildQueueHealthSection(windowedQueueRows, currentActiveRows) {
  const staleThresholdMs = Date.now() - 2 * 60 * 60 * 1000

  const queued_active = currentActiveRows.filter((r) => ['queued', 'pending'].includes(lower(r.queue_status))).length
  const scheduled_future = currentActiveRows.filter((r) => lower(r.queue_status) === 'scheduled').length
  const processing = currentActiveRows.filter((r) => ['processing', 'sending'].includes(lower(r.queue_status))).length
  const stale_active = currentActiveRows.filter((r) => {
    const ts = new Date(r.updated_at || r.created_at || 0).getTime()
    return ts < staleThresholdMs
  }).length

  const content_blocked_today = windowedQueueRows.filter((r) => {
    const s = lower(r.queue_status)
    return (s === 'blocked' || s === 'failed') && classifyBlockReason(r) === 'content_blocked'
  }).length
  const duplicate_blocked = windowedQueueRows.filter((r) => lower(r.queue_status) === 'duplicate_blocked').length
  const expired = windowedQueueRows.filter((r) => lower(r.queue_status) === 'expired').length
  const cancelled = windowedQueueRows.filter((r) => lower(r.queue_status) === 'cancelled').length
  const failed_total = windowedQueueRows.filter((r) => lower(r.queue_status) === 'failed').length

  const failed_by_reason = {}
  for (const row of windowedQueueRows.filter((r) => lower(r.queue_status) === 'failed')) {
    const reason = classifyBlockReason(row)
    failed_by_reason[reason] = (failed_by_reason[reason] || 0) + 1
  }

  return {
    queued_active,
    scheduled_future,
    processing,
    stale_active,
    content_blocked_today,
    duplicate_blocked,
    expired,
    cancelled,
    failed_total,
    failed_by_reason,
  }
}

function buildFailureReasons(windowedQueueRows) {
  const rows = windowedQueueRows.filter((r) =>
    ['failed', 'blocked', 'duplicate_blocked'].includes(lower(r.queue_status))
  )
  const by_reason = {}
  for (const row of rows) {
    const reason = classifyBlockReason(row)
    by_reason[reason] = (by_reason[reason] || 0) + 1
  }
  return { total: rows.length, by_reason }
}

function buildTemplateOutliers(windowedQueueRows) {
  const byTemplate = new Map()
  for (const row of windowedQueueRows) {
    const tplId = clean(row.template_id || row.use_case_template || '')
    if (!tplId) continue
    const e = byTemplate.get(tplId) || { template_id: tplId, sent: 0, failed: 0, blocked: 0 }
    const s = lower(row.queue_status)
    if (['sent', 'delivered'].includes(s)) e.sent += 1
    if (s === 'failed') e.failed += 1
    if (['blocked', 'duplicate_blocked'].includes(s)) e.blocked += 1
    byTemplate.set(tplId, e)
  }
  return [...byTemplate.values()]
    .map((e) => ({
      ...e,
      failure_rate: safeRateOrNull(e.failed + e.blocked, e.sent + e.failed + e.blocked),
    }))
    .sort((a, b) => b.failed + b.blocked - (a.failed + a.blocked))
    .slice(0, 8)
}

function buildNumberOutliers(senderPerformance) {
  return senderPerformance.slice(0, 10).map((s) => ({
    number: s.sender,
    sent: s.sent_count,
    delivered: s.delivered_count,
    failed: s.failed_count,
    replies: s.inbound_reply_count,
    opt_outs: s.opt_out_count,
    delivery_rate: safeRateOrNull(s.delivered_count, s.sent_count),
    failure_rate: safeRateOrNull(s.failed_count, s.sent_count),
    reply_rate: safeRateOrNull(s.inbound_reply_count, s.delivered_count),
    opt_out_rate: safeRateOrNull(s.opt_out_count, s.delivered_count),
  }))
}

// ── Existing helpers ───────────────────────────────────────────────────────

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
    }
    if (isAcceptedOutbound(row)) entry.sent_count += 1
    if (isDeliveredStatus(row.provider_delivery_status) || isDeliveredStatus(row.delivery_status)) entry.delivered_count += 1
    if (isFailedStatus(row.provider_delivery_status) || isFailedStatus(row.delivery_status) || row.is_final_failure === true) entry.failed_count += 1
    bySender.set(sender, entry)
  }

  for (const row of messageRows) {
    if (lower(row.direction) !== 'inbound') continue
    const target = clean(row.to_phone_number)
    if (!target || !bySender.has(target)) continue
    const entry = bySender.get(target)
    entry.inbound_reply_count += 1
    if (row.is_opt_out === true || lower(row.detected_intent) === 'opt_out') entry.opt_out_count += 1
  }

  return [...bySender.values()]
    .map((entry) => ({
      ...entry,
      delivery_rate: safeRate(entry.delivered_count, entry.sent_count),
      failure_rate: safeRate(entry.failed_count, entry.sent_count),
      reply_rate: safeRate(entry.inbound_reply_count, entry.delivered_count),
      opt_out_rate: safeRate(entry.opt_out_count, entry.delivered_count),
    }))
    .filter((entry) => entry.sent_count > 0)
    .sort((a, b) => b.sent_count - a.sent_count)
}

// ── Route handler ──────────────────────────────────────────────────────────

export async function GET(request) {
  const cors = corsHeaders(request)
  const auth = ensureMutationAuth(request)
  if (!auth.ok) {
    return NextResponse.json(
      await auth.response.json().catch(() => ({ ok: false, error: 'unauthorized' })),
      { status: auth.response.status, headers: cors },
    )
  }
  if (!hasSupabaseConfig()) {
    return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 500, headers: cors })
  }

  const { searchParams } = new URL(request.url)
  const window = clean(searchParams.get('window') || 'today') || 'today'
  const { start, end } = startOfWindow(window)
  const startIso = start.toISOString()
  const endIso = end.toISOString()

  let flags, messageRes, queueRes, activeQueueRes
  try {
  ;[flags, messageRes, queueRes, activeQueueRes] = await Promise.all([
    getSystemFlags(['queue_runner_enabled']),
    supabase
      .from('message_events')
      .select('direction, delivery_status, provider_delivery_status, detected_intent, is_opt_out, is_final_failure, from_phone_number, to_phone_number, created_at, thread_key')
      .gte('created_at', startIso)
      .lte('created_at', endIso),
    supabase
      .from('send_queue')
      .select('queue_status, failed_reason, blocked_reason, metadata, updated_at, created_at, queue_key, message_type, use_case_template, touch_number, current_stage, thread_key, to_phone_number, template_id, scheduled_for')
      .gte('created_at', startIso)
      .lte('created_at', endIso),
    supabase
      .from('send_queue')
      .select('queue_status, updated_at, created_at')
      .in('queue_status', ['queued', 'pending', 'scheduled', 'processing', 'sending', 'approval']),
  ])

  } catch (fetchErr) {
    console.error('[ops-metrics] query failure', fetchErr)
    return NextResponse.json(
      { ok: false, error: 'METRICS_QUERY_FAILED', message: String(fetchErr?.message ?? fetchErr) },
      { status: 500, headers: cors },
    )
  }

  if (messageRes.error) {
    console.error('[ops-metrics] message_events error', messageRes.error)
    return NextResponse.json({ ok: false, error: 'MESSAGE_EVENTS_ERROR', message: String(messageRes.error.message) }, { status: 500, headers: cors })
  }
  if (queueRes.error) {
    console.error('[ops-metrics] send_queue error', queueRes.error)
    return NextResponse.json({ ok: false, error: 'QUEUE_ERROR', message: String(queueRes.error.message) }, { status: 500, headers: cors })
  }
  if (activeQueueRes.error) {
    console.error('[ops-metrics] active_queue error', activeQueueRes.error)
    return NextResponse.json({ ok: false, error: 'ACTIVE_QUEUE_ERROR', message: String(activeQueueRes.error.message) }, { status: 500, headers: cors })
  }

  const messageRows = messageRes.data || []
  const queueRows = queueRes.data || []
  const activeQueueRows = activeQueueRes.data || []

  const outboundRows = messageRows.filter((r) => lower(r.direction) === 'outbound')
  const inboundRows = messageRows.filter((r) => lower(r.direction) === 'inbound')

  // Build thread_key → classified type map from send_queue (primary classification source)
  const threadToType = new Map()
  for (const row of queueRows) {
    const thread = clean(row.thread_key || row.to_phone_number || '')
    if (!thread) continue
    const type = classifyQueueRow(row)
    // Last-write-wins; prefer more specific types over 'unknown'
    if (!threadToType.has(thread) || threadToType.get(thread) === 'unknown') {
      threadToType.set(thread, type)
    }
  }

  // ── Existing top-level metrics ─────────────────────────────────────────
  const sentCount = outboundRows.filter((r) => isAcceptedOutbound(r)).length
  const deliveredCount = outboundRows.filter(
    (r) => isDeliveredStatus(r.provider_delivery_status) || isDeliveredStatus(r.delivery_status)
  ).length
  const failedCount = outboundRows.filter(
    (r) => isFailedStatus(r.provider_delivery_status) || isFailedStatus(r.delivery_status) || r.is_final_failure === true
  ).length
  const inboundReplyCount = inboundRows.length
  const optOutCount = inboundRows.filter(
    (r) => r.is_opt_out === true || lower(r.detected_intent) === 'opt_out'
  ).length
  const positiveCount = inboundRows.filter((r) =>
    ['seller_interested', 'asking_price_provided', 'asks_offer', 'ownership_confirmed', 'price_anchor'].includes(lower(r.detected_intent))
  ).length
  const negativeCount = inboundRows.filter((r) =>
    ['negative', 'not_interested', 'opt_out', 'wrong_number', 'hostile', 'hostile_or_legal'].includes(lower(r.detected_intent))
  ).length

  const waitingStatuses = new Set(['queued', 'pending', 'scheduled'])
  const pendingCount = queueRows.filter((r) => lower(r.queue_status) === 'pending').length
  const queuedCount = queueRows.filter((r) => lower(r.queue_status) === 'queued').length
  const queueWaitingCount = queueRows.filter((r) => waitingStatuses.has(lower(r.queue_status))).length
  const queueFailedTodayCount = queueRows.filter((r) => lower(r.queue_status) === 'failed').length
  const automationHardFailureCount = queueRows.filter((r) => {
    if (lower(r.queue_status) !== 'failed') return false
    const reason = lower(r.failed_reason || r.blocked_reason || r.metadata?.failure_category || '')
    return !reason.includes('carrier') && !reason.includes('delivery')
  }).length

  const lastRunCandidate = [...queueRows].sort(
    (a, b) => new Date(b.updated_at || b.created_at || 0).getTime() - new Date(a.updated_at || a.created_at || 0).getTime()
  )[0] || null
  const queueLastRunAt = lastRunCandidate ? clean(lastRunCandidate.updated_at || lastRunCandidate.created_at) : null
  const hasRecentSuccess = queueRows.some((r) => {
    const s = lower(r.queue_status)
    const ts = new Date(r.updated_at || r.created_at || 0).getTime()
    return ['sent', 'delivered'].includes(s) && Date.now() - ts <= 5 * 60 * 1000
  })
  const hasRecentError = queueRows.some((r) => {
    const s = lower(r.queue_status)
    const ts = new Date(r.updated_at || r.created_at || 0).getTime()
    return s === 'failed' && Date.now() - ts <= 5 * 60 * 1000
  })

  const queueProcessorStatus = deriveQueueProcessorStatus({
    queueRunnerEnabled: flags.queue_runner_enabled !== false,
    queueWaitingCount,
    queueLastRunAt,
    hasRecentSuccess,
    hasRecentError,
  })

  const senderPerformance = buildSenderPerformance(messageRows)

  // ── Sections ────────────────────────────────────────────────────────────
  const sectionArgs = [queueRows, outboundRows, inboundRows, threadToType]

  const sections = {
    first_touch: buildMessageTypeSection('first_touch', ...sectionArgs),
    auto_replies: {
      stage_1: buildMessageTypeSection('auto_reply_stage_1', ...sectionArgs),
      stage_2: buildMessageTypeSection('auto_reply_stage_2', ...sectionArgs),
      stage_3: buildMessageTypeSection('auto_reply_stage_3', ...sectionArgs),
    },
    manual_replies: buildMessageTypeSection('manual_reply', ...sectionArgs),
    follow_up: buildMessageTypeSection('follow_up', ...sectionArgs),
    unknown: buildMessageTypeSection('unknown', ...sectionArgs),
    queue_health: buildQueueHealthSection(queueRows, activeQueueRows),
    failure_reasons: buildFailureReasons(queueRows),
    template_outliers: { top: buildTemplateOutliers(queueRows) },
    number_outliers: { top: buildNumberOutliers(senderPerformance) },
  }

  const response = {
    window,
    generated_at: new Date().toISOString(),
    sent_count: sentCount,
    delivered_count: deliveredCount,
    failed_count: failedCount,
    pending_count: pendingCount,
    queued_count: queuedCount,
    received_count: inboundReplyCount,
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
    sender_performance: senderPerformance,
    sections,
    metric_source_debug: {
      transport_source: 'message_events',
      queue_source: 'send_queue',
      window_start: startIso,
      window_end: endIso,
      message_rows: messageRows.length,
      queue_rows: queueRows.length,
      active_queue_rows: activeQueueRows.length,
      thread_to_type_entries: threadToType.size,
      queue_runner_enabled: flags.queue_runner_enabled !== false,
    },
  }

  return NextResponse.json({ ok: true, action: 'ops-metrics', diagnostics: response }, { status: 200, headers: cors })
}

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}
