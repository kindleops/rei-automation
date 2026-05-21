import type { CommandCenterStore } from '../../domain/types'
import { formatCurrency, formatPercent, formatRelativeTime } from '../../shared/formatters'

export interface ActiveMarket {
  id: string
  name: string
  label: string
  stateCode: string
  heat: 'hot' | 'warm' | 'steady'
  campaignStatus: 'live' | 'warning' | 'paused'
  scanLabel: string
  activeProperties: number
  outboundToday: number
  repliesToday: number
  hotLeads: number
  pipelineValue: number
  pipelineLabel: string
  replyRate: number
  replyLabel: string
  optOutRate: number
  healthScore: number
  operationalRisk: string
  capacityStrain: number
  leadCount: number
  agentCount: number
  alertCount: number
  lastSweepLabel: string
  hourlyOutbound: number[]
  topZips: Array<{ zip: string; outbound: number; trend: string }>
}

export interface MarketsModel {
  markets: ActiveMarket[]
  totalPipeline: string
  avgHealth: number
  liveCount: number
  pausedCount: number
}

export const adaptMarketsModel = (store: CommandCenterStore): MarketsModel => {
  const markets: ActiveMarket[] = store.marketIds.map((id) => {
    const raw = store.marketsById[id]!
    const leads = store.propertyIdsByMarketId[id] ?? []
    const agents = store.agentIds.filter((aid) => store.agentsById[aid]!.marketId === id)
    const alerts = store.alertIdsByMarketId[id] ?? []

    return {
      id: raw.id,
      name: raw.name,
      label: raw.label,
      stateCode: raw.stateCode,
      heat: raw.heat,
      campaignStatus: raw.campaignStatus,
      scanLabel: raw.scanLabel,
      activeProperties: raw.activeProperties,
      outboundToday: raw.outboundToday,
      repliesToday: raw.repliesToday,
      hotLeads: raw.hotLeads,
      pipelineValue: raw.pipelineValue,
      pipelineLabel: formatCurrency(raw.pipelineValue),
      replyRate: raw.replyRate,
      replyLabel: formatPercent(raw.replyRate / 100),
      optOutRate: raw.optOutRate,
      healthScore: raw.healthScore,
      operationalRisk: raw.operationalRisk,
      capacityStrain: raw.capacityStrain,
      leadCount: leads.length,
      agentCount: agents.length,
      alertCount: alerts.length,
      lastSweepLabel: formatRelativeTime(raw.lastSweepIso),
      hourlyOutbound: raw.hourlyOutbound,
      topZips: raw.topZips,
    }
  })

  markets.sort((a, b) => b.pipelineValue - a.pipelineValue)

  const totalPipeline = markets.reduce((s, m) => s + m.pipelineValue, 0)
  const avgHealth = markets.length > 0
    ? Math.round(markets.reduce((s, m) => s + m.healthScore, 0) / markets.length)
    : 0

  return {
    markets,
    totalPipeline: formatCurrency(totalPipeline),
    avgHealth,
    liveCount: markets.filter((m) => m.campaignStatus === 'live').length,
    pausedCount: markets.filter((m) => m.campaignStatus === 'paused').length,
  }
}

export const loadMarkets = async (): Promise<MarketsModel> => {
  const { loadCommandCenterStore } = await import('../../domain/normalize-command-center')
  const store = await loadCommandCenterStore()
  return adaptMarketsModel(store)
}
