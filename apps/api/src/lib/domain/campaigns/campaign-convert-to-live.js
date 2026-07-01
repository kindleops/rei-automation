/**
 * Convert a test-mode campaign to a guarded live launch.
 */

import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { runCanonicalCampaignActivation } from '@/lib/domain/campaigns/campaign-activation-orchestrator.js'
import { transitionCampaignStatus } from '@/lib/domain/campaigns/campaign-state-machine.js'

import { syncCampaignMetrics, isProofQueueRow } from '@/lib/domain/campaigns/campaign-sync-metrics.js'
import { buildCampaignCommandSummary } from '@/lib/domain/campaigns/campaign-command-summary.js'
import { normalizeCampaignStatus } from '@/lib/domain/campaigns/campaign-state-machine.js'
import { getSystemValue, setSystemValues } from '@/lib/system-control.js'
import { asBoolean } from '@/lib/domain/queue/queue-control-safety.js'
import { createCampaignQueuePlan } from '@/lib/domain/campaigns/campaign-automation-service.js'
import {
  buildCanonicalLiveCampaignPatch,
  CANONICAL_FULL_AUTOPILOT_MODE,
  isCampaignFullyLive,
  isCampaignLiveInconsistent,
  mergeLaunchWriteModeIntoInput,
} from '@/lib/domain/campaigns/campaign-live-execution.js'
import { recomputeCampaignProgress } from '@/lib/domain/campaigns/campaign-progress.js'

const PROOF_CANCEL_STATUSES = ['queued', 'scheduled', 'pending', 'ready', 'approved', 'processing', 'sending']
const MARKET_TIMEZONES = {
  'miami, fl': 'America/New_York',
  'jacksonville, fl': 'America/New_York',
  'dallas, tx': 'America/Chicago',
  'houston, tx': 'America/Chicago',
  'los angeles, ca': 'America/Los_Angeles',
  'minneapolis, mn': 'America/Chicago',
  'charlotte, nc': 'America/New_York',
  'atlanta, ga': 'America/New_York',
}

function clean(value) {
  return String(value ?? '').trim()
}

function parseTimeMinutes(value, fallback = 8 * 60) {
  const raw = clean(value)
  const match = raw.match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return fallback
  return Number(match[1]) * 60 + Number(match[2])
}

function resolveCampaignTimezone(campaign = {}) {
  const market = clean(campaign.market || campaign.metadata?.market).toLowerCase()
  if (MARKET_TIMEZONES[market]) return MARKET_TIMEZONES[market]
  const metaTz = clean(campaign.metadata?.timezone || campaign.metadata?.recipient_timezone)
  if (metaTz) return metaTz
  return 'America/New_York'
}

function getLocalParts(date, timezone) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    })
    const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]))
    return {
      year: Number(parts.year),
      month: Number(parts.month),
      day: Number(parts.day),
      hour: Number(parts.hour),
      minute: Number(parts.minute),
      second: Number(parts.second || 0),
    }
  } catch {
    return null
  }
}

function timezoneOffsetMs(date, timezone) {
  const parts = getLocalParts(date, timezone)
  if (!parts) return 0
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  return localAsUtc - date.getTime()
}

function localPartsToUtc(parts, timezone) {
  let guess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0)
  for (let i = 0; i < 3; i += 1) {
    const offset = timezoneOffsetMs(new Date(guess), timezone)
    const next = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0) - offset
    if (Math.abs(next - guess) < 1000) return next
    guess = next
  }
  return guess
}

export function computeNextValidSendInstant(campaign = {}, now = new Date()) {
  const timezone = resolveCampaignTimezone(campaign)
  const startMinutes = parseTimeMinutes(campaign.contact_window_start, 8 * 60)
  const endMinutes = parseTimeMinutes(campaign.contact_window_end, 21 * 60)
  const localNow = getLocalParts(now, timezone) || getLocalParts(now, 'America/New_York')
  const currentMinutes = localNow.hour * 60 + localNow.minute

  let dayOffset = 0
  if (currentMinutes >= endMinutes) dayOffset = 1

  const buildStart = (offset) => localPartsToUtc({
    year: localNow.year,
    month: localNow.month,
    day: localNow.day + offset,
    hour: Math.floor(startMinutes / 60),
    minute: startMinutes % 60,
    second: 0,
  }, timezone)

  let startUtc = buildStart(dayOffset)
  const endUtc = localPartsToUtc({
    year: localNow.year,
    month: localNow.month,
    day: localNow.day + dayOffset,
    hour: Math.floor(endMinutes / 60),
    minute: endMinutes % 60,
    second: 0,
  }, timezone)

  if (currentMinutes >= startMinutes && currentMinutes < endMinutes) {
    startUtc = Math.max(now.getTime() + 5 * 60 * 1000, now.getTime())
  } else if (startUtc < now.getTime()) {
    dayOffset += 1
    startUtc = buildStart(dayOffset)
  }

  if (startUtc >= endUtc) {
    dayOffset += 1
    startUtc = buildStart(dayOffset)
  }

  return {
    scheduled_for: new Date(startUtc).toISOString(),
    timezone,
    window_start: campaign.contact_window_start || '08:00',
    window_end: campaign.contact_window_end || '21:00',
  }
}

async function cancelProofQueueRows(supabase, campaignId) {
  let cancelled = 0
  const filters = [
    () => supabase.from('send_queue').update({ queue_status: 'cancelled', updated_at: new Date().toISOString() }).eq('campaign_id', campaignId).filter('metadata->>no_send', 'eq', 'true'),
    () => supabase.from('send_queue').update({ queue_status: 'cancelled', updated_at: new Date().toISOString() }).eq('campaign_id', campaignId).filter('metadata->>proof_no_send', 'eq', 'true'),
    () => supabase.from('send_queue').update({ queue_status: 'cancelled', updated_at: new Date().toISOString() }).eq('campaign_id', campaignId).filter('metadata->>launch_mode', 'eq', 'proof_hydration_no_send'),
  ]
  for (const run of filters) {
    const { data, error } = await run().select('id')
    if (error) throw error
    cancelled += data?.length || 0
  }
  return { cancelled, proof_rows: cancelled, deleted: 0 }
}

async function countActiveLiveQueueRows(supabase, campaignId) {
  const { data, error } = await supabase
    .from('send_queue')
    .select('id,metadata')
    .eq('campaign_id', campaignId)
    .in('queue_status', PROOF_CANCEL_STATUSES)
  if (error) throw error
  return (data || []).filter((row) => !isProofQueueRow(row)).length
}

async function applyLiveCampaignState(supabase, campaign, schedule) {
  const patch = buildCanonicalLiveCampaignPatch(campaign, schedule)
  const { data, error } = await supabase
    .from('campaigns')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', campaign.id)
    .select('*')
    .maybeSingle()
  if (error) throw error
  return data
}

async function createInitialLiveBatch(campaignId, campaign, schedule, input, deps) {
  const batchMax = Number(input.batch_max ?? input.limit ?? campaign.daily_cap ?? campaign.batch_max ?? 5)
  const launchInput = mergeLaunchWriteModeIntoInput(campaign, {
    ...input,
    lock_owner: 'convert_to_live',
    production_live_write: true,
    force_live: true,
    no_send: false,
    confirm_live: true,
    explicit_operator_action: true,
    scheduled_for: schedule.scheduled_for,
    first_scheduled_at: schedule.scheduled_for,
    batch_max: batchMax,
    limit: batchMax,
    block_on_global_emergency_stop: false,
  })
  const planFn = deps.createCampaignQueuePlan || createCampaignQueuePlan
  return planFn(campaignId, launchInput, deps)
}

export async function convertTestCampaignToLive(campaignId, input = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  if (!campaignId) return { ok: false, error: 'campaign_id_required' }

  const { data: campaign, error: campErr } = await supabase
    .from('campaigns')
    .select('*')
    .eq('id', campaignId)
    .maybeSingle()
  if (campErr) throw campErr
  if (!campaign) return { ok: false, error: 'campaign_not_found' }

  if (!asBoolean(input.confirm_live ?? input.confirmLive, true)) {
    return { ok: false, error: 'confirm_live_required', message: 'Operator must confirm live conversion.' }
  }

  const status = normalizeCampaignStatus(campaign.status)
  const summaryFn = deps.buildCampaignCommandSummary || buildCampaignCommandSummary
  const beforeSummary = await summaryFn(campaignId, deps)

  if (isCampaignFullyLive(campaign)) {
    return {
      ok: true,
      campaign_id: campaignId,
      action: 'convert_to_live',
      outcome: 'already_live_and_healthy',
      from: status,
      to: campaign.status,
      state: beforeSummary.state,
      state_label: beforeSummary.state_label,
      mode: beforeSummary.mode,
      counts: beforeSummary.counts,
      blockers: beforeSummary.blockers || [],
      warnings: beforeSummary.warnings || [],
      campaign,
      idempotent: true,
      inserted: 0,
    }
  }

  const inconsistent = isCampaignLiveInconsistent(campaign)
  const outcome = inconsistent ? 'live_state_repaired' : 'successfully_converted'

  const purged = await cancelProofQueueRows(supabase, campaignId)

  const { data: staleActive, error: staleError } = await supabase
    .from('send_queue')
    .update({
      queue_status: 'cancelled',
      updated_at: new Date().toISOString(),
    })
    .eq('campaign_id', campaignId)
    .in('queue_status', PROOF_CANCEL_STATUSES)
    .select('id')
  if (staleError) throw staleError
  const staleCancelled = staleActive?.length || 0

  if (status === 'paused') {
    const resumed = await transitionCampaignStatus(supabase, campaignId, 'active', {
      reason: clean(input.reason) || 'operator:convert_to_live',
    })
    if (!resumed.ok) return { ok: false, error: resumed.error || 'resume_failed', from: status }
  }

  const schedule = computeNextValidSendInstant(campaign)
  const batchMax = Number(input.batch_max ?? input.limit ?? campaign.daily_cap ?? campaign.batch_max ?? 5)

  const setValuesFn = deps.setSystemValues || setSystemValues
  const getValueFn = deps.getSystemValue || ((key, opts) => getSystemValue(key, opts))
  if (asBoolean(input.enable_processor ?? input.enableProcessor, true)) {
    await setValuesFn({
      queue_emergency_stop_at: '',
      queue_processor_mode: 'on',
      queue_auto_enqueue_enabled: 'true',
      outbound_sms_enabled: 'true',
      auto_reply_mode: CANONICAL_FULL_AUTOPILOT_MODE,
    }, { supabase })
  }

  const queuePlanFn = deps.createCampaignQueuePlan || createCampaignQueuePlan
  const queueResult = await createInitialLiveBatch(campaignId, campaign, schedule, {
    ...input,
    batch_max: batchMax,
    limit: batchMax,
  }, { ...deps, createCampaignQueuePlan: queuePlanFn })

  const inserted = Number(queueResult?.send_queue_rows_created ?? queueResult?.queue_rows_created ?? 0)
  const queueBlockers = queueResult?.blockers || []

  const refreshedCampaign = await applyLiveCampaignState(supabase, campaign, schedule)

  if (inserted === 0 && queueBlockers.length) {
    return {
      ok: false,
      error: 'activation_failed',
      blockers: queueBlockers,
      purged: { ...purged, stale_cancelled: staleCancelled },
      schedule,
      from: status,
      to: refreshedCampaign?.status || 'active',
      queue_result: queueResult,
    }
  }

  const activationFn = deps.runCanonicalCampaignActivation || runCanonicalCampaignActivation
  const activation = await activationFn(campaignId, {
    ...input,
    action: 'activate',
    force_live: true,
    production_live_write: true,
    no_send: false,
    confirm_live: true,
    explicit_operator_action: true,
    scheduled_activation: true,
    scheduled_for: schedule.scheduled_for,
    first_scheduled_at: schedule.scheduled_for,
    batch_max: 0,
    limit: 0,
    skip_queue_hydration: true,
    activation_idempotency_key: clean(input.activation_idempotency_key) || `convert-live:${Date.now()}`,
    reason: clean(input.reason) || 'operator:convert_to_live',
    lock_owner: 'convert_to_live',
  }, deps)

  await (deps.recomputeCampaignProgress || recomputeCampaignProgress)(campaignId, deps)
  const syncFn = deps.syncCampaignMetrics || syncCampaignMetrics
  await syncFn(campaignId, deps)
  const afterSummary = await summaryFn(campaignId, deps)

  const processorMode = await getValueFn('queue_processor_mode', { supabase })
  await supabase.from('campaign_events').insert({
    campaign_id: campaignId,
    event_type: 'campaign.converted_to_live',
    severity: 'success',
    title: 'Converted to Live Campaign',
    description: `${outcome}: purged ${purged.cancelled} proof rows, inserted ${inserted} live rows. Scheduled for ${schedule.scheduled_for}.`,
    metadata: {
      outcome,
      purged_proof_rows: purged.cancelled,
      scheduled_for: schedule.scheduled_for,
      timezone: schedule.timezone,
      inserted,
      processor_mode: processorMode,
      auto_reply_mode: CANONICAL_FULL_AUTOPILOT_MODE,
      counts: afterSummary.counts,
    },
  })

  const { data: finalCampaign } = await supabase.from('campaigns').select('*').eq('id', campaignId).maybeSingle()

  return {
    ok: true,
    campaign_id: campaignId,
    action: 'convert_to_live',
    outcome,
    from: status,
    to: finalCampaign?.status || 'active',
    state: afterSummary.state,
    state_label: afterSummary.state_label,
    mode: afterSummary.mode,
    purged: { ...purged, stale_cancelled: staleCancelled },
    schedule,
    activation,
    queue_result: queueResult,
    inserted,
    counts: afterSummary.counts,
    blockers: afterSummary.blockers || [],
    warnings: afterSummary.warnings || [],
    campaign: finalCampaign,
    proof_mode_cleared: afterSummary.execution?.proof_mode !== true,
    auto_send_enabled: asBoolean(finalCampaign?.auto_send_enabled, false),
    auto_reply_mode: clean(finalCampaign?.auto_reply_mode),
  }
}