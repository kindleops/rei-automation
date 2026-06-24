import { NextResponse } from 'next/server.js'
import { ensureMutationAuth } from '../../_shared.js'
import { hasSupabaseConfig } from '@/lib/supabase/client.js'
import { readThroughCache } from '@/lib/dashboard/ops-cache.js'
import { fetchOpsMetricsAggregate } from '@/lib/cockpit/ops-metrics-aggregate-service.js'

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
  const normalizedFailure = normalizeTextGridFailure(row)
  if (normalizedFailure.failure_class === 'content_filter_blocked') return 'content_blocked'
  if (normalizedFailure.failure_class === 'recipient_opted_out') return 'opted_out'
  if (normalizedFailure.failure_class === 'invalid_to_number') return 'invalid_number'
  if (normalizedFailure.failure_class === 'recipient_out_of_credit') return 'recipient_out_of_credit'

  const blocked = lower(row.blocked_reason || '')
  const failed = lower(row.failed_reason || '')
  const metadata = row.metadata || {}
  const meta = lower(metadata.failure_class || metadata.provider_failure_reason || metadata.normalized_reason || metadata.failure_category || metadata.blocked_reason || metadata.block_reason || '')
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
    content_filter_count: s.content_filter_count || 0,
    invalid_to_count: s.invalid_to_count || 0,
    replies: s.inbound_reply_count,
    opt_outs: s.opt_out_count,
    delivery_rate: safeRateOrNull(s.delivered_count, s.sent_count),
    failure_rate: safeRateOrNull(s.failed_count, s.sent_count),
    content_filter_rate: safeRateOrNull(s.content_filter_count || 0, s.sent_count),
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

function buildSenderPerformance(messageRows = [], queueRows = []) {
  return buildTextGridSenderHealth(messageRows, queueRows)
}

function degradedMetricsResponse({ errorCode, message, window = 'today', startedAt, sourceUsed = null }) {
  const generated_at = new Date().toISOString()
  return {
    ok: true,
    degraded: true,
    action: 'ops-metrics',
    error_code: errorCode,
    error: errorCode,
    message,
    diagnostics: {
      window,
      generated_at,
      sent_count: 0,
      delivered_count: 0,
      failed_count: 0,
      pending_count: 0,
      queued_count: 0,
      received_count: 0,
      reply_rate: 0,
      positive_rate: 0,
      negative_rate: 0,
      delivery_rate: 0,
      failure_rate: 0,
      opt_out_rate: 0,
      queue_processor_status: 'Unknown',
      queue_last_run_at: null,
      queue_waiting_count: 0,
      queue_failed_today_count: 0,
      automation_hard_failure_count: 0,
      sender_performance: [],
      sections: {
        first_touch: {},
        auto_replies: { stage_1: {}, stage_2: {}, stage_3: {} },
        manual_replies: {},
        follow_up: {},
        unknown: {},
        queue_health: {},
        failure_reasons: { total: 0, by_reason: {} },
        template_outliers: { top: [] },
        number_outliers: { top: [] },
      },
      metric_source_debug: {
        transport_source: 'message_events',
        queue_source: 'send_queue',
        degraded: true,
        error_code: errorCode,
        sourceUsed,
      },
      queryMs: Date.now() - startedAt,
      sourceUsed,
    },
    queryMs: Date.now() - startedAt,
    sourceUsed,
  }
}

// ── Route handler ──────────────────────────────────────────────────────────

export async function GET(request) {
  const cors = corsHeaders(request)
  const startedAt = Date.now()
  const auth = ensureMutationAuth(request)
  if (!auth.ok) {
    return NextResponse.json(
      await auth.response.json().catch(() => ({ ok: false, error: 'unauthorized' })),
      { status: auth.response.status, headers: cors },
    )
  }
  if (!hasSupabaseConfig()) {
    return NextResponse.json(
      degradedMetricsResponse({
        errorCode: 'supabase_not_configured',
        message: 'Supabase is not configured for ops metrics.',
        startedAt,
      }),
      { status: 200, headers: cors },
    )
  }

  const { searchParams } = new URL(request.url)
  const window = clean(searchParams.get('window') || 'today') || 'today'

  try {
    const response = await readThroughCache(
      `cockpit:ops-metrics:${window}`,
      12_000,
      () => fetchOpsMetricsAggregate(window),
    )

    return NextResponse.json(
      {
        ok: true,
        degraded: false,
        action: 'ops-metrics',
        diagnostics: response,
        queryMs: response.queryMs ?? Date.now() - startedAt,
        sourceUsed: response.sourceUsed || 'rpc:cockpit_ops_metrics_snapshot',
      },
      { status: 200, headers: cors },
    )
  } catch (fetchErr) {
    console.error('[ops-metrics] aggregate failure', fetchErr)
    return NextResponse.json(
      degradedMetricsResponse({
        errorCode: 'METRICS_QUERY_FAILED',
        message: String(fetchErr?.message ?? fetchErr),
        window,
        startedAt,
        sourceUsed: 'rpc:cockpit_ops_metrics_snapshot',
      }),
      { status: 200, headers: cors },
    )
  }
}

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}
