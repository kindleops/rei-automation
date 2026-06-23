/**
 * Shadow-mode template rotation autopilot policy.
 * Evaluates cohort-matched templates; never mutates production state.
 */

import { ROTATION_STATES } from './template-intelligence-contract.js'

export const POLICY_VERSION = 'template-intelligence-shadow-v1'

const MIN_DELIVERED_THRESHOLD = 30
const MAX_OPT_OUT_RATE = 0.05
const MAX_HOSTILE_RATE = 0.02
const MAX_FAILURE_RATE = 0.20
const MAX_WEIGHT_STEP = 0.15

export function cohortKey(template) {
  return [
    template.stage_code,
    template.touch_number,
    template.use_case,
    template.language,
    template.asset_scope,
  ].map((v) => String(v ?? '').toLowerCase()).join('|')
}

export function computeCopyScore(metrics) {
  const reply = metrics.rates?.reply?.value ?? 0
  const positive = metrics.rates?.positive_reply?.value ?? 0
  const ownership = metrics.rates?.ownership_confirmation?.value ?? 0
  const optOut = metrics.rates?.opt_out?.value ?? 0
  const hostile = metrics.rates?.hostile_legal?.value ?? 0
  let score = reply * 0.35 + positive * 0.35 + ownership * 0.2
  score -= optOut * 2 + hostile * 3
  return Math.max(0, Math.min(100, Math.round(score * 10) / 10))
}

export function computeExecutionScore(metrics) {
  const delivery = metrics.rates?.delivery?.value ?? 0
  const failure = metrics.rates?.failure?.value ?? 100
  const retryRecovery = metrics.rates?.retry_recovery?.value ?? 0
  let score = delivery * 0.7 + retryRecovery * 0.1
  score -= failure * 0.5
  return Math.max(0, Math.min(100, Math.round(score * 10) / 10))
}

export function computeAudienceQualityScore(metrics, attributionHealthy = true) {
  const wrong = metrics.rates?.wrong_number?.value ?? 0
  const unclear = metrics.unclear > 0 && metrics.replies > 0
    ? (metrics.unclear / metrics.replies) * 100
    : 0
  let score = attributionHealthy ? 70 : 40
  score -= wrong * 2 + unclear * 0.5
  return Math.max(0, Math.min(100, Math.round(score * 10) / 10))
}

function immediatePauseReasons(template, metrics, dataQuality = {}) {
  const reasons = []
  if (dataQuality.unresolved_merge_variable) reasons.push('unresolved_merge_variable')
  if (dataQuality.wrong_language) reasons.push('wrong_language')
  if (dataQuality.asset_mismatch) reasons.push('asset_mismatch')
  if (dataQuality.prohibited_content) reasons.push('prohibited_content')
  if (dataQuality.duplicate_outreach_violation) reasons.push('duplicate_outreach_violation')
  if ((metrics.rates?.opt_out?.value ?? 0) >= 8) reasons.push('high_confidence_opt_out_spike')
  if ((metrics.rates?.hostile_legal?.value ?? 0) >= 3) reasons.push('legal_hostile_complaint_spike')
  if (dataQuality.carrier_content_rejection_spike) reasons.push('carrier_content_rejection_spike')
  return reasons
}

function mapRotationState(metrics, currentState, cohortBaseline) {
  const delivered = metrics.delivered ?? 0
  const copyScore = computeCopyScore(metrics)
  const baseline = cohortBaseline?.copy_score ?? 0

  if (delivered < 5) return 'cold_start'
  if (delivered < MIN_DELIVERED_THRESHOLD) return currentState === 'winner' || currentState === 'champion' ? 'watch' : 'testing'
  if (copyScore >= baseline + 15 && delivered >= 100) return 'champion'
  if (copyScore >= baseline + 8) return 'winner'
  if (copyScore >= baseline + 3) return 'rising'
  if ((metrics.rates?.opt_out?.value ?? 0) >= MAX_OPT_OUT_RATE * 100) return 'cooldown'
  if ((metrics.rates?.failure?.value ?? 0) >= MAX_FAILURE_RATE * 100) return 'watch'
  return currentState || 'testing'
}

export function evaluateTemplateAutopilot({
  template,
  metrics,
  cohortBaseline = null,
  cohortPeers = [],
  dataQuality = {},
  currentControl = {},
  mode = 'shadow',
}) {
  const now = new Date().toISOString()
  const pauseReasons = immediatePauseReasons(template, metrics, dataQuality)
  const copyScore = computeCopyScore(metrics)
  const executionScore = computeExecutionScore(metrics)
  const audienceScore = computeAudienceQualityScore(metrics, dataQuality.attribution_healthy !== false)
  const currentState = currentControl.rotation_state ?? 'cold_start'
  const currentWeight = Number(currentControl.traffic_weight ?? 1)
  const currentCap = Number(currentControl.daily_cap ?? 0) || null

  let proposedState = mapRotationState(metrics, currentState, cohortBaseline)
  let proposedWeight = currentWeight
  let proposedCap = currentCap
  let decisionReason = 'within_policy_thresholds'
  const riskFlags = []

  if (pauseReasons.length > 0) {
    proposedState = 'paused'
    proposedWeight = 0
    decisionReason = `immediate_safety_pause:${pauseReasons.join(',')}`
    riskFlags.push(...pauseReasons)
  } else if (metrics.delivered < MIN_DELIVERED_THRESHOLD) {
    decisionReason = 'insufficient_delivered_volume'
    proposedState = 'cold_start'
    riskFlags.push('below_minimum_delivered_threshold')
  } else if (dataQuality.attribution_healthy === false) {
    decisionReason = 'attribution_unhealthy_hold'
    proposedState = 'watch'
    riskFlags.push('attribution_unhealthy')
  } else if (dataQuality.variable_rendering_healthy === false) {
    decisionReason = 'variable_rendering_unhealthy_hold'
    proposedState = 'watch'
    riskFlags.push('variable_rendering_unhealthy')
  } else if ((metrics.rates?.opt_out?.value ?? 0) > MAX_OPT_OUT_RATE * 100) {
    decisionReason = 'opt_out_rate_above_ceiling'
    proposedState = 'cooldown'
    proposedWeight = Math.max(0, currentWeight - MAX_WEIGHT_STEP)
    riskFlags.push('opt_out_above_ceiling')
  } else if ((metrics.rates?.hostile_legal?.value ?? 0) > MAX_HOSTILE_RATE * 100) {
    decisionReason = 'hostile_rate_above_ceiling'
    proposedState = 'cooldown'
    riskFlags.push('hostile_above_ceiling')
  } else if ((metrics.rates?.failure?.value ?? 0) > MAX_FAILURE_RATE * 100) {
    decisionReason = 'execution_failure_not_copy'
    proposedState = 'watch'
    riskFlags.push('execution_failure_elevated')
  } else if (cohortBaseline && copyScore < cohortBaseline.copy_score) {
    decisionReason = 'copy_below_cohort_baseline'
    proposedState = 'watch'
    riskFlags.push('below_cohort_baseline')
  } else if (copyScore >= (cohortBaseline?.copy_score ?? 0) + 5) {
    const target = Math.min(currentWeight + MAX_WEIGHT_STEP, 1)
    if (target > currentWeight) {
      proposedWeight = Math.round(target * 100) / 100
      decisionReason = 'gradual_scale_up_copy_outperforming'
    }
  }

  if (currentControl.manual_lock) {
    proposedState = currentState
    proposedWeight = currentWeight
    proposedCap = currentCap
    decisionReason = `manual_lock:${currentControl.block_reason ?? 'locked'}`
  }

  const percentile = cohortPeers.length > 0
    ? Math.round((cohortPeers.filter((p) => p.copy_score < copyScore).length / cohortPeers.length) * 100)
    : null

  return {
    rotation_state: currentState,
    traffic_weight: currentWeight,
    daily_cap: currentCap,
    minimum_threshold: MIN_DELIVERED_THRESHOLD,
    maximum_threshold: null,
    proposed_state: proposedState,
    proposed_weight: proposedWeight,
    proposed_cap: proposedCap,
    decision_reason: decisionReason,
    policy_version: POLICY_VERSION,
    last_evaluation: now,
    next_evaluation: new Date(Date.now() + 6 * 3600000).toISOString(),
    manual_lock: Boolean(currentControl.manual_lock),
    block_reason: currentControl.block_reason ?? null,
    mode,
    would_mutate: mode === 'autonomous' || mode === 'controlled',
    shadow_only: mode === 'shadow' || mode === 'recommend' || mode === 'off',
    intelligence: {
      current_range_confidence: metrics.confidence,
      historical_confidence: confidenceFromDelivered(metrics.delivered),
      performance_label: metrics.performance_label,
      trend: metrics.delivered > (cohortBaseline?.delivered ?? 0) ? 'rising' : 'stable',
      copy_score: copyScore,
      execution_score: executionScore,
      audience_quality_score: audienceScore,
      risk_flags: riskFlags,
      cohort_baseline: cohortBaseline,
      percentile_rank: percentile,
    },
    metric_snapshot: {
      delivered: metrics.delivered,
      sends: metrics.sends,
      reply_rate: metrics.rates?.reply?.value,
      positive_rate: metrics.rates?.positive_reply?.value,
      opt_out_rate: metrics.rates?.opt_out?.value,
      failure_rate: metrics.rates?.failure?.value,
    },
  }
}

function confidenceFromDelivered(delivered) {
  const n = Number(delivered) || 0
  if (n >= 500) return { bucket: 'high_confidence', sample_size: n, range: 'historical' }
  if (n >= 100) return { bucket: 'medium_confidence', sample_size: n, range: 'historical' }
  if (n >= 30) return { bucket: 'low_confidence', sample_size: n, range: 'historical' }
  return { bucket: 'insufficient_data', sample_size: n, range: 'historical' }
}

export function buildCohortBaseline(templates) {
  const groups = new Map()
  for (const t of templates) {
    const key = cohortKey(t)
    const entry = groups.get(key) ?? { copy_scores: [], delivered: 0, count: 0 }
    entry.copy_scores.push(t.intelligence?.copy_score ?? computeCopyScore(t.metrics ?? {}))
    entry.delivered += t.metrics?.delivered ?? 0
    entry.count += 1
    groups.set(key, entry)
  }
  const baselines = new Map()
  for (const [key, g] of groups) {
    const avgCopy = g.copy_scores.length
      ? g.copy_scores.reduce((a, b) => a + b, 0) / g.copy_scores.length
      : 0
    baselines.set(key, {
      copy_score: Math.round(avgCopy * 10) / 10,
      delivered: Math.round(g.delivered / Math.max(g.count, 1)),
      peer_count: g.count,
    })
  }
  return baselines
}

export function validateRotationState(state) {
  return ROTATION_STATES.includes(state)
}