import type { LiveLead } from '../live-dashboard.adapter'
import type { DashboardMapMode } from './types'

export const priorityFromLead = (lead: LiveLead): 'P0' | 'P1' | 'P2' | 'P3' => {
  if (lead.urgencyScore >= 88) return 'P0'
  if (lead.urgencyScore >= 72) return 'P1'
  if (lead.urgencyScore >= 52) return 'P2'
  return 'P3'
}

export const aiScoreFromLead = (lead: LiveLead) =>
  Math.round((lead.urgencyScore * 0.55) + (lead.opportunityScore * 0.45))

export const equityPctFromLead = (lead: LiveLead) => {
  if (lead.estimatedValue <= 0) return 0
  return Math.max(0, Math.min(100, Math.round(((lead.estimatedValue - lead.offerAmount) / lead.estimatedValue) * 100)))
}

export const stageBucketFromLead = (lead: LiveLead): string => {
  if (lead.pipelineStage === 'new') return 'not-contacted'
  if (lead.pipelineStage === 'contacted') return 'contacted'
  if (lead.pipelineStage === 'responding') return 'replied'
  if (lead.pipelineStage === 'negotiating') return 'negotiating'
  if (lead.pipelineStage === 'under-contract') return 'under-contract'
  return 'closing'
}

export const followUpLagMinutesFromLead = (lead: LiveLead): number => {
  const now = Date.now()
  const lastOutbound = Date.parse(lead.lastOutboundIso)
  if (!Number.isFinite(lastOutbound)) return 0
  return Math.max(0, Math.floor((now - lastOutbound) / 60000))
}

export const replyStatusFromLead = (lead: LiveLead): 'replied' | 'awaiting-reply' | 'no-reply' => {
  if (lead.lastInboundIso) return 'replied'
  return lead.outboundAttempts > 0 ? 'awaiting-reply' : 'no-reply'
}

export const followUpStatusFromLead = (lead: LiveLead): 'on-track' | 'due-soon' | 'overdue' | 'stalled' => {
  const lag = followUpLagMinutesFromLead(lead)
  if (lag >= 60 * 48) return 'overdue'
  if (lag >= 60 * 24) return 'due-soon'
  if (lead.outboundAttempts >= 6) return 'stalled'
  return 'on-track'
}

export const distressSignalsFromLead = (lead: LiveLead): string[] => {
  const tags: string[] = []
  if (lead.ownerType === 'tax-delinquent') tags.push('tax-delinquent')
  if (lead.ownerType === 'estate') tags.push('probate')
  if (lead.ownerType === 'absentee') tags.push('absentee-owner')
  if (lead.ownerType === 'corporate') tags.push('tired-landlord')
  if (equityPctFromLead(lead) >= 45) tags.push('high-equity')
  for (const flag of lead.riskFlags) {
    const f = flag.toLowerCase()
    if (f.includes('vacant')) tags.push('vacant')
    if (f.includes('foreclos')) tags.push('pre-foreclosure')
    if (f.includes('code') || f.includes('violation')) tags.push('code-violation')
  }
  return Array.from(new Set(tags))
}

export const distressCountFromLead = (lead: LiveLead): number => distressSignalsFromLead(lead).length

export const contractStatusFromLead = (lead: LiveLead): 'under-contract' | 'negotiating' | 'clear-to-close' | 'none' => {
  if (lead.pipelineStage === 'under-contract') {
    return lead.riskFlags.some((flag) => /clear-to-close|title clear/i.test(flag))
      ? 'clear-to-close'
      : 'under-contract'
  }
  if (lead.pipelineStage === 'negotiating') return 'negotiating'
  return 'none'
}

export const titleStateFromLead = (lead: LiveLead): 'clear' | 'risk' =>
  lead.riskFlags.some((flag) => /title|lien|cloud|probate/i.test(flag)) ? 'risk' : 'clear'

export const buyerDemandScoreFromLead = (lead: LiveLead): number => {
  const momentum = lead.stageMomentum === 'accelerating'
    ? 14
    : lead.stageMomentum === 'stalling'
      ? -8
      : 0
  return Math.max(0, Math.min(100, Math.round(lead.opportunityScore * 0.72 + lead.conversationTemperature * 0.28 + momentum)))
}

export const heatWeightFromLead = (lead: LiveLead, mode: DashboardMapMode): number => {
  const distress = distressCountFromLead(lead)
  const followUpLag = followUpLagMinutesFromLead(lead)
  const aiScore = aiScoreFromLead(lead)

  if (mode === 'heat') {
    return Math.max(1, Math.round((lead.urgencyScore * 0.45) + (aiScore * 0.4) + (distress * 9)))
  }
  if (mode === 'pressure') {
    return Math.max(1, Math.round((followUpLag / 24) + (lead.outboundAttempts * 4) + (replyStatusFromLead(lead) === 'awaiting-reply' ? 16 : 6)))
  }
  if (mode === 'distress') {
    return Math.max(1, Math.round((distress * 20) + (equityPctFromLead(lead) * 0.25)))
  }
  if (mode === 'stage') {
    const stageWeight: Record<string, number> = {
      'not-contacted': 22,
      contacted: 30,
      replied: 46,
      negotiating: 62,
      'under-contract': 76,
      closing: 68,
    }
    return stageWeight[stageBucketFromLead(lead)] ?? 22
  }
  if (mode === 'closings') {
    const contract = contractStatusFromLead(lead)
    return contract === 'clear-to-close' ? 92 : contract === 'under-contract' ? 78 : contract === 'negotiating' ? 54 : 16
  }

  return Math.max(1, Math.round((lead.urgencyScore * 0.58) + (lead.opportunityScore * 0.42)))
}
