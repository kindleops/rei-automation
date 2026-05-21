import type { CommandCenterStore, OwnerType, PipelineStage, PropertyType, Sentiment, OperationalRisk, AlertPriority, StageMomentum } from '../../../domain/types'

export interface SystemHealthItem {
  id: string
  label: string
  status: 'healthy' | 'warning' | 'degraded' | 'critical'
  value?: string
  detail?: string
}

export interface FilterOption {
  value: string
  label: string
}

export interface SummaryMetric {
  id: string
  label: string
  value: string
  tone: 'primary' | 'success' | 'warning' | 'muted'
  detail: string
}

export interface LiveMarket {
  id: string
  slug: string
  name: string
  stateCode: string
  label: string
  lat: number
  lng: number
  heat: 'hot' | 'warm' | 'steady'
  campaignStatus: 'live' | 'warning' | 'paused'
  scanLabel: string
  activeProperties: number
  outboundToday: number
  repliesToday: number
  hotLeads: number
  pipelineValue: number
  deliverability: number
  healthScore: number
  activeCampaigns: number
  replyRate: number
  positiveRate: number
  optOutRate: number
  pendingFollowUps: number
  hourlyOutbound: number[]
  recentReplyRate: number[]
  topZips: {
    zip: string
    outbound: number
    trend: '+' | '−'
  }[]
  pipelineSegments: {
    label: string
    value: number
    color: string
  }[]
  lastSweepIso: string
  propertyIds: string[]
  alertCount: number
  operationalRisk: OperationalRisk
  capacityStrain: number
}

export interface LiveLead {
  id: string
  marketId: string
  marketLabel: string
  address: string
  city: string
  stateCode: string
  zip: string
  lat: number
  lng: number
  ownerName: string
  ownerType: OwnerType
  propertyType: PropertyType
  sentiment: Sentiment
  pipelineStage: PipelineStage
  currentIntent: string
  estimatedValue: number
  offerAmount: number
  pipelineDays: number
  outboundAttempts: number
  lastOutboundIso: string
  lastInboundIso: string | null
  aiSummary: string
  heatFactors: string[]
  urgencyScore: number
  opportunityScore: number
  actionConfidence: number
  conversationTemperature: number
  stageMomentum: StageMomentum
  riskSummary: string
  riskFlags: string[]
  objectionsDetected: string[]
  recommendedAction: string
  messages: {
    id: string
    direction: 'outbound' | 'inbound'
    message: string
    timestampIso: string
    aiGenerated?: boolean
  }[]
}

export interface LiveAgent {
  id: string
  name: string
  specialty: string
  status: 'active' | 'watching' | 'queued'
  handledToday: number
  avgResponseMinutes: number
  successRate: number
  load: number
  marketId: string
  marketLabel: string
  focusLeadId: string
  focusLeadLabel: string
  activityLabel: string
  aiSummary: string
}

export interface LiveAlert {
  id: string
  marketId: string
  marketLabel: string
  severity: 'critical' | 'warning' | 'info'
  priority: AlertPriority
  title: string
  detail: string
  metricLabel: string
  metricValue: string
  timestampIso: string
}

export interface LiveActivity {
  id: string
  marketId: string
  marketLabel: string
  kind: 'system' | 'alert' | 'ai' | 'deal' | 'conversation' | 'autopilot'
  severity: 'critical' | 'warning' | 'info'
  title: string
  detail: string
  timestampIso: string
}

export interface LiveMapLink {
  id: string
  fromMarketId: string
  toMarketId: string
  volume: number
}

export interface LiveDashboardModel {
  generatedAtIso: string
  appName: string
  /** 'live' when backed by the real-estate-automation API; 'mock' for reference data */
  dataSource?: 'live' | 'mock'
  /** Present when the live fetch partially failed and mock data was substituted */
  degraded?: {
    reason: string
    partial: string[]
  }
  summaryMetrics: SummaryMetric[]
  markets: LiveMarket[]
  leads: LiveLead[]
  agents: LiveAgent[]
  alerts: LiveAlert[]
  timeline: LiveActivity[]
  mapLinks: LiveMapLink[]
  systemHealth: SystemHealthItem[]
  filters: {
    propertyTypes: FilterOption[]
    sentiments: FilterOption[]
    pipelineStages: FilterOption[]
    ownerTypes: FilterOption[]
  }
  defaults: {
    marketId: string
    leadId: string
    agentId: string
  }
  healthLabel: string
}

const toneFromSeverity = (severity: 'critical' | 'warning' | 'info') => {
  if (severity === 'critical') {
    return 'warning' as const
  }

  if (severity === 'warning') {
    return 'warning' as const
  }

  return 'muted' as const
}

const percentValue = (value: number) => `${value.toFixed(1)}%`

const compactValue = (value: number) =>
  new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value)

const currencyValue = (value: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value)

const buildFilterOptions = (values: string[]) =>
  Array.from(new Set(values))
    .sort((left, right) => left.localeCompare(right))
    .map((value) => ({
      value,
      label: value
        .split('-')
        .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
        .join(' '),
    }))

const pipelineColors = ['var(--tone-muted)', 'var(--tone-primary)', 'var(--tone-sky)', 'var(--tone-warning)', 'var(--tone-success)']

export const adaptLiveDashboardModel = (store: CommandCenterStore): LiveDashboardModel => {
  const markets = store.marketIds.map((marketId) => {
    const market = store.marketsById[marketId]
    const distributionEntries = Object.entries(market.pipelineDistribution) as Array<
      [keyof typeof market.pipelineDistribution, number]
    >

    return {
      id: market.id,
      slug: market.slug,
      name: market.name,
      stateCode: market.stateCode,
      label: market.label,
      lat: market.lat,
      lng: market.lng,
      heat: market.heat,
      campaignStatus: market.campaignStatus,
      scanLabel: market.scanLabel,
      activeProperties: market.activeProperties,
      outboundToday: market.outboundToday,
      repliesToday: market.repliesToday,
      hotLeads: market.hotLeads,
      pipelineValue: market.pipelineValue,
      deliverability: market.deliverability,
      healthScore: market.healthScore,
      activeCampaigns: market.activeCampaigns,
      replyRate: market.replyRate,
      positiveRate: market.positiveRate,
      optOutRate: market.optOutRate,
      pendingFollowUps: market.pendingFollowUps,
      hourlyOutbound: market.hourlyOutbound,
      recentReplyRate: market.recentReplyRate,
      topZips: market.topZips,
      pipelineSegments: distributionEntries.map(([label, value], index) => ({
        label:
          label === 'underContract'
            ? 'Under Contract'
            : label.charAt(0).toUpperCase() + label.slice(1),
        value,
        color: pipelineColors[index] ?? 'var(--tone-primary)',
      })),
      lastSweepIso: market.lastSweepIso,
      propertyIds: store.propertyIdsByMarketId[market.id] ?? [],
      alertCount: (store.alertIdsByMarketId[market.id] ?? []).length,
      operationalRisk: market.operationalRisk,
      capacityStrain: market.capacityStrain,
    }
  })

  const leads = store.propertyIds.map((leadId) => {
    const lead = store.propertiesById[leadId]
    const market = store.marketsById[lead.marketId]

    return {
      id: lead.id,
      marketId: lead.marketId,
      marketLabel: market.label,
      address: lead.address,
      city: lead.city,
      stateCode: lead.stateCode,
      zip: lead.zip,
      lat: lead.lat,
      lng: lead.lng,
      ownerName: lead.ownerName,
      ownerType: lead.ownerType,
      propertyType: lead.propertyType,
      sentiment: lead.sentiment,
      pipelineStage: lead.pipelineStage,
      currentIntent: lead.currentIntent,
      estimatedValue: lead.estimatedValue,
      offerAmount: lead.offerAmount,
      pipelineDays: lead.pipelineDays,
      outboundAttempts: lead.outboundAttempts,
      lastOutboundIso: lead.lastOutboundIso,
      lastInboundIso: lead.lastInboundIso,
      aiSummary: lead.aiSummary,
      heatFactors: lead.heatFactors,
      urgencyScore: lead.urgencyScore,
      opportunityScore: lead.opportunityScore,
      actionConfidence: lead.actionConfidence,
      conversationTemperature: lead.conversationTemperature,
      stageMomentum: lead.stageMomentum,
      riskSummary: lead.riskSummary,
      riskFlags: lead.riskFlags,
      objectionsDetected: lead.objectionsDetected,
      recommendedAction: lead.recommendedAction,
      messages: lead.messages,
    }
  })

  const agents = store.agentIds.map((agentId) => {
    const agent = store.agentsById[agentId]
    const market = store.marketsById[agent.marketId]
    const focusLead = store.propertiesById[agent.focusLeadId]

    return {
      id: agent.id,
      name: agent.name,
      specialty: agent.specialty,
      status: agent.status,
      handledToday: agent.handledToday,
      avgResponseMinutes: agent.avgResponseMinutes,
      successRate: agent.successRate,
      load: agent.load,
      marketId: agent.marketId,
      marketLabel: market.label,
      focusLeadId: agent.focusLeadId,
      focusLeadLabel: `${focusLead.ownerName} • ${focusLead.city}`,
      activityLabel: agent.activityLabel,
      aiSummary: agent.aiSummary,
    }
  })

  const alerts = store.alertIds.map((alertId) => {
    const alert = store.alertsById[alertId]
    const market = store.marketsById[alert.marketId]

    return {
      id: alert.id,
      marketId: alert.marketId,
      marketLabel: market.label,
      severity: alert.severity,
      priority: alert.priority,
      title: alert.title,
      detail: alert.detail,
      metricLabel: alert.metricLabel,
      metricValue: alert.metricValue,
      timestampIso: alert.timestampIso,
    }
  })

  const timeline = store.activityIds.map((activityId) => {
    const activity = store.activitiesById[activityId]
    const market = store.marketsById[activity.marketId]

    return {
      id: activity.id,
      marketId: activity.marketId,
      marketLabel: market.label,
      kind: activity.kind,
      severity: activity.severity,
      title: activity.title,
      detail: activity.detail,
      timestampIso: activity.timestampIso,
    }
  })

  const totalOutbound = markets.reduce((sum, market) => sum + market.outboundToday, 0)
  const repliesToday = markets.reduce((sum, market) => sum + market.repliesToday, 0)
  const hotLeads = markets.reduce((sum, market) => sum + market.hotLeads, 0)
  const pendingFollowUps = markets.reduce((sum, market) => sum + market.pendingFollowUps, 0)
  const pipelineValue = markets.reduce((sum, market) => sum + market.pipelineValue, 0)
  const averageDeliverability =
    markets.reduce((sum, market) => sum + market.deliverability, 0) / markets.length
  const averageHealth = Math.round(
    markets.reduce((sum, market) => sum + market.healthScore, 0) / markets.length,
  )
  const replyRate = totalOutbound === 0 ? 0 : (repliesToday / totalOutbound) * 100
  const positiveRate =
    markets.reduce((sum, market) => sum + market.positiveRate, 0) / markets.length
  const highestAlert = alerts.find((alert) => alert.severity === 'critical') ?? alerts[0]

  const systemHealth: SystemHealthItem[] = store.systemHealth.map((item) => ({
    id: item.id,
    label: item.label,
    status: item.status,
    value: item.value,
    detail: item.detail,
  }))

  return {
    generatedAtIso: new Date().toISOString(),
    appName: 'NEXUS',
    dataSource: 'mock' as const,
    summaryMetrics: [
      {
        id: 'total-outbound',
        label: 'Total Outbound',
        value: compactValue(totalOutbound),
        tone: 'primary',
        detail: 'vs yesterday +12%',
      },
      {
        id: 'replies-today',
        label: 'Replies Today',
        value: compactValue(repliesToday),
        tone: 'success',
        detail: `${hotLeads} hot leads`,
      },
      {
        id: 'reply-rate',
        label: 'Reply Rate',
        value: percentValue(replyRate),
        tone: 'primary',
        detail: `${percentValue(positiveRate)} positive`,
      },
      {
        id: 'opt-out-rate',
        label: 'Opt-Out Rate',
        value: percentValue(
          markets.reduce((sum, market) => sum + market.optOutRate, 0) / markets.length,
        ),
        tone: toneFromSeverity(highestAlert.severity),
        detail: highestAlert.title,
      },
      {
        id: 'active-markets',
        label: 'Active Markets',
        value: `${markets.length}`,
        tone: 'muted',
        detail: `${markets.filter((market) => market.campaignStatus === 'live').length} live`,
      },
      {
        id: 'pending-followups',
        label: 'Pending Follow-ups',
        value: `${pendingFollowUps}`,
        tone: 'warning',
        detail: `${alerts.length} alerting`,
      },
      {
        id: 'pipeline-value',
        label: 'Pipeline Value',
        value: currencyValue(pipelineValue),
        tone: 'success',
        detail: `${agents.length} AI agents`,
      },
      {
        id: 'deliverability',
        label: 'Deliverability',
        value: percentValue(averageDeliverability),
        tone: 'primary',
        detail: `Health ${averageHealth}`,
      },
    ],
    markets,
    leads,
    agents,
    alerts,
    timeline,
    mapLinks: store.mapLinks,
    systemHealth,
    filters: {
      propertyTypes: buildFilterOptions(leads.map((lead) => lead.propertyType)),
      sentiments: buildFilterOptions(leads.map((lead) => lead.sentiment)),
      pipelineStages: buildFilterOptions(leads.map((lead) => lead.pipelineStage)),
      ownerTypes: buildFilterOptions(leads.map((lead) => lead.ownerType)),
    },
    defaults: {
      marketId: markets[0]?.id ?? '',
      leadId: leads[0]?.id ?? '',
      agentId: agents[0]?.id ?? '',
    },
    healthLabel: highestAlert ? `HOME BASE • ${highestAlert.title}` : 'HOME BASE • NOMINAL',
  }
}
