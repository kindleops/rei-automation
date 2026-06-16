/**
 * Campaign progress engine (Phase 2C).
 *
 * Deterministic progress metrics derived from real send_queue rows and
 * message_events — no fake counters. The canonical path is the Postgres
 * `campaign_recompute_progress` function + `campaign_runtime_summary` view
 * (cheap, bounded aggregation). Both degrade to an equivalent JS computation
 * when not yet deployed, so the UX never reads stale/garbage data.
 */

import { supabase as defaultSupabase } from '../lib/supabase/client.js'

const ACTIVE_QUEUE_STATUSES = new Set([
  'queued', 'scheduled', 'pending', 'ready', 'approved', 'processing', 'sending',
])
const FAILED_QUEUE_STATUSES = new Set(['failed', 'failed_transport'])
const POSITIVE_INTENTS = new Set([
  'ownership_confirmed', 'asking_price_provided', 'asks_offer',
  'seller_interested', 'needs_call', 'need_time',
])

function rpcFunctionMissing(error) {
  if (!error) return false
  const code = error.code || ''
  const msg = `${error.message || ''} ${error.details || ''} ${error.hint || ''}`.toLowerCase()
  return (
    code === '42883' || code === 'PGRST202' || code === '42P01' ||
    msg.includes('could not find') || msg.includes('does not exist')
  )
}

function pct(numerator, denominator) {
  if (!denominator) return 0
  return Math.round((Number(numerator) / Number(denominator)) * 1000) / 10
}

/** Recompute and persist progress counters for a campaign. */
export async function recomputeCampaignProgress(campaignId, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  if (!campaignId) return { ok: false, error: 'campaign_id_required' }

  const { data, error } = await supabase.rpc('campaign_recompute_progress', {
    p_campaign_id: campaignId,
  })
  if (!error) {
    const row = Array.isArray(data) ? data[0] : data
    return { ok: true, campaign: row || null }
  }
  if (!rpcFunctionMissing(error)) return { ok: false, error: error.message || 'recompute_failed' }
  return recomputeCampaignProgressFallback(supabase, campaignId)
}

async function recomputeCampaignProgressFallback(supabase, campaignId) {
  const { data: queueRows, error: queueError } = await supabase
    .from('send_queue')
    .select('id,queue_status,sent_at,delivered_at,failed_reason')
    .eq('campaign_id', campaignId)
    .limit(50000)
  if (queueError) return { ok: false, error: queueError.message || 'queue_read_failed' }

  const rows = queueRows || []
  const counts = { queued: 0, sent: 0, delivered: 0, failed: 0, replied: 0, positive: 0, opt_out: 0 }
  const queueIds = []
  for (const r of rows) {
    const status = String(r.queue_status || '').toLowerCase()
    queueIds.push(r.id)
    if (ACTIVE_QUEUE_STATUSES.has(status)) counts.queued += 1
    if (r.sent_at || status === 'sent' || status === 'delivered') counts.sent += 1
    if (r.delivered_at || status === 'delivered') counts.delivered += 1
    if (FAILED_QUEUE_STATUSES.has(status) || r.failed_reason) counts.failed += 1
  }

  if (queueIds.length) {
    // chunk the IN() to keep the bounded-attribution guarantee
    for (let i = 0; i < queueIds.length; i += 1000) {
      const chunk = queueIds.slice(i, i + 1000)
      const { data: events } = await supabase
        .from('message_events')
        .select('direction,detected_intent,is_opt_out')
        .in('queue_id', chunk)
        .limit(50000)
      for (const e of events || []) {
        if (String(e.direction || '').toLowerCase() !== 'inbound') continue
        counts.replied += 1
        const intent = String(e.detected_intent || '').toLowerCase()
        if (POSITIVE_INTENTS.has(intent)) counts.positive += 1
        if (e.is_opt_out === true || intent === 'opt_out') counts.opt_out += 1
      }
    }
  }

  const patch = {
    queued_count: counts.queued, sent_count: counts.sent, delivered_count: counts.delivered,
    failed_count: counts.failed, replied_count: counts.replied, positive_count: counts.positive,
    opt_out_count: counts.opt_out, progress_synced_at: new Date().toISOString(),
  }
  const { data: updated, error: updateError } = await supabase
    .from('campaigns').update(patch).eq('id', campaignId).select('*').maybeSingle()
  if (updateError && !rpcFunctionMissing(updateError)) {
    return { ok: false, error: updateError.message || 'progress_update_failed' }
  }
  return { ok: true, campaign: updated || null, counts, degraded: true }
}

/** Read the lightweight runtime summary (cached counters + derived rates). */
export async function getCampaignRuntimeSummary(campaignId, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  if (!campaignId) return { ok: false, error: 'campaign_id_required' }

  const { data, error } = await supabase
    .from('campaign_runtime_summary')
    .select('*')
    .eq('campaign_id', campaignId)
    .maybeSingle()
  if (!error && data) return { ok: true, summary: data }
  if (error && !rpcFunctionMissing(error)) return { ok: false, error: error.message || 'summary_failed' }

  // Fallback: read counters off the campaign row and derive rates in JS.
  const { data: c, error: cErr } = await supabase
    .from('campaigns')
    .select('id,name,status,scheduled_for,activated_at,paused_at,completed_at,failed_at,failure_reason,last_transition_at,activation_attempt_count,execution_heartbeat_at,hydration_cursor,progress_synced_at,queued_count,sent_count,delivered_count,failed_count,replied_count,positive_count,opt_out_count')
    .eq('id', campaignId)
    .maybeSingle()
  if (cErr) return { ok: false, error: cErr.message || 'campaign_read_failed' }
  if (!c) return { ok: false, error: 'campaign_not_found' }

  const sent = Number(c.sent_count || 0)
  const queued = Number(c.queued_count || 0)
  const summary = {
    campaign_id: c.id,
    name: c.name,
    status: c.status,
    scheduled_for: c.scheduled_for ?? null,
    activated_at: c.activated_at ?? null,
    paused_at: c.paused_at ?? null,
    completed_at: c.completed_at ?? null,
    failed_at: c.failed_at ?? null,
    failure_reason: c.failure_reason ?? null,
    last_transition_at: c.last_transition_at ?? null,
    activation_attempt_count: Number(c.activation_attempt_count || 0),
    hydration_active: false,
    execution_heartbeat_at: c.execution_heartbeat_at ?? null,
    hydration_cursor: c.hydration_cursor ?? {},
    progress_synced_at: c.progress_synced_at ?? null,
    queued_count: queued,
    sent_count: sent,
    delivered_count: Number(c.delivered_count || 0),
    failed_count: Number(c.failed_count || 0),
    replied_count: Number(c.replied_count || 0),
    positive_count: Number(c.positive_count || 0),
    opt_out_count: Number(c.opt_out_count || 0),
    total_planned: queued + sent,
    delivery_rate_pct: pct(c.delivered_count, sent),
    reply_rate_pct: pct(c.replied_count, sent),
    positive_rate_pct: pct(c.positive_count, c.replied_count),
    opt_out_rate_pct: pct(c.opt_out_count, sent),
    hydration_progress_pct: pct(sent, queued + sent),
  }
  return { ok: true, summary, degraded: true }
}
