/**
 * Canonical campaign activation — shared by Activate Now and scheduled worker.
 */

import { SCHEDULE_MISSED_GRACE_MS, isScheduleMissed, isCampaignStartMissed } from '@/lib/domain/campaigns/campaign-schedule-missed.js'
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { activateCampaignWithHydration } from '@/lib/domain/campaigns/campaign-automation-service.js'
import { evaluateCampaignLaunchReadiness, resolveLaunchReadinessContext } from '@/lib/domain/campaigns/campaign-launch-readiness.js'
import { recomputeCampaignProgress } from '@/lib/domain/campaigns/campaign-progress.js'

import { isQueueableStatus, normalizeCampaignStatus } from '@/lib/domain/campaigns/campaign-state-machine.js'
import {
  countLiveConfirmedQueueRows,
  isCampaignFullyLive,
  isCampaignLiveInconsistentWithQueue,
  mergeLaunchWriteModeIntoInput,
  reconcileCampaignLiveState,
} from '@/lib/domain/campaigns/campaign-live-execution.js'

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

const ACTIVATION_STEPS = [
  'validating_recipients',
  'resolving_templates',
  'resolving_senders',
  'applying_compliance',
  'hydrating_queue',
  'activating_campaign',
  'complete',
]

/**
 * Single entry for campaign activation (operator + cron).
 */
export async function runCanonicalCampaignActivation(campaignId, input = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const idempotencyKey = clean(input.activation_idempotency_key || input.activationIdempotencyKey)
  const owner = clean(input.lock_owner || input.owner || 'activation_orchestrator')
  const steps = []
  const recordStep = (step, detail = {}) => {
    steps.push({ step, at: new Date().toISOString(), ...detail })
  }

  try {
    recordStep('validating_recipients')
    const { data: campaign } = await supabase.from('campaigns').select('*').eq('id', campaignId).maybeSingle()
    if (!campaign) return failResult('campaign_not_found', steps)

    const status = normalizeCampaignStatus(campaign.status)
    if (!isQueueableStatus(status) && status !== 'scheduled') {
      return failResult('campaign_not_queueable', steps, {
        blockers: [`Campaign status "${status}" is not eligible for activation.`],
      })
    }

    const { count: activeQueueCount } = await supabase
      .from('send_queue')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', campaignId)
      .in('queue_status', ['queued', 'scheduled', 'pending', 'ready', 'approved', 'processing', 'sending'])

    const skipHydration = input.skip_queue_hydration === true || input.skipQueueHydration === true
    const forceLive = input.force_live === true || input.forceLive === true
    const liveQueueRows = await countLiveConfirmedQueueRows(supabase, campaignId)
    const needsReconcile = isCampaignLiveInconsistentWithQueue(campaign, { liveQueueRows })

    // Split-brain repair: an already-active campaign whose live queue rows do not
    // match its execution flags must be reconciled — never returned as "already
    // active" while inconsistent. This self-heals active + proof + live-row state.
    if (status === 'active' && needsReconcile && !forceLive) {
      const repair = await reconcileCampaignLiveState(campaignId, deps)
      await (deps.recomputeCampaignProgress || recomputeCampaignProgress)(campaignId, deps)
      const { data: repairedCampaign } = await supabase.from('campaigns').select('*').eq('id', campaignId).maybeSingle()
      recordStep('complete', { reconciled: true, outcome: repair.outcome, live_queue_rows: liveQueueRows })
      return {
        ok: true,
        idempotent: true,
        reconciled: true,
        campaign_id: campaignId,
        campaign: repairedCampaign || repair.campaign || campaign,
        steps,
        inserted: 0,
        skipped: 0,
        blockers: [],
        from: 'active',
        to: 'active',
        outcome: repair.outcome,
        live_queue_rows: liveQueueRows,
      }
    }

    if (
      status === 'active' &&
      !forceLive &&
      !needsReconcile &&
      (campaign.activated_at || Number(activeQueueCount || 0) > 0 || Number(campaign.queued_count || 0) > 0)
    ) {
      await (deps.recomputeCampaignProgress || recomputeCampaignProgress)(campaignId, deps)
      recordStep('complete', { idempotent: true, queue_rows: activeQueueCount })
      return {
        ok: true,
        idempotent: true,
        campaign_id: campaignId,
        campaign,
        steps,
        inserted: 0,
        skipped: 0,
        blockers: [],
        from: 'active',
        to: 'active',
        outcome: isCampaignFullyLive(campaign) ? 'already_live_and_healthy' : 'active_with_queue_rows',
      }
    }

    if (idempotencyKey && clean(campaign.last_activation_idempotency_key) === idempotencyKey && ['active', 'activating', 'queued'].includes(status)) {
      return {
        ok: true,
        idempotent: true,
        campaign_id: campaignId,
        campaign,
        steps,
        inserted: 0,
        skipped: 0,
        blockers: [],
        from: status,
        to: status,
      }
    }

    recordStep('resolving_templates')
    const { repairCampaignLaunchPrerequisites } = await import('@/lib/domain/campaigns/campaign-target-template-assignment.js')
    const repair = await repairCampaignLaunchPrerequisites(campaignId, deps)
    recordStep('templates_repaired', {
      stage_repaired: repair.stage_repaired,
      templates_assigned: repair.templates_assigned,
      launch_ready: repair.templates_assigned,
    })
    const launchMode = mergeLaunchWriteModeIntoInput(campaign, input)
    const proofNoSend = launchMode.no_send === true
    const scheduledActivation = input.scheduled_activation === true || clean(input.lock_owner) === 'scheduled_worker'
    const readiness = await evaluateCampaignLaunchReadiness(campaignId, deps, {
      ...input,
      ...launchMode,
      proof_hydration: proofNoSend,
      guarded_live_launch: !proofNoSend && launchMode.confirm_live === true,
      explicit_operator_action: asBoolean(input.explicit_operator_action ?? input.explicitOperatorAction, !scheduledActivation),
      scheduled_activation: scheduledActivation,
    })
    if (readiness.launch_readiness === 'blocked') {
      return failResult('launch_blocked', steps, {
        blockers: readiness.blockers,
        blocker_codes: readiness.blocker_codes,
        readiness,
      })
    }

    recordStep('resolving_senders')
    recordStep('applying_compliance')

    const batchMax = input.batch_max ?? input.batchMax ?? input.limit ?? 5
    recordStep('hydrating_queue', { batch_max: batchMax, skip_hydration: skipHydration })

    const scheduledFor = input.scheduled_for || input.scheduledFor || input.first_scheduled_at || campaign.scheduled_for || null
    const result = skipHydration || batchMax <= 0
      ? { ok: true, inserted: 0, skipped: 0, blockers: [], from: status, to: status, campaign }
      : await activateCampaignWithHydration(campaignId, {
        ...input,
        ...launchMode,
        activation_idempotency_key: idempotencyKey,
        explicit_operator_action: asBoolean(input.explicit_operator_action ?? input.explicitOperatorAction, !scheduledActivation),
        scheduled_activation: scheduledActivation,
        scheduled_for: scheduledFor,
        first_scheduled_at: input.first_scheduled_at || input.first_scheduled_at_utc || scheduledFor,
        first_scheduled_at_utc: input.first_scheduled_at_utc || input.first_scheduled_at || scheduledFor,
        batch_max: batchMax,
        limit: batchMax,
        lock_owner: owner,
        reason: clean(input.reason) || `operator:${owner}`,
        block_on_global_emergency_stop: false,
      }, deps)

    if (!result.ok) {
      return failResult(result.error || 'activation_failed', steps, {
        blockers: result.blockers || [],
        queue_result: result.queue_result || null,
        inserted: result.inserted ?? 0,
        skipped: result.skipped ?? 0,
      })
    }

    recordStep('activating_campaign')
    await recomputeCampaignProgress(campaignId, deps)

    let processorKickoff = null
    const shouldFinalizeLive =
      !proofNoSend &&
      launchMode.confirm_live === true &&
      (input.trigger_immediate_processor === true ||
        input.triggerImmediateProcessor === true ||
        asBoolean(input.explicit_operator_action ?? input.explicitOperatorAction, false))

    if (shouldFinalizeLive && !result.idempotent) {
      const { finalizeOperatorLiveActivation } = await import('@/lib/domain/campaigns/campaign-live-execution.js')
      processorKickoff = await finalizeOperatorLiveActivation(campaignId, input, deps)
      recordStep('processor_kickoff', {
        sent_count: processorKickoff?.sent_count ?? 0,
        claimed_count: processorKickoff?.claimed_count ?? 0,
      })
    }

    recordStep('complete', { inserted: result.inserted, skipped: result.skipped })

    const { data: refreshedCampaign } = await supabase.from('campaigns').select('*').eq('id', campaignId).maybeSingle()

    return {
      ok: true,
      campaign_id: campaignId,
      campaign: refreshedCampaign || result.campaign || null,
      idempotent: Boolean(result.idempotent),
      proof_hydration: proofNoSend,
      activation_mode: proofNoSend ? 'test' : 'live',
      steps,
      inserted: result.inserted ?? 0,
      skipped: result.skipped ?? 0,
      blockers: result.blockers || [],
      from: result.from,
      to: result.to || 'active',
      lifecycle_result: result.lifecycle_result || null,
      queue_result: result.queue_result || null,
      processor_kickoff: processorKickoff,
      sent_count: processorKickoff?.sent_count ?? 0,
      readiness,
      readiness_context: resolveLaunchReadinessContext({
        ...input,
        proof_hydration: proofNoSend,
        scheduled_activation: scheduledActivation,
      }),
    }
  } catch (error) {
    return failResult(error?.message || 'activation_exception', steps)
  }
}

function failResult(error, steps, extra = {}) {
  return {
    ok: false,
    error,
    steps,
    inserted: 0,
    skipped: 0,
    blockers: extra.blockers || [],
    ...extra,
  }
}

/**
 * A schedule this far in the past was MISSED, not due. Scheduled activation was
 * unwired in production (no scheduler called activate-due after the Vercel
 * crons were removed), so campaigns sat `scheduled` for days past their start.
 * Wiring it back must not turn a days-old schedule into an immediate, unannounced
 * send the moment a deploy lands: a missed schedule is surfaced for the operator
 * to reschedule or activate, never auto-fired.
 */
export { SCHEDULE_MISSED_GRACE_MS, isScheduleMissed, isCampaignStartMissed }

export async function findDueScheduledCampaigns(deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const nowMs = new Date(deps.now || Date.now()).getTime()
  const now = new Date(nowMs).toISOString()
  const graceFloor = new Date(nowMs - SCHEDULE_MISSED_GRACE_MS).toISOString()
  // Two reads, not one. A single `scheduled_for <= now ORDER BY scheduled_for
  // LIMIT 20` returns the OLDEST due rows first — which are exactly the missed
  // ones, already marked and never activated. Twenty of them would starve every
  // campaign that is genuinely due right now until it, too, aged into "missed".
  const { data: due, error } = await supabase
    .from('campaigns')
    // '*' — this selected id/name/status/scheduled_for only, so the activation
    // request read `campaign.batch_max` as undefined and hydrated 5 rows.
    .select('*')
    .eq('status', 'scheduled')
    .lte('scheduled_for', now)
    .gte('scheduled_for', graceFloor)
    .order('scheduled_for', { ascending: true })
    .limit(20)
  if (error) throw error
  const { data: stale, error: staleError } = await supabase
    .from('campaigns')
    .select('*')
    .eq('status', 'scheduled')
    .lt('scheduled_for', graceFloor)
    .order('scheduled_for', { ascending: false })
    .limit(20)
  if (staleError) throw staleError
  // Already-marked missed rows need no further work; only unmarked ones are returned.
  const unmarked = (stale || []).filter((c) => (c.metadata && typeof c.metadata === 'object' ? c.metadata.schedule_missed_for : null) !== c.scheduled_for)
  return [...(due || []), ...unmarked]
}

/** Internal hydration chunk for the first activation; the feeder continues from there. */
export const ACTIVATION_HYDRATION_CHUNK = 100

export function buildScheduledActivationRequest(campaign = {}) {
  const scheduledFor = campaign.scheduled_for || null
  const chunk = Math.max(1, Math.trunc(Number(campaign.batch_max) || ACTIVATION_HYDRATION_CHUNK))
  return {
    activation_idempotency_key: `scheduled:${campaign.id}:${scheduledFor}`,
    lock_owner: 'scheduled_worker',
    reason: 'scheduled_worker:due_activation',
    scheduled_activation: true,
    scheduled_for: scheduledFor,
    first_scheduled_at: scheduledFor,
    first_scheduled_at_utc: scheduledFor,
    batch_max: chunk,
    confirm_live: true,
    no_send: false,
  }
}

async function markScheduleMissed(campaign, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const metadata = campaign.metadata && typeof campaign.metadata === 'object' ? campaign.metadata : {}
  if (metadata.schedule_missed_for === campaign.scheduled_for) return false
  await supabase
    .from('campaigns')
    .update({
      metadata: { ...metadata, schedule_missed_at: new Date().toISOString(), schedule_missed_for: campaign.scheduled_for },
      updated_at: new Date().toISOString(),
    })
    .eq('id', campaign.id)
  return true
}

export async function runDueScheduledCampaignActivations(deps = {}) {
  const due = await findDueScheduledCampaigns(deps)
  const now = new Date(deps.now || Date.now()).getTime()
  const results = []
  for (const campaign of due) {
    if (isScheduleMissed(campaign, now)) {
      const marked = await markScheduleMissed(campaign, deps).catch(() => false)
      results.push({
        campaign_id: campaign.id,
        name: campaign.name,
        ok: false,
        skipped: true,
        error: 'schedule_missed',
        scheduled_for: campaign.scheduled_for,
        newly_marked: marked,
      })
      continue
    }
    const result = await runCanonicalCampaignActivation(
      campaign.id,
      buildScheduledActivationRequest(campaign),
      deps,
    )
    const recorded = result.ok === false
      ? await recordScheduledActivationRefusal(campaign, result, deps).catch(() => false)
      : false
    results.push({ campaign_id: campaign.id, name: campaign.name, refusal_recorded: recorded, ...result })
  }
  return { ok: true, processed: results.length, results }
}

/**
 * A scheduled launch that readiness refused left no trace on the campaign: the
 * reasons went back to the scheduler tick and nowhere else, the campaign sat
 * `scheduled`, and two hours later it was marked missed. The operator saw a
 * schedule that silently never started. Record the refusal — once per distinct
 * (schedule, reasons) — on the campaign and in its activity.
 */
export async function recordScheduledActivationRefusal(campaign = {}, result = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const metadata = campaign.metadata && typeof campaign.metadata === 'object' && !Array.isArray(campaign.metadata) ? campaign.metadata : {}
  const blockers = (Array.isArray(result.blockers) ? result.blockers : []).map((value) => clean(value)).filter(Boolean).slice(0, 6)
  const codes = (Array.isArray(result.blocker_codes) ? result.blocker_codes : []).map((value) => clean(value)).filter(Boolean).slice(0, 10)
  const error = clean(result.error) || 'activation_failed'
  const signature = [clean(campaign.scheduled_for), error, ...codes, ...blockers].join('|')
  if (metadata.activation_blocked?.signature === signature) return false
  const at = new Date(deps.now || Date.now()).toISOString()
  const scheduledMs = Date.parse(campaign.scheduled_for || '')
  const retryUntil = Number.isFinite(scheduledMs) ? new Date(scheduledMs + SCHEDULE_MISSED_GRACE_MS).toISOString() : null
  const activationBlocked = {
    at,
    scheduled_for: campaign.scheduled_for || null,
    error,
    blocker_codes: codes,
    blockers,
    retry_until: retryUntil,
    signature,
  }
  const { error: updateError } = await supabase
    .from('campaigns')
    .update({ metadata: { ...metadata, activation_blocked: activationBlocked }, updated_at: at })
    .eq('id', campaign.id)
  if (updateError) throw updateError
  await supabase.from('campaign_events').insert({
    campaign_id: campaign.id,
    event_type: 'campaign.activation_blocked',
    severity: 'warning',
    title: 'Scheduled launch held',
    description: `The scheduled launch could not start: ${blockers.join(' · ') || error}.`
      + (retryUntil ? ' It retries every few minutes for two hours after the scheduled time, then is marked missed.' : ''),
    metadata: { ...activationBlocked, source: 'scheduled_activation' },
  })
  return true
}

export { ACTIVATION_STEPS }
