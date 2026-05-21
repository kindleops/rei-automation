import type { LiveLead, LiveMarket } from '../live-dashboard.adapter'
import type { ActiveMarketConfig, DashboardMapMode } from './types'
import { heatWeightFromLead } from './lead-intel'

const clamp100 = (value: number) => Math.max(0, Math.min(100, Math.round(value)))

const computeActivityScore = (market: LiveMarket): number => {
  const responseScore = market.replyRate * 0.32
  const conversionSignal = market.positiveRate * 0.24
  const healthSignal = market.healthScore * 0.22
  const pressurePenalty = Math.max(0, market.pendingFollowUps - 20) * 0.45
  return clamp100(responseScore + conversionSignal + healthSignal - pressurePenalty + market.hotLeads * 0.08)
}

const computeMarketIntensity = (
  marketLeads: LiveLead[],
  mode: DashboardMapMode,
): number => {
  if (marketLeads.length === 0) return 0
  const total = marketLeads.reduce((sum, lead) => sum + heatWeightFromLead(lead, mode), 0)
  const avg = total / marketLeads.length
  return clamp100(avg)
}

export const buildActiveMarketConfig = (
  markets: LiveMarket[],
  leads: LiveLead[],
  mode: DashboardMapMode,
): ActiveMarketConfig[] => {
  const marketLeadMap = new Map<string, LiveLead[]>()
  for (const lead of leads) {
    const existing = marketLeadMap.get(lead.marketId)
    if (existing) {
      existing.push(lead)
    } else {
      marketLeadMap.set(lead.marketId, [lead])
    }
  }

  return markets.map((market) => {
    const marketLeads = marketLeadMap.get(market.id) ?? []
    const activityScore = computeActivityScore(market)
    return {
      id: market.id,
      name: market.name,
      state: market.stateCode,
      lat: market.lat,
      lng: market.lng,
      activityScore,
      leadCount: marketLeads.length,
      replyRate: market.replyRate,
      hotLeadCount: marketLeads.filter((lead) => lead.sentiment === 'hot').length,
      pipelineValue: market.pipelineValue,
      operationalStatus: market.campaignStatus,
      activityIntensity: computeMarketIntensity(marketLeads, mode),
    }
  })
}
