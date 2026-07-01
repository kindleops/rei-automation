/**
 * Canonical campaign activation — shared by Activate Now and scheduled worker.
 */

import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { activateCampaignWithHydration } from '@/lib/domain/campaigns/campaign-automation-service.js'
import { evaluateCampaignLaunchReadiness, resolveLaunchReadinessContext } from '@/lib/domain/campaigns/campaign-launch-readiness.js'
import { recomputeCampaignProgress } from '@/lib/domain/campaigns/campaign-progress.js'

import { isQueueableStatus, normalizeCampaignStatus } from '@/lib/domain/campaigns/campaign-state-machine.js'
import {
  isCampaignFullyLive,
  isCampaignLiveInconsistent,
  mergeLaunchWriteModeIntoInput,
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
    const needsReconcile = isCampaignLiveInconsistent(campaign)

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

export async function findDueScheduledCampaigns(deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from('campaigns')
    .select('id,name,status,scheduled_for,activation_attempt_count')
    .eq('status', 'scheduled')
    .lte('scheduled_for', now)
    .order('scheduled_for', { ascending: true })
    .limit(20)
  if (error) throw error
  return data || []
}

export function buildScheduledActivationRequest(campaign = {}) {
  const scheduledFor = campaign.scheduled_for || null
  return {
    activation_idempotency_key: `scheduled:${campaign.id}:${scheduledFor}`,
    lock_owner: 'scheduled_worker',
    reason: 'scheduled_worker:due_activation',
    scheduled_activation: true,
    scheduled_for: scheduledFor,
    first_scheduled_at: scheduledFor,
    first_scheduled_at_utc: scheduledFor,
    batch_max: campaign.batch_max ?? 5,
    confirm_live: true,
    no_send: false,
  }
}

export async function runDueScheduledCampaignActivations(deps = {}) {
  const due = await findDueScheduledCampaigns(deps)
  const results = []
  for (const campaign of due) {
    const result = await runCanonicalCampaignActivation(
      campaign.id,
      buildScheduledActivationRequest(campaign),
      deps,
    )
    results.push({ campaign_id: campaign.id, name: campaign.name, ...result })
  }
  return { ok: true, processed: results.length, results }
}

export { ACTIVATION_STEPS }