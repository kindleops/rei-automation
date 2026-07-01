/**
 * Canonical production live execution — single source of truth for
 * proof vs live launch mode derived from persisted campaign state.
 */

import { asBoolean, asPositiveInteger } from '@/lib/domain/queue/queue-control-safety.js'
import {
  isLiveCampaignStatus,
  normalizeCampaignStatus,
} from '@/lib/domain/campaigns/campaign-state-machine.js'

/** Full Autopilot maps to live_limited in persisted runtime (seller-flow contract). */
export const CANONICAL_FULL_AUTOPILOT_MODE = 'live_limited'

export const LIVE_LAUNCH_MODE = 'guarded_live_queue_creation'
export const PROOF_LAUNCH_MODE = 'proof_hydration_no_send'

function clean(value) {
  return String(value ?? '').trim()
}

function metadataObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export function isCampaignProductionLaunch(campaign = {}) {
  const metadata = metadataObject(campaign.metadata)
  return Boolean(clean(metadata.converted_to_live_at) || metadata.production_launch)
}

export function isCampaignFullyLive(campaign = {}) {
  const status = normalizeCampaignStatus(campaign.status)
  return (
    isLiveCampaignStatus(status) &&
    asBoolean(campaign.auto_queue_enabled, false) &&
    asBoolean(campaign.auto_send_enabled, false) &&
    clean(campaign.auto_reply_mode) === CANONICAL_FULL_AUTOPILOT_MODE &&
    isCampaignProductionLaunch(campaign)
  )
}

export function isCampaignLiveInconsistent(campaign = {}) {
  const status = normalizeCampaignStatus(campaign.status)
  if (!['active', 'activating', 'paused'].includes(status)) return false
  if (isCampaignFullyLive(campaign)) return false

  const productionLaunch = isCampaignProductionLaunch(campaign)
  const hasLiveSignals =
    productionLaunch ||
    asBoolean(campaign.auto_send_enabled, false) ||
    asBoolean(campaign.auto_queue_enabled, false) && status === 'active'

  if (!hasLiveSignals && !productionLaunch) {
    return status === 'active' && asBoolean(campaign.auto_queue_enabled, false)
  }

  return (
    !asBoolean(campaign.auto_send_enabled, false) ||
    clean(campaign.auto_reply_mode || 'disabled') !== CANONICAL_FULL_AUTOPILOT_MODE ||
    !productionLaunch ||
    !asBoolean(campaign.auto_queue_enabled, false)
  )
}

export function buildCanonicalLiveCampaignPatch(campaign = {}, schedule = {}) {
  const metadata = metadataObject(campaign.metadata)
  const now = new Date().toISOString()
  return {
    auto_queue_enabled: true,
    auto_send_enabled: true,
    auto_reply_mode: CANONICAL_FULL_AUTOPILOT_MODE,
    scheduled_for: schedule.scheduled_for || campaign.scheduled_for || null,
    activated_at: campaign.activated_at || now,
    execution_heartbeat_at: now,
    metadata: {
      ...metadata,
      converted_to_live_at: metadata.converted_to_live_at || now,
      production_launch: true,
      test_mode_cleared: true,
      launch_timezone: schedule.timezone || metadata.launch_timezone || null,
      launch_window: schedule.window_start
        ? { start: schedule.window_start, end: schedule.window_end }
        : metadata.launch_window || null,
    },
  }
}

export function isProductionLiveWriteContext(campaign = {}, input = {}) {
  if (input.production_live_write === true || input.productionLiveWrite === true) return true
  const owner = clean(input.lock_owner || input.owner)
  if (['convert_to_live', 'campaign_feeder', 'campaign_feeder_worker', 'activation_orchestrator'].includes(owner)) {
    return true
  }
  if (input.force_live === true || input.forceLive === true) return true
  if (isCampaignFullyLive(campaign)) return true
  if (isCampaignProductionLaunch(campaign) && asBoolean(campaign.auto_send_enabled, false)) return true
  return false
}

/**
 * Derive queue write mode from backend campaign state. Explicit input overrides
 * only for explicit preview/test actions — never infer proof from campaign name.
 */
export function resolveCampaignLaunchWriteMode(campaign = {}, input = {}) {
  const explicitProof =
    input.proof_hydration === true ||
    input.proofHydration === true ||
    input.preview_mode === true ||
    input.previewMode === true ||
    (input.no_send === true || input.noSend === true) &&
      input.confirm_live !== true &&
      input.confirmLive !== true &&
      !isProductionLiveWriteContext(campaign, input)

  if (explicitProof) {
    return {
      no_send: true,
      confirm_live: true,
      proof_hydration: true,
      launch_mode: PROOF_LAUNCH_MODE,
      production_live_write: false,
    }
  }

  const productionLive =
    isProductionLiveWriteContext(campaign, input) ||
    input.confirm_live === true ||
    input.confirmLive === true ||
    input.no_send === false ||
    input.noSend === false

  if (productionLive) {
    return {
      no_send: false,
      confirm_live: true,
      proof_hydration: false,
      launch_mode: LIVE_LAUNCH_MODE,
      production_live_write: true,
    }
  }

  const status = normalizeCampaignStatus(campaign.status)
  if (['active', 'activating'].includes(status) && isCampaignProductionLaunch(campaign)) {
    return {
      no_send: false,
      confirm_live: true,
      proof_hydration: false,
      launch_mode: LIVE_LAUNCH_MODE,
      production_live_write: true,
    }
  }

  return {
    no_send: true,
    confirm_live: true,
    proof_hydration: true,
    launch_mode: PROOF_LAUNCH_MODE,
    production_live_write: false,
  }
}

export function mergeLaunchWriteModeIntoInput(campaign = {}, input = {}) {
  const derived = resolveCampaignLaunchWriteMode(campaign, input)
  return {
    ...input,
    ...derived,
    dry_run: input.dry_run === true || input.dryRun === true,
    hydrate_canonical_queue: derived.proof_hydration ? true : false,
    create_send_queue_rows: input.create_send_queue_rows !== false && input.createSendQueueRows !== false,
  }
}

/**
 * Align global queue safety rails with a production campaign's configured caps.
 * Replaces stale canary/emergency-stop limits so cron dispatch can run at campaign scale.
 */
export function buildProductionQueueRailsPatch(campaign = {}) {
  const batchMax = asPositiveInteger(campaign.batch_max, 50)
  const dailyCap = asPositiveInteger(campaign.daily_cap, batchMax)
  const marketCap = asPositiveInteger(campaign.market_cap, dailyCap)
  const perSenderCap = asPositiveInteger(campaign.per_sender_cap, batchMax)
  const market = clean(campaign.market)
  const state = market.toLowerCase().includes(', fl') ? 'FL' : clean(campaign.metadata?.state)

  return {
    queue_emergency_stop_at: '',
    queue_processor_mode: 'on',
    queue_auto_enqueue_enabled: 'true',
    queue_auto_send_enabled: 'true',
    outbound_sms_enabled: 'true',
    auto_reply_mode: CANONICAL_FULL_AUTOPILOT_MODE,
    campaign_mode: 'live_limited',
    queue_execution_mode: 'normal',
    queue_run_limit: String(Math.min(batchMax, 50)),
    queue_hard_cap: String(batchMax),
    queue_max_batch_size: String(batchMax),
    queue_daily_send_cap: String(dailyCap),
    queue_market_cap: String(marketCap),
    queue_per_number_cap: String(perSenderCap),
    ...(market ? { queue_market_filter: market } : {}),
    ...(state ? { queue_state_filter: state } : {}),
    queue_last_run_status: '',
  }
}

export async function syncProductionQueueRailsFromCampaign(campaign = {}, deps = {}) {
  if (!isCampaignProductionLaunch(campaign)) {
    return { ok: false, skipped: true, reason: 'not_production_launch' }
  }
  const { setSystemValues } = await import('@/lib/system-control.js')
  const setValues = deps.setSystemValues || setSystemValues
  const supabase = deps.supabase
  const patch = buildProductionQueueRailsPatch(campaign)
  await setValues(patch, supabase ? { supabase } : {})
  return { ok: true, patch }
}

/**
 * After guarded live activation: persist live flags, sync queue rails, run processor immediately.
 */
export async function finalizeOperatorLiveActivation(campaignId, input = {}, deps = {}) {
  const supabase = deps.supabase || (await import('@/lib/supabase/client.js')).supabase
  const { computeNextValidSendInstant } = await import('@/lib/domain/campaigns/campaign-convert-to-live.js')
  const { runSendQueue } = await import('@/lib/domain/queue/run-send-queue.js')

  const { data: campaign, error } = await supabase.from('campaigns').select('*').eq('id', campaignId).maybeSingle()
  if (error) throw error
  if (!campaign) return { ok: false, error: 'campaign_not_found' }

  const schedule = computeNextValidSendInstant(campaign)
  const patch = buildCanonicalLiveCampaignPatch(campaign, schedule)
  const { data: refreshed, error: updateError } = await supabase
    .from('campaigns')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', campaignId)
    .select('*')
    .maybeSingle()
  if (updateError) throw updateError

  const liveCampaign = refreshed || campaign
  await syncProductionQueueRailsFromCampaign(liveCampaign, { ...deps, supabase })

  const batchMax = asPositiveInteger(
    input.batch_max ?? input.batchMax ?? input.limit ?? liveCampaign.batch_max,
    5,
  )
  const runQueue = deps.runSendQueue || runSendQueue
  const processorResult = await runQueue({ limit: batchMax }, { ...deps, supabaseClient: supabase, supabase })

  return {
    ok: true,
    schedule,
    processor_result: processorResult,
    sent_count: Number(processorResult?.sent_count || 0),
    claimed_count: Number(processorResult?.claimed_count || 0),
  }
}