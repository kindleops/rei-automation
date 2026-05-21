import { useDeferredValue, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { NexusMap } from './NexusMap'
import type { DashboardMapFilters, DashboardMapMode } from './map/types'
import {
  aiScoreFromLead as mapLeadAiScore,
  buyerDemandScoreFromLead as mapLeadBuyerDemandScore,
  contractStatusFromLead as mapLeadContractStatus,
  distressSignalsFromLead as mapLeadDistressSignals,
  equityPctFromLead as mapLeadEquityPct,
  followUpStatusFromLead as mapLeadFollowUpStatus,
  priorityFromLead as mapLeadPriority,
  replyStatusFromLead as mapLeadReplyStatus,
  stageBucketFromLead as mapLeadStage,
} from './map/lead-intel'
import { buildActiveMarketConfig } from './map/market-config'
import type {
  FilterOption,
  LiveActivity,
  LiveAgent,
  LiveAlert,
  LiveDashboardModel,
  LiveLead,
  LiveMarket,
  SystemHealthItem,
} from './live-dashboard.adapter'
import {
  formatClockTime,
  formatCompactNumber,
  formatCurrency,
  formatOwnerLabel,
  formatRelativeTime,
  formatShortDateTime,
  formatStageLabel,
} from '../../../shared/formatters'
import { Icon } from '../../../shared/icons'
import { SplitView } from '../../../shared/SplitView'
import { emitNotification } from '../../../shared/NotificationToast'

type DrawerType = 'market' | 'lead' | 'agent' | null
type LayoutMode = 'split' | 'map' | 'list' | 'battlefield'
type MapMode = DashboardMapMode

const classes = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

const includesQuery = (query: string, ...values: Array<string | null | undefined>) => {
  if (!query) {
    return true
  }

  return values.some((value) => value?.toLowerCase().includes(query))
}

const stageToneClass: Record<LiveLead['sentiment'], string> = {
  hot: 'is-hot',
  warm: 'is-warm',
  neutral: 'is-neutral',
  cold: 'is-cold',
}

const alertClass: Record<LiveAlert['severity'], string> = {
  critical: 'is-critical',
  warning: 'is-warning',
  info: 'is-info',
}

const alertPriorityLabel: Record<'P0' | 'P1' | 'P2' | 'P3', string> = {
  P0: 'IMMEDIATE',
  P1: 'URGENT',
  P2: 'ELEVATED',
  P3: 'MONITOR',
}

const marketStatusLabel: Record<LiveMarket['campaignStatus'], string> = {
  live: 'LIVE',
  warning: 'WATCH',
  paused: 'PAUSED',
}

const operationalRiskClass: Record<LiveMarket['operationalRisk'], string> = {
  elevated: 'is-elevated',
  moderate: 'is-moderate',
  nominal: 'is-nominal',
}

const operationalRiskLabel: Record<LiveMarket['operationalRisk'], string> = {
  elevated: 'RISK ELEVATED',
  moderate: 'RISK MODERATE',
  nominal: 'NOMINAL',
}

const DEFAULT_MAP_FILTERS: DashboardMapFilters = {
  marketIds: [],
  temperatures: [],
  leadTemperatures: [],
  priorities: [],
  propertyTypes: [],
  distressSignals: [],
  sellerStages: [],
  campaignSources: [],
  dateWindow: 'all',
  agentIds: [],
  followUpStatuses: [],
  replyStatuses: [],
  aiScoreMin: 0,
  aiScoreMax: 100,
  equityMin: 0,
  equityMax: 100,
  offerEligibility: 'all',
  buyerDemandOverlap: 'all',
  contractStatuses: [],
}

export const LiveDashboardPage = ({ data }: { data: LiveDashboardModel }) => {
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query.trim().toLowerCase())
  const [marketScope, setMarketScope] = useState<string>('all')
  const [propertyType] = useState<string>('all')
  const [sentiment] = useState<string>('all')
  const [stage] = useState<string>('all')
  const [ownerType] = useState<string>('all')
  const [leftRailOpen, setLeftRailOpen] = useState(true)
  const [rightRailOpen, setRightRailOpen] = useState(true)
  const [activeDrawer, setActiveDrawer] = useState<DrawerType>(null)
  const [selectedMarketId, setSelectedMarketId] = useState(data.defaults.marketId)
  const [selectedLeadId, setSelectedLeadId] = useState(data.defaults.leadId)
  const [selectedAgentId, setSelectedAgentId] = useState(data.defaults.agentId)
  const [dismissedAlertIds] = useState<string[]>([])
  const [clock, setClock] = useState(() => new Date())
  // New — layout and map mode
  const [layoutMode, setLayoutMode] = useState<LayoutMode>('split')
  const [mapMode, setMapMode] = useState<MapMode>('leads')
  const [heatModeEnabled, setHeatModeEnabled] = useState(false)
  const [mapFiltersOpen, setMapFiltersOpen] = useState(false)
  const [mapFilterSearch, setMapFilterSearch] = useState('')
  const [mapFilters, setMapFilters] = useState<DashboardMapFilters>(DEFAULT_MAP_FILTERS)
  const [splitLeadId, setSplitLeadId] = useState<string | null>(null)
  const [commandMapOverlayOpen, setCommandMapOverlayOpen] = useState(false)
  const [dashboardPaletteOpen, setDashboardPaletteOpen] = useState(false)
  const mapFilterSearchRef = useRef<HTMLInputElement>(null)

  const deferredMapFilterSearch = useDeferredValue(mapFilterSearch.trim().toLowerCase())

  useEffect(() => {
    const handleCopilotSplitView = (event: Event) => {
      const detail = (event as CustomEvent<{ surfacePath?: string; target?: string }>).detail
      if (detail?.surfacePath !== '/dashboard/live') return
      if (detail.target === 'current-lead' || !detail.target) {
        setSplitLeadId(selectedLeadId)
      }
    }

    window.addEventListener('nx:copilot-split-view', handleCopilotSplitView)
    return () => window.removeEventListener('nx:copilot-split-view', handleCopilotSplitView)
  }, [selectedLeadId])

  const visibleLeads = data.leads.filter((lead) => {
    const matchesMarket = marketScope === 'all' || lead.marketId === marketScope
    const matchesPropertyType = propertyType === 'all' || lead.propertyType === propertyType
    const matchesSentiment = sentiment === 'all' || lead.sentiment === sentiment
    const matchesStage = stage === 'all' || lead.pipelineStage === stage
    const matchesOwnerType = ownerType === 'all' || lead.ownerType === ownerType
    const matchesQuery = includesQuery(
      deferredQuery,
      lead.ownerName,
      lead.address,
      lead.city,
      lead.currentIntent,
      lead.marketLabel,
    )

    return (
      matchesMarket &&
      matchesPropertyType &&
      matchesSentiment &&
      matchesStage &&
      matchesOwnerType &&
      matchesQuery
    )
  })

  const visibleMarkets = data.markets.filter((market) => {
    const matchesScope = marketScope === 'all' || market.id === marketScope
    const matchesQuery = includesQuery(deferredQuery, market.name, market.label, market.scanLabel)
    return matchesScope && (matchesQuery || deferredQuery.length === 0)
  })

  const visibleAgents = data.agents.filter((agent) => {
    const matchesMarket = marketScope === 'all' || agent.marketId === marketScope
    return (
      matchesMarket &&
      includesQuery(
        deferredQuery,
        agent.name,
        agent.specialty,
        agent.activityLabel,
        agent.marketLabel,
        agent.focusLeadLabel,
      )
    )
  })

  const visibleAlerts = data.alerts.filter((alert) => {
    const matchesMarket = marketScope === 'all' || alert.marketId === marketScope
    const isDismissed = dismissedAlertIds.includes(alert.id)
    return (
      matchesMarket &&
      !isDismissed &&
      includesQuery(deferredQuery, alert.title, alert.detail, alert.marketLabel)
    )
  })

  const visibleTimeline = data.timeline.filter((entry) => {
    const matchesMarket = marketScope === 'all' || entry.marketId === marketScope
    return (
      matchesMarket &&
      includesQuery(deferredQuery, entry.title, entry.detail, entry.marketLabel, entry.kind)
    )
  })

  const marketById = useMemo(() => {
    return new Map(data.markets.map((market) => [market.id, market]))
  }, [data.markets])

  const leadAgentIdMap = useMemo(() => {
    const direct = new Map<string, string>()
    const byMarket = new Map<string, string[]>()

    for (const agent of data.agents) {
      direct.set(agent.focusLeadId, agent.id)
      const list = byMarket.get(agent.marketId)
      if (list) {
        list.push(agent.id)
      } else {
        byMarket.set(agent.marketId, [agent.id])
      }
    }

    const resolved = new Map<string, string>()
    for (const lead of data.leads) {
      const directAgent = direct.get(lead.id)
      if (directAgent) {
        resolved.set(lead.id, directAgent)
        continue
      }
      const marketAgents = byMarket.get(lead.marketId)
      if (marketAgents && marketAgents.length > 0) {
        const index = Math.abs(lead.id.split('').reduce((sum, ch) => sum + ch.charCodeAt(0), 0)) % marketAgents.length
        resolved.set(lead.id, marketAgents[index])
      }
    }

    return resolved
  }, [data.agents, data.leads])

  const mapFilteredLeads = useMemo(() => {
    return visibleLeads.filter((lead) => {
      if (mapFilters.marketIds.length > 0 && !mapFilters.marketIds.includes(lead.marketId)) return false
      if (mapFilters.temperatures.length > 0 && !mapFilters.temperatures.includes(lead.sentiment)) return false
      if (mapFilters.leadTemperatures.length > 0 && !mapFilters.leadTemperatures.includes(lead.sentiment)) return false
      if (mapFilters.priorities.length > 0 && !mapFilters.priorities.includes(mapLeadPriority(lead))) return false
      if (mapFilters.propertyTypes.length > 0 && !mapFilters.propertyTypes.includes(lead.propertyType)) return false
      if (mapFilters.sellerStages.length > 0 && !mapFilters.sellerStages.includes(mapLeadStage(lead))) return false
      if (mapFilters.followUpStatuses.length > 0 && !mapFilters.followUpStatuses.includes(mapLeadFollowUpStatus(lead))) return false
      if (mapFilters.replyStatuses.length > 0 && !mapFilters.replyStatuses.includes(mapLeadReplyStatus(lead))) return false
      if (mapFilters.contractStatuses.length > 0 && !mapFilters.contractStatuses.includes(mapLeadContractStatus(lead))) return false

      const leadDistressSignals = mapLeadDistressSignals(lead)
      if (mapFilters.distressSignals.length > 0 && !mapFilters.distressSignals.some((signal) => leadDistressSignals.includes(signal))) {
        return false
      }

      const aiScore = mapLeadAiScore(lead)
      if (aiScore < mapFilters.aiScoreMin || aiScore > mapFilters.aiScoreMax) return false

      const equityPct = mapLeadEquityPct(lead)
      if (equityPct < mapFilters.equityMin || equityPct > mapFilters.equityMax) return false

      if (mapFilters.offerEligibility === 'eligible' && !(lead.pipelineStage !== 'under-contract' && aiScore >= 62 && equityPct >= 18)) {
        return false
      }
      if (mapFilters.offerEligibility === 'ineligible' && (lead.pipelineStage !== 'under-contract' && aiScore >= 62 && equityPct >= 18)) {
        return false
      }

      const buyerDemandScore = mapLeadBuyerDemandScore(lead)
      const buyerDemandBand = buyerDemandScore >= 76 ? 'high' : buyerDemandScore >= 50 ? 'medium' : 'low'
      if (mapFilters.buyerDemandOverlap !== 'all' && buyerDemandBand !== mapFilters.buyerDemandOverlap) return false

      if (mapFilters.campaignSources.length > 0) {
        const market = marketById.get(lead.marketId)
        const sourceTags = [
          market?.scanLabel?.toLowerCase() ?? '',
          market?.campaignStatus ?? '',
          lead.ownerType,
        ]
        if (!mapFilters.campaignSources.some((source) => sourceTags.some((tag) => tag.includes(source)))) {
          return false
        }
      }

      if (mapFilters.dateWindow !== 'all') {
        const latestIso = lead.lastInboundIso ?? lead.lastOutboundIso
        const latest = Date.parse(latestIso)
        const now = Date.now()
        if (Number.isFinite(latest)) {
          const ageHours = Math.max(0, (now - latest) / 3600000)
          if (mapFilters.dateWindow === '24h' && ageHours > 24) return false
          if (mapFilters.dateWindow === '7d' && ageHours > 24 * 7) return false
          if (mapFilters.dateWindow === '30d' && ageHours > 24 * 30) return false
        }
      }

      if (mapFilters.agentIds.length > 0) {
        const mappedAgentId = leadAgentIdMap.get(lead.id)
        if (!mappedAgentId || !mapFilters.agentIds.includes(mappedAgentId)) return false
      }

      if (deferredMapFilterSearch) {
        const haystack = [
          lead.ownerName,
          lead.address,
          lead.city,
          lead.stateCode,
          lead.marketLabel,
          lead.propertyType,
          lead.pipelineStage,
          lead.ownerType,
          ...lead.heatFactors,
          ...lead.riskFlags,
        ].join(' ').toLowerCase()
        if (!haystack.includes(deferredMapFilterSearch)) return false
      }

      return true
    })
  }, [visibleLeads, mapFilters, deferredMapFilterSearch, leadAgentIdMap, marketById])

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setClock(new Date())
    }, 30_000)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [])

  const onKeyboardShortcut = useEffectEvent((event: KeyboardEvent) => {
    const target = event.target
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    ) {
      return
    }

    if (event.key === 'Escape') {
      if (dashboardPaletteOpen) {
        setDashboardPaletteOpen(false)
        return
      }
      if (commandMapOverlayOpen) {
        setCommandMapOverlayOpen(false)
        return
      }
      if (layoutMode === 'map' || layoutMode === 'battlefield') {
        setLayoutMode('split')
        return
      }
      if (activeDrawer) {
        setActiveDrawer(null)
        return
      }
    }
  })

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      onKeyboardShortcut(event)
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  const handleToggleLeftRail = () => {
    setLeftRailOpen((current) => !current)
  }

  const handleToggleRightRail = () => {
    setRightRailOpen((current) => !current)
  }

  const handleOpenCommandMapOverlay = () => {
    setCommandMapOverlayOpen((current) => !current)
  }

  const handleOpenDashboardPalette = () => {
    setDashboardPaletteOpen((current) => !current)
    window.dispatchEvent(new CustomEvent('nx:context-palette'))
  }

  const handleClearTemporaryPanels = () => {
    setActiveDrawer(null)
    setSplitLeadId(null)
    setDashboardPaletteOpen(false)
    setCommandMapOverlayOpen(false)
  }

  const updateFilterList = <K extends keyof DashboardMapFilters>(
    key: K,
    value: DashboardMapFilters[K] extends Array<infer T> ? T : never,
  ) => {
    setMapFilters((current) => {
      const source = current[key]
      if (!Array.isArray(source)) return current
      const list = source as Array<typeof value>
      const exists = list.includes(value)
      return {
        ...current,
        [key]: exists ? list.filter((item) => item !== value) : [...list, value],
      }
    })
  }

  const clearMapFiltersAndHeat = () => {
    setMapFilters(DEFAULT_MAP_FILTERS)
    setMapFilterSearch('')
    setMapMode('leads')
    setHeatModeEnabled(false)
  }

  const handleToggleHeatMode = () => {
    setHeatModeEnabled((current) => !current)
  }

  const handleSetMapMode = (mode: MapMode) => {
    setMapMode(mode)
    if (mode === 'heat') {
      setHeatModeEnabled(true)
    }
  }

  const handleFocusFilterSearch = () => {
    setMapFiltersOpen(true)
    mapFilterSearchRef.current?.focus()
  }

  const resolvedSelectedMarketId = visibleMarkets.some((market) => market.id === selectedMarketId)
    ? selectedMarketId
    : visibleMarkets[0]?.id ?? data.defaults.marketId

  const selectedMarket = visibleMarkets.find((market) => market.id === resolvedSelectedMarketId) ??
    data.markets.find((market) => market.id === resolvedSelectedMarketId) ??
    visibleMarkets[0] ??
    data.markets[0]

  const preferredLeadPool = visibleLeads.filter((lead) => lead.marketId === selectedMarket?.id)
  const activeLeadPool = preferredLeadPool.length > 0 ? preferredLeadPool : visibleLeads

  const resolvedSelectedLeadId = activeLeadPool.some((lead) => lead.id === selectedLeadId)
    ? selectedLeadId
    : activeLeadPool[0]?.id ?? data.defaults.leadId

  const selectedLead = activeLeadPool.find((lead) => lead.id === resolvedSelectedLeadId) ??
    data.leads.find((lead) => lead.id === resolvedSelectedLeadId) ??
    activeLeadPool[0] ??
    data.leads[0]

  const selectedLeadIdForMap = mapFilteredLeads.some((lead) => lead.id === selectedLead?.id)
    ? selectedLead?.id
    : mapFilteredLeads[0]?.id

  const selectedMarketIdForMap = data.markets.some((market) => market.id === selectedMarket?.id)
    ? selectedMarket?.id
    : data.markets[0]?.id

  const activeMarketConfigs = useMemo(
    () => buildActiveMarketConfig(data.markets, mapFilteredLeads, mapMode),
    [data.markets, mapFilteredLeads, mapMode],
  )

  const activeFilterChips = [
    ...mapFilters.marketIds.map((id) => ({ key: `market-${id}`, label: `Market: ${data.markets.find((m) => m.id === id)?.name ?? id}` })),
    ...mapFilters.temperatures.map((value) => ({ key: `temp-${value}`, label: `Temp: ${value}` })),
    ...mapFilters.leadTemperatures.map((value) => ({ key: `lead-temp-${value}`, label: `Lead: ${value}` })),
    ...mapFilters.priorities.map((value) => ({ key: `priority-${value}`, label: value })),
    ...mapFilters.campaignSources.map((value) => ({ key: `campaign-${value}`, label: `Src: ${value}` })),
    ...mapFilters.agentIds.map((value) => ({ key: `agent-${value}`, label: `Agent: ${data.agents.find((a) => a.id === value)?.name ?? value}` })),
    ...mapFilters.propertyTypes.map((value) => ({ key: `ptype-${value}`, label: `Type: ${value}` })),
    ...mapFilters.distressSignals.map((value) => ({ key: `dist-${value}`, label: value })),
    ...mapFilters.sellerStages.map((value) => ({ key: `stage-${value}`, label: value })),
    ...mapFilters.followUpStatuses.map((value) => ({ key: `follow-${value}`, label: value })),
    ...mapFilters.replyStatuses.map((value) => ({ key: `reply-${value}`, label: value })),
    ...mapFilters.contractStatuses.map((value) => ({ key: `contract-${value}`, label: value })),
    ...(mapFilters.offerEligibility !== 'all' ? [{ key: 'offer-eligibility', label: `Offer: ${mapFilters.offerEligibility}` }] : []),
    ...(mapFilters.buyerDemandOverlap !== 'all' ? [{ key: 'buyer-overlap', label: `Buyer: ${mapFilters.buyerDemandOverlap}` }] : []),
    ...(mapFilters.dateWindow !== 'all' ? [{ key: 'date-window', label: `Window: ${mapFilters.dateWindow}` }] : []),
    ...(mapFilters.aiScoreMin !== 0 || mapFilters.aiScoreMax !== 100
      ? [{ key: 'ai-range', label: `AI ${mapFilters.aiScoreMin}-${mapFilters.aiScoreMax}` }]
      : []),
    ...(mapFilters.equityMin !== 0 || mapFilters.equityMax !== 100
      ? [{ key: 'equity-range', label: `Equity ${mapFilters.equityMin}-${mapFilters.equityMax}%` }]
      : []),
  ]

  const preferredAgentPool = visibleAgents.filter((agent) => agent.marketId === selectedMarket?.id)
  const activeAgentPool = preferredAgentPool.length > 0 ? preferredAgentPool : visibleAgents

  const resolvedSelectedAgentId = activeAgentPool.some((agent) => agent.id === selectedAgentId)
    ? selectedAgentId
    : activeAgentPool[0]?.id ?? data.defaults.agentId

  const selectedAgent = activeAgentPool.find((agent) => agent.id === resolvedSelectedAgentId) ??
    data.agents.find((agent) => agent.id === resolvedSelectedAgentId) ??
    activeAgentPool[0] ??
    data.agents[0]

  const selectedAgentLead =
    data.leads.find((lead) => lead.id === selectedAgent?.focusLeadId) ?? selectedLead

  // Effective open states account for layout mode
  const leftEffOpen = leftRailOpen && layoutMode !== 'map' && layoutMode !== 'battlefield'
  const rightEffOpen = rightRailOpen && layoutMode !== 'map' && layoutMode !== 'battlefield'

  // Top priority alerts for right blade
  const topAlerts = visibleAlerts
    .filter(a => a.severity === 'critical' || a.severity === 'warning')
    .slice(0, 3)

  // ── Alternate layouts (list / battlefield) use legacy cc-* shell ────────
  if (layoutMode === 'list' || layoutMode === 'battlefield') {
    return (
      <div className={classes('cc-shell', `cc-shell--layout-${layoutMode}`)} data-testid="dashboard-root">
        <DashboardHeader
          appName={data.appName}
          query={query}
          setQuery={setQuery}
          liveClock={clock}
          healthLabel={data.healthLabel}
          leftRailOpen={leftEffOpen}
          rightRailOpen={rightEffOpen}
          layoutMode={layoutMode}
          onToggleLeftRail={() => { setLeftRailOpen((current) => !current) }}
          onToggleRightRail={() => { setRightRailOpen((current) => !current) }}
          onSetLayoutMode={setLayoutMode}
        />
        <HealthStrip items={data.systemHealth} />
        <div className="cc-workspace">
          {layoutMode === 'list' ? (
            <LeadListTable
              leads={visibleLeads}
              selectedLeadId={resolvedSelectedLeadId}
              onOpenLead={(leadId) => { setSelectedLeadId(leadId); setActiveDrawer('lead') }}
            />
          ) : (
            <BattlefieldView
              leads={visibleLeads}
              selectedLeadId={resolvedSelectedLeadId}
              onOpenLead={(leadId) => { setSelectedLeadId(leadId); setActiveDrawer('lead') }}
            />
          )}
        </div>
        <DrawerOverlay activeDrawer={activeDrawer} onClose={() => { setActiveDrawer(null) }}>
          {activeDrawer === 'market' && selectedMarket ? <MarketDrawer market={selectedMarket} /> : null}
          {activeDrawer === 'lead' && selectedLead ? <LeadDrawer lead={selectedLead} /> : null}
          {activeDrawer === 'agent' && selectedAgent && selectedAgentLead ? <AgentDrawer agent={selectedAgent} lead={selectedAgentLead} /> : null}
        </DrawerOverlay>
      </div>
    )
  }

  // ── Home Command Floor — cinematic map-first scene ──────────────────────
  return (
    <div className="hq" data-testid="dashboard-root">
      {/* Full-bleed map — the emotional center */}
      <div className="hq__map">
        <NexusMap
          leads={mapFilteredLeads}
          markets={data.markets}
          marketConfigs={activeMarketConfigs}
          timeline={visibleTimeline}
          selectedLeadId={selectedLeadIdForMap}
          selectedMarketId={selectedMarketIdForMap}
          mapMode={mapMode}
          heatModeEnabled={heatModeEnabled}
          activeFilters={mapFilters}
          activeDrawer={activeDrawer}
          onOpenLead={(leadId) => { setSelectedLeadId(leadId); setActiveDrawer('lead') }}
          onSelectMarket={(marketId) => { setSelectedMarketId(marketId) }}
          onToggleLeftPanel={handleToggleLeftRail}
          onToggleRightPanel={handleToggleRightRail}
          onOpenCommandMapOverlay={handleOpenCommandMapOverlay}
          onOpenDashboardPalette={handleOpenDashboardPalette}
          onClearTemporaryPanels={handleClearTemporaryPanels}
          onSetMapMode={handleSetMapMode}
          onToggleHeatMode={handleToggleHeatMode}
          onClearHeatAndFilters={clearMapFiltersAndHeat}
          onFocusFilterSearch={handleFocusFilterSearch}
        />

        <section className="hq__map-filter-dock" aria-label="Map filter controls">
          <div className="hq__map-filter-head">
            <button
              type="button"
              className={classes('hq__map-filter-toggle', mapFiltersOpen && 'is-open')}
              onClick={() => setMapFiltersOpen((current) => !current)}
            >
              Filters
            </button>
            <button
              type="button"
              className={classes('hq__map-heat-toggle', heatModeEnabled && 'is-on')}
              onClick={handleToggleHeatMode}
              title="Heat overlay (H)"
            >
              Heat {heatModeEnabled ? 'On' : 'Off'}
            </button>
            <button type="button" className="hq__map-filter-clear" onClick={clearMapFiltersAndHeat}>
              Reset
            </button>
          </div>

          {activeFilterChips.length > 0 ? (
            <div className="hq__map-filter-chips">
              {activeFilterChips.slice(0, 12).map((chip) => (
                <span key={chip.key} className="hq__map-filter-chip">{chip.label}</span>
              ))}
            </div>
          ) : null}

          {mapFiltersOpen ? (
            <div className="hq__map-filter-panel">
              <div className="hq__map-filter-row">
                <input
                  ref={mapFilterSearchRef}
                  className="hq__map-filter-search"
                  type="search"
                  value={mapFilterSearch}
                  onChange={(event) => setMapFilterSearch(event.target.value)}
                  placeholder="Filter search (Cmd/Ctrl+F)…"
                />
                <select
                  className="hq__map-filter-select"
                  value={mapFilters.buyerDemandOverlap}
                  onChange={(event) => setMapFilters((current) => ({ ...current, buyerDemandOverlap: event.target.value as DashboardMapFilters['buyerDemandOverlap'] }))}
                >
                  <option value="all">Buyer overlap: all</option>
                  <option value="high">Buyer overlap: high</option>
                  <option value="medium">Buyer overlap: medium</option>
                  <option value="low">Buyer overlap: low</option>
                </select>
                <select
                  className="hq__map-filter-select"
                  value={mapFilters.offerEligibility}
                  onChange={(event) => setMapFilters((current) => ({ ...current, offerEligibility: event.target.value as DashboardMapFilters['offerEligibility'] }))}
                >
                  <option value="all">Offer: all</option>
                  <option value="eligible">Offer: eligible</option>
                  <option value="ineligible">Offer: ineligible</option>
                </select>
              </div>

              <div className="hq__map-filter-row hq__map-filter-row--chips">
                {visibleMarkets.slice(0, 8).map((market) => (
                  <button
                    key={market.id}
                    type="button"
                    className={classes('hq__map-filter-pick', mapFilters.marketIds.includes(market.id) && 'is-active')}
                    onClick={() => updateFilterList('marketIds', market.id)}
                  >
                    {market.name}
                  </button>
                ))}
                {(['hot', 'warm', 'cold'] as const).map((temp) => (
                  <button
                    key={temp}
                    type="button"
                    className={classes('hq__map-filter-pick', mapFilters.temperatures.includes(temp) && 'is-active')}
                    onClick={() => updateFilterList('temperatures', temp)}
                  >
                    {temp}
                  </button>
                ))}
                {(['P0', 'P1', 'P2', 'P3'] as const).map((priority) => (
                  <button
                    key={priority}
                    type="button"
                    className={classes('hq__map-filter-pick', mapFilters.priorities.includes(priority) && 'is-active')}
                    onClick={() => updateFilterList('priorities', priority)}
                  >
                    {priority}
                  </button>
                ))}
                {Array.from(new Set(data.leads.map((lead) => lead.propertyType))).slice(0, 6).map((type) => (
                  <button
                    key={type}
                    type="button"
                    className={classes('hq__map-filter-pick', mapFilters.propertyTypes.includes(type) && 'is-active')}
                    onClick={() => updateFilterList('propertyTypes', type)}
                  >
                    {type}
                  </button>
                ))}
                {['tax-delinquent', 'probate', 'vacant', 'pre-foreclosure', 'absentee-owner', 'high-equity'].map((signal) => (
                  <button
                    key={signal}
                    type="button"
                    className={classes('hq__map-filter-pick', mapFilters.distressSignals.includes(signal) && 'is-active')}
                    onClick={() => updateFilterList('distressSignals', signal)}
                  >
                    {signal}
                  </button>
                ))}
                {['not-contacted', 'contacted', 'replied', 'negotiating', 'under-contract', 'closing'].map((stageLabel) => (
                  <button
                    key={stageLabel}
                    type="button"
                    className={classes('hq__map-filter-pick', mapFilters.sellerStages.includes(stageLabel) && 'is-active')}
                    onClick={() => updateFilterList('sellerStages', stageLabel)}
                  >
                    {stageLabel}
                  </button>
                ))}
                {['on-track', 'due-soon', 'overdue', 'stalled'].map((status) => (
                  <button
                    key={status}
                    type="button"
                    className={classes('hq__map-filter-pick', mapFilters.followUpStatuses.includes(status) && 'is-active')}
                    onClick={() => updateFilterList('followUpStatuses', status)}
                  >
                    {status}
                  </button>
                ))}
                {['awaiting-reply', 'replied', 'no-reply'].map((status) => (
                  <button
                    key={status}
                    type="button"
                    className={classes('hq__map-filter-pick', mapFilters.replyStatuses.includes(status) && 'is-active')}
                    onClick={() => updateFilterList('replyStatuses', status)}
                  >
                    {status}
                  </button>
                ))}
                {['under-contract', 'title-risk', 'clear-to-close', 'none'].map((status) => (
                  <button
                    key={status}
                    type="button"
                    className={classes('hq__map-filter-pick', mapFilters.contractStatuses.includes(status) && 'is-active')}
                    onClick={() => updateFilterList('contractStatuses', status)}
                  >
                    {status}
                  </button>
                ))}
              </div>

              <div className="hq__map-filter-row hq__map-filter-row--range">
                <label>
                  AI {mapFilters.aiScoreMin}-{mapFilters.aiScoreMax}
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={mapFilters.aiScoreMin}
                    onChange={(event) => setMapFilters((current) => ({ ...current, aiScoreMin: Number(event.target.value) }))}
                  />
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={mapFilters.aiScoreMax}
                    onChange={(event) => setMapFilters((current) => ({ ...current, aiScoreMax: Number(event.target.value) }))}
                  />
                </label>
                <label>
                  Equity {mapFilters.equityMin}-{mapFilters.equityMax}%
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={mapFilters.equityMin}
                    onChange={(event) => setMapFilters((current) => ({ ...current, equityMin: Number(event.target.value) }))}
                  />
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={mapFilters.equityMax}
                    onChange={(event) => setMapFilters((current) => ({ ...current, equityMax: Number(event.target.value) }))}
                  />
                </label>
              </div>
            </div>
          ) : null}
        </section>
      </div>

      {/* Top Command Strip — thin, embedded, premium */}
      <header className="hq__strip">
        <div className="hq__strip-left">
          <div className="hq__brand">
            <Icon name="radar" className="hq__brand-icon" />
            <span className="hq__brand-label">NEXUS</span>
          </div>
          <span className="hq__live">
            <span className="hq__live-dot" />
            LIVE
          </span>
          <span className="hq__health">{data.healthLabel}</span>
        </div>

        <div className="hq__strip-center">
          <Icon name="search" className="hq__search-icon" />
          <input
            className="hq__search"
            type="search"
            placeholder="Search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="hq__strip-right">
          <span className="hq__clock">
            <Icon name="clock" className="hq__clock-icon" />
            {formatClockTime(clock)} CT
          </span>
          <div className="hq__modes">
            <button
              type="button"
              className={classes('hq__mode-btn', layoutMode === 'map' && 'is-active')}
              title="Map Focus"
              onClick={() => setLayoutMode(layoutMode === 'map' ? 'split' : 'map')}
            >
              <Icon name="maximize" className="hq__mode-icon" />
            </button>
            <button
              type="button"
              className="hq__mode-btn"
              title="List View"
              onClick={() => setLayoutMode('list')}
            >
              <Icon name="list" className="hq__mode-icon" />
            </button>
            <button
              type="button"
              className="hq__mode-btn"
              title="Battlefield"
              onClick={() => setLayoutMode('battlefield')}
            >
              <Icon name="command" className="hq__mode-icon" />
            </button>
          </div>
          <div className="hq__map-modes">
            {(['leads', 'heat', 'pressure', 'distress', 'stage', 'closings', 'buyerDemand', 'aiPriority'] as MapMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                className={classes('hq__map-mode', mapMode === mode && 'is-active')}
                onClick={() => handleSetMapMode(mode)}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* Left Intelligence Blade */}
      {leftEffOpen && (
        <aside className="hq__blade hq__blade--left">
          <div className="hq__blade-header">
            <span className="hq__blade-title">Intelligence</span>
            <button type="button" className="hq__blade-close" onClick={() => setLeftRailOpen(false)}>
              <Icon name="chevron-right" className="hq__blade-close-icon is-flip" />
            </button>
          </div>

          {/* Scope */}
          <div className="hq__scope">
            <span className="hq__scope-label">SCOPE</span>
            <select
              className="hq__scope-select"
              value={marketScope}
              onChange={(e) => setMarketScope(e.target.value)}
            >
              <option value="all">All Markets</option>
              {data.markets.map(m => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>

          {/* Key Metrics — 2×3 grid */}
          <div className="hq__metrics hq__metrics--rich">
            {data.summaryMetrics.slice(0, 6).map(m => (
              <div key={m.id} className={classes('hq__metric', `is-${m.tone}`)}>
                <span className="hq__metric-value">{m.value}</span>
                <span className="hq__metric-label">{m.label}</span>
                {m.detail && <span className="hq__metric-detail">{m.detail}</span>}
              </div>
            ))}
          </div>

          {/* Quick Stats Bar */}
          <div className="hq__quick-stats">
            <div className="hq__stat-pill">
              <span className="hq__stat-pill-value">{visibleMarkets.length}</span>
              <span className="hq__stat-pill-label">Markets</span>
            </div>
            <div className="hq__stat-pill is-hot">
              <span className="hq__stat-pill-value">{visibleLeads.filter(l => l.sentiment === 'hot').length}</span>
              <span className="hq__stat-pill-label">Hot</span>
            </div>
            <div className="hq__stat-pill is-warm">
              <span className="hq__stat-pill-value">{visibleLeads.filter(l => l.sentiment === 'warm').length}</span>
              <span className="hq__stat-pill-label">Warm</span>
            </div>
          </div>

          {/* Selected Market Context */}
          {selectedMarket && (
            <div className="hq__context">
              <div className="hq__context-header">
                <span className="hq__context-eyebrow">{selectedMarket.label}</span>
                <span className={classes('hq__context-status', `is-${selectedMarket.campaignStatus}`)}>
                  {marketStatusLabel[selectedMarket.campaignStatus]}
                </span>
              </div>
              <span className="hq__context-name">{selectedMarket.scanLabel}</span>
              <div className="hq__context-stats">
                <span>{formatCompactNumber(selectedMarket.outboundToday)} sent</span>
                <span>{selectedMarket.hotLeads} hot</span>
                <span>H{selectedMarket.healthScore}</span>
              </div>
              <div className="hq__context-capacity">
                <div className="hq__capacity-bar">
                  <div className="hq__capacity-fill" style={{ width: `${Math.min(selectedMarket.capacityStrain, 100)}%` }} />
                </div>
                <span className="hq__capacity-label">{selectedMarket.capacityStrain}% capacity</span>
              </div>
              <button
                type="button"
                className="hq__context-action"
                onClick={() => { setSelectedMarketId(selectedMarket.id); setActiveDrawer('market') }}
              >
                Open Market
              </button>
            </div>
          )}

          {/* Agents Summary */}
          <div className="hq__agents-summary">
            <span className="hq__scope-label">AGENTS</span>
            <div className="hq__agents-row">
              <span className="hq__agents-count">{visibleAgents.filter(a => a.status === 'active').length} active</span>
              <span className="hq__agents-handled">{visibleAgents.reduce((s, a) => s + a.handledToday, 0)} handled today</span>
            </div>
            {visibleAgents.slice(0, 3).map(agent => (
              <button
                key={agent.id}
                type="button"
                className={classes('hq__agent-mini', agent.id === selectedAgent?.id && 'is-selected')}
                onClick={() => { setSelectedAgentId(agent.id); setActiveDrawer('agent') }}
              >
                <span className={classes('hq__agent-status-dot', agent.status === 'active' ? 'is-active' : 'is-idle')} />
                <span className="hq__agent-name">{agent.name}</span>
                <span className="hq__agent-load">{agent.handledToday}</span>
              </button>
            ))}
          </div>
        </aside>
      )}

      {/* Left blade toggle (when closed) */}
      {!leftEffOpen && (
        <button type="button" className="hq__blade-toggle hq__blade-toggle--left" onClick={() => setLeftRailOpen(true)}>
          <Icon name="chevron-right" className="hq__blade-toggle-icon" />
        </button>
      )}

      {/* Right Activity Blade */}
      {rightEffOpen && (
        <aside className="hq__blade hq__blade--right">
          <div className="hq__blade-header">
            <span className="hq__blade-title">Activity</span>
            <span className="hq__blade-count">{visibleAlerts.filter(a => a.severity === 'critical').length} critical</span>
            <button type="button" className="hq__blade-close" onClick={() => setRightRailOpen(false)}>
              <Icon name="chevron-right" className="hq__blade-close-icon" />
            </button>
          </div>

          {/* Priority Alerts */}
          {topAlerts.length > 0 && (
            <div className="hq__alerts">
              <span className="hq__scope-label">PRIORITY</span>
              {topAlerts.map(alert => (
                <div key={alert.id} className={classes('hq__alert', `is-${alert.severity}`)}>
                  <div className="hq__alert-top">
                    <span className="hq__alert-priority">{alert.priority}</span>
                    <span className="hq__alert-market">{alert.marketLabel}</span>
                    <span className="hq__alert-time">{formatRelativeTime(alert.timestampIso)}</span>
                  </div>
                  <span className="hq__alert-title">{alert.title}</span>
                  {alert.detail && <span className="hq__alert-detail">{alert.detail}</span>}
                  <div className="hq__alert-metric">
                    <span>{alert.metricLabel}</span>
                    <strong>{alert.metricValue}</strong>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Live Stream with kind icons */}
          <div className="hq__stream">
            <span className="hq__scope-label">LIVE STREAM</span>
            {visibleTimeline.slice(0, 10).map(evt => (
              <div key={evt.id} className={classes('hq__stream-event', `is-${evt.severity}`, `is-kind-${evt.kind}`)}>
                <div className="hq__stream-icon-wrap">
                  <Icon name={(timelineKindIcon[evt.kind] ?? 'activity') as Parameters<typeof Icon>[0]['name']} className="hq__stream-icon" />
                </div>
                <div className="hq__stream-body">
                  <span className="hq__stream-title">{evt.title}</span>
                  <div className="hq__stream-meta">
                    <span className="hq__stream-market">{evt.marketLabel}</span>
                    <span className="hq__stream-time">{formatRelativeTime(evt.timestampIso)}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Selected Lead Spotlight — enriched */}
          {selectedLead && (
            <div className="hq__spotlight">
              <div className="hq__spotlight-header">
                <span className={classes('hq__spotlight-sentiment', stageToneClass[selectedLead.sentiment])}>
                  {selectedLead.sentiment.toUpperCase()}
                </span>
                <strong className="hq__spotlight-score">{selectedLead.urgencyScore}</strong>
              </div>
              <span className="hq__spotlight-name">{selectedLead.ownerName}</span>
              <span className="hq__spotlight-address">{selectedLead.address}</span>
              <span className="hq__spotlight-intent">{selectedLead.currentIntent}</span>
              <div className="hq__spotlight-stats">
                <span>{formatStageLabel(selectedLead.pipelineStage)}</span>
                <span>{selectedLead.outboundAttempts} outbound</span>
                <span>{selectedLead.pipelineDays}d in pipeline</span>
              </div>
              <button
                type="button"
                className="hq__context-action"
                onClick={() => { setSelectedLeadId(selectedLead.id); setActiveDrawer('lead') }}
              >
                Full Dossier
              </button>
              <button
                type="button"
                className="hq__context-action hq__context-action--focus"
                onClick={() => setSplitLeadId(selectedLead.id)}
              >
                Focus View
              </button>
            </div>
          )}
        </aside>
      )}

      {/* Right blade toggle (when closed) */}
      {!rightEffOpen && (
        <button type="button" className="hq__blade-toggle hq__blade-toggle--right" onClick={() => setRightRailOpen(true)}>
          <Icon name="chevron-right" className="hq__blade-toggle-icon is-flip" />
        </button>
      )}

      {/* Bottom Timeline Rail — enriched */}
      <div className="hq__timeline">
        <div className="hq__timeline-strip">
          <span className="hq__timeline-now">NOW</span>
        </div>
        <div className="hq__timeline-track">
          {visibleTimeline.slice(0, 40).map(evt => (
            <button
              type="button"
              key={evt.id}
              className={classes('hq__timeline-event', `is-${evt.severity}`, `is-kind-${evt.kind}`)}
              onClick={() => {
                const m = data.markets.find(mk => mk.id === evt.marketId);
                if (m) { setSelectedMarketId(m.id); setActiveDrawer('market'); }
              }}
            >
              <Icon name={(timelineKindIcon[evt.kind] ?? 'activity') as Parameters<typeof Icon>[0]['name']} className="hq__timeline-icon" />
              <span className="hq__timeline-label">{evt.title}</span>
              <div className="hq__timeline-sub">
                <span className="hq__timeline-market">{evt.marketLabel}</span>
                <span className="hq__timeline-time">{formatRelativeTime(evt.timestampIso)}</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {commandMapOverlayOpen ? (
        <section className="hq__command-overlay" role="dialog" aria-label="Map Command Overlay">
          <div className="hq__command-overlay-head">
            <span>Map Command Overlay</span>
            <button type="button" onClick={() => setCommandMapOverlayOpen(false)}>Close</button>
          </div>
          <div className="hq__command-overlay-grid">
            <span>G</span><span>National command view</span>
            <span>M</span><span>Cycle active markets</span>
            <span>F</span><span>Focus selected property</span>
            <span>P / T / B</span><span>Pitch, terrain, and 3D buildings</span>
            <span>H / Shift+H</span><span>Heat toggle, clear heat+filters</span>
            <span>1..6</span><span>Mode select: leads, heat, pressure, distress, stage, closings</span>
            <span>Cmd/Ctrl+F</span><span>Focus map filter search</span>
          </div>
        </section>
      ) : null}

      {dashboardPaletteOpen ? (
        <section className="hq__palette-overlay" role="dialog" aria-label="Dashboard Command Palette">
          <div className="hq__palette-overlay-head">
            <span>Dashboard Command Palette</span>
            <button type="button" onClick={() => setDashboardPaletteOpen(false)}>Close</button>
          </div>
          <div className="hq__palette-overlay-body">
            <button type="button" onClick={() => { handleSetMapMode('leads'); setDashboardPaletteOpen(false) }}>Set map mode: Leads</button>
            <button type="button" onClick={() => { handleSetMapMode('heat'); setDashboardPaletteOpen(false) }}>Set map mode: Heat</button>
            <button type="button" onClick={() => { handleSetMapMode('pressure'); setDashboardPaletteOpen(false) }}>Set map mode: Pressure</button>
            <button type="button" onClick={() => { handleSetMapMode('distress'); setDashboardPaletteOpen(false) }}>Set map mode: Distress</button>
            <button type="button" onClick={() => { handleSetMapMode('stage'); setDashboardPaletteOpen(false) }}>Set map mode: Stage</button>
            <button type="button" onClick={() => { handleSetMapMode('closings'); setDashboardPaletteOpen(false) }}>Set map mode: Closings</button>
            <button type="button" onClick={() => { handleSetMapMode('buyerDemand'); setDashboardPaletteOpen(false) }}>Set map mode: Buyer Demand</button>
            <button type="button" onClick={() => { handleSetMapMode('aiPriority'); setDashboardPaletteOpen(false) }}>Set map mode: AI Priority</button>
          </div>
        </section>
      ) : null}

      {/* Map attribution */}
      <div className="hq__attribution">
        <a href="https://carto.com/attributions" target="_blank" rel="noopener noreferrer">© CARTO</a>
        {' '}
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OSM</a>
      </div>

      {/* Drawer system — shared */}
      <DrawerOverlay activeDrawer={activeDrawer} onClose={() => { setActiveDrawer(null) }}>
        {activeDrawer === 'market' && selectedMarket ? <MarketDrawer market={selectedMarket} /> : null}
        {activeDrawer === 'lead' && selectedLead ? <LeadDrawer lead={selectedLead} /> : null}
        {activeDrawer === 'agent' && selectedAgent && selectedAgentLead ? <AgentDrawer agent={selectedAgent} lead={selectedAgentLead} /> : null}
      </DrawerOverlay>

      {/* Split View — lead focus mode */}
      <SplitView
        open={!!splitLeadId}
        title={data.leads.find(l => l.id === splitLeadId)?.ownerName ?? 'Lead Detail'}
        subtitle={data.leads.find(l => l.id === splitLeadId)?.address}
        badge={(() => {
          const lead = data.leads.find(l => l.id === splitLeadId)
          return lead ? (
            <span className={classes('hq__spotlight-sentiment', stageToneClass[lead.sentiment])}>
              {lead.sentiment.toUpperCase()}
            </span>
          ) : undefined
        })()}
        onClose={() => setSplitLeadId(null)}
      >
        {(() => {
          const lead = data.leads.find(l => l.id === splitLeadId)
          if (!lead) return null
          return (
            <div className="nx-split-lead">
              <div className="nx-split-lead__urgency">
                <span className="nx-split-lead__urgency-label">URGENCY</span>
                <strong>{lead.urgencyScore}</strong>
                <div className="nx-split-lead__urgency-bar">
                  <div className="nx-split-lead__urgency-fill" style={{ width: `${lead.urgencyScore}%` }} />
                </div>
              </div>
              <div className="nx-split-lead__factors">
                {lead.heatFactors.map(f => (
                  <span key={f} className="nx-split-lead__factor">{f}</span>
                ))}
              </div>
              <div className="nx-split-lead__ai">
                <Icon name="spark" className="nx-split-lead__ai-icon" />
                <p>{lead.aiSummary}</p>
              </div>
              <div className="nx-split-lead__stats">
                <div className="nx-info-row"><span>Pipeline Stage</span><strong>{formatStageLabel(lead.pipelineStage)}</strong></div>
                <div className="nx-info-row"><span>Est. Value</span><strong>{formatCurrency(lead.estimatedValue)}</strong></div>
                <div className="nx-info-row"><span>Outbound</span><strong>{lead.outboundAttempts}</strong></div>
                <div className="nx-info-row"><span>Days in Pipeline</span><strong>{lead.pipelineDays}</strong></div>
              </div>
              <div className="nx-split-lead__nba">
                <span className="nx-split-lead__nba-label">NEXT ACTION</span>
                <p>{lead.recommendedAction}</p>
              </div>
              <div className="nx-split-lead__actions">
                <button className="nx-primary-button" type="button" onClick={() => {
                  emitNotification({ title: 'Follow-up Sent', detail: `Outbound to ${lead.ownerName}`, severity: 'success' })
                }}>
                  <Icon className="nx-primary-button__icon" name="send" />
                  Send Follow-up
                </button>
                <button className="nx-secondary-button" type="button" onClick={() => {
                  setSelectedLeadId(lead.id)
                  setActiveDrawer('lead')
                  setSplitLeadId(null)
                }}>
                  Full Dossier
                </button>
              </div>
            </div>
          )
        })()}
      </SplitView>
    </div>
  )
}

const DashboardHeader = ({
  appName,
  query,
  setQuery,
  liveClock,
  healthLabel,
  leftRailOpen,
  rightRailOpen,
  layoutMode,
  onToggleLeftRail,
  onToggleRightRail,
  onSetLayoutMode,
}: {
  appName: string
  query: string
  setQuery: (value: string) => void
  liveClock: Date
  healthLabel: string
  leftRailOpen: boolean
  rightRailOpen: boolean
  layoutMode: LayoutMode
  onToggleLeftRail: () => void
  onToggleRightRail: () => void
  onSetLayoutMode: (mode: LayoutMode) => void
}) => (
  <header className="cc-header">
    <div className="cc-header__brand">
      <div className="cc-brand-mark">
        <Icon className="cc-brand-mark__icon" name="radar" />
      </div>
      <div className="cc-brand-copy">
        <span className="cc-eyebrow" data-testid="text-app-name">
          {appName}
        </span>
        <div className="cc-status-row">
          <span className="cc-live-pill" data-testid="status-live-indicator">
            <span className="cc-live-pill__dot" />
            LIVE
          </span>
          <span className="cc-health-pill" data-testid="status-system-health">
            <Icon className="cc-health-pill__icon" name="shield" />
            {healthLabel}
          </span>
        </div>
      </div>
    </div>

    <div className="cc-header__search">
      <Icon className="cc-header__search-icon" name="search" />
      <input
        className="cc-header__input"
        type="search"
        placeholder="Search markets, leads, alerts, agents"
        value={query}
        data-testid="input-command-search"
        onChange={(event) => {
          setQuery(event.target.value)
        }}
      />
    </div>

    <div className="cc-header__actions">
      <div className="cc-clock" data-testid="text-live-clock">
        <Icon className="cc-clock__icon" name="clock" />
        {formatClockTime(liveClock)} CT
      </div>

      {/* Layout mode toggles */}
      <button
        className={classes('cc-icon-button', layoutMode === 'split' && 'is-active')}
        type="button"
        title="Split View"
        onClick={() => onSetLayoutMode('split')}
      >
        <Icon className="cc-icon-button__icon" name="layout-split" />
      </button>
      <button
        className={classes('cc-icon-button', layoutMode === 'map' && 'is-active')}
        type="button"
        title="Map Focus (⌘M)"
        onClick={() => onSetLayoutMode(layoutMode === 'map' ? 'split' : 'map')}
      >
        <Icon className="cc-icon-button__icon" name="maximize" />
      </button>
      <button
        className={classes('cc-icon-button', layoutMode === 'list' && 'is-active')}
        type="button"
        title="List View"
        onClick={() => onSetLayoutMode(layoutMode === 'list' ? 'split' : 'list')}
      >
        <Icon className="cc-icon-button__icon" name="list" />
      </button>

      {/* Mobile toggles */}
      <button className="cc-icon-button cc-icon-button--mobile" type="button" onClick={onToggleLeftRail}>
        {leftRailOpen ? 'Hide Intel' : 'Show Intel'}
      </button>
      <button className="cc-icon-button cc-icon-button--mobile" type="button" onClick={onToggleRightRail}>
        {rightRailOpen ? 'Hide Activity' : 'Show Activity'}
      </button>

      <button className="cc-icon-button" type="button" data-testid="button-alerts">
        <Icon className="cc-icon-button__icon" name="bell" />
      </button>
      <button className="cc-icon-button" type="button" data-testid="button-settings">
        <Icon className="cc-icon-button__icon" name="settings" />
      </button>
    </div>
  </header>
)

export const IntelligenceRail = ({
  data,
  filtersOpen,
  onToggleFilters,
  selectedMarketId,
  selectedAgentId,
  visibleMarkets,
  visibleAgents,
  onSelectMarket,
  onOpenMarket,
  onOpenAgent,
  marketScope,
  propertyType,
  sentiment,
  stage,
  ownerType,
  setMarketScope,
  setPropertyType,
  setSentiment,
  setStage,
  setOwnerType,
}: {
  data: LiveDashboardModel
  filtersOpen: boolean
  onToggleFilters: () => void
  selectedMarketId: string
  selectedAgentId: string
  visibleMarkets: LiveMarket[]
  visibleAgents: LiveAgent[]
  onSelectMarket: (marketId: string) => void
  onOpenMarket: (marketId: string) => void
  onOpenAgent: (agentId: string) => void
  marketScope: string
  propertyType: string
  sentiment: string
  stage: string
  ownerType: string
  setMarketScope: (value: string) => void
  setPropertyType: (value: string) => void
  setSentiment: (value: string) => void
  setStage: (value: string) => void
  setOwnerType: (value: string) => void
}) => (
  <aside className="cc-rail cc-rail--left" data-testid="intelligence-rail">
    <div className="cc-rail__header">
      <div>
        <span className="cc-eyebrow">NEXUS</span>
        <h2>Intelligence</h2>
      </div>
      <span className="cc-rail__badge">{visibleMarkets.length} MKTS</span>
    </div>

    <section className="cc-panel cc-panel--hero">
      <div className="cc-panel__header">
        <span className="cc-panel__eyebrow">HOME BASE</span>
        <span className="cc-status-chip">ACTIVE</span>
      </div>
      <div className="cc-home-grid">
        <MetricReadout label="Pipeline Value" value={data.summaryMetrics[6]?.value ?? '$0'} />
        <MetricReadout label="Health" value={data.healthLabel.split('•')[0]?.trim() ?? 'Nominal'} />
        <MetricReadout label="MKTS" value={`${data.markets.length}`} />
        <MetricReadout label="ARCS" value={`${data.mapLinks.length}`} />
      </div>
    </section>

    <section className="cc-panel">
      <div className="cc-panel__header">
        <div>
          <span className="cc-panel__eyebrow">Filters</span>
          <h3>Live Scope</h3>
        </div>
        <button
          className="cc-inline-button"
          type="button"
          data-testid="button-collapse-filters"
          onClick={onToggleFilters}
        >
          {filtersOpen ? 'Collapse' : 'Expand'}
        </button>
      </div>

      {filtersOpen ? (
        <div className="cc-filter-stack" data-testid="filter-chips">
          <FilterGroup
            label="Market"
            value={marketScope}
            options={[
              { value: 'all', label: 'All Markets' },
              ...data.markets.map((market) => ({ value: market.id, label: market.label })),
            ]}
            onSelect={setMarketScope}
          />
          <FilterGroup
            label="Property Type"
            value={propertyType}
            options={[{ value: 'all', label: 'All Types' }, ...data.filters.propertyTypes]}
            onSelect={setPropertyType}
          />
          <FilterGroup
            label="Sentiment"
            value={sentiment}
            options={[{ value: 'all', label: 'All Sentiment' }, ...data.filters.sentiments]}
            onSelect={setSentiment}
          />
          <FilterGroup
            label="Pipeline Stage"
            value={stage}
            options={[{ value: 'all', label: 'All Stages' }, ...data.filters.pipelineStages]}
            onSelect={setStage}
          />
          <FilterGroup
            label="Owner Type"
            value={ownerType}
            options={[{ value: 'all', label: 'All Owners' }, ...data.filters.ownerTypes]}
            onSelect={setOwnerType}
          />
        </div>
      ) : null}
    </section>

    <section className="cc-panel">
      <div className="cc-panel__header">
        <div>
          <span className="cc-panel__eyebrow">Active Markets</span>
          <h3>Pipeline</h3>
        </div>
      </div>
        <div className="cc-market-list">
        {visibleMarkets.map((market) => (
          <article
            key={market.id}
            className={classes(
              'cc-market-card',
              selectedMarketId === market.id && 'is-selected',
              market.campaignStatus === 'paused' && 'is-muted',
            )}
            role="button"
            tabIndex={0}
            onClick={() => {
              onSelectMarket(market.id)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onSelectMarket(market.id)
              }
            }}
          >
            <div className="cc-market-card__header">
              <div>
                <div className="cc-market-card__title">
                  <span>{market.name}</span>
                  <span className={classes('cc-market-card__status', `is-${market.campaignStatus}`)}>
                    {marketStatusLabel[market.campaignStatus]}
                  </span>
                </div>
                <span className="cc-market-card__subtitle">{market.scanLabel}</span>
              </div>
                <button
                  className="cc-inline-button"
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation()
                  onOpenMarket(market.id)
                }}
              >
                View
              </button>
            </div>
            <div className="cc-market-card__metrics">
              <span>MKT {formatCompactNumber(market.activeProperties)}</span>
              <span>SENT {formatCompactNumber(market.outboundToday)}</span>
              <span>HEAT {market.heat.toUpperCase()}</span>
            </div>
            <div className="cc-market-card__trend">
              <Sparkline values={market.hourlyOutbound} />
            </div>
            <div className="cc-market-card__footer">
              <span>{formatCurrency(market.pipelineValue)}</span>
              <span className={classes('cc-op-badge', operationalRiskClass[market.operationalRisk])}>
                {operationalRiskLabel[market.operationalRisk]}
              </span>
              <span>{market.alertCount} alerts</span>
            </div>
          </article>
        ))}
      </div>
    </section>

    <section className="cc-panel">
      <div className="cc-panel__header">
        <div>
          <span className="cc-panel__eyebrow">AI Agents</span>
          <h3>Handled</h3>
        </div>
      </div>
      <div className="cc-agent-list">
        {visibleAgents.map((agent) => (
          <button
            key={agent.id}
            className={classes('cc-agent-card', selectedAgentId === agent.id && 'is-selected')}
            type="button"
            onClick={() => {
              onOpenAgent(agent.id)
            }}
          >
            <div className="cc-agent-card__header">
              <div>
                <span className="cc-agent-card__name">{agent.name}</span>
                <span className="cc-agent-card__specialty">{agent.specialty}</span>
              </div>
              <span className={classes('cc-status-chip', `is-${agent.status}`)}>{agent.status}</span>
            </div>
            <p className="cc-agent-card__activity">{agent.activityLabel}</p>
            <div className="cc-agent-card__metrics">
              <span>Handled {agent.handledToday}</span>
              <span>Avg resp. {agent.avgResponseMinutes}m</span>
              <span>Success {agent.successRate}%</span>
            </div>
            <div className="cc-load-bar">
              <div className="cc-load-bar__fill" style={{ width: `${agent.load}%` }} />
            </div>
          </button>
        ))}
      </div>
    </section>
  </aside>
)

export const MapStage = ({
  markets,
  leads,
  selectedMarket,
  selectedLead,
  selectedMarketLeads,
  metrics,
  metricsCollapsed,
  activeDrawer,
  mapMode,
  onToggleMetrics,
  onSelectMarket,
  onOpenMarket,
  onOpenLead,
  onSetMapMode,
}: {
  markets: LiveMarket[]
  leads: LiveLead[]
  selectedMarket: LiveMarket | undefined
  selectedLead: LiveLead | undefined
  selectedMarketLeads: LiveLead[]
  metrics: LiveDashboardModel['summaryMetrics']
  metricsCollapsed: boolean
  activeDrawer: DrawerType
  mapMode: MapMode
  onToggleMetrics: () => void
  onSelectMarket: (marketId: string) => void
  onOpenMarket: (marketId: string) => void
  onOpenLead: (leadId: string) => void
  onSetMapMode: (mode: MapMode) => void
}) => (
    <section className="cc-map-stage" data-testid="map-canvas">
      <div className="cc-map-stage__controls">
        <span className="cc-live-pill">
          <span className="cc-live-pill__dot" />
          LIVE
        </span>
        <button
          className="cc-inline-button"
          type="button"
          data-testid="button-collapse-kpi"
          onClick={onToggleMetrics}
        >
          {metricsCollapsed ? 'Show KPI' : 'Hide KPI'}
        </button>
        <div className="cc-map-mode-selector" role="group" aria-label="Map intelligence mode">
          {(['leads', 'heat', 'pressure', 'distress', 'stage', 'closings', 'buyerDemand', 'aiPriority'] as MapMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              className={classes('cc-map-mode-pill', mapMode === mode && 'is-active')}
              onClick={() => onSetMapMode(mode)}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      {!metricsCollapsed ? (
        <div className="cc-metric-strip">
          {metrics.map((metric) => (
            <article key={metric.id} className={classes('cc-kpi-card', `is-${metric.tone}`)}>
              <span className="cc-kpi-card__label">{metric.label}</span>
              <strong className="cc-kpi-card__value">{metric.value}</strong>
              <span className="cc-kpi-card__detail">{metric.detail}</span>
            </article>
          ))}
        </div>
      ) : null}

      <div className="cc-map">
        {/* ── Real MapLibre geographic property map ───────────────────────── */}
        <NexusMap
          leads={leads}
          markets={markets}
          timeline={[]}
          selectedLeadId={selectedLead?.id}
          selectedMarketId={selectedMarket?.id}
          mapMode={mapMode}
          heatModeEnabled={mapMode === 'heat'}
          activeFilters={DEFAULT_MAP_FILTERS}
          activeDrawer={activeDrawer}
          onOpenLead={onOpenLead}
          onSelectMarket={onSelectMarket}
          onSetMapMode={onSetMapMode}
        />

        {selectedMarket ? (
          <div className="cc-map__market-card">
            <div className="cc-map__market-card-header">
              <div>
                <span className="cc-panel__eyebrow">{selectedMarket.label}</span>
                <h3>{selectedMarket.scanLabel}</h3>
              </div>
              <button
                className="cc-inline-button"
                type="button"
                onClick={() => { onOpenMarket(selectedMarket.id) }}
              >
                Open
              </button>
            </div>
            <div className="cc-map__market-card-grid">
              <MetricReadout label="Outbound" value={formatCompactNumber(selectedMarket.outboundToday)} />
              <MetricReadout label="Replies" value={formatCompactNumber(selectedMarket.repliesToday)} />
              <MetricReadout label="Health" value={`${selectedMarket.healthScore}`} />
              <MetricReadout label="Value" value={formatCurrency(selectedMarket.pipelineValue)} />
            </div>
          </div>
        ) : null}

        {selectedLead ? (
          <button
            className="cc-map__lead-card"
            type="button"
            onClick={() => { onOpenLead(selectedLead.id) }}
          >
            <div className="cc-map__lead-card-header">
              <span className={classes('cc-sentiment-pill', stageToneClass[selectedLead.sentiment])}>
                {selectedLead.sentiment.toUpperCase()}
              </span>
              <span className="cc-map__lead-card-intent">{selectedLead.currentIntent}</span>
            </div>
            <strong>{selectedLead.ownerName}</strong>
            <p>{selectedLead.address}</p>
            <div className="cc-map__lead-card-metrics">
              <span>{formatCurrency(selectedLead.offerAmount)} offer</span>
              <span>{selectedLead.pipelineDays}d in pipeline</span>
            </div>
          </button>
        ) : null}

        <div className="cc-map__spotlights">
          {selectedMarketLeads.map((lead) => (
            <button
              key={lead.id}
              className="cc-spotlight-card"
              type="button"
              onClick={() => { onOpenLead(lead.id) }}
            >
              <div className="cc-spotlight-card__header">
                <span className={classes('cc-sentiment-pill', stageToneClass[lead.sentiment])}>
                  {lead.sentiment.toUpperCase()}
                </span>
                <span className="cc-spotlight-card__urgency">
                  <span className="cc-spotlight-card__urg-label">URG</span>
                  {lead.urgencyScore}
                </span>
              </div>
              <strong>{lead.ownerName}</strong>
              <span>{lead.currentIntent}</span>
              {lead.heatFactors[0] ? (
                <span className="cc-spotlight-card__signal">{lead.heatFactors[0]}</span>
              ) : null}
            </button>
          ))}
        </div>

        {/* Attribution — CARTO/OSM compliance */}
        <div className="cc-map__attribution">
          <a href="https://carto.com/attributions" target="_blank" rel="noopener noreferrer">© CARTO</a>
          {' '}
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OSM</a>
          {' · '}NEXUS Intelligence Map
        </div>
      </div>
    </section>
  )

export const ActivityRail = ({
  alerts,
  timeline,
  selectedLead,
  onAcknowledgeAlert,
  onOpenLead,
}: {
  alerts: LiveAlert[]
  timeline: LiveDashboardModel['timeline']
  selectedLead: LiveLead | undefined
  onAcknowledgeAlert: (alertId: string) => void
  onOpenLead: (leadId: string) => void
}) => (
  <aside className="cc-rail cc-rail--right" data-testid="activity-rail">
    <div className="cc-rail__header">
      <div>
        <span className="cc-eyebrow">Activity</span>
        <h2>Timeline</h2>
      </div>
      <span className="cc-rail__badge">LIVE</span>
    </div>

    <section className="cc-panel">
      <div className="cc-panel__header">
        <div>
          <span className="cc-panel__eyebrow">Alerts</span>
          <h3>Active</h3>
        </div>
      </div>
      <div className="cc-alert-list">
        {alerts.length > 0 ? (
          alerts.map((alert) => (
            <article key={alert.id} className={classes('cc-alert-card', alertClass[alert.severity])}>
              <div className="cc-alert-card__header">
                <div>
                  <div className="cc-alert-card__meta">
                    <span className={classes('cc-priority-badge', `is-${alert.priority.toLowerCase()}`)}>{alert.priority}</span>
                    <span className="cc-alert-card__market">{alert.marketLabel}</span>
                  </div>
                  <strong>{alert.title}</strong>
                </div>
                <button
                  className="cc-inline-button"
                  type="button"
                  onClick={() => {
                    onAcknowledgeAlert(alert.id)
                  }}
                >
                  Acknowledge
                </button>
              </div>
              <p>{alert.detail}</p>
              <div className="cc-alert-card__footer">
                <span>
                  {alert.metricLabel}: {alert.metricValue}
                </span>
                <span>{alertPriorityLabel[alert.priority]}</span>
                <span>{formatRelativeTime(alert.timestampIso)}</span>
              </div>
            </article>
          ))
        ) : (
          <div className="cc-empty-state cc-empty-state--ok">All clear — no active alerts.</div>
        )}
      </div>
    </section>

    <section className="cc-panel">
      <div className="cc-panel__header">
        <div>
          <span className="cc-panel__eyebrow">Event</span>
          <h3>Timeline</h3>
        </div>
      </div>
      <div className="cc-timeline">
        {timeline.map((entry) => (
          <article key={entry.id} className={classes('cc-timeline__item', alertClass[entry.severity])}>
            <div className="cc-timeline__marker" />
            <div className="cc-timeline__content">
              <div className="cc-timeline__header">
                <strong>{entry.title}</strong>
                <span>{formatRelativeTime(entry.timestampIso)}</span>
              </div>
              <span className="cc-timeline__market">{entry.marketLabel}</span>
              <p>{entry.detail}</p>
            </div>
          </article>
        ))}
      </div>
    </section>

    {selectedLead ? (
      <section className="cc-panel cc-panel--spotlight">
        <div className="cc-panel__header">
          <div>
            <span className="cc-panel__eyebrow">Lead Spotlight</span>
            <h3>{selectedLead.ownerName}</h3>
          </div>
          <span className={classes('cc-sentiment-pill', stageToneClass[selectedLead.sentiment])}>
            {selectedLead.sentiment.toUpperCase()}
          </span>
        </div>
        <UrgencyBar score={selectedLead.urgencyScore} />
        <HeatFactors factors={selectedLead.heatFactors} />
        <p className="cc-spotlight-summary">{selectedLead.aiSummary}</p>
        <NBACard action={selectedLead.recommendedAction} />
        <div className="cc-spotlight-metrics">
          <span>{formatCurrency(selectedLead.estimatedValue)} est. value</span>
          <span>{formatStageLabel(selectedLead.pipelineStage)}</span>
        </div>
        <button
          className="cc-primary-button"
          type="button"
          onClick={() => {
            onOpenLead(selectedLead.id)
          }}
        >
          Full Dossier
          <Icon className="cc-primary-button__icon" name="arrow-up-right" />
        </button>
      </section>
    ) : null}
  </aside>
)

const DrawerOverlay = ({
  activeDrawer,
  children,
  onClose,
}: {
  activeDrawer: DrawerType
  children: ReactNode
  onClose: () => void
}) => {
  if (!activeDrawer) {
    return null
  }

  return (
    <div className="cc-drawer">
      <button className="cc-drawer__scrim" type="button" onClick={onClose} />
      <section className="cc-drawer__panel">
        <button
          className="cc-drawer__close"
          type="button"
          data-testid="button-close-drawer"
          onClick={onClose}
        >
          <Icon className="cc-drawer__close-icon" name="close" />
        </button>
        {children}
      </section>
    </div>
  )
}

const MarketDrawer = ({ market }: { market: LiveMarket }) => (
  <div className="cc-drawer__content">
    <div className="cc-drawer__hero">
      <span className="cc-eyebrow">{market.label}</span>
      <h2>{market.scanLabel}</h2>
      <p>{market.activeProperties.toLocaleString()} active properties</p>
    </div>

    <section className="cc-drawer-section">
      <SectionHeading label="Today's Performance" />
      <div className="cc-stat-grid">
        <DrawerStat label="Outbound" value={formatCompactNumber(market.outboundToday)} />
        <DrawerStat label="Replies" value={formatCompactNumber(market.repliesToday)} />
        <DrawerStat label="Hot Leads" value={`${market.hotLeads}`} />
        <DrawerStat label="Health" value={`${market.healthScore}`} />
      </div>
    </section>

    <section className="cc-drawer-section">
      <SectionHeading label="24-Hour Outbound Volume" />
      <div className="cc-chart-card">
        <Sparkline values={market.hourlyOutbound} />
      </div>
    </section>

    <section className="cc-drawer-section">
      <SectionHeading label="Reply Rate — Last 8 Hours" />
      <div className="cc-chart-card">
        <BarStrip values={market.recentReplyRate} />
      </div>
    </section>

    <section className="cc-drawer-section">
      <SectionHeading label="Pipeline Breakdown" />
      <div className="cc-segment-bar">
        {market.pipelineSegments.map((segment) => (
          <div
            key={segment.label}
            className="cc-segment-bar__item"
            style={{
              width: `${segment.value}%`,
              background: segment.color,
            }}
          />
        ))}
      </div>
      <div className="cc-segment-legend">
        {market.pipelineSegments.map((segment) => (
          <span key={segment.label}>
            <i style={{ background: segment.color }} />
            {segment.label} {segment.value}%
          </span>
        ))}
      </div>
    </section>

    <section className="cc-drawer-section">
      <SectionHeading label="Top ZIP Codes" />
      <div className="cc-table-card">
        <table>
          <thead>
            <tr>
              <th>ZIP</th>
              <th>Outbound</th>
              <th>Trend</th>
            </tr>
          </thead>
          <tbody>
            {market.topZips.map((row) => (
              <tr key={row.zip}>
                <td>{row.zip}</td>
                <td>{formatCompactNumber(row.outbound)}</td>
                <td>{row.trend}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>

    <section className="cc-drawer-section">
      <div className="cc-inline-stats">
        <DrawerInlineStat label="Active Conversations" value={`${Math.round(market.repliesToday * 0.3)} open`} />
        <DrawerInlineStat label="Total Pipeline Value" value={formatCurrency(market.pipelineValue)} />
      </div>
      <p className="cc-drawer__timestamp">Last sweep {formatShortDateTime(market.lastSweepIso)}</p>
    </section>
  </div>
)

const LeadDrawer = ({ lead }: { lead: LiveLead }) => (
  <div className="cc-drawer__content">
    <div className="cc-drawer__hero">
      <span className="cc-eyebrow">{lead.marketLabel}</span>
      <h2>{lead.address}</h2>
      <p>
        {lead.ownerName} • {lead.city}, {lead.stateCode} {lead.zip}
      </p>
    </div>

    <div className="cc-drawer__tags">
      <span className={classes('cc-sentiment-pill', stageToneClass[lead.sentiment])}>
        {lead.sentiment.toUpperCase()}
      </span>
      <span className="cc-chip">{formatOwnerLabel(lead.ownerType)}</span>
      <span className="cc-chip">{lead.propertyType}</span>
      <span className="cc-chip">{formatStageLabel(lead.pipelineStage)}</span>
    </div>

    <section className="cc-drawer-section">
      <SectionHeading label="Signal Profile" />
      <UrgencyBar score={lead.urgencyScore} />
      <HeatFactors factors={lead.heatFactors} />
    </section>

    <section className="cc-drawer-section">
      <SectionHeading label="AI Intelligence" />
      <div className="cc-ai-summary">
        <div className="cc-ai-summary__label">
          <Icon className="cc-ai-summary__icon" name="spark" />
          AI Analysis
        </div>
        <p>{lead.aiSummary}</p>
      </div>
    </section>

    <section className="cc-drawer-section">
      <SectionHeading label="Property Stats" />
      <div className="cc-stat-grid">
        <DrawerStat label="Outbound Attempts" value={`${lead.outboundAttempts}`} />
        <DrawerStat label="Last Outbound" value={formatRelativeTime(lead.lastOutboundIso)} />
        <DrawerStat
          label="Last Inbound"
          value={lead.lastInboundIso ? formatRelativeTime(lead.lastInboundIso) : '—'}
        />
        <DrawerStat label="Est. Value" value={formatCurrency(lead.estimatedValue)} />
        <DrawerStat label="Offer Amount" value={formatCurrency(lead.offerAmount)} />
        <DrawerStat label="Days in Pipeline" value={`${lead.pipelineDays}`} />
      </div>
    </section>

    <section className="cc-drawer-section">
      <SectionHeading label="Recent Conversation" />
      <div className="cc-message-stack">
        {lead.messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
      </div>
    </section>

    {lead.riskFlags.length > 0 ? (
      <section className="cc-drawer-section">
        <SectionHeading label="Risk Flags" />
        <RiskFlags flags={lead.riskFlags} />
      </section>
    ) : null}

    <section className="cc-drawer-section">
      <SectionHeading label="Next Best Action" />
      <NBACard action={lead.recommendedAction} />
      <div className="cc-action-row">
        <button className="cc-primary-button" type="button" data-testid="button-send-followup">
          <Icon className="cc-primary-button__icon" name="send" />
          Send Follow-up
        </button>
        <button className="cc-secondary-button" type="button" data-testid="button-make-offer">
          <Icon className="cc-primary-button__icon" name="target" />
          Make Offer
        </button>
        <button className="cc-neutral-button" type="button" data-testid="button-schedule-call">
          <Icon className="cc-primary-button__icon" name="calendar" />
          Schedule Call
        </button>
      </div>
    </section>
  </div>
)

const AgentDrawer = ({ agent, lead }: { agent: LiveAgent; lead: LiveLead }) => (
  <div className="cc-drawer__content">
    <div className="cc-drawer__hero">
      <span className="cc-eyebrow">{agent.marketLabel}</span>
      <h2>{agent.name}</h2>
      <p>
        {agent.specialty} • {lead.ownerName}
      </p>
    </div>

    <div className="cc-drawer__tags">
      <span className={classes('cc-status-chip', `is-${agent.status}`)}>{agent.status}</span>
      <span className="cc-chip">{lead.currentIntent}</span>
      <span className="cc-chip">{formatStageLabel(lead.pipelineStage)}</span>
    </div>

    <section className="cc-drawer-section">
      <SectionHeading label="Intent Score" />
      <div className="cc-intent-meter">
        <div className="cc-intent-meter__bar" style={{ width: `${Math.min(98, agent.load + 30)}%` }} />
      </div>
      <div className="cc-intent-meter__label">
        <span>Load {agent.load}%</span>
        <strong>{Math.min(98, agent.load + 30)} / 100</strong>
      </div>
    </section>

    <section className="cc-drawer-section">
      <SectionHeading label="AI Summary" />
      <div className="cc-ai-summary">
        <div className="cc-ai-summary__label">
          <Icon className="cc-ai-summary__icon" name="spark" />
          AI Analysis
        </div>
        <p>{agent.aiSummary}</p>
      </div>
    </section>

    <section className="cc-drawer-section">
      <SectionHeading label="Objections Detected" />
      <div className="cc-tag-cloud">
        {lead.objectionsDetected.map((objection) => (
          <span key={objection} className="cc-tag-cloud__item">
            {objection}
          </span>
        ))}
      </div>
    </section>

    <section className="cc-drawer-section">
      <SectionHeading label="Recommended Action" />
      <div className="cc-recommendation-card">{lead.recommendedAction}</div>
    </section>

    <section className="cc-drawer-section">
      <SectionHeading label="Conversation Thread" />
      <div className="cc-message-stack">
        {lead.messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
      </div>
    </section>

    <section className="cc-drawer-section">
      <SectionHeading label="Draft Response" />
      <div className="cc-draft-card">
        <textarea
          rows={4}
          data-testid="input-response-draft"
          defaultValue={`Hi ${lead.ownerName.split(' ')[0]}, based on what you shared, the next best step is a fast comp-backed review so you can make a confident decision without listing friction.`}
        />
        <div className="cc-draft-card__actions">
          <button className="cc-neutral-button" type="button" data-testid="button-ai-generate">
            <Icon className="cc-primary-button__icon" name="spark" />
            AI Generate
          </button>
          <button className="cc-primary-button" type="button" data-testid="button-send-response">
            <Icon className="cc-primary-button__icon" name="send" />
            Send
          </button>
        </div>
      </div>
    </section>
  </div>
)

const LeadListTable = ({
  leads,
  selectedLeadId,
  onOpenLead,
}: {
  leads: LiveLead[]
  selectedLeadId: string | null
  onOpenLead: (leadId: string) => void
}) => (
  <section className="cc-list-stage">
    <div className="cc-list-stage__header">
      <span className="cc-panel__eyebrow">ALL LEADS</span>
      <span className="cc-panel__eyebrow">{leads.length} results</span>
    </div>
    <div className="cc-table-card cc-lead-table">
      <table>
        <thead>
          <tr>
            <th>Sentiment</th>
            <th>Owner / Market</th>
            <th>Address</th>
            <th>Stage</th>
            <th>Value</th>
            <th>Intent</th>
            <th>Days</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {leads.map((lead) => (
            <tr
              key={lead.id}
              className={classes('cc-lead-table__row', lead.id === selectedLeadId && 'is-selected')}
            >
              <td>
                <span className={classes('cc-sentiment-pill', stageToneClass[lead.sentiment])}>
                  {lead.sentiment.toUpperCase()}
                </span>
              </td>
              <td>
                <strong>{lead.ownerName}</strong>
                <br />
                <span className="cc-muted">{lead.marketLabel}</span>
              </td>
              <td className="cc-muted">{lead.address}</td>
              <td>{formatStageLabel(lead.pipelineStage)}</td>
              <td>{formatCurrency(lead.offerAmount)}</td>
              <td className="cc-muted">{lead.currentIntent}</td>
              <td className="cc-muted">{lead.pipelineDays}d</td>
              <td>
                <button
                  className="cc-inline-button"
                  type="button"
                  onClick={() => { onOpenLead(lead.id) }}
                >
                  Open
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </section>
)

export const CommandHintBar = ({
  activeDrawer,
  layoutMode,
}: {
  activeDrawer: DrawerType
  layoutMode: LayoutMode
}) => (
  <div className="cc-hint-bar">
    <span>⌘K</span>
    <span>commands</span>
    <span>⌘M</span>
    <span>{layoutMode === 'map' ? 'exit map' : 'map focus'}</span>
    <span>⌘B</span>
    <span>{layoutMode === 'battlefield' ? 'exit battlefield' : 'battlefield'}</span>
    <span>[</span>
    <span>intel</span>
    <span>]</span>
    <span>activity</span>
    <span>ESC</span>
    <span>{activeDrawer ? 'close drawer' : layoutMode !== 'split' ? 'exit mode' : 'dismiss'}</span>
    <span>/dashboard/live</span>
  </div>
)

const timelineKindIcon: Record<string, string> = {
  system: 'activity',
  alert: 'alert',
  ai: 'radar',
  deal: 'trending-up',
  conversation: 'inbox',
  autopilot: 'command',
}

export const TimelineRail = ({ events }: { events: LiveActivity[] }) => {
  const railRef = useRef<HTMLDivElement>(null)
  const recent = events.slice(0, 30)

  return (
    <div className="cc-timeline-rail">
      <div className="cc-timeline-rail__track" ref={railRef}>
        {recent.map((evt) => (
          <div key={evt.id} className={classes('cc-timeline-rail__event', `is-${evt.severity}`)}>
            <Icon name={(timelineKindIcon[evt.kind] ?? 'activity') as Parameters<typeof Icon>[0]['name']} className="cc-timeline-rail__icon" />
            <span className="cc-timeline-rail__label">{evt.title}</span>
            <span className="cc-timeline-rail__time">{formatRelativeTime(evt.timestampIso)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

const MetricReadout = ({ label, value }: { label: string; value: string }) => (
  <div className="cc-metric-readout">
    <span>{label}</span>
    <strong>{value}</strong>
  </div>
)

const FilterGroup = ({
  label,
  value,
  options,
  onSelect,
}: {
  label: string
  value: string
  options: FilterOption[]
  onSelect: (value: string) => void
}) => (
  <div className="cc-filter-group">
    <span className="cc-filter-group__label">{label}</span>
    <div className="cc-filter-group__chips">
      {options.map((option) => (
        <button
          key={option.value}
          className={classes('cc-filter-chip', value === option.value && 'is-active')}
          type="button"
          onClick={() => {
            onSelect(option.value)
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  </div>
)

const DrawerStat = ({ label, value }: { label: string; value: string }) => (
  <article className="cc-drawer-stat">
    <span>{label}</span>
    <strong>{value}</strong>
  </article>
)

const DrawerInlineStat = ({ label, value }: { label: string; value: string }) => (
  <div className="cc-inline-stat">
    <span>{label}</span>
    <strong>{value}</strong>
  </div>
)

const SectionHeading = ({ label }: { label: string }) => (
  <div className="cc-section-heading">
    <span className="cc-panel__eyebrow">{label}</span>
  </div>
)

const MessageBubble = ({
  message,
}: {
  message: LiveLead['messages'][number]
}) => (
  <div className={classes('cc-message', message.direction === 'outbound' && 'is-outbound')}>
    <div className="cc-message__bubble">{message.message}</div>
    <div className="cc-message__meta">
      <span>{formatRelativeTime(message.timestampIso)}</span>
      {message.aiGenerated ? <span>AI</span> : null}
    </div>
  </div>
)

const Sparkline = ({ values }: { values: number[] }) => {
  const maxValue = Math.max(...values)
  const minValue = Math.min(...values)
  const range = Math.max(1, maxValue - minValue)
  const points = values
    .map((value, index) => {
      const x = (index / Math.max(values.length - 1, 1)) * 100
      const y = 100 - ((value - minValue) / range) * 76 - 12
      return `${x},${y}`
    })
    .join(' ')

  return (
    <svg className="cc-sparkline" viewBox="0 0 100 100" preserveAspectRatio="none">
      <polyline points={points} />
    </svg>
  )
}

const BarStrip = ({ values }: { values: number[] }) => {
  const maxValue = Math.max(...values)

  return (
    <div className="cc-bar-strip">
      {values.map((value, index) => (
        <span
          key={`${value}-${index}`}
          className="cc-bar-strip__bar"
          style={{ height: `${Math.max(18, (value / Math.max(1, maxValue)) * 100)}%` }}
        />
      ))}
    </div>
  )
}

const UrgencyBar = ({ score }: { score: number }) => {
  const tone = score >= 80 ? 'critical' : score >= 60 ? 'warning' : 'nominal'
  return (
    <div className={classes('cc-urgency-bar', `is-${tone}`)}>
      <div className="cc-urgency-bar__header">
        <span className="cc-urgency-bar__label">URGENCY</span>
        <strong className="cc-urgency-bar__score">{score}</strong>
      </div>
      <div className="cc-urgency-bar__track">
        <div className="cc-urgency-bar__fill" style={{ width: `${score}%` }} />
      </div>
    </div>
  )
}

const HeatFactors = ({ factors }: { factors: string[] }) => (
  <ul className="cc-heat-factors">
    {factors.map((factor) => (
      <li key={factor} className="cc-heat-factors__item">
        <span className="cc-heat-factors__dot" />
        <span>{factor}</span>
      </li>
    ))}
  </ul>
)

const NBACard = ({ action, confidence }: { action: string; confidence?: number }) => (
  <div className="cc-nba-card">
    <div className="cc-nba-card__header">
      <span className="cc-eyebrow">NEXT ACTION</span>
      {confidence !== undefined ? (
        <span className={classes('cc-nba-badge', confidence >= 80 ? 'is-high' : 'is-medium')}>
          {confidence}% confidence
        </span>
      ) : null}
    </div>
    <p className="cc-nba-card__text">{action}</p>
  </div>
)

const RiskFlags = ({ flags }: { flags: string[] }) => (
  <ul className="cc-risk-flags">
    {flags.map((flag) => (
      <li key={flag} className="cc-risk-flags__item">
        <Icon className="cc-risk-flags__icon" name="alert" />
        <span>{flag}</span>
      </li>
    ))}
  </ul>
)

const HealthStrip = ({ items }: { items: SystemHealthItem[] }) => (
  <div className="cc-health-strip" role="status" aria-label="System health">
    {items.map((item) => (
      <div key={item.id} className={classes('cc-health-node', `is-${item.status}`)}>
        <span className="cc-health-node__dot" />
        <span className="cc-health-node__label">{item.label}</span>
        {item.value ? <span className="cc-health-node__value">{item.value}</span> : null}
      </div>
    ))}
  </div>
)

const BattlefieldView = ({
  leads,
  selectedLeadId,
  onOpenLead,
}: {
  leads: LiveLead[]
  selectedLeadId: string
  onOpenLead: (leadId: string) => void
}) => {
  const priorityLeads = leads
    .filter((lead) => lead.urgencyScore >= 40 || lead.sentiment === 'hot')
    .sort((a, b) => b.urgencyScore - a.urgencyScore)
    .slice(0, 12)

  return (
    <section className="cc-battlefield" data-testid="battlefield-view">
      <div className="cc-battlefield__header">
        <span className="cc-eyebrow">PRIORITY BATTLEFIELD</span>
        <span className="cc-battlefield__count">{priorityLeads.length} leads in play</span>
      </div>
      <div className="cc-battlefield__grid">
        {priorityLeads.map((lead) => (
          <button
            key={lead.id}
            type="button"
            className={classes(
              'cc-battlefield-card',
              `is-${lead.sentiment}`,
              lead.id === selectedLeadId && 'is-selected',
            )}
            onClick={() => onOpenLead(lead.id)}
          >
            <div className="cc-battlefield-card__header">
              <span className={classes('cc-sentiment-pill', stageToneClass[lead.sentiment])}>
                {lead.sentiment.toUpperCase()}
              </span>
              <strong className="cc-battlefield-card__score">{lead.urgencyScore}</strong>
            </div>
            <div className="cc-battlefield-card__name">{lead.ownerName}</div>
            <div className="cc-battlefield-card__address">{lead.address}</div>
            {lead.heatFactors[0] ? (
              <div className="cc-battlefield-card__why">{lead.heatFactors[0]}</div>
            ) : null}
            <div className="cc-battlefield-card__meta">
              <span>{formatStageLabel(lead.pipelineStage)}</span>
              <span>{formatCurrency(lead.offerAmount)}</span>
            </div>
          </button>
        ))}
      </div>
    </section>
  )
}
