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

/**
 * Derive operator lifecycle state from persisted status + execution truth.
 */
export function deriveOperatorState(campaign = {}, execution = {}, readiness = {}) {
  const status = normalizeCampaignStatus(campaign.status || 'draft')
  const proofMode = Boolean(execution?.proof_mode || execution?.no_messages_will_transmit)
  const liveSendRows = Number(execution?.live_send_rows || 0)
  const routingAllowed = Number(execution?.routing_allowed || 0)
  const transmissionEnabled = Boolean(execution?.transmission_enabled)
  const readinessLevel = clean(readiness?.launch_readiness || readiness?.level)
  const hasBlockers = (readiness?.blockers || []).length > 0 || readinessLevel === 'blocked'
  const frozenTargets = Number(campaign.total_targets ?? execution?.frozen_targets ?? 0)
  const building = clean(campaign.metadata?.target_build_status).toLowerCase() === 'building'

  if (status === 'archived') return 'archived'
  if (status === 'completed') return 'completed'
  if (status === 'failed') return 'failed'
  if (building) return 'building_targets'

  if (proofMode && ['active', 'activating', 'paused', 'scheduled'].includes(status)) {
    return 'test_mode'
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
    if (liveSendRows > 0 && transmissionEnabled && routingAllowed > 0) return 'live'
    if (proofMode) return 'test_mode'
    if (hasBlockers || routingAllowed === 0 || !transmissionEnabled) return 'blocked'
    return 'live'
  }

  return status
}

export function operatorStateLabel(state) {
  return OPERATOR_LABELS[state] || OPERATOR_LABELS.draft
}

export function operatorModeLabel(execution = {}) {
  if (execution?.proof_mode || execution?.no_messages_will_transmit) return 'test'
  if (execution?.transmission_enabled && Number(execution?.live_send_rows || 0) > 0) return 'live'
  return 'test'
}

export function primaryCommandForState(operatorState) {
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
      return { action: 'pause', label: 'Pause' }
    case 'test_mode':
      return { action: 'review_blockers', label: 'Review Blockers' }
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