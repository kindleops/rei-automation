/**
 * Canonical campaign feeder — replenishes active production campaigns.
 */

import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { asBoolean } from '@/lib/domain/queue/queue-control-safety.js'
import { getSystemValue, setSystemValues } from '@/lib/system-control.js'
import { createCampaignQueuePlan } from '@/lib/domain/campaigns/campaign-automation-service.js'
import { isLiveCampaignStatus, normalizeCampaignStatus } from '@/lib/domain/campaigns/campaign-state-machine.js'
import {
  computeNextValidSendInstant,
} from '@/lib/domain/campaigns/campaign-convert-to-live.js'
import {
  isCampaignFullyLive,
  isCampaignProductionLaunch,
  mergeLaunchWriteModeIntoInput,
} from '@/lib/domain/campaigns/campaign-live-execution.js'
import { recomputeCampaignProgress } from '@/lib/domain/campaigns/campaign-progress.js'

const ACTIVE_QUEUE_STATUSES = ['queued', 'scheduled', 'pending', 'ready', 'approved', 'processing', 'sending']

function clean(value) {
  return String(value ?? '').trim()
}

function asPositiveInteger(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback
}

async function countActiveLiveQueueRows(supabase, campaignId) {
  const { data, error } = await supabase
    .from('send_queue')
    .select('id,metadata')
    .eq('campaign_id', campaignId)
    .in('queue_status', ACTIVE_QUEUE_STATUSES)
  if (error) throw error

  let live = 0
  for (const row of data || []) {
    const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
    const proof =
      asBoolean(meta.no_send ?? meta.proof_no_send, false) ||
      clean(meta.launch_mode) === 'proof_hydration_no_send'
    if (!proof) live += 1
  }
  return live
}

async function countSentToday(supabase, campaignId, timezone = 'America/New_York') {
  const now = new Date()
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]))
  const dayStart = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00`)
  const { count, error } = await supabase
    .from('send_queue')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .in('queue_status', ['sent', 'delivered', 'sending', 'processing'])
    .gte('updated_at', dayStart.toISOString())
  if (error) throw error
  return Number(count || 0)
}

function resolveBatchLimit(campaign = {}, activeLiveRows = 0) {
  const batchMax = asPositiveInteger(campaign.batch_max, 5)
  const dailyCap = asPositiveInteger(campaign.daily_cap, batchMax)
  const totalCap = asPositiveInteger(campaign.total_cap, dailyCap)
  const sentCount = asPositiveInteger(campaign.sent_count, 0)
  const remainingTotal = Math.max(0, totalCap - sentCount)
  const targetBuffer = batchMax
  const need = Math.max(0, targetBuffer - activeLiveRows)
  return Math.min(need, batchMax, dailyCap, remainingTotal)
}

export async function findFeedableCampaigns(deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const { data, error } = await supabase
    .from('campaigns')
    .select('*')
    .eq('status', 'active')
    .eq('auto_queue_enabled', true)
    .eq('auto_send_enabled', true)
    .order('execution_heartbeat_at', { ascending: true, nullsFirst: true })
    .limit(20)
  if (error) throw error
  return (data || []).filter((campaign) => {
    const status = normalizeCampaignStatus(campaign.status)
    return isLiveCampaignStatus(status) && isCampaignProductionLaunch(campaign)
  })
}

export async function feedCampaignBatch(campaign, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const activeLiveRows = await countActiveLiveQueueRows(supabase, campaign.id)
  const batchLimit = resolveBatchLimit(campaign, activeLiveRows)
  if (batchLimit <= 0) {
    return {
      ok: true,
      campaign_id: campaign.id,
      skipped: true,
      reason: 'buffer_satisfied_or_caps_reached',
      active_live_rows: activeLiveRows,
      batch_limit: 0,
      inserted: 0,
    }
  }

  const schedule = computeNextValidSendInstant(campaign)
  const launchInput = mergeLaunchWriteModeIntoInput(campaign, {
    lock_owner: 'campaign_feeder',
    production_live_write: true,
    explicit_operator_action: true,
    scheduled_for: schedule.scheduled_for,
    first_scheduled_at: schedule.scheduled_for,
    batch_max: batchLimit,
    limit: batchLimit,
    daily_cap: campaign.daily_cap,
    per_sender_cap: campaign.per_sender_cap,
    per_market_cap: campaign.market_cap,
    block_on_global_emergency_stop: false,
  })

  const result = await createCampaignQueuePlan(campaign.id, launchInput, deps)
  const inserted = Number(result.send_queue_rows_created ?? result.queue_rows_created ?? 0)

  await supabase
    .from('campaigns')
    .update({
      execution_heartbeat_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', campaign.id)

  if (inserted > 0) {
    await (deps.recomputeCampaignProgress || recomputeCampaignProgress)(campaign.id, deps)
  }

  return {
    ok: result.ok !== false,
    campaign_id: campaign.id,
    campaign_name: campaign.name,
    skipped: inserted === 0,
    reason: inserted === 0 ? (result.blockers?.[0] || 'no_eligible_targets') : null,
    active_live_rows: activeLiveRows,
    batch_limit: batchLimit,
    inserted,
    skipped_count: Number(result.skipped_count || 0),
    blockers: result.blockers || [],
    launch_summary: result.launch_summary || null,
  }
}

export async function runCampaignOutboundFeeder(deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const globalAutoEnqueue = await getSystemValue('queue_auto_enqueue_enabled', { supabase })
  if (!asBoolean(globalAutoEnqueue, false)) {
    return {
      ok: true,
      skipped: true,
      reason: 'global_auto_enqueue_disabled',
      processed: 0,
      results: [],
    }
  }

  const campaigns = await findFeedableCampaigns(deps)
  const results = []
  let totalInserted = 0
  let totalBlocked = 0

  for (const campaign of campaigns) {
    if (!isCampaignFullyLive(campaign) && !isCampaignProductionLaunch(campaign)) continue
    const feedResult = await feedCampaignBatch(campaign, deps)
    results.push(feedResult)
    totalInserted += Number(feedResult.inserted || 0)
    if ((feedResult.blockers || []).length) totalBlocked += 1
  }

  const heartbeatAt = new Date().toISOString()
  await setSystemValues({
    campaign_feeder_heartbeat_at: heartbeatAt,
    campaign_feeder_last_batch_at: totalInserted > 0 ? heartbeatAt : await getSystemValue('campaign_feeder_last_batch_at', { supabase }),
    campaign_feeder_last_inserted_count: String(totalInserted),
    campaign_feeder_last_blocked_count: String(totalBlocked),
  }, { supabase })

  return {
    ok: true,
    processed: results.length,
    total_inserted: totalInserted,
    total_blocked: totalBlocked,
    heartbeat_at: heartbeatAt,
    results,
  }
}