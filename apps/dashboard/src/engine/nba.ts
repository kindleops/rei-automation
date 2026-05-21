import type { CommandCenterStore } from '../domain/types'

// ── Next Best Action Engine ───────────────────────────────────────────────
// Computes the single most impactful action for any entity in the system.

export interface NextBestAction {
  id: string
  entityType: 'lead' | 'market' | 'agent' | 'title'
  entityId: string
  action: string
  reasoning: string
  confidence: number
  urgency: number // 0-100
  impact: 'high' | 'medium' | 'low'
  category: 'follow-up' | 'escalation' | 'close' | 'outreach' | 'review' | 'pause'
}

export interface NBASummary {
  topActions: NextBestAction[]
  totalActionable: number
  highUrgencyCount: number
  avgConfidence: number
}

export const computeNBASummary = (store: CommandCenterStore): NBASummary => {
  const actions: NextBestAction[] = []

  // Lead-level NBAs
  for (const id of store.propertyIds) {
    const lead = store.propertiesById[id]!
    const market = store.marketsById[lead.marketId]

    if (lead.sentiment === 'hot' && lead.pipelineStage === 'negotiating') {
      actions.push({
        id: `nba-lead-${id}`,
        entityType: 'lead',
        entityId: id,
        action: lead.recommendedAction,
        reasoning: `Hot lead in negotiation with ${lead.pipelineDays}d pipeline age. ${lead.stageMomentum === 'accelerating' ? 'Momentum is building.' : 'Needs attention to maintain momentum.'}`,
        confidence: lead.actionConfidence,
        urgency: lead.urgencyScore,
        impact: lead.urgencyScore >= 80 ? 'high' : lead.urgencyScore >= 50 ? 'medium' : 'low',
        category: lead.pipelineStage === 'negotiating' ? 'close' : 'follow-up',
      })
    } else if (lead.stageMomentum === 'stalling') {
      actions.push({
        id: `nba-stall-${id}`,
        entityType: 'lead',
        entityId: id,
        action: lead.recommendedAction,
        reasoning: `Lead momentum stalling after ${lead.pipelineDays} days. ${lead.riskSummary}`,
        confidence: lead.actionConfidence,
        urgency: Math.min(100, lead.urgencyScore + 15),
        impact: 'medium',
        category: 'review',
      })
    } else if (lead.sentiment === 'warm') {
      actions.push({
        id: `nba-warm-${id}`,
        entityType: 'lead',
        entityId: id,
        action: lead.recommendedAction,
        reasoning: `Warm lead with ${lead.heatFactors.length} active heat factors. Opportunity score: ${lead.opportunityScore}.`,
        confidence: lead.actionConfidence,
        urgency: lead.urgencyScore,
        impact: lead.urgencyScore >= 60 ? 'medium' : 'low',
        category: 'follow-up',
      })
    }

    // Market-level NBAs
    if (market && market.operationalRisk === 'elevated') {
      const existing = actions.find((a) => a.entityId === market.id && a.entityType === 'market')
      if (!existing) {
        actions.push({
          id: `nba-market-${market.id}`,
          entityType: 'market',
          entityId: market.id,
          action: `Review ${market.name} operational status — risk is elevated with ${market.capacityStrain}% capacity strain.`,
          reasoning: `Opt-out rate at ${market.optOutRate}% and capacity strain at ${market.capacityStrain}%. Deliverability may be impacted.`,
          confidence: 85,
          urgency: market.capacityStrain,
          impact: 'high',
          category: 'review',
        })
      }
    }
  }

  // Title-level NBAs
  for (const id of store.titleRecordIds) {
    const title = store.titleRecordsById[id]!
    if (title.issues.length > 0 && title.status !== 'closed') {
      actions.push({
        id: `nba-title-${id}`,
        entityType: 'title',
        entityId: id,
        action: `Resolve ${title.issues.length} title issue(s) for ${title.address}`,
        reasoning: `${title.daysInPhase} days in ${title.closingPhase} phase. Issues: ${title.issues.join('; ')}`,
        confidence: 78,
        urgency: Math.min(100, title.daysInPhase * 12),
        impact: title.status === 'issue' ? 'high' : 'medium',
        category: 'review',
      })
    }
  }

  const sorted = actions.sort((a, b) => b.urgency - a.urgency)
  const highUrgency = sorted.filter((a) => a.urgency >= 70)
  const avgConf = sorted.length > 0
    ? Math.round(sorted.reduce((sum, a) => sum + a.confidence, 0) / sorted.length)
    : 0

  return {
    topActions: sorted.slice(0, 8),
    totalActionable: sorted.length,
    highUrgencyCount: highUrgency.length,
    avgConfidence: avgConf,
  }
}
