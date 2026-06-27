/**
 * notification-scanners.js
 *
 * Proactive scanners that emit notification_events when real conditions are met.
 * NO fake data — only emits on verified DB signals.
 */

import { supabase } from '@/lib/supabase/client.js'
import { child } from '@/lib/logging/logger.js'
import { fetchQueueProcessorHealth } from '@/lib/cockpit/queue-processor-health-service.js'
import { fetchOpsMetricsAggregate } from '@/lib/cockpit/ops-metrics-aggregate-service.js'
import { buildTextGridSenderHealth } from '@/lib/domain/messaging/textgrid-sender-health.js'
import {
  analyzeCampaignHealth,
  buildCampaignPauseRecommendation,
  buildCampaignScaleRecommendation,
  fetchCampaignMetrics,
  THRESHOLDS as PROACTIVE_THRESHOLDS,
} from '@/lib/domain/ops/proactive-notifications.js'
import {
  buildDedupKey,
  buildGroupingKey,
  THRESHOLDS,
  upsertNotificationEvent,
  __setDeps as __setServiceDeps,
  __resetDeps as __resetServiceDeps,
} from './notification-intelligence-service.js'

const logger = child({ module: 'domain.notifications.scanners' })

let _deps = { supabase_override: null }

export function __setDeps(overrides = {}) {
  _deps = { ..._deps, ...overrides }
  if (overrides.supabase_override) {
    __setServiceDeps({ supabase_override: overrides.supabase_override })
  }
}

export function __resetDeps() {
  _deps = { supabase_override: null }
  __resetServiceDeps()
}

function getDb() {
  return _deps.supabase_override ?? supabase
}

function clean(value) {
  return String(value ?? '').trim()
}

function pct(numerator, denominator) {
  const d = Number(denominator) || 0
  if (d <= 0) return 0
  return Number(((Number(numerator) / d) * 100).toFixed(1))
}

async function emitScanEvent(fields) {
  return upsertNotificationEvent({
    group: true,
    ...fields,
  })
}

// ---------------------------------------------------------------------------
// Campaign scanner
// ---------------------------------------------------------------------------

export async function scanCampaignNotifications() {
  const db = getDb()
  const emitted = []
  const errors = []

  try {
    const { data: campaigns, error } = await db
      .from('campaigns')
      .select(`
        id, name, status, market, daily_cap, sent_count, delivered_count,
        failed_count, replied_count, positive_count, opt_out_count,
        queued_count, activated_at, execution_heartbeat_at, progress_synced_at,
        metadata
      `)
      .in('status', ['active', 'activating', 'scheduled', 'paused'])
      .order('updated_at', { ascending: false })
      .limit(100)

    if (error) {
      errors.push(error.message)
      return { emitted, errors, campaigns_checked: 0 }
    }

    const rows = campaigns ?? []
    const nowMs = Date.now()

    for (const campaign of rows) {
      const campaignId = campaign.id
      const campaignName = clean(campaign.name) || campaignId
      const campaignKey = clean(campaign.metadata?.campaign_key) || campaignId
      const sent = Number(campaign.sent_count || 0)
      const delivered = Number(campaign.delivered_count || 0)
      const failed = Number(campaign.failed_count || 0)
      const optOut = Number(campaign.opt_out_count || 0)
      const replied = Number(campaign.replied_count || 0)
      const dailyCap = Number(campaign.daily_cap || campaign.metadata?.daily_cap || 0)
      const deliveryRate = pct(delivered, sent)
      const optOutRate = pct(optOut, sent)
      const status = clean(campaign.status)

      const metrics = {
        sent,
        delivered,
        failed,
        replied,
        opted_out: optOut,
        sample_size: sent,
        delivery_rate_pct: deliveryRate,
        opt_out_rate_pct: optOutRate,
      }

      // No sends despite active
      if (status === 'active' && sent === 0) {
        const activatedAt = campaign.activated_at ? new Date(campaign.activated_at).getTime() : 0
        if (activatedAt && nowMs - activatedAt > 2 * 60 * 60 * 1000) {
          const r = await emitScanEvent({
            event_type: 'campaign_no_sends_despite_active',
            campaign_id: campaignId,
            source_entity_id: campaignId,
            title_vars: { campaign_name: campaignName },
            description: `Active campaign has sent 0 messages since activation.`,
            metrics_snapshot: metrics,
            deduplication_key: buildDedupKey('campaign_no_sends_despite_active', campaignId),
            grouping_key: buildGroupingKey('campaign_no_sends_despite_active', campaignId),
          })
          if (r.ok) emitted.push(r.id)
        }
      }

      // Daily cap hit (sent >= daily cap when cap configured)
      if (dailyCap > 0 && sent >= dailyCap && status === 'active') {
        const r = await emitScanEvent({
          event_type: 'campaign_daily_cap_hit',
          severity: 'neutral',
          campaign_id: campaignId,
          source_entity_id: campaignId,
          title_vars: { campaign_name: campaignName },
          description: `Sent ${sent} of ${dailyCap} daily cap.`,
          metrics_snapshot: { ...metrics, daily_cap: dailyCap },
          deduplication_key: buildDedupKey('campaign_daily_cap_hit', campaignId),
          grouping_key: buildGroupingKey('campaign_daily_cap_hit', campaignId),
        })
        if (r.ok) emitted.push(r.id)
      }

      // Delivery rate falling (sample required)
      if (sent >= THRESHOLDS.MIN_SAMPLE_SIZE && deliveryRate < 70) {
        const r = await emitScanEvent({
          event_type: 'campaign_delivery_rate_falling',
          severity: deliveryRate < 50 ? 'critical' : 'warning',
          campaign_id: campaignId,
          source_entity_id: campaignId,
          title_vars: { campaign_name: campaignName },
          description: `Delivery rate ${deliveryRate}% (threshold 70%).`,
          metrics_snapshot: metrics,
          deduplication_key: buildDedupKey('campaign_delivery_rate_falling', campaignId),
          grouping_key: buildGroupingKey('campaign_delivery_rate_falling', campaignId),
        })
        if (r.ok) emitted.push(r.id)
      }

      // Opt-out spike
      if (sent >= THRESHOLDS.MIN_SAMPLE_SIZE && optOutRate >= PROACTIVE_THRESHOLDS.PAUSE_OPT_OUT_THRESHOLD * 100) {
        const r = await emitScanEvent({
          event_type: 'campaign_opt_out_spike',
          severity: 'critical',
          campaign_id: campaignId,
          source_entity_id: campaignId,
          title_vars: { campaign_name: campaignName },
          description: `Opt-out rate ${optOutRate}% exceeds threshold.`,
          metrics_snapshot: metrics,
          deduplication_key: buildDedupKey('campaign_opt_out_spike', campaignId),
          grouping_key: buildGroupingKey('campaign_opt_out_spike', campaignId),
        })
        if (r.ok) emitted.push(r.id)
      }

      // Stale heartbeat
      const heartbeat = campaign.execution_heartbeat_at
        ? new Date(campaign.execution_heartbeat_at).getTime()
        : 0
      if (status === 'active' && heartbeat && nowMs - heartbeat > 30 * 60 * 1000) {
        const r = await emitScanEvent({
          event_type: 'campaign_stale_heartbeat',
          campaign_id: campaignId,
          source_entity_id: campaignId,
          title_vars: { campaign_name: campaignName },
          description: `No execution heartbeat for 30+ minutes.`,
          metrics_snapshot: metrics,
          deduplication_key: buildDedupKey('campaign_stale_heartbeat', campaignId),
          grouping_key: buildGroupingKey('campaign_stale_heartbeat', campaignId),
        })
        if (r.ok) emitted.push(r.id)
      }

      // Pacing behind (queued >> sent with active status)
      const queued = Number(campaign.queued_count || 0)
      if (status === 'active' && queued > 100 && sent > 0 && sent / (queued + sent) < 0.1) {
        const r = await emitScanEvent({
          event_type: 'campaign_pacing_behind',
          campaign_id: campaignId,
          source_entity_id: campaignId,
          title_vars: { campaign_name: campaignName },
          description: `Hydration ${pct(sent, queued + sent)}% — pacing behind.`,
          metrics_snapshot: { ...metrics, queued_count: queued },
          deduplication_key: buildDedupKey('campaign_pacing_behind', campaignId),
          grouping_key: buildGroupingKey('campaign_pacing_behind', campaignId),
        })
        if (r.ok) emitted.push(r.id)
      }

      // Proactive health analysis (message_events)
      let eventMetrics
      try {
        eventMetrics = await fetchCampaignMetrics(campaignKey, 72)
      } catch {
        continue
      }

      const analysis = analyzeCampaignHealth(campaign, eventMetrics)
      if (analysis.scale_recommended) {
        const rec = buildCampaignScaleRecommendation(campaign, eventMetrics, analysis)
        const r = await emitScanEvent({
          event_type: 'campaign_scale_up_recommended',
          severity: 'positive',
          campaign_id: campaignId,
          source_entity_id: campaignId,
          title_vars: { campaign_name: campaignName },
          description: analysis.reason,
          metrics_snapshot: eventMetrics,
          recommendation: rec,
          deduplication_key: buildDedupKey('campaign_scale_up_recommended', campaignId),
          grouping_key: buildGroupingKey('campaign_scale_up_recommended', campaignId),
        })
        if (r.ok) emitted.push(r.id)
      }

      if (analysis.pause_recommended) {
        const rec = buildCampaignPauseRecommendation(campaign, eventMetrics, analysis)
        const r = await emitScanEvent({
          event_type: 'campaign_pause_recommended',
          severity: 'warning',
          campaign_id: campaignId,
          source_entity_id: campaignId,
          title_vars: { campaign_name: campaignName },
          description: analysis.reason,
          metrics_snapshot: eventMetrics,
          recommendation: rec,
          deduplication_key: buildDedupKey('campaign_pause_recommended', campaignId),
          grouping_key: buildGroupingKey('campaign_pause_recommended', campaignId),
        })
        if (r.ok) emitted.push(r.id)
      }

      // Strong reply rate
      const replyRate = pct(replied, delivered || sent)
      if (sent >= THRESHOLDS.MIN_SAMPLE_SIZE && replyRate >= 8) {
        const r = await emitScanEvent({
          event_type: 'campaign_reply_rate_strong',
          severity: 'positive',
          campaign_id: campaignId,
          source_entity_id: campaignId,
          title_vars: { campaign_name: campaignName },
          description: `Reply rate ${replyRate}% is above baseline.`,
          metrics_snapshot: { ...metrics, reply_rate_pct: replyRate },
          deduplication_key: buildDedupKey('campaign_reply_rate_strong', campaignId),
          grouping_key: buildGroupingKey('campaign_reply_rate_strong', campaignId),
        })
        if (r.ok) emitted.push(r.id)
      }
    }

    return { emitted, errors, campaigns_checked: rows.length }
  } catch (err) {
    logger.warn('scan.campaigns_failed', { error: String(err?.message ?? err) })
    return { emitted, errors: [...errors, String(err?.message ?? err)], campaigns_checked: 0 }
  }
}

// ---------------------------------------------------------------------------
// Template scanner
// ---------------------------------------------------------------------------

export async function scanTemplateNotifications() {
  const db = getDb()
  const emitted = []
  const errors = []

  try {
    const { data: kpiRows, error } = await db
      .from('template_performance_kpis_v')
      .select('*')
      .eq('time_window', '7d')
      .gte('sends', THRESHOLDS.MIN_SAMPLE_SIZE)
      .limit(200)

    if (error) {
      errors.push(error.message)
      return { emitted, errors, templates_checked: 0 }
    }

    for (const row of kpiRows ?? []) {
      const templateKey = clean(row.template_key)
      const templateName = clean(row.template_name) || templateKey
      const sends = Number(row.sends || 0)
      const delivered = Number(row.delivered || sends)
      const optOutRate = Number(row.opt_out_rate ?? 0)
      const replyRate = Number(row.reply_rate ?? 0)
      const failureRate = Number(row.failure_rate ?? 0)
      const positiveRate = Number(row.positive_rate ?? 0)

      const metrics = {
        sends,
        delivered,
        opt_out_rate: optOutRate,
        reply_rate: replyRate,
        failure_rate: failureRate,
        positive_rate: positiveRate,
      }

      if (optOutRate >= 8) {
        const r = await emitScanEvent({
          event_type: 'template_opt_out_spike',
          severity: 'critical',
          template_id: templateKey,
          source_entity_id: templateKey,
          title_vars: { template_name: templateName },
          description: `Opt-out rate ${optOutRate}% on 7d window.`,
          metrics_snapshot: metrics,
          deduplication_key: buildDedupKey('template_opt_out_spike', templateKey),
          grouping_key: buildGroupingKey('template_opt_out_spike', templateKey),
        })
        if (r.ok) emitted.push(r.id)
      }

      if (failureRate >= 20) {
        const r = await emitScanEvent({
          event_type: 'template_failure_rate_high',
          severity: 'warning',
          template_id: templateKey,
          source_entity_id: templateKey,
          title_vars: { template_name: templateName },
          description: `Failure rate ${failureRate}% on 7d window.`,
          metrics_snapshot: metrics,
          deduplication_key: buildDedupKey('template_failure_rate_high', templateKey),
          grouping_key: buildGroupingKey('template_failure_rate_high', templateKey),
        })
        if (r.ok) emitted.push(r.id)
      }

      const deliveryRate = pct(delivered, sends)
      if (sends >= THRESHOLDS.MIN_SAMPLE_SIZE && deliveryRate < 65) {
        const r = await emitScanEvent({
          event_type: 'template_delivery_falling',
          template_id: templateKey,
          source_entity_id: templateKey,
          title_vars: { template_name: templateName },
          description: `Delivery rate ${deliveryRate}% on 7d window.`,
          metrics_snapshot: metrics,
          deduplication_key: buildDedupKey('template_delivery_falling', templateKey),
          grouping_key: buildGroupingKey('template_delivery_falling', templateKey),
        })
        if (r.ok) emitted.push(r.id)
      }

      if (positiveRate >= 5 && replyRate >= 8) {
        const r = await emitScanEvent({
          event_type: 'template_copy_outperforming',
          severity: 'positive',
          template_id: templateKey,
          source_entity_id: templateKey,
          title_vars: { template_name: templateName },
          description: `Positive rate ${positiveRate}%, reply rate ${replyRate}%.`,
          metrics_snapshot: metrics,
          deduplication_key: buildDedupKey('template_copy_outperforming', templateKey),
          grouping_key: buildGroupingKey('template_copy_outperforming', templateKey),
        })
        if (r.ok) emitted.push(r.id)
      }

      if (replyRate < 2 && sends >= 100) {
        const r = await emitScanEvent({
          event_type: 'template_copy_underperforming',
          template_id: templateKey,
          source_entity_id: templateKey,
          title_vars: { template_name: templateName },
          description: `Reply rate ${replyRate}% below baseline.`,
          metrics_snapshot: metrics,
          deduplication_key: buildDedupKey('template_copy_underperforming', templateKey),
          grouping_key: buildGroupingKey('template_copy_underperforming', templateKey),
        })
        if (r.ok) emitted.push(r.id)
      }
    }

    return { emitted, errors, templates_checked: kpiRows?.length ?? 0 }
  } catch (err) {
    logger.warn('scan.templates_failed', { error: String(err?.message ?? err) })
    return { emitted, errors: [...errors, String(err?.message ?? err)], templates_checked: 0 }
  }
}

// ---------------------------------------------------------------------------
// Sender health scanner
// ---------------------------------------------------------------------------

export async function scanSenderHealthNotifications() {
  const db = getDb()
  const emitted = []
  const errors = []

  try {
    const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()

    const [msgRes, queueRes] = await Promise.all([
      db
        .from('message_events')
        .select('direction,delivery_status,provider_delivery_status,is_opt_out,detected_intent,is_final_failure,from_phone_number,to_phone_number,market,message_body,created_at,failed_at,delivered_at,updated_at,metadata,textgrid_number_id,queue_id')
        .gte('created_at', since)
        .limit(5000),
      db
        .from('send_queue')
        .select('id,from_phone_number,textgrid_number,textgrid_number_id,market,message_body,message_text,rendered_message,queue_status,failed_reason,created_at,updated_at,failed_at,metadata')
        .gte('created_at', since)
        .in('queue_status', ['failed', 'blocked'])
        .limit(2000),
    ])

    if (msgRes.error) errors.push(msgRes.error.message)
    if (queueRes.error) errors.push(queueRes.error.message)

    const healthRows = buildTextGridSenderHealth(msgRes.data ?? [], queueRes.data ?? [])

    for (const sender of healthRows) {
      const senderNumber = clean(sender.sender)
      if (!senderNumber || senderNumber === 'unknown') continue

      const metrics = {
        sent_count: sender.sent_count,
        delivered_count: sender.delivered_count,
        failed_count: sender.failed_count,
        delivery_rate: sender.delivery_rate,
        failure_rate: sender.failure_rate,
        opt_out_rate: sender.opt_out_rate,
        content_filter_rate: sender.content_filter_rate,
      }

      if (sender.sent_count >= THRESHOLDS.MIN_SAMPLE_SIZE && sender.failure_rate >= 15) {
        const r = await emitScanEvent({
          event_type: 'sender_delivery_spike_failure',
          severity: sender.failure_rate >= 25 ? 'critical' : 'warning',
          sender_number_id: senderNumber,
          source_entity_id: senderNumber,
          title_vars: { sender_number: senderNumber },
          description: `Failure rate ${sender.failure_rate}% over 48h.`,
          metrics_snapshot: metrics,
          deduplication_key: buildDedupKey('sender_delivery_spike_failure', senderNumber),
          grouping_key: buildGroupingKey('sender_delivery_spike_failure', senderNumber),
        })
        if (r.ok) emitted.push(r.id)
      }

      if (sender.content_filter_count >= 5) {
        const r = await emitScanEvent({
          event_type: 'sender_content_filter_spike',
          severity: 'critical',
          sender_number_id: senderNumber,
          source_entity_id: senderNumber,
          title_vars: { sender_number: senderNumber },
          description: `${sender.content_filter_count} content filter blocks in 48h.`,
          metrics_snapshot: metrics,
          deduplication_key: buildDedupKey('sender_content_filter_spike', senderNumber),
          grouping_key: buildGroupingKey('sender_content_filter_spike', senderNumber),
        })
        if (r.ok) emitted.push(r.id)
      }

      if (sender.sent_count >= THRESHOLDS.MIN_SAMPLE_SIZE && sender.opt_out_rate >= 8) {
        const r = await emitScanEvent({
          event_type: 'sender_opt_out_spike',
          sender_number_id: senderNumber,
          source_entity_id: senderNumber,
          title_vars: { sender_number: senderNumber },
          description: `Opt-out rate ${sender.opt_out_rate}% over 48h.`,
          metrics_snapshot: metrics,
          deduplication_key: buildDedupKey('sender_opt_out_spike', senderNumber),
          grouping_key: buildGroupingKey('sender_opt_out_spike', senderNumber),
        })
        if (r.ok) emitted.push(r.id)
      }

      if (sender.delivery_rate >= 90 && sender.sent_count >= THRESHOLDS.MIN_SAMPLE_SIZE) {
        const r = await emitScanEvent({
          event_type: 'sender_delivery_improving',
          severity: 'positive',
          sender_number_id: senderNumber,
          source_entity_id: senderNumber,
          title_vars: { sender_number: senderNumber },
          description: `Delivery rate ${sender.delivery_rate}% over 48h.`,
          metrics_snapshot: metrics,
          deduplication_key: buildDedupKey('sender_delivery_improving', senderNumber),
          grouping_key: buildGroupingKey('sender_delivery_improving', senderNumber),
        })
        if (r.ok) emitted.push(r.id)
      }
    }

    return { emitted, errors, senders_checked: healthRows.length }
  } catch (err) {
    logger.warn('scan.senders_failed', { error: String(err?.message ?? err) })
    return { emitted, errors: [...errors, String(err?.message ?? err)], senders_checked: 0 }
  }
}

// ---------------------------------------------------------------------------
// Market scanner
// ---------------------------------------------------------------------------

export async function scanMarketNotifications() {
  const db = getDb()
  const emitted = []
  const errors = []

  try {
    let metrics
    try {
      metrics = await fetchOpsMetricsAggregate('24h')
    } catch (err) {
      errors.push(String(err?.message ?? err))
      return { emitted, errors, markets_checked: 0 }
    }

    const senderPerf = Array.isArray(metrics.sender_performance) ? metrics.sender_performance : []
    const marketMap = new Map()

    for (const row of senderPerf) {
      const market = clean(row.market) || 'unknown'
      if (!marketMap.has(market)) {
        marketMap.set(market, {
          market_key: market,
          sent: 0,
          delivered: 0,
          failed: 0,
          senders: new Set(),
        })
      }
      const entry = marketMap.get(market)
      entry.sent += Number(row.sent_count || 0)
      entry.delivered += Number(row.delivered_count || 0)
      entry.failed += Number(row.failed_count || 0)
      if (row.sender) entry.senders.add(row.sender)
    }

    // Also pull market aggregates from campaigns
    const { data: campaigns } = await db
      .from('campaigns')
      .select('market, sent_count, delivered_count, failed_count, opt_out_count, status')
      .in('status', ['active', 'activating'])
      .not('market', 'is', null)
      .limit(200)

    for (const c of campaigns ?? []) {
      const market = clean(c.market)
      if (!market) continue
      if (!marketMap.has(market)) {
        marketMap.set(market, { market_key: market, sent: 0, delivered: 0, failed: 0, senders: new Set() })
      }
      const entry = marketMap.get(market)
      entry.sent += Number(c.sent_count || 0)
      entry.delivered += Number(c.delivered_count || 0)
      entry.failed += Number(c.failed_count || 0)
    }

    for (const [, entry] of marketMap) {
      const marketKey = entry.market_key
      if (marketKey === 'unknown') continue

      const deliveryRate = pct(entry.delivered, entry.sent)
      const failureRate = pct(entry.failed, entry.sent)
      const senderCount = entry.senders.size
      const metricsSnap = {
        sent: entry.sent,
        delivered: entry.delivered,
        failed: entry.failed,
        delivery_rate_pct: deliveryRate,
        failure_rate_pct: failureRate,
        sender_count: senderCount,
      }

      if (entry.sent >= THRESHOLDS.MIN_SAMPLE_SIZE && deliveryRate < 65) {
        const r = await emitScanEvent({
          event_type: 'market_delivery_below_baseline',
          market_id: marketKey,
          source_entity_id: marketKey,
          title_vars: { market_key: marketKey },
          description: `Market delivery ${deliveryRate}% over 24h.`,
          metrics_snapshot: metricsSnap,
          deduplication_key: buildDedupKey('market_delivery_below_baseline', marketKey),
          grouping_key: buildGroupingKey('market_delivery_below_baseline', marketKey),
        })
        if (r.ok) emitted.push(r.id)
      }

      if (entry.sent >= THRESHOLDS.MIN_SAMPLE_SIZE && failureRate >= 15) {
        const r = await emitScanEvent({
          event_type: 'market_failure_rate_high',
          severity: 'critical',
          market_id: marketKey,
          source_entity_id: marketKey,
          title_vars: { market_key: marketKey },
          description: `Market failure rate ${failureRate}% over 24h.`,
          metrics_snapshot: metricsSnap,
          deduplication_key: buildDedupKey('market_failure_rate_high', marketKey),
          grouping_key: buildGroupingKey('market_failure_rate_high', marketKey),
        })
        if (r.ok) emitted.push(r.id)
      }

      if (senderCount > 0 && senderCount < 2 && entry.sent >= 50) {
        const r = await emitScanEvent({
          event_type: 'market_sender_diversity_low',
          market_id: marketKey,
          source_entity_id: marketKey,
          title_vars: { market_key: marketKey },
          description: `Only ${senderCount} sender(s) active in market.`,
          metrics_snapshot: metricsSnap,
          deduplication_key: buildDedupKey('market_sender_diversity_low', marketKey),
          grouping_key: buildGroupingKey('market_sender_diversity_low', marketKey),
        })
        if (r.ok) emitted.push(r.id)
      }
    }

    return { emitted, errors, markets_checked: marketMap.size }
  } catch (err) {
    logger.warn('scan.markets_failed', { error: String(err?.message ?? err) })
    return { emitted, errors: [...errors, String(err?.message ?? err)], markets_checked: 0 }
  }
}

// ---------------------------------------------------------------------------
// Platform health scanner
// ---------------------------------------------------------------------------

export async function scanPlatformHealthNotifications() {
  const emitted = []
  const errors = []

  try {
    const health = await fetchQueueProcessorHealth()
    const counts = health.counts || {}

    const metrics = {
      status: health.status,
      counts,
      oldest_queued_at: health.oldestQueuedAt,
      latest_sent_at: health.latestSentAt,
      latest_webhook_at: health.latestWebhookAt,
      source_used: health.sourceUsed,
    }

    if (health.status === 'degraded') {
      const r = await emitScanEvent({
        event_type: 'platform_queue_processor_degraded',
        severity: 'critical',
        source_entity_id: 'queue_processor',
        description: `Queue processor degraded. Lag active: ${counts.lagActive ?? 0}, stale: ${counts.staleActive ?? 0}.`,
        metrics_snapshot: metrics,
        deduplication_key: buildDedupKey('platform_queue_processor_degraded', 'queue_processor'),
        grouping_key: buildGroupingKey('platform_queue_processor_degraded', 'queue_processor'),
      })
      if (r.ok) emitted.push(r.id)
    }

    if (health.status === 'attention') {
      const r = await emitScanEvent({
        event_type: 'platform_queue_lag_detected',
        source_entity_id: 'queue_processor',
        description: `Queue attention state. Failed today: ${counts.failedToday ?? 0}.`,
        metrics_snapshot: metrics,
        deduplication_key: buildDedupKey('platform_queue_lag_detected', 'queue_processor'),
        grouping_key: buildGroupingKey('platform_queue_lag_detected', 'queue_processor'),
      })
      if (r.ok) emitted.push(r.id)
    }

    if (health.sourceUsed?.includes('fallback')) {
      const r = await emitScanEvent({
        event_type: 'platform_rpc_fallback_active',
        source_entity_id: 'ops_metrics',
        description: `Queue health using fallback path: ${health.sourceUsed}.`,
        metrics_snapshot: metrics,
        deduplication_key: buildDedupKey('platform_rpc_fallback_active', 'ops_metrics'),
        grouping_key: buildGroupingKey('platform_rpc_fallback_active', 'ops_metrics'),
      })
      if (r.ok) emitted.push(r.id)
    }

    const webhookAt = health.latestWebhookAt ? new Date(health.latestWebhookAt).getTime() : 0
    if (webhookAt && Date.now() - webhookAt > 30 * 60 * 1000) {
      const r = await emitScanEvent({
        event_type: 'platform_webhook_stale',
        source_entity_id: 'webhook_log',
        description: `Last webhook ${Math.round((Date.now() - webhookAt) / 60000)} minutes ago.`,
        metrics_snapshot: metrics,
        deduplication_key: buildDedupKey('platform_webhook_stale', 'webhook_log'),
        grouping_key: buildGroupingKey('platform_webhook_stale', 'webhook_log'),
      })
      if (r.ok) emitted.push(r.id)
    }

    if ((counts.failedToday ?? 0) >= 25) {
      const r = await emitScanEvent({
        event_type: 'platform_send_failure_spike',
        severity: 'critical',
        source_entity_id: 'send_queue',
        description: `${counts.failedToday} failed sends today.`,
        metrics_snapshot: metrics,
        deduplication_key: buildDedupKey('platform_send_failure_spike', 'send_queue'),
        grouping_key: buildGroupingKey('platform_send_failure_spike', 'send_queue'),
      })
      if (r.ok) emitted.push(r.id)
    }

    if (health.status === 'healthy') {
      const r = await emitScanEvent({
        event_type: 'platform_queue_processor_healthy',
        severity: 'positive',
        source_entity_id: 'queue_processor',
        description: 'Queue processor operating normally.',
        metrics_snapshot: metrics,
        deduplication_key: buildDedupKey('platform_queue_processor_healthy', 'queue_processor'),
        grouping_key: buildGroupingKey('platform_queue_processor_healthy', 'queue_processor'),
      })
      if (r.ok) emitted.push(r.id)
    }

    return { emitted, errors, platform_checks: 1 }
  } catch (err) {
    logger.warn('scan.platform_failed', { error: String(err?.message ?? err) })
    return { emitted, errors: [...errors, String(err?.message ?? err)], platform_checks: 0 }
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runNotificationIntelligenceScan(opts = {}) {
  const dryRun = opts.dry_run === true
  const startedAt = Date.now()

  const results = {
    dry_run: dryRun,
    started_at: new Date(startedAt).toISOString(),
    duration_ms: 0,
    scanners: {},
    total_emitted: 0,
    errors: [],
  }

  const scanners = [
    ['campaigns', scanCampaignNotifications],
    ['templates', scanTemplateNotifications],
    ['senders', scanSenderHealthNotifications],
    ['markets', scanMarketNotifications],
    ['platform', scanPlatformHealthNotifications],
  ]

  for (const [name, fn] of scanners) {
    if (dryRun) {
      results.scanners[name] = { skipped: true, reason: 'dry_run' }
      continue
    }
    try {
      const scanResult = await fn()
      results.scanners[name] = scanResult
      results.total_emitted += scanResult.emitted?.length ?? 0
      if (scanResult.errors?.length) results.errors.push(...scanResult.errors.map((e) => `${name}:${e}`))
    } catch (err) {
      results.scanners[name] = { error: String(err?.message ?? err) }
      results.errors.push(`${name}:${String(err?.message ?? err)}`)
    }
  }

  results.duration_ms = Date.now() - startedAt
  return results
}

export default runNotificationIntelligenceScan