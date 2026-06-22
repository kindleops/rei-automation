import type { CampaignSummary } from './campaigns.types'

export type OperatorState =
  | 'draft'
  | 'building_targets'
  | 'targets_ready'
  | 'needs_configuration'
  | 'scheduled'
  | 'live'
  | 'test_mode'
  | 'paused'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'archived'

const STATE_LABELS: Record<OperatorState, string> = {
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
}

const PERSISTED_TO_OPERATOR: Record<string, OperatorState> = {
  draft: 'draft',
  built: 'targets_ready',
  ready: 'targets_ready',
  previewed: 'targets_ready',
  queued: 'targets_ready',
  scheduled: 'scheduled',
  activating: 'live',
  active: 'live',
  live_limited: 'live',
  paused: 'paused',
  completed: 'completed',
  failed: 'failed',
  archived: 'archived',
}

export function resolveOperatorState(campaign: CampaignSummary): OperatorState {
  const explicit = (campaign as CampaignSummary & { operator_state?: string }).operator_state
  if (explicit && explicit in STATE_LABELS) return explicit as OperatorState

  const proof = campaign.execution_proof
  if (proof?.proof_mode || proof?.no_messages_will_transmit) return 'test_mode'
  if (campaign.launch_readiness === 'blocked') return 'blocked'

  return PERSISTED_TO_OPERATOR[campaign.status] ?? 'draft'
}

export function operatorStateLabel(campaign: CampaignSummary): string {
  const state = resolveOperatorState(campaign)
  return (campaign as CampaignSummary & { operator_state_label?: string }).operator_state_label
    ?? STATE_LABELS[state]
    ?? state
}

export function operatorModeLabel(campaign: CampaignSummary): 'Live' | 'Test Mode' {
  const mode = (campaign as CampaignSummary & { mode_label?: string }).mode_label
  if (mode) return mode as 'Live' | 'Test Mode'
  const proof = campaign.execution_proof
  if (proof?.proof_mode || proof?.no_messages_will_transmit) return 'Test Mode'
  if (proof?.transmission_enabled && (proof.live_send_rows ?? 0) > 0) return 'Live'
  return 'Test Mode'
}

export const ACTION_LABELS: Record<string, string> = {
  queue_batch: 'Prepare Next Batch',
  queue_batch_loading: 'Preparing batch…',
  pause: 'Pause',
  pause_loading: 'Pausing…',
  resume: 'Resume',
  resume_loading: 'Resuming…',
  schedule: 'Schedule',
  schedule_loading: 'Scheduling…',
  activate: 'Go Live',
  activate_loading: 'Activating…',
  refresh: 'Refresh',
  refresh_loading: 'Refreshing…',
  build_targets: 'Build Targets',
  build_targets_loading: 'Building targets…',
}

export function actionInFlightLabel(action: string): string {
  return ACTION_LABELS[`${action}_loading`] ?? `${action}…`
}