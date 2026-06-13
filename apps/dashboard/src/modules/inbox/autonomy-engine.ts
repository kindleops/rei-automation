import type { InboxActivityEvent } from '../../lib/data/inboxActivityData'
import type { QueueModel } from '../../lib/data/queueData'
import type { SmsTemplate } from '../../lib/data/templateData'
import type { InboxWorkflowThread } from '../../lib/data/inboxWorkflowData'
import type { ThreadCommandIntel } from './ai-command-center'

export interface AutonomyControlState {
  autonomousMode: 'active' | 'approval_required' | 'paused' | 'emergency_stop'
  dryRun: boolean
  requireNegotiationApproval: boolean
  requireHumanReviewForHighRisk: boolean
  marketThrottleMode: 'balanced' | 'aggressive' | 'safe'
}

export interface AutonomyDirective {
  id: string
  label: string
  detail: string
  tone: 'default' | 'accent' | 'success' | 'warning' | 'danger'
}

export interface MarketAutonomySnapshot {
  market: string
  threadCount: number
  hotLeadCount: number
  responseRate: number
  optOutRisk: number
  closeMomentum: number
  saturationRisk: number
}

export interface TemplateOptimizationSnapshot {
  useCase: string
  total: number
  active: number
  winnerScore: number
  action: 'promote' | 'watch' | 'suppress'
}

import type { AutoReplyResult } from '../../lib/data/inboxAutoReply'

const DEV = Boolean(import.meta.env.DEV)

export interface AutonomousEngineModel {
  controls: AutonomyControlState
  autonomyCoverage: number
  humanReviewLoad: number
  queueRiskScore: number
  complianceRiskScore: number
  underwritingReadiness: number
  dispositionReadiness: number
  marketBreadth: number
  emergencyState: boolean
  topDirective: string
  globalDirectives: AutonomyDirective[]
  marketSnapshots: MarketAutonomySnapshot[]
  templateOptimization: TemplateOptimizationSnapshot[]
  routeSummary: {
    autonomous: number
    humanReview: number
    suppress: number
    dispoPriority: number
  }
}

/**
 * Runs a full autonomous cycle: finds eligible threads and queues auto-replies.
 */
export const runAutonomousCycle = async (
  _threads: InboxWorkflowThread[],
  _controls: AutonomyControlState
): Promise<AutoReplyResult[]> => {
  if (DEV) console.log(`[AutonomyEngine] Cycle requested. Bypassed: backend queue processor is canonical.`)
  // Backend queue processor is canonical. 
  // Client-side runAutonomousCycle is disabled and acts only as a display-only model.
  return []
}

export const defaultAutonomyControlState: AutonomyControlState = {
  autonomousMode: 'active',
  dryRun: false,
  requireNegotiationApproval: true,
  requireHumanReviewForHighRisk: true,
  marketThrottleMode: 'balanced',
}

const clamp = (value: number, min = 0, max = 100): number => Math.max(min, Math.min(max, value))
const average = (values: number[]): number => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
const safeLabel = (value: unknown, fallback = 'Unknown'): string => {
  const text = String(value ?? '').trim()
  return text || fallback
}

export const buildAutonomousEngineModel = ({
  threads,
  threadIntel,
  queueModel,
  templates,
  activities,
  controls,
}: {
  threads: InboxWorkflowThread[]
  threadIntel: ThreadCommandIntel[]
  queueModel: QueueModel | null
  templates: SmsTemplate[]
  activities: InboxActivityEvent[]
  controls: AutonomyControlState
}): AutonomousEngineModel => {
  const totalThreads = Math.max(threads.length, 1)
  const autonomous = threads.filter((thread) => (
    thread.automationState === 'active' &&
    !thread.isSuppressed &&
    !thread.isOptOut &&
    thread.inboxStatus !== 'needs_review'
  )).length
  const humanReview = threads.filter((thread) => (
    thread.inboxStatus === 'needs_review' ||
    thread.automationState === 'manual_control'
  )).length
  const suppressed = threads.filter((thread) => thread.isSuppressed || thread.isOptOut || thread.inboxStatus === 'suppressed').length
  const dispoPriority = threads.filter((thread) => {
    const score = Number(thread.finalAcquisitionScore ?? thread.motivationScore ?? 0)
    return score >= 70 && thread.conversationStage === 'contract_path'
  }).length

  const autonomyCoverage = clamp((autonomous / totalThreads) * 100)
  const humanReviewLoad = clamp((humanReview / totalThreads) * 100)

  const queueRiskScore = clamp(
    (queueModel?.optOutRiskCount ?? 0) * 8 +
      (queueModel?.failedCount ?? 0) * 4 +
      (queueModel?.retryCount ?? 0) * 5 +
      ((queueModel?.apiPressureLevel ?? 'low') === 'high' ? 28 : (queueModel?.apiPressureLevel ?? 'low') === 'medium' ? 14 : 4),
  )

  const complianceSignals = threadIntel.map((item) => Math.max(item.dncRisk, item.hostilityRisk))
  const complianceRiskScore = clamp(average(complianceSignals) + (queueModel?.optOutRiskCount ?? 0) * 4)
  const underwritingReadiness = clamp(average(threadIntel.map((item) => item.underwritingConfidence)))
  const dispositionReadiness = clamp(average(threadIntel.map((item) => (item.closeProbability * 0.55) + ((item.estimatedDealValue ? 72 : 40) * 0.2) + ((100 - item.acquisitionComplexity) * 0.25))))

  const markets = new Map<string, InboxWorkflowThread[]>()
  for (const thread of threads) {
    const market = safeLabel(thread.market || thread.marketId, 'Unknown')
    const current = markets.get(market) ?? []
    current.push(thread)
    markets.set(market, current)
  }

  const marketSnapshots: MarketAutonomySnapshot[] = Array.from(markets.entries()).map(([market, marketThreads]) => {
    const responseRate = clamp((marketThreads.filter((thread) => Boolean(thread.lastInboundAt)).length / Math.max(marketThreads.length, 1)) * 100)
    const hotLeadCount = marketThreads.filter((thread) => Number(thread.finalAcquisitionScore ?? thread.motivationScore ?? 0) >= 70).length
    const optOutRisk = clamp((marketThreads.filter((thread) => thread.isSuppressed || thread.isOptOut).length / Math.max(marketThreads.length, 1)) * 100)
    const closeMomentum = clamp(average(marketThreads.map((thread) => Number(thread.finalAcquisitionScore ?? thread.motivationScore ?? 0))))
    const saturationRisk = clamp((marketThreads.length >= 30 ? 35 : marketThreads.length >= 15 ? 20 : 8) + optOutRisk * 0.25 + ((queueModel?.apiPressureLevel ?? 'low') === 'high' ? 10 : 0))
    return {
      market,
      threadCount: marketThreads.length,
      hotLeadCount,
      responseRate,
      optOutRisk,
      closeMomentum,
      saturationRisk,
    }
  }).sort((a, b) => b.hotLeadCount - a.hotLeadCount || b.threadCount - a.threadCount).slice(0, 6)

  const templateGroups = new Map<string, SmsTemplate[]>()
  for (const template of templates) {
    const key = template.useCaseSlug || template.useCase
    const current = templateGroups.get(key) ?? []
    current.push(template)
    templateGroups.set(key, current)
  }

  const templateOptimization: TemplateOptimizationSnapshot[] = Array.from(templateGroups.entries()).map(([useCase, items]) => {
    const active = items.filter((item) => item.active).length
    const multilingualBonus = new Set(items.map((item) => item.language.toLowerCase())).size >= 2 ? 12 : 0
    const firstTouchBonus = items.some((item) => item.isFirstTouch) ? 8 : 0
    const followupCoverage = items.some((item) => item.isFollowUp) ? 8 : 0
    const winnerScore = clamp((active / Math.max(items.length, 1)) * 45 + multilingualBonus + firstTouchBonus + followupCoverage)
    const action: TemplateOptimizationSnapshot['action'] =
      winnerScore >= 70 ? 'promote' : winnerScore >= 45 ? 'watch' : 'suppress'
    return {
      useCase: safeLabel(useCase),
      total: items.length,
      active,
      winnerScore,
      action,
    }
  }).sort((a, b) => b.winnerScore - a.winnerScore).slice(0, 6)

  const recentCriticalActivity = activities
    .filter((event) => ['message_failed', 'ai_copilot_interaction'].includes(event.event_type) || String(event.title).toLowerCase().includes('fail'))
    .length

  const emergencyState = controls.autonomousMode === 'emergency_stop'
    || queueRiskScore >= 82
    || complianceRiskScore >= 78
    || recentCriticalActivity >= 6

  const globalDirectives: AutonomyDirective[] = [
    emergencyState
      ? {
          id: 'emergency',
          label: 'Emergency intervention',
          detail: 'Automation should remain halted until queue/compliance pressure returns to a safe band.',
          tone: 'danger',
        }
      : {
          id: 'autonomy',
          label: 'Autonomous coverage',
          detail: `${autonomyCoverage}% of active leads are eligible for autonomous handling.`,
          tone: autonomyCoverage >= 65 ? 'success' : autonomyCoverage >= 45 ? 'accent' : 'warning',
        },
    {
      id: 'review',
      label: 'Human escalation load',
      detail: `${humanReview} threads currently need human review or negotiation oversight.`,
      tone: humanReviewLoad >= 35 ? 'warning' : 'default',
    },
    {
      id: 'market',
      label: 'Market optimization',
      detail: marketSnapshots[0]
        ? `${marketSnapshots[0].market} leads the network with ${marketSnapshots[0].hotLeadCount} hot opportunities.`
        : 'No market leadership signal available yet.',
      tone: 'accent',
    },
    {
      id: 'templates',
      label: 'Template optimization',
      detail: templateOptimization[0]
        ? `${templateOptimization[0].useCase} is the current top-performing template lane.`
        : 'Template inventory not loaded yet.',
      tone: 'default',
    },
  ]

  const topDirective = emergencyState
    ? 'System is in protective posture. Pause autonomous sends and resolve risk pressure.'
    : complianceRiskScore >= 65
      ? 'Compliance pressure is rising. Shift to safer follow-up cadences and manual review for high-risk threads.'
      : autonomyCoverage < 55
        ? 'Expand autonomous routing carefully by reducing manual-review debt and improving underwriting completeness.'
        : 'Autonomous acquisition network is stable. Prioritize hot leads, disposition-ready deals, and market winner promotion.'

  return {
    controls,
    autonomyCoverage,
    humanReviewLoad,
    queueRiskScore,
    complianceRiskScore,
    underwritingReadiness,
    dispositionReadiness,
    marketBreadth: markets.size,
    emergencyState,
    topDirective,
    globalDirectives,
    marketSnapshots,
    templateOptimization,
    routeSummary: {
      autonomous,
      humanReview,
      suppress: suppressed,
      dispoPriority,
    },
  }
}
