/**
 * Canonical campaign activation — shared by Activate Now and scheduled worker.
 */

import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { activateCampaignWithHydration } from '@/lib/domain/campaigns/campaign-automation-service.js'
import { evaluateCampaignLaunchReadiness } from '@/lib/domain/campaigns/campaign-launch-readiness.js'
import { recomputeCampaignProgress } from '@/lib/domain/campaigns/campaign-progress.js'

import { isQueueableStatus, normalizeCampaignStatus } from '@/lib/domain/campaigns/campaign-state-machine.js'

function clean(value) {
  return String(value ?? '').trim()
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

    if (idempotencyKey && clean(campaign.last_activation_idempotency_key) === idempotencyKey && ['active', 'activating', 'queued'].includes(status)) {
      return {
        ok: true,
        idempotent: true,
        campaign_id: campaignId,
        steps,
        inserted: 0,
        skipped: 0,
        blockers: [],
      }
    }

    recordStep('resolving_templates')
    const readiness = await evaluateCampaignLaunchReadiness(campaignId, deps)
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
    recordStep('hydrating_queue', { batch_max: batchMax })

    const proofNoSend = input.no_send === true || input.noSend === true
    const result = await activateCampaignWithHydration(campaignId, {
      ...input,
      activation_idempotency_key: idempotencyKey,
      confirm_live: proofNoSend ? true : input.confirm_live !== false,
      no_send: proofNoSend,
      hydrate_canonical_queue: proofNoSend,
      batch_max: batchMax,
      limit: batchMax,
      lock_owner: owner,
      reason: clean(input.reason) || `operator:${owner}`,
      block_on_global_emergency_stop: proofNoSend ? false : input.block_on_global_emergency_stop,
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
    recordStep('complete', { inserted: result.inserted, skipped: result.skipped })

    return {
      ok: true,
      campaign_id: campaignId,
      idempotent: Boolean(result.idempotent),
      steps,
      inserted: result.inserted ?? 0,
      skipped: result.skipped ?? 0,
      blockers: result.blockers || [],
      from: result.from,
      to: result.to || 'active',
      queue_result: result.queue_result || null,
      readiness,
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

export async function runDueScheduledCampaignActivations(deps = {}) {
  const due = await findDueScheduledCampaigns(deps)
  const results = []
  for (const campaign of due) {
    const idempotencyKey = `scheduled:${campaign.id}:${campaign.scheduled_for}`
    const result = await runCanonicalCampaignActivation(campaign.id, {
      activation_idempotency_key: idempotencyKey,
      lock_owner: 'scheduled_worker',
      reason: 'scheduled_worker:due_activation',
      batch_max: 5,
      confirm_live: true,
    }, deps)
    results.push({ campaign_id: campaign.id, name: campaign.name, ...result })
  }
  return { ok: true, processed: results.length, results }
}

export { ACTIVATION_STEPS }