/**
 * Canonical campaign execution modes — shared across launch, feeder, processor, recovery.
 */

import { isCampaignProductionLaunch } from '@/lib/domain/campaigns/campaign-live-execution.js'
import { normalizeCampaignStatus } from '@/lib/domain/campaigns/campaign-state-machine.js'

export const EXECUTION_MODES = Object.freeze({
  proof: 'proof',
  scheduled_live: 'scheduled_live',
  immediate_live: 'immediate_live',
})

export const LIVE_LAUNCH_MODE = 'guarded_live_queue_creation'
export const PROOF_LAUNCH_MODE = 'proof_hydration_no_send'

function clean(value) {
  return String(value ?? '').trim()
}

function metadataObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export function resolveCampaignExecutionMode(campaign = {}, input = {}) {
  const explicit = clean(input.execution_mode || input.executionMode || campaign.metadata?.execution_mode)
  if (explicit && EXECUTION_MODES[explicit]) return explicit

  const proofRequested =
    input.proof_hydration === true ||
    input.proofHydration === true ||
    input.preview_mode === true ||
    input.previewMode === true ||
    (input.no_send === true || input.noSend === true) &&
      input.confirm_live !== true &&
      input.confirmLive !== true

  if (proofRequested) return EXECUTION_MODES.proof

  const scheduledActivation =
    input.scheduled_activation === true ||
    input.scheduledActivation === true ||
    Boolean(campaign.scheduled_for && new Date(campaign.scheduled_for).getTime() > Date.now())

  if (scheduledActivation && isCampaignProductionLaunch(campaign)) {
    return EXECUTION_MODES.scheduled_live
  }

  const status = normalizeCampaignStatus(campaign.status)
  if (['active', 'activating'].includes(status) && isCampaignProductionLaunch(campaign)) {
    return EXECUTION_MODES.immediate_live
  }

  return EXECUTION_MODES.proof
}

export function buildExecutionModeMetadata(campaign = {}, input = {}, base = {}) {
  const mode = resolveCampaignExecutionMode(campaign, input)
  const isProof = mode === EXECUTION_MODES.proof
  return {
    ...metadataObject(base),
    execution_mode: mode,
    launch_mode: isProof ? PROOF_LAUNCH_MODE : LIVE_LAUNCH_MODE,
    no_send: isProof,
    proof_hydration: isProof,
    proof_no_send: isProof,
    confirm_live: !isProof,
    dry_run: input.dry_run === true || input.dryRun === true,
  }
}

export function validateQueueRowAgainstExecutionMode(row = {}, expectedMode = null) {
  const metadata = metadataObject(row.metadata)
  const mode = clean(metadata.execution_mode) || (
    metadata.no_send === true || metadata.proof_hydration === true || metadata.proof_no_send === true
      ? EXECUTION_MODES.proof
      : EXECUTION_MODES.immediate_live
  )

  if (expectedMode === EXECUTION_MODES.proof) {
    if (metadata.confirm_live === true && metadata.no_send !== true) {
      return { ok: false, reason: 'proof_row_contains_live_flags' }
    }
    return { ok: true, mode }
  }

  if (
    expectedMode === EXECUTION_MODES.immediate_live ||
    expectedMode === EXECUTION_MODES.scheduled_live
  ) {
    if (metadata.no_send === true || metadata.proof_hydration === true || metadata.proof_no_send === true) {
      return { ok: false, reason: 'live_row_contains_proof_flags' }
    }
    if (metadata.confirm_live === false) {
      return { ok: false, reason: 'live_row_missing_confirm_live' }
    }
    return { ok: true, mode }
  }

  return { ok: true, mode }
}

export function isProofQueueExecutionRow(row = {}) {
  const metadata = metadataObject(row.metadata)
  return Boolean(
    metadata.execution_mode === EXECUTION_MODES.proof ||
    metadata.no_send === true ||
    metadata.proof_no_send === true ||
    metadata.proof_hydration === true ||
    clean(metadata.launch_mode) === PROOF_LAUNCH_MODE
  )
}