import type { CampaignStatus, CampaignSummary } from './campaigns.types'

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

const PRE_LAUNCH: CampaignStatus[] = ['draft', 'previewed', 'ready', 'built']
const LIVE: CampaignStatus[] = ['active', 'activating', 'live_limited', 'scheduled', 'queued', 'paused']

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
    if (campaign.auto_send_enabled) issues.push('Auto-send must stay disabled in Phase 1')

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
  if (campaign.auto_send_enabled) {
    score -= 15
    issues.push('Auto-send must stay disabled in Phase 1')
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

  if (campaign.total_targets === 0) blockers.push('No target snapshot — run Build Targets')
  if (campaign.ready_targets === 0 && campaign.total_targets > 0) {
    warnings.push('Zero ready targets after build — review exclusions')
  }
  if (campaign.auto_send_enabled) blockers.push('Auto-send is disabled in Phase 1')

  const level: ReadinessLevel =
    blockers.length > 0 ? 'blocked' : warnings.length > 0 ? 'warnings' : 'ready'

  return {
    level,
    label: level === 'ready' ? 'Ready' : level === 'warnings' ? 'Ready with Warnings' : 'Blocked',
    blockers,
    warnings,
  }
}

export function canDeleteDraft(campaign: CampaignSummary): boolean {
  return (
    campaign.status === 'draft' &&
    campaign.sent_count === 0 &&
    campaign.queued_targets === 0 &&
    campaign.scheduled_targets === 0
  )
}

export function canArchiveCampaign(_campaign: CampaignSummary): boolean {
  return true
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
  if (filter === 'ready') return ['ready', 'built', 'previewed'].includes(campaign.status)
  if (filter === 'scheduled') return campaign.status === 'scheduled'
  if (filter === 'live') return ['active', 'activating', 'live_limited', 'queued'].includes(campaign.status)
  if (filter === 'paused') return campaign.status === 'paused'
  if (filter === 'completed') return campaign.status === 'completed'
  if (filter === 'archived') return campaign.status === 'archived'
  if (filter === 'needs_attention') {
    const health = computeCampaignHealth(campaign)
    return health.issues.length > 0 || health.level === 'dangerous' || health.level === 'caution'
  }
  return true
}

export function getAvailableCampaignActions(campaign: CampaignSummary): string[] {
  const actions: string[] = ['open', 'duplicate']
  if (campaign.status === 'active' || campaign.status === 'live_limited') {
    actions.push('pause')
  }
  if (campaign.status === 'paused') actions.push('resume')
  if (['scheduled', 'built', 'ready', 'previewed', 'draft'].includes(campaign.status)) {
    actions.push('schedule', 'reschedule')
  }
  if (['built', 'ready', 'previewed', 'scheduled', 'queued'].includes(campaign.status)) {
    actions.push('activate')
  }
  if (['draft', 'built', 'ready', 'previewed'].includes(campaign.status)) {
    actions.push('build_targets', 'edit')
  }
  if (campaign.ready_targets > 0 && ['built', 'ready', 'scheduled', 'active', 'paused'].includes(campaign.status)) {
    actions.push('queue_batch')
  }
  if (canDeleteDraft(campaign)) actions.push('delete_draft')
  else actions.push('archive')
  if (campaign.status !== 'draft') actions.push('rename')
  return actions
}