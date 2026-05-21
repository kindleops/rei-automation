import type { CommandCenterStore } from '../domain/types'

// ── Autopilot Engine ──────────────────────────────────────────────────────
// Computes automated actions from the current store state.
// Each rule evaluates conditions and emits autopilot recommendations.

export interface AutopilotRecommendation {
  id: string
  action: 'escalate' | 'send' | 'pause' | 'match' | 'alert' | 'schedule'
  priority: number // 0-100
  confidence: number
  title: string
  detail: string
  targetLeadId: string | null
  targetMarketId: string
  approved: boolean
}

export interface AutopilotSummary {
  totalActions: number
  pendingApproval: number
  autoApproved: number
  topAction: AutopilotRecommendation | null
  recentActions: AutopilotRecommendation[]
  engineStatus: 'active' | 'paused' | 'learning'
  confidenceAvg: number
}

export const computeAutopilotSummary = (store: CommandCenterStore): AutopilotSummary => {
  const events = store.autopilotEventIds.map((id) => store.autopilotEventsById[id]!)

  const recommendations: AutopilotRecommendation[] = events.map((event) => ({
    id: event.id,
    action: event.action,
    priority: event.confidence,
    confidence: event.confidence,
    title: event.title,
    detail: event.detail,
    targetLeadId: event.leadId,
    targetMarketId: event.marketId,
    approved: event.approved,
  }))

  const sorted = [...recommendations].sort((a, b) => b.priority - a.priority)
  const pending = sorted.filter((r) => !r.approved)
  const approved = sorted.filter((r) => r.approved)
  const avgConfidence = sorted.length > 0
    ? Math.round(sorted.reduce((sum, r) => sum + r.confidence, 0) / sorted.length)
    : 0

  // Derive engine status from alert severity
  const criticalAlerts = store.alertIds
    .map((id) => store.alertsById[id]!)
    .filter((a) => a.severity === 'critical')

  const engineStatus = criticalAlerts.length > 1
    ? 'learning' as const
    : criticalAlerts.length === 1
      ? 'active' as const
      : 'active' as const

  return {
    totalActions: sorted.length,
    pendingApproval: pending.length,
    autoApproved: approved.length,
    topAction: sorted[0] ?? null,
    recentActions: sorted.slice(0, 5),
    engineStatus,
    confidenceAvg: avgConfidence,
  }
}

// ── Hot Lead Escalation Rule ────────────────────────────────────────────
export const detectHotLeadGaps = (store: CommandCenterStore) => {
  const now = Date.now()
  const gaps: Array<{ leadId: string; marketId: string; minutesIdle: number }> = []

  for (const id of store.propertyIds) {
    const lead = store.propertiesById[id]!
    if (lead.sentiment !== 'hot') continue

    const lastContact = lead.lastInboundIso
      ? new Date(lead.lastInboundIso).getTime()
      : new Date(lead.lastOutboundIso).getTime()

    const minutesIdle = Math.round((now - lastContact) / 60_000)

    if (minutesIdle > 15) {
      gaps.push({ leadId: id, marketId: lead.marketId, minutesIdle })
    }
  }

  return gaps.sort((a, b) => b.minutesIdle - a.minutesIdle)
}

// ── Queue Protection Rule ───────────────────────────────────────────────
export const detectQueuePressure = (store: CommandCenterStore) => {
  const pressures: Array<{ marketId: string; strain: number; risk: string }> = []

  for (const id of store.marketIds) {
    const market = store.marketsById[id]!
    if (market.capacityStrain > 75) {
      pressures.push({
        marketId: id,
        strain: market.capacityStrain,
        risk: market.operationalRisk,
      })
    }
  }

  return pressures.sort((a, b) => b.strain - a.strain)
}
