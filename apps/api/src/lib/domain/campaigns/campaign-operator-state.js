/**
 * Operator-facing campaign lifecycle labels — distinct from persisted DB status.
 */

import { normalizeCampaignStatus } from '@/lib/domain/campaigns/campaign-state-machine.js'

function clean(value) {
  return String(value ?? '').trim()
}

export const OPERATOR_STATES = Object.freeze([
  'draft',
  'building_targets',
  'targets_ready',
  'needs_configuration',
  'scheduled',
  'live',
  'test_mode',
  'paused',
  'blocked',
  'completed',
  'failed',
  'archived',
])

const OPERATOR_LABELS = Object.freeze({
  draft: 'Draft',
  building_targets: 'Building Targets',
  targets_ready: 'Targets Ready',
  needs_configuration: 'Needs Configuration',
  scheduled: 'Scheduled',
  live: 'Live',
  test_mode: 'Test Mode',
  paused: 'Paused',
  blocked: 'Blocked',
  completed: 'Completed',
  failed: 'Failed',
  archived: 'Archived',
})

export function deriveOperatorState(campaign = {}, execution = {}, readiness = {}) {
  const status = normalizeCampaignStatus(campaign.status || 'draft')
  const proofMode = Boolean(execution?.proof_mode || execution?.no_messages_will_transmit)
  const productionLaunch = Boolean(clean(campaign.metadata?.converted_to_live_at) || campaign.metadata?.production_launch)
  const liveSendRows = Number(execution?.live_send_rows || 0)
  const routingAllowed = Number(execution?.routing_allowed || 0)
  const transmissionEnabled = Boolean(execution?.transmission_enabled)
  const readinessLevel = clean(readiness?.launch_readiness || readiness?.level)
  const hasBlockers = (readiness?.blockers || []).length > 0 || readinessLevel === 'blocked'
  const frozenTargets = Number(campaign.total_targets ?? execution?.total_targets ?? 0)
  const building = clean(campaign.metadata?.target_build_status).toLowerCase() === 'building'

  if (status === 'archived') return 'archived'
  if (status === 'completed') return 'completed'
  if (status === 'failed') return 'failed'
  if (building) return 'building_targets'

  if (proofMode || (liveSendRows === 0 && Number(execution?.proof_no_send_rows || 0) > 0 && !transmissionEnabled)) {
    if (['active', 'activating', 'paused', 'scheduled'].includes(status)) return 'test_mode'
  }

  if (status === 'paused') return 'paused'

  if (hasBlockers && ['active', 'activating', 'scheduled', 'built', 'queued'].includes(status)) {
    return 'blocked'
  }

  if (status === 'draft') return 'draft'

  if (['built', 'queued'].includes(status)) {
    if (frozenTargets > 0 && !hasBlockers) return 'targets_ready'
    if (frozenTargets > 0) return 'needs_configuration'
    return 'draft'
  }

  if (status === 'scheduled') return 'scheduled'

  if (['active', 'activating'].includes(status)) {
    if (liveSendRows > 0 && routingAllowed > 0 && (transmissionEnabled || productionLaunch)) return 'live'
    if (proofMode) return 'test_mode'
    if (hasBlockers || routingAllowed === 0) return 'blocked'
    if (!transmissionEnabled && !productionLaunch) return 'blocked'
    return 'live'
  }

  return status
}

export function deriveReadinessLabel(campaign = {}, execution = {}, readiness = {}, operatorState = 'draft') {
  const status = normalizeCampaignStatus(campaign.status || 'draft')
  if (operatorState === 'completed') return 'Completed'
  if (operatorState === 'failed') return 'Failed'
  if (operatorState === 'paused') return 'Paused'
  if (operatorState === 'live') return 'Live'

  const proofMode = Boolean(execution?.proof_mode || execution?.no_messages_will_transmit)
  const liveSendRows = Number(execution?.live_send_rows || 0)
  const proofRows = Number(execution?.proof_no_send_rows || 0)
  const transmissionEnabled = Boolean(execution?.transmission_enabled)
  const readinessLevel = clean(readiness?.launch_readiness || readiness?.level)

  if (proofMode || (liveSendRows === 0 && proofRows > 0 && !transmissionEnabled)) {
    return 'Ready for Test Hydration'
  }

  if (readinessLevel === 'blocked' || (readiness?.blockers || []).length > 0) {
    return 'Blocked for Live Transmission'
  }

  if (readinessLevel === 'ready' && transmissionEnabled && liveSendRows > 0) {
    return 'Ready for Controlled Live'
  }

  if (['active', 'activating', 'scheduled'].includes(status) && readinessLevel === 'ready') {
    return 'Ready for Controlled Live'
  }

  if (readinessLevel === 'warnings') return 'Ready with Warnings'
  if (readinessLevel === 'ready') return 'Ready for Controlled Live'
  return 'Blocked for Live Transmission'
}

export function operatorStateLabel(state) {
  return OPERATOR_LABELS[state] || OPERATOR_LABELS.draft
}

export function operatorModeLabel(execution = {}) {
  if (execution?.proof_mode || execution?.no_messages_will_transmit) return 'test'
  if (execution?.transmission_enabled && Number(execution?.live_send_rows || 0) > 0) return 'live'
  return 'test'
}

export function primaryCommandForState(operatorState, options = {}) {
  const liveReady = options.liveReady === true
  switch (operatorState) {
    case 'draft':
    case 'building_targets':
      return { action: 'build_targets', label: 'Build Targets' }
    case 'targets_ready':
    case 'needs_configuration':
      return { action: 'schedule', label: 'Schedule' }
    case 'scheduled':
      return { action: 'activate', label: 'Go Live' }
    case 'live':
      return liveReady
        ? { action: 'queue_batch_live', label: 'Prepare Controlled Live Batch' }
        : { action: 'pause', label: 'Pause' }
    case 'test_mode':
      return { action: 'queue_batch_test', label: 'Prepare Test Batch' }
    case 'paused':
      return { action: 'resume', label: 'Resume' }
    case 'blocked':
      return { action: 'review_blockers', label: 'Review Blockers' }
    case 'completed':
      return { action: 'view_results', label: 'View Results' }
    default:
      return { action: 'refresh', label: 'Refresh' }
  }
}