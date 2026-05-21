import type { CommandCenterStore } from '../../domain/types'
import { formatCurrency, formatCompactNumber, formatPercent } from '../../shared/formatters'
import { computeAutopilotSummary } from '../../engine/autopilot'
import { computeNBASummary } from '../../engine/nba'
import type { AutopilotSummary } from '../../engine/autopilot'
import type { NBASummary } from '../../engine/nba'

export interface KPIMetric {
  id: string
  label: string
  value: string
  change: string
  changeDirection: 'up' | 'down' | 'flat'
  tone: 'primary' | 'success' | 'warning' | 'danger' | 'muted'
}

export interface MarketRank {
  id: string
  name: string
  label: string
  pipelineValue: number
  pipelineLabel: string
  replyRate: number
  replyLabel: string
  healthScore: number
  campaignStatus: string
  rank: number
}

export interface StatsModel {
  kpis: KPIMetric[]
  marketRankings: MarketRank[]
  totalPipelineValue: string
  totalOutbound: string
  avgReplyRate: string
  avgHealthScore: number
  autopilot: AutopilotSummary
  nba: NBASummary
}

export const adaptStatsModel = (store: CommandCenterStore): StatsModel => {
  const markets = store.marketIds.map((id) => store.marketsById[id]!)
  const properties = store.propertyIds.map((id) => store.propertiesById[id]!)

  const totalPipeline = markets.reduce((s, m) => s + m.pipelineValue, 0)
  const totalOutbound = markets.reduce((s, m) => s + m.outboundToday, 0)
  const totalReplies = markets.reduce((s, m) => s + m.repliesToday, 0)
  const avgReply = markets.length > 0
    ? markets.reduce((s, m) => s + m.replyRate, 0) / markets.length
    : 0
  const avgHealth = markets.length > 0
    ? Math.round(markets.reduce((s, m) => s + m.healthScore, 0) / markets.length)
    : 0
  const totalHotLeads = markets.reduce((s, m) => s + m.hotLeads, 0)
  const avgDeliverability = markets.length > 0
    ? markets.reduce((s, m) => s + m.deliverability, 0) / markets.length
    : 0

  const kpis: KPIMetric[] = [
    { id: 'pipeline', label: 'Total Pipeline', value: formatCurrency(totalPipeline), change: '+8.2%', changeDirection: 'up', tone: 'success' },
    { id: 'outbound', label: 'Outbound Today', value: formatCompactNumber(totalOutbound), change: '+12%', changeDirection: 'up', tone: 'primary' },
    { id: 'replies', label: 'Replies Today', value: formatCompactNumber(totalReplies), change: '+5.6%', changeDirection: 'up', tone: 'success' },
    { id: 'reply-rate', label: 'Avg Reply Rate', value: formatPercent(avgReply / 100), change: '+0.3pp', changeDirection: 'up', tone: 'primary' },
    { id: 'hot-leads', label: 'Hot Leads', value: `${totalHotLeads}`, change: '+4', changeDirection: 'up', tone: 'warning' },
    { id: 'health', label: 'Avg Health', value: `${avgHealth}`, change: 'Stable', changeDirection: 'flat', tone: 'muted' },
    { id: 'deliverability', label: 'Deliverability', value: formatPercent(avgDeliverability / 100), change: '-0.2pp', changeDirection: 'down', tone: 'muted' },
    { id: 'properties', label: 'Active Properties', value: formatCompactNumber(properties.length), change: `${markets.length} markets`, changeDirection: 'flat', tone: 'muted' },
  ]

  const marketRankings: MarketRank[] = markets
    .sort((a, b) => b.pipelineValue - a.pipelineValue)
    .map((m, i) => ({
      id: m.id,
      name: m.name,
      label: m.label,
      pipelineValue: m.pipelineValue,
      pipelineLabel: formatCurrency(m.pipelineValue),
      replyRate: m.replyRate,
      replyLabel: formatPercent(m.replyRate / 100),
      healthScore: m.healthScore,
      campaignStatus: m.campaignStatus,
      rank: i + 1,
    }))

  return {
    kpis,
    marketRankings,
    totalPipelineValue: formatCurrency(totalPipeline),
    totalOutbound: formatCompactNumber(totalOutbound),
    avgReplyRate: formatPercent(avgReply / 100),
    avgHealthScore: avgHealth,
    autopilot: computeAutopilotSummary(store),
    nba: computeNBASummary(store),
  }
}

export const loadStats = async (): Promise<StatsModel> => {
  const { loadCommandCenterStore } = await import('../../domain/normalize-command-center')
  const store = await loadCommandCenterStore()
  return adaptStatsModel(store)
}
