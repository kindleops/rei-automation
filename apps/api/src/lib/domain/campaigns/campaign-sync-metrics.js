/**
 * Canonical campaign metrics sync — one source of truth for Campaign Command KPIs.
 */

import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { recomputeCampaignProgress } from '@/lib/domain/campaigns/campaign-progress.js'
import { buildCampaignCommandSummary } from '@/lib/domain/campaigns/campaign-command-summary.js'
import { isLiveCampaignStatus, normalizeCampaignStatus } from '@/lib/domain/campaigns/campaign-state-machine.js'
import { deriveOperatorState } from '@/lib/domain/campaigns/campaign-operator-state.js'

const ACTIVE_QUEUE_STATUSES = ['queued', 'scheduled', 'pending', 'ready', 'approved', 'processing', 'sending']
const TERMINAL_FAILURE_STATUSES = ['failed', 'expired', 'cancelled', 'suppressed', 'blocked']
const PROOF_QUEUE_STATUSES = ['queued', 'scheduled', 'pending', 'ready', 'approved', 'processing', 'sending', 'expired', 'cancelled', 'failed']

function clean(value) {
  return String(value ?? '').trim()
}

function asBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value
  const normalized = clean(value).toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return fallback
}

function isProofQueueRow(row = {}) {
  const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
  return (
    asBoolean(meta.no_send ?? meta.proof_no_send, false) ||
    clean(meta.launch_mode) === 'proof_hydration_no_send'
  )
}

function pct(numerator, denominator) {
  if (!denominator) return 0
  return Math.round((Number(numerator) / Number(denominator)) * 1000) / 10
}

function isOperatorActiveCampaign(campaign = {}, execution = {}) {
  const status = normalizeCampaignStatus(campaign.status)
  if (isLiveCampaignStatus(status)) return true
  if (status === 'scheduled') return true
  if (status === 'paused' && Number(campaign.ready_targets ?? 0) > 0) return true
  const operator = deriveOperatorState(campaign, execution, {})
  return operator === 'test_mode' || operator === 'live' || operator === 'blocked'
}

function isTestOrMockCampaign(campaign = {}) {
  const name = clean(campaign.name || campaign.campaign_name).toLowerCase()
  const meta = campaign.metadata && typeof campaign.metadata === 'object' ? campaign.metadata : {}
  if (asBoolean(meta.is_test ?? meta.test_campaign ?? meta.mock_campaign, false)) return true
  if (name.includes('proof ') || name.startsWith('proof') || name.includes('test campaign') || name === 'test') return true
  if (name.includes('activate test')) return true
  return false
}

async function loadCurrentRunId(supabase, campaignId) {
  const { data } = await supabase
    .from('campaign_runs')
    .select('id')
    .eq('campaign_id', campaignId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data?.id || null
}

async function aggregateScopedFailures(supabase, campaignId, runId = null) {
  const { data: rows, error } = await supabase
    .from('send_queue')
    .select('id,queue_status,metadata,failed_reason,updated_at')
    .eq('campaign_id', campaignId)
    .in('queue_status', TERMINAL_FAILURE_STATUSES)
    .limit(5000)
  if (error) throw error

  const scoped = (rows || []).filter((row) => {
    if (isProofQueueRow(row)) return false
    const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
    const rowRun = clean(meta.run_id || meta.campaign_run_id)
    if (!runId) return clean(row.queue_status) === 'failed'
    return rowRun === runId
  })

  return {
    failed_execution_rows: scoped.length,
    historical_excluded: Math.max(0, (rows || []).length - scoped.length),
  }
}

async function aggregateTodaySendMetrics(supabase, campaignId) {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const { data: rows, error } = await supabase
    .from('send_queue')
    .select('id,queue_status,sent_at,delivered_at,metadata')
    .eq('campaign_id', campaignId)
    .gte('sent_at', start.toISOString())
    .limit(10000)
  if (error) throw error

  let sentToday = 0
  let deliveredToday = 0
  for (const row of rows || []) {
    if (isProofQueueRow(row)) continue
    if (row.sent_at) sentToday += 1
    if (row.delivered_at || clean(row.queue_status) === 'delivered') deliveredToday += 1
  }
  return { sentToday, deliveredToday }
}

export async function syncCampaignMetrics(campaignId, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  if (!campaignId) return { ok: false, error: 'campaign_id_required' }

  const recomputed = await recomputeCampaignProgress(campaignId, deps)
  const summary = await buildCampaignCommandSummary(campaignId, deps)
  if (!summary.ok) return { ok: false, error: summary.error || 'summary_failed', recomputed }

  const runId = summary.run_id || await loadCurrentRunId(supabase, campaignId)
  const [failures, today] = await Promise.all([
    aggregateScopedFailures(supabase, campaignId, runId),
    aggregateTodaySendMetrics(supabase, campaignId),
  ])

  const counts = summary.counts || {}
  const sent = Number(counts.sent_rows || 0)
  const failedScoped = failures.failed_execution_rows + Number(counts.failed_target_rows || 0)
  const delivered = Number(counts.delivered_rows || 0)
  const replied = Number(counts.replied_rows || 0)
  const positive = Number(counts.positive || counts.replied_positive || 0)
  const optedOut = Number(counts.opted_out_rows || 0)

  const patch = {
    queued_count: Number(counts.queued_rows || 0) + Number(counts.scheduled_queue_rows || 0),
    sent_count: sent,
    delivered_count: delivered,
    failed_count: failedScoped,
    replied_count: replied,
    positive_count: positive,
    opt_out_count: optedOut,
    progress_synced_at: new Date().toISOString(),
    metadata: undefined,
  }

  const { data: existing } = await supabase.from('campaigns').select('metadata').eq('id', campaignId).maybeSingle()
  const metadata = {
    ...(existing?.metadata && typeof existing.metadata === 'object' ? existing.metadata : {}),
    metrics_synced_at: patch.progress_synced_at,
    metrics_run_id: runId,
    historical_failures_excluded: failures.historical_excluded,
    proof_rows_excluded_from_live_counts: Number(counts.proof_no_send_rows || 0),
  }
  patch.metadata = metadata

  const { data: campaign, error: updateError } = await supabase
    .from('campaigns')
    .update({
      queued_count: patch.queued_count,
      sent_count: patch.sent_count,
      delivered_count: patch.delivered_count,
      failed_count: patch.failed_count,
      replied_count: patch.replied_count,
      positive_count: patch.positive_count,
      opt_out_count: patch.opt_out_count,
      progress_synced_at: patch.progress_synced_at,
      metadata,
    })
    .eq('id', campaignId)
    .select('*')
    .maybeSingle()
  if (updateError) return { ok: false, error: updateError.message || 'metrics_update_failed' }

  return {
    ok: true,
    campaign_id: campaignId,
    campaign,
    run_id: runId,
    recomputed: recomputed.ok,
    summary,
    counts: {
      ...counts,
      failed_execution_rows: failures.failed_execution_rows,
      failed_total_scoped: failedScoped,
      historical_failures_excluded: failures.historical_excluded,
      sent_today: today.sentToday,
      delivered_today: today.deliveredToday,
      reply_rate: pct(replied, delivered),
      failure_rate: pct(failedScoped, Math.max(sent, 1)),
      opt_out_rate: pct(optedOut, Math.max(sent, 1)),
    },
  }
}

export async function syncPortfolioMetrics(deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const { data: campaigns, error } = await supabase
    .from('campaigns')
    .select('id,status,name,metadata')
    .neq('status', 'archived')
    .limit(200)
  if (error) throw error

  const summaries = []
  for (const row of campaigns || []) {
    const result = await syncCampaignMetrics(row.id, deps)
    if (result.ok) summaries.push(result)
  }

  let activeCampaigns = 0
  let totalTargets = 0
  let readyTargets = 0
  let scheduledQueueRows = 0
  let plannedTargets = 0
  let sentToday = 0
  let deliveredToday = 0
  let positiveReplies = 0
  let totalSent = 0
  let totalFailed = 0
  let totalOptOut = 0
  let totalReplied = 0

  for (const item of summaries) {
    const c = item.counts || {}
    const campaign = item.campaign || {}
    if (isOperatorActiveCampaign(campaign, item.summary?.execution || {})) activeCampaigns += 1
    totalTargets += Number(c.total_targets || 0)
    readyTargets += Number(c.ready_targets || 0)
    scheduledQueueRows += Number(c.scheduled_queue_rows || 0)
    plannedTargets += Number(c.planned_targets || 0)
    sentToday += Number(c.sent_today || 0)
    deliveredToday += Number(c.delivered_today || 0)
    positiveReplies += Number(c.positive || c.replied_positive || campaign.positive_count || 0)
    totalSent += Number(c.sent_rows || campaign.sent_count || 0)
    totalFailed += Number(c.failed_total_scoped || campaign.failed_count || 0)
    totalOptOut += Number(c.opted_out_rows || campaign.opt_out_count || 0)
    totalReplied += Number(c.replied_rows || campaign.replied_count || 0)
  }

  return {
    ok: true,
    campaigns_synced: summaries.length,
    kpis: {
      activeCampaigns,
      totalTargets,
      readyTargets,
      scheduledQueueRows,
      plannedTargets,
      sentToday,
      deliveredToday,
      replyRate: pct(totalReplied, deliveredToday || totalSent),
      positiveReplies,
      optOutRate: pct(totalOptOut, totalSent),
      failureRate: pct(totalFailed, totalSent),
    },
    campaigns: summaries,
  }
}

export { isTestOrMockCampaign, isProofQueueRow, isOperatorActiveCampaign }