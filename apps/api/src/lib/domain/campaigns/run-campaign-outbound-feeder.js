/**
 * Canonical campaign feeder — replenishes active production campaigns.
 */

import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { asBoolean, isEmergencyStopActive } from '@/lib/domain/queue/queue-control-safety.js'
import { getSystemValue, setSystemValues } from '@/lib/system-control.js'
import { createCampaignQueuePlan } from '@/lib/domain/campaigns/campaign-automation-service.js'
import { isLiveCampaignStatus, normalizeCampaignStatus, transitionCampaignStatus } from '@/lib/domain/campaigns/campaign-state-machine.js'
import {
  computeNextValidSendInstant,
} from '@/lib/domain/campaigns/campaign-convert-to-live.js'
import {
  isCampaignFullyLive,
  isCampaignProductionLaunch,
  mergeLaunchWriteModeIntoInput,
  syncProductionQueueRailsFromCampaign,
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

export async function countActiveLiveQueueRows(supabase, campaignId) {
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

/**
 * Midnight of the campaign's local day, as a UTC instant. This parsed
 * `YYYY-MM-DDT00:00:00` in the SERVER's zone, so "today" for a Chicago campaign
 * started at UTC midnight on the container — 5-6 hours off the campaign's day.
 */
export function campaignDayStart(now, timezone, parts) {
  const at = new Date(now)
  const inZone = Date.parse(at.toLocaleString('en-US', { timeZone: timezone }))
  const inUtc = Date.parse(at.toLocaleString('en-US', { timeZone: 'UTC' }))
  const offsetMs = inZone - inUtc
  return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) - offsetMs)
}

async function countSentToday(supabase, campaignId, timezone = 'America/New_York', now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]))
  const dayStart = campaignDayStart(now, timezone, parts)
  const { count, error } = await supabase
    .from('send_queue')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .in('queue_status', ['sent', 'delivered', 'sending', 'processing'])
    .gte('updated_at', dayStart.toISOString())
  if (error) throw error
  return Number(count || 0)
}

/**
 * CAMPAIGN SIZE IS NOT WORKER SIZE.
 *
 * This used `campaign.batch_max` as the rolling buffer: `need = batch_max -
 * activeLiveRows`. The mobile builder hard-clamped batch_max to 50, so a
 * 503-seller campaign put 50 rows in the queue, the feeder saw a "satisfied"
 * buffer, and the other 453 sat `ready` forever. batch_max is not consulted
 * here any more. These two numbers are worker internals; the campaign's own
 * intent is its targets, bounded only by the operator's total_cap/daily_cap
 * and by real sender/window capacity downstream.
 */
export const FEEDER_BUFFER_TARGET = 150 // live rows kept scheduled ahead of the processor
export const FEEDER_HYDRATION_CHUNK = 100 // rows planned per campaign per feeder cycle

/**
 * Skip reasons that mean "this target can never be sent by this campaign".
 * A campaign whose only remaining ready targets carry these is finished.
 * Anything else (window full, sender/market cap, routing, render) is capacity
 * or operator-fixable, so the campaign stays live and keeps retrying.
 */
const PERMANENT_INELIGIBLE_REASONS = new Set([
  'missing_to_phone_number',
  'missing_prospect_id',
  'prior_contacted_suppression',
  'graph_suppression_or_queue_block',
  'owner_identity_not_verified',
  'renter_not_owner',
  'likely_renter',
])

/** Skip reasons that mean "no more room today", not "cannot be sent". */
const CAPACITY_REASONS = new Set(['per_sender_cap_reached', 'per_market_cap_reached', 'schedule_window_full'])

export function resolveFeedLimit({
  campaign = {},
  activeLiveRows = 0,
  readyRemaining = 0,
  committedTargets = 0,
  sentToday = 0,
} = {}) {
  const dailyCap = asPositiveInteger(campaign.daily_cap, 0)
  const totalCap = asPositiveInteger(campaign.total_cap, 0)
  const bufferNeed = Math.max(0, FEEDER_BUFFER_TARGET - activeLiveRows)
  // Rows already sitting in the queue will spend today's allowance first.
  const dailyRemaining = dailyCap ? Math.max(0, dailyCap - sentToday - activeLiveRows) : Number.POSITIVE_INFINITY
  // total_cap is the operator's campaign-size intent: targets already handed
  // to the queue (planned or beyond) count against it, held targets do not.
  const totalRemaining = totalCap ? Math.max(0, totalCap - committedTargets) : Number.POSITIVE_INFINITY
  const limit = Math.min(bufferNeed, FEEDER_HYDRATION_CHUNK, dailyRemaining, totalRemaining, Math.max(0, readyRemaining))
  let bound = 'buffer'
  if (readyRemaining <= 0) bound = 'cohort_exhausted'
  else if (totalRemaining <= 0) bound = 'total_cap_reached'
  else if (dailyRemaining <= 0) bound = 'daily_cap_reached'
  else if (bufferNeed <= 0) bound = 'buffer_full'
  return { limit: Math.max(0, Math.trunc(limit)), bound, buffer_need: bufferNeed, daily_remaining: dailyRemaining, total_remaining: totalRemaining }
}

export function isCohortResolved({ readyRemaining = 0, activeLiveRows = 0, inserted = 0, skippedByReason = {} } = {}) {
  if (activeLiveRows > 0 || inserted > 0) return false
  if (readyRemaining <= 0) return true
  const reasons = Object.entries(skippedByReason).filter(([, n]) => Number(n) > 0).map(([r]) => r)
  if (!reasons.length) return false
  const skipped = reasons.reduce((sum, r) => sum + Number(skippedByReason[r] || 0), 0)
  return skipped >= readyRemaining && reasons.every((r) => PERMANENT_INELIGIBLE_REASONS.has(r))
}

async function countTargets(supabase, campaignId, statuses, { not = false } = {}) {
  let query = supabase.from('campaign_targets').select('id', { count: 'exact', head: true }).eq('campaign_id', campaignId)
  query = not ? query.not('target_status', 'in', `(${statuses.join(',')})`) : query.in('target_status', statuses)
  const { count, error } = await query
  if (error) throw error
  return Number(count || 0)
}

/**
 * What each sender number already carries for this campaign today: rows sent
 * since the campaign's local midnight plus rows still queued. Seeds the
 * planner's per-sender counters so per_sender_cap holds per DAY across refills.
 */
export async function senderUseToday(supabase, campaignId, timezone = 'America/New_York', now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]))
  const dayStart = campaignDayStart(now, timezone, parts).toISOString()
  const { data, error } = await supabase
    .from('send_queue')
    .select('from_phone_number,queue_status,updated_at')
    .eq('campaign_id', campaignId)
    .in('queue_status', [...ACTIVE_QUEUE_STATUSES, 'sent', 'delivered'])
  if (error) throw error
  const seed = {}
  for (const row of data || []) {
    const sender = clean(row.from_phone_number)
    if (!sender) continue
    const active = ACTIVE_QUEUE_STATUSES.includes(row.queue_status)
    if (!active && String(row.updated_at || '') < dayStart) continue
    seed[sender] = (seed[sender] || 0) + 1
  }
  return seed
}

async function latestActiveScheduledAt(supabase, campaignId) {
  const { data, error } = await supabase
    .from('send_queue')
    .select('scheduled_for')
    .eq('campaign_id', campaignId)
    .in('queue_status', ACTIVE_QUEUE_STATUSES)
    .order('scheduled_for', { ascending: false, nullsFirst: false })
    .limit(1)
  if (error) throw error
  return data?.[0]?.scheduled_for || null
}

/** A campaign that has ever had a real (non-proof) send_queue row is a live launch. */
export async function hasLiveQueueHistory(supabase, campaignId) {
  const { data, error } = await supabase
    .from('send_queue')
    .select('id,metadata')
    .eq('campaign_id', campaignId)
    .limit(200)
  if (error) throw error
  return (data || []).some((row) => {
    const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
    return !(asBoolean(meta.no_send ?? meta.proof_no_send, false) || clean(meta.launch_mode) === 'proof_hydration_no_send')
  })
}

/**
 * Live campaigns whose operator left auto-queue on. This required
 * `auto_send_enabled` + a `production_launch` stamp, which only the Activate
 * Now path writes — a campaign that went live on its SCHEDULE never qualified,
 * so the feeder could not continue it past its first chunk. A live launch is
 * now also recognised by its own live queue history.
 */
export async function findFeedableCampaigns(deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const { data, error } = await supabase
    .from('campaigns')
    .select('*')
    .in('status', ['active', 'activating', 'live_limited'])
    .eq('auto_queue_enabled', true)
    .order('execution_heartbeat_at', { ascending: true, nullsFirst: true })
    .limit(50)
  if (error) throw error
  const out = []
  for (const campaign of data || []) {
    if (!isLiveCampaignStatus(normalizeCampaignStatus(campaign.status))) continue
    if (isEmergencyStopActive(campaign.emergency_stop_at)) continue
    if (isCampaignProductionLaunch(campaign) || await hasLiveQueueHistory(supabase, campaign.id)) out.push(campaign)
  }
  return out
}

/**
 * CARRIER-FILTERED SENDS RETRY WITH A DIFFERENT TEMPLATE.
 *
 * A text the carrier filtered as spam (failure_bucket 'Spam') never reached
 * the seller, and on 2026-09-28 the filtering was driven by wording: the same
 * sellers on the same numbers delivered plainer templates. So a filtered send
 * puts its target back in line with that template excluded, once. A hard
 * bounce (dead number) is never retried; neither is a second filtering.
 */
export const SPAM_RETRY_LIMIT = 1

export async function recycleFilteredSends(supabase, campaignId, { now = Date.now() } = {}) {
  const since = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString()
  const { data: failed, error } = await supabase
    .from('send_queue')
    .select('id,campaign_target_id,template_id,provider_message_id,metadata')
    .eq('campaign_id', campaignId)
    .in('queue_status', ['failed_transport', 'failed'])
    .gte('updated_at', since)
    .limit(500)
  if (error) throw error
  const fresh = (failed || []).filter((r) => r.campaign_target_id && !(r.metadata && r.metadata.recycled_at))
  if (!fresh.length) return { recycled: 0, skipped: 0 }

  const sids = fresh.map((r) => r.provider_message_id).filter(Boolean)
  const ids = fresh.map((r) => r.id)
  const buckets = new Map()
  if (sids.length || ids.length) {
    const { data: events } = await supabase
      .from('message_events')
      .select('queue_id,provider_message_sid,failure_bucket')
      .or([sids.length ? `provider_message_sid.in.(${sids.map((x) => `"${x}"`).join(',')})` : null, `queue_id.in.(${ids.join(',')})`].filter(Boolean).join(','))
      .limit(1000)
    for (const e of events || []) {
      if (e.failure_bucket) {
        if (e.queue_id) buckets.set(String(e.queue_id), e.failure_bucket)
        if (e.provider_message_sid) buckets.set(String(e.provider_message_sid), e.failure_bucket)
      }
    }
  }

  let recycled = 0
  let skipped = 0
  const stamp = new Date(now).toISOString()
  for (const row of fresh) {
    const bucket = buckets.get(String(row.id)) || buckets.get(String(row.provider_message_id || ''))
    const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
    if (!bucket) { skipped += 1; continue } // no carrier verdict yet — decide on a later pass
    let retried = false
    if (bucket === 'Spam') {
      const { data: target } = await supabase.from('campaign_targets').select('id,target_status,metadata').eq('id', row.campaign_target_id).maybeSingle()
      const tmeta = target?.metadata && typeof target.metadata === 'object' ? target.metadata : {}
      const count = Number(tmeta.spam_retry_count || 0)
      if (target && target.target_status === 'planned' && count < SPAM_RETRY_LIMIT) {
        const excluded = [...new Set([...(Array.isArray(tmeta.excluded_template_ids) ? tmeta.excluded_template_ids : []), row.template_id].filter(Boolean).map(String))]
        await supabase.from('campaign_targets').update({
          target_status: 'ready',
          metadata: { ...tmeta, excluded_template_ids: excluded, spam_retry_count: count + 1, last_spam_retry_at: stamp },
          updated_at: stamp,
        }).eq('id', target.id).eq('target_status', 'planned')
        recycled += 1
        retried = true
      }
    }
    await supabase.from('send_queue').update({ metadata: { ...meta, recycled_at: stamp, recycle_outcome: retried ? 'retry_different_template' : `no_retry:${bucket}` } }).eq('id', row.id)
    if (!retried) skipped += 1
  }
  return { recycled, skipped }
}

export async function feedCampaignBatch(campaign, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const now = new Date(deps.now || Date.now())
  const timezone = clean(campaign.metadata?.timezone || campaign.metadata?.launch_timezone) || 'America/New_York'
  const recycle = await (deps.recycleFilteredSends || recycleFilteredSends)(supabase, campaign.id, { now: now.getTime() })
    .catch((error) => ({ recycled: 0, skipped: 0, error: error?.message || String(error) }))
  const [activeLiveRows, readyRemaining, heldTargets, committedTargets, sentToday] = await Promise.all([
    countActiveLiveQueueRows(supabase, campaign.id),
    countTargets(supabase, campaign.id, ['ready']),
    countTargets(supabase, campaign.id, ['blocked']),
    countTargets(supabase, campaign.id, ['ready', 'blocked'], { not: true }),
    countSentToday(supabase, campaign.id, timezone, now),
  ])
  const feed = resolveFeedLimit({ campaign, activeLiveRows, readyRemaining, committedTargets, sentToday })
  const base = {
    campaign_id: campaign.id,
    campaign_name: campaign.name,
    active_live_rows: activeLiveRows,
    ready_remaining: readyRemaining,
    held_targets: heldTargets,
    committed_targets: committedTargets,
    sent_today: sentToday,
    batch_limit: feed.limit,
    bound: feed.bound,
  }

  let result = null
  let inserted = 0
  if (feed.limit > 0) {
    const next = computeNextValidSendInstant(campaign, now)
    // Continue the campaign's cadence after its last queued row instead of
    // restarting at "now", which would double the send rate on overlap.
    const lastScheduled = await latestActiveScheduledAt(supabase, campaign.id)
    const senderSeed = await senderUseToday(supabase, campaign.id, timezone, now)
    const intervalMs = asPositiveInteger(campaign.send_interval_seconds, 60) * 1000
    const notBefore = lastScheduled ? new Date(new Date(lastScheduled).getTime() + intervalMs).toISOString() : null
    const launchInput = mergeLaunchWriteModeIntoInput(campaign, {
      lock_owner: 'campaign_feeder',
      production_live_write: true,
      explicit_operator_action: true,
      scheduled_for: next.scheduled_for,
      first_scheduled_at: next.scheduled_for,
      schedule_not_before: notBefore,
      sender_use_seed: senderSeed,
      batch_max: feed.limit,
      limit: feed.limit,
      max_targets: feed.limit,
      daily_cap: campaign.daily_cap,
      per_sender_cap: campaign.per_sender_cap,
      per_market_cap: campaign.market_cap,
      block_on_global_emergency_stop: false,
      now: now.toISOString(),
    })
    result = await (deps.createCampaignQueuePlan || createCampaignQueuePlan)(campaign.id, launchInput, deps)
    inserted = Number(result.send_queue_rows_created ?? result.queue_rows_created ?? 0)
  }

  const readyAfter = Math.max(0, readyRemaining - inserted)
  const resolved = isCohortResolved({
    readyRemaining: readyAfter,
    activeLiveRows: activeLiveRows + inserted,
    inserted,
    skippedByReason: result?.skipped_counts_by_reason || {},
  })
  let completed = false
  // Only a campaign that actually executed can finish. An active campaign with
  // no audience at all is a configuration problem, not a completed campaign.
  if (resolved && committedTargets + inserted > 0) {
    const transition = await (deps.transitionCampaignStatus || transitionCampaignStatus)(supabase, campaign.id, 'completed', {
      reason: 'campaign_feeder:cohort_resolved',
    }).catch((error) => ({ ok: false, error: error?.message }))
    completed = transition?.ok !== false
  }

  // A live campaign with sendable targets left that could not place a single
  // row, while nothing is queued ahead, is stalled — say so, don't idle.
  // Hitting today's capacity (sender cap, window, daily cap) is pacing, not a
  // stall: the remainder waits for the next day/window by design.
  const skipped = result?.skipped_counts_by_reason || {}
  const capacityBound = Object.keys(skipped).some((r) => CAPACITY_REASONS.has(r) && Number(skipped[r]) > 0)
  const stalled = !completed && readyAfter > 0 && activeLiveRows + inserted === 0 && !capacityBound &&
    !['daily_cap_reached', 'total_cap_reached'].includes(feed.bound)
  const reason = completed
    ? 'cohort_resolved'
    : inserted > 0
      ? null
      : (result?.blockers?.[0] || (capacityBound ? 'capacity_reached_today' : feed.limit > 0 ? 'no_row_placed' : feed.bound))

  const heartbeatAt = new Date().toISOString()
  const metadata = campaign.metadata && typeof campaign.metadata === 'object' ? campaign.metadata : {}
  await supabase
    .from('campaigns')
    .update({
      execution_heartbeat_at: heartbeatAt,
      updated_at: heartbeatAt,
      metadata: {
        ...metadata,
        feeder_last: {
          at: heartbeatAt,
          inserted,
          spam_retries: recycle?.recycled ?? 0,
          ...base,
          ready_remaining: readyAfter,
          reason,
          stalled,
          skipped_counts_by_reason: result?.skipped_counts_by_reason || {},
          ...(inserted > 0 ? { last_refill_at: heartbeatAt } : { last_refill_at: metadata.feeder_last?.last_refill_at || null }),
        },
      },
    })
    .eq('id', campaign.id)

  if (inserted > 0) {
    await (deps.recomputeCampaignProgress || recomputeCampaignProgress)(campaign.id, deps)
  }

  return {
    ok: result ? result.ok !== false : true,
    ...base,
    ready_remaining: readyAfter,
    skipped: inserted === 0,
    reason,
    stalled,
    completed,
    inserted,
    skipped_count: Number(result?.skipped_count || 0),
    skipped_counts_by_reason: result?.skipped_counts_by_reason || {},
    blockers: result?.blockers || [],
    launch_summary: result?.launch_summary || null,
  }
}

export async function runCampaignOutboundFeeder(deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const writeHeartbeat = async (fields) => {
    const heartbeatAt = new Date().toISOString()
    await (deps.setSystemValues || setSystemValues)({
      campaign_feeder_heartbeat_at: heartbeatAt,
      ...fields,
    }, { supabase })
    return heartbeatAt
  }

  const globalAutoEnqueue = await getSystemValue('queue_auto_enqueue_enabled', { supabase })
  if (!asBoolean(globalAutoEnqueue, false)) {
    // Still a heartbeat: "ran and was told not to queue" is not "did not run".
    const heartbeatAt = await writeHeartbeat({ campaign_feeder_last_reason: 'global_auto_enqueue_disabled' })
    return {
      ok: true,
      skipped: true,
      reason: 'global_auto_enqueue_disabled',
      processed: 0,
      heartbeat_at: heartbeatAt,
      results: [],
    }
  }

  const campaigns = await findFeedableCampaigns(deps)
  const results = []
  let totalInserted = 0
  let totalBlocked = 0
  let stalled = 0

  for (const campaign of campaigns) {
    try {
      if (isCampaignFullyLive(campaign)) {
        await syncProductionQueueRailsFromCampaign(campaign, deps)
      }
      const feedResult = await feedCampaignBatch(campaign, deps)
      results.push(feedResult)
      totalInserted += Number(feedResult.inserted || 0)
      if ((feedResult.blockers || []).length) totalBlocked += 1
      if (feedResult.stalled) stalled += 1
    } catch (error) {
      // One bad campaign must not starve the others of their refill.
      results.push({ ok: false, campaign_id: campaign.id, campaign_name: campaign.name, error: error?.message || String(error) })
      totalBlocked += 1
    }
  }

  const lastBatchAt = totalInserted > 0 ? new Date().toISOString() : await getSystemValue('campaign_feeder_last_batch_at', { supabase })
  const heartbeatAt = await writeHeartbeat({
    campaign_feeder_last_batch_at: lastBatchAt || '',
    campaign_feeder_last_inserted_count: String(totalInserted),
    campaign_feeder_last_blocked_count: String(totalBlocked),
    campaign_feeder_last_campaign_count: String(results.length),
    campaign_feeder_last_stalled_count: String(stalled),
    campaign_feeder_last_reason: '',
  })

  return {
    ok: true,
    processed: results.length,
    total_inserted: totalInserted,
    total_blocked: totalBlocked,
    stalled,
    heartbeat_at: heartbeatAt,
    results,
  }
}
