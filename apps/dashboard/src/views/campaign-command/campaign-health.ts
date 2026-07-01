import type { CampaignStatus, CampaignSummary } from './campaigns.types'
import { resolveOperatorState } from './campaign-operator'

export type HealthLevel = 'healthy' | 'caution' | 'dangerous' | 'not_started' | 'awaiting'

export type CampaignHealth = {
  level: HealthLevel
  score: number | null
  label: string
  issues: string[]
  sampleSufficient: boolean
}

export type ReadinessLevel = 'ready' | 'warnings' | 'blocked'

export type CampaignReadiness = {
  level: ReadinessLevel
  label: string
  blockers: string[]
  warnings: string[]
}

export type CampaignActionDef = {
  id: string
  label: string
  variant?: string
  icon?: string
}

const PRE_LAUNCH: CampaignStatus[] = ['draft', 'previewed', 'ready', 'built']
const LIVE: CampaignStatus[] = ['active', 'activating', 'live_limited', 'scheduled', 'queued', 'paused']

const READY_STATUSES: CampaignStatus[] = ['ready', 'built', 'previewed']

export function hasExecutionSample(campaign: CampaignSummary): boolean {
  return campaign.sent_count >= 10
}

export function getLifecycleHealthLabel(campaign: CampaignSummary): string {
  if (campaign.sent_count === 0) {
    if (PRE_LAUNCH.includes(campaign.status)) return 'Not Started'
    if (campaign.status === 'scheduled') return 'Awaiting Activation'
    if (['active', 'activating', 'queued'].includes(campaign.status)) return 'Awaiting First Send'
    if (campaign.status === 'paused' && campaign.queued_targets + campaign.scheduled_targets > 0) {
      return 'Awaiting First Send'
    }
    return 'Not Started'
  }
  if (!hasExecutionSample(campaign)) return 'Insufficient Sample'
  return 'Operational'
}

export function computeCampaignHealth(campaign: CampaignSummary): CampaignHealth {
  const lifecycleLabel = getLifecycleHealthLabel(campaign)
  const sampleSufficient = hasExecutionSample(campaign)

  if (!sampleSufficient) {
    const issues: string[] = []
    if (campaign.ready_targets === 0 && LIVE.includes(campaign.status)) {
      issues.push('No ready targets — build or refresh target list')
    }
    const productionLive = Boolean(campaign.execution_proof?.transmission_enabled) && campaign.auto_send_enabled
    if (campaign.auto_send_enabled && !productionLive) {
      issues.push('Auto-send enabled but live transmission not fully configured')
    }

    return {
      level: campaign.sent_count === 0 ? 'not_started' : 'awaiting',
      score: null,
      label: lifecycleLabel,
      issues,
      sampleSufficient: false,
    }
  }

  const issues: string[] = []
  let score = 100

  if (campaign.delivery_rate < 90) {
    score -= 15
    if (campaign.delivery_rate < 75) {
      score -= 15
      issues.push(`Delivery rate ${campaign.delivery_rate.toFixed(1)}% is critically low`)
    } else {
      issues.push(`Delivery rate ${campaign.delivery_rate.toFixed(1)}% needs attention`)
    }
  }
  if (campaign.opt_out_rate > 3) {
    score -= 10
    if (campaign.opt_out_rate > 6) {
      score -= 15
      issues.push(`Opt-out rate ${campaign.opt_out_rate.toFixed(1)}% exceeds safe threshold`)
    } else {
      issues.push(`Opt-out rate ${campaign.opt_out_rate.toFixed(1)}% is elevated`)
    }
  }
  if (campaign.failed_count > 20) {
    score -= 10
    issues.push(`${campaign.failed_count} failed sends detected`)
  }
  if (campaign.reply_rate < 5) {
    score -= 5
    issues.push(`Reply rate ${campaign.reply_rate.toFixed(1)}% is below target`)
  }
  const productionLive = Boolean(campaign.execution_proof?.transmission_enabled) && campaign.auto_send_enabled
  if (campaign.auto_send_enabled && !productionLive) {
    score -= 15
    issues.push('Auto-send enabled but live transmission not fully configured')
  }
  if (campaign.ready_targets === 0 && LIVE.includes(campaign.status)) {
    score -= 10
    issues.push('No ready targets — build or refresh target list')
  }

  const level: HealthLevel =
    score >= 80 ? 'healthy' : score >= 55 ? 'caution' : 'dangerous'

  return {
    level,
    score: Math.max(0, score),
    label: level === 'healthy' ? 'Healthy' : level === 'caution' ? 'Caution' : 'Critical',
    issues,
    sampleSufficient: true,
  }
}

export function computeCampaignReadiness(campaign: CampaignSummary): CampaignReadiness {
  const blockers: string[] = []
  const warnings: string[] = []
  const proof = campaign.execution_proof
  const operatorState = resolveOperatorState(campaign)

  if (operatorState === 'test_mode') {
    return {
      level: 'blocked',
      label: campaign.readiness_label ?? 'Ready for Test Hydration',
      blockers: ['TEST MODE — NO MESSAGES WILL TRANSMIT'],
      warnings: [],
    }
  }

  if (operatorState === 'completed') {
    return { level: 'ready', label: 'Completed', blockers: [], warnings: [] }
  }

  if (campaign.launch_readiness === 'blocked') {
    return {
      level: 'blocked',
      label: 'Blocked',
      blockers: campaign.launch_blockers?.length
        ? [...campaign.launch_blockers]
        : ['Launch blocked — resolve backend blockers'],
      warnings: [],
    }
  }

  if (proof && (proof.routing_allowed ?? 0) === 0 && ['active', 'activating', 'scheduled'].includes(campaign.status)) {
    blockers.push('No routable recipients — sender routing unavailable')
  }

  if (proof && !proof.transmission_enabled && ['active', 'activating'].includes(campaign.status)) {
    blockers.push('Sending is disabled for this campaign')
  }

  if (campaign.launch_readiness === 'warnings') {
    warnings.push('Partial template or routing resolution — review before live send')
  }

  if (campaign.total_targets === 0) blockers.push('No frozen targets — run Build Targets')
  if (campaign.ready_targets === 0 && campaign.total_targets > 0) {
    warnings.push('Zero ready targets after build — review exclusions')
  }
  if (campaign.launch_blocker_codes?.includes('template_required')) {
    blockers.push('Approved template required for campaign stage/language')
  }

  const level: ReadinessLevel =
    blockers.length > 0 ? 'blocked' : warnings.length > 0 ? 'warnings' : 'ready'

  const derivedLabel = campaign.readiness_label
    ?? (level === 'ready' ? 'Ready for Controlled Live' : level === 'warnings' ? 'Ready with Warnings' : 'Blocked for Live Transmission')

  return {
    level,
    label: derivedLabel,
    blockers,
    warnings,
  }
}

function isTestOrMockCampaign(campaign: CampaignSummary): boolean {
  const name = campaign.campaign_name.toLowerCase()
  return (
    name.includes('proof ') ||
    name.startsWith('proof') ||
    name.includes('test campaign') ||
    name === 'test' ||
    name.includes('activate test')
  )
}

export function canDeleteDraft(campaign: CampaignSummary): boolean {
  if (isTestOrMockCampaign(campaign)) return true
  return (
    campaign.status === 'draft' &&
    campaign.sent_count === 0 &&
    campaign.queued_targets === 0 &&
    campaign.scheduled_targets === 0
  )
}

export function canForceDeleteCampaign(campaign: CampaignSummary): boolean {
  return isTestOrMockCampaign(campaign) || (
    ['draft', 'archived', 'built', 'previewed'].includes(campaign.status) &&
    campaign.sent_count === 0
  )
}

export function canArchiveCampaign(campaign: CampaignSummary): boolean {
  if (campaign.status === 'archived') return false
  if (campaign.status === 'active' || campaign.status === 'live_limited') {
    return campaign.ready_targets === 0
  }
  return true
}

export function canQueueBatch(campaign: CampaignSummary): boolean {
  if (!['active', 'live_limited', 'queued', 'scheduled', 'built', 'ready', 'previewed'].includes(campaign.status)) {
    return false
  }
  if (campaign.ready_targets <= 0) return false
  const health = computeCampaignHealth(campaign)
  return health.level !== 'dangerous'
}

export function getPrimaryAction(campaign: CampaignSummary): CampaignActionDef {
  const operatorState = resolveOperatorState(campaign)
  if (operatorState === 'test_mode') {
    return { id: 'convert_to_live', label: 'Convert to Live Campaign', variant: 'is-primary' }
  }
  if (operatorState === 'live' && campaign.readiness_label === 'Ready for Controlled Live') {
    return { id: 'queue_batch_live', label: 'Prepare Controlled Live Batch', variant: 'is-primary' }
  }
  if (operatorState === 'blocked') {
    return { id: 'review_blockers', label: 'Review Blockers', variant: 'is-warn' }
  }

  switch (campaign.status) {
    case 'draft':
      if (campaign.total_targets === 0) {
        return { id: 'build_targets', label: 'Build Targets', variant: 'is-blue' }
      }
      return { id: 'build_targets', label: 'Build Targets', variant: 'is-blue' }
    case 'built':
    case 'ready':
    case 'previewed':
      return { id: 'activate', label: 'Activate', variant: 'is-primary' }
    case 'scheduled':
      return { id: 'activate', label: 'Activate Now', variant: 'is-primary' }
    case 'active':
    case 'live_limited':
      return { id: 'queue_batch_live', label: 'Prepare Controlled Live Batch', variant: 'is-primary' }
    case 'paused':
      return { id: 'resume', label: 'Resume', variant: 'is-primary' }
    case 'completed':
      return { id: 'archive', label: 'Archive', variant: '' }
    case 'archived':
      return { id: 'restore', label: 'Restore', variant: 'is-primary' }
    default:
      return { id: 'open', label: 'Open', variant: '' }
  }
}

export function getDetailActions(campaign: CampaignSummary): CampaignActionDef[] {
  const actions: CampaignActionDef[] = []
  const operatorState = resolveOperatorState(campaign)

  if (operatorState === 'test_mode') {
    actions.push({ id: 'convert_to_live', label: 'Convert to Live Campaign', variant: 'is-primary' })
  }

  switch (campaign.status) {
    case 'draft':
      actions.push(
        { id: 'build_targets', label: 'Build Targets', variant: 'is-blue' },
        { id: 'archive', label: 'Archive', variant: '' },
      )
      break
    case 'built':
    case 'ready':
    case 'previewed':
      actions.push(
        { id: 'schedule', label: 'Schedule', variant: 'is-blue' },
        { id: 'activate', label: 'Activate', variant: 'is-primary' },
        { id: 'archive', label: 'Archive', variant: '' },
      )
      break
    case 'scheduled':
      actions.push(
        { id: 'reschedule', label: 'Reschedule', variant: 'is-blue' },
        { id: 'activate', label: 'Activate Now', variant: 'is-primary' },
        { id: 'pause', label: 'Pause', variant: '' },
        { id: 'archive', label: 'Archive', variant: '' },
      )
      break
    case 'active':
    case 'live_limited':
      if (canQueueBatch(campaign) && resolveOperatorState(campaign) !== 'test_mode') {
        actions.push({ id: 'queue_batch', label: 'Prepare Next Batch', variant: 'is-blue' })
      }
      actions.push({ id: 'pause', label: 'Pause', variant: 'is-danger' })
      if (canArchiveCampaign(campaign)) {
        actions.push({ id: 'archive', label: 'Archive', variant: '' })
      }
      break
    case 'paused':
      actions.push(
        { id: 'resume', label: 'Resume', variant: 'is-primary' },
        { id: 'reschedule', label: 'Reschedule', variant: 'is-blue' },
        { id: 'archive', label: 'Archive', variant: '' },
      )
      break
    case 'completed':
      actions.push(
        { id: 'duplicate', label: 'Duplicate', variant: '' },
        { id: 'archive', label: 'Archive', variant: '' },
      )
      break
    case 'archived':
      actions.push(
        { id: 'restore', label: 'Restore', variant: 'is-primary' },
        { id: 'duplicate', label: 'Duplicate', variant: '' },
      )
      break
    default:
      break
  }

  return actions
}

/** Overflow menu — lifecycle-neutral utilities only; never Activate/Queue on archived. */
export function getAvailableCampaignActions(campaign: CampaignSummary): string[] {
  const actions: string[] = ['open']

  if (campaign.status !== 'archived') {
    actions.push('rename')
  }

  actions.push('duplicate')

  if (campaign.status === 'archived') {
    actions.push('restore')
    return actions
  }

  if (canDeleteDraft(campaign)) {
    actions.push(isTestOrMockCampaign(campaign) ? 'delete' : 'delete_draft')
  }

  if (canArchiveCampaign(campaign)) {
    actions.push('archive')
  }

  return actions
}

export type CampaignListFilter =
  | 'all'
  | 'draft'
  | 'ready'
  | 'scheduled'
  | 'live'
  | 'paused'
  | 'completed'
  | 'archived'
  | 'needs_attention'

export function matchesListFilter(campaign: CampaignSummary, filter: CampaignListFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'draft') return campaign.status === 'draft'
  if (filter === 'ready') return READY_STATUSES.includes(campaign.status)
  if (filter === 'scheduled') return campaign.status === 'scheduled'
  if (filter === 'live') {
    return ['active', 'activating', 'live_limited', 'queued', 'scheduled', 'paused'].includes(campaign.status)
      || resolveOperatorState(campaign) === 'test_mode'
  }
  if (filter === 'paused') return campaign.status === 'paused'
  if (filter === 'completed') return campaign.status === 'completed'
  if (filter === 'archived') return campaign.status === 'archived'
  if (filter === 'needs_attention') {
    const health = computeCampaignHealth(campaign)
    return health.issues.length > 0 || health.level === 'dangerous' || health.level === 'caution'
  }
  return true
}