/**
 * NexusMap.tsx
 *
 * Real MapLibre GL geographic property map for the NEXUS command center.
 * Atmospheric intelligence layer with live event pulses, pressure fields,
 * and premium basemap with cities, roads, and neighborhood detail.
 *
 * Tile provider: CartoCDN dark-matter (free, no API key required)
 * Override with VITE_MAP_STYLE_URL env var for a custom tile provider.
 *
 * Attribution required: © CARTO  © OpenStreetMap contributors
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { FeatureCollection, Point } from 'geojson'
import type { ExpressionSpecification } from 'maplibre-gl'
import type { LiveActivity, LiveLead, LiveMarket } from './live-dashboard.adapter'
import type { ActiveMarketConfig, DashboardMapFilters, DashboardMapMode } from './map/types'
import {
  aiScoreFromLead,
  buyerDemandScoreFromLead as mapBuyerDemandScore,
  contractStatusFromLead as mapContractState,
  distressCountFromLead as mapDistressCount,
  equityPctFromLead as mapEquityPct,
  heatWeightFromLead as mapHeatWeight,
  priorityFromLead as mapPriorityFromLead,
  replyStatusFromLead as mapReplyStateFromLead,
  stageBucketFromLead as mapStageBucketFromLead,
  followUpLagMinutesFromLead as mapFollowUpLagMinutes,
  titleStateFromLead as mapTitleState,
} from './map/lead-intel'
import { buildMarketHeatFieldGeoJSON } from './map/heat-field'
import { loadSettings, resolveMapStyleUrl } from '../../../shared/settings'
import { playSound } from '../../../shared/sounds'

// ─── Types ────────────────────────────────────────────────────────────────

type MapMode = DashboardMapMode
type DrawerType = 'market' | 'lead' | 'agent' | null

type PinTier = 'hot' | 'warm' | 'neutral' | 'cold'

// GeoJSON feature property shapes ─────────────────────────────────────────

interface LeadFeatureProps {
  id: string
  ownerName: string
  address: string
  city: string
  stateCode: string
  marketId: string
  marketLabel: string
  ownerType: string
  propertyType: string
  sentiment: string
  priority: 'P0' | 'P1' | 'P2' | 'P3'
  pipelineStage: string
  stageBucket: string
  replyState: 'replied' | 'awaiting-reply' | 'no-reply'
  contractState: 'under-contract' | 'negotiating' | 'clear-to-close' | 'none'
  titleState: 'clear' | 'risk'
  distressCount: number
  followUpLagMinutes: number
  buyerDemandScore: number
  aiScore: number
  equityPct: number
  heatWeight: number
  outboundAttempts: number
  urgencyScore: number
  pinTier: PinTier
  selected: 0 | 1
}

interface MarketFeatureProps {
  id: string
  name: string
  label: string
  heat: string
  campaignStatus: string
  selected: 0 | 1
}

interface FocusFeatureProps {
  id: string
  kind: 'subject' | 'comp' | 'activity'
  score: number
}

type DetailLevel = 'national' | 'market' | 'property'
type LayerToggleKey = 'leads' | 'heat' | 'pressure' | 'distress' | 'stage' | 'closings' | 'buyerDemand' | 'aiPriority'

interface ViewportTuning {
  nationalMaxZoom: number
  propertyMinZoom: number
  zoomStep: number
  panBase: number
  flyScale: number
}

const DEFAULT_CENTER: [number, number] = [-96.0, 37.5]
const DEFAULT_ZOOM = 3.7
const GOOGLE_MAPS_API_KEY = (import.meta.env as Record<string, string | undefined>).VITE_GOOGLE_MAPS_API_KEY

const getStreetViewEmbedUrl = (lead: LiveLead): string | undefined => {
  if (!GOOGLE_MAPS_API_KEY) return undefined

  const location = `${lead.lat},${lead.lng}`
  const params = new URLSearchParams({
    key: GOOGLE_MAPS_API_KEY,
    location,
    heading: '210',
    pitch: '0',
    fov: '80',
  })

  return `https://www.google.com/maps/embed/v1/streetview?${params.toString()}`
}

const getStreetViewMapsUrl = (lead: LiveLead): string =>
  `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lead.lat},${lead.lng}`

const getViewportTuning = (): ViewportTuning => {
  if (typeof window === 'undefined') {
    return {
      nationalMaxZoom: 4.5,
      propertyMinZoom: 10.1,
      zoomStep: 0.72,
      panBase: 104,
      flyScale: 1,
    }
  }

  const width = window.innerWidth
  if (width >= 1880) {
    return {
      nationalMaxZoom: 4.2,
      propertyMinZoom: 10.9,
      zoomStep: 0.66,
      panBase: 94,
      flyScale: 0.86,
    }
  }

  return {
    nationalMaxZoom: 4.75,
    propertyMinZoom: 10.25,
    zoomStep: 0.78,
    panBase: 112,
    flyScale: 1,
  }
}

const MAP_LAYER_IDS = {
  heat: 'leads-heat',
  clusters: 'leads-clusters',
  clusterCount: 'leads-cluster-count',
  pinGlow: 'leads-pin-glow',
  pulseRing: 'leads-pulse-ring',
  pins: 'leads-pins',
  pressure: 'leads-pressure',
  distress: 'leads-distress',
  closings: 'leads-closings',
  marketsGlow: 'markets-glow',
  marketsPulse: 'markets-pulse-ring',
  marketsCore: 'markets-core',
  marketsLabel: 'markets-label',
  focusNearby: 'focus-nearby-points',
  focusNearbyLabel: 'focus-nearby-label',
  eventPulse: 'event-pulse-rings',
  buildings3d: 'nexus-3d-buildings',
  stage: 'leads-stage',
  buyerDemand: 'leads-buyer-demand',
  aiPriority: 'leads-ai-priority',
  marketHeatField: 'market-heat-field',
} as const

const SOURCE_IDS = {
  leads: 'leads',
  markets: 'markets',
  marketHeatField: 'market-heat-field',
  eventPulses: 'event-pulses',
  focusNearby: 'focus-nearby',
  terrainDem: 'nexus-dem',
} as const

const MODE_TO_TOGGLE: Record<DashboardMapMode, LayerToggleKey> = {
  leads: 'leads',
  heat: 'heat',
  pressure: 'pressure',
  distress: 'distress',
  closings: 'closings',
  stage: 'stage',
  buyerDemand: 'buyerDemand',
  aiPriority: 'aiPriority',
}

// ─── Coordinate guard ─────────────────────────────────────────────────────

const isValidCoord = (lat: number, lng: number): boolean =>
  Number.isFinite(lat) && Number.isFinite(lng) &&
  lat !== 0 && lng !== 0 &&
  lat >= -90 && lat <= 90 &&
  lng >= -180 && lng <= 180

// ─── Pin tier computation ─────────────────────────────────────────────────

function computePinTier(lead: LiveLead, mode: MapMode): PinTier {
  switch (mode) {
    case 'leads':
      return lead.sentiment as PinTier
    case 'distress': {
      const tiers: Partial<Record<LiveLead['ownerType'], PinTier>> = {
        'tax-delinquent': 'hot',
        estate: 'warm',
        absentee: 'warm',
        corporate: 'neutral',
        'owner-occupied': 'cold',
      }
      return tiers[lead.ownerType] ?? 'neutral'
    }
    case 'heat':
      return lead.urgencyScore >= 80 ? 'hot'
        : lead.urgencyScore >= 60 ? 'warm'
        : lead.urgencyScore >= 40 ? 'neutral'
        : 'cold'
    case 'stage': {
      const tiers: Partial<Record<LiveLead['pipelineStage'], PinTier>> = {
        'under-contract': 'hot',
        negotiating: 'hot',
        responding: 'warm',
        contacted: 'neutral',
        new: 'cold',
      }
      return tiers[lead.pipelineStage] ?? 'neutral'
    }
    case 'pressure':
      return lead.outboundAttempts >= 7 ? 'hot'
        : lead.outboundAttempts >= 5 ? 'warm'
        : lead.outboundAttempts >= 3 ? 'neutral'
        : 'cold'
    case 'closings':
      return lead.pipelineStage === 'under-contract' ||
        lead.pipelineStage === 'negotiating'
        ? 'hot' : 'cold'
    case 'buyerDemand':
      return mapBuyerDemandScore(lead) >= 75 ? 'hot'
        : mapBuyerDemandScore(lead) >= 58 ? 'warm'
        : mapBuyerDemandScore(lead) >= 40 ? 'neutral'
        : 'cold'
    case 'aiPriority': {
      const aiScore = Math.round((lead.urgencyScore * 0.55) + (lead.opportunityScore * 0.45))
      return aiScore >= 82 ? 'hot'
        : aiScore >= 64 ? 'warm'
        : aiScore >= 46 ? 'neutral'
        : 'cold'
    }
  }
}

// ─── GeoJSON builders ─────────────────────────────────────────────────────

function buildLeadsGeoJSON(
  leads: LiveLead[],
  mode: DashboardMapMode,
  selectedLeadId: string | undefined,
): FeatureCollection<Point, LeadFeatureProps> {
  return {
    type: 'FeatureCollection',
    features: leads
      .filter((l) => isValidCoord(l.lat, l.lng))
      .map((lead) => ({
        // Keep weighting calculation in-source so mode and filters can update layers
        // without remounting the map instance.
        type: 'Feature' as const,
        geometry: {
          type: 'Point' as const,
          coordinates: [lead.lng, lead.lat],
        },
        properties: {
          id: lead.id,
          ownerName: lead.ownerName,
          address: lead.address,
          city: lead.city,
          stateCode: lead.stateCode,
          marketId: lead.marketId,
          marketLabel: lead.marketLabel,
          ownerType: lead.ownerType,
          propertyType: lead.propertyType,
          sentiment: lead.sentiment,
          priority: mapPriorityFromLead(lead),
          pipelineStage: lead.pipelineStage,
          stageBucket: mapStageBucketFromLead(lead),
          replyState: mapReplyStateFromLead(lead),
          contractState: mapContractState(lead),
          titleState: mapTitleState(lead),
          distressCount: mapDistressCount(lead),
          followUpLagMinutes: mapFollowUpLagMinutes(lead),
          buyerDemandScore: mapBuyerDemandScore(lead),
          aiScore: aiScoreFromLead(lead),
          equityPct: mapEquityPct(lead),
          heatWeight: mapHeatWeight(lead, mode),
          outboundAttempts: lead.outboundAttempts,
          urgencyScore: lead.urgencyScore,
          pinTier: computePinTier(lead, mode),
          selected: lead.id === selectedLeadId ? 1 : 0,
        } satisfies LeadFeatureProps,
      })),
  }
}

function buildFocusNearbyGeoJSON(
  leads: LiveLead[],
  selectedLeadId: string | undefined,
): FeatureCollection<Point, FocusFeatureProps> {
  if (!selectedLeadId) {
    return { type: 'FeatureCollection', features: [] }
  }

  const subject = leads.find((l) => l.id === selectedLeadId)
  if (!subject || !isValidCoord(subject.lat, subject.lng)) {
    return { type: 'FeatureCollection', features: [] }
  }

  const comparables = leads
    .filter((lead) =>
      lead.id !== subject.id &&
      lead.marketId === subject.marketId &&
      isValidCoord(lead.lat, lead.lng),
    )
    .sort((a, b) => b.urgencyScore - a.urgencyScore)
    .slice(0, 14)

  const features: Array<GeoJSON.Feature<Point, FocusFeatureProps>> = [
    {
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [subject.lng, subject.lat],
      },
      properties: {
        id: subject.id,
        kind: 'subject',
        score: subject.urgencyScore,
      },
    },
    ...comparables.map((lead, index) => {
      const kind: FocusFeatureProps['kind'] = index % 3 === 0 ? 'activity' : 'comp'
      return {
        type: 'Feature' as const,
        geometry: {
          type: 'Point' as const,
          coordinates: [lead.lng, lead.lat],
        },
        properties: {
          id: lead.id,
          kind,
          score: lead.urgencyScore,
        },
      }
    }),
  ]

  return {
    type: 'FeatureCollection',
    features,
  }
}

function buildMarketsGeoJSON(
  markets: LiveMarket[],
  selectedMarketId: string | undefined,
): FeatureCollection<Point, MarketFeatureProps> {
  return {
    type: 'FeatureCollection',
    features: markets
      .filter((m) => isValidCoord(m.lat, m.lng))
      .map((market) => ({
        type: 'Feature' as const,
        geometry: {
          type: 'Point' as const,
          coordinates: [market.lng, market.lat],
        },
        properties: {
          id: market.id,
          name: market.name,
          label: market.label,
          heat: market.heat,
          campaignStatus: market.campaignStatus,
          selected: market.id === selectedMarketId ? 1 : 0,
        } satisfies MarketFeatureProps,
      })),
  }
}

// ─── Map style ────────────────────────────────────────────────────────────
// CartoCDN dark-matter (WITH labels) — free, no API key, rich detail at
// all zoom levels including cities, streets, neighborhoods, POIs.
// Override via VITE_MAP_STYLE_URL for a custom tile provider.

function getMapStyleUrl(): string {
  const settings = loadSettings()
  return resolveMapStyleUrl(settings.mapTheme)
}

// ─── Heat palette presets ─────────────────────────────────────────────────

type HeatColorStops = Array<[number, string]>

const HEAT_PALETTES: Record<string, HeatColorStops> = {
  default: [
    [0,    'rgba(0,0,0,0)'],
    [0.03, 'rgba(8,14,36,0.12)'],
    [0.08, 'rgba(12,28,68,0.22)'],
    [0.15, 'rgba(16,52,110,0.35)'],
    [0.25, 'rgba(24,90,160,0.45)'],
    [0.38, 'rgba(56,208,240,0.52)'],
    [0.50, 'rgba(80,220,210,0.58)'],
    [0.62, 'rgba(180,190,80,0.62)'],
    [0.74, 'rgba(216,149,48,0.72)'],
    [0.86, 'rgba(212,64,76,0.82)'],
    [1.0,  'rgba(220,40,60,0.92)'],
  ],
  infrared: [
    [0,    'rgba(0,0,0,0)'],
    [0.05, 'rgba(20,8,40,0.15)'],
    [0.15, 'rgba(60,10,80,0.30)'],
    [0.30, 'rgba(120,20,100,0.45)'],
    [0.45, 'rgba(180,40,60,0.55)'],
    [0.60, 'rgba(220,80,30,0.65)'],
    [0.75, 'rgba(240,140,20,0.75)'],
    [0.90, 'rgba(255,200,60,0.85)'],
    [1.0,  'rgba(255,240,140,0.95)'],
  ],
  ocean: [
    [0,    'rgba(0,0,0,0)'],
    [0.05, 'rgba(4,12,30,0.12)'],
    [0.12, 'rgba(8,24,60,0.22)'],
    [0.22, 'rgba(12,48,100,0.35)'],
    [0.35, 'rgba(20,80,140,0.45)'],
    [0.50, 'rgba(32,120,180,0.55)'],
    [0.65, 'rgba(56,180,220,0.62)'],
    [0.80, 'rgba(100,220,240,0.72)'],
    [0.92, 'rgba(160,240,250,0.82)'],
    [1.0,  'rgba(220,255,255,0.90)'],
  ],
  arctic: [
    [0,    'rgba(0,0,0,0)'],
    [0.05, 'rgba(6,10,20,0.10)'],
    [0.15, 'rgba(16,30,60,0.22)'],
    [0.30, 'rgba(30,60,120,0.35)'],
    [0.45, 'rgba(60,120,200,0.48)'],
    [0.60, 'rgba(120,180,240,0.58)'],
    [0.75, 'rgba(180,220,255,0.68)'],
    [0.90, 'rgba(220,240,255,0.80)'],
    [1.0,  'rgba(240,250,255,0.90)'],
  ],
}

function buildHeatColorExpr(): ExpressionSpecification {
  const settings = loadSettings()
  const palette = HEAT_PALETTES[settings.heatPalette] ?? HEAT_PALETTES.default
  const flat: Array<number | string> = []
  for (const [stop, color] of palette) {
    flat.push(stop, color)
  }
  return ['interpolate', ['linear'], ['heatmap-density'], ...flat] as ExpressionSpecification
}

// ─── Event pulse system ───────────────────────────────────────────────────
// Queued from timeline events, rendered as expanding color-coded rings

interface EventPulse {
  lng: number
  lat: number
  color: string
  startTime: number
  duration: number
}

const EVENT_COLOR: Record<string, string> = {
  conversation: '#38d0f0',  // cyan
  alert:        '#d4404c',  // red
  deal:         '#2cb87a',  // green
  ai:           '#9966ff',  // purple
  autopilot:    '#9966ff',  // purple
  system:       '#d89530',  // amber
}

const PULSE_DURATION = 3200  // ms — slower, more cinematic ring expansion

// ─── Paint expressions ────────────────────────────────────────────────────

const PIN_COLOR_EXPR: ExpressionSpecification = [
  'match', ['get', 'pinTier'],
  'hot',     '#d4404c',
  'warm',    '#d89530',
  'neutral', '#38d0f0',
  /* default (cold) */ '#4e6e88',
]

// ─── Component ────────────────────────────────────────────────────────────

export interface NexusMapProps {
  leads: LiveLead[]
  markets: LiveMarket[]
  marketConfigs?: ActiveMarketConfig[]
  timeline: LiveActivity[]
  selectedLeadId: string | undefined
  selectedMarketId: string | undefined
  mapMode: DashboardMapMode
  heatModeEnabled?: boolean
  activeFilters?: DashboardMapFilters
  activeDrawer: DrawerType
  onOpenLead: (id: string) => void
  onSelectMarket: (id: string) => void
  onToggleLeftPanel?: () => void
  onToggleRightPanel?: () => void
  onOpenCommandMapOverlay?: () => void
  onOpenDashboardPalette?: () => void
  onClearTemporaryPanels?: () => void
  onSetMapMode?: (mode: DashboardMapMode) => void
  onToggleHeatMode?: () => void
  onClearHeatAndFilters?: () => void
  onFocusFilterSearch?: () => void
}

export const NexusMap = ({
  leads,
  markets,
  marketConfigs = [],
  timeline,
  selectedLeadId,
  selectedMarketId,
  mapMode,
  heatModeEnabled = false,
  activeFilters,
  activeDrawer,
  onOpenLead,
  onSelectMarket,
  onToggleLeftPanel,
  onToggleRightPanel,
  onOpenCommandMapOverlay,
  onOpenDashboardPalette,
  onClearTemporaryPanels,
  onSetMapMode,
  onToggleHeatMode,
  onClearHeatAndFilters,
  onFocusFilterSearch,
}: NexusMapProps) => {
  const [streetViewOpen, setStreetViewOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const hoverPopupRef = useRef<maplibregl.Popup | null>(null)
  const mapReadyRef = useRef(false)
  const eventPulsesRef = useRef<EventPulse[]>([])
  const lastTimelineCountRef = useRef(0)
  const detailLevelRef = useRef<DetailLevel>('national')
  const viewportTuningRef = useRef<ViewportTuning>(getViewportTuning())
  const pitchEnabledRef = useRef(false)
  const heatModeEnabledRef = useRef(heatModeEnabled)
  const terrainEnabledRef = useRef(false)
  const buildingsEnabledRef = useRef(false)
  const labelsEnabledRef = useRef(true)
  const baseSymbolLayerIdsRef = useRef<string[]>([])
  const buildingsSourceRef = useRef<{ source: string; sourceLayer: string } | null>(null)
  const layerTogglesRef = useRef<Record<LayerToggleKey, boolean>>({
    leads: true,
    heat: heatModeEnabled,
    pressure: false,
    distress: false,
    stage: false,
    closings: false,
    buyerDemand: false,
    aiPriority: false,
  })

  // Stable refs for callbacks — avoid stale closures in map event listeners
  const onOpenLeadRef = useRef(onOpenLead)
  const onSelectMarketRef = useRef(onSelectMarket)
  onOpenLeadRef.current = onOpenLead
  onSelectMarketRef.current = onSelectMarket

  // Latest prop values for use inside the async `load` handler
  const leadsRef = useRef(leads)
  const marketsRef = useRef(markets)
  const mapModeRef = useRef(mapMode)
  const selectedLeadIdRef = useRef(selectedLeadId)
  const selectedMarketIdRef = useRef(selectedMarketId)
  const marketConfigsRef = useRef(marketConfigs)
  leadsRef.current = leads
  marketsRef.current = markets
  marketConfigsRef.current = marketConfigs
  mapModeRef.current = mapMode
  heatModeEnabledRef.current = heatModeEnabled
  selectedLeadIdRef.current = selectedLeadId
  selectedMarketIdRef.current = selectedMarketId

  const leadsGeoJSON = useMemo(
    () => buildLeadsGeoJSON(leads, mapMode, selectedLeadId),
    [leads, mapMode, selectedLeadId],
  )

  const marketsGeoJSON = useMemo(
    () => buildMarketsGeoJSON(markets, selectedMarketId),
    [markets, selectedMarketId],
  )

  const focusNearbyGeoJSON = useMemo(
    () => buildFocusNearbyGeoJSON(leads, selectedLeadId),
    [leads, selectedLeadId],
  )

  const marketHeatFieldGeoJSON = useMemo(
    () => buildMarketHeatFieldGeoJSON(marketConfigs, 0),
    [marketConfigs],
  )

  const selectedLeadForMapCard = selectedLeadId
    ? leads.find((lead) => lead.id === selectedLeadId)
    : undefined
  const streetViewEmbedUrl = selectedLeadForMapCard ? getStreetViewEmbedUrl(selectedLeadForMapCard) : undefined
  const streetViewMapsUrl = selectedLeadForMapCard ? getStreetViewMapsUrl(selectedLeadForMapCard) : undefined

  useEffect(() => {
    setStreetViewOpen(false)
  }, [selectedLeadId])

  const setLayerVisible = (layerId: string, visible: boolean) => {
    const map = mapRef.current
    if (!map || !map.getLayer(layerId)) return
    map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none')
  }

  const applyLayerVisibility = () => {
    const map = mapRef.current
    if (!map || !mapReadyRef.current) return

    const detail = detailLevelRef.current
    const toggles = layerTogglesRef.current
    const heatEnabled = heatModeEnabledRef.current || mapModeRef.current === 'heat'

    const showMarket = detail === 'national' || detail === 'market'
    const showPins = detail !== 'national'
    const showClusters = detail !== 'property'
    const showHeat = heatEnabled && toggles.heat && detail !== 'property'
    const showFocusNearby = detail === 'property'

    setLayerVisible(MAP_LAYER_IDS.heat, showHeat)
    setLayerVisible(MAP_LAYER_IDS.marketHeatField, showHeat)
    setLayerVisible(MAP_LAYER_IDS.clusters, showClusters)
    setLayerVisible(MAP_LAYER_IDS.clusterCount, showClusters)
    setLayerVisible(MAP_LAYER_IDS.pinGlow, showPins)
    setLayerVisible(MAP_LAYER_IDS.pulseRing, showPins)
    setLayerVisible(MAP_LAYER_IDS.pins, showPins)
    setLayerVisible(MAP_LAYER_IDS.marketsGlow, showMarket)
    setLayerVisible(MAP_LAYER_IDS.marketsPulse, showMarket)
    setLayerVisible(MAP_LAYER_IDS.marketsCore, showMarket)
    setLayerVisible(MAP_LAYER_IDS.marketsLabel, showMarket && labelsEnabledRef.current)
    setLayerVisible(MAP_LAYER_IDS.pressure, toggles.pressure && detail !== 'national')
    setLayerVisible(MAP_LAYER_IDS.distress, toggles.distress && detail !== 'national')
    setLayerVisible(MAP_LAYER_IDS.stage, toggles.stage && detail !== 'national')
    setLayerVisible(MAP_LAYER_IDS.closings, toggles.closings && detail !== 'national')
    setLayerVisible(MAP_LAYER_IDS.buyerDemand, toggles.buyerDemand && detail !== 'national')
    setLayerVisible(MAP_LAYER_IDS.aiPriority, toggles.aiPriority && detail !== 'national')
    setLayerVisible(MAP_LAYER_IDS.focusNearby, showFocusNearby)
    setLayerVisible(MAP_LAYER_IDS.focusNearbyLabel, showFocusNearby && labelsEnabledRef.current)

    if (buildingsEnabledRef.current) {
      const shouldShowBuildings = detail === 'property' || map.getZoom() >= 13.5
      setLayerVisible(MAP_LAYER_IDS.buildings3d, shouldShowBuildings)
    }
  }

  const setDetailLevelFromZoom = (zoom: number) => {
    const tuning = viewportTuningRef.current
    const tunedNext: DetailLevel = zoom <= tuning.nationalMaxZoom
      ? 'national'
      : zoom >= tuning.propertyMinZoom
        ? 'property'
        : 'market'

    if (tunedNext !== detailLevelRef.current) {
      detailLevelRef.current = tunedNext
    }
    applyLayerVisibility()
  }

  const flyToNational = () => {
    const map = mapRef.current
    if (!map || !mapReadyRef.current) return
    const tuning = viewportTuningRef.current
    detailLevelRef.current = 'national'
    map.flyTo({
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      pitch: 0,
      bearing: 0,
      duration: Math.round(1080 * tuning.flyScale),
      essential: true,
    })
    applyLayerVisibility()
  }

  const flyToMarket = (marketId: string) => {
    const map = mapRef.current
    if (!map || !mapReadyRef.current) return
    const tuning = viewportTuningRef.current
    const market = marketsRef.current.find((m) => m.id === marketId)
    if (!market || !isValidCoord(market.lat, market.lng)) return
    detailLevelRef.current = 'market'
    map.flyTo({
      center: [market.lng, market.lat],
      zoom: Math.max(map.getZoom(), 8.4),
      pitch: pitchEnabledRef.current ? 46 : 0,
      duration: Math.round(920 * tuning.flyScale),
      essential: true,
    })
    applyLayerVisibility()
  }

  const flyToProperty = (leadId: string) => {
    const map = mapRef.current
    if (!map || !mapReadyRef.current) return
    const tuning = viewportTuningRef.current
    const lead = leadsRef.current.find((l) => l.id === leadId)
    if (!lead || !isValidCoord(lead.lat, lead.lng)) return
    detailLevelRef.current = 'property'
    map.flyTo({
      center: [lead.lng, lead.lat],
      zoom: Math.max(map.getZoom(), 13.2),
      pitch: pitchEnabledRef.current ? 52 : 20,
      offset: activeDrawer === 'lead' ? [-190, 10] : [0, 0],
      duration: Math.round(860 * tuning.flyScale),
      essential: true,
    })
    applyLayerVisibility()
  }

  const ensureTerrainSource = () => {
    const map = mapRef.current
    if (!map || map.getSource(SOURCE_IDS.terrainDem)) return
    map.addSource(SOURCE_IDS.terrainDem, {
      type: 'raster-dem',
      url: 'https://demotiles.maplibre.org/terrain-tiles/tiles.json',
      tileSize: 256,
      maxzoom: 14,
    })
  }

  const enterTactical3D = () => {
    const map = mapRef.current
    if (!map || !mapReadyRef.current) return
    const tuning = viewportTuningRef.current
    pitchEnabledRef.current = true
    map.easeTo({ pitch: 52, duration: Math.round(540 * tuning.flyScale) })
    applyLayerVisibility()
  }

  const exitTactical3D = () => {
    const map = mapRef.current
    if (!map || !mapReadyRef.current) return
    const tuning = viewportTuningRef.current
    pitchEnabledRef.current = false
    map.easeTo({ pitch: 0, bearing: 0, duration: Math.round(540 * tuning.flyScale) })
    applyLayerVisibility()
  }

  const toggleTerrain = () => {
    const map = mapRef.current
    if (!map || !mapReadyRef.current) return
    if (!terrainEnabledRef.current) {
      try {
        ensureTerrainSource()
        map.setTerrain({ source: SOURCE_IDS.terrainDem, exaggeration: 1.15 })
        terrainEnabledRef.current = true
      } catch {
        terrainEnabledRef.current = false
      }
      return
    }
    map.setTerrain(null)
    terrainEnabledRef.current = false
  }

  const ensureBuildingsLayer = () => {
    const map = mapRef.current
    if (!map || map.getLayer(MAP_LAYER_IDS.buildings3d)) return

    if (!buildingsSourceRef.current) {
      const style = map.getStyle()
      const buildingLayer = style.layers?.find((layer) =>
        layer.type === 'fill' &&
        !!(layer as { source?: string })?.source &&
        String((layer as { 'source-layer'?: string })['source-layer'] ?? '').includes('building'),
      ) as (maplibregl.LayerSpecification & { source?: string; 'source-layer'?: string }) | undefined

      if (!buildingLayer?.source || !buildingLayer['source-layer']) {
        return
      }

      buildingsSourceRef.current = {
        source: buildingLayer.source,
        sourceLayer: buildingLayer['source-layer'],
      }
    }

    const buildingMeta = buildingsSourceRef.current
    if (!buildingMeta) return

    map.addLayer({
      id: MAP_LAYER_IDS.buildings3d,
      type: 'fill-extrusion',
      source: buildingMeta.source,
      'source-layer': buildingMeta.sourceLayer,
      minzoom: 12,
      paint: {
        'fill-extrusion-color': 'rgba(148, 163, 184, 0.55)',
        'fill-extrusion-height': [
          'interpolate',
          ['linear'],
          ['zoom'],
          12, 0,
          15, ['coalesce', ['get', 'render_height'], ['get', 'height'], 24],
        ],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], ['get', 'min_height'], 0],
        'fill-extrusion-opacity': 0.66,
      },
      layout: { visibility: 'none' },
    } as maplibregl.LayerSpecification)
  }

  const toggleBuildings = () => {
    const map = mapRef.current
    if (!map || !mapReadyRef.current) return
    if (!buildingsEnabledRef.current) {
      try {
        ensureBuildingsLayer()
      } catch {
        return
      }
      buildingsEnabledRef.current = true
      applyLayerVisibility()
      return
    }
    buildingsEnabledRef.current = false
    setLayerVisible(MAP_LAYER_IDS.buildings3d, false)
  }

  const toggleLabels = () => {
    const map = mapRef.current
    if (!map || !mapReadyRef.current) return
    labelsEnabledRef.current = !labelsEnabledRef.current

    for (const id of baseSymbolLayerIdsRef.current) {
      if (map.getLayer(id)) {
        map.setLayoutProperty(id, 'visibility', labelsEnabledRef.current ? 'visible' : 'none')
      }
    }

    applyLayerVisibility()
  }

  // ── Mount / unmount ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return

    const settings = loadSettings()

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: getMapStyleUrl(),
      center: [-96, 37.5],
      zoom: settings.defaultZoom,
      minZoom: 2,
      maxZoom: 17,
      attributionControl: false,
      renderWorldCopies: false,
      pitchWithRotate: false,
      dragRotate: false,
      fadeDuration: 350,  // smoother tile/feature transitions
    })

    mapRef.current = map

    // Compact attribution for CARTO/OSM compliance
    map.addControl(
      new maplibregl.AttributionControl({ compact: true }),
      'bottom-right',
    )

    map.on('load', () => {
      // Read from refs so we always get latest props, even if they changed
      // during the async style load
      const curLeads = leadsRef.current
      const curMarkets = marketsRef.current
      const curMode = mapModeRef.current
      const curSelectedLead = selectedLeadIdRef.current
      const curSelectedMarket = selectedMarketIdRef.current

      // ── Sources ─────────────────────────────────────────────────
      map.addSource('leads', {
        type: 'geojson',
        data: buildLeadsGeoJSON(curLeads, curMode, curSelectedLead),
      })

      map.addSource('markets', {
        type: 'geojson',
        data: buildMarketsGeoJSON(curMarkets, curSelectedMarket),
      })

      map.addSource(SOURCE_IDS.focusNearby, {
        type: 'geojson',
        data: buildFocusNearbyGeoJSON(curLeads, curSelectedLead),
      })

      map.addSource(SOURCE_IDS.marketHeatField, {
        type: 'geojson',
        data: buildMarketHeatFieldGeoJSON(marketConfigsRef.current, 0),
      })

      const style = map.getStyle()
      baseSymbolLayerIdsRef.current = (style.layers ?? [])
        .filter((layer) => layer.type === 'symbol')
        .map((layer) => layer.id)

      // ── Heatmap ─────────────────────────────────────────────────
      // Atmospheric pressure layer with settings-driven palette.
      // Wider radius creates blended fields rather than isolated circles.
      const heatIntensity = settings.heatIntensity
      map.addLayer({
        id: MAP_LAYER_IDS.marketHeatField,
        type: 'heatmap',
        source: SOURCE_IDS.marketHeatField,
        maxzoom: 9,
        paint: {
          'heatmap-weight': [
            'interpolate', ['linear'],
            ['get', 'weight'],
            0, 0,
            100, 2.7,
          ],
          'heatmap-intensity': [
            'interpolate', ['linear'],
            ['zoom'], 2, 0.84, 6, 1.55, 9, 0.98,
          ],
          'heatmap-color': [
            'interpolate', ['linear'], ['heatmap-density'],
            0, 'rgba(5, 9, 18, 0)',
            0.08, 'rgba(40, 99, 170, 0.22)',
            0.24, 'rgba(46, 180, 212, 0.34)',
            0.44, 'rgba(82, 210, 199, 0.44)',
            0.64, 'rgba(226, 176, 82, 0.54)',
            0.82, 'rgba(236, 131, 62, 0.64)',
            1, 'rgba(224, 92, 102, 0.74)',
          ],
          'heatmap-radius': [
            'interpolate', ['linear'],
            ['zoom'], 2, 92, 5, 128, 8, 156,
          ],
          'heatmap-opacity': [
            'interpolate', ['linear'],
            ['zoom'], 2, 0.60, 8, 0.50,
          ],
        },
      })

      map.addLayer({
        id: 'leads-heat',
        type: 'heatmap',
        source: 'leads',
        maxzoom: 11,
        paint: {
          'heatmap-weight': [
            'interpolate', ['linear'],
            ['get', 'heatWeight'], 0, 0.06 * heatIntensity, 100, 2.4 * heatIntensity,
          ],
          'heatmap-intensity': [
            'interpolate', ['linear'],
            ['zoom'], 3, 0.6 * heatIntensity, 10, 2.4 * heatIntensity,
          ],
          'heatmap-color': buildHeatColorExpr(),
          'heatmap-radius': [
            'interpolate', ['exponential', 1.5],
            ['zoom'], 3, 32, 6, 52, 10, 80,
          ],
          'heatmap-opacity': [
            'interpolate', ['linear'],
            ['zoom'], 3, 0.68, 10, 0.46,
          ],
        },
      })

      // ── Individual property pins ─────────────────────────────────
      // Outer glow halo — tier-colored blur ring
      map.addLayer({
        id: 'leads-pin-glow',
        type: 'circle',
        source: 'leads',
        paint: {
          'circle-radius': [
            'case', ['==', ['get', 'selected'], 1], 22, 14,
          ],
          'circle-blur': 0.9,
          'circle-opacity': [
            'case', ['==', ['get', 'selected'], 1], 0.50, 0.18,
          ],
          'circle-color': PIN_COLOR_EXPR,
        },
      })

      // Activity pulse ring — visible on ALL pins with tier-differentiated intensity
      map.addLayer({
        id: 'leads-pulse-ring',
        type: 'circle',
        source: 'leads',
        paint: {
          'circle-radius': [
            'match', ['get', 'pinTier'],
            'hot', 18,
            'warm', 14,
            'neutral', 12,
            10,
          ],
          'circle-blur': 0.6,
          'circle-opacity': [
            'match', ['get', 'pinTier'],
            'hot', 0.22,
            'warm', 0.12,
            'neutral', 0.08,
            0.04,
          ],
          'circle-color': PIN_COLOR_EXPR,
          'circle-stroke-width': 1.5,
          'circle-stroke-color': PIN_COLOR_EXPR,
          'circle-stroke-opacity': [
            'match', ['get', 'pinTier'],
            'hot', 0.35,
            'warm', 0.18,
            'neutral', 0.12,
            0.06,
          ],
        },
      })

      // Core dot
      map.addLayer({
        id: 'leads-pins',
        type: 'circle',
        source: 'leads',
        paint: {
          'circle-radius': [
            'case', ['==', ['get', 'selected'], 1], 9.0, 5.5,
          ],
          'circle-color': PIN_COLOR_EXPR,
          'circle-stroke-width': [
            'case', ['==', ['get', 'selected'], 1], 2.5, 1.0,
          ],
          'circle-stroke-color': [
            'case',
            ['==', ['get', 'selected'], 1], '#ffffff',
            'rgba(255,255,255,0.26)',
          ],
          'circle-opacity': 0.95,
        },
      })

      map.addLayer({
        id: MAP_LAYER_IDS.pressure,
        type: 'circle',
        source: SOURCE_IDS.leads,
        paint: {
          'circle-radius': [
            'interpolate', ['linear'],
            ['get', 'outboundAttempts'],
            0, 3,
            4, 8,
            8, 14,
          ],
          'circle-color': 'rgba(245, 184, 73, 0.30)',
          'circle-stroke-width': 1,
          'circle-stroke-color': 'rgba(245, 184, 73, 0.78)',
          'circle-opacity': 0.72,
        },
        layout: { visibility: 'none' },
      })

      map.addLayer({
        id: MAP_LAYER_IDS.distress,
        type: 'circle',
        source: SOURCE_IDS.leads,
        filter: [
          'match', ['get', 'ownerType'], ['tax-delinquent', 'estate'], true, false,
        ],
        paint: {
          'circle-radius': 9,
          'circle-color': 'rgba(248, 113, 113, 0.16)',
          'circle-stroke-width': 2,
          'circle-stroke-color': 'rgba(248, 113, 113, 0.85)',
          'circle-opacity': 0.88,
        },
        layout: { visibility: 'none' },
      })

      map.addLayer({
        id: MAP_LAYER_IDS.closings,
        type: 'circle',
        source: SOURCE_IDS.leads,
        filter: [
          'match', ['get', 'pipelineStage'], ['under-contract', 'negotiating'], true, false,
        ],
        paint: {
          'circle-radius': 7,
          'circle-color': 'rgba(62, 207, 142, 0.20)',
          'circle-stroke-width': 2,
          'circle-stroke-color': 'rgba(62, 207, 142, 0.86)',
          'circle-opacity': 0.92,
        },
        layout: { visibility: 'none' },
      })

      map.addLayer({
        id: MAP_LAYER_IDS.stage,
        type: 'circle',
        source: SOURCE_IDS.leads,
        paint: {
          'circle-radius': [
            'match', ['get', 'stageBucket'],
            'not-contacted', 4,
            'contacted', 5,
            'replied', 6,
            'negotiating', 8,
            'under-contract', 9,
            'closing', 8,
            5,
          ],
          'circle-color': [
            'match', ['get', 'stageBucket'],
            'not-contacted', 'rgba(120, 132, 150, 0.58)',
            'contacted', 'rgba(86, 153, 222, 0.58)',
            'replied', 'rgba(56, 208, 240, 0.66)',
            'negotiating', 'rgba(245, 184, 73, 0.70)',
            'under-contract', 'rgba(249, 115, 22, 0.76)',
            'closing', 'rgba(62, 207, 142, 0.74)',
            'rgba(120, 132, 150, 0.52)',
          ],
          'circle-stroke-width': 1.5,
          'circle-stroke-color': 'rgba(235, 242, 252, 0.38)',
          'circle-opacity': 0.9,
        },
        layout: { visibility: 'none' },
      })

      map.addLayer({
        id: MAP_LAYER_IDS.buyerDemand,
        type: 'circle',
        source: SOURCE_IDS.leads,
        paint: {
          'circle-radius': [
            'interpolate', ['linear'], ['get', 'buyerDemandScore'],
            0, 3,
            40, 6,
            70, 9,
            100, 12,
          ],
          'circle-color': [
            'interpolate', ['linear'], ['get', 'buyerDemandScore'],
            0, 'rgba(38, 92, 142, 0.20)',
            55, 'rgba(245, 184, 73, 0.24)',
            100, 'rgba(62, 207, 142, 0.32)',
          ],
          'circle-stroke-width': 1.4,
          'circle-stroke-color': [
            'interpolate', ['linear'], ['get', 'buyerDemandScore'],
            0, 'rgba(88, 142, 196, 0.40)',
            55, 'rgba(245, 184, 73, 0.58)',
            100, 'rgba(62, 207, 142, 0.74)',
          ],
          'circle-opacity': 0.92,
        },
        layout: { visibility: 'none' },
      })

      map.addLayer({
        id: MAP_LAYER_IDS.aiPriority,
        type: 'circle',
        source: SOURCE_IDS.leads,
        paint: {
          'circle-radius': [
            'interpolate', ['linear'], ['get', 'aiScore'],
            0, 4,
            60, 8,
            100, 12,
          ],
          'circle-color': [
            'interpolate', ['linear'], ['get', 'aiScore'],
            0, 'rgba(56, 208, 240, 0.14)',
            65, 'rgba(245, 184, 73, 0.24)',
            82, 'rgba(249, 115, 22, 0.30)',
            100, 'rgba(244, 114, 182, 0.32)',
          ],
          'circle-stroke-width': 1.6,
          'circle-stroke-color': [
            'interpolate', ['linear'], ['get', 'aiScore'],
            0, 'rgba(56, 208, 240, 0.46)',
            65, 'rgba(245, 184, 73, 0.64)',
            82, 'rgba(249, 115, 22, 0.72)',
            100, 'rgba(244, 114, 182, 0.78)',
          ],
          'circle-opacity': 0.9,
        },
        layout: { visibility: 'none' },
      })

      // ── Market centroids ─────────────────────────────────────────
      // Wide glow bloom
      map.addLayer({
        id: 'markets-glow',
        type: 'circle',
        source: 'markets',
        paint: {
          'circle-radius': [
            'case', ['==', ['get', 'selected'], 1], 38, 28,
          ],
          'circle-color': '#38d0f0',
          'circle-opacity': [
            'case', ['==', ['get', 'selected'], 1], 0.13, 0.06,
          ],
          'circle-blur': 1.2,
        },
      })

      map.addLayer({
        id: MAP_LAYER_IDS.marketsPulse,
        type: 'circle',
        source: SOURCE_IDS.markets,
        paint: {
          'circle-radius': [
            'case', ['==', ['get', 'selected'], 1], 18, 14,
          ],
          'circle-color': 'rgba(56, 208, 240, 0.15)',
          'circle-stroke-width': 1.2,
          'circle-stroke-color': 'rgba(56, 208, 240, 0.72)',
          'circle-opacity': 0.72,
          'circle-blur': 0.45,
        },
      })

      // Core ring
      map.addLayer({
        id: 'markets-core',
        type: 'circle',
        source: 'markets',
        paint: {
          'circle-radius': [
            'case', ['==', ['get', 'selected'], 1], 11, 7,
          ],
          'circle-color': '#38d0f0',
          'circle-stroke-width': 2,
          'circle-stroke-color': [
            'case', ['==', ['get', 'selected'], 1],
            '#ffffff',
            'rgba(56,208,240,0.50)',
          ],
          'circle-opacity': [
            'case', ['==', ['get', 'selected'], 1], 1.0, 0.85,
          ],
        },
      })

      // Market name label
      map.addLayer({
        id: 'markets-label',
        type: 'symbol',
        source: 'markets',
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Bold'],
          'text-size': 11,
          'text-offset': [0, -1.5],
          'text-anchor': 'bottom',
          'text-optional': true,
          'text-allow-overlap': false,
        },
        paint: {
          'text-color': '#8ac8e0',
          'text-halo-color': 'rgba(3,4,8,0.94)',
          'text-halo-width': 2,
        },
      })

      map.addLayer({
        id: MAP_LAYER_IDS.focusNearby,
        type: 'circle',
        source: SOURCE_IDS.focusNearby,
        paint: {
          'circle-radius': [
            'match', ['get', 'kind'],
            'subject', 10,
            'comp', 6,
            5,
          ],
          'circle-color': [
            'match', ['get', 'kind'],
            'subject', 'rgba(56, 208, 240, 0.16)',
            'comp', 'rgba(245, 184, 73, 0.14)',
            'rgba(148, 163, 184, 0.12)',
          ],
          'circle-stroke-width': 1.5,
          'circle-stroke-color': [
            'match', ['get', 'kind'],
            'subject', 'rgba(56, 208, 240, 0.82)',
            'comp', 'rgba(245, 184, 73, 0.70)',
            'rgba(148, 163, 184, 0.62)',
          ],
          'circle-opacity': 0.9,
        },
        layout: { visibility: 'none' },
      })

      map.addLayer({
        id: MAP_LAYER_IDS.focusNearbyLabel,
        type: 'symbol',
        source: SOURCE_IDS.focusNearby,
        layout: {
          'text-field': [
            'match', ['get', 'kind'],
            'subject', 'FOCUS',
            'comp', 'COMP',
            'ACT',
          ],
          'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Bold'],
          'text-size': 9,
          'text-offset': [0, 1.2],
          'text-anchor': 'top',
          visibility: 'none',
        },
        paint: {
          'text-color': 'rgba(220, 230, 240, 0.72)',
          'text-halo-color': 'rgba(8, 10, 12, 0.9)',
          'text-halo-width': 1.5,
        },
        filter: ['!=', ['get', 'kind'], 'subject'],
      } as maplibregl.LayerSpecification)

      // ── Event pulse layer (empty source, populated dynamically) ──
      map.addSource('event-pulses', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })

      map.addLayer({
        id: 'event-pulse-rings',
        type: 'circle',
        source: 'event-pulses',
        paint: {
          'circle-radius': ['get', 'radius'],
          'circle-color': ['get', 'color'],
          'circle-opacity': ['get', 'opacity'],
          'circle-blur': 0.6,
          'circle-stroke-width': 1.5,
          'circle-stroke-color': ['get', 'color'],
          'circle-stroke-opacity': ['*', ['get', 'opacity'], 0.6],
        },
      })

      // ── Interactions ─────────────────────────────────────────────

      // Click unclustered property pin → open right-side dossier
      map.on('click', 'leads-pins', (e) => {
        e.preventDefault()
        const feature = e.features?.[0]
        if (!feature?.properties) return
        onOpenLeadRef.current(feature.properties.id as string)
      })

      // Click cluster → expand (zoom into cluster bounds)
      map.on('click', 'leads-clusters', (e) => {
        e.preventDefault()
        const feature = e.features?.[0]
        if (!feature?.geometry || feature.geometry.type !== 'Point') return
        const clusterId = feature.properties?.cluster_id as number
        const coords = feature.geometry.coordinates as [number, number]
        const source = map.getSource('leads') as maplibregl.GeoJSONSource
        void source.getClusterExpansionZoom(clusterId).then((zoom) => {
          map.easeTo({ center: coords, zoom: zoom + 0.5, duration: 700 })
        })
      })

      // Click market centroid → select market (drives left rail + overlay card)
      map.on('click', 'markets-core', (e) => {
        e.preventDefault()
        e.originalEvent.stopPropagation()
        const feature = e.features?.[0]
        if (!feature?.properties) return
        onSelectMarketRef.current(feature.properties.id as string)
      })

      // Pointer cursors
      const clickableLayers = ['leads-pins', 'leads-clusters', 'markets-core'] as const
      for (const layer of clickableLayers) {
        map.on('mouseenter', layer, () => {
          map.getCanvas().style.cursor = 'pointer'
        })
        map.on('mouseleave', layer, () => {
          map.getCanvas().style.cursor = ''
        })
      }

      map.on('mousemove', 'leads-pins', (e) => {
        const feature = e.features?.[0]
        const geometry = feature?.geometry
        const props = feature?.properties as Partial<LeadFeatureProps> | undefined
        if (!props || !geometry || geometry.type !== 'Point') return

        const coords = geometry.coordinates as [number, number]
        const tooltipHtml = `
          <div class="cc-map-tooltip">
            <strong>${props.ownerName ?? 'Lead'}</strong>
            <span>${props.city ?? ''}${props.city ? ', ' : ''}${props.stateCode ?? ''}</span>
            <span>Temp ${String(props.sentiment ?? 'neutral').toUpperCase()} • ${props.priority ?? 'P2'}</span>
            <span>AI ${Math.round(Number(props.aiScore ?? 0))} • ${String(props.pipelineStage ?? '').replace(/-/g, ' ')}</span>
          </div>
        `

        if (!hoverPopupRef.current) {
          hoverPopupRef.current = new maplibregl.Popup({
            closeButton: false,
            closeOnClick: false,
            className: 'cc-map-tooltip-popup',
            offset: 16,
          })
        }

        hoverPopupRef.current
          .setLngLat(coords)
          .setHTML(tooltipHtml)
          .addTo(map)
      })

      map.on('mouseleave', 'leads-pins', () => {
        hoverPopupRef.current?.remove()
      })

      mapReadyRef.current = true
      setDetailLevelFromZoom(map.getZoom())

      // ── Live pulse animation — pulsing hot pins + event pulses ──
      let pulseFrame = 0
      let lastPulseTime = performance.now()
      let lastFieldUpdate = performance.now()
      const reduceMotion = typeof window !== 'undefined'
        ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
        : false

      const animatePulse = () => {
        if (!mapReadyRef.current) return
        const now = performance.now()

        // Pin pulse — smoother sinusoidal expansion cycle
        pulseFrame = (pulseFrame + 1) % 150
        const t = pulseFrame / 150
        const wave = Math.sin(t * Math.PI)
        const scale = 1 + wave * 2.2
        const opacity = 0.28 * (1 - t * 0.8)
        try {
          map.setPaintProperty('leads-pulse-ring', 'circle-radius', [
            'match', ['get', 'pinTier'],
            'hot', 10 + scale * 9,
            'warm', 8 + scale * 6,
            'neutral', 6 + scale * 4,
            5 + scale * 3,
          ])
          map.setPaintProperty('leads-pulse-ring', 'circle-opacity', [
            'match', ['get', 'pinTier'],
            'hot', opacity,
            'warm', opacity * 0.45,
            'neutral', opacity * 0.25,
            opacity * 0.12,
          ])
        } catch {
          // Layer may have been removed during cleanup
        }

        if (!reduceMotion) {
          const breathe = (Math.sin(now / 1700) + 1) * 0.5
          const heatOpacity = 0.46 + (breathe * 0.07)
          const heatIntensity = 1.35 + (breathe * 0.22)
          try {
            map.setPaintProperty(MAP_LAYER_IDS.marketHeatField, 'heatmap-opacity', heatOpacity)
            map.setPaintProperty(MAP_LAYER_IDS.marketHeatField, 'heatmap-intensity', heatIntensity)
          } catch {
            // Heat layer may not be available yet
          }

          if (now - lastFieldUpdate > 220) {
            lastFieldUpdate = now
            const phase = now / 1200
            const source = map.getSource(SOURCE_IDS.marketHeatField) as maplibregl.GeoJSONSource | undefined
            source?.setData(buildMarketHeatFieldGeoJSON(marketConfigsRef.current, phase))
          }
        }

        // Event pulse rendering — throttled to 33ms (~30fps) for smooth rings
        if (now - lastPulseTime > 33) {
          lastPulseTime = now
          const activePulses = eventPulsesRef.current
          if (activePulses.length > 0) {
            const features = activePulses
              .map((p) => {
                const elapsed = now - p.startTime
                const progress = Math.min(elapsed / p.duration, 1)
                if (progress >= 1) return null
                const eased = 1 - Math.pow(1 - progress, 4) // ease-out quartic — slower start, cinematic tail
                return {
                  type: 'Feature' as const,
                  geometry: {
                    type: 'Point' as const,
                    coordinates: [p.lng, p.lat],
                  },
                  properties: {
                    radius: 6 + eased * 52,
                    color: p.color,
                    opacity: 0.40 * Math.pow(1 - progress, 1.5),
                  },
                }
              })
              .filter(Boolean)

            // Prune expired pulses
            eventPulsesRef.current = activePulses.filter(
              (p) => now - p.startTime < p.duration,
            )

            try {
              const source = map.getSource('event-pulses') as maplibregl.GeoJSONSource | undefined
              source?.setData({
                type: 'FeatureCollection',
                features: features as Array<GeoJSON.Feature<Point>>,
              })
            } catch {
              // Source may be removed
            }
          }
        }

        requestAnimationFrame(animatePulse)
      }
      requestAnimationFrame(animatePulse)
    })

    return () => {
      mapReadyRef.current = false
      hoverPopupRef.current?.remove()
      map.remove()
      mapRef.current = null
    }
    // Mount/unmount only — prop changes handled by update effects below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Update lead GeoJSON (on leads, mapMode, or selectedLeadId change) ───
  useEffect(() => {
    if (!mapReadyRef.current || !mapRef.current) return
    const source = mapRef.current.getSource('leads') as maplibregl.GeoJSONSource | undefined
    source?.setData(leadsGeoJSON)
  }, [leadsGeoJSON])

  // ── Update market GeoJSON (on markets or selectedMarketId change) ────────
  useEffect(() => {
    if (!mapReadyRef.current || !mapRef.current) return
    const source = mapRef.current.getSource('markets') as maplibregl.GeoJSONSource | undefined
    source?.setData(marketsGeoJSON)
  }, [marketsGeoJSON])

  // ── Update focus context source ──────────────────────────────────────────
  useEffect(() => {
    if (!mapReadyRef.current || !mapRef.current) return
    const source = mapRef.current.getSource(SOURCE_IDS.focusNearby) as maplibregl.GeoJSONSource | undefined
    source?.setData(focusNearbyGeoJSON)
  }, [focusNearbyGeoJSON])

  // ── Update full-map market heat field (all active markets) ──────────────
  useEffect(() => {
    if (!mapReadyRef.current || !mapRef.current) return
    const source = mapRef.current.getSource(SOURCE_IDS.marketHeatField) as maplibregl.GeoJSONSource | undefined
    source?.setData(marketHeatFieldGeoJSON)
  }, [marketHeatFieldGeoJSON])

  // ── Sync map mode into active toggle visibility ──────────────────────────
  useEffect(() => {
    const modeToggles: Record<LayerToggleKey, boolean> = {
      leads: true,
      heat: true,
      pressure: mapMode === 'pressure',
      distress: mapMode === 'distress',
      stage: mapMode === 'stage',
      closings: mapMode === 'closings',
      buyerDemand: mapMode === 'buyerDemand',
      aiPriority: mapMode === 'aiPriority',
    }
    const key = MODE_TO_TOGGLE[mapMode]
    modeToggles[key] = true
    layerTogglesRef.current = modeToggles
    applyLayerVisibility()
    // Mode switching intentionally resets visualization toggles so each mode
    // shows a clear, deterministic layer set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapMode])

  // ── Sync external heat mode toggle ───────────────────────────────────────
  useEffect(() => {
    heatModeEnabledRef.current = heatModeEnabled
    layerTogglesRef.current.heat = heatModeEnabled
    applyLayerVisibility()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heatModeEnabled])

  // ── Update detail level only after zoom interactions complete ────────────
  useEffect(() => {
    if (!mapReadyRef.current || !mapRef.current) return
    const map = mapRef.current
    const onZoomEnd = () => setDetailLevelFromZoom(map.getZoom())
    map.on('zoomend', onZoomEnd)
    map.on('moveend', onZoomEnd)
    return () => {
      map.off('zoomend', onZoomEnd)
      map.off('moveend', onZoomEnd)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Retune camera profile for laptop vs large external displays ──────────
  useEffect(() => {
    const applyTuning = () => {
      viewportTuningRef.current = getViewportTuning()
      if (mapRef.current && mapReadyRef.current) {
        setDetailLevelFromZoom(mapRef.current.getZoom())
      }
    }

    applyTuning()
    window.addEventListener('resize', applyTuning)
    return () => {
      window.removeEventListener('resize', applyTuning)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── FlyTo selected lead when drawer opens (drawer-aware offset) ──────────
  useEffect(() => {
    if (!mapReadyRef.current || !mapRef.current) return
    if (!activeDrawer || !selectedLeadId) return
    const lead = leads.find((l) => l.id === selectedLeadId)
    if (!lead || !isValidCoord(lead.lat, lead.lng)) return
    const currentZoom = mapRef.current.getZoom()
    mapRef.current.flyTo({
      center: [lead.lng, lead.lat],
      zoom: Math.max(currentZoom, 11.5),
      // Offset left: shifts map center so the lead pin appears right-of-center,
      // leaving clear space for the right-side drawer
      offset: [-200, 20],
      duration: 1200,
      essential: true,
    })
  }, [activeDrawer, selectedLeadId, leads])

  // ── Timeline → event pulse sync ──────────────────────────────────────────
  // When new timeline events arrive, create visual pulses on the map at
  // the geographic position of the event's market centroid.
  useEffect(() => {
    if (!mapReadyRef.current) return
    const settings = loadSettings()
    const count = timeline.length
    if (count <= lastTimelineCountRef.current) {
      lastTimelineCountRef.current = count
      return
    }
    // New events since last render
    const newEvents = timeline.slice(0, count - lastTimelineCountRef.current)
    lastTimelineCountRef.current = count

    const pulseDensity = settings.pulseDensity
    const now = performance.now()

    for (const evt of newEvents) {
      // Skip based on density setting (random threshold)
      if (Math.random() > pulseDensity) continue

      // Find geographic position via related market
      const market = markets.find((m) => m.id === evt.marketId)
      if (!market || !isValidCoord(market.lat, market.lng)) continue

      const color = EVENT_COLOR[evt.kind] ?? EVENT_COLOR.system
      eventPulsesRef.current.push({
        lng: market.lng + (Math.random() - 0.5) * 0.3,
        lat: market.lat + (Math.random() - 0.5) * 0.2,
        color,
        startTime: now,
        duration: PULSE_DURATION,
      })

      // Play sound for certain event types
      if (evt.kind === 'alert' && evt.severity === 'critical') {
        playSound('alert-triggered')
      } else if (evt.kind === 'conversation') {
        playSound('inbound-reply')
      } else if (evt.kind === 'ai') {
        playSound('ai-response')
      } else if (evt.kind === 'deal') {
        playSound('contract-milestone')
      }
    }
  }, [timeline, markets])

  // ── Keyboard command map controls ────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable
      ) {
        return
      }

      // Dashboard overlays
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'm') {
        event.preventDefault()
        onOpenCommandMapOverlay?.()
        return
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        onOpenDashboardPalette?.()
        return
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        onFocusFilterSearch?.()
        return
      }

      if (event.key === '[') {
        event.preventDefault()
        onToggleLeftPanel?.()
        return
      }

      if (event.key === ']') {
        event.preventDefault()
        onToggleRightPanel?.()
        return
      }

      const map = mapRef.current
      if (!map || !mapReadyRef.current) return

      const tuning = viewportTuningRef.current
      const panDistance = event.shiftKey ? Math.round(tuning.panBase * 2.15) : tuning.panBase

      switch (event.key) {
        case 'g':
        case 'G':
          event.preventDefault()
          flyToNational()
          break
        case 'm':
        case 'M': {
          event.preventDefault()
          const validMarkets = marketsRef.current.filter((m) => isValidCoord(m.lat, m.lng))
          if (!validMarkets.length) return
          const currentIndex = validMarkets.findIndex((m) => m.id === selectedMarketIdRef.current)
          const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % validMarkets.length : 0
          const nextMarket = validMarkets[nextIndex]
          onSelectMarketRef.current(nextMarket.id)
          flyToMarket(nextMarket.id)
          break
        }
        case 'f':
        case 'F':
          event.preventDefault()
          if (selectedLeadIdRef.current) {
            flyToProperty(selectedLeadIdRef.current)
            break
          }
          if (selectedMarketIdRef.current) {
            flyToMarket(selectedMarketIdRef.current)
          }
          break
        case 'Escape':
          event.preventDefault()
          onClearTemporaryPanels?.()
          exitTactical3D()
          break
        case '+':
        case '=':
          event.preventDefault()
          map.easeTo({ zoom: Math.min(map.getZoom() + tuning.zoomStep, 17), duration: Math.round(250 * tuning.flyScale) })
          break
        case '-':
        case '_':
          event.preventDefault()
          map.easeTo({ zoom: Math.max(map.getZoom() - tuning.zoomStep, 2), duration: Math.round(250 * tuning.flyScale) })
          break
        case 'ArrowUp':
          event.preventDefault()
          map.panBy([0, -panDistance], { duration: 180 })
          break
        case 'ArrowDown':
          event.preventDefault()
          map.panBy([0, panDistance], { duration: 180 })
          break
        case 'ArrowLeft':
          event.preventDefault()
          map.panBy([-panDistance, 0], { duration: 180 })
          break
        case 'ArrowRight':
          event.preventDefault()
          map.panBy([panDistance, 0], { duration: 180 })
          break
        case 'r':
        case 'R':
          event.preventDefault()
          map.easeTo({ bearing: map.getBearing() + 18, duration: 260 })
          break
        case 'p':
        case 'P':
          event.preventDefault()
          if (pitchEnabledRef.current) {
            exitTactical3D()
          } else {
            enterTactical3D()
          }
          break
        case 't':
        case 'T':
          event.preventDefault()
          toggleTerrain()
          break
        case 'b':
        case 'B':
          event.preventDefault()
          toggleBuildings()
          break
        case 'h':
        case 'H': {
          event.preventDefault()
          if (event.shiftKey) {
            onClearHeatAndFilters?.()
            onSetMapMode?.('leads')
            heatModeEnabledRef.current = false
            layerTogglesRef.current.heat = false
            applyLayerVisibility()
            break
          }
          onToggleHeatMode?.()
          heatModeEnabledRef.current = !heatModeEnabledRef.current
          layerTogglesRef.current.heat = heatModeEnabledRef.current
          applyLayerVisibility()
          break
        }
        case 'l':
        case 'L':
          event.preventDefault()
          toggleLabels()
          break
        case '1':
          event.preventDefault()
          onSetMapMode?.('leads')
          break
        case '2':
          event.preventDefault()
          onSetMapMode?.('heat')
          break
        case '3':
          event.preventDefault()
          onSetMapMode?.('pressure')
          break
        case '4':
          event.preventDefault()
          onSetMapMode?.('distress')
          break
        case '5':
          event.preventDefault()
          onSetMapMode?.('stage')
          break
        case '6':
          event.preventDefault()
          onSetMapMode?.('closings')
          break
        default:
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [
    onOpenCommandMapOverlay,
    onOpenDashboardPalette,
    onToggleLeftPanel,
    onToggleRightPanel,
    onClearTemporaryPanels,
    onSetMapMode,
    onToggleHeatMode,
    onClearHeatAndFilters,
    onFocusFilterSearch,
  ])

  // ── Debug counts ─────────────────────────────────────────────────────────
  const validCount = leads.filter((l) => isValidCoord(l.lat, l.lng)).length
  const activeFilterCount = activeFilters
    ? [
      activeFilters.marketIds.length,
      activeFilters.temperatures.length,
      activeFilters.priorities.length,
      activeFilters.propertyTypes.length,
      activeFilters.distressSignals.length,
      activeFilters.sellerStages.length,
      activeFilters.followUpStatuses.length,
      activeFilters.replyStatuses.length,
      activeFilters.contractStatuses.length,
      activeFilters.buyerDemandOverlap !== 'all' ? 1 : 0,
      activeFilters.offerEligibility !== 'all' ? 1 : 0,
      activeFilters.aiScoreMin !== 0 || activeFilters.aiScoreMax !== 100 ? 1 : 0,
      activeFilters.equityMin !== 0 || activeFilters.equityMax !== 100 ? 1 : 0,
    ].reduce((sum, value) => sum + value, 0)
    : 0

  return (
    <div className="cc-nexus-map-wrap">
      {/* MapLibre canvas host — fills the .cc-map container */}
      <div ref={containerRef} className="cc-nexus-map" />

      {selectedLeadForMapCard ? (
        <aside className="cc-map-dossier" role="status" aria-live="polite">
          <div className="cc-map-dossier__top">
            <strong>{selectedLeadForMapCard.ownerName}</strong>
            <span>{mapPriorityFromLead(selectedLeadForMapCard)}</span>
          </div>
          <span className="cc-map-dossier__address">{selectedLeadForMapCard.address}</span>
          <div className="cc-map-dossier__meta">
            <span>{selectedLeadForMapCard.city}, {selectedLeadForMapCard.stateCode}</span>
            <span>{selectedLeadForMapCard.sentiment.toUpperCase()}</span>
            <span>AI {Math.round((selectedLeadForMapCard.urgencyScore * 0.55) + (selectedLeadForMapCard.opportunityScore * 0.45))}</span>
            <span>{selectedLeadForMapCard.pipelineStage.replace(/-/g, ' ')}</span>
          </div>
          <div className="cc-map-dossier__actions">
            <button
              type="button"
              className={streetViewOpen ? 'is-active' : ''}
              onClick={() => setStreetViewOpen((current) => !current)}
            >
              Street View
            </button>
            <button type="button" onClick={() => onOpenLead(selectedLeadForMapCard.id)}>
              Open Lead
            </button>
          </div>
        </aside>
      ) : null}

      {streetViewOpen && selectedLeadForMapCard ? (
        <aside className="cc-map-street-view" aria-label="Live Street View">
          <header>
            <div>
              <span>Live Street View</span>
              <strong>{selectedLeadForMapCard.address}</strong>
            </div>
            <button type="button" onClick={() => setStreetViewOpen(false)} aria-label="Close Street View">
              x
            </button>
          </header>
          {streetViewEmbedUrl ? (
            <iframe
              title={`${selectedLeadForMapCard.address} street view`}
              src={streetViewEmbedUrl}
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
            />
          ) : null}
          {!streetViewEmbedUrl && streetViewMapsUrl ? (
            <div className="cc-map-street-view__empty">
              <strong>Street View embed key required</strong>
              <span>Set VITE_GOOGLE_MAPS_API_KEY to show the live embedded panorama here.</span>
              <a href={streetViewMapsUrl} target="_blank" rel="noreferrer">
                Open in Google Street View
              </a>
            </div>
          ) : null}
        </aside>
      ) : null}

      {/* Debug badge — property count vs. valid geo coords */}
      <div className="cc-map__debug" aria-hidden="true">
        {validCount} / {leads.length} properties plotted{activeFilterCount > 0 ? ` • ${activeFilterCount} active filters` : ''}
      </div>

      {/* Empty state — shown when filter returns leads but none have coords */}
      {validCount === 0 && leads.length > 0 ? (
        <div className="cc-map__empty-overlay" role="status">
          <span className="cc-map__empty-icon">⌀</span>
          <span>No geo coordinates available for current filter</span>
        </div>
      ) : null}
    </div>
  )
}
