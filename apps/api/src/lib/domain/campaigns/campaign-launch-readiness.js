/**
 * Truthful launch readiness — evaluates execution gates before live send.
 */

import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { getSystemValue } from '@/lib/system-control.js'
import { renderOutboundTemplate } from '@/lib/domain/outbound/supabase-candidate-feeder.js'
import { normalizeCampaignStageCode } from '@/lib/domain/campaigns/campaign-stage-code.js'
import {
  canonicalLanguageLabel,
  resolveLanguage,
} from '@/lib/domain/campaigns/campaign-canonical-language.js'
import {
  asBoolean,
  isEmergencyStopActive,
  normalizeQueueProcessorMode,
} from '@/lib/domain/queue/queue-control-safety.js'
import { evaluateGlobalSendBrakeState } from '@/lib/domain/queue/queue-send-brake-state.js'
import { normalizeCampaignStatus } from '@/lib/domain/campaigns/campaign-state-machine.js'

async function launchCandidateFromTarget(target, campaign) {
  const { launchCandidateFromTarget: resolve } = await import('@/lib/domain/campaigns/campaign-automation-service.js')
  return resolve(target, campaign)
}

function clean(value) {
  return String(value ?? '').trim()
}

function metadataObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

const BLOCKER_LABELS = {
  emergency_stop: 'Emergency stop is active',
  queue_processor_disabled: 'Global queue processor is disabled',
  global_auto_enqueue_disabled: 'Global campaign enqueue is disabled',
  campaign_auto_queue_disabled: 'Campaign auto-queue is disabled',
  transmission_disabled: 'Campaign transmission is disabled (test mode / auto-send off)',
  unrestricted_auto_send: 'Unrestricted auto-send must remain disabled for guarded launch',
  missing_daily_cap: 'Daily send cap is missing',
  missing_total_cap: 'Total send cap is missing',
  missing_batch_max: 'Batch maximum is missing',
  missing_market_cap: 'Market cap is missing',
  missing_per_sender_cap: 'Per-sender cap is missing',
  missing_send_window: 'Send window is not configured',
  routing_zero: 'No routable recipients (routing allowed = 0)',
  template_required: 'No approved template resolved for scenario/stage/language',
  language_template_gap: 'Targets missing language template assignment',
  no_ready_recipients: 'No ready recipients in target snapshot',
  no_launch_ready_recipients: 'No launch-ready recipients after template and routing gates',
  missing_canonical_phone: 'Recipient missing canonical phone',
  suppression_blocked: 'Active suppression on ready recipients',
  routing_blocked: 'Sender route unavailable for ready recipients',
  identity_blocked: 'Identity confidence too low for activation',
  duplicate_queue_row: 'Duplicate active queue row exists',
  campaign_not_queueable: 'Campaign lifecycle does not allow activation',
  missing_launch_caps: 'Campaign missing required pacing caps',
  provider_disabled: 'Outbound SMS provider is disabled',
  zero_valid_senders: 'No active sender route covers this campaign market',
}

function isTargetRoutingReady(row = {}) {
  return (
    clean(row.target_status) === 'ready' &&
    clean(row.routing_status) === 'ready' &&
    clean(row.suppression_status) !== 'blocked'
  )
}

function isTargetLaunchReady(row = {}) {
  return (
    isTargetRoutingReady(row) &&
    clean(row.template_status) === 'ready' &&
    clean(row.identity_status) !== 'blocked'
  )
}

function isSenderCoveredTarget(row = {}) {
  const metadata = metadataObject(row.metadata)
  return metadata.sender_covered === true || metadata.candidate_snapshot?.sender_covered === true
}

export function resolveLaunchReadinessContext(options = {}) {
  const proof_hydration = options.proof_hydration === true || options.no_send === true || options.noSend === true
  const guarded_live_launch = !proof_hydration && (
    options.guarded_live_launch === true ||
    options.confirm_live === true ||
    options.confirmLive === true
  )
  const explicit_operator_action = options.explicit_operator_action === true || options.explicitOperatorAction === true
  const scheduled_activation = options.scheduled_activation === true || options.scheduledActivation === true
  const controlled_hydration = proof_hydration || guarded_live_launch || explicit_operator_action || scheduled_activation
  return {
    proof_hydration,
    guarded_live_launch,
    explicit_operator_action,
    scheduled_activation,
    controlled_hydration,
  }
}

export async function evaluateCampaignLaunchReadiness(campaignId, deps = {}, options = {}) {
  const supabase = deps.supabase || defaultSupabase
  const blockers = []
  const blockerCodes = []
  const warnings = []
  const context = resolveLaunchReadinessContext(options)

  const { data: campaign } = await supabase.from('campaigns').select('*').eq('id', campaignId).maybeSingle()
  if (!campaign) return { ok: false, error: 'campaign_not_found' }

  const status = normalizeCampaignStatus(campaign.status)
  const loadSystemValue = deps.getSystemValue
    ? (key) => deps.getSystemValue(key, { supabase })
    : (key) => getSystemValue(key, { supabase })

  const [
    emergencyStop,
    processorModeRaw,
    globalAutoEnqueue,
    outboundSms,
    targetRowsRes,
    senderRowsRes,
  ] = await Promise.all([
    loadSystemValue('queue_emergency_stop_at'),
    loadSystemValue('queue_processor_mode'),
    loadSystemValue('queue_auto_enqueue_enabled'),
    loadSystemValue('outbound_sms_enabled'),
    supabase.from('campaign_targets').select('*').eq('campaign_id', campaignId).limit(50000),
    supabase.from('textgrid_numbers').select('id,market,status').eq('status', 'active').limit(500),
  ])

  const brakeState = evaluateGlobalSendBrakeState({
    queue_emergency_stop_at: emergencyStop,
    queue_processor_mode: processorModeRaw,
  })

  if (context.controlled_hydration) {
    if (brakeState.emergency_stop_active) {
      warnings.push('Emergency stop is active — queue hydration allowed, live sends remain blocked until cleared')
    }
    if (brakeState.processor_paused) {
      warnings.push('Queue processor is paused — rows will hydrate but will not transmit until processor resumes')
    }
  } else {
    if (isEmergencyStopActive(emergencyStop)) {
      blockers.push(BLOCKER_LABELS.emergency_stop)
      blockerCodes.push('emergency_stop')
    }
    const processorMode = normalizeQueueProcessorMode(processorModeRaw, 'off')
    if (processorMode === 'off') {
      blockers.push(BLOCKER_LABELS.queue_processor_disabled)
      blockerCodes.push('queue_processor_disabled')
    }
  }

  if (!context.controlled_hydration) {
    if (!asBoolean(globalAutoEnqueue, false)) {
      blockers.push(BLOCKER_LABELS.global_auto_enqueue_disabled)
      blockerCodes.push('global_auto_enqueue_disabled')
    }
    if (!campaign.auto_queue_enabled) {
      blockers.push(BLOCKER_LABELS.campaign_auto_queue_disabled)
      blockerCodes.push('campaign_auto_queue_disabled')
    }
    if (!campaign.auto_send_enabled) {
      blockers.push(BLOCKER_LABELS.transmission_disabled)
      blockerCodes.push('transmission_disabled')
    }
  } else if (
    asBoolean(campaign.auto_send_enabled, false) &&
    !context.guarded_live_launch &&
    !asBoolean(campaign.metadata?.production_launch, false)
  ) {
    blockers.push(BLOCKER_LABELS.unrestricted_auto_send)
    blockerCodes.push('unrestricted_auto_send')
  }

  if (!asBoolean(outboundSms, false)) {
    blockers.push(BLOCKER_LABELS.provider_disabled)
    blockerCodes.push('provider_disabled')
  }

  if (!campaign.daily_cap) {
    blockers.push(BLOCKER_LABELS.missing_daily_cap)
    blockerCodes.push('missing_daily_cap')
  }
  if (!campaign.total_cap) {
    warnings.push('Total send cap is not set')
  }
  if (!campaign.batch_max) {
    blockers.push(BLOCKER_LABELS.missing_batch_max)
    blockerCodes.push('missing_batch_max')
  }
  if (!campaign.market_cap) {
    blockers.push(BLOCKER_LABELS.missing_market_cap)
    blockerCodes.push('missing_market_cap')
  }
  if (!campaign.per_sender_cap) {
    blockers.push(BLOCKER_LABELS.missing_per_sender_cap)
    blockerCodes.push('missing_per_sender_cap')
  }
  if (!campaign.contact_window_start || !campaign.contact_window_end) {
    blockers.push(BLOCKER_LABELS.missing_send_window)
    blockerCodes.push('missing_send_window')
  }

  const targets = targetRowsRes.data || []
  const persistedTargetCount = targets.length
  const readyTargets = targets.filter((row) => clean(row.target_status) === 'ready')
  const readyTotal = readyTargets.length
  const routingReadyTargets = targets.filter(isTargetRoutingReady)
  const routingReadyTotal = routingReadyTargets.length
  const templateReadyTotal = targets.filter((row) => clean(row.template_status) === 'ready').length
  const launchReadyTargets = targets.filter(isTargetLaunchReady)
  const launchReadyTotal = launchReadyTargets.length
  const suppressedTotal = targets.filter((row) => clean(row.suppression_status) === 'blocked').length
  const awaitingTemplateTotal = routingReadyTargets.filter((row) => clean(row.template_status) !== 'ready').length
  const senderCoveredTotal = routingReadyTargets.filter(isSenderCoveredTarget).length
  const outsideSenderCapacityTotal = Math.max(0, routingReadyTotal - senderCoveredTotal)

  const langBuckets = new Map()
  let unsupportedLanguageTotal = 0
  for (const row of targets) {
    const lang = canonicalLanguageLabel(row.language)
    const resolved = resolveLanguage(row.language)
    if (!langBuckets.has(lang)) {
      langBuckets.set(lang, { total: 0, unassigned: 0, unsupported: 0 })
    }
    const bucket = langBuckets.get(lang)
    bucket.total += 1
    if (resolved.unsupported) {
      bucket.unsupported += 1
      unsupportedLanguageTotal += 1
    } else if (clean(row.template_status) !== 'ready') {
      bucket.unassigned += 1
    }
  }

  const routableTotal = routingReadyTotal
  const templateCoveragePct = routingReadyTotal > 0
    ? (launchReadyTotal / routingReadyTotal) * 100
    : 100

  if (!readyTotal) {
    blockers.push(BLOCKER_LABELS.no_ready_recipients)
    blockerCodes.push('no_ready_recipients')
  }

  if (readyTotal > 0 && routingReadyTotal === 0) {
    blockers.push(BLOCKER_LABELS.routing_zero)
    blockerCodes.push('routing_zero')
  }

  if (routingReadyTotal > 0 && launchReadyTotal === 0) {
    blockers.push(BLOCKER_LABELS.no_launch_ready_recipients)
    blockerCodes.push('no_launch_ready_recipients')
  }

  const activeSenders = (senderRowsRes.data || []).filter((row) => clean(row.status).toLowerCase() === 'active')
  const campaignMarket = clean(campaign.market).toLowerCase()
  const marketAliases = new Set([
    campaignMarket,
    'los angeles',
    'los angeles, ca',
    'la',
    'riverside',
    'inland empire',
    'san bernardino',
  ].filter(Boolean))
  const marketSenders = activeSenders.filter((row) => marketAliases.has(clean(row.market).toLowerCase()))
  if (routingReadyTotal > 0 && marketSenders.length === 0) {
    blockers.push(BLOCKER_LABELS.zero_valid_senders)
    blockerCodes.push('zero_valid_senders')
  } else if (outsideSenderCapacityTotal > 0 && launchReadyTotal > 0) {
    warnings.push(
      `${outsideSenderCapacityTotal} routing-ready targets are outside current sender capacity — initial batch will cover ${senderCoveredTotal}`
    )
  }

  for (const [lang, bucket] of langBuckets) {
    if (bucket.unsupported > 0) {
      warnings.push(`${bucket.unsupported} ${lang} targets excluded — no approved S1 template`)
    }
    if (bucket.unassigned > 0 && !bucket.unsupported) {
      const message = `${bucket.unassigned} ${lang} targets awaiting template assignment`
      if (launchReadyTotal > 0) {
        warnings.push(message)
      } else if (context.controlled_hydration && templateCoveragePct >= 95) {
        warnings.push(message)
      } else {
        blockers.push(message)
        blockerCodes.push('language_template_gap')
      }
    }
  }

  if (unsupportedLanguageTotal > 0 && launchReadyTotal > 0) {
    warnings.push(`${unsupportedLanguageTotal} targets excluded for unsupported language — campaign can still launch`)
  }

  let templateResolved = 0
  let templateMissing = 0
  const sampleTargets = launchReadyTargets.length
    ? launchReadyTargets.slice(0, 5)
    : routingReadyTargets.slice(0, 5)
  const sampleSize = Math.min(5, sampleTargets.length)
  const stageCode = normalizeCampaignStageCode(campaign.metadata?.stage_code, 'S1')

  for (let i = 0; i < sampleSize; i += 1) {
    const target = sampleTargets[i]
    const candidate = launchCandidateFromTarget(target, campaign)
    candidate.stage_code = stageCode
    const rendered = await renderOutboundTemplate(candidate, {
      template_use_case: campaign.metadata?.template_use_case || campaign.objective || 'ownership_check',
      stage_code: stageCode,
      first_touch: true,
      campaign_template_assignment: true,
      allow_identity_unknown: true,
    }, deps)
    if (rendered.ok && (rendered.selected_template_id || rendered.template?.template_id)) {
      templateResolved += 1
    } else {
      templateMissing += 1
    }
  }

  if (routingReadyTotal && templateMissing === sampleSize && launchReadyTotal === 0) {
    if (context.controlled_hydration && routableTotal > 0) {
      warnings.push(BLOCKER_LABELS.template_required)
    } else {
      blockers.push(BLOCKER_LABELS.template_required)
      blockerCodes.push('template_required')
    }
  } else if (templateMissing > 0) {
    warnings.push(`${templateMissing}/${sampleSize} sampled recipients missing template resolution`)
  }

  if (['archived', 'completed', 'failed'].includes(status)) {
    blockers.push(BLOCKER_LABELS.campaign_not_queueable)
    blockerCodes.push('campaign_not_queueable')
  }

  const uniqueBlockers = [...new Set(blockers)]
  const uniqueCodes = [...new Set(blockerCodes)]
  const level = uniqueBlockers.length ? 'blocked' : warnings.length ? 'warnings' : 'ready'

  return {
    ok: true,
    launch_readiness: level,
    blocker_count: uniqueBlockers.length,
    blocker_codes: uniqueCodes,
    blockers: uniqueBlockers,
    warnings,
    template_readiness: templateMissing === 0 && launchReadyTotal ? 'resolved' : templateMissing === sampleSize ? 'missing' : 'partial',
    template_sample: { resolved: templateResolved, missing: templateMissing, sampled: sampleSize },
    counts: {
      candidates_discovered:
        Number(campaign.metadata?.candidate_count || campaign.metadata?.preview_ready_to_queue || 0) || null,
      targets_persisted: persistedTargetCount,
      deduplicated: persistedTargetCount,
      routing_ready: routingReadyTotal,
      template_ready: templateReadyTotal,
      template_assigned: templateReadyTotal,
      sender_covered: senderCoveredTotal,
      contactable: Math.max(0, routingReadyTotal - suppressedTotal),
      launch_ready: launchReadyTotal,
      awaiting_template: awaitingTemplateTotal,
      unsupported_language: unsupportedLanguageTotal,
      outside_sender_capacity: outsideSenderCapacityTotal,
      suppressed: suppressedTotal,
      previously_contacted: targets.filter((row) => {
        const meta = metadataObject(row.metadata)
        return meta.never_contacted === false || Number(meta.touch_count || 0) > 0
      }).length,
      blocked: suppressedTotal + (routingReadyTotal === 0 && readyTotal > 0 ? readyTotal - routingReadyTotal : 0),
      warnings_count: warnings.length,
      hard_blockers_count: uniqueBlockers.length,
      excluded: unsupportedLanguageTotal + suppressedTotal,
    },
    ready_recipient_count: readyTotal,
    routable_recipient_count: routableTotal,
    launch_ready_recipient_count: launchReadyTotal,
    remediation: uniqueBlockers,
    readiness_context: context,
    send_brake_state: brakeState,
    stage_code: stageCode,
    false_routing_blocker_removed: true,
  }
}