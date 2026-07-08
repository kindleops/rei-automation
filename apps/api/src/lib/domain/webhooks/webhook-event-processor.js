import { randomUUID } from 'node:crypto'

import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import {
  syncDeliveryEvent,
  markWebhookLogProcessed,
  markWebhookLogFailed,
} from '@/lib/supabase/sms-engine.js'
import { syncCampaignMetrics } from '@/lib/domain/campaigns/campaign-sync-metrics.js'
import { maybeScheduleFollowUpAfterDelivery } from '@/lib/domain/seller-flow/delivery-triggered-followup.js'
import { resolveDeployGitSha } from '@/lib/domain/deploy/resolve-deploy-sha.js'
import { handleTextgridInbound } from '@/lib/flows/handle-textgrid-inbound.js'
import { warn, info } from '@/lib/logging/logger.js'
import {
  WEBHOOK_PROCESSOR_VERSION,
  groupDeliveryEventsByProvider,
  selectTerminalDeliveryEvent,
  detectContradictoryTerminalStates,
  buildSyncPayloadFromTerminalEvent,
  normalizeProviderEventPayload,
  isInboundWebhookRow,
  inboundProcessingPriority,
} from '@/lib/domain/webhooks/provider-event-state-machine.js'

const DELIVERY_EVENT_TYPES = ['delivery', 'status', 'outbound']

function clean(value) {
  return String(value ?? '').trim()
}

function nowIso() {
  return new Date().toISOString()
}

function buildProcessingMeta({
  lane,
  execution_id,
  result,
  matched_record_id = null,
  error_code = null,
} = {}) {
  return {
    processor_version: WEBHOOK_PROCESSOR_VERSION,
    deployed_sha: resolveDeployGitSha(),
    reconciliation_execution_id: execution_id || null,
    processing_lane: lane || 'live',
    processing_result: result || null,
    matched_record_id: matched_record_id || null,
    processing_error_code: error_code || null,
  }
}

async function markWebhookRowsProcessed(webhook_ids = [], meta = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const now = deps.now || nowIso()
  const ids = [...new Set(webhook_ids.map((id) => clean(id)).filter(Boolean))]
  if (!ids.length) return { updated: 0 }

  const update = {
    processed: true,
    processed_at: now,
    error_message: null,
    processor_version: meta.processor_version || WEBHOOK_PROCESSOR_VERSION,
    deployed_sha: meta.deployed_sha || resolveDeployGitSha(),
    reconciliation_execution_id: meta.reconciliation_execution_id || null,
    processing_result: meta.processing_result || null,
    matched_record_id: meta.matched_record_id || null,
    processing_error_code: null,
  }

  const results = []
  for (const id of ids) {
    try {
      const row = await markWebhookLogProcessed(id, { supabase, now, ...update, ...meta })
      results.push(row)
    } catch (error) {
      const { data } = await supabase
        .from('webhook_log')
        .update({
          processed: true,
          processed_at: now,
          error_message: null,
        })
        .eq('id', id)
        .select('id')
        .maybeSingle()
      if (data) results.push(data)
    }
  }

  return { updated: results.length, ids }
}

async function markWebhookRowsUnmatched(webhook_ids = [], reason, meta = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const now = deps.now || nowIso()
  const processing_result = {
    status: 'unmatched',
    reason: reason || 'no_local_record',
    ...meta.processing_result,
  }

  for (const id of webhook_ids) {
    await markWebhookLogProcessed(id, {
      supabase,
      now,
      processor_version: WEBHOOK_PROCESSOR_VERSION,
      deployed_sha: resolveDeployGitSha(),
      reconciliation_execution_id: meta.reconciliation_execution_id || null,
      processing_result,
      matched_record_id: null,
      processing_error_code: 'unmatched_provider_id',
    }).catch(() =>
      supabase
        .from('webhook_log')
        .update({
          processed: true,
          processed_at: now,
          error_message: `unmatched:${reason}`,
        })
        .eq('id', id)
    )
  }
}

async function syncCampaignMetricsForQueueRows(rows = [], deps = {}) {
  const campaign_ids = [
    ...new Set((rows || []).map((row) => clean(row?.campaign_id)).filter(Boolean)),
  ]
  for (const campaign_id of campaign_ids) {
    try {
      await syncCampaignMetrics(campaign_id, deps)
    } catch (error) {
      warn('webhook_processor.campaign_metrics_sync_failed', {
        campaign_id,
        error: error?.message || 'sync_failed',
      })
    }
  }
}

/**
 * Live lane: process one delivery webhook immediately after durable persistence.
 */
export async function processDeliveryWebhookLive(webhook_log_row, options = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const now = options.now || nowIso()
  const execution_id = options.execution_id || randomUUID()
  const lane = 'live'
  const started = Date.now()

  const normalized = normalizeProviderEventPayload(webhook_log_row)
  if (!normalized.provider_message_sid || !normalized.provider_status) {
    await markWebhookLogFailed(
      webhook_log_row?.id,
      'missing_message_or_status',
      { supabase, now }
    )
    return {
      ok: false,
      lane,
      reason: 'missing_message_or_status',
      latency_ms: Date.now() - started,
    }
  }

  const sync_payload = buildSyncPayloadFromTerminalEvent(normalized)

  const syncFn = deps.syncDeliveryEvent || syncDeliveryEvent

  try {
    const result = await syncFn(sync_payload, {
      supabase,
      now,
      webhook_log_id: webhook_log_row?.id || null,
      force_local_delivery_reconcile: options.force_local_delivery_reconcile === true,
    })

    const matched =
      Number(result?.send_queue_count || 0) > 0 || Number(result?.message_events_count || 0) > 0

    const processing_result = {
      status: matched ? 'matched' : 'unmatched',
      final_delivery_status: result?.final_delivery_status || normalized.canonical_status,
      send_queue_count: result?.send_queue_count || 0,
      message_events_count: result?.message_events_count || 0,
      provider_message_sid: normalized.provider_message_sid,
    }

    const meta = buildProcessingMeta({
      lane,
      execution_id,
      result: processing_result,
      matched_record_id: matched ? normalized.provider_message_sid : null,
      error_code: matched ? null : 'unmatched_provider_id',
    })

    if (matched) {
      await markWebhookRowsProcessed([webhook_log_row.id], meta, { supabase, now })
    } else {
      await markWebhookRowsUnmatched([webhook_log_row.id], 'no_local_record_on_live', meta, {
        supabase,
        now,
      })
    }

    // Delivery-confirmed follow-up trigger: only a matched, provider-confirmed
    // delivery may schedule the next touch (the gate rejects everything else).
    let delivery_followup = { ok: true, scheduled: false, reason: 'not_attempted' }
    if (matched) {
      const scheduleAfterDelivery =
        deps.maybeScheduleFollowUpAfterDelivery || maybeScheduleFollowUpAfterDelivery
      delivery_followup = await scheduleAfterDelivery({
        provider_message_sid: normalized.provider_message_sid,
        final_delivery_status: processing_result.final_delivery_status,
        supabase,
      })
    }

    info('webhook_processor.delivery_live_processed', {
      provider_message_sid: normalized.provider_message_sid,
      matched,
      final_delivery_status: processing_result.final_delivery_status,
      delivery_followup_scheduled: delivery_followup.scheduled,
      delivery_followup_reason: delivery_followup.reason,
      latency_ms: Date.now() - started,
    })

    return {
      ok: true,
      lane,
      matched,
      ...processing_result,
      delivery_followup,
      latency_ms: Date.now() - started,
      execution_id,
    }
  } catch (error) {
    await markWebhookLogFailed(webhook_log_row?.id, error?.message || 'delivery_live_failed', {
      supabase,
      now,
    })
    throw error
  }
}

/**
 * Recovery lane: compact processing for a provider message ID group.
 */
export async function processDeliveryProviderGroup(
  { provider_message_sid, webhook_rows = [], events = [] },
  options = {},
  deps = {}
) {
  const supabase = deps.supabase || defaultSupabase
  const now = options.now || nowIso()
  const execution_id = options.execution_id || randomUUID()
  const lane = 'recovery'

  const normalized_events =
    events.length > 0
      ? events
      : (webhook_rows || []).map((row) => normalizeProviderEventPayload(row))

  const contradiction = detectContradictoryTerminalStates(normalized_events)
  if (contradiction.contradictory) {
    warn('webhook_processor.contradictory_terminal_states', {
      provider_message_sid,
      ...contradiction,
      execution_id,
    })
  }

  const terminal = selectTerminalDeliveryEvent(normalized_events)
  if (!terminal) {
    return {
      ok: false,
      lane,
      provider_message_sid,
      reason: 'no_processable_events',
      webhook_ids: (webhook_rows || []).map((r) => r.id),
    }
  }

  const sync_payload = buildSyncPayloadFromTerminalEvent(terminal)

  const syncFn = deps.syncDeliveryEvent || syncDeliveryEvent

  try {
    const result = await syncFn(sync_payload, {
      supabase,
      now,
      webhook_log_id: terminal.webhook_log_id || null,
      force_local_delivery_reconcile: options.force_local_delivery_reconcile === true,
    })

    const matched =
      Number(result?.send_queue_count || 0) > 0 || Number(result?.message_events_count || 0) > 0

    const webhook_ids = (webhook_rows || []).map((r) => r.id).filter(Boolean)
    const processing_result = {
      status: matched ? 'matched' : 'unmatched',
      final_delivery_status: result?.final_delivery_status || terminal.canonical_status,
      terminal_provider_status: terminal.canonical_status,
      events_in_group: normalized_events.length,
      contradictory_terminal: contradiction.contradictory,
      send_queue_count: result?.send_queue_count || 0,
      message_events_count: result?.message_events_count || 0,
    }

    const meta = buildProcessingMeta({
      lane,
      execution_id,
      result: processing_result,
      matched_record_id: matched ? provider_message_sid : null,
    })

    if (matched) {
      await markWebhookRowsProcessed(webhook_ids, meta, { supabase, now })
    } else {
      await markWebhookRowsUnmatched(webhook_ids, 'no_local_record_on_recovery', meta, {
        supabase,
        now,
      })
    }

    return {
      ok: true,
      lane,
      provider_message_sid,
      matched,
      recovered: webhook_ids.length,
      ...processing_result,
      execution_id,
    }
  } catch (error) {
    const webhook_ids = (webhook_rows || []).map((r) => r.id).filter(Boolean)
    for (const id of webhook_ids) {
      await markWebhookLogFailed(id, error?.message || 'recovery_group_failed', { supabase, now }).catch(
        () => {}
      )
    }
    return {
      ok: false,
      lane,
      provider_message_sid,
      reason: error?.message || 'recovery_group_failed',
      webhook_ids,
    }
  }
}

/**
 * Process explicit provider IDs (e.g. LA campaign proof).
 */
export async function processDeliveryProviderIds(provider_message_sids = [], options = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const execution_id = options.execution_id || randomUUID()
  const sids = [...new Set(provider_message_sids.map((s) => clean(s)).filter(Boolean))]
  const results = []

  for (const sid of sids) {
    const { data: rows, error } = await supabase
      .from('webhook_log')
      .select('id,provider_message_sid,payload,event_type,processed,created_at,direction')
      .eq('processed', false)
      .eq('provider_message_sid', sid)
      .in('event_type', DELIVERY_EVENT_TYPES)
      .order('created_at', { ascending: true })

    if (error) {
      results.push({ ok: false, provider_message_sid: sid, reason: error.message })
      continue
    }

    if (!rows?.length) {
      const { data: payloadRows } = await supabase
        .from('webhook_log')
        .select('id,provider_message_sid,payload,event_type,processed,created_at,direction')
        .eq('processed', false)
        .in('event_type', DELIVERY_EVENT_TYPES)
        .filter('payload->>message_id', 'eq', sid)
        .order('created_at', { ascending: true })
        .limit(50)

      if (!payloadRows?.length) {
        results.push({ ok: false, provider_message_sid: sid, reason: 'no_unprocessed_webhooks' })
        continue
      }

      const group = { provider_message_sid: sid, webhook_rows: payloadRows, events: [] }
      const outcome = await processDeliveryProviderGroup(group, { ...options, execution_id }, deps)
      results.push(outcome)
      continue
    }

    const group = { provider_message_sid: sid, webhook_rows: rows, events: [] }
    const outcome = await processDeliveryProviderGroup(group, { ...options, execution_id }, deps)
    results.push(outcome)
  }

  return {
    ok: true,
    execution_id,
    targeted: sids.length,
    results,
    matched: results.filter((r) => r.matched).length,
    unmatched: results.filter((r) => r.ok && !r.matched).length,
    failed: results.filter((r) => r.ok === false).length,
  }
}

/**
 * Inbound priority lane — process webhook_log inbound records through seller automation.
 */
export async function processInboundWebhookLive(webhook_log_row, options = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const now = options.now || nowIso()
  const execution_id = options.execution_id || randomUUID()
  const lane = 'inbound_live'
  const started = Date.now()

  const payload = webhook_log_row?.payload && typeof webhook_log_row.payload === 'object'
    ? webhook_log_row.payload
    : {}

  if (!payload.from && !payload.message_id) {
    await markWebhookLogFailed(webhook_log_row?.id, 'invalid_inbound_payload', { supabase, now })
    return { ok: false, lane, reason: 'invalid_inbound_payload' }
  }

  const provider_message_sid = clean(payload.message_id || webhook_log_row.provider_message_sid)

  const { data: existing } = await supabase
    .from('message_events')
    .select('id,metadata')
    .eq('provider_message_sid', provider_message_sid)
    .eq('direction', 'inbound')
    .maybeSingle()

  const existing_meta = existing?.metadata && typeof existing.metadata === 'object' ? existing.metadata : {}
  if (existing_meta.seller_flow_completed === true || existing_meta.webhook_processed === true) {
    const meta = buildProcessingMeta({
      lane,
      execution_id,
      result: { status: 'already_processed', message_event_id: existing?.id || null },
      matched_record_id: existing?.id || null,
    })
    await markWebhookRowsProcessed([webhook_log_row.id], meta, { supabase, now })
    return {
      ok: true,
      lane,
      skipped: true,
      reason: 'already_persisted',
      latency_ms: Date.now() - started,
    }
  }

  const handleInbound = deps.handleTextgridInbound || handleTextgridInbound
  const result = await handleInbound(payload, {
    inbound_user_initiated: true,
    auto_reply_enabled: options.auto_reply_enabled ?? process.env.INBOUND_AUTOPILOT_ENABLED ?? null,
    auto_reply_live_enabled: options.auto_reply_live_enabled ?? process.env.AUTO_REPLY_LIVE_ENABLED ?? null,
    auto_reply_mode: options.auto_reply_mode ?? process.env.AUTO_REPLY_MODE ?? null,
    webhook_log_id: webhook_log_row?.id || null,
    ...options.inbound_options,
  })

  const processing_result = {
    status: result?.ok !== false ? 'processed' : 'failed',
    reason: result?.reason || null,
    retryable: Boolean(result?.retryable),
    provider_message_sid,
  }

  const meta = buildProcessingMeta({
    lane,
    execution_id,
    result: processing_result,
    matched_record_id: provider_message_sid,
    error_code: result?.ok === false ? result?.reason || 'inbound_failed' : null,
  })

  if (result?.ok !== false) {
    await markWebhookRowsProcessed([webhook_log_row.id], meta, { supabase, now })
  } else if (!result?.retryable) {
    await markWebhookRowsUnmatched([webhook_log_row.id], result?.reason || 'inbound_failed', meta, {
      supabase,
      now,
    })
  } else {
    await markWebhookLogFailed(
      webhook_log_row.id,
      result?.reason || 'inbound_retryable_failure',
      { supabase, now }
    )
  }

  return {
    ok: result?.ok !== false,
    lane,
    result,
    latency_ms: Date.now() - started,
    execution_id,
  }
}

export async function processInboundWebhookRecovery(options = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const limit = Math.max(Number(options.limit ?? 25), 1)
  const execution_id = options.execution_id || randomUUID()
  const now = options.now || nowIso()

  const { data: rows, error } = await supabase
    .from('webhook_log')
    .select('id,provider_message_sid,payload,event_type,processed,created_at,direction')
    .eq('processed', false)
    .eq('event_type', 'inbound')
    .order('created_at', { ascending: false })
    .limit(limit * 3)

  if (error) throw error

  const inbound_rows = (rows || [])
    .filter((row) => isInboundWebhookRow(row))
    .sort((a, b) => inboundProcessingPriority(b) - inboundProcessingPriority(a))
    .slice(0, limit)

  const results = []
  for (const row of inbound_rows) {
    const outcome = await processInboundWebhookLive(row, { ...options, execution_id, now }, deps)
    results.push({ webhook_log_id: row.id, ...outcome })
  }

  return {
    ok: true,
    execution_id,
    scanned: inbound_rows.length,
    processed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results: results.slice(0, 25),
  }
}

export { groupDeliveryEventsByProvider, WEBHOOK_PROCESSOR_VERSION }