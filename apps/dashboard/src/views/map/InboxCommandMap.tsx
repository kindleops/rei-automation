import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'

import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import './map-intelligence-cards.css'
import type { FeatureCollection, GeoJsonProperties, LineString, Point, Polygon } from 'geojson'
import type { ThreadMessage } from '../../lib/data/inboxData'
import type { InboxWorkflowThread } from '../../lib/data/inboxWorkflowData'
import type { MapSourceMode } from '../../domain/inbox/inbox-layout-state'
import { findPinForThread, isMappableCoord } from '../../domain/inbox/map-selection-sync'
import { buildConversationDecision } from '../../domain/inbox/inbox-decisioning'
import { buildStreetViewUrl } from '../../domain/inbox/inbox-normalization'
import type { ViewLayoutMode } from '../../domain/inbox/view-layout'
import { useBreakpoint } from '../../modules/mobile/useBreakpoint'
import { SellerMapCard } from './seller-card/SellerMapCard'
import {
  defaultBuyerMapFilters,
  type BuyerCommandData,
  type BuyerMapFilters,
  type BuyerProfilePoint,
  type BuyerRecentPurchase,
} from '../buyer-match/buyerCommandData'
import { loadBuyerDemandLayerPoints, type BuyerDemandMetric, type BuyerDemandLayerPoint, formatShortPrice } from '../../lib/data/buyerActivityMapData'
import { loadCensusForProperty, calculateInvestorOpportunityScore, type CensusData } from '../../lib/data/censusData'
import { loadSoldCompsInBounds, type RecentSoldComp, loadCommandMapSellerPinDetail, loadCommandMapSellerPins, type CommandMapSellerPin } from '../../lib/data/commandMapData'
import {
  centerMapOnActivity,
  loadLiveActivityFeedSnapshot,
  type CommandMapActivityEvent,
  type CommandMapActivityPinSource,
  type CommandMapBounds,
  type CommandMapPerformanceSettings,
} from './commandMapLiveActivity'
import type { LiveActivityEvent } from './live-activity-engine'
import { useCommandMapLiveActivitySettings } from './useCommandMapLiveActivitySettings'
import { useCommandMapPerformanceMode } from './useCommandMapPerformanceMode'
import { CommandMapLiveActivityRail } from './components/CommandMapLiveActivityRail'
import {
  buildOverlayGeoJson,
  getCensusOverlayLegend,
  loadNationwideCensusOverlay,
  type CensusOverlayFeature,
  type CensusOverlayLegend,
  type CensusOverlayMetric,
} from '../../lib/map/censusOverlayUtils'
import {
  COMMAND_MAP_THEME_OPTIONS,
  getCommandMapBaseStyleId,
  getCommandMapTheme,
  getCommandMapThemeStyle,
  isCommandMapBasemapTheme,
  type CommandMapThemeDefinition,
  type CommandMapThemeId,
  type MapStyleMode,
} from './commandMapThemes'
import { loadPropertyIcons, normalizePropertyTypeSlug, PIN_ICON } from './pin-icons'
import {
  ACQUISITION_RADAR_CLUSTER_PROPERTIES,
  acquisitionRadarPulseOpacity,
  acquisitionRadarPulseRadius,
  buildClusterDominantIconExpr,
  buildClusterHaloExpr,
  buildClusterSemanticCoreExpr,
  buildClusterSemanticStrokeExpr,
  buildIndividualPinVisibilityFilter,
  CLUSTER_HALO_RADIUS_EXPR,
  CLUSTER_RADIUS_EXPR,
  enrichAcquisitionRadarFeature,
  MOTION_PIN_FILTER,
  PIN_GLASS_RADIUS_EXPR,
  PIN_HALO_OPACITY_EXPR,
  PIN_HALO_RADIUS_EXPR,
  PIN_HIT_RADIUS_EXPR,
  PIN_ICON_COLOR_EXPR,
  PIN_ICON_IMAGE_EXPR,
  PIN_ICON_SCALE_EXPR,
  PIN_RING_STROKE_EXPR,
  PIN_RING_WIDTH_EXPR,
} from './acquisition-radar-pin-renderer'
import { ACQUISITION_RADAR_ZOOM } from './acquisition-radar-state-matrix'
import {
  CLUSTER_COUNT_TEXT_EXPR,
  getMapPropertyFetchMode,
  getMapZoomBand,
  shouldUseAggregateSource,
  shouldUsePropertySource,
  shouldUseVectorTileSource,
} from './map-property-source'
import {
  ALL_PROPERTY_TILE_LAYER_IDS,
  applyPropertyTileEnrichmentStates,
  applyPropertyTileThemePaint,
  ensurePropertyTileSourceAndLayers,
} from './map-property-tile-integration'
import { PROPERTY_TILES_LAYER_IDS, buildPropertyTileTransformRequest } from './map-property-tile-source'
import { MapPropertyDiagnosticsOverlay, type MapPropertyDiagnostics } from './components/MapPropertyDiagnosticsOverlay'
import { isMapDiagnosticsDebugEnabled, isMapVerificationMode } from './map-property-diagnostics-debug'
import {
  computeTileAccountingDelta,
  countVisualRepresentation,
  getCoveringTileCoords,
  queryUniqueTilePropertiesInBounds,
} from './map-property-accounting'
import { assertMapRenderInvariants, findDuplicateRenderedPropertyIds } from './map-render-invariants'

import { ASSET_TYPE_ICON_COLORS, resolveAcquisitionAssetFamily } from './acquisition-radar-asset-icons'
import { getMapPinThemeTokens } from './map-pin-theme-tokens'
import {
  PIN_ICON_COLOR_COALESCED_EXPR,
  PIN_ICON_IMAGE_BY_SLUG_EXPR,
  PIN_ICON_SCALE_TOUCH_EXPR,
} from './pin-icon-expressions'

import { buildThemeIdentityCssVars, getCommandMapThemeIdentity } from './command-map-theme-identity'
import type { CommandMapIntelligenceModeId } from './command-map-intelligence-modes'
import {
  buildSellerClusterCoreExpr,
  buildSellerClusterRingExpr,
  buildSellerClusterStrokeExpr,
  resolveCommandPinRingColor,
  resolveEffectiveSellerState,
  SELLER_PIN_CLUSTER_PROPERTIES,
  UNIVERSAL_PIN_GLASS_OPACITY_EXPR,
  UNIVERSAL_PIN_GLOW_OPACITY_EXPR,
  UNIVERSAL_PIN_ICON_SCALE_EXPR,
  UNIVERSAL_PIN_RING_STROKE_EXPR,
  UNIVERSAL_PIN_RING_WIDTH_EXPR,
} from './universal-pin-system'
import { getMapThemeTokens } from './map-theme-tokens'
import {
  applyVisualPresetBasemapPaint,
  buildPresetInterfaceCssVars,
} from './map-basemap-paint'
import {
  CARTO_VECTOR_DARK_STYLE_URL,
  MAP_VISUAL_PRESET_OPTIONS,
  normalizeMapVisualPresetId,
  THEME_TRANSITION_MS,
} from './map-visual-presets'
import { fetchMapProperties } from '../../lib/api/backendClient'
import type { LocationResult } from '../../domain/command-center/command.types'
import {
  CONTACTABILITY_ORDER,
  DISPOSITION_ORDER,
  LIFECYCLE_STAGE_META,
  LIFECYCLE_STAGE_ORDER,
  OPERATIONAL_STATUS_ORDER,
  contactabilityBlocksSend,
  normalizeContactability,
  normalizeDisposition,
  normalizeLeadTemperature,
  normalizeLifecycleStage,
  normalizeOperationalStatus,
} from '../../domain/lead-state/universal-lead-state-registry'
import { UniversalLeadStateControls } from '../../domain/lead-state/UniversalLeadStateControls'
import {
  consumePendingMapComp,
  MAP_FOCUS_COMP_EVENT,
  mapFocusPayloadToSoldCompFeature,
  type MapFocusCompPayload,
} from './command-map-bridge'

export type { MapStyleMode } from './commandMapThemes'

const RAW_SOURCE_ID = 'command-pins-raw'
const CLUSTER_SOURCE_ID = 'command-pins-clustered'
const RAW_LAYER_IDS = [
  'command-pin-glow-raw',
  'command-pin-pulse-raw',
  'command-pin-unread-ring-raw',
  'command-pin-offer-ring-raw',
  'command-pin-contract-ring-raw',
  'command-pin-core-raw',
  'command-pin-icon-raw',
  'command-pin-warning-badge-raw',
] as const
const CLUSTER_POINT_LAYER_IDS = [
  'command-pin-glow-clustered',
  'command-pin-pulse-clustered',
  'command-pin-unread-ring-clustered',
  'command-pin-offer-ring-clustered',
  'command-pin-contract-ring-clustered',
  'command-pin-core-clustered',
  'command-pin-icon-clustered',
  'command-pin-warning-badge-clustered',
] as const
const CLUSTER_LAYER_IDS = [
  'command-pin-cluster-glow',
  'command-pin-cluster-core',
  'command-pin-cluster-count',
] as const
const BUYER_PURCHASE_SOURCE_ID = 'command-buyer-purchases'
const BUYER_PROFILE_SOURCE_ID = 'command-buyer-profiles'
const BUYER_TRAIL_SOURCE_ID = 'command-buyer-trail'
const BUYER_HEATMAP_LAYER_ID = 'command-buyer-heatmap'
const BUYER_PURCHASE_CLUSTER_IDS = [
  'command-buyer-cluster-glow',
  'command-buyer-cluster-core',
  'command-buyer-cluster-count',
] as const
const BUYER_PURCHASE_LAYER_IDS = [
  'command-buyer-purchase-glow',
  'command-buyer-purchase-core',
] as const
const BUYER_PROFILE_LAYER_IDS = [
  'command-buyer-profile-core',
  'command-buyer-profile-label',
] as const
const THEME_TINT_SOURCE_ID = 'command-map-theme-tint'
const THEME_TINT_LAYER_ID = 'command-map-theme-tint'
const THEME_GRID_SOURCE_ID = 'command-map-theme-grid'
const THEME_GRID_LAYER_ID = 'command-map-theme-grid'
const THEME_RADAR_SOURCE_ID = 'command-map-theme-radar'
const THEME_RADAR_LAYER_ID = 'command-map-theme-radar'
const BUYER_TRAIL_LAYER_IDS = [
  'command-buyer-trail-glow',
  'command-buyer-trail-line',
] as const

// Census + Buyer Demand overlay layer IDs
const CENSUS_SOURCE_ID = 'census-geo-source'
const BUYER_DEMAND_SOURCE_ID = 'buyer-demand-source'
const SOLD_COMPS_SOURCE_ID = 'sold-comps-source'
const SELLER_PINS_SOURCE_ID = 'seller-pins-source'

// SOURCE A — national/market aggregate clusters (canonical totals)
const MARKET_AGGREGATE_SOURCE_ID = 'map-market-aggregates'
const MARKET_AGGREGATE_LAYER_IDS = {
  halo: 'map-agg-cluster-halo',
  core: 'map-agg-cluster-core',
  ring: 'map-agg-cluster-ring',
  icon: 'map-agg-cluster-icon',
  count: 'map-agg-cluster-count',
} as const

// SOURCE B — property-level vector source (canonical properties table)
const PROPERTY_UNIVERSE_SOURCE_ID = 'inbox-property-universe'
const PROPERTY_UNIVERSE_LAYER_IDS = {
  clusterRing:  'prop-univ-cluster-ring',
  clusterCore:  'prop-univ-cluster-core',
  clusterIcon:  'prop-univ-cluster-icon',
  clusterCount: 'prop-univ-cluster-count',
  markerHit:    'prop-univ-marker-hit',
  markerGlow:   'prop-univ-marker-glow',
  markerGlass:  'prop-univ-marker-glass',
  markerRing:   'prop-univ-marker-ring',
  markerPulse:  'prop-univ-marker-pulse',
  markers:      'prop-univ-markers',
} as const

const PROPERTY_UNIVERSE_CLUSTER_MAX_ZOOM = ACQUISITION_RADAR_ZOOM.clusterMaxZoom
const SELLER_PINS_CLUSTER_MAX_ZOOM = 8

const PIN_ASSET_GLOW_COLOR_EXPR = [
  'coalesce',
  ['get', 'icon_color'],
  PIN_ICON_COLOR_COALESCED_EXPR,
] as maplibregl.ExpressionSpecification

const enrichPropertyUniverseFeatures = (
  features: GeoJSON.Feature<Point>[],
  themeId: CommandMapThemeId,
  selectedPropertyId: string | null,
  modeId: CommandMapIntelligenceModeId,
): GeoJSON.Feature<Point>[] => features.map((feature) => ({
  ...feature,
  properties: enrichAcquisitionRadarFeature(
    { properties: (feature.properties ?? {}) as Record<string, unknown> },
    themeId,
    { selectedPropertyId, modeId },
  ),
}))

const CENSUS_LAYER_IDS = {
  fill: 'census-overlay-fill',
  line: 'census-overlay-line',
  hoverLine: 'census-overlay-hover-line',
} as const
const BUYER_DEMAND_LAYER_IDS = {
  activity6mo: 'buyer-demand-activity-6mo',
  investorDemand: 'buyer-demand-investor',
  buyerHeat: 'buyer-demand-heat',
  soldPrice: 'buyer-demand-sold-price',
  soldPriceLabel: 'buyer-demand-sold-price-label',
} as const
const ALL_BUYER_DEMAND_LAYER_IDS = Object.values(BUYER_DEMAND_LAYER_IDS)
const SOLD_COMPS_LAYER_IDS = {
  hit: 'sold-comps-hit',
  marker: 'sold-comps-marker',
  icon: 'sold-comps-icon',
  label: 'sold-comps-label',
} as const
const SOLD_COMPS_CLUSTER_LAYER_IDS = {
  glow: 'sold-comps-cluster-glow',
  core: 'sold-comps-cluster-core',
  count: 'sold-comps-cluster-count',
} as const
const ALL_SOLD_COMPS_LAYER_IDS = [...Object.values(SOLD_COMPS_LAYER_IDS), ...Object.values(SOLD_COMPS_CLUSTER_LAYER_IDS)]

const SELLER_PINS_LAYER_IDS = {
  hit: 'seller-pins-hit',
  glow: 'seller-pins-glow',
  pulse: 'seller-pins-pulse',
  ring: 'seller-pins-ring',
  core: 'seller-pins-core',
  icon: 'seller-pins-icon',
  clusterGlow: 'seller-pins-cluster-glow',
  clusterCore: 'seller-pins-cluster-core',
  clusterCount: 'seller-pins-cluster-count',
} as const

const SELLER_PIN_HOVER_LAYER_IDS = [
  SELLER_PINS_LAYER_IDS.hit,
  SELLER_PINS_LAYER_IDS.core,
  SELLER_PINS_LAYER_IDS.ring,
  SELLER_PINS_LAYER_IDS.glow,
  SELLER_PINS_LAYER_IDS.pulse,
  SELLER_PINS_LAYER_IDS.clusterCore,
  SELLER_PINS_LAYER_IDS.clusterGlow,
] as const

const commandMapPinToSellerCardRecord = (
  props: CommandMapPin,
  hydratedThread: Record<string, unknown> | null,
): Record<string, unknown> => ({
  ...(hydratedThread ?? {}),
  ...props,
  property_id: props.property_id,
  master_owner_id: props.master_owner_id,
  thread_key: props.conversation_id,
  property_address_full: props.property_address_full || props.address,
  property_address: props.address,
  owner_display_name: props.owner_display_name || props.owner_name || props.seller_name,
  owner_name: props.owner_name || props.seller_name,
  canonical_e164: text(props.phone) || text((props as { canonical_e164?: string }).canonical_e164) || null,
  seller_phone: text(props.phone) || text((props as { seller_phone?: string }).seller_phone) || null,
  total_bedrooms: props.beds,
  total_baths: props.baths,
  building_square_feet: props.sqft,
  units_count: props.units,
  estimated_repair_cost: props.repair_estimate,
  owner_priority_score: props.priority_score,
  priority_score: props.priority_score,
  latest_message_at: props.last_activity_at,
  latest_direction: props.last_message_direction,
  last_inbound_at: props.last_inbound_at || props.last_reply_at,
  last_outbound_at: props.last_outbound_at,
  delivery_status: props.delivery_status,
})
const SELLER_PINS_SETTINGS_KEY = 'nexus.commandMap.sellerPinSettings.v3'
const LEGACY_SELLER_PINS_SETTINGS_KEYS = [
  'nexus.commandMap.sellerPinSettings.v2',
  'nexus.commandMap.sellerPinSettings.v1',
] as const
const SELECTED_STAR_SOURCE_ID = 'command-selected-star'
const SELECTED_STAR_LAYER_ID = 'command-selected-star-layer'
export type MapOverlayToggles = {
  roads: boolean
  cities: boolean
  poi: boolean
  zip: boolean
}

type StyleLayerLike = maplibregl.LayerSpecification & {
  id: string
  type: string
  source?: string
  'source-layer'?: string
  layout?: Record<string, unknown>
  paint?: Record<string, unknown>
}

export type InboxMapActivityMode = 'all' | 'threads' | 'sends' | 'follow_ups'

type ThreadMapState = 'new_replies' | 'needs_review' | 'waiting_on_seller' | 'negotiating' | 'follow_up_due' | 'suppressed'
type SendMapState = 'queued' | 'sending' | 'sent' | 'delivered' | 'failed' | 'replied' | 'opted_out' | 'queue_blocked'
type FollowUpMapState = 'due_now' | 'due_later_today' | 'due_tomorrow' | 'overdue' | 'stale_no_response'
type PinActivityState = ThreadMapState | SendMapState | FollowUpMapState

export type MapFilterState = {
  market: string
  stage: string
  status: string
  leadTemperature: string
  disposition: string
  contactability: string
  archiveOnly: boolean
  snoozeOnly: boolean
  automationStatus: string
  messageDirection: string
  unreadOnly: boolean
  followUpDue: boolean
  highEquity: boolean
  propertyType: string
  offerStatus: string
  contractStatus: string
  suppressionStatus: string
  dateRange: string
}

type UnmappedItem = {
  id: string
  conversation_id: string
  seller_name: string
  address: string
  reason: 'missing_coordinates'
}

type CommandMapPin = {
  id: string
  conversation_id: string
  property_id: string
  master_owner_id: string
  seller_name: string
  address: string
  city: string
  state: string
  zip: string
  lat: number
  lng: number
  market: string
  property_type: string
  beds: number | null
  baths: number | null
  sqft: number | null
  units: number | null
  estimated_value: number | null
  equity_percent: number | null
  repair_estimate: number | null
  streetview_image: string | null
  last_message: string
  last_message_direction: 'inbound' | 'outbound' | 'unknown'
  last_activity_at: string
  unread: boolean
  conversation_stage: string
  conversation_status: string
  lifecycle_stage: string
  operational_status: string
  disposition: string
  contactability_status: string
  is_archived: boolean
  snoozed_until: string | null
  stage_short_label: string
  inbox_bucket: string
  lead_temperature: string
  priority_score: number
  automation_status: string
  suppression_status: string
  next_action: string
  offer_status: string
  contract_status: string
  next_follow_up_at: string | null
  review_reason: string | null
  confidence: number
  last_inbound_at: string | null
  last_outbound_at: string | null
  last_reply_at: string | null
  queue_status: string | null
  delivery_status: string | null
  map_image: string | null
  satellite_image: string | null
  property_address_full: string | null
  property_address_city: string | null
  property_address_state: string | null
  property_address_zip: string | null
  owner_name: string | null
  owner_display_name: string | null
  owner_full_name: string | null
  owner_type: string | null
  is_corporate_owner: boolean | null
  corporate_owner: boolean | null
  owner_occupied: boolean | null
  out_of_state_owner: boolean | null
  absentee_owner: boolean | null
  ownership_years: number | null
  last_sale_date: string | null
  sale_date: string | null
  sale_price: number | null
  last_sale_price: number | null
  latest_message_body: string | null
  last_outreach_message: string | null
  reply_status: string | null
  seller_stage: string | null
  seller_state: string | null
  execution_state: string | null
  pipeline_stage: string | null
  contact_status: string | null
  sms_eligible: boolean | null
  language: string | null
  phone: string | null
  motivation_score: number | null
  final_acquisition_score: number | null
  seller_persona: string | null
  ai_seller_persona: string | null
  market_status_label: string | null
  mls_market_status: string | null
  market_sub_status_label: string | null
  building_condition: string | null
  building_quality: string | null
  construction_type: string | null
  year_built: number | null
  effective_year_built: number | null
  total_bedrooms: number | null
  total_baths: number | null
  building_square_feet: number | null
  units_count: number | null
  lot_square_feet: number | null
  lot_acreage: number | null
  estimated_repair_cost: number | null
  equity_amount: number | null
  tax_delinquent: boolean | null
  active_lien: boolean | null
  property_flags_json: unknown
  property_flags_text: string | null
  activity_mode: InboxMapActivityMode
  activity_state: PinActivityState
  activity_label: string
}

type PinFeatureProps = CommandMapPin & {
  featureType: 'pin' | 'market_cluster'
  selected: 0 | 1
  focusOpacity: number
  stageColor: string
  pulseTier: 'fast' | 'medium_fast' | 'medium' | 'slow' | 'very_slow' | 'none'
  pulseMode: 'none' | 'continuous' | 'ripple' | 'triple'
  glowStrength: number
  unreadRingColor: string
  offerRingColor: string
  contractRingColor: string
  badgeColor: string
  pinCount: number
  lockState: 0 | 1
  needsReviewBadge: 0 | 1
  followUpDueBadge: 0 | 1
  suppressedBadge: 0 | 1
  queueBlockedBadge: 0 | 1
  propTypeSlug: string
  icon_color?: string
}

type MapKpiFilterKey =
  | ThreadMapState
  | SendMapState
  | FollowUpMapState
  | 'contract_active'
  | 'offer_ready'
  | 'not_contacted'

type MapKpiChip = {
  key: MapKpiFilterKey
  label: string
  count: number
  tone: string
}

type ControlsTab = 'modes' | 'filters' | 'style' | 'intel' | 'performance'
type MapModeKey = CommandMapIntelligenceModeId
type FilterCategory = 'property' | 'prospect' | 'owner' | 'buyer' | 'saved'
type CinematicControlsState = {
  livePulses: 'off' | 'subtle' | 'full'
  pinGlow: 'off' | 'subtle' | 'full'
  eventTrail: boolean
  soundFx: 'off' | 'soft' | 'full'
  mapAtmosphere: 'clean' | 'cinematic' | 'tactical'
}

type ClusterCensusSummary = {
  id: string
  title: string
  subtitle: string
  itemCount: number
  metrics: Array<{ label: string; value: string }>
}

type MapLoadStage = 'stage_1' | 'stage_2'

type SellerPinsPerfSnapshot = {
  shown: number
  cap: number
  capHit: boolean
  cacheHit: boolean
  loadedAt: number | null
  sampled: boolean
  rpcMs: number | null
  pinsReturned: number
}

type CensusOverlaySelection = {
  feature: CensusOverlayFeature
  mode: 'hover' | 'selected'
}

type SellerPinLayerToggles = {
  sellerPins: boolean
  notContacted: boolean
  contacted: boolean
  newReplies: boolean
  positive: boolean
  negotiating: boolean
  hot: boolean
  issues: boolean
  blocked: boolean
  queued: boolean
  scheduled: boolean
  ready: boolean
  activeSending: boolean
  sent: boolean
  delivered: boolean
  failedIssue: boolean
}

const defaultSellerPinLayers: SellerPinLayerToggles = {
  sellerPins: true,
  notContacted: true,
  contacted: true,
  newReplies: true,
  positive: true,
  negotiating: true,
  hot: true,
  issues: true,
  blocked: true,
  queued: true,
  scheduled: true,
  ready: true,
  activeSending: true,
  sent: true,
  delivered: true,
  failedIssue: true,
}

const withAllSellerPinCategories = (
  overrides: Partial<SellerPinLayerToggles> = {},
): SellerPinLayerToggles => ({
  ...defaultSellerPinLayers,
  sellerPins: true,
  ...overrides,
})

type BuyerLayerToggles = {
  sellerThreads: boolean
  buyerMatches: boolean
  buyerRecentPurchases: boolean
  buyerHeatmap: boolean
  buyerProfiles: boolean
  recentSoldComps: boolean
  repeatBuyers: boolean
  corporateBuyers: boolean
  localInvestors: boolean
  retailNoise: boolean
  offMarketBuyers: boolean
  buyerFocusMode: boolean
  institutional: boolean
  landlords: boolean
  flippers: boolean
  builders: boolean
}

type BuyerFeatureProps = {
  featureType: 'buyer_purchase' | 'buyer_profile'
  buyerKey: string
  buyerName: string
  buyerTier: string
  buyerType: string
  market: string
  state: string
  zip: string
  propertyType: string
  propertyAddressFull: string
  saleDate: string
  salePrice: number
  estimatedValue: number
  matchScore: number
  confidenceScore: number
  purchaseCount: number
  category: string
  pointColor: string
  radiusWeight: number
  heatWeight: number
  pricePerSqft: number
  beds: number
  baths: number
  sqft: number
  yearBuilt: number
  buyerActivitySignal: string
  buyerEntityStrength: string
  investorFitScore: number
  compQualityScore: number
  distanceMiles: number
  focusOpacity: number
  isRecent: number
  isSelectedBuyer: number
  sourceLabel: string
}

const DEBUG_MAP_CARDS = false

type MapEntityKind = 'seller' | 'sold_comp'
type MapCardIntent = 'hover' | 'selected'
type MapCardState = {
  kind: MapEntityKind
  intent: MapCardIntent
  id: string
  anchor: { x: number; y: number }
  coordinates: [number, number]
  feature: Record<string, unknown>
  containerSize: { width: number; height: number }
  hydrating?: boolean
} | null

const resolveActiveSellerMapCard = (
  hovered: MapCardState,
  selected: MapCardState,
): MapCardState | null => {
  if (selected?.kind === 'seller') return selected
  if (hovered?.kind === 'seller') return hovered
  return null
}

const buildMapCardContainerContext = (
  map: maplibregl.Map | null,
  containerEl: HTMLElement | null,
  coordinates: [number, number],
) => {
  const containerBounds = containerEl?.getBoundingClientRect()
  const containerWidth = containerBounds?.width ?? window.innerWidth
  const containerHeight = containerBounds?.height ?? window.innerHeight
  const pixelPoint = map?.project(coordinates) ?? { x: containerWidth / 2, y: containerHeight / 2 }
  return {
    anchor: { x: pixelPoint.x, y: pixelPoint.y },
    containerSize: { width: containerWidth, height: containerHeight },
  }
}

const defaultBuyerLayerToggles: BuyerLayerToggles = {
  sellerThreads: true,
  buyerMatches: true,
  buyerRecentPurchases: true,
  buyerHeatmap: false,
  buyerProfiles: false,
  recentSoldComps: true,
  repeatBuyers: false,
  corporateBuyers: false,
  localInvestors: false,
  retailNoise: false,
  offMarketBuyers: false,
  buyerFocusMode: true,
  institutional: false,
  landlords: false,
  flippers: false,
  builders: false,
}

type CensusLayerToggles = {
  incomeHeat: boolean
  vacancyHeat: boolean
  renterDensity: boolean
  housingAge: boolean
  acquisitionPressure: boolean
  ownerOccupancy: boolean
  medianHomeValue: boolean
  medianRent: boolean
  investorOpportunity: boolean
  populationDensity: boolean
  censusHeatmap: boolean
}

type BuyerDemandLayerToggles = {
  activity6mo: boolean
  investorDemand: boolean
  buyerHeat: boolean
  soldPrice: boolean
}

const defaultCensusLayers: CensusLayerToggles = {
  incomeHeat: false,
  vacancyHeat: false,
  renterDensity: false,
  housingAge: false,
  acquisitionPressure: false,
  ownerOccupancy: false,
  medianHomeValue: false,
  medianRent: false,
  investorOpportunity: false,
  populationDensity: false,
  censusHeatmap: false,
}

// Census toggle definitions for UI dock
const CENSUS_TOGGLE_DEFS: Array<{ key: keyof CensusLayerToggles; label: string; color: string }> = [
  { key: 'censusHeatmap',      label: 'Heatmap',    color: '#a78bfa' },
  { key: 'vacancyHeat',        label: 'Vacancy',    color: '#ef4444' },
  { key: 'incomeHeat',         label: 'Income',     color: '#f59e0b' },
  { key: 'renterDensity',      label: 'Renter%',    color: '#3b82f6' },
  { key: 'ownerOccupancy',     label: 'Owner%',     color: '#10b981' },
  { key: 'medianHomeValue',    label: 'Med Value',  color: '#06b6d4' },
  { key: 'medianRent',         label: 'Med Rent',   color: '#8b5cf6' },
  { key: 'housingAge',         label: 'Bldg Age',   color: '#94a3b8' },
  { key: 'acquisitionPressure', label: 'Acq Pressure', color: '#ec4899' },
  { key: 'investorOpportunity',label: 'Opp Score',  color: '#22c55e' },
  { key: 'populationDensity',  label: 'Pop Density',color: '#38bdf8' },
]

const defaultBuyerDemandLayers: BuyerDemandLayerToggles = {
  activity6mo: false,
  investorDemand: false,
  buyerHeat: false,
  soldPrice: false,
}

const EMPTY_GEOJSON: FeatureCollection<Point, Record<string, unknown>> = { type: 'FeatureCollection', features: [] }
const CONTROLS_TABS: Array<{ key: ControlsTab; label: string }> = [
  { key: 'modes', label: 'Modes' },
  { key: 'filters', label: 'Filters' },
  { key: 'style', label: 'Style' },
  { key: 'intel', label: 'Intel' },
  { key: 'performance', label: 'Perf' },
]

const MAP_MODES: Array<{ key: MapModeKey; label: string; description: string; swatches: string[] }> = [
  { key: 'acquisition', label: 'Acquisition Radar', description: 'Seller leads, threads, motivation, urgency', swatches: ['#7a8fa8', '#30d158', '#ff6b35'] },
  { key: 'buyer_demand', label: 'Buyer Demand', description: 'Buyer comps, repeat buyers, liquidity hotspots', swatches: ['#2563eb', '#14b8a6', '#8b5cf6'] },
  { key: 'comps', label: 'Comps Intel', description: 'Sold comps, price anchors, valuation context', swatches: ['#ef4444', '#f97316', '#eab308'] },
  { key: 'execution', label: 'Execution Live', description: 'Queued, sent, delivered, failed, replies', swatches: ['#8f9bad', '#5bb6ff', '#30d158'] },
  { key: 'opportunity_heat', label: 'Opportunity Heat', description: 'Equity, distress, motivation, census pressure', swatches: ['#3b82f6', '#14b8a6', '#f97316', '#ef4444'] },
  { key: 'territory', label: 'Territory Scan', description: 'Property universe, asset mix, boundaries', swatches: ['#64748b', '#94a3b8', '#a6d260'] },
  { key: 'census', label: 'Census Intel', description: 'Demographic and economic overlays', swatches: ['#06b6d4', '#8b5cf6', '#38bdf8'] },
  { key: 'command', label: 'Command Mode', description: 'Highest-priority leads, follow-ups, replies, urgent activity', swatches: ['#ff2d87', '#ff6b35', '#30d158'] },
]

const FILTER_CATEGORIES: Array<{ key: FilterCategory; label: string }> = [
  { key: 'property', label: 'Property' },
  { key: 'prospect', label: 'Prospect' },
  { key: 'owner', label: 'Owner' },
  { key: 'buyer', label: 'Buyer' },
  { key: 'saved', label: 'Saved' },
]

const FILTER_PRESETS: Array<{ key: string; label: string; filters: Partial<MapFilterState> }> = [
  { key: 'hot_sellers', label: 'Hot Sellers', filters: { leadTemperature: 'hot' } },
  { key: 'follow_up', label: 'Follow-Up Due', filters: { followUpDue: true } },
  { key: 'unread', label: 'New Replies', filters: { unreadOnly: true } },
  { key: 'high_equity', label: 'High Equity Absentee', filters: { highEquity: true } },
  { key: 'landlords', label: 'Tired Landlords', filters: { leadTemperature: 'warm' } },
  { key: 'multi_24', label: '2–4 Unit Owners', filters: { propertyType: '2–4 Units' } },
  { key: 'multi_5plus', label: '5+ Multifamily', filters: { propertyType: '5+ Units' } },
  { key: 'storage', label: 'Storage Owners', filters: { propertyType: 'Storage' } },
  { key: 'delinquent', label: 'Tax Delinquent', filters: {} },
  { key: 'out_of_state', label: 'Out-of-State', filters: {} },
  { key: 'buyer_dense', label: 'Buyer Dense', filters: {} },
  { key: 'institutional_excl', label: 'Institutional Excl.', filters: {} },
]

type CinematicThemeDef = { id: MapStyleMode; label: string; description: string; bestFor: string }
const CINEMATIC_THEME_DEFINITIONS: CinematicThemeDef[] = MAP_VISUAL_PRESET_OPTIONS.map((preset) => ({
  id: preset.id,
  label: preset.label,
  description: preset.description,
  bestFor: preset.id === 'satellite' ? 'Recon'
    : preset.id === 'red_ops' ? 'Execution'
      : preset.id === 'executive' ? 'Review'
        : preset.id === 'dark_ops' ? 'Ops'
          : preset.id === 'blueprint' ? 'Analysis'
            : preset.id === 'radar_night' ? 'Acquisition'
              : preset.id === 'matrix' ? 'Signals'
                : preset.id === 'light_street' ? 'Due Diligence'
                  : preset.id === 'terrain' ? 'Land'
                    : 'Stealth',
}))

const RASTER_BASEMAP_THEMES = new Set<MapStyleMode>(['satellite', 'terrain'])




const MAP_LEGEND_ITEMS = [
  { label: 'Not Contacted', color: '#97a3b6' },
  { label: 'Active Cluster', color: '#3b82f6' },
  { label: 'Contacted / Replied', color: '#38bdf8' },
  { label: 'Needs Review', color: '#facc15' },
  { label: 'Positive Intent', color: '#22c55e' },
  { label: 'Offer / Contract', color: '#a855f7' },
  { label: 'Blocked / Suppressed / Urgent', color: '#ef4444' },
  { label: 'Selected / Hot', color: '#eab308' },
  { label: 'Recent Sold Comp', color: '#ef4444' },
  { label: 'MLS Sold', color: '#3b82f6' },
  { label: 'Public Record Sold', color: '#eab308' },
  { label: 'Off-Market Sold', color: '#facc15' },
] as const

const SELLER_PINS_LEGEND_ITEMS = [
  { label: 'Not Contacted', color: '#97a3b6', isRing: false },
  { label: 'Contacted', color: '#3b82f6', isRing: false },
  { label: 'New Reply', color: '#06b6d4', isRing: false },
  { label: 'Positive', color: '#22c55e', isRing: false },
  { label: 'Negotiating', color: '#a855f7', isRing: false },
  { label: 'Hot', color: '#eab308', isRing: false },
  { label: 'Issue / Blocked', color: '#ef4444', isRing: false },
  { label: 'Queued (Execution)', color: '#3b82f6', isRing: true },
  { label: 'Scheduled (Execution)', color: '#0ea5e9', isRing: true },
  { label: 'Ready/Active (Execution)', color: '#22d3ee', isRing: true },
  { label: 'Delivered (Execution)', color: '#22c55e', isRing: true },
] as const

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')
const text = (value: unknown): string => String(value ?? '').trim()
const lower = (value: unknown): string => text(value).toLowerCase()
const num = (value: unknown): number | null => {
  const n = Number(String(value ?? '').replace(/[,$\s]/g, ''))
  return Number.isFinite(n) ? n : null
}
const bool = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') return value
  const normalized = lower(value)
  if (!normalized) return null
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true
  if (['false', '0', 'no', 'n'].includes(normalized)) return false
  return null
}

const nullIfZeroish = (value: number | null | undefined): number | null => {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  return Math.abs(value) <= 0.000001 ? null : value
}

const resolveSellerPinDisplayName = (record: Partial<CommandMapSellerPin>): string => (
  text(record.owner_display_name)
  || text(record.owner_name)
  || text(record.owner_full_name)
  || text(record.entity_name)
  || 'Unknown Owner'
)

const resolveSellerPinAddress = (record: Partial<CommandMapSellerPin>): string => (
  text(record.property_address_full)
  || text(record.property_address)
  || text((record as Record<string, unknown>).address as string)
  || text((record as Record<string, unknown>).situs_address as string)
  || [
    text(record.property_address_city),
    text(record.property_address_state),
    text(record.property_address_zip),
  ].filter(Boolean).join(', ').trim()
  || 'Property Unknown'
)

const needsSellerPinHydration = (pin: Partial<CommandMapSellerPin>): boolean => {
  const hasDisplayName = Boolean(
    text(pin.owner_display_name)
    || text(pin.owner_name)
    || text(pin.owner_full_name)
    || text(pin.entity_name),
  )
  const hasAddress = Boolean(text(pin.property_address_full) || text(pin.property_address))
  const hasPhysical = [pin.total_bedrooms, pin.total_baths, pin.building_square_feet, pin.year_built].some((value) => nullIfZeroish(value ?? null) !== null)
  const hasFinancial = [pin.estimated_value, pin.equity_amount, pin.equity_percent, pin.estimated_repair_cost].some((value) => nullIfZeroish(value ?? null) !== null)
  const hasPriority = nullIfZeroish(pin.owner_priority_score ?? pin.priority_score ?? null) !== null
  const hasCanonicalState = Boolean(
    text(pin.lifecycle_stage)
    || text(pin.lead_temperature)
    || text(pin.operational_status)
    || (text(pin.seller_state) && text(pin.seller_state) !== 'not_contacted'),
  )
  const hasImage = Boolean(text(pin.streetview_image) || text(pin.map_image) || text(pin.satellite_image))
  return !hasDisplayName
    || !hasAddress
    || (!hasPhysical && !hasFinancial)
    || !hasPriority
    || !hasCanonicalState
    || !hasImage
}

const sanitizeSellerPinRecord = (pin: Partial<CommandMapSellerPin>): CommandMapSellerPin => {
  const normalizedPropertyType = text(pin.property_type) || text(pin.asset_class) || '—'
  return {
    property_id: text(pin.property_id),
    master_owner_id: text(pin.master_owner_id) || null,
    prospect_id: text(pin.prospect_id) || null,
    thread_key: text(pin.thread_key) || null,
    lat: Number(pin.lat ?? pin.latitude ?? 0),
    lng: Number(pin.lng ?? pin.longitude ?? 0),
    latitude: pin.latitude ?? pin.lat ?? null,
    longitude: pin.longitude ?? pin.lng ?? null,
    seller_name: resolveSellerPinDisplayName(pin),
    seller_display_name: text(pin.seller_display_name) || null,
    property_address_full: resolveSellerPinAddress(pin),
    property_address: text(pin.property_address) || null,
    property_address_city: text(pin.property_address_city) || null,
    property_address_state: text(pin.property_address_state) || null,
    property_address_zip: text(pin.property_address_zip) || null,
    market: text(pin.market) || text(pin.filter_market) || null,
    filter_market: text(pin.filter_market) || text(pin.market) || null,
    owner_type: text(pin.owner_type) || null,
    owner_display_name: text(pin.owner_display_name) || null,
    owner_name: text(pin.owner_name) || null,
    owner_full_name: text(pin.owner_full_name) || null,
    entity_name: text(pin.entity_name) || null,
    property_type: normalizedPropertyType,
    asset_class: text(pin.asset_class) || null,
    total_bedrooms: nullIfZeroish(pin.total_bedrooms ?? null),
    total_baths: nullIfZeroish(pin.total_baths ?? null),
    building_square_feet: nullIfZeroish(pin.building_square_feet ?? null),
    units_count: nullIfZeroish(pin.units_count ?? null),
    year_built: nullIfZeroish(pin.year_built ?? null),
    lot_square_feet: nullIfZeroish(pin.lot_square_feet ?? null),
    lot_acreage: nullIfZeroish(pin.lot_acreage ?? null),
    estimated_value: nullIfZeroish(pin.estimated_value ?? null),
    equity_amount: nullIfZeroish(pin.equity_amount ?? null),
    equity_percent: nullIfZeroish(pin.equity_percent ?? null),
    estimated_repair_cost: nullIfZeroish(pin.estimated_repair_cost ?? null),
    motivation_score: nullIfZeroish(pin.motivation_score ?? null),
    final_acquisition_score: nullIfZeroish(pin.final_acquisition_score ?? null),
    priority_score: nullIfZeroish(pin.priority_score ?? null),
    owner_priority_score: nullIfZeroish(pin.owner_priority_score ?? pin.priority_score ?? null),
    owner_priority_tier: text(pin.owner_priority_tier) || null,
    lifecycle_stage: text(pin.lifecycle_stage) || null,
    operational_status: text(pin.operational_status) || text(pin.seller_status) || null,
    lead_temperature: text(pin.lead_temperature) || null,
    contactability_status: text(pin.contactability_status) || null,
    mailing_address_full: text(pin.mailing_address_full) || text(pin.owner_mailing_address) || null,
    owner_mailing_address: text(pin.owner_mailing_address) || text(pin.mailing_address_full) || null,
    effective_year_built: nullIfZeroish(pin.effective_year_built ?? null),
    construction_type: text(pin.construction_type) || null,
    building_condition: text(pin.building_condition) || null,
    stories: nullIfZeroish(pin.stories ?? null),
    zoning: text(pin.zoning) || null,
    land_use: text(pin.land_use) || null,
    ownership_years: nullIfZeroish(pin.ownership_years ?? null),
    tax_delinquent: pin.tax_delinquent ?? null,
    absentee_owner: pin.absentee_owner ?? null,
    out_of_state_owner: pin.out_of_state_owner ?? null,
    active_lien: pin.active_lien ?? null,
    mortgage_balance: nullIfZeroish(pin.mortgage_balance ?? null),
    loan_count: nullIfZeroish(pin.loan_count ?? null),
    loan_type: text(pin.loan_type) || null,
    assessed_total_value: nullIfZeroish(pin.assessed_total_value ?? null),
    assessed_land_value: nullIfZeroish(pin.assessed_land_value ?? null),
    assessed_improvement_value: nullIfZeroish(pin.assessed_improvement_value ?? null),
    annual_taxes: nullIfZeroish(pin.annual_taxes ?? null),
    last_sale_amount: nullIfZeroish(pin.last_sale_amount ?? null),
    last_sale_date: text(pin.last_sale_date) || null,
    last_inbound_text: text(pin.last_inbound_text) || null,
    last_inbound_at: text(pin.last_inbound_at) || null,
    last_outbound_text: text(pin.last_outbound_text) || null,
    last_outbound_at: text(pin.last_outbound_at) || null,
    delivery_status: text(pin.delivery_status) || null,
    suppression_reason: text(pin.suppression_reason) || null,
    campaign_name: text(pin.campaign_name) || null,
    automation_state: text(pin.automation_state) || text(pin.execution_state) || null,
    follow_up_due_at: text(pin.follow_up_due_at) || null,
    next_action_at: text(pin.next_action_at) || text(pin.next_scheduled_for) || null,
    canonical_e164: text(pin.canonical_e164) || text(pin.seller_phone) || null,
    seller_phone: text(pin.seller_phone) || text(pin.canonical_e164) || null,
    property_count: nullIfZeroish(pin.property_count ?? null),
    streetview_image: text(pin.streetview_image) || null,
    map_image: text(pin.map_image) || null,
    satellite_image: text(pin.satellite_image) || null,
    property_tags_text: text(pin.property_tags_text) || text(pin.property_flags_text) || null,
    property_tags_json: pin.property_tags_json ?? pin.podio_tags ?? null,
    podio_tags: pin.podio_tags ?? null,
    property_flags_text: text(pin.property_flags_text) || null,
    property_flags_json: pin.property_flags_json ?? null,
    latest_message_at: text(pin.latest_message_at) || null,
    latest_direction: text(pin.latest_direction) || null,
    seller_state: text(pin.seller_state) || 'not_contacted',
    seller_status: text(pin.seller_status) || null,
    execution_state: text(pin.execution_state) || 'none',
    inbox_category: text(pin.inbox_category) || null,
    inbound_count: nullIfZeroish(pin.inbound_count ?? null),
    outbound_count: nullIfZeroish(pin.outbound_count ?? null),
    queued_count: nullIfZeroish(pin.queued_count ?? null),
    scheduled_count: nullIfZeroish(pin.scheduled_count ?? null),
    ready_count: nullIfZeroish(pin.ready_count ?? null),
    sent_count: nullIfZeroish(pin.sent_count ?? null),
    delivered_count: nullIfZeroish(pin.delivered_count ?? null),
    next_scheduled_for: text(pin.next_scheduled_for) || null,
    pin_color: text(pin.pin_color) || null,
    pin_shape: text(pin.pin_shape) || null,
    pulse_style: text(pin.pulse_style) || null,
    execution_ring_color: text(pin.execution_ring_color) || null,
    render_priority: nullIfZeroish(pin.render_priority ?? null),
  }
}

const ringColorsForTheme = (styleMode: MapStyleMode) => {
  const theme = getCommandMapTheme(styleMode)
  const palette = theme.pinPalette
  return {
    unread: theme.accentColor,
    offer: palette.delivered ?? palette.positive_intent ?? theme.accentColor,
    contract: palette.active ?? palette.scheduled ?? theme.accentColor,
  }
}

const stageBadgeColor = (pin: CommandMapPin): string => {
  const stage = normalizeLifecycleStage(pin.lifecycle_stage || pin.conversation_stage)
  return LIFECYCLE_STAGE_META[stage]?.color ?? '#97a3b6'
}

const pinNeedsWarning = (pin: CommandMapPin): boolean =>
  normalizeOperationalStatus(pin.operational_status || pin.conversation_status) === 'needs_review'
  || pin.inbox_bucket === 'needs_review'
  || Boolean(pin.review_reason)
  || contactabilityBlocksSend(pin.contactability_status)

const glowStrength = (priorityScore: number): number => {
  if (priorityScore >= 90) return 1
  if (priorityScore >= 70) return 0.8
  if (priorityScore >= 40) return 0.52
  return 0.2
}

const pulseModeFor = (pin: CommandMapPin): PinFeatureProps['pulseMode'] => {
  if (pin.activity_state === 'sending') return 'continuous'
  if (pin.activity_state === 'sent' || pin.activity_state === 'delivered' || pin.activity_state === 'replied' || pin.activity_state === 'opted_out') return 'ripple'
  if (pin.activity_state === 'failed') return 'triple'
  if (pin.activity_state === 'overdue' || pin.activity_state === 'due_now') return 'continuous'
  if (pin.activity_state === 'due_later_today' || pin.activity_state === 'due_tomorrow') return 'ripple'
  if (pin.activity_mode === 'follow_ups' || pin.activity_mode === 'sends') return 'none'
  return pulseTierFor(pin.last_activity_at) === 'none' ? 'none' : 'continuous'
}

const pulseTierFor = (lastActivityAt: string): PinFeatureProps['pulseTier'] => {
  const ts = new Date(lastActivityAt).getTime()
  if (!Number.isFinite(ts)) return 'none'
  const ageMinutes = (Date.now() - ts) / 60000
  if (ageMinutes <= 5) return 'fast'
  if (ageMinutes <= 30) return 'medium_fast'
  if (ageMinutes <= 240) return 'medium'
  if (ageMinutes <= 1440) return 'slow'
  if (ageMinutes <= 10080) return 'very_slow'
  return 'none'
}

const isValidCoord = (lat: number, lng: number) =>
  Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0 && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180

const formatLabel = (value: string): string => value.replace(/_/g, ' ')
const minutesBetween = (older: string | null, newer = new Date().toISOString()): number | null => {
  if (!older) return null
  const a = new Date(older).getTime()
  const b = new Date(newer).getTime()
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return (b - a) / 60000
}
const sameDay = (left: Date, right: Date): boolean =>
  left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate()
const dayKey = (value: Date): string => `${value.getFullYear()}-${value.getMonth()}-${value.getDate()}`
const formatPercent = (value: number): string => {
  if (!Number.isFinite(value) || value < 0 || value > 100) return '—'
  return `${Math.round(value * 10) / 10}%`
}
const formatRelative = (value: string | null): string => {
  if (!value) return 'Unknown'
  const deltaMinutes = minutesBetween(value)
  if (deltaMinutes === null) return 'Unknown'
  if (deltaMinutes < 1) return 'Just now'
  if (deltaMinutes < 60) return `${Math.max(1, Math.floor(deltaMinutes))}m ago`
  if (deltaMinutes < 1440) return `${Math.floor(deltaMinutes / 60)}h ago`
  return `${Math.floor(deltaMinutes / 1440)}d ago`
}
const formatCurrency = (value: number | null): string => {
  if (!Number.isFinite(value ?? NaN)) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value as number)
}
const formatCompactCurrency = (value: number | null): string => {
  if (!Number.isFinite(value ?? NaN)) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value as number)
}
const resolveAddress = (thread: InboxWorkflowThread | null, pin?: Pick<CommandMapPin, 'address'> | null): string =>
  [
    text((thread as any)?.propertyAddress),
    text((thread as any)?.propertyAddressFull),
    text((thread as any)?.property_address),
    text((thread as any)?.property_address_full),
    text((thread as any)?.address),
    text((thread as any)?.situs_address),
    text(pin?.address),
  ].find(Boolean) || 'Property Unknown'
const buyerColorFor = (styleMode: MapStyleMode, category: string): string => {
  if (styleMode === 'red_ops') {
    if (category === 'institutional') return '#ff8b6a'
    if (category === 'builder') return '#f3b36d'
    if (category === 'flipper') return '#ff6a87'
    if (category === 'landlord') return '#e4aa5d'
    return '#ff9b78'
  }
  if (styleMode === 'satellite') {
    if (category === 'institutional') return '#7ed6d3'
    if (category === 'builder') return '#dbb568'
    if (category === 'flipper') return '#c79fff'
    if (category === 'landlord') return '#9fd38c'
    return '#9bc3d9'
  }
  if (styleMode === 'matrix' || styleMode === 'radar_night') {
    if (category === 'institutional') return '#72ffb2'
    if (category === 'builder') return '#c8ff4d'
    if (category === 'flipper') return '#9d7cff'
    if (category === 'landlord') return '#56ffc1'
    return '#00ff88'
  }
  if (styleMode === 'light_street') {
    if (category === 'institutional') return '#2563eb'
    if (category === 'builder') return '#ca8a04'
    if (category === 'flipper') return '#7c3aed'
    if (category === 'landlord') return '#059669'
    return '#0ea5e9'
  }
  if (styleMode === 'executive') {
    if (category === 'institutional') return '#e2c27a'
    if (category === 'builder') return '#f0d998'
    if (category === 'flipper') return '#b8a77a'
    if (category === 'landlord') return '#d6bc7f'
    return '#d9c07a'
  }
  if (styleMode === 'blueprint') {
    if (category === 'institutional') return '#63e3ef'
    if (category === 'builder') return '#55cad8'
    if (category === 'flipper') return '#83ecf5'
    if (category === 'landlord') return '#46bcca'
    return '#56d9e8'
  }
  if (styleMode === 'monochrome') {
    if (category === 'institutional') return '#d8dee6'
    if (category === 'builder') return '#c8d0db'
    if (category === 'flipper') return '#e3e8ef'
    if (category === 'landlord') return '#c2cad5'
    return '#d0d7e0'
  }
  if (category === 'institutional') return '#7be0ff'
  if (category === 'builder') return '#f5ca76'
  if (category === 'flipper') return '#cf90ff'
  if (category === 'landlord') return '#7edb97'
  return '#95beff'
}
const buyerCategoryLabel = (category: string): string => {
  if (category === 'institutional') return 'Institutional'
  if (category === 'landlord') return 'Landlord'
  if (category === 'flipper') return 'Flipper'
  if (category === 'builder') return 'Builder'
  return 'Buyer'
}
const buyerInitials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || 'BY'
const buyerMatchTier = (score: number | null | undefined): string => {
  const safe = Number(score ?? 0)
  if (safe >= 90) return 'Elite Match'
  if (safe >= 75) return 'Strong Match'
  if (safe >= 60) return 'Possible Match'
  if (safe >= 40) return 'Weak Match'
  return 'Low Fit'
}
const zillowSearchUrl = (address: string): string =>
  `https://www.zillow.com/homes/${encodeURIComponent(address)}_rb/`
const mapsSearchUrl = (address: string): string =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`

const padCommandBounds = (bounds: CommandMapBounds, ratio = 0.18): CommandMapBounds => {
  const latPad = (bounds.north - bounds.south) * ratio
  const lngPad = (bounds.east - bounds.west) * ratio
  return {
    west: bounds.west - lngPad,
    south: bounds.south - latPad,
    east: bounds.east + lngPad,
    north: bounds.north + latPad,
  }
}

const isPointInBounds = (lat: number, lng: number, bounds: CommandMapBounds | null): boolean =>
  !bounds || (lat >= bounds.south && lat <= bounds.north && lng >= bounds.west && lng <= bounds.east)

const getDensityMultiplier = (density: CommandMapPerformanceSettings['markerDensity']): number => (
  density === 'low' ? 0.7 : density === 'high' ? 1.4 : 1
)

const getPinRenderCap = (
  zoom: number,
  settings: CommandMapPerformanceSettings,
  layer: 'seller' | 'buyer' | 'sold_comp',
): number => {
  const density = getDensityMultiplier(settings.markerDensity)
  const base =
    layer === 'seller'
      ? 150000
      : layer === 'buyer'
        ? zoom < 6 ? 160 : zoom < 10 ? 240 : 340
        : zoom < 8 ? 280 : 520
  const modeFactor =
    settings.performanceMode === 'speed'
      ? 0.68
      : settings.performanceMode === 'balanced'
        ? 0.88
        : settings.performanceMode === 'quality'
          ? 1.16
          : 1
  return Math.max(layer === 'seller' ? 300 : 80, Math.round(base * density * modeFactor))
}

const roundBound = (value: number): string => value.toFixed(2)
const buildViewportCacheKey = (
  bounds: { minLng: number; minLat: number; maxLng: number; maxLat: number },
  zoom: number,
  suffix: string,
): string => [
  roundBound(bounds.minLng),
  roundBound(bounds.minLat),
  roundBound(bounds.maxLng),
  roundBound(bounds.maxLat),
  Math.floor(zoom),
  suffix,
].join(':')

const sortPinsForPerformance = (pins: CommandMapPin[]): CommandMapPin[] =>
  pins
    .slice()
    .sort((left, right) => {
      const priorityDelta = (right.priority_score ?? 0) - (left.priority_score ?? 0)
      if (priorityDelta !== 0) return priorityDelta
      const unreadDelta = Number(right.unread) - Number(left.unread)
      if (unreadDelta !== 0) return unreadDelta
      return new Date(right.last_activity_at).getTime() - new Date(left.last_activity_at).getTime()
    })

const applyPinPerformanceWindow = (
  pins: CommandMapPin[],
  viewportBounds: CommandMapBounds | null,
  zoom: number,
  settings: CommandMapPerformanceSettings,
): CommandMapPin[] => {
  const paddedBounds = viewportBounds ? padCommandBounds(viewportBounds, zoom >= 10 ? 0.06 : 0.18) : null
  const shouldFilterByBounds = Boolean(paddedBounds && (settings.performanceMode !== 'quality' || zoom >= 5))
  const candidates = shouldFilterByBounds
    ? pins.filter((pin) => isPointInBounds(pin.lat, pin.lng, paddedBounds))
    : pins
  const capped = sortPinsForPerformance(candidates).slice(0, getPinRenderCap(zoom, settings, 'seller'))
  return capped.length > 0 ? capped : sortPinsForPerformance(pins).slice(0, getPinRenderCap(zoom, settings, 'seller'))
}
const buildBuyerFeatureCollection = (
  items: Array<BuyerRecentPurchase | BuyerProfilePoint>,
  styleMode: MapStyleMode,
  featureType: BuyerFeatureProps['featureType'],
  selectedBuyerKey: string | null,
): FeatureCollection<Point, BuyerFeatureProps> => ({
  type: 'FeatureCollection',
  features: items.map((item) => {
    const isPurchase = featureType === 'buyer_purchase'
    const latitude = isPurchase ? (item as BuyerRecentPurchase).latitude : (item as BuyerProfilePoint).latitude
    const longitude = isPurchase ? (item as BuyerRecentPurchase).longitude : (item as BuyerProfilePoint).longitude
    const category = item.category || 'general'
    const pointColor = buyerColorFor(styleMode, category)
    const salePrice = isPurchase ? ((item as BuyerRecentPurchase).salePrice ?? 0) : ((item as BuyerProfilePoint).avgPurchasePrice ?? 0)
    const confidence = isPurchase ? ((item as BuyerRecentPurchase).compConfidenceScore ?? 0) : ((item as BuyerProfilePoint).confidenceScore ?? 0)
    const purchaseCount = isPurchase ? 1 : (item as BuyerProfilePoint).purchaseCount
    const saleDate = 'saleDate' in item ? item.saleDate || '' : item.recentPurchaseDate || ''
    const daysSince = saleDate ? Math.max(0, Math.round((Date.now() - new Date(saleDate).getTime()) / 86_400_000)) : null
    const isSelectedBuyer = selectedBuyerKey && selectedBuyerKey === item.buyerKey ? 1 : 0
    const focusOpacity = selectedBuyerKey ? (isSelectedBuyer ? 1 : 0.18) : 1
    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [longitude, latitude] },
      properties: {
        featureType,
        buyerKey: item.buyerKey,
        buyerName: item.buyerName,
        buyerTier: 'buyerTier' in item ? (item.buyerTier || 'Unknown') : 'Unknown',
        buyerType: 'buyerType' in item ? (item.buyerType || 'Unknown') : 'Unknown',
        market: item.market || 'Market Unknown',
        state: 'propertyAddressState' in item ? item.propertyAddressState || '' : item.state || '',
        zip: 'propertyAddressZip' in item ? item.propertyAddressZip || '' : item.zip || '',
        propertyType: 'propertyType' in item ? item.propertyType || 'Unknown' : (item.propertyTypes?.[0] || 'Unknown'),
        propertyAddressFull: 'propertyAddressFull' in item ? item.propertyAddressFull || 'Property Unknown' : 'Buyer Profile',
        saleDate,
        salePrice,
        estimatedValue: 'estimatedValue' in item ? (item.estimatedValue ?? 0) : 0,
        matchScore: selectedBuyerKey && selectedBuyerKey === item.buyerKey ? 100 : 0,
        confidenceScore: confidence,
        purchaseCount,
        category,
        pointColor,
        radiusWeight: Math.min(18, 8 + purchaseCount * 1.2),
        heatWeight: Math.max(0.1, ((salePrice || 0) / 250000) + (((isPurchase ? (item as BuyerRecentPurchase).investorFitScore : (item as BuyerProfilePoint).velocityScore) ?? 0) / 100)),
        pricePerSqft: 'pricePerSqft' in item ? (item.pricePerSqft ?? 0) : 0,
        beds: 'totalBedrooms' in item ? (item.totalBedrooms ?? 0) : 0,
        baths: 'totalBaths' in item ? (item.totalBaths ?? 0) : 0,
        sqft: 'buildingSquareFeet' in item ? (item.buildingSquareFeet ?? 0) : 0,
        yearBuilt: 'yearBuilt' in item ? (item.yearBuilt ?? 0) : 0,
        buyerActivitySignal: 'buyerActivitySignal' in item ? item.buyerActivitySignal || '' : '',
        buyerEntityStrength: 'buyerEntityStrength' in item ? item.buyerEntityStrength || '' : '',
        investorFitScore: 'investorFitScore' in item ? (item.investorFitScore ?? 0) : ((item as BuyerProfilePoint).velocityScore ?? 0),
        compQualityScore: 'compQualityScore' in item ? (item.compQualityScore ?? 0) : ((item as BuyerProfilePoint).confidenceScore ?? 0),
        distanceMiles: 'distanceMiles' in item ? (item.distanceMiles ?? 0) : 0,
        focusOpacity,
        isRecent: daysSince != null && daysSince <= 90 ? 1 : 0,
        isSelectedBuyer,
        sourceLabel: 'isOffMarketPurchase' in item ? (item.isOffMarketPurchase ? 'Off-Market / Public Record' : 'MLS') : 'Buyer Profile',
      },
    }
  }),
})

const buildBuyerTrailGeojson = (
  purchases: BuyerRecentPurchase[],
  styleMode: MapStyleMode,
): FeatureCollection<LineString, GeoJsonProperties> => {
  if (purchases.length < 2) return { type: 'FeatureCollection', features: [] }
  const sorted = purchases
    .slice()
    .sort((left, right) => new Date(left.saleDate || 0).getTime() - new Date(right.saleDate || 0).getTime())
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: sorted.map((purchase) => [purchase.longitude, purchase.latitude]),
      },
      properties: {
        color: buyerColorFor(styleMode, sorted[sorted.length - 1]?.category || 'general'),
      },
    }],
  }
}

const defaultMapOverlays: MapOverlayToggles = {
  roads: true,
  cities: true,
  poi: true,
  zip: true,
}

let darkStyleSpecPromise: Promise<maplibregl.StyleSpecification | null> | null = null
let lastWorkingDarkStyleSpec: maplibregl.StyleSpecification | null = null

const fetchDarkStyleSpec = async (): Promise<maplibregl.StyleSpecification | null> => {
  if (!darkStyleSpecPromise) {
    const darkStyleUrl = CARTO_VECTOR_DARK_STYLE_URL
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 4000)
    darkStyleSpecPromise = fetch(darkStyleUrl, { signal: controller.signal })
      .then(async (response) => {
        clearTimeout(timeout)
        if (!response.ok) return null
        const spec = await response.json() as maplibregl.StyleSpecification
        lastWorkingDarkStyleSpec = spec
        return spec
      })
      .catch(() => lastWorkingDarkStyleSpec)
  }
  return darkStyleSpecPromise
}

const isCustomLayer = (id?: string) => !id ? false : (
  id.startsWith('command-') ||
  id.startsWith('census-') ||
  id.startsWith('buyer-demand-') ||
  id.startsWith('sold-comps-') ||
  id.startsWith('prop-univ-') ||
  id.startsWith('prop-tiles-') ||
  id.startsWith('map-agg-') ||
  id.startsWith('seller-pins-') ||
  id.startsWith('command-map-theme-') ||
  id.startsWith('nx-icm-hybrid-')
)
const hybridLayerPrefix = 'nx-icm-hybrid-'
const THEME_TINT_GEOJSON: FeatureCollection<Polygon, GeoJsonProperties> = {
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [-180, -85],
        [180, -85],
        [180, 85],
        [-180, 85],
        [-180, -85],
      ]],
    },
    properties: {},
  }],
}
const THEME_GRID_GEOJSON: FeatureCollection<LineString, GeoJsonProperties> = {
  type: 'FeatureCollection',
  features: [
    ...[-120, -60, 0, 60, 120].map((lng) => ({
      type: 'Feature' as const,
      geometry: {
        type: 'LineString' as const,
        coordinates: [[lng, -85], [lng, 85]] as [number, number][],
      },
      properties: {},
    })),
    ...[-60, -30, 0, 30, 60].map((lat) => ({
      type: 'Feature' as const,
      geometry: {
        type: 'LineString' as const,
        coordinates: [[-180, lat], [180, lat]] as [number, number][],
      },
      properties: {},
    })),
  ],
}
const THEME_RADAR_GEOJSON: FeatureCollection<LineString, GeoJsonProperties> = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [[-180, 0], [180, 0]],
      },
      properties: {},
    },
    {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [[0, -85], [0, 85]],
      },
      properties: {},
    },
    {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [[-160, -55], [160, 55]],
      },
      properties: {},
    },
    {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [[-160, 55], [160, -55]],
      },
      properties: {},
    },
  ],
}

const classifyBaseLayer = (layer: StyleLayerLike): Array<keyof MapOverlayToggles> => {
  const id = lower(layer.id)
  const sourceLayer = lower(layer['source-layer'])
  const token = `${id} ${sourceLayer}`
  const matches: Array<keyof MapOverlayToggles> = []

  const isRoad =
    layer.type === 'line'
    || token.includes('road')
    || token.includes('street')
    || token.includes('highway')
    || token.includes('transport')
    || token.includes('bridge')
    || token.includes('tunnel')
  if (isRoad) matches.push('roads')

  const isCity =
    layer.type === 'symbol'
    && (
      token.includes('place')
      || token.includes('settlement')
      || token.includes('city')
      || token.includes('town')
      || token.includes('village')
      || token.includes('state_label')
      || token.includes('country_label')
    )
  if (isCity) matches.push('cities')

  const isPoi =
    layer.type === 'symbol'
    && (
      token.includes('poi')
      || token.includes('landmark')
      || token.includes('attraction')
      || token.includes('transit_stop')
      || token.includes('airport')
      || token.includes('railway')
    )
  if (isPoi) matches.push('poi')

  const isZip =
    layer.type === 'symbol'
    && (
      token.includes('postal')
      || token.includes('postcode')
      || token.includes('zip')
    )
  if (isZip) matches.push('zip')

  return matches
}

const cloneLayerWithId = (layer: StyleLayerLike, id: string): StyleLayerLike => {
  return {
    ...layer,
    id,
    layout: layer.layout ? { ...layer.layout } : undefined,
    paint: layer.paint ? { ...layer.paint } : undefined,
  }
}

const hybridOverlayLayerId = (layerId: string) => `${hybridLayerPrefix}${layerId}`
const formatInteger = (value: number | null): string => {
  if (!Number.isFinite(value ?? NaN)) return '—'
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value as number)
}
const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const getLat = (thread: InboxWorkflowThread): number => Number((thread as any).lat ?? (thread as any).latitude ?? 0)
const getLng = (thread: InboxWorkflowThread): number => Number((thread as any).lng ?? (thread as any).longitude ?? 0)
const get = (thread: InboxWorkflowThread, ...keys: string[]): unknown => {
  const row = thread as unknown as Record<string, unknown>
  for (const key of keys) {
    const value = row[key]
    if (value !== undefined && value !== null && `${value}`.trim() !== '') return value
  }
  return undefined
}

const buildMapPin = (thread: InboxWorkflowThread): { pin: CommandMapPin | null; unmapped: UnmappedItem | null } => {
  const lat = getLat(thread)
  const lng = getLng(thread)
  const decision = buildConversationDecision(thread)
  const base = {
    id: thread.id,
    conversation_id: thread.id,
    property_id: text(get(thread, 'propertyId', 'property_id')),
    master_owner_id: text(get(thread, 'ownerId', 'master_owner_id')),
    seller_name: text(get(thread, 'ownerName', 'sellerName', 'ownerDisplayName')) || 'Unknown Seller',
    address: text(get(thread, 'propertyAddress', 'propertyAddressFull', 'subject')) || 'Unknown Address',
    city: text(get(thread, 'property_address_city', 'city')),
    state: text(get(thread, 'property_address_state', 'state')),
    zip: text(get(thread, 'property_address_zip', 'zip')),
    lat,
    lng,
    market: text(get(thread, 'market', 'marketName', 'marketId')) || 'Unknown',
    property_type: text(get(thread, 'propertyType', 'property_type', 'propertyClass')) || 'Unknown',
    beds: num(get(thread, 'beds', 'bedrooms', 'total_bedrooms')),
    baths: num(get(thread, 'baths', 'bathrooms', 'total_baths')),
    sqft: num(get(thread, 'sqft', 'livingAreaSqft', 'building_square_feet')),
    units: num(get(thread, 'units', 'unit_count', 'units_count', 'number_of_units')),
    estimated_value: num(get(thread, 'estimatedValue', 'estimated_value')),
    equity_percent: num(get(thread, 'equityPercent', 'equity_percent')),
    repair_estimate: num(get(thread, 'estimatedRepairCost', 'estimated_repair_cost')),
    streetview_image: text(get(thread, 'streetview_image', 'streetviewImage')) || null,
    map_image: text(get(thread, 'map_image', 'mapImage')) || null,
    satellite_image: text(get(thread, 'satellite_image', 'satelliteImage')) || null,
    last_message: text(get(thread, 'lastMessageBody', 'latestMessageBody', 'preview')),
    last_message_direction: decision.last_message_direction,
    last_activity_at: thread.lastMessageAt || thread.lastMessageIso || new Date().toISOString(),
    unread: decision.unread,
    conversation_stage: decision.conversation_stage,
    conversation_status: decision.conversation_status,
    lifecycle_stage: normalizeLifecycleStage(
      get(thread, 'lifecycle_stage', 'lifecycleStage', 'universal_stage', 'universalStage', 'conversationStage', 'seller_stage', 'sellerStage')
        || decision.conversation_stage,
    ),
    operational_status: normalizeOperationalStatus(
      get(thread, 'operational_status', 'operationalStatus', 'conversation_status', 'conversationStatus', 'inboxStatus', 'status')
        || decision.conversation_status,
    ),
    disposition: normalizeDisposition(get(thread, 'disposition')),
    contactability_status: normalizeContactability(
      get(thread, 'contactability_status', 'contactabilityStatus', 'contactability'),
    ),
    is_archived: bool(get(thread, 'is_archived', 'isArchived', 'archived')) ?? false,
    snoozed_until: text(get(thread, 'snoozed_until', 'snoozedUntil')) || null,
    stage_short_label: LIFECYCLE_STAGE_META[normalizeLifecycleStage(
      get(thread, 'lifecycle_stage', 'lifecycleStage', 'universal_stage', 'conversationStage', 'seller_stage') || decision.conversation_stage,
    )]?.shortLabel ?? 'S?',
    inbox_bucket: decision.inbox_bucket,
    lead_temperature: normalizeLeadTemperature(
      get(thread, 'lead_temperature', 'leadTemperature', 'temperature') || decision.lead_temperature,
    ),
    priority_score: decision.priority_score,
    automation_status: decision.automation_status,
    suppression_status: decision.suppression_status,
    next_action: decision.next_action,
    offer_status: lower(decision.conversation_status).includes('offer') ? 'ready' : text(get(thread, 'offer_status', 'offerStatus')) || 'none',
    contract_status: lower(decision.conversation_status).includes('contract') ? 'active' : text(get(thread, 'contract_status', 'contractStatus')) || 'none',
    next_follow_up_at: decision.next_follow_up_at,
    review_reason: decision.review_reason,
    confidence: decision.confidence,
    last_inbound_at: thread.lastInboundAt || null,
    last_outbound_at: thread.lastOutboundAt || null,
    last_reply_at: text(get(thread, 'last_reply_at', 'lastReplyAt')) || thread.lastInboundAt || null,
    queue_status: text(get(thread, 'queueStatus', 'queue_status', 'deliveryState')) || null,
    delivery_status: text(get(thread, 'deliveryStatus', 'delivery_status', 'providerDeliveryStatus', 'provider_delivery_status')) || null,
    property_address_full: text(get(thread, 'propertyAddressFull', 'property_address_full', 'propertyAddress', 'property_address')) || null,
    property_address_city: text(get(thread, 'property_address_city', 'city')) || null,
    property_address_state: text(get(thread, 'property_address_state', 'state')) || null,
    property_address_zip: text(get(thread, 'property_address_zip', 'zip')) || null,
    owner_name: text(get(thread, 'owner_name', 'ownerName')) || null,
    owner_display_name: text(get(thread, 'owner_display_name', 'ownerDisplayName')) || null,
    owner_full_name: text(get(thread, 'owner_full_name')) || null,
    owner_type: text(get(thread, 'owner_type', 'ownerType', 'owner_type_guess')) || null,
    is_corporate_owner: bool(get(thread, 'is_corporate_owner')),
    corporate_owner: bool(get(thread, 'corporate_owner')),
    owner_occupied: bool(get(thread, 'owner_occupied')),
    out_of_state_owner: bool(get(thread, 'out_of_state_owner', 'outOfStateOwner', 'is_out_of_state_owner')),
    absentee_owner: bool(get(thread, 'absentee_owner', 'isAbsentee')),
    ownership_years: num(get(thread, 'ownership_years', 'ownershipYears')),
    last_sale_date: text(get(thread, 'last_sale_date', 'lastSaleDate')) || null,
    sale_date: text(get(thread, 'sale_date', 'saleDate')) || null,
    sale_price: num(get(thread, 'sale_price', 'salePrice')),
    last_sale_price: num(get(thread, 'last_sale_price', 'lastSalePrice')),
    latest_message_body: text(get(thread, 'latest_message_body', 'latestMessageBody', 'lastMessageBody')) || null,
    last_outreach_message: text(get(thread, 'last_outreach_message', 'lastOutreachMessage')) || null,
    reply_status: text(get(thread, 'reply_status', 'replyStatus', 'inboxStatus')) || null,
    seller_stage: text(get(thread, 'seller_stage')) || null,
    pipeline_stage: text(get(thread, 'pipeline_stage')) || null,
    contact_status: text(get(thread, 'contact_status', 'suppression_status', 'suppressionStatus')) || null,
    sms_eligible: bool(get(thread, 'sms_eligible')),
    language: text(get(thread, 'language', 'seller_language', 'best_language', 'detected_language')) || null,
    phone: text(get(thread, 'phone', 'phoneNumber', 'canonicalE164')) || null,
    motivation_score: num(get(thread, 'motivation_score', 'motivationScore')),
    final_acquisition_score: num(get(thread, 'final_acquisition_score', 'finalAcquisitionScore', 'priority_score', 'priorityScore')),
    seller_persona: text(get(thread, 'seller_persona', 'sellerPersona')) || null,
    ai_seller_persona: text(get(thread, 'ai_seller_persona')) || null,
    market_status_label: text(get(thread, 'market_status_label')) || null,
    mls_market_status: text(get(thread, 'mls_market_status')) || null,
    market_sub_status_label: text(get(thread, 'market_sub_status_label')) || null,
    building_condition: text(get(thread, 'building_condition')) || null,
    building_quality: text(get(thread, 'building_quality')) || null,
    construction_type: text(get(thread, 'construction_type')) || null,
    year_built: num(get(thread, 'year_built', 'yearBuilt')),
    effective_year_built: num(get(thread, 'effective_year_built')),
    total_bedrooms: num(get(thread, 'total_bedrooms', 'beds', 'bedrooms')),
    total_baths: num(get(thread, 'total_baths', 'baths', 'bathrooms')),
    building_square_feet: num(get(thread, 'building_square_feet', 'sqft', 'livingAreaSqft')),
    units_count: num(get(thread, 'units_count', 'units', 'unit_count', 'number_of_units')),
    lot_square_feet: num(get(thread, 'lot_square_feet')),
    lot_acreage: num(get(thread, 'lot_acreage')),
    estimated_repair_cost: num(get(thread, 'estimated_repair_cost', 'estimatedRepairCost')),
    equity_amount: num(get(thread, 'equity_amount')),
    tax_delinquent: bool(get(thread, 'tax_delinquent')),
    active_lien: bool(get(thread, 'active_lien')),
    property_flags_json: get(thread, 'property_flags_json'),
    property_flags_text: text(get(thread, 'property_flags_text')) || null,
    seller_state: text(get(thread, 'seller_state')) || (decision.suppression_status !== 'clear' ? 'blocked' : 'contacted'),
    execution_state: text(get(thread, 'execution_state')) || 'none',
    activity_mode: 'threads' as const,
    activity_state: (decision.suppression_status !== 'clear' ? 'suppressed' : 'new_replies') as PinActivityState,
    activity_label: decision.suppression_status !== 'clear' ? 'Suppressed' : 'New Replies',
  }

  if (!isValidCoord(lat, lng)) {
    return {
      pin: null,
      unmapped: {
        id: thread.id,
        conversation_id: thread.id,
        seller_name: base.seller_name,
        address: base.address,
        reason: 'missing_coordinates',
      },
    }
  }

  return {
    pin: {
      ...base,
      lat,
      lng,
    },
    unmapped: null,
  }
}

const deriveThreadState = (pin: CommandMapPin): ThreadMapState => {
  if (pin.suppression_status !== 'clear') return 'suppressed'
  if (pin.inbox_bucket === 'new_replies') return 'new_replies'
  if (pin.inbox_bucket === 'needs_review') return 'needs_review'
  if (pin.inbox_bucket === 'waiting_on_seller') return 'waiting_on_seller'
  if (pin.inbox_bucket === 'negotiating') return 'negotiating'
  if (pin.inbox_bucket === 'follow_up_due') return 'follow_up_due'
  if (pin.review_reason) return 'needs_review'
  if (pin.last_message_direction === 'outbound') return 'waiting_on_seller'
  if (pin.conversation_status === 'underwriting' || pin.conversation_status === 'offer_ready' || pin.conversation_status === 'contract_ready') return 'negotiating'
  return 'new_replies'
}

const deriveSendState = (pin: CommandMapPin): SendMapState | null => {
  const queueStatus = lower(pin.queue_status)
  const deliveryStatus = lower(pin.delivery_status)
  const outboundAt = pin.last_outbound_at ? new Date(pin.last_outbound_at).getTime() : 0
  const inboundAt = pin.last_inbound_at ? new Date(pin.last_inbound_at).getTime() : 0

  if (pin.suppression_status !== 'clear') return 'opted_out'
  if (queueStatus.includes('blocked')) return 'queue_blocked'
  if (inboundAt > outboundAt && outboundAt > 0) return 'replied'
  if (deliveryStatus.includes('failed') || queueStatus.includes('failed')) return 'failed'
  if (deliveryStatus.includes('delivered') || queueStatus.includes('delivered')) return 'delivered'
  if (queueStatus.includes('sending') || queueStatus.includes('processing') || queueStatus.includes('running')) return 'sending'
  if (deliveryStatus.includes('sent') || queueStatus.includes('sent')) return 'sent'
  if (queueStatus.includes('queued') || queueStatus.includes('scheduled') || queueStatus.includes('approval') || queueStatus.includes('ready')) return 'queued'
  if (outboundAt > 0) return 'sent'
  return null
}

const deriveFollowUpState = (pin: CommandMapPin): FollowUpMapState | null => {
  if (pin.suppression_status !== 'clear') return null
  const now = new Date()
  const nextTs = pin.next_follow_up_at ? new Date(pin.next_follow_up_at).getTime() : NaN
  if (Number.isFinite(nextTs)) {
    const next = new Date(nextTs)
    const deltaMinutes = (nextTs - now.getTime()) / 60000
    if (deltaMinutes < 0) return 'overdue'
    if (deltaMinutes <= 60) return 'due_now'
    if (sameDay(next, now)) return 'due_later_today'
    const tomorrow = new Date(now)
    tomorrow.setDate(now.getDate() + 1)
    if (dayKey(next) === dayKey(tomorrow)) return 'due_tomorrow'
  }

  const outboundTs = pin.last_outbound_at ? new Date(pin.last_outbound_at).getTime() : 0
  const inboundTs = pin.last_inbound_at ? new Date(pin.last_inbound_at).getTime() : 0
  const coldThresholdHours = 72
  if (outboundTs > 0 && inboundTs < outboundTs && now.getTime() - outboundTs >= coldThresholdHours * 3600_000) {
    return 'stale_no_response'
  }
  return null
}

const deriveAllState = (pin: CommandMapPin): PinActivityState => {
  if (pin.suppression_status !== 'clear') return 'suppressed'
  const threadState = deriveThreadState(pin)
  if (threadState === 'new_replies' || threadState === 'needs_review' || threadState === 'negotiating') return threadState

  const sendState = deriveSendState(pin)
  if (sendState === 'queue_blocked' || sendState === 'failed' || sendState === 'replied' || sendState === 'sending' || sendState === 'queued') {
    return sendState
  }

  const followUpState = deriveFollowUpState(pin)
  if (followUpState === 'overdue' || followUpState === 'due_now' || followUpState === 'due_later_today' || followUpState === 'due_tomorrow') {
    return followUpState
  }

  if (sendState) return sendState
  if (followUpState) return followUpState
  return threadState
}

const activityLabelFor = (activityState: PinActivityState): string => {
  if (activityState === 'new_replies') return 'New Replies'
  if (activityState === 'needs_review') return 'Needs Review'
  if (activityState === 'waiting_on_seller') return 'Waiting on Seller'
  if (activityState === 'follow_up_due') return 'Follow-Up Due'
  if (activityState === 'stale_no_response') return 'Stale / No Response'
  if (activityState === 'queue_blocked') return 'Queue Blocked'
  if (activityState === 'due_now') return 'Due Now'
  if (activityState === 'due_later_today') return 'Later Today'
  if (activityState === 'due_tomorrow') return 'Due Tomorrow'
  if (activityState === 'opted_out') return 'Opted Out'
  return formatLabel(activityState)
}

const toActivityPins = (pins: CommandMapPin[], activityMode: InboxMapActivityMode): CommandMapPin[] => {
  return pins.flatMap((pin) => {
    const activityState =
      activityMode === 'all'
        ? deriveAllState(pin)
        : activityMode === 'threads'
        ? deriveThreadState(pin)
        : activityMode === 'sends'
          ? deriveSendState(pin)
          : deriveFollowUpState(pin)
    if (!activityState) return []
    return [{
      ...pin,
      activity_mode: activityMode,
      activity_state: activityState,
      activity_label: activityLabelFor(activityState),
    }]
  })
}

const matchesFilters = (pin: CommandMapPin, filters: MapFilterState): boolean => {
  if (filters.market && pin.market !== filters.market) return false
  if (filters.stage) {
    const stage = normalizeLifecycleStage(pin.lifecycle_stage || pin.conversation_stage)
    if (stage !== normalizeLifecycleStage(filters.stage)) return false
  }
  if (filters.status) {
    const status = normalizeOperationalStatus(pin.operational_status || pin.conversation_status)
    if (status !== normalizeOperationalStatus(filters.status)) return false
  }
  if (filters.leadTemperature) {
    const temp = normalizeLeadTemperature(pin.lead_temperature)
    if (temp !== normalizeLeadTemperature(filters.leadTemperature)) return false
  }
  if (filters.disposition) {
    const disposition = normalizeDisposition(pin.disposition)
    if (disposition !== normalizeDisposition(filters.disposition)) return false
  }
  if (filters.contactability) {
    const contactability = normalizeContactability(pin.contactability_status)
    if (contactability !== normalizeContactability(filters.contactability)) return false
  }
  if (filters.archiveOnly && !pin.is_archived) return false
  if (filters.snoozeOnly) {
    const snoozedUntil = pin.snoozed_until ? new Date(pin.snoozed_until).getTime() : 0
    if (!Number.isFinite(snoozedUntil) || snoozedUntil <= Date.now()) return false
  }
  if (filters.automationStatus && pin.automation_status !== filters.automationStatus) return false
  if (filters.messageDirection && pin.last_message_direction !== filters.messageDirection) return false
  if (filters.unreadOnly && !pin.unread) return false
  if (filters.followUpDue && pin.inbox_bucket !== 'follow_up_due') return false
  if (filters.highEquity && (pin.equity_percent ?? 0) < 50) return false
  if (filters.propertyType && pin.property_type !== filters.propertyType) return false
  if (filters.offerStatus && pin.offer_status !== filters.offerStatus) return false
  if (filters.contractStatus && pin.contract_status !== filters.contractStatus) return false
  if (filters.suppressionStatus && pin.suppression_status !== filters.suppressionStatus) return false
  if (filters.dateRange) {
    const days = Number(filters.dateRange)
    const ts = new Date(pin.last_activity_at).getTime()
    if (Number.isFinite(days) && Number.isFinite(ts)) {
      if (Date.now() - ts > days * 86400000) return false
    }
  }
  return true
}

const featureCollectionForPins = (
  pins: CommandMapPin[],
  selectedConversationId: string | null,
  activeKpiFilter: MapKpiFilterKey | null,
  styleMode: MapStyleMode,
): FeatureCollection<Point, PinFeatureProps> => {
  const features: FeatureCollection<Point, PinFeatureProps>['features'] = []

  const rings = ringColorsForTheme(styleMode)

  pins.forEach((pin) => {
    const selected = pin.conversation_id === selectedConversationId ? 1 : 0
    const focusMatch = matchesKpiFilter(pin, activeKpiFilter)
    const focusOpacity = selected ? 1 : activeKpiFilter ? (focusMatch ? 1 : 0.16) : 1
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [pin.lng, pin.lat] },
      properties: {
        ...pin,
        featureType: 'pin',
        selected,
        focusOpacity,
        stageColor: resolveCommandPinRingColor(pin),
        pulseTier:
          pin.activity_mode === 'sends'
            ? (pin.activity_state === 'sending'
              ? 'fast'
              : pin.activity_state === 'sent' || pin.activity_state === 'delivered' || pin.activity_state === 'replied' || pin.activity_state === 'opted_out'
                ? 'medium_fast'
                : pin.activity_state === 'failed'
                  ? 'fast'
                  : 'none')
            : pin.activity_mode === 'follow_ups'
              ? (pin.activity_state === 'overdue'
                ? 'medium'
                : pin.activity_state === 'due_now'
                  ? 'slow'
                  : 'none')
              : pulseTierFor(pin.last_activity_at),
        pulseMode: pulseModeFor(pin),
        glowStrength: glowStrength(pin.priority_score),
        unreadRingColor: pin.unread && pin.last_message_direction === 'inbound' ? rings.unread : 'transparent',
        offerRingColor: lower(pin.offer_status).includes('ready') || lower(pin.offer_status).includes('sent') ? rings.offer : 'transparent',
        contractRingColor: lower(pin.contract_status).includes('active') ? rings.contract : 'transparent',
        badgeColor: stageBadgeColor(pin),
        pinCount: 1,
        lockState: pin.suppression_status !== 'clear' ? 1 : 0,
        needsReviewBadge: pinNeedsWarning(pin) ? 1 : 0,
        followUpDueBadge: pin.inbox_bucket === 'follow_up_due' || pin.activity_state === 'due_now' || pin.activity_state === 'due_later_today' || pin.activity_state === 'due_tomorrow' || pin.activity_state === 'overdue' ? 1 : 0,
        suppressedBadge: pin.suppression_status !== 'clear' ? 1 : 0,
        queueBlockedBadge: pin.activity_state === 'queue_blocked' ? 1 : 0,
        propTypeSlug: normalizePropertyTypeSlug(pin.property_type ?? ''),
        icon_color: ASSET_TYPE_ICON_COLORS[resolveAcquisitionAssetFamily(pin.property_type ?? '')],
      },
    })
  })
  return { type: 'FeatureCollection', features }
}

const buildSellerPinsFeatureCollection = (
  pins: CommandMapSellerPin[],
  themeId: CommandMapThemeId,
  modeId: CommandMapIntelligenceModeId,
  selectedPropertyId: string | null,
): FeatureCollection<Point, Record<string, unknown>> => {
  const features: FeatureCollection<Point, Record<string, unknown>>['features'] = []

  pins.forEach((pin) => {
    const lat = Number(pin.lat ?? pin.latitude)
    const lng = Number(pin.lng ?? pin.longitude)
    if (!isValidCoord(lat, lng)) return

    const propertyId = text(pin.property_id)
    if (!propertyId) return

    const enriched = enrichAcquisitionRadarFeature(
      {
        properties: {
          ...pin,
          property_id: propertyId,
          assetType: pin.property_type ?? pin.asset_class ?? '',
          markerState: pin.seller_state ?? pin.seller_status ?? 'uncontacted',
          acquisitionScore: Number(pin.final_acquisition_score ?? pin.priority_score ?? pin.owner_priority_score) || 0,
          contactStatus: pin.seller_state ?? pin.seller_status,
          activityStatus: pin.inbox_category ?? pin.execution_state,
        },
      },
      themeId,
      { selectedPropertyId, modeId },
    )

    const semanticKey = String(enriched.semanticKey ?? '')
    const motion = semanticKey === 'uncontacted' ? 'static' : enriched.motion

    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lng, lat] },
      properties: {
        ...pin,
        ...enriched,
        property_id: propertyId,
        propTypeSlug: normalizePropertyTypeSlug(pin.property_type ?? pin.asset_class ?? ''),
        marker_key: enriched.marker_key,
        pulse_style: pin.pulse_style ?? 'none',
        motion,
        focus_opacity: 1,
        base_opacity: 1,
        pin_selected: selectedPropertyId === propertyId ? 1 : 0,
      },
    })
  })

  return { type: 'FeatureCollection', features }
}

const matchesKpiFilter = (pin: CommandMapPin, filter: MapKpiFilterKey | null): boolean => {
  if (!filter) return true
  if (filter === 'contract_active') return lower(pin.contract_status).includes('active')
  if (filter === 'offer_ready') return lower(pin.offer_status).includes('ready') || lower(pin.offer_status).includes('sent')
  if (filter === 'not_contacted') return pin.seller_state === 'not_contacted'
  return pin.activity_state === filter
}

const buildKpiChips = (pins: CommandMapPin[], activityMode: InboxMapActivityMode): MapKpiChip[] => {
  const build = (key: MapKpiFilterKey, label: string, tone: string) => ({
    key,
    label,
    tone,
    count: pins.filter((pin) => matchesKpiFilter(pin, key)).length,
  })

  if (activityMode === 'threads') {
    return [
      build('new_replies', 'New Replies', '#5bb6ff'),
      build('needs_review', 'Needs Review', '#f5b94c'),
      build('waiting_on_seller', 'Waiting', '#9ec3ff'),
      build('negotiating', 'Negotiating', '#b188ff'),
      build('follow_up_due', 'Follow-Up Due', '#3ed8a5'),
      build('not_contacted', 'Not Contacted', '#94a3b8'),
      build('suppressed', 'Suppressed', '#ff6b63'),
    ]
  }
  if (activityMode === 'sends') {
    return [
      build('queued', 'Queued', '#8f9bad'),
      build('sending', 'Sending', '#4d8fff'),
      build('delivered', 'Delivered', '#4fe18a'),
      build('replied', 'Replies', '#62d3ff'),
      build('failed', 'Failed', '#ff6b63'),
      build('queue_blocked', 'Routing Blocked', '#ff9d57'),
    ]
  }
  if (activityMode === 'follow_ups') {
    return [
      build('due_now', 'Due Now', '#ffb44d'),
      build('due_later_today', 'Later Today', '#5bb6ff'),
      build('due_tomorrow', 'Tomorrow', '#4fe18a'),
      build('overdue', 'Overdue', '#ff6b63'),
      build('stale_no_response', 'Stale', '#97a3b6'),
    ]
  }
  return [
    build('new_replies', 'New Replies', '#5bb6ff'),
    build('needs_review', 'Needs Review', '#f5b94c'),
    build('waiting_on_seller', 'Waiting', '#9ec3ff'),
    build('queued', 'Queued', '#8f9bad'),
    build('offer_ready', 'Offer Ready', '#4fe18a'),
    build('contract_active', 'Contracts', '#30d5c8'),
  ]
}

const isValidHttpUrl = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.trim().length === 0) return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

const sanitizeStyleSpec = (style: maplibregl.StyleSpecification | string): maplibregl.StyleSpecification | string | null => {
  if (typeof style === 'string') return style
  const normalizedSources: Record<string, unknown> = {}
  for (const [sourceId, sourceValue] of Object.entries(style.sources ?? {})) {
    const source = sourceValue as Record<string, unknown>
    if (source?.type === 'raster' && Array.isArray(source.tiles)) {
      const validTiles = (source.tiles as unknown[]).filter(isValidHttpUrl)
      if (validTiles.length === 0) return null
      normalizedSources[sourceId] = { ...source, tiles: validTiles }
      continue
    }
    normalizedSources[sourceId] = sourceValue
  }
  if (style.sprite && !isValidHttpUrl(style.sprite)) return null
  if (style.glyphs && !isValidHttpUrl(style.glyphs)) return null
  return { ...style, sources: normalizedSources as maplibregl.StyleSpecification['sources'] }
}

const resolveStyle = (styleMode: MapStyleMode): maplibregl.StyleSpecification | string => {
  const theme = getCommandMapTheme(normalizeMapVisualPresetId(styleMode))
  const sanitized = sanitizeStyleSpec(getCommandMapThemeStyle(styleMode))
  if (sanitized) return sanitized
  const fallback = getCommandMapTheme(theme.fallbackThemeId)
  return sanitizeStyleSpec(getCommandMapThemeStyle(fallback.id)) ?? getCommandMapThemeStyle('satellite')
}

const cardThemeStyleAttr = (styleMode: MapStyleMode): string =>
  Object.entries(getCommandMapTheme(styleMode).cardTheme).map(([key, value]) => `${key}:${value}`).join(';')

const mapThemeRootClassName = (styleMode: MapStyleMode): string => {
  switch (styleMode) {
    case 'satellite': return 'map-theme-satellite'
    case 'dark_ops': return 'map-theme-dark'
    case 'red_ops': return 'map-theme-red-ops'
    case 'matrix': return 'map-theme-matrix'
    case 'blueprint': return 'map-theme-blueprint'
    case 'monochrome': return 'map-theme-monochrome'
    case 'executive': return 'map-theme-executive'
    case 'terrain': return 'map-theme-terrain'
    case 'radar_night': return 'map-theme-radar-night'
    case 'light_street': return 'map-theme-light-street'
    default: return `map-theme-${String(styleMode).replace(/_/g, '-')}`
  }
}

const canvasFilterForTheme = (styleMode: MapStyleMode): string => {
  // Overlay raster themes are tinted via MapLibre raster paint — stacking CSS filters
  // on top double-processes the canvas and blacks out red_ops / matrix / etc.
  if (!RASTER_BASEMAP_THEMES.has(styleMode)) return 'none'
  if (styleMode === 'light_street' || styleMode === 'satellite') return 'none'
  if (styleMode === 'terrain') return 'saturate(1.08) contrast(1.04)'
  return 'none'
}

const MIN_MAP_CONTAINER_PX = 48

const readMapContainerDimensions = (el: HTMLElement | null) => {
  if (!el) return { width: 0, height: 0 }
  const rect = el.getBoundingClientRect()
  return { width: rect.width, height: rect.height }
}

const waitForMapContainerReady = (
  el: HTMLElement,
  isCancelled: () => boolean,
  timeoutMs = 12_000,
): Promise<void> => new Promise((resolve) => {
  const isReady = () => {
    const { width, height } = readMapContainerDimensions(el)
    return width >= MIN_MAP_CONTAINER_PX && height >= MIN_MAP_CONTAINER_PX
  }
  if (isCancelled()) {
    resolve()
    return
  }
  if (isReady()) {
    resolve()
    return
  }

  let observer: ResizeObserver | undefined
  const finish = () => {
    observer?.disconnect()
    window.clearTimeout(timer)
    resolve()
  }
  const timer = window.setTimeout(finish, timeoutMs)
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => {
      if (isCancelled() || isReady()) finish()
    })
    observer.observe(el)
  }
})

const countBuyerFilters = (filters: BuyerMapFilters | undefined): number => {
  if (!filters) return 0
  let count = 0
  const textKeys: Array<keyof BuyerMapFilters> = [
    'buyerType', 'buyerTier', 'buyerName', 'entityName', 'mailingName', 'companyName', 'buyerPhone', 'buyerEmail',
    'buyerMarket', 'buyerState', 'buyerZip', 'market', 'submarket', 'county', 'city', 'state', 'zip', 'neighborhood',
    'schoolDistrict', 'censusTract', 'opportunityZone', 'propertyType', 'assetClass', 'condition', 'renovationLevel',
    'occupancy', 'vacancy', 'lastPurchaseDateFrom', 'lastPurchaseDateTo', 'firstPurchaseDateFrom', 'firstPurchaseDateTo',
    'soldDateFrom', 'soldDateTo', 'recordingDateFrom', 'recordingDateTo', 'exitStrategyMatch',
  ]
  const rangeKeys: Array<keyof BuyerMapFilters> = [
    'maxPurchaseCount', 'maxMatchScore', 'maxDispoPriorityScore', 'minVelocityScore', 'maxVelocityScore',
    'minAveragePurchasePrice', 'maxAveragePurchasePrice', 'minMedianPurchasePrice', 'maxMedianPurchasePrice',
    'minHighestPurchasePrice', 'maxHighestPurchasePrice', 'minLowestPurchasePrice', 'maxLowestPurchasePrice',
    'minTotalSpend', 'maxTotalSpend', 'minCashPurchasePercent', 'maxCashPurchasePercent', 'minDaysSinceLastBuy',
    'maxDaysSinceLastBuy', 'minBeds', 'maxBeds', 'minBaths', 'maxBaths', 'minUnits', 'maxUnits', 'minSqft', 'maxSqft',
    'minLotSqft', 'maxLotSqft', 'minAcreage', 'maxAcreage', 'yearBuiltMin', 'yearBuiltMax', 'effectiveYearBuiltMin',
    'effectiveYearBuiltMax', 'minStories', 'maxStories', 'minSalePrice', 'maxSalePrice', 'minPricePerSqft', 'maxPricePerSqft',
    'minPricePerUnit', 'maxPricePerUnit', 'minArv', 'maxArv', 'minDiscountPercent', 'maxDiscountPercent',
    'minSpreadPotential', 'maxSpreadPotential', 'minEstimatedRehab', 'maxEstimatedRehab', 'minEquityPercent', 'maxEquityPercent',
    'minDistanceFromSubject', 'maxDistanceFromSubject', 'minConfidenceScore', 'maxConfidenceScore', 'minDemandScore', 'maxDemandScore',
  ]
  textKeys.forEach((key) => {
    if (typeof filters[key] === 'string' && text(filters[key])) count += 1
  })
  rangeKeys.forEach((key) => {
    if (filters[key] !== '') count += 1
  })
  if (filters.activityWindowDays !== defaultBuyerMapFilters.activityWindowDays) count += 1
  if (filters.radiusMiles !== defaultBuyerMapFilters.radiusMiles) count += 1
  if (filters.minPurchaseCount !== defaultBuyerMapFilters.minPurchaseCount) count += 1
  if (filters.minMatchScore !== defaultBuyerMapFilters.minMatchScore) count += 1
  if (filters.minDispoPriorityScore !== defaultBuyerMapFilters.minDispoPriorityScore) count += 1
  count += filters.buyerSourceTypes.length
  count += filters.buyerRoles.length
  count += filters.buyerIdentityTags.length
  count += filters.assetTypes.length
  count += filters.dealTypes.length
  count += filters.locationTags.length
  count += filters.matchTags.length
  return count
}

const buildBuyerHoverMarkup = (buyer: BuyerFeatureProps, styleMode: MapStyleMode): string => `
  <article class="nx-icm-hover nx-icm-hover--buyer" style="${escapeHtml(cardThemeStyleAttr(styleMode))}">
    <div class="nx-icm-hover__body">
      <div class="nx-icm-hover__head">
        <div>
          <p class="nx-icm-hover__eyebrow">${escapeHtml(buyerCategoryLabel(buyer.category))}</p>
          <h4>${escapeHtml(buyer.buyerName || 'Property Buyer')}</h4>
        </div>
        <span class="nx-icm-hover__status nx-icm-hover__status--accent">${escapeHtml(buyerMatchTier(buyer.matchScore || buyer.confidenceScore || 0))}</span>
      </div>
      <p class="nx-icm-hover__address"><span class="nx-icm-hover__address-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s6-5 6-10a6 6 0 0 0-12 0c0 5 6 10 6 10Z" /><circle cx="12" cy="10" r="2.2" /></svg></span>${escapeHtml(buyer.propertyAddressFull || buyer.market || 'Market Unknown')}</p>
      <div class="nx-icm-hover__stats">
        <div class="nx-icm-hover__metric is-accent"><div class="nx-icm-hover__metric-copy"><span>Sale Price</span><strong>${escapeHtml(formatCurrency(buyer.salePrice || null))}</strong></div></div>
        <div class="nx-icm-hover__metric"><div class="nx-icm-hover__metric-copy"><span>Sold</span><strong>${escapeHtml(buyer.saleDate ? formatRelative(buyer.saleDate) : 'Unknown')}</strong></div></div>
        <div class="nx-icm-hover__metric"><div class="nx-icm-hover__metric-copy"><span>Type</span><strong>${escapeHtml(buyer.buyerType || buyer.category || 'Investor')}</strong></div></div>
        <div class="nx-icm-hover__metric"><div class="nx-icm-hover__metric-copy"><span>PPSF</span><strong>${buyer.pricePerSqft ? escapeHtml(formatCurrency(buyer.pricePerSqft)) : '—'}</strong></div></div>
        <div class="nx-icm-hover__metric"><div class="nx-icm-hover__metric-copy"><span>Distance</span><strong>${buyer.distanceMiles ? `${buyer.distanceMiles.toFixed(1)} mi` : '—'}</strong></div></div>
        <div class="nx-icm-hover__metric"><div class="nx-icm-hover__metric-copy"><span>Source</span><strong>${escapeHtml(buyer.sourceLabel || 'Buyer')}</strong></div></div>
      </div>
    </div>
  </article>
`

const haversineMiles = (lat1: number, lng1: number, lat2: number, lng2: number): number => {
  const toRad = (value: number) => (value * Math.PI) / 180
  const earthRadiusMiles = 3958.8
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2)
  return earthRadiusMiles * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

type SoldCompMetricItem = {
  label: string
  value: string
  emphasis?: 'default' | 'accent' | 'hero'
}

type SoldCompPresentation = {
  variant: 'residential' | 'multifamily'
  accentHex: string
  salePrice: string
  saleDate: string
  sourceLabel: string
  buyerName: string
  buyerInitials: string
  buyerType: string
  buyerTone: 'institutional' | 'premium' | 'accent'
  entityLabel: string
  imageUrl: string
  imageLabel: string
  propertyLabel: string
  subtypeLabel: string | null
  distanceLabel: string | null
  headlineMetrics: SoldCompMetricItem[]
  supportMetrics: SoldCompMetricItem[]
  intelligenceChips: Array<{ label: string; value: string; tone?: 'success' | 'accent' | 'warning' | 'neutral' }>
  whyItMatters: string
}

const SOLD_COMP_INSTITUTIONAL_NAME_PATTERNS = [
  'INVITATION HOMES', 'PROGRESS RESIDENTIAL', 'AMERICAN HOMES 4 RENT', 'AH4R', 'TRICON',
  'AMHERST', 'FIRSTKEY', 'STARWOOD', 'BLACKSTONE', 'VINEBROOK', 'ROOFSTOCK', 'PRETIUM',
  'OPENDOOR', 'OFFERPAD', 'HOME PARTNERS OF AMERICA', 'MAYMONT HOMES', 'SECOND AVENUE',
]

const SOLD_COMP_INSTITUTIONAL_KEYWORDS = [
  'REIT', 'HEDGE FUND', 'PORTFOLIO', 'SINGLE FAMILY RENTAL', 'INSTITUTIONAL',
  'CAPITAL', 'FUND', 'OPPORTUNITY FUND', 'ASSET MANAGEMENT', 'INVESTMENT MANAGEMENT',
]

const SOLD_COMP_BUILDER_KEYWORDS = [
  'BUILDER', 'BUILDERS', 'DEVELOPMENT', 'DEVELOPER', 'CONSTRUCTION', 'HOMES',
  'LAND DEVELOPMENT', 'CUSTOM HOME', 'COMMUNITIES',
]

const SOLD_COMP_OPERATOR_KEYWORDS = [
  'APARTMENTS', 'APARTMENT', 'RESIDENCES', 'RESIDENCE', 'COMMUNITY', 'COMMUNITIES',
  'LIVING', 'HOLDINGS', 'PROPERTIES', 'MANAGEMENT', 'LOFTS', 'VILLAS',
]

const formatDateLabel = (value: string | null | undefined): string => {
  if (!value) return 'Date Unknown'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Date Unknown'
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

const formatDecimal = (value: number | null | undefined, digits = 1): string => {
  if (!Number.isFinite(value ?? NaN)) return '—'
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(value as number)
}

const formatLotSizeLabel = (lotAcreage: number | null | undefined, lotSquareFeet: number | null | undefined): string => {
  if (Number.isFinite(lotAcreage ?? NaN) && (lotAcreage as number) >= 1) return `${formatDecimal(lotAcreage, 2)} ac`
  if (Number.isFinite(lotAcreage ?? NaN) && (lotAcreage as number) > 0) return `${formatDecimal(lotAcreage, 2)} ac`
  if (Number.isFinite(lotSquareFeet ?? NaN)) return `${formatInteger(lotSquareFeet as number)} sf`
  return '—'
}

const initialsFromName = (value: string): string => {
  const parts = value
    .replace(/[^A-Za-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((part) => !['LLC', 'LP', 'LTD', 'INC', 'CORP', 'TRUST', 'CO', 'COMPANY', 'HOLDINGS'].includes(part.toUpperCase()))
    .slice(0, 2)
  if (parts.length === 0) return 'SC'
  return parts.map((part) => part[0]?.toUpperCase() ?? '').join('').slice(0, 2)
}

const toUpperTokens = (value: string): string => value.toUpperCase().replace(/\s+/g, ' ').trim()

const inferSoldCompVariant = (comp: RecentSoldComp): SoldCompPresentation['variant'] => {
  const anyComp = comp as RecentSoldComp & Record<string, unknown>
  const propertyType = toUpperTokens(text(comp.property_type))
  const subtype = toUpperTokens(text(comp.normalized_asset_class || comp.property_class))
  const units = Number(comp.units_count ?? anyComp.units_count ?? 0)
  if (
    units >= 5
    || propertyType.includes('APARTMENT')
    || propertyType.includes('MULTI')
    || subtype.includes('APARTMENT')
    || subtype.includes('MULTIFAMILY')
  ) {
    return 'multifamily'
  }
  return 'residential'
}

const classifySoldCompBuyer = (comp: RecentSoldComp, variant: SoldCompPresentation['variant']) => {
  const anyComp = comp as RecentSoldComp & Record<string, unknown>
  const buyerName = [
    text(anyComp.buyer_display_name),
    text(anyComp.buyer_name),
    text(comp.owner_name),
  ].find(Boolean) || 'Unknown Buyer'
  const tokens = toUpperTokens(buyerName)
  const providedLabel = text(comp.buyer_type_label)

  let buyerType = providedLabel && !providedLabel.toUpperCase().includes('UNKNOWN') ? providedLabel : ''
  let buyerTone: SoldCompPresentation['buyerTone'] = comp.is_corporate_owner ? 'premium' : 'accent'
  let entityLabel = comp.is_corporate_owner === false ? 'Individual' : 'Corporate'

  const institutionalMatch =
    SOLD_COMP_INSTITUTIONAL_NAME_PATTERNS.some((pattern) => tokens.includes(pattern))
    || (
      comp.is_corporate_owner !== false
      && SOLD_COMP_INSTITUTIONAL_KEYWORDS.some((pattern) => tokens.includes(pattern))
    )

  const builderMatch =
    comp.is_corporate_owner !== false
    && SOLD_COMP_BUILDER_KEYWORDS.some((pattern) => tokens.includes(pattern))

  const apartmentOperatorMatch =
    comp.is_corporate_owner !== false
    && (
      SOLD_COMP_OPERATOR_KEYWORDS.some((pattern) => tokens.includes(pattern))
      || (tokens.includes('LLC') && variant === 'multifamily')
    )

  if (!buyerType) {
    if (institutionalMatch) buyerType = 'Hedge Fund / Institutional'
    else if (builderMatch) buyerType = 'Builder / Developer'
    else if (apartmentOperatorMatch) buyerType = 'Apartment Operator'
    else if (comp.is_corporate_owner) buyerType = variant === 'multifamily' && tokens.includes('LLC') ? 'Investor / Operator' : 'Corporate Buyer'
    else if (comp.is_corporate_owner === false) buyerType = 'Individual Buyer'
    else if (tokens.includes('LLC') || tokens.includes('LP') || tokens.includes('TRUST')) buyerType = variant === 'multifamily' ? 'Investor / Operator' : 'Corporate Buyer'
    else buyerType = 'Individual Buyer'
  }

  if (/INDIVIDUAL/i.test(buyerType)) entityLabel = 'Individual'
  else entityLabel = institutionalMatch || builderMatch || apartmentOperatorMatch || comp.is_corporate_owner !== false ? 'Corporate' : 'Individual'

  if (institutionalMatch || /HEDGE FUND|INSTITUTIONAL/i.test(buyerType)) buyerTone = 'institutional'
  else if (entityLabel === 'Corporate') buyerTone = 'premium'
  else buyerTone = 'accent'

  return {
    buyerName,
    buyerType,
    buyerTone,
    entityLabel,
  }
}

const buildSoldCompPresentation = (
  comp: RecentSoldComp,
  subject?: { latitude?: number | null; longitude?: number | null; normalized_asset_class?: string | null; building_square_feet?: number | null } | null,
  zoom: number = 14,
): SoldCompPresentation => {
  const anyComp = comp as RecentSoldComp & Record<string, unknown>
  const variant = inferSoldCompVariant(comp)
  const accentHex = '#ef4444'
  const salePriceValue = comp.sale_price ?? comp.mls_sold_price ?? null
  const salePrice = formatCurrency(salePriceValue)
  const saleDate = formatDateLabel(comp.sale_date || comp.mls_sold_date)
  
  const rawSource = comp.sale_source
    || (comp.mls_sold_price || comp.mls_sold_date ? 'MLS Sold' : (comp.sale_price || comp.sale_date ? 'Public Record Sold' : 'Sold'))
  
  let sourceLabel = 'Sold for comps'
  if (zoom >= 14) {
    if (rawSource.toLowerCase().includes('mls')) sourceLabel = 'MLS Sold'
    else if (rawSource.toLowerCase().includes('public record') || rawSource.toLowerCase().includes('pr')) sourceLabel = 'PR Sold'
    else sourceLabel = 'Sold'
  }
  const { buyerName, buyerType, buyerTone, entityLabel } = classifySoldCompBuyer(comp, variant)
  const buyerInitials = initialsFromName(buyerName)
  const imageUrl = text(anyComp.streetview_image) || text(anyComp.map_image) || text(comp.satellite_image) || buildStreetViewUrl(comp.property_address_full, comp.latitude, comp.longitude) || ''
  const imageLabel = text(anyComp.streetview_image) ? 'Street View' : 'Property Preview'
  const propertyLabel = text(comp.property_type) || (variant === 'multifamily' ? 'Apartment' : 'Residential')
  const subtypeLabel = text(comp.normalized_asset_class || comp.property_class) || null
  const distance =
    subject?.latitude && subject?.longitude
      ? haversineMiles(subject.latitude, subject.longitude, comp.latitude, comp.longitude)
      : null
  const distanceLabel = distance !== null ? `${distance.toFixed(distance < 1 ? 2 : 1)} mi away` : null
  const units = Number(comp.units_count ?? anyComp.units_count ?? 0) || 0
  const buildingSqft = Number(comp.building_square_feet ?? 0) || null
  const totalBeds = Number(comp.total_bedrooms ?? 0) || null
  const totalBaths = Number(comp.total_baths ?? 0) || null
  const ppsf =
    comp.computed_ppsf
    ?? comp.arv_ppsf
    ?? (salePriceValue && buildingSqft ? Math.round(salePriceValue / buildingSqft) : null)
  const ppu = salePriceValue && units > 1 ? Math.round(salePriceValue / units) : null
  const sqftPerUnit = Number(anyComp.avg_sqft_per_unit ?? anyComp.sqft_per_unit ?? (buildingSqft && units > 0 ? Math.round(buildingSqft / units) : NaN))
  const bedsPerUnit = Number(anyComp.beds_per_unit ?? (totalBeds && units > 0 ? totalBeds / units : NaN))
  const bathsPerUnit = Number(totalBaths && units > 0 ? totalBaths / units : NaN)
  const lotSize = formatLotSizeLabel(comp.lot_acreage, comp.lot_square_feet)
  const yearBuilt = formatInteger(comp.year_built ?? (anyComp.effective_year_built as number | null) ?? null)
  const confidenceValue = comp.comp_confidence_score ? `${Math.round(comp.comp_confidence_score)}%` : '—'
  const gradeValue = text(comp.deal_grade) || 'Watchlist'
  const conditionValue = text(comp.building_condition) || 'Condition N/A'
  const constructionValue = text(comp.construction_type) || 'Construction N/A'
  const estimatedValue = formatCurrency(comp.arv_estimate)
  const offValueRaw =
    Number(anyComp.potential_spread ?? NaN)
    || (
      Number.isFinite(comp.arv_estimate ?? NaN) && Number.isFinite(salePriceValue ?? NaN)
        ? Math.round((comp.arv_estimate as number) - (salePriceValue as number))
        : NaN
    )
  const offPercentRaw =
    Number.isFinite(comp.arv_estimate ?? NaN) && Number.isFinite(offValueRaw)
      ? ((offValueRaw as number) / Math.max(comp.arv_estimate as number, 1)) * 100
      : Number(anyComp.target_margin_percent ?? NaN)
  const offValue = formatCurrency(Number.isFinite(offValueRaw) ? offValueRaw as number : null)
  const offPercent = Number.isFinite(offPercentRaw) ? `${Math.round((offPercentRaw as number) * 10) / 10}%` : '—'
  const bedsBathsSqft = [totalBeds ? `${formatDecimal(totalBeds, 1)} bd` : '', totalBaths ? `${formatDecimal(totalBaths, 1)} ba` : '', buildingSqft ? `${formatInteger(buildingSqft)} sf` : '']
    .filter(Boolean)
    .join(' • ') || '—'

  const headlineMetrics: SoldCompMetricItem[] = variant === 'multifamily'
    ? [
        { label: 'Units', value: formatInteger(units || null), emphasis: 'hero' },
        { label: 'Avg SF/Unit', value: formatInteger(Number.isFinite(sqftPerUnit) ? sqftPerUnit : null) },
        { label: 'Beds/Unit', value: Number.isFinite(bedsPerUnit) ? formatDecimal(bedsPerUnit, 1) : '—' },
        { label: 'Baths/Unit', value: Number.isFinite(bathsPerUnit) ? formatDecimal(bathsPerUnit, 1) : '—' },
      ]
    : [
        { label: 'Beds / Baths / Sqft', value: bedsBathsSqft, emphasis: 'hero' },
        { label: 'Year Built', value: yearBuilt },
        { label: 'Condition', value: conditionValue },
        { label: 'Construction', value: constructionValue },
      ]

  const supportMetrics: SoldCompMetricItem[] = variant === 'multifamily'
    ? [
        { label: ppu ? 'Price / Unit' : 'PPSF', value: ppu ? formatCurrency(ppu) : formatCurrency(ppsf), emphasis: 'accent' },
        { label: 'Total Sqft', value: formatInteger(buildingSqft) },
        { label: 'Est. Value', value: estimatedValue },
        { label: 'Off Value', value: offValue },
        { label: '% Off', value: offPercent },
        { label: 'Built / Cond.', value: `${yearBuilt} • ${conditionValue}` },
      ]
    : [
        { label: 'PPSF', value: formatCurrency(ppsf), emphasis: 'accent' },
        { label: 'Est. Value', value: estimatedValue },
        { label: 'Off Value', value: offValue },
        { label: '% Off', value: offPercent },
        ...(lotSize !== '—' ? [{ label: 'Lot Size', value: lotSize }] : []),
      ]

  const intelligenceChips: SoldCompPresentation['intelligenceChips'] = [
    { label: 'Grade', value: gradeValue, tone: 'success' as const },
    { label: 'Confidence', value: confidenceValue, tone: 'accent' as const },
    { label: 'Buyer', value: buyerType, tone: buyerTone === 'institutional' ? 'warning' : 'neutral' },
  ]

  const sameAssetClass =
    Boolean(subject?.normalized_asset_class)
    && Boolean(comp.normalized_asset_class)
    && text(subject?.normalized_asset_class).toLowerCase() === text(comp.normalized_asset_class).toLowerCase()
  const tightDistance = distance !== null && distance <= 0.75
  const similarSize =
    Number.isFinite(subject?.building_square_feet ?? NaN)
    && Number.isFinite(buildingSqft ?? NaN)
    && Math.abs((subject?.building_square_feet ?? 0) - (buildingSqft ?? 0)) <= 500

  let whyItMatters = 'Recent sold comp for pricing context.'
  if (variant === 'multifamily' && units > 0) {
    whyItMatters = `Unitized comp with ${formatInteger(units)} doors and ${formatCurrency(ppu)} per unit for apartment pricing.`
  } else if (tightDistance && sameAssetClass) {
    whyItMatters = 'Tight-radius asset-class match that strongly supports nearby pricing decisions.'
  } else if (tightDistance && similarSize) {
    whyItMatters = 'Close-proximity size match that helps anchor residential sold pricing.'
  } else if (comp.comp_confidence_score && comp.comp_confidence_score >= 85) {
    whyItMatters = 'High-confidence sold comp that should carry meaningful weight in comp review.'
  }

  return {
    variant,
    accentHex,
    salePrice,
    saleDate,
    sourceLabel,
    buyerName,
    buyerInitials,
    buyerType,
    buyerTone,
    entityLabel,
    imageUrl,
    imageLabel,
    propertyLabel,
    subtypeLabel,
    distanceLabel,
    headlineMetrics,
    supportMetrics,
    intelligenceChips,
    whyItMatters,
  }
}


// ── Unified Map Card System ────────────────────────────────────────────────
// Single source of truth for all floating map cards.
// Replaces: standalone hoverPopupRef seller/comp hover + old compCardAnchor system.

const DEBUG_MAP_CARDS_CONST = false // Separate from module-level for React closure safety

function getViewportSafeCardStyle(
  anchor: { x: number; y: number },
  containerSize: { width: number; height: number },
  cardWidth: number,
  cardMaxHeight: number,
  gap = 18,
  navOffset = 88,
  bottomOffset = 36,
): React.CSSProperties {
  const { x, y } = anchor
  const { width: cw, height: ch } = containerSize
  const LEFT_MARGIN = 16
  const RIGHT_MARGIN = 16

  let left = x + gap
  let top = y - Math.floor(cardMaxHeight / 2)

  // Flip left if near right edge
  if (left + cardWidth > cw - RIGHT_MARGIN) {
    left = x - cardWidth - gap
  }
  // Clamp left
  if (left < LEFT_MARGIN) left = LEFT_MARGIN
  // Clamp top below nav
  if (top < navOffset) top = navOffset
  // Clamp top above bottom
  const maxTop = ch - cardMaxHeight - bottomOffset
  if (top > maxTop) top = Math.max(navOffset, maxTop)

  const availHeight = ch - top - bottomOffset
  const finalHeight = Math.min(cardMaxHeight, Math.max(240, availHeight))
  return {
    position: 'absolute',
    left,
    top,
    width: Math.min(cardWidth, cw - LEFT_MARGIN - RIGHT_MARGIN),
    height: finalHeight,
    maxHeight: finalHeight,
    // overflow: hidden is on the card via CSS, body handles internal scroll
  }
}


const SoldCompMapCard = ({
  comp,
  intent,
  anchor,
  containerSize,
  subject,
  onClose,
  onCenterMap,
  onOpenCompIntel,
  onMouseEnter,
  onMouseLeave,
}: {
  comp: RecentSoldComp
  intent: MapCardIntent
  anchor: { x: number; y: number }
  containerSize: { width: number; height: number }
  subject?: any | null
  onClose: () => void
  onCenterMap: (lng: number, lat: number) => void
  onOpenCompIntel?: () => void
  onOpenDealIntelligence?: () => void
  onMouseEnter?: () => void
  onMouseLeave?: () => void
}) => {
  const isSelected = intent === 'selected'
  const cardWidth = isSelected ? 480 : 360
  const cardMaxHeight = isSelected
    ? Math.min(720, containerSize.height - 120)
    : Math.min(420, containerSize.height - 140)

  const cardStyle = getViewportSafeCardStyle(anchor, containerSize, cardWidth, cardMaxHeight)

  const intelligence = buildSoldCompPresentation(comp, subject, 14)
  const price = comp.mls_sold_price ?? comp.sale_price ?? 0
  const imageUrl = comp.streetview_image || comp.satellite_image || buildStreetViewUrl(comp.property_address_full, comp.latitude, comp.longitude) || ''
  const ppsf = comp.computed_ppsf ?? comp.arv_ppsf ?? (price && comp.building_square_feet ? Math.round(price / comp.building_square_feet) : null)
  const distance = (subject?.latitude && subject?.longitude)
    ? haversineMiles(subject.latitude, subject.longitude, comp.latitude, comp.longitude)
    : null

  return (
    <div
      className={cls(
        'nx-map-card nx-map-card--comp',
        isSelected ? 'nx-map-card--selected' : 'nx-map-card--hover',
      )}
      style={cardStyle}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* MAP_CARD_AUDIT: unified sold comp card (hover=compact, selected=full) */}
      {/* Close button */}
      {isSelected && (
        <button type="button" className="nx-map-card__close-btn" onClick={onClose} aria-label="Close">×</button>
      )}

      {/* Media header */}
      <div className="nx-map-card__media">
        {imageUrl ? (
          <img src={imageUrl} alt={comp.property_address_full || 'Comp'} loading="lazy" />
        ) : (
          <div className="nx-map-card__media-placeholder">No Preview</div>
        )}
        <div className="nx-map-card__media-scrim" />
        <div className="nx-map-card__media-hero">
          <div className="nx-map-card__price-label">{intelligence.salePrice}</div>
          <div className="nx-map-card__price-sub">
            <span className="nx-map-card__pill nx-map-card__pill--source">{intelligence.sourceLabel}</span>
            <span>{intelligence.saleDate}</span>
          </div>
        </div>
      </div>

      {/* Scrollable body */}
      <div className="nx-map-card__body">
        {/* Address + pills */}
        <div className="nx-map-card__identity">
          <div className="nx-map-card__pills">
            <span className="nx-map-card__pill">{intelligence.propertyLabel}</span>
            {distance !== null && (
              <span className="nx-map-card__pill nx-map-card__pill--muted">{distance.toFixed(1)} mi</span>
            )}
            {comp.deal_grade ? (
              <span className="nx-map-card__pill nx-map-card__pill--gold">Grade {comp.deal_grade}</span>
            ) : null}
            <span className={cls('nx-map-card__pill', `nx-map-card__pill--buyer-${intelligence.buyerTone}`)}>
              {intelligence.buyerType}
            </span>
          </div>
          <div className="nx-map-card__address">{comp.property_address_full || 'Address Unknown'}</div>
        </div>

        {/* Buyer row */}
        <div className="nx-map-card__buyer-row">
          <div className="nx-map-card__buyer-avatar">{intelligence.buyerInitials}</div>
          <div className="nx-map-card__buyer-copy">
            <div className="nx-map-card__buyer-name">{intelligence.buyerName}</div>
            <div className="nx-map-card__buyer-entity">{intelligence.entityLabel}</div>
          </div>
        </div>

        {/* Why it matters */}
        {intelligence.whyItMatters && (
          <div className="nx-map-card__match-note">
            ◆ {intelligence.whyItMatters}
          </div>
        )}

        {/* Headline metrics */}
        <div className="nx-map-card__metric-grid">
          {intelligence.headlineMetrics.slice(0, isSelected ? 6 : 3).map((m) => (
            <div key={m.label} className={cls('nx-map-card__metric', m.emphasis === 'accent' ? 'nx-map-card__metric--accent' : m.emphasis === 'hero' ? 'nx-map-card__metric--hero' : '')}>
              <span>{m.label}</span>
              <strong>{m.value}</strong>
            </div>
          ))}
          {ppsf && (
            <div className="nx-map-card__metric">
              <span>PPSF</span>
              <strong>{formatCurrency(ppsf)}</strong>
            </div>
          )}
        </div>

        {/* Support metrics — selected only */}
        {isSelected && intelligence.supportMetrics.length > 0 && (
          <div className="nx-map-card__metric-grid nx-map-card__metric-grid--support">
            {intelligence.supportMetrics.map((m) => (
              <div key={m.label} className={cls('nx-map-card__metric', m.emphasis === 'accent' ? 'nx-map-card__metric--accent' : '')}>
                <span>{m.label}</span>
                <strong>{m.value}</strong>
              </div>
            ))}
          </div>
        )}

        {/* Intelligence chips — selected only */}
        {isSelected && intelligence.intelligenceChips.length > 0 && (
          <div className="nx-map-card__chips">
            {intelligence.intelligenceChips.map((chip) => (
              <div key={chip.label} className={cls('nx-map-card__chip', chip.tone ? `nx-map-card__chip--${chip.tone}` : '')}>
                <span>{chip.label}</span>
                <strong>{chip.value}</strong>
              </div>
            ))}
          </div>
        )}

        {/* Subject comp match — selected only */}
        {isSelected && subject && distance !== null && (
          <div className="nx-map-card__metric-grid nx-map-card__metric-grid--support">
            <div className="nx-map-card__metric">
              <span>Distance</span>
              <strong>{distance.toFixed(2)} mi</strong>
            </div>
            <div className={cls('nx-map-card__metric', subject.normalized_asset_class === comp.normalized_asset_class ? 'nx-map-card__metric--green' : 'nx-map-card__metric--accent')}>
              <span>Asset Match</span>
              <strong>{subject.normalized_asset_class === comp.normalized_asset_class ? 'Match' : 'Mismatch'}</strong>
            </div>
          </div>
        )}
      </div>

      {/* Footer actions */}
      {isSelected && (
        <div className="nx-map-card__footer nx-map-card__actions">
          <button type="button" className="nx-mic-btn nx-mic-btn--success" onClick={() => { if (DEBUG_MAP_CARDS_CONST) console.debug('[MapCard] Add to ARV') }}>Add to ARV</button>
          <button type="button" className="nx-mic-btn nx-mic-btn--danger" onClick={() => { if (DEBUG_MAP_CARDS_CONST) console.debug('[MapCard] Exclude comp') }}>Exclude</button>
          <button type="button" className="nx-mic-btn" onClick={() => onCenterMap(comp.longitude, comp.latitude)}>Center</button>
          {onOpenCompIntel && (
            <button type="button" className="nx-mic-btn nx-mic-btn--violet" onClick={onOpenCompIntel}>Comp Intel</button>
          )}
        </div>
      )}
    </div>
  )
}

const MapEntityCard = ({
  card,
  subject,
  onClose,
  onCenterMap,
  onOpenDealIntelligence,
  onOpenCompIntel,
  clearHoverTimerRef,
  cancelClearHover,
  onPeekToFocus,
  sellerDraftText = '',
  onSellerDraftChange,
  onSellerSend: _onSellerSend,
  sellerMessagingDisabled: _sellerMessagingDisabled = false,
  onSellerActivityRefresh,
}: {
  card: MapCardState
  subject?: any | null
  onClose: () => void
  onCenterMap: (lng: number, lat: number) => void
  onOpenDealIntelligence?: () => void
  onOpenCompIntel?: () => void
  clearHoverTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>
  cancelClearHover: () => void
  onPeekToFocus?: () => void
  sellerDraftText?: string
  onSellerDraftChange?: (value: string) => void
  onSellerSend?: (value: string) => void | Promise<void>
  sellerMessagingDisabled?: boolean
  onSellerActivityRefresh?: () => void
}) => {
  if (!card) return null

  const handleMouseEnter = () => {
    if (card.intent === 'hover') cancelClearHover()
  }
  const handleMouseLeave = () => {
    if (card.intent === 'hover') {
      if (clearHoverTimerRef.current) clearTimeout(clearHoverTimerRef.current)
      clearHoverTimerRef.current = setTimeout(() => {
        clearHoverTimerRef.current = null
        onClose()
      }, 120)
    }
  }

  if (card.kind === 'sold_comp') {
    const comp = card.feature as unknown as RecentSoldComp
    return (
      <div
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: card.intent === 'selected' ? 28 : 22 }}
      >
        <SoldCompMapCard
          comp={comp}
          intent={card.intent}
          anchor={card.anchor}
          containerSize={card.containerSize}
          subject={subject}
          onClose={onClose}
          onCenterMap={onCenterMap}
          onOpenCompIntel={onOpenCompIntel}
          onOpenDealIntelligence={onOpenDealIntelligence}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        />
      </div>
    )
  }

  if (card.kind === 'seller') {
    const pin = card.feature
    const mode = card.intent === 'selected' ? 'focus' : 'peek'
    return (
      <div
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: card.intent === 'selected' ? 28 : 22 }}
      >
        <SellerMapCard
          key={text((pin as Record<string, unknown>).property_id) || card.id}
          record={pin}
          mode={mode}
          anchor={card.anchor}
          containerSize={card.containerSize}
          draftText={sellerDraftText}
          onDraftChange={onSellerDraftChange}
          onClose={card.intent === 'selected' ? onClose : undefined}
          onPeekToFocus={card.intent === 'hover' ? onPeekToFocus : undefined}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          onActivityRefresh={onSellerActivityRefresh}
        />
      </div>
    )
  }

  return null
}


const BuyerSelectionCard = ({
  purchase,
  purchases,
  matches,
  profile,
  onSelectBuyer,
}: {
  purchase: BuyerRecentPurchase | null
  purchases: BuyerRecentPurchase[]
  matches: BuyerCommandData['matches']
  profile: BuyerCommandData['profiles'][number] | null
  onSelectBuyer: (buyerKey: string | null) => void
}) => {
  if (!purchase) return null
  const match = matches.find((item) => item.buyerKey === purchase.buyerKey) || null
  const recentTrail = purchases
    .slice()
    .sort((left, right) => new Date(right.saleDate || 0).getTime() - new Date(left.saleDate || 0).getTime())
    .slice(0, 4)
  const badges = [
    profile?.buyerGrade ? `${profile.buyerGrade}-Tier Buyer` : null,
    profile?.isRepeatBuyer ? 'Repeat Buyer' : null,
    profile?.isCorporateBuyer ? 'Corporate Buyer' : null,
    profile?.isLocalBuyer ? 'Local Investor' : null,
    profile?.isOffMarketBuyer ? 'Off-Market Buyer' : null,
    profile?.category === 'institutional' ? 'Institutional' : null,
  ].filter(Boolean) as string[]
  return (
    <article className="nx-icm-buyer-card nx-icm-buyer-card--premium">
      <div className="nx-icm-buyer-card__head nx-icm-buyer-card__head--premium">
        <div className="nx-icm-buyer-card__hero">
          <div className="nx-icm-buyer-card__avatar">{buyerInitials(purchase.buyerName || 'Buyer')}</div>
          <div>
          <span className="nx-icm-buyer-card__eyebrow">{buyerCategoryLabel(purchase.category)}</span>
          <strong>{purchase.buyerName || 'Property Buyer'}</strong>
            <small>{purchase.market || 'Market Unknown'} • {purchase.saleDate ? formatRelative(purchase.saleDate) : 'Unknown'}</small>
          </div>
        </div>
        <button type="button" className="nx-icm__mode-tab" onClick={() => onSelectBuyer(purchase.buyerKey || null)}>
          Open Buyer
        </button>
      </div>
      <div className="nx-icm-buyer-card__badges">
        {badges.map((badge) => <span key={badge}>{badge}</span>)}
      </div>
      <div className="nx-icm-buyer-card__grid nx-icm-buyer-card__grid--premium">
        <div className="nx-icm-buyer-card__metric"><span>Address</span><strong>{purchase.propertyAddressFull || 'Property Unknown'}</strong></div>
        <div className="nx-icm-buyer-card__metric"><span>Sale Price</span><strong>{formatCurrency(purchase.salePrice)}</strong></div>
        <div className="nx-icm-buyer-card__metric"><span>Price / Sqft</span><strong>{formatCurrency(purchase.pricePerSqft)}</strong></div>
        <div className="nx-icm-buyer-card__metric"><span>Source</span><strong>{purchase.isOffMarketPurchase ? 'Off-Market / Public Record' : 'MLS'}</strong></div>
        <div className="nx-icm-buyer-card__metric"><span>Distance</span><strong>{purchase.distanceMiles != null ? `${purchase.distanceMiles.toFixed(1)} mi` : '—'}</strong></div>
        <div className="nx-icm-buyer-card__metric"><span>Purchase Trail</span><strong>{recentTrail.length} visible purchases</strong></div>
      </div>
      {match ? (
        <div className="nx-icm-buyer-card__summary">
          <span className="nx-icm-buyer-card__section-label">Live Match</span>
          <strong>{buyerMatchTier(match.matchScore)} • {match.matchScore ?? '—'}/100</strong>
          <p>{match.reasonForMatch || match.recommendedAction}</p>
        </div>
      ) : null}
      <div className="nx-icm-buyer-card__trail">
        {recentTrail.map((item) => (
          <div key={`${item.buyerKey}-${item.propertyId}`} className="nx-icm-buyer-card__trail-item">
            <div className="nx-icm-buyer-card__trail-item-head">
              <strong>{item.propertyAddressFull || 'Property Unknown'}</strong>
              <span>{item.saleDate ? formatRelative(item.saleDate) : 'Unknown'}</span>
            </div>
            <div className="nx-icm-buyer-card__trail-item-meta">
              <span>{formatCurrency(item.salePrice)}</span>
              <span>{item.propertyType || 'Unknown type'}</span>
              <span>{item.pricePerSqft ? `${formatCurrency(item.pricePerSqft)} ppsf` : '—'}</span>
              <span>{item.isOffMarketPurchase ? 'Off-Market' : 'MLS'}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="nx-icm-buyer-card__actions nx-icm-buyer-card__actions--premium">
        <a href={zillowSearchUrl(purchase.propertyAddressFull)} target="_blank" rel="noreferrer">Open Zillow</a>
        <a href={mapsSearchUrl(purchase.propertyAddressFull)} target="_blank" rel="noreferrer">Open Maps</a>
        <button type="button" onClick={() => onSelectBuyer(purchase.buyerKey || null)}>Show Only This Buyer</button>
      </div>
    </article>
  )
}

// ── Census Intelligence Panel ──────────────────────────────────────────────────
const CensusIntelPanel = ({
  data,
  styleMode,
  title,
  subtitle,
  metrics,
  emptyMessage,
}: {
  data: CensusData | null
  styleMode: MapStyleMode
  title: string
  subtitle: string
  metrics?: Array<{ label: string; value: string }>
  emptyMessage?: string
}) => {
  const { score, grade, summary } = data
    ? calculateInvestorOpportunityScore(data)
    : { score: 0, grade: 'Watchlist', summary: emptyMessage || 'No census intelligence available.' }
  const gradeColor: Record<string, string> = {
    A: '#14b8a6', B: '#f59e0b', C: '#fb923c', Watchlist: '#6b7280',
  }
  const fmt = (n: number | undefined, prefix = '', suffix = '') =>
    n != null && Number.isFinite(n) ? `${prefix}${n.toLocaleString()}${suffix}` : '—'
  const fmtK = (n: number | undefined) =>
    n != null && Number.isFinite(n) ? `$${Math.round(n / 1000)}K` : '—'
  const fmtPct = (n: number | undefined) =>
    n != null && Number.isFinite(n) ? `${Math.round(n)}%` : '—'
  const metricRows = data
    ? [
        { label: 'Med. Income', value: fmtK(data.median_household_income) },
        { label: 'Vacancy', value: fmtPct(data.vacancy_rate) },
        { label: 'Renter%', value: fmtPct(data.renter_occupied_percent) },
        { label: 'Owner%', value: fmtPct(data.owner_occupied_percent) },
        { label: 'Med. Rent', value: fmt(data.median_gross_rent, '$') },
        { label: 'Med. Value', value: fmtK(data.median_home_value) },
        { label: 'Pop/mi²', value: fmt(data.population_density) },
        { label: 'Opp Score', value: `${score}` },
      ]
    : (metrics ?? [])

  return (
    <div className="nx-icm__census-panel">
      <div className="nx-icm__census-panel-head">
        <div className="nx-icm__census-panel-headercopy">
          <span className="nx-icm__census-panel-title">
            <span className="nx-icm__census-dot" />
            {title}
          </span>
          <small className="nx-icm__census-panel-subtitle">{subtitle}</small>
        </div>
        <span
          className="nx-icm__census-grade"
          style={{ color: gradeColor[grade] ?? '#6b7280', borderColor: gradeColor[grade] ?? '#6b7280' }}
        >
          {data ? grade : 'Live'}
        </span>
        <span className="nx-icm__census-score">{data ? score : '—'}<span>{data ? '/100' : ''}</span></span>
      </div>
      <div className={cls('nx-icm__census-grid', `is-${styleMode}`)}>
        {metricRows.length > 0 ? metricRows.map((metric) => (
          <div key={metric.label} className={cls('nx-icm__census-stat', metric.label === 'Opp Score' && data && 'is-highlight')}>
            <span>{metric.label}</span>
            <strong style={metric.label === 'Opp Score' && data ? { color: gradeColor[grade] } : undefined}>{metric.value}</strong>
          </div>
        )) : (
          <div className="nx-icm__census-empty">
            <strong>Waiting for geography data</strong>
            <p>{emptyMessage || 'Select a property or hover a cluster to inspect census intelligence.'}</p>
          </div>
        )}
      </div>
      <p className="nx-icm__census-summary">◆ {summary}</p>
    </div>
  )
}

const toFallbackSellerPin = (pin: CommandMapPin): CommandMapSellerPin => ({
  property_id: text(pin.property_id || pin.id || pin.conversation_id),
  master_owner_id: text(pin.master_owner_id) || null,
  prospect_id: null,
  thread_key: text((pin as any).thread_key) || text(pin.conversation_id) || null,
  lat: pin.lat,
  lng: pin.lng,
  latitude: pin.lat,
  longitude: pin.lng,
  seller_name: text(pin.seller_name) || null,
  seller_display_name: text((pin as any).seller_display_name) || null,
  property_address_full: text(pin.property_address_full || pin.address) || null,
  property_address: text(pin.address) || null,
  property_address_city: text(pin.property_address_city || pin.city) || null,
  property_address_state: text(pin.property_address_state || pin.state) || null,
  property_address_zip: text(pin.property_address_zip || pin.zip) || null,
  market: text(pin.market) || null,
  filter_market: text(pin.market) || null,
  owner_type: text((pin as any).owner_type) || null,
  owner_display_name: text((pin as any).owner_display_name) || null,
  owner_name: text(pin.owner_name) || null,
  owner_full_name: text((pin as any).owner_full_name) || null,
  entity_name: text((pin as any).entity_name) || null,
  property_type: text(pin.property_type) || null,
  asset_class: text((pin as any).asset_class) || null,
  total_bedrooms: pin.total_bedrooms ?? pin.beds ?? null,
  total_baths: pin.total_baths ?? pin.baths ?? null,
  building_square_feet: pin.building_square_feet ?? pin.sqft ?? null,
  units_count: pin.units_count ?? pin.units ?? null,
  year_built: pin.year_built ?? null,
  lot_square_feet: pin.lot_square_feet ?? null,
  lot_acreage: pin.lot_acreage ?? null,
  estimated_value: pin.estimated_value ?? null,
  equity_amount: pin.equity_amount ?? null,
  equity_percent: pin.equity_percent ?? null,
  estimated_repair_cost: pin.estimated_repair_cost ?? pin.repair_estimate ?? null,
  motivation_score: pin.motivation_score ?? null,
  final_acquisition_score: pin.final_acquisition_score ?? null,
  priority_score: pin.priority_score ?? null,
  property_tags_text: text((pin as any).property_tags_text || (pin as any).property_flags_text) || null,
  property_tags_json: (pin as any).property_tags_json ?? null,
  podio_tags: (pin as any).podio_tags ?? null,
  property_flags_text: text((pin as any).property_flags_text) || null,
  property_flags_json: (pin as any).property_flags_json ?? null,
  latest_message_at: text((pin as any).latest_message_at || pin.last_activity_at) || null,
  latest_direction: text((pin as any).latest_direction || pin.last_message_direction) || null,
  seller_state: 'not_contacted',
  seller_status: text((pin as any).seller_status) || null,
  execution_state: text((pin as any).execution_state) || 'none',
  inbox_category: text((pin as any).inbox_category || pin.inbox_bucket) || 'not_contacted',
  inbound_count: (pin as any).inbound_count ?? null,
  outbound_count: (pin as any).outbound_count ?? null,
  queued_count: (pin as any).queued_count ?? null,
  scheduled_count: (pin as any).scheduled_count ?? null,
  ready_count: (pin as any).ready_count ?? null,
  sent_count: (pin as any).sent_count ?? null,
  delivered_count: (pin as any).delivered_count ?? null,
  next_scheduled_for: text((pin as any).next_scheduled_for) || null,
  pin_color: null,
  pin_shape: null,
  pulse_style: null,
  execution_ring_color: null,
  render_priority: (pin as any).render_priority ?? null,
  canonical_e164: text((pin as any).canonical_e164 || pin.phone) || null,
  seller_phone: text((pin as any).seller_phone || pin.phone) || null,
})

// ── WebGL / style safety helpers ──────────────────────────────────────────────
type MapWebGLErrorDetails = {
  message: string
  blocked: boolean
}

function parseMapWebGLError(error: unknown): MapWebGLErrorDetails {
  const err = error as Error & { type?: string; statusMessage?: string }
  const statusMessage = typeof err?.statusMessage === 'string' ? err.statusMessage.trim() : ''
  const message = statusMessage || (err instanceof Error ? err.message : '') || 'Failed to initialize WebGL'
  const blocked = /context loss and was blocked|web page caused context loss/i.test(statusMessage)
    || /webgl.*blocked/i.test(message)
  return { message, blocked }
}

function webglBlockedUserMessage(details: MapWebGLErrorDetails): string {
  if (!details.blocked) return details.message
  return 'Chrome blocked WebGL on this tab after repeated graphics context loss. Reload the full page to restore the map.'
}

function probeWebGLAvailability(): { ok: true } | { ok: false; reason: string; blocked: boolean } {
  if (typeof document === 'undefined') {
    return { ok: false, reason: 'WebGL is unavailable in this environment.', blocked: false }
  }
  try {
    const canvas = document.createElement('canvas')
    const gl =
      canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: false, powerPreference: 'default' })
      ?? canvas.getContext('webgl', { failIfMajorPerformanceCaveat: false, powerPreference: 'default' })
    if (!gl) {
      return {
        ok: false,
        reason: 'WebGL is unavailable. Enable hardware acceleration or try another browser.',
        blocked: false,
      }
    }
    return { ok: true }
  } catch (error) {
    const parsed = parseMapWebGLError(error)
    return { ok: false, reason: webglBlockedUserMessage(parsed), blocked: parsed.blocked }
  }
}

function isMapSafe(map: maplibregl.Map | null | undefined): map is maplibregl.Map {
  return !!map && !(map as unknown as { _removed?: boolean })._removed && typeof map.loaded === 'function'
}

function isStyleSafe(map: maplibregl.Map | null | undefined): map is maplibregl.Map {
  try {
    if (!isMapSafe(map)) return false
    const style = map.getStyle?.()
    return !!style && !!(style as unknown as { sources?: unknown }).sources && !!(style as unknown as { layers?: unknown }).layers
  } catch {
    return false
  }
}

function safeGetSource(map: maplibregl.Map | null | undefined, sourceId: string): maplibregl.Source | null {
  try {
    if (!isStyleSafe(map)) return null
    return map!.getSource(sourceId) || null
  } catch {
    return null
  }
}

function safeSetGeoJsonSourceData(
  map: maplibregl.Map | null | undefined,
  sourceId: string,
  data: Parameters<maplibregl.GeoJSONSource['setData']>[0],
): boolean {
  try {
    const source = safeGetSource(map, sourceId) as (maplibregl.GeoJSONSource & { setData?: (data: unknown) => void }) | null
    if (!source || typeof source.setData !== 'function') return false
    source.setData(data)
    return true
  } catch (error) {
    console.warn('[CommandMap] safeSetGeoJsonSourceData skipped', { sourceId, error })
    return false
  }
}

const SELLER_PIN_ASSET_LAYER_IDS = [
  SELLER_PINS_LAYER_IDS.hit,
  SELLER_PINS_LAYER_IDS.icon,
  SELLER_PINS_LAYER_IDS.ring,
  SELLER_PINS_LAYER_IDS.clusterGlow,
  SELLER_PINS_LAYER_IDS.clusterCore,
  SELLER_PINS_LAYER_IDS.clusterCount,
] as const

const SELLER_PIN_ORB_LAYER_IDS = [
  SELLER_PINS_LAYER_IDS.core,
  SELLER_PINS_LAYER_IDS.glow,
  SELLER_PINS_LAYER_IDS.pulse,
] as const

const shouldPresentSellerPinGeojsonField = (
  sellerPinsEnabled: boolean,
  zoom: number,
  geojsonFeatureCount = 0,
): boolean => (
  sellerPinsEnabled
  && shouldUseVectorTileSource(zoom)
  && geojsonFeatureCount > 0
)

const applySellerPinFieldPresentation = (
  map: maplibregl.Map,
  options: {
    sellerPinsEnabled: boolean
    viewportZoom: number
    geojson?: FeatureCollection<Point, Record<string, unknown>>
  },
): void => {
  const { sellerPinsEnabled, viewportZoom, geojson } = options
  const geojsonFeatureCount = geojson?.features?.length ?? 0
  const sellerPinFieldActive = shouldPresentSellerPinGeojsonField(
    sellerPinsEnabled,
    viewportZoom,
    geojsonFeatureCount,
  )
  const showMarkers = sellerPinFieldActive
    && shouldUsePropertySource(viewportZoom)
    && !shouldUseAggregateSource(viewportZoom)
  const vis = (on: boolean) => on ? 'visible' : 'none'

  loadPropertyIcons(map)
  if (geojson) {
    safeSetGeoJsonSourceData(map, SELLER_PINS_SOURCE_ID, geojson)
  }

  for (const layerId of SELLER_PIN_ASSET_LAYER_IDS) {
    if (!map.getLayer(layerId)) continue
    map.setLayoutProperty(layerId, 'visibility', vis(showMarkers))
    if (layerId === SELLER_PINS_LAYER_IDS.icon) {
      map.setLayoutProperty(layerId, 'icon-image', PIN_ICON_IMAGE_BY_SLUG_EXPR as maplibregl.ExpressionSpecification)
      map.setPaintProperty(
        layerId,
        'icon-color',
        ['coalesce', ['get', 'icon_color'], PIN_ICON_COLOR_COALESCED_EXPR] as unknown as maplibregl.ExpressionSpecification,
      )
    }
  }
  for (const layerId of SELLER_PIN_ORB_LAYER_IDS) {
    if (map.getLayer(layerId)) {
      map.setLayoutProperty(layerId, 'visibility', 'none')
    }
  }

  if (!sellerPinFieldActive) return

  for (const layerId of ALL_PROPERTY_TILE_LAYER_IDS) {
    if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', 'none')
  }
  for (const layerId of Object.values(PROPERTY_UNIVERSE_LAYER_IDS)) {
    if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', 'none')
  }
}

// Only query layers that actually exist in the current style, and always
// return [] on any error — never propagate MapLibre internal crashes.
function safeQueryRenderedFeatures(
  map: maplibregl.Map,
  point: maplibregl.PointLike,
  layerIds: string[],
): maplibregl.MapGeoJSONFeature[] {
  try {
    if (!isStyleSafe(map)) return []
    const existing = layerIds.filter((id) => { try { return !!map.getLayer(id) } catch { return false } })
    if (existing.length === 0) return []
    return map.queryRenderedFeatures(point, { layers: existing })
  } catch {
    return []
  }
}

interface Props {
  threads: InboxWorkflowThread[]
  visibleThreads: InboxWorkflowThread[]
  buyerCommandData?: BuyerCommandData | null
  buyerFilters?: BuyerMapFilters
  onBuyerFiltersChange?: (patch: Partial<BuyerMapFilters>) => void
  selectedBuyerKey?: string | null
  onSelectBuyerKey?: (buyerKey: string | null) => void
  selectedThread: InboxWorkflowThread | null
  selectedThreadMessages?: ThreadMessage[]
  selectedThreadMessagesLoading?: boolean
  quickReplyDraft?: string
  onQuickReplyDraftChange?: (value: string) => void
  onQuickReplySend?: (value: string) => void | Promise<void>
  quickReplyDisabled?: boolean
  zoomedIn: boolean
  sourceMode: MapSourceMode
  onSourceModeChange?: (mode: MapSourceMode) => void
  onSelectThreadId?: (threadId: string) => void
  onSelectSellerContext?: (context: {
    propertyId?: string
    masterOwnerId?: string
    sourceView: 'map'
    intent: 'open_seller' | 'open_queue'
  }) => void
  onSelectActivity?: (event: CommandMapActivityEvent) => void
  onOpenDealIntelligence?: (threadId: string) => void
  onBackgroundClick?: () => void
  fullHeight?: boolean
  layoutMode?: ViewLayoutMode
  commandMode?: boolean
  /** True when mobile SMS thread pane is open and covers the map composer area */
  mobileConversationOpen?: boolean
  initialActivityMode?: InboxMapActivityMode
  initialMapStyleMode?: MapStyleMode
  initialFilters?: Partial<MapFilterState>
  initialMapOverlays?: Partial<MapOverlayToggles>
  onStateChange?: (state: {
    activityMode: InboxMapActivityMode
    mapStyleMode: MapStyleMode
    filters: MapFilterState
    mapOverlays: MapOverlayToggles
  }) => void
  paused?: boolean
}

const defaultFilters: MapFilterState = {
  market: '',
  stage: '',
  status: '',
  leadTemperature: '',
  disposition: '',
  contactability: '',
  archiveOnly: false,
  snoozeOnly: false,
  automationStatus: '',
  messageDirection: '',
  unreadOnly: false,
  followUpDue: false,
  highEquity: false,
  propertyType: '',
  offerStatus: '',
  contractStatus: '',
  suppressionStatus: '',
  dateRange: '',
}

// ── Deal Intelligence Side Sheet ─────────────────────────────────────────────
type DealIntelSheetData =
  | { type: 'seller'; thread: InboxWorkflowThread | null; pin?: CommandMapSellerPin | null }
  | { type: 'comp'; comp: RecentSoldComp }

const DealIntelligenceSideSheet = ({
  data,
  onClose,
}: {
  data: DealIntelSheetData
  onClose: () => void
}) => {
  const [activeTab, setActiveTab] = useState(0)

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  const isComp = data.type === 'comp'
  const tabs = isComp
    ? ['Summary', 'Sale', 'Match', 'Buyer', 'Nearby', 'Actions']
    : ['Summary', 'Property', 'Owner', 'Conversation', 'Comps', 'Actions']

  // Helper formatters
  const fmtNum = (n: number | null | undefined): string =>
    n != null && Number.isFinite(n) ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n) : '—'
  const fmtMoney = (n: number | null | undefined): string => {
    if (n == null || !Number.isFinite(n)) return '—'
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(n)
  }
  const fmtPct = (n: number | null | undefined): string =>
    n != null && Number.isFinite(n) ? `${Math.round(n)}%` : '—'
  const fmtRel = (iso: string | null | undefined): string => {
    if (!iso) return '—'
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    const diff = (Date.now() - d.getTime()) / 60000
    if (diff < 60) return `${Math.max(1, Math.floor(diff))}m ago`
    if (diff < 1440) return `${Math.floor(diff / 60)}h ago`
    return `${Math.floor(diff / 1440)}d ago`
  }

  const Metric = ({ label, value, accent, gold, green }: { label: string; value: string; accent?: boolean; gold?: boolean; green?: boolean }) => (
    <div className={cls('nx-deal-sheet__metric', accent && 'nx-deal-sheet__metric--accent', gold && 'nx-deal-sheet__metric--gold', green && 'nx-deal-sheet__metric--green', isComp && 'nx-deal-sheet__metric--comp')}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )

  const SectionLabel = ({ label }: { label: string }) => (
    <span className={cls('nx-deal-sheet__section-label', isComp && 'nx-deal-sheet__section-label--comp')}>{label}</span>
  )

  const EmptyTab = ({ title, sub }: { title: string; sub: string }) => (
    <div className="nx-deal-sheet__empty-tab">
      <strong>{title}</strong>
      <span>{sub}</span>
    </div>
  )

  // ── Seller tab content ────────────────────────────────────────────────────
  const renderSellerTab = () => {
    const t = data.type === 'seller' ? data.thread : null
    const pin = data.type === 'seller' ? data.pin : null
    const rec = (t as any) || (pin as any) || {}

    if (activeTab === 0) { // Summary
      return (
        <div className="nx-deal-sheet__section">
          <SectionLabel label="Deal Summary" />
          <div className="nx-deal-sheet__metrics">
            <Metric label="Est. Value"     value={fmtMoney(rec.estimated_value ?? rec.estimatedValue)} accent />
            <Metric label="Equity"         value={fmtPct(rec.equity_percent ?? rec.equityPercent)} />
            <Metric label="Repairs"        value={fmtMoney(rec.estimated_repair_cost ?? rec.estimatedRepairCost)} />
            <Metric label="Motivation"     value={rec.motivation_score != null ? `${Math.round(rec.motivation_score)}/100` : '—'} />
            <Metric label="Acquisition"    value={rec.final_acquisition_score != null ? `${Math.round(rec.final_acquisition_score)}/100` : '—'} />
            <Metric label="Stage"          value={text(rec.conversation_stage ?? rec.seller_stage ?? rec.stage) || '—'} />
          </div>
          {rec.last_outreach_message || rec.latest_message_body ? (
            <div>
              <SectionLabel label="Last Message" />
              <div className="nx-deal-sheet__text-block">
                {rec.last_outreach_message || rec.latest_message_body}
              </div>
            </div>
          ) : null}
        </div>
      )
    }
    if (activeTab === 1) { // Property
      return (
        <div className="nx-deal-sheet__section">
          <SectionLabel label="Property Details" />
          <div className="nx-deal-sheet__metrics">
            <Metric label="Type"       value={text(rec.property_type ?? rec.propertyType) || '—'} />
            <Metric label="Beds"       value={fmtNum(rec.total_bedrooms ?? rec.beds)} />
            <Metric label="Baths"      value={fmtNum(rec.total_baths ?? rec.baths)} />
            <Metric label="Sqft"       value={fmtNum(rec.building_square_feet ?? rec.sqft)} />
            <Metric label="Units"      value={fmtNum(rec.units_count ?? rec.units)} />
            <Metric label="Year Built" value={fmtNum(rec.year_built)} />
            <Metric label="Lot"        value={rec.lot_acreage ? `${rec.lot_acreage} ac` : fmtNum(rec.lot_square_feet) !== '—' ? `${fmtNum(rec.lot_square_feet)} sf` : '—'} />
            <Metric label="Condition"  value={text(rec.building_condition) || '—'} />
          </div>
          {rec.property_address_full || rec.address ? (
            <div>
              <SectionLabel label="Address" />
              <div className="nx-deal-sheet__text-block">{rec.property_address_full || rec.address}</div>
            </div>
          ) : null}
        </div>
      )
    }
    if (activeTab === 2) { // Owner
      return (
        <div className="nx-deal-sheet__section">
          <SectionLabel label="Owner Information" />
          <div className="nx-deal-sheet__metrics">
            <Metric label="Owner Name"   value={text(rec.owner_display_name ?? rec.owner_name) || '—'} />
            <Metric label="Owner Type"   value={text(rec.owner_type) || '—'} />
            <Metric label="Yrs Owned"    value={fmtNum(rec.ownership_years)} />
            <Metric label="Last Sale"    value={rec.last_sale_date ? new Date(rec.last_sale_date).toLocaleDateString() : '—'} />
            <Metric label="Absentee"     value={rec.absentee_owner ? 'Yes' : rec.absentee_owner === false ? 'No' : '—'} />
            <Metric label="Out of State" value={rec.out_of_state_owner ? 'Yes' : rec.out_of_state_owner === false ? 'No' : '—'} />
          </div>
        </div>
      )
    }
    if (activeTab === 3) { // Conversation
      return (
        <div className="nx-deal-sheet__section">
          <SectionLabel label="Conversation Status" />
          <div className="nx-deal-sheet__metrics">
            <Metric label="Reply Status"  value={text(rec.reply_status ?? rec.replyStatus) || '—'} accent />
            <Metric label="Last Reply"    value={fmtRel(rec.last_reply_at ?? rec.lastReplyAt)} />
            <Metric label="Last Outreach" value={fmtRel(rec.last_outbound_at ?? rec.lastOutboundAt)} />
            <Metric label="Automation"    value={text(rec.automation_status ?? rec.automationStatus) || '—'} />
          </div>
          {rec.latest_message_body || rec.last_message ? (
            <div>
              <SectionLabel label="Latest Message" />
              <div className="nx-deal-sheet__text-block">{rec.latest_message_body || rec.last_message}</div>
            </div>
          ) : null}
        </div>
      )
    }
    if (activeTab === 4) { // Comps
      return <EmptyTab title="Comp Analysis" sub="Select comp markers on the map to compare against this property." />
    }
    if (activeTab === 5) { // Actions
      const threadKey = text(rec.thread_key || rec.threadKey || rec.conversation_id || rec.id)
      return (
        <div className="nx-deal-sheet__section">
          <SectionLabel label="Universal Lead State" />
          {threadKey ? (
            <UniversalLeadStateControls
              thread={t ?? rec}
              sourceView="map"
              compact
            />
          ) : (
            <EmptyTab title="No thread context" sub="Select a mapped seller pin to edit canonical lead state." />
          )}
        </div>
      )
    }
    return null
  }

  // ── Comp tab content ──────────────────────────────────────────────────────
  const renderCompTab = () => {
    const comp = data.type === 'comp' ? data.comp : null
    if (!comp) return null

    const price = comp.mls_sold_price ?? comp.sale_price ?? 0
    const ppsf = comp.computed_ppsf ?? comp.arv_ppsf ?? (price && comp.building_square_feet ? Math.round(price / comp.building_square_feet) : null)

    if (activeTab === 0) { // Summary
      return (
        <div className="nx-deal-sheet__section">
          <SectionLabel label="Sale Summary" />
          <div className="nx-deal-sheet__metrics">
            <Metric label="Sale Price"  value={fmtMoney(price)} accent />
            <Metric label="PPSF"        value={ppsf ? fmtMoney(ppsf) : '—'} />
            <Metric label="Confidence"  value={comp.comp_confidence_score ? `${Math.round(comp.comp_confidence_score)}/100` : '—'} />
            <Metric label="Grade"       value={comp.deal_grade || '—'} gold />
            <Metric label="ARV Est."    value={fmtMoney(comp.arv_estimate)} />
            <Metric label="Source"      value={comp.sale_source || '—'} />
          </div>
          <div>
            <SectionLabel label="Address" />
            <div className="nx-deal-sheet__text-block">{comp.property_address_full || 'Unknown'}</div>
          </div>
        </div>
      )
    }
    if (activeTab === 1) { // Sale
      return (
        <div className="nx-deal-sheet__section">
          <SectionLabel label="Sale Details" />
          <div className="nx-deal-sheet__metrics">
            <Metric label="MLS Price"    value={fmtMoney(comp.mls_sold_price)} accent />
            <Metric label="Public Price" value={fmtMoney(comp.sale_price)} />
            <Metric label="PPSF"         value={ppsf ? fmtMoney(ppsf) : '—'} />
            <Metric label="Sale Date"    value={comp.sale_date ? new Date(comp.sale_date).toLocaleDateString() : '—'} />
            <Metric label="Type"         value={comp.property_type || '—'} />
            <Metric label="Asset Class"  value={comp.normalized_asset_class || '—'} />
          </div>
        </div>
      )
    }
    if (activeTab === 2) { // Match
      return (
        <div className="nx-deal-sheet__section">
          <SectionLabel label="Property Details" />
          <div className="nx-deal-sheet__metrics">
            <Metric label="Beds"       value={fmtNum(comp.total_bedrooms)} />
            <Metric label="Baths"      value={fmtNum(comp.total_baths)} />
            <Metric label="Sqft"       value={fmtNum(comp.building_square_feet)} />
            <Metric label="Units"      value={fmtNum(comp.units_count)} />
            <Metric label="Year Built" value={fmtNum(comp.year_built)} />
            <Metric label="Condition"  value={comp.building_condition || '—'} />
            <Metric label="Lot"        value={comp.lot_acreage ? `${comp.lot_acreage} ac` : fmtNum(comp.lot_square_feet) !== '—' ? `${fmtNum(comp.lot_square_feet)} sf` : '—'} />
            <Metric label="Confidence" value={comp.comp_confidence_score ? `${Math.round(comp.comp_confidence_score)}%` : '—'} accent />
          </div>
        </div>
      )
    }
    if (activeTab === 3) { // Buyer
      return (
        <div className="nx-deal-sheet__section">
          <SectionLabel label="Buyer Intelligence" />
          <div className="nx-deal-sheet__metrics">
            <Metric label="Name"       value={comp.owner_name || '—'} />
            <Metric label="Buyer Type" value={comp.buyer_type_label || '—'} accent />
            <Metric label="Corporate"  value={comp.is_corporate_owner ? 'Yes' : 'No'} />
            <Metric label="Institutional" value={comp.is_institutional_buyer ? 'Yes' : 'No'} />
          </div>
          {comp.is_institutional_buyer && comp.institutional_match_name ? (
            <div>
              <SectionLabel label="Institution Match" />
              <div className="nx-deal-sheet__text-block">
                {comp.institutional_match_name}
                {comp.institutional_match_confidence ? ` (${comp.institutional_match_confidence})` : ''}
              </div>
            </div>
          ) : null}
        </div>
      )
    }
    if (activeTab === 4) { // Nearby
      return <EmptyTab title="Nearby Comps" sub="Select more comp markers to build a nearby comp set for this property." />
    }
    if (activeTab === 5) { // Actions
      return (
        <div className="nx-deal-sheet__section">
          <SectionLabel label="Actions" />
          <div className="nx-deal-sheet__actions-grid">
            <button type="button" className="nx-deal-sheet__action-btn nx-deal-sheet__action-btn--comp" disabled>
              Add to ARV
            </button>
            <button type="button" className="nx-deal-sheet__action-btn" disabled>
              Exclude Comp
            </button>
            <button type="button" className="nx-deal-sheet__action-btn" disabled>
              Find Similar
            </button>
            <button type="button" className="nx-deal-sheet__action-btn" disabled>
              Export
            </button>
          </div>
        </div>
      )
    }
    return null
  }

  const titleName = isComp
    ? (data.type === 'comp' ? (data.comp.property_address_full || 'Sold Comp') : '')
    : (data.type === 'seller' ? (text((data.thread as any)?.seller_name ?? (data.thread as any)?.owner_name) || 'Seller') : '')
  const titleSub = isComp
    ? (data.type === 'comp' ? (data.comp.property_address_full || '') : '')
    : (data.type === 'seller' ? (text((data.thread as any)?.property_address_full ?? (data.thread as any)?.address) || '') : '')

  return (
    <div className="nx-deal-sheet">
      <div className="nx-deal-sheet__topbar">
        <button type="button" className="nx-deal-sheet__back" onClick={onClose}>← Back</button>
        <div className="nx-deal-sheet__title-block">
          <div className="nx-deal-sheet__title-name" title={titleName}>{titleName}</div>
          {titleSub && titleSub !== titleName ? <div className="nx-deal-sheet__title-sub" title={titleSub}>{titleSub}</div> : null}
        </div>
        <span className={cls('nx-deal-sheet__type-badge', isComp && 'nx-deal-sheet__type-badge--comp')}>
          {isComp ? 'Comp Intel' : 'Deal Intel'}
        </span>
      </div>

      <div className="nx-deal-sheet__tabs">
        {tabs.map((tab, i) => (
          <button
            key={tab}
            type="button"
            className={cls('nx-deal-sheet__tab', activeTab === i && 'is-active', isComp && 'nx-deal-sheet__tab--comp')}
            onClick={() => setActiveTab(i)}
          >
            {tab}
          </button>
        ))}
      </div>

      <div className="nx-deal-sheet__content">
        {isComp ? renderCompTab() : renderSellerTab()}
      </div>
    </div>
  )
}

export function InboxCommandMap({
  threads,
  visibleThreads,
  buyerCommandData = null,
  buyerFilters = undefined,
  onBuyerFiltersChange,
  selectedBuyerKey = null,
  onSelectBuyerKey,
  selectedThread,
  selectedThreadMessages: _selectedThreadMessages = [],
  selectedThreadMessagesLoading: _selectedThreadMessagesLoading = false,
  quickReplyDraft = '',
  onQuickReplyDraftChange,
  onQuickReplySend,
  quickReplyDisabled = false,
  zoomedIn,
  sourceMode,
  onSourceModeChange,
  onSelectThreadId,
  onSelectSellerContext,
  onSelectActivity,
  onOpenDealIntelligence,
  onBackgroundClick,
  fullHeight = false,
  layoutMode = 'full',
  commandMode = false,
  mobileConversationOpen = false,
  initialActivityMode = 'threads',
  initialMapStyleMode = 'dark_ops',
  initialFilters,
  initialMapOverlays,
  onStateChange,
  paused = false,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const controlsRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const lastAutoNavSelectionRef = useRef<string | null>(null)
  const mapContextLostRef = useRef(false)
  const mapContextLossOverlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mapContainerKeyRef = useRef(0)
  const propUnivHandlersRegisteredRef = useRef(false)
  const animationRef = useRef<number | null>(null)
  const hoverPopupRef = useRef<maplibregl.Popup | null>(null)
  const clearPinHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const applyCommandMapThemeRef = useRef<((map: maplibregl.Map, nextThemeId: MapStyleMode) => void) | null>(null)
  const activeKpiFilterRef = useRef<MapKpiFilterKey | null>(null)
  const onSelectThreadIdRef = useRef<Props['onSelectThreadId']>(onSelectThreadId)
  const onSelectSellerContextRef = useRef<Props['onSelectSellerContext']>(onSelectSellerContext)
  const onOpenDealIntelligenceRef = useRef<Props['onOpenDealIntelligence']>(onOpenDealIntelligence)
  const onSelectBuyerKeyRef = useRef<Props['onSelectBuyerKey']>(onSelectBuyerKey)
  const onBackgroundClickRef = useRef<Props['onBackgroundClick']>(onBackgroundClick)
  const performanceSettingsRef = useRef<CommandMapPerformanceSettings | null>(null)
  const reducedMotionRef = useRef(false)
  const selectedThreadRef = useRef<InboxWorkflowThread | null>(null)
  const [selectedSoldComp, setSelectedSoldComp] = useState<RecentSoldComp | null>(null)
  const selectedSoldCompRef = useRef<RecentSoldComp | null>(null)
  useEffect(() => {
    selectedThreadRef.current = selectedThread
  }, [selectedThread])
  useEffect(() => {
    selectedSoldCompRef.current = selectedSoldComp
  }, [selectedSoldComp])
  const mapStyleModeRef = useRef<MapStyleMode>(initialMapStyleMode)
  const activeBaseStyleIdRef = useRef(getCommandMapBaseStyleId(initialMapStyleMode))
  const activeThemeRef = useRef<CommandMapThemeDefinition>(getCommandMapTheme(initialMapStyleMode))
  const mapOverlaysRef = useRef<MapOverlayToggles>({ ...defaultMapOverlays, ...initialMapOverlays })
  const buyerPurchasesRef = useRef<BuyerRecentPurchase[]>([])
  const buyerMatchesRef = useRef<BuyerCommandData['matches']>([])
  const censusOverlayFeaturesRef = useRef<CensusOverlayFeature[]>([])
  const activeCensusMetricRef = useRef<CensusOverlayMetric | null>(null)
  const geojsonRef = useRef<FeatureCollection<Point, PinFeatureProps>>(featureCollectionForPins([], null, null, initialMapStyleMode))
  const buyerPurchasesGeojsonRef = useRef<FeatureCollection<Point, BuyerFeatureProps>>(EMPTY_GEOJSON as FeatureCollection<Point, BuyerFeatureProps>)
  const buyerProfilesGeojsonRef = useRef<FeatureCollection<Point, BuyerFeatureProps>>(EMPTY_GEOJSON as FeatureCollection<Point, BuyerFeatureProps>)
  const buyerTrailGeojsonRef = useRef<FeatureCollection<LineString, GeoJsonProperties>>({ type: 'FeatureCollection', features: [] })
  const censusGeojsonRef = useRef<FeatureCollection<Polygon, GeoJsonProperties>>({ type: 'FeatureCollection', features: [] })
  const buyerDemandGeojsonRef = useRef<FeatureCollection<Point, Record<string, unknown>>>(EMPTY_GEOJSON)
  const soldCompsGeojsonRef = useRef<FeatureCollection<Point, Record<string, unknown>>>(EMPTY_GEOJSON)
  const sellerPinsGeojsonRef = useRef<FeatureCollection<Point, Record<string, unknown>>>(EMPTY_GEOJSON)
  const activityModeRef = useRef<InboxMapActivityMode>('threads')
  const [activityMode, setActivityMode] = useState<InboxMapActivityMode>(initialActivityMode)
  const [filters, setFilters] = useState<MapFilterState>({ ...defaultFilters, ...initialFilters })
  const [tempLocation, setTempLocation] = useState<LocationResult | null>(null)
  const [selectedPinId, setSelectedPinId] = useState<string | null>(selectedThread?.id ?? null)
  const [showSelectedHidden, setShowSelectedHidden] = useState(false)
  const [buyerLayers, setBuyerLayers] = useState<BuyerLayerToggles>(defaultBuyerLayerToggles)
  const [sellerPinLayers, setSellerPinLayers] = useState<SellerPinLayerToggles>(() => {
    try {
      const stored = localStorage.getItem(SELLER_PINS_SETTINGS_KEY)
      if (stored) {
        const parsed = JSON.parse(stored) as Partial<SellerPinLayerToggles>
        return { ...defaultSellerPinLayers, ...parsed, sellerPins: parsed.sellerPins !== false }
      }

      for (const legacyKey of LEGACY_SELLER_PINS_SETTINGS_KEYS) {
        const legacyStored = localStorage.getItem(legacyKey)
        if (!legacyStored) continue
        const legacyParsed = JSON.parse(legacyStored) as Partial<SellerPinLayerToggles>
        const migrated = {
          ...defaultSellerPinLayers,
          ...legacyParsed,
          sellerPins: true,
          notContacted: legacyParsed.notContacted !== false,
        }
        localStorage.setItem(SELLER_PINS_SETTINGS_KEY, JSON.stringify(migrated))
        localStorage.removeItem(legacyKey)
        return migrated
      }

      return defaultSellerPinLayers
    } catch {
      return defaultSellerPinLayers
    }
  })
  
  const tempMarkerRef = useRef<maplibregl.Marker | null>(null)
  
  useEffect(() => {
    localStorage.setItem(SELLER_PINS_SETTINGS_KEY, JSON.stringify(sellerPinLayers))
  }, [sellerPinLayers])
  const sellerPinLayersRef = useRef(sellerPinLayers)
  useEffect(() => {
    sellerPinLayersRef.current = sellerPinLayers
  }, [sellerPinLayers])

  const [sellerPinsGeojson, setSellerPinsGeojson] = useState<FeatureCollection<Point, Record<string, unknown>>>(EMPTY_GEOJSON)
  const [sellerPinsRaw, setSellerPinsRaw] = useState<CommandMapSellerPin[]>([])
  const [sellerPins, setSellerPins] = useState<CommandMapSellerPin[]>([])
  const [sellerPinsLoading, setSellerPinsLoading] = useState(false)
  const [sellerPinsPerf, setSellerPinsPerf] = useState<SellerPinsPerfSnapshot>({
    shown: 0,
    cap: 0,
    capHit: false,
    cacheHit: false,
    loadedAt: null,
    sampled: false,
    rpcMs: null,
    pinsReturned: 0,
  })
  const sellerPinsCacheRef = useRef<Map<string, { ts: number; pins: CommandMapSellerPin[] }>>(new Map())
  const sellerPinsRequestSeqRef = useRef(0)
  const lastSellerPinsDataKeyRef = useRef<string>('')
  const sellerPinsByPropertyIdRef = useRef<Map<string, CommandMapSellerPin>>(new Map())
  const sellerPinDetailsCacheRef = useRef<Map<string, CommandMapSellerPin>>(new Map())

  const mapCardHydrationAbortRef = useRef<AbortController | null>(null)
  const mapCardHydrationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sellerPinsFetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sellerPinsAbortRef = useRef<AbortController | null>(null)
  const propertyUniverseAbortRef = useRef<AbortController | null>(null)
  const propertyUniverseRawFeaturesRef = useRef<GeoJSON.Feature<Point>[]>([])
  const marketAggregateRawFeaturesRef = useRef<GeoJSON.Feature<Point>[]>([])
  const [mapPropertyDiagnostics, setMapPropertyDiagnostics] = useState<MapPropertyDiagnostics | null>(null)
  const propTilesHandlersRegisteredRef = useRef(false)

  const styleLoadSeqRef = useRef(0)
  const styleLoadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const styleLoadStartedAtRef = useRef<number | null>(null)
  const styleFallbackGuardRef = useRef(false)
  const [censusLayers, setCensusLayers] = useState<CensusLayerToggles>(defaultCensusLayers)
  const [buyerDemandLayers, setBuyerDemandLayers] = useState<BuyerDemandLayerToggles>(defaultBuyerDemandLayers)
  const [censusGeojson, setCensusGeojson] = useState<FeatureCollection<Polygon, GeoJsonProperties>>({ type: 'FeatureCollection', features: [] })
  const [censusOverlayFeatures, setCensusOverlayFeatures] = useState<CensusOverlayFeature[]>([])
  const [censusOverlayLegend, setCensusOverlayLegend] = useState<CensusOverlayLegend | null>(null)
  const [censusOverlayMessage, setCensusOverlayMessage] = useState<string>('')
  const [censusOverlayLoading, setCensusOverlayLoading] = useState(false)
  const [hoveredCensusFeature, setHoveredCensusFeature] = useState<CensusOverlaySelection | null>(null)
  const [selectedCensusFeature, setSelectedCensusFeature] = useState<CensusOverlaySelection | null>(null)
  const [buyerDemandGeojson, setBuyerDemandGeojson] = useState<FeatureCollection<Point, Record<string, unknown>>>(EMPTY_GEOJSON)
  const [soldCompsGeojson, setSoldCompsGeojson] = useState<FeatureCollection<Point, Record<string, unknown>>>(EMPTY_GEOJSON)
  const [soldComps, setSoldComps] = useState<RecentSoldComp[]>([])
  const [, setSoldCompsLoading] = useState(false)
  const [, setCompCardAnchor] = useState<React.CSSProperties | null>(null)
  const [hoveredMapCard, setHoveredMapCard] = useState<MapCardState>(null)
  const [selectedMapCard, setSelectedMapCard] = useState<MapCardState>(null)
  const hoveredMapCardRef = useRef<MapCardState>(null)
  const selectedMapCardRef = useRef<MapCardState>(null)
  useEffect(() => {
    hoveredMapCardRef.current = hoveredMapCard
  }, [hoveredMapCard])
  useEffect(() => {
    selectedMapCardRef.current = selectedMapCard
  }, [selectedMapCard])
  const [dealIntelSheet, setDealIntelSheet] = useState<DealIntelSheetData | null>(null)
  const [selectedThreadCensus, setSelectedThreadCensus] = useState<CensusData | null>(null)
  const [selectedBuyerPurchase, setSelectedBuyerPurchase] = useState<BuyerRecentPurchase | null>(null)
  const [hoveredClusterSummary, setHoveredClusterSummary] = useState<ClusterCensusSummary | null>(null)
  const [selectedClusterSummary, setSelectedClusterSummary] = useState<ClusterCensusSummary | null>(null)
  const [showLegendPanel, setShowLegendPanel] = useState(false)
  const [showCensusDock, setShowCensusDock] = useState(false)

  const [filtersOpen, setFiltersOpen] = useState(false)
  const [activeControlsTab, setActiveControlsTab] = useState<ControlsTab>('modes')
  const [mapMode, setMapMode] = useState<MapModeKey>('acquisition')
  const [filterCategory, setFilterCategory] = useState<FilterCategory>('prospect')
  const [filterSearch, setFilterSearch] = useState('')
  const [advancedLayersOpen, setAdvancedLayersOpen] = useState(false)
  const [cinematicControls, setCinematicControls] = useState<CinematicControlsState>({
    livePulses: 'off',
    pinGlow: 'subtle',
    eventTrail: false,
    soundFx: 'off',
    mapAtmosphere: 'clean',
  })
  const { isMobile } = useBreakpoint()
  const isMobileRef = useRef(isMobile)
  useEffect(() => {
    isMobileRef.current = isMobile
  }, [isMobile])
  const [dockTier, setDockTier] = useState<'mini' | 'compact' | 'full'>(() => (
    typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches ? 'compact' : 'full'
  ))

  useEffect(() => {
    if (isMobile && dockTier === 'full') setDockTier('compact')
  }, [isMobile, dockTier])
  const [mapStyleMode, setMapStyleMode] = useState<MapStyleMode>(initialMapStyleMode)
  const [baseStyleLoading, setBaseStyleLoading] = useState(false)
  const [styleFallbackWarning, setStyleFallbackWarning] = useState<string | null>(null)
  const [mapContextLost, setMapContextLost] = useState(false)
  const [mapInitError, setMapInitError] = useState<string | null>(null)
  const [mapWebglBlocked, setMapWebglBlocked] = useState(false)
  const [mapContainerKey, setMapContainerKey] = useState(0)

  const scheduleMapResize = (aggressive = false) => {
    const map = mapRef.current
    if (!map) return
    const runResize = () => {
      try {
        map.resize()
        map.triggerRepaint()
      } catch {
        // Keep map resilient during transient layout/style transitions.
      }
    }
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => requestAnimationFrame(runResize))
    } else {
      setTimeout(runResize, 0)
    }
    setTimeout(runResize, 120)
    if (aggressive) {
      setTimeout(runResize, THEME_TRANSITION_MS)
      setTimeout(runResize, THEME_TRANSITION_MS + 160)
    }
  }
  const [mapDimension, setMapDimension] = useState<'2d' | '3d'>('2d')
  const [mapOverlays, setMapOverlays] = useState<MapOverlayToggles>({ ...defaultMapOverlays, ...initialMapOverlays })

  const [showKpiBadges, setShowKpiBadges] = useState(true)
  const [activeKpiFilter, setActiveKpiFilter] = useState<MapKpiFilterKey | null>(null)
  const [viewportBounds, setViewportBounds] = useState<CommandMapBounds | null>(null)
  const [viewportZoom, setViewportZoom] = useState(zoomedIn ? 10.5 : 4.4)
  const viewportZoomRef = useRef(viewportZoom)
  useEffect(() => {
    viewportZoomRef.current = viewportZoom
  }, [viewportZoom])
  const [viewportWidth, setViewportWidth] = useState(0)
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false)
  const preferredDockTier = layoutMode === 'compact' ? 'mini' : layoutMode === 'medium' ? 'compact' : 'full'
  const isUltrawide = viewportWidth >= 1800
  const { settings: liveActivitySettings, patchSettings: patchLiveActivitySettings } = useCommandMapLiveActivitySettings(isUltrawide)
  const { settings: performanceSettings, patchSettings: patchPerformanceSettings } = useCommandMapPerformanceMode(isUltrawide)
  const activeCensusMetric = useMemo(() => {
    const metricMap: Array<[keyof CensusLayerToggles, CensusOverlayMetric]> = [
      ['censusHeatmap', 'census_heatmap'],
      ['vacancyHeat', 'vacancy_heat'],
      ['incomeHeat', 'income_heat'],
      ['renterDensity', 'renter_density'],
      ['ownerOccupancy', 'owner_occupancy'],
      ['medianHomeValue', 'median_home_value'],
      ['medianRent', 'median_rent'],
      ['housingAge', 'housing_age'],
      ['acquisitionPressure', 'acquisition_pressure'],
      ['investorOpportunity', 'investor_opportunity'],
      ['populationDensity', 'population_density'],
    ]
    return metricMap.find(([key]) => censusLayers[key])?.[1] ?? null
  }, [censusLayers])

  const setSingleCensusMetric = (key: keyof CensusLayerToggles, enabled: boolean) => {
    setCensusLayers({
      incomeHeat: false,
      vacancyHeat: false,
      renterDensity: false,
      housingAge: false,
      acquisitionPressure: false,
      ownerOccupancy: false,
      medianHomeValue: false,
      medianRent: false,
      investorOpportunity: false,
      populationDensity: false,
      censusHeatmap: false,
      [key]: enabled,
    })
  }

  // ── Map Mode Preset Application ────────────────────────────────────────────
  // Skip the initial mount — only fire when user actively changes mode.
  const _mapModeInitRef = useRef(true)
  useEffect(() => {
    if (_mapModeInitRef.current) { _mapModeInitRef.current = false; return }

    const enabledLayers: string[] = []
    const disabledLayers: string[] = []
    const track = (name: string, on: boolean) => (on ? enabledLayers : disabledLayers).push(name)

    switch (mapMode) {
      case 'acquisition':
        setSellerPinLayers(() => withAllSellerPinCategories({ blocked: false }))
        track('sellerPins', true)
        setBuyerLayers((p) => {
          track('buyerMatches', false); track('recentSoldComps', false); track('buyerHeatmap', false)
          return { ...p, sellerThreads: true, buyerMatches: false, recentSoldComps: false, buyerHeatmap: false, buyerProfiles: false }
        })
        setBuyerDemandLayers(defaultBuyerDemandLayers)
        setCensusLayers(defaultCensusLayers)
        setShowCensusDock(false)
        break

      case 'buyer_demand':
        setSellerPinLayers(() => withAllSellerPinCategories())
        track('sellerPins', true)
        setBuyerLayers((p) => {
          track('buyerMatches', true); track('buyerHeatmap', true); track('recentSoldComps', true)
          track('repeatBuyers', true); track('corporateBuyers', true); track('localInvestors', true)
          return { ...p, sellerThreads: true, buyerMatches: true, buyerHeatmap: true, recentSoldComps: true, repeatBuyers: true, corporateBuyers: true, localInvestors: true, flippers: true, buyerProfiles: false }
        })
        setBuyerDemandLayers(defaultBuyerDemandLayers)
        setCensusLayers(defaultCensusLayers)
        setShowCensusDock(false)
        break

      case 'comps':
        setSellerPinLayers(() => withAllSellerPinCategories())
        track('sellerPins', true)
        setBuyerLayers((p) => {
          track('recentSoldComps', true); track('buyerMatches', true); track('buyerProfiles', true)
          return { ...p, sellerThreads: true, recentSoldComps: true, buyerMatches: true, buyerProfiles: true, buyerHeatmap: false }
        })
        setBuyerDemandLayers((p) => {
          track('soldPrice', true); track('activity6mo', true)
          return { ...p, soldPrice: true, activity6mo: true, buyerHeat: false, investorDemand: false }
        })
        setCensusLayers(defaultCensusLayers)
        setShowCensusDock(false)
        break

      case 'execution':
        setSellerPinLayers(() => withAllSellerPinCategories())
        track('sellerPins', true)
        setBuyerLayers((p) => {
          track('buyerMatches', false); track('recentSoldComps', false)
          return { ...p, sellerThreads: true, buyerMatches: false, recentSoldComps: false, buyerHeatmap: false, buyerProfiles: false }
        })
        setBuyerDemandLayers(defaultBuyerDemandLayers)
        setCensusLayers(defaultCensusLayers)
        setShowCensusDock(false)
        break

      case 'opportunity_heat':
        setSellerPinLayers(() => withAllSellerPinCategories())
        track('sellerPins', true)
        setBuyerLayers((p) => {
          track('buyerMatches', false); track('recentSoldComps', false)
          return { ...p, sellerThreads: false, buyerMatches: false, recentSoldComps: false, buyerHeatmap: false, buyerProfiles: false }
        })
        setBuyerDemandLayers((p) => {
          track('investorDemand', true); track('activity6mo', true); track('buyerHeat', true)
          return { ...p, investorDemand: true, activity6mo: true, buyerHeat: true, soldPrice: false }
        })
        setCensusLayers(() => { track('vacancyHeat', true); return { ...defaultCensusLayers, vacancyHeat: true } })
        setShowCensusDock(false)
        break

      case 'territory':
        setSellerPinLayers(() => withAllSellerPinCategories())
        track('sellerPins', true)
        setBuyerLayers((p) => {
          track('buyerMatches', false); track('recentSoldComps', false)
          return { ...p, sellerThreads: false, buyerMatches: false, recentSoldComps: false, buyerHeatmap: false, buyerProfiles: false }
        })
        setBuyerDemandLayers(defaultBuyerDemandLayers)
        setCensusLayers(defaultCensusLayers)
        setMapOverlays((p) => { track('zip', true); track('cities', true); track('roads', true); return { ...p, zip: true, cities: true, roads: true } })
        setShowCensusDock(false)
        break

      case 'census':
        setSellerPinLayers(() => withAllSellerPinCategories())
        track('sellerPins', true)
        setBuyerLayers((p) => {
          track('buyerMatches', false); track('recentSoldComps', false)
          return { ...p, sellerThreads: true, buyerMatches: false, recentSoldComps: false, buyerHeatmap: false, buyerProfiles: false }
        })
        setBuyerDemandLayers(defaultBuyerDemandLayers)
        setSingleCensusMetric('incomeHeat', true)
        track('incomeHeat', true)
        setShowCensusDock(true)
        break

      case 'command':
        setSellerPinLayers(() => withAllSellerPinCategories())
        track('sellerPins', true)
        setBuyerLayers((p) => {
          track('buyerMatches', false); track('recentSoldComps', false)
          return { ...p, sellerThreads: true, buyerMatches: false, recentSoldComps: false, buyerHeatmap: false, buyerProfiles: false }
        })
        setBuyerDemandLayers(defaultBuyerDemandLayers)
        setCensusLayers(defaultCensusLayers)
        setShowCensusDock(false)
        break

      default:
        break
    }

    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.log('[MapMode] applied', { mode: mapMode, enabledLayers, disabledLayers })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapMode])

  useEffect(() => {
    setDockTier(preferredDockTier)
  }, [layoutMode, preferredDockTier])

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => setPrefersReducedMotion(media.matches)
    sync()
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [])

  const hydratedThreadsById = useMemo(
    () => new Map(threads.map((thread) => [thread.id, thread])),
    [threads],
  )
  const hydratedThreadsByKey = useMemo(
    () => new Map(threads.map((thread) => [String((thread as any).threadKey || thread.id), thread])),
    [threads],
  )
  const hydratedThreadsByPropertyId = useMemo(() => {
    const map = new Map<string, InboxWorkflowThread>()
    threads.forEach((thread) => {
      const propertyId = text((thread as any).propertyId || (thread as any).property_id)
      if (propertyId && !map.has(propertyId)) map.set(propertyId, thread)
    })
    return map
  }, [threads])
  const visibleHydratedThreads = useMemo(() => (
    visibleThreads
      .map((thread) => hydratedThreadsById.get(thread.id) || hydratedThreadsByKey.get(String((thread as any).threadKey || thread.id)) || thread)
  ), [hydratedThreadsById, hydratedThreadsByKey, visibleThreads])
  const hydratedThreadsByIdRef = useRef(hydratedThreadsById)
  const hydratedThreadsByKeyRef = useRef(hydratedThreadsByKey)
  const hydratedThreadsByPropertyIdRef = useRef(hydratedThreadsByPropertyId)
  const visibleHydratedThreadsRef = useRef(visibleHydratedThreads)
  useEffect(() => {
    hydratedThreadsByIdRef.current = hydratedThreadsById
  }, [hydratedThreadsById])
  useEffect(() => {
    hydratedThreadsByKeyRef.current = hydratedThreadsByKey
  }, [hydratedThreadsByKey])
  useEffect(() => {
    hydratedThreadsByPropertyIdRef.current = hydratedThreadsByPropertyId
  }, [hydratedThreadsByPropertyId])
  useEffect(() => {
    visibleHydratedThreadsRef.current = visibleHydratedThreads
  }, [visibleHydratedThreads])
  useEffect(() => {
    const map = new Map<string, CommandMapSellerPin>()
    sellerPins.forEach((pin) => {
      const propertyId = text((pin as any).property_id)
      if (propertyId) map.set(propertyId, pin)
    })
    sellerPinsByPropertyIdRef.current = map
  }, [sellerPins])
  const selectedHydratedThread = useMemo(() => {
    if (!selectedThread) return null
    const hydrated = hydratedThreadsById.get(selectedThread.id)
      || hydratedThreadsByKey.get(String((selectedThread as any).threadKey || selectedThread.id))
      || selectedThread
    if (isMappableCoord(getLat(hydrated), getLng(hydrated))) return hydrated
    if (isMappableCoord(getLat(selectedThread), getLng(selectedThread))) {
      return {
        ...hydrated,
        lat: getLat(selectedThread),
        lng: getLng(selectedThread),
        latitude: getLat(selectedThread),
        longitude: getLng(selectedThread),
      }
    }
    return hydrated
  }, [hydratedThreadsById, hydratedThreadsByKey, selectedThread])
  const baseThreads = useMemo(
    () => sourceMode === 'visible_threads' ? visibleHydratedThreads : threads,
    [sourceMode, threads, visibleHydratedThreads],
  )
  const pinPipeline = useMemo(() => {
    const mapped: CommandMapPin[] = []
    const unmapped: UnmappedItem[] = []
    baseThreads.forEach((thread) => {
      const result = buildMapPin(thread)
      if (result.pin) mapped.push(result.pin)
      if (result.unmapped) unmapped.push(result.unmapped)
    })
    return { mapped, unmapped }
  }, [baseThreads])
  const allPins = useMemo(() => toActivityPins(pinPipeline.mapped, activityMode), [activityMode, pinPipeline.mapped])
  const filteredPins = useMemo(
    () => allPins.filter((pin) => matchesFilters(pin, filters)),
    [allPins, filters],
  )
  const selectedBasePin = useMemo(() => {
    if (!selectedHydratedThread) return null
    return buildMapPin(selectedHydratedThread).pin
  }, [selectedHydratedThread])
  const selectedHiddenByFilters = useMemo(
    () => Boolean(selectedBasePin && !filteredPins.some((pin) => pin.conversation_id === selectedBasePin.conversation_id)),
    [filteredPins, selectedBasePin],
  )
  const baseVisiblePins = useMemo(() => {
    if (!selectedBasePin || !showSelectedHidden || !selectedHiddenByFilters) return filteredPins
    const selectedActivityPins = toActivityPins([selectedBasePin], activityMode)
    if (selectedActivityPins.length === 0) return filteredPins
    if (filteredPins.some((pin) => pin.conversation_id === selectedBasePin.conversation_id)) return filteredPins
    return [...filteredPins, ...selectedActivityPins]
  }, [activityMode, filteredPins, selectedBasePin, selectedHiddenByFilters, showSelectedHidden])
  const visiblePins = useMemo(() => (
    applyPinPerformanceWindow(baseVisiblePins, viewportBounds, viewportZoom, performanceSettings)
  ), [baseVisiblePins, performanceSettings, viewportBounds, viewportZoom])
  const selectedPin = useMemo(
    () => findPinForThread(visiblePins, selectedHydratedThread, [selectedPinId])
      ?? findPinForThread(baseVisiblePins, selectedHydratedThread, [selectedPinId])
      ?? findPinForThread(allPins, selectedHydratedThread, [selectedPinId])
      ?? selectedBasePin,
    [allPins, baseVisiblePins, selectedBasePin, selectedPinId, selectedHydratedThread, visiblePins],
  )
  const focusPin = selectedPin ?? selectedBasePin
  const kpiChips = useMemo(() => {
    const chips = buildKpiChips(visiblePins, activityMode)
    // Count genuinely uncontacted seller pins (those with no conversation history).
    // These don't appear in visiblePins at all since they have no threads, so the
    // chip built from thread-only data always shows 0 without this supplement.
    const sellerPinNotContactedCount = sellerPins.filter((sp) => {
      const state = lower(sp.seller_state)
      const hasMsg = Boolean(sp.latest_message_at)
        || Number(sp.sent_count ?? 0) > 0
        || Number(sp.delivered_count ?? 0) > 0
      if (hasMsg) return false
      return state === 'not_contacted' || state === '' || !sp.seller_state
        || lower((sp as any).inbox_category) === 'not_contacted'
        || (sp as any).is_uncontacted === true
    }).length
    return chips.map((chip) =>
      chip.key === 'not_contacted'
        ? { ...chip, count: chip.count + sellerPinNotContactedCount }
        : chip,
    )
  }, [activityMode, sellerPins, visiblePins])
  const activeSellerMapCard = useMemo(
    () => resolveActiveSellerMapCard(hoveredMapCard, selectedMapCard),
    [hoveredMapCard, selectedMapCard],
  )
  const activeSellerCardHydrationKey = activeSellerMapCard
    ? `${activeSellerMapCard.kind}|${activeSellerMapCard.intent}|${activeSellerMapCard.id}`
    : null
  const geojson = useMemo(
    () => featureCollectionForPins(
      visiblePins,
      selectedThread?.id ?? selectedPin?.conversation_id ?? null,
      activeKpiFilter,
      mapStyleMode,
    ),
    [activeKpiFilter, mapStyleMode, selectedPin?.conversation_id, selectedThread?.id, visiblePins],
  )
  const filteredBuyerPurchases = useMemo(() => {
    const purchases = buyerCommandData?.recentPurchases ?? []
    const filtered = purchases.filter((purchase) => {
      if (buyerLayers.repeatBuyers && !(buyerCommandData?.profiles.find((profile) => profile.buyerKey === purchase.buyerKey)?.isRepeatBuyer)) return false
      if (buyerLayers.corporateBuyers && !purchase.isCorporateBuyer) return false
      if (buyerLayers.localInvestors && !(buyerCommandData?.profiles.find((profile) => profile.buyerKey === purchase.buyerKey)?.isLocalBuyer)) return false
      if (buyerLayers.offMarketBuyers && !purchase.isOffMarketPurchase) return false
      if (!buyerLayers.retailNoise && buyerCommandData?.profiles.find((profile) => profile.buyerKey === purchase.buyerKey)?.isRetailOrNoise) return false
      if (buyerLayers.institutional || buyerLayers.landlords || buyerLayers.flippers || buyerLayers.builders) {
        if (buyerLayers.institutional && purchase.category === 'institutional') return true
        if (buyerLayers.landlords && purchase.category === 'landlord') return true
        if (buyerLayers.flippers && purchase.category === 'flipper') return true
        if (buyerLayers.builders && purchase.category === 'builder') return true
        return false
      }
      return true
    })
    const bounded = viewportBounds
      ? filtered.filter((purchase) => isPointInBounds(purchase.latitude, purchase.longitude, padCommandBounds(viewportBounds, 0.18)))
      : filtered
    return bounded.slice(0, getPinRenderCap(viewportZoom, performanceSettings, 'buyer'))
  }, [buyerCommandData?.profiles, buyerCommandData?.recentPurchases, buyerLayers.builders, buyerLayers.corporateBuyers, buyerLayers.flippers, buyerLayers.institutional, buyerLayers.landlords, buyerLayers.localInvestors, buyerLayers.offMarketBuyers, buyerLayers.repeatBuyers, buyerLayers.retailNoise, performanceSettings, viewportBounds, viewportZoom])
  const filteredBuyerProfiles = useMemo(() => {
    const profiles = buyerCommandData?.profilePoints ?? []
    const filtered = profiles.filter((profile) => {
      if (buyerLayers.repeatBuyers && !profile.isRepeatBuyer) return false
      if (buyerLayers.corporateBuyers && !profile.isCorporateBuyer) return false
      if (buyerLayers.localInvestors && !profile.isLocalBuyer) return false
      if (buyerLayers.offMarketBuyers && !profile.isOffMarketBuyer) return false
      if (!buyerLayers.retailNoise && profile.isRetailOrNoise) return false
      if (buyerLayers.institutional || buyerLayers.landlords || buyerLayers.flippers || buyerLayers.builders) {
        if (buyerLayers.institutional && profile.category === 'institutional') return true
        if (buyerLayers.landlords && profile.category === 'landlord') return true
        if (buyerLayers.flippers && profile.category === 'flipper') return true
        if (buyerLayers.builders && profile.category === 'builder') return true
        return false
      }
      return true
    })
    const bounded = viewportBounds
      ? filtered.filter((profile) => isPointInBounds(profile.latitude, profile.longitude, padCommandBounds(viewportBounds, 0.18)))
      : filtered
    return bounded.slice(0, getPinRenderCap(viewportZoom, performanceSettings, 'buyer'))
  }, [buyerCommandData?.profilePoints, buyerLayers.builders, buyerLayers.corporateBuyers, buyerLayers.flippers, buyerLayers.institutional, buyerLayers.landlords, buyerLayers.localInvestors, buyerLayers.offMarketBuyers, buyerLayers.repeatBuyers, buyerLayers.retailNoise, performanceSettings, viewportBounds, viewportZoom])
  const selectedBuyerTrailPurchases = useMemo(
    () => selectedBuyerKey ? filteredBuyerPurchases.filter((purchase) => purchase.buyerKey === selectedBuyerKey) : [],
    [filteredBuyerPurchases, selectedBuyerKey],
  )
  const buyerPurchasesGeojson = useMemo(
    () => buildBuyerFeatureCollection(filteredBuyerPurchases, mapStyleMode, 'buyer_purchase', buyerLayers.buyerFocusMode ? selectedBuyerKey : null),
    [buyerLayers.buyerFocusMode, filteredBuyerPurchases, mapStyleMode, selectedBuyerKey],
  )
  const buyerProfilesGeojson = useMemo(
    () => buildBuyerFeatureCollection(filteredBuyerProfiles, mapStyleMode, 'buyer_profile', buyerLayers.buyerFocusMode ? selectedBuyerKey : null),
    [buyerLayers.buyerFocusMode, filteredBuyerProfiles, mapStyleMode, selectedBuyerKey],
  )
  const buyerTrailGeojson = useMemo(
    () => buildBuyerTrailGeojson(selectedBuyerTrailPurchases, mapStyleMode),
    [mapStyleMode, selectedBuyerTrailPurchases],
  )
  const selectedBuyerProfile = useMemo(
    () => buyerCommandData?.profiles.find((profile) => profile.buyerKey === (selectedBuyerPurchase?.buyerKey || selectedBuyerKey)) ?? null,
    [buyerCommandData?.profiles, selectedBuyerKey, selectedBuyerPurchase?.buyerKey],
  )
  const buyerFilterCount = useMemo(() => countBuyerFilters(buyerFilters), [buyerFilters])
  const activeFilterCount = useMemo(() => {
    let count = 0
    if (filters.market) count++
    if (filters.stage) count++
    if (filters.status) count++
    if (filters.leadTemperature) count++
    if (filters.disposition) count++
    if (filters.contactability) count++
    if (filters.archiveOnly) count++
    if (filters.snoozeOnly) count++
    if (filters.automationStatus) count++
    if (filters.propertyType) count++
    if (filters.unreadOnly) count++
    if (filters.followUpDue) count++
    if (filters.highEquity) count++
    count += buyerFilterCount
    return count
  }, [filters, buyerFilterCount])
  const selectedStarGeojson = useMemo((): FeatureCollection<Point, Record<string, unknown>> => ({
    type: 'FeatureCollection',
    features: [],
  }), [])
  const buyerFilterOptions = useMemo(() => {
    const profiles = buyerCommandData?.profiles ?? []
    const purchases = buyerCommandData?.recentPurchases ?? []
    return {
      markets: Array.from(new Set([
        ...profiles.flatMap((profile) => profile.topMarkets),
        ...purchases.map((purchase) => purchase.market),
      ].filter(Boolean))).sort(),
      states: Array.from(new Set([
        ...profiles.flatMap((profile) => profile.topStates),
        ...purchases.map((purchase) => purchase.propertyAddressState),
      ].filter(Boolean))).sort(),
      zips: Array.from(new Set([
        ...profiles.flatMap((profile) => profile.topZips),
        ...purchases.map((purchase) => purchase.propertyAddressZip),
      ].filter(Boolean))).sort(),
      propertyTypes: Array.from(new Set([
        ...profiles.flatMap((profile) => profile.propertyTypeFocus),
        ...purchases.map((purchase) => purchase.propertyType),
      ].filter(Boolean))).sort(),
      assetClasses: Array.from(new Set(profiles.flatMap((profile) => profile.assetClassesBought).filter(Boolean))).sort(),
      buyerNames: Array.from(new Set(profiles.map((profile) => profile.buyerName).filter(Boolean))).sort(),
      exitStrategies: Array.from(new Set(profiles.map((profile) => profile.buyerExitStrategy).filter(Boolean))).sort(),
    }
  }, [buyerCommandData?.profiles, buyerCommandData?.recentPurchases])
  const activeThemeDefinition = useMemo(() => getCommandMapTheme(mapStyleMode), [mapStyleMode])
  const mapThemeStyle = useMemo(
    () => ({
      ...activeThemeDefinition.cardTheme,
      ...buildThemeIdentityCssVars(getCommandMapThemeIdentity(mapStyleMode)),
      ...buildPresetInterfaceCssVars(mapStyleMode),
      '--nx-map-canvas-filter': canvasFilterForTheme(mapStyleMode),
      '--nx-theme-transition-ms': `${THEME_TRANSITION_MS}ms`,
    } as CSSProperties),
    [activeThemeDefinition, mapStyleMode],
  )

  const clearBuyerFilters = () => onBuyerFiltersChange?.(defaultBuyerMapFilters)
  const selectedPropertyId = useMemo(() => (
    text((selectedHydratedThread as any)?.propertyId)
      || text((selectedHydratedThread as any)?.property_id)
      || text((selectedPin as any)?.property_id)
      || null
  ), [selectedHydratedThread, selectedPin])

  const liveActivityFeed = useMemo(() => (
    loadLiveActivityFeedSnapshot({
      pins: visiblePins as CommandMapActivityPinSource[],
      threadsById: hydratedThreadsById,
      buyerPurchases: filteredBuyerPurchases,
      soldComps,
      settings: liveActivitySettings,
      selectedMarket: filters.market || selectedPin?.market || null,
      bounds: viewportBounds,
      selectedThread: selectedHydratedThread,
      selectedPropertyId,
    })
  ), [visiblePins, hydratedThreadsById, filteredBuyerPurchases, soldComps, liveActivitySettings, filters.market, viewportBounds, selectedHydratedThread, selectedPin?.market, selectedPropertyId])
  const debugStats = useMemo(() => ({
    allPinsCount: allPins.length,
    filteredPinsCount: filteredPins.length,
    visiblePinsCount: visiblePins.length,
    buyerPurchasesCount: filteredBuyerPurchases.length,
    buyerProfilesCount: filteredBuyerProfiles.length,
    liveActivityEventsCount: liveActivityFeed.visibleCount,
    unmappedCount: pinPipeline.unmapped.length,
    activeMode: activityMode,
    activeFilters: filters,
  }), [activityMode, allPins.length, filteredBuyerProfiles.length, filteredBuyerPurchases.length, filteredPins.length, filters, liveActivityFeed.visibleCount, pinPipeline.unmapped.length, visiblePins.length])

  useEffect(() => {
    activeThemeRef.current = getCommandMapTheme(mapStyleMode)
  }, [mapStyleMode])

  useEffect(() => {
    buyerPurchasesGeojsonRef.current = buyerPurchasesGeojson
  }, [buyerPurchasesGeojson])

  useEffect(() => {
    buyerProfilesGeojsonRef.current = buyerProfilesGeojson
  }, [buyerProfilesGeojson])

  useEffect(() => {
    buyerTrailGeojsonRef.current = buyerTrailGeojson
  }, [buyerTrailGeojson])

  useEffect(() => {
    censusGeojsonRef.current = censusGeojson
  }, [censusGeojson])

  useEffect(() => {
    buyerDemandGeojsonRef.current = buyerDemandGeojson
  }, [buyerDemandGeojson])

  useEffect(() => {
    soldCompsGeojsonRef.current = soldCompsGeojson
  }, [soldCompsGeojson])

  useEffect(() => {
    sellerPinsGeojsonRef.current = sellerPinsGeojson
  }, [sellerPinsGeojson])

  geojsonRef.current = geojson
  activityModeRef.current = activityMode
  activeKpiFilterRef.current = activeKpiFilter
  performanceSettingsRef.current = performanceSettings
  reducedMotionRef.current = prefersReducedMotion || performanceSettings.animation !== 'full'
  onSelectThreadIdRef.current = onSelectThreadId
  onSelectSellerContextRef.current = onSelectSellerContext
  onOpenDealIntelligenceRef.current = onOpenDealIntelligence
  onSelectBuyerKeyRef.current = onSelectBuyerKey
  onBackgroundClickRef.current = onBackgroundClick
  mapStyleModeRef.current = mapStyleMode
  mapOverlaysRef.current = mapOverlays
  buyerPurchasesRef.current = filteredBuyerPurchases
  buyerMatchesRef.current = buyerCommandData?.matches ?? []
  censusOverlayFeaturesRef.current = censusOverlayFeatures
  activeCensusMetricRef.current = activeCensusMetric

  useEffect(() => {
    setShowSelectedHidden(false)
  }, [selectedThread?.id, activityMode])

  useEffect(() => {
    if (!activeKpiFilter) return
    if (!kpiChips.some((chip) => chip.key === activeKpiFilter)) {
      setActiveKpiFilter(null)
    }
  }, [activeKpiFilter, kpiChips])

  useEffect(() => {
    if (!selectedThread || !buyerCommandData) return
    if ((buyerCommandData.matches.length + buyerCommandData.recentPurchases.length) === 0) return
    setBuyerLayers((current) => (
      current.buyerMatches || current.buyerRecentPurchases || current.buyerHeatmap || current.buyerProfiles
        ? current
        : { ...current, buyerRecentPurchases: true }
    ))
  }, [buyerCommandData, selectedThread])

  useEffect(() => {
    if (!selectedBuyerKey) {
      setSelectedBuyerPurchase(null)
      return
    }
    const next = filteredBuyerPurchases.find((purchase) => purchase.buyerKey === selectedBuyerKey) || null
    setSelectedBuyerPurchase(next)
  }, [filteredBuyerPurchases, selectedBuyerKey])

  useEffect(() => {
    if (!selectedBuyerPurchase || !mapRef.current) return
    mapRef.current.easeTo({
      center: [selectedBuyerPurchase.longitude, selectedBuyerPurchase.latitude],
      zoom: Math.max(mapRef.current.getZoom(), 11.6),
      duration: 580,
    })
  }, [selectedBuyerPurchase])

  useEffect(() => {
    setSelectedPinId(selectedThread?.id ?? null)
    if (selectedThread?.id) {
      setShowSelectedHidden(true)
      setSelectedClusterSummary(null)
    } else {
      lastAutoNavSelectionRef.current = null
    }
  }, [selectedThread?.id])

  useEffect(() => {
    setActivityMode(initialActivityMode)
  }, [initialActivityMode])

  useEffect(() => {
    setMapStyleMode(initialMapStyleMode)
  }, [initialMapStyleMode])

  useEffect(() => {
    setFilters({ ...defaultFilters, ...initialFilters })
  }, [initialFilters])

  useEffect(() => {
    setMapOverlays({ ...defaultMapOverlays, ...initialMapOverlays })
  }, [initialMapOverlays])

  useEffect(() => {
    onStateChange?.({
      activityMode,
      mapStyleMode,
      filters,
      mapOverlays,
    })
  }, [activityMode, filters, mapOverlays, mapStyleMode, onStateChange])

  useEffect(() => {
    if (!filtersOpen) return
    setActiveControlsTab((current) => current || 'modes')
    const handlePointerDown = (event: MouseEvent) => {
      if (!controlsRef.current?.contains(event.target as Node)) setFiltersOpen(false)
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFiltersOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [filtersOpen])

  useEffect(() => {
    if (!selectedSoldComp) return
    const handleEscapeComp = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSelectedSoldComp(null)
        setCompCardAnchor(null)
      }
    }
    document.addEventListener('keydown', handleEscapeComp)
    return () => document.removeEventListener('keydown', handleEscapeComp)
  }, [selectedSoldComp])

  useEffect(() => {
    if (!selectedMapCard) return
    const handleEscapeCard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedMapCard(null)
    }
    document.addEventListener('keydown', handleEscapeCard)
    return () => document.removeEventListener('keydown', handleEscapeCard)
  }, [selectedMapCard])

  useEffect(() => {
    if (!rootRef.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0
      setViewportWidth(width)
      setDockTier(width <= 360 ? 'mini' : width <= 760 ? 'compact' : 'full')
      scheduleMapResize()
    })
    observer.observe(rootRef.current)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const onWindowResize = () => scheduleMapResize(true)
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') scheduleMapResize(true)
    }
    window.addEventListener('resize', onWindowResize)
    document.addEventListener('visibilitychange', onVisibilityChange)

    let containerObserver: ResizeObserver | undefined
    const containerEl = containerRef.current
    if (containerEl && typeof ResizeObserver !== 'undefined') {
      containerObserver = new ResizeObserver(() => {
        scheduleMapResize()
      })
      containerObserver.observe(containerEl)
    }

    return () => {
      window.removeEventListener('resize', onWindowResize)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      containerObserver?.disconnect()
    }
  }, [mapContainerKey])

  useEffect(() => {
    scheduleMapResize(true)
  }, [filtersOpen, layoutMode, dockTier, fullHeight, commandMode, mapStyleMode])

  useEffect(() => {
    const handleFlyTo = (e: Event) => {
      const customEvent = e as CustomEvent
      const location = customEvent.detail?.location as LocationResult | undefined
      if (location) {
        const map = mapRef.current
        if (!map) return
        
        map.flyTo({
          center: [location.longitude, location.latitude],
          zoom: 14.5,
          essential: true,
        })

        if (tempMarkerRef.current) {
          tempMarkerRef.current.remove()
          tempMarkerRef.current = null
        }

        tempMarkerRef.current = new maplibregl.Marker({ color: '#38bdf8' })
          .setLngLat([location.longitude, location.latitude])
          .addTo(map)

        setTempLocation(location)
      }
    }

    window.addEventListener('nexus:map-flyto', handleFlyTo)
    return () => window.removeEventListener('nexus:map-flyto', handleFlyTo)
  }, [])

  const focusExternalSoldComp = useCallback((payload: MapFocusCompPayload | null | undefined) => {
    if (!payload) return
    const lat = Number(payload.latitude)
    const lng = Number(payload.longitude)
    const map = mapRef.current
    const containerEl = containerRef.current
    if (!map || !Number.isFinite(lat) || !Number.isFinite(lng)) return

    const feature = mapFocusPayloadToSoldCompFeature(payload)
    const coordinates: [number, number] = [lng, lat]
    const pixelPoint = map.project(coordinates)
    const containerBounds = containerEl?.getBoundingClientRect()
    const containerWidth = containerBounds?.width ?? window.innerWidth
    const containerHeight = containerBounds?.height ?? window.innerHeight

    setSelectedSoldComp(feature as RecentSoldComp)
    setHoveredMapCard(null)
    setSelectedMapCard({
      kind: 'sold_comp',
      intent: 'selected',
      id: String(feature.property_id),
      anchor: { x: pixelPoint.x, y: pixelPoint.y },
      coordinates,
      feature,
      containerSize: { width: containerWidth, height: containerHeight },
    })
    map.easeTo({ center: coordinates, zoom: Math.max(map.getZoom(), 13.2), duration: 620 })
  }, [])

  useEffect(() => {
    const handleFocusComp = (event: Event) => {
      const payload = (event as CustomEvent<{ comp?: MapFocusCompPayload }>).detail?.comp
      if (payload) focusExternalSoldComp(payload)
    }
    window.addEventListener(MAP_FOCUS_COMP_EVENT, handleFocusComp)
    const pending = consumePendingMapComp()
    if (pending) window.setTimeout(() => focusExternalSoldComp(pending), 160)
    return () => window.removeEventListener(MAP_FOCUS_COMP_EVENT, handleFocusComp)
  }, [focusExternalSoldComp])

  useEffect(() => {
    if (!import.meta.env.DEV) return
    console.log('[InboxCommandMap]', debugStats)
  }, [debugStats])

  useEffect(() => {
    if (!import.meta.env.DEV || sellerPinsRaw.length === 0) return
    const sampleIncompletePins = sellerPinsRaw
      .filter((pin) => needsSellerPinHydration(pin))
      .slice(0, 3)
      .map((pin) => ({
        property_id: pin.property_id,
        seller_display_name: pin.seller_display_name,
        owner_display_name: pin.owner_display_name,
        property_address_full: pin.property_address_full,
        market: pin.market,
        total_bedrooms: pin.total_bedrooms,
        total_baths: pin.total_baths,
        building_square_feet: pin.building_square_feet,
        estimated_value: pin.estimated_value,
        motivation_score: pin.motivation_score,
      }))
    console.log('[CommandMapSellerPinsHydration]', {
      totalPins: sellerPinsRaw.length,
      notContactedPins: sellerPinsRaw.filter((pin) => lower(pin.seller_state) === 'not_contacted' || !text(pin.seller_state)).length,
      missingSellerName: sellerPinsRaw.filter((pin) => !text(pin.seller_display_name) && !text(pin.owner_display_name) && !text(pin.owner_name) && !text(pin.seller_name)).length,
      missingAddress: sellerPinsRaw.filter((pin) => !text(pin.property_address_full) && !text(pin.property_address)).length,
      missingBedsBathsSqft: sellerPinsRaw.filter((pin) => !nullIfZeroish(pin.total_bedrooms ?? null) && !nullIfZeroish(pin.total_baths ?? null) && !nullIfZeroish(pin.building_square_feet ?? null)).length,
      missingValue: sellerPinsRaw.filter((pin) => !nullIfZeroish(pin.estimated_value ?? null)).length,
      missingMarket: sellerPinsRaw.filter((pin) => !text(pin.market) && !text(pin.filter_market)).length,
      sampleIncompletePins,
      sampleHydratedPin: sellerPinsRaw.find((pin) => !needsSellerPinHydration(pin)) ?? null,
    })
  }, [sellerPinsRaw])

  const hydrateSellerMapCard = useCallback((
    card: MapCardState,
    setter: React.Dispatch<React.SetStateAction<MapCardState>>,
  ) => {
    if (!card || card.kind !== 'seller' || card.hydrating) return
    const propertyId = text(card.feature.property_id)
    if (!propertyId) return

    const cached = sellerPinDetailsCacheRef.current.get(propertyId)
    if (cached) {
      setter((current) => {
        if (!current || current.kind !== 'seller' || text(current.feature.property_id) !== propertyId) return current
        return {
          ...current,
          feature: sanitizeSellerPinRecord({ ...current.feature, ...cached }) as Record<string, unknown>,
          hydrating: false,
        }
      })
      return
    }

    mapCardHydrationAbortRef.current?.abort()
    const controller = new AbortController()
    mapCardHydrationAbortRef.current = controller
    setter((current) => (
      current && current.kind === 'seller' && text(current.feature.property_id) === propertyId
        ? { ...current, hydrating: true }
        : current
    ))

    const pinSnapshot = sanitizeSellerPinRecord(card.feature as Partial<CommandMapSellerPin>)
    const threadKey = text(card.feature.thread_key) || null
    const masterOwnerId = text(card.feature.master_owner_id) || null
    loadCommandMapSellerPinDetail(propertyId, {
      signal: controller.signal,
      threadKey,
      masterOwnerId,
    })
      .then((detail) => {
        if (!detail) return
        const hydrated = sanitizeSellerPinRecord({ ...pinSnapshot, ...detail })
        sellerPinDetailsCacheRef.current.set(propertyId, hydrated)
        setter((current) => {
          if (!current || current.kind !== 'seller' || text(current.feature.property_id) !== propertyId) return current
          return {
            ...current,
            feature: hydrated as Record<string, unknown>,
            hydrating: false,
          }
        })
      })
      .catch(() => {
        if (controller.signal.aborted) return
        setter((current) => (
          current && current.kind === 'seller' && text(current.feature.property_id) === propertyId
            ? { ...current, hydrating: false }
            : current
        ))
      })
  }, [])

  useEffect(() => {
    if (mapCardHydrationTimerRef.current) {
      clearTimeout(mapCardHydrationTimerRef.current)
      mapCardHydrationTimerRef.current = null
    }
    const card = resolveActiveSellerMapCard(hoveredMapCardRef.current, selectedMapCardRef.current)
    if (!card) return

    const propertyId = text(card.feature.property_id)
    const applySellerCardUpdate: React.Dispatch<React.SetStateAction<MapCardState>> = (updater) => {
      setSelectedMapCard((current) => {
        if (current?.kind !== 'seller' || text(current.feature.property_id) !== propertyId) return current
        return typeof updater === 'function' ? updater(current) : updater
      })
      setHoveredMapCard((current) => {
        if (current?.kind !== 'seller' || text(current.feature.property_id) !== propertyId) return current
        return typeof updater === 'function' ? updater(current) : updater
      })
    }

    const runHydration = () => hydrateSellerMapCard(card, applySellerCardUpdate)
    if (card.intent === 'hover') {
      mapCardHydrationTimerRef.current = setTimeout(runHydration, 90)
    } else {
      runHydration()
    }
    return () => {
      if (mapCardHydrationTimerRef.current) {
        clearTimeout(mapCardHydrationTimerRef.current)
        mapCardHydrationTimerRef.current = null
      }
    }
  }, [activeSellerCardHydrationKey, hydrateSellerMapCard])

  useEffect(() => {
    const map = mapRef.current
    const containerEl = containerRef.current
    if (!map || !containerEl) return

    const syncMapCardAnchors = () => {
      const containerBounds = containerEl.getBoundingClientRect()
      const containerSize = { width: containerBounds.width, height: containerBounds.height }
      const projectAnchor = (coordinates: [number, number]) => {
        try {
          const pixelPoint = map.project(coordinates)
          return { x: pixelPoint.x, y: pixelPoint.y }
        } catch {
          return null
        }
      }

      setHoveredMapCard((current) => {
        if (!current?.coordinates) return current
        const anchor = projectAnchor(current.coordinates)
        if (!anchor) return current
        return { ...current, anchor, containerSize }
      })
      setSelectedMapCard((current) => {
        if (!current?.coordinates) return current
        const anchor = projectAnchor(current.coordinates)
        if (!anchor) return current
        return { ...current, anchor, containerSize }
      })
    }

    map.on('move', syncMapCardAnchors)
    map.on('resize', syncMapCardAnchors)
    return () => {
      map.off('move', syncMapCardAnchors)
      map.off('resize', syncMapCardAnchors)
    }
  }, [mapRef.current, containerRef.current])

  useEffect(() => {
    if (!containerRef.current) return
    if (mapRef.current) return

    const setLayerVisibility = (map: maplibregl.Map, layerIds: readonly string[], visible: boolean) => {
      layerIds.forEach((layerId) => {
        if (map.getLayer(layerId)) {
          map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none')
        }
      })
    }

    const syncLayerVisibility = (map: maplibregl.Map, nextMode: InboxMapActivityMode) => {
      const clusteredMode =
        (nextMode !== 'sends' && !activeKpiFilterRef.current)
        || (performanceSettingsRef.current?.clusterAggressiveness === 'high' && map.getZoom() < 12.5)
      setLayerVisibility(map, RAW_LAYER_IDS, !clusteredMode)
      setLayerVisibility(map, CLUSTER_POINT_LAYER_IDS, clusteredMode)
      setLayerVisibility(map, CLUSTER_LAYER_IDS, clusteredMode)
      setLayerVisibility(map, BUYER_PURCHASE_LAYER_IDS, buyerLayers.sellerThreads || buyerLayers.buyerRecentPurchases || buyerLayers.recentSoldComps || buyerLayers.buyerMatches)
      setLayerVisibility(map, BUYER_PURCHASE_CLUSTER_IDS, buyerLayers.sellerThreads || buyerLayers.buyerRecentPurchases || buyerLayers.recentSoldComps || buyerLayers.buyerMatches)
      setLayerVisibility(map, BUYER_PROFILE_LAYER_IDS, buyerLayers.buyerProfiles)
      setLayerVisibility(map, ALL_SOLD_COMPS_LAYER_IDS, buyerLayers.recentSoldComps)
      if (map.getLayer(BUYER_HEATMAP_LAYER_ID)) {
        map.setLayoutProperty(BUYER_HEATMAP_LAYER_ID, 'visibility', buyerLayers.buyerHeatmap && performanceSettingsRef.current?.showHeatEffects !== false ? 'visible' : 'none')
      }
    }

    const applyOverlayVisibility = (map: maplibregl.Map) => {
      const overlayState = mapOverlaysRef.current
      const layers = map.getStyle()?.layers ?? []
      layers.forEach((layer) => {
        const typedLayer = layer as StyleLayerLike
        if (!typedLayer.id || isCustomLayer(typedLayer.id)) return
        const categories = classifyBaseLayer(typedLayer)
        if (categories.length === 0) return
        const visible = categories.every((category) => overlayState[category])
        if (map.getLayer(typedLayer.id)) {
          map.setLayoutProperty(typedLayer.id, 'visibility', visible ? 'visible' : 'none')
        }
      })
    }

    const applyThemeBasemapPaint = (map: maplibregl.Map, theme: CommandMapThemeDefinition) => {
      applyVisualPresetBasemapPaint(map, theme.id, isCustomLayer)
    }

    const updateCustomThemeLayers = (map: maplibregl.Map, theme: CommandMapThemeDefinition) => {
      const clusterPalette = theme.clusterPalette
      const buyerAccent = theme.buyerAccent
      const soldCompColor = theme.soldCompColor
      const heatmapStops = theme.heatmapStops

      if (map.getLayer('command-pin-cluster-glow')) {
        map.setPaintProperty('command-pin-cluster-glow', 'circle-color', clusterPalette.glow)
      }
      if (map.getLayer('command-pin-cluster-core')) {
        map.setPaintProperty('command-pin-cluster-core', 'circle-color', clusterPalette.core)
        map.setPaintProperty('command-pin-cluster-core', 'circle-stroke-color', clusterPalette.stroke)
      }
      if (map.getLayer('command-pin-cluster-count')) {
        map.setPaintProperty('command-pin-cluster-count', 'text-color', clusterPalette.label)
        map.setPaintProperty('command-pin-cluster-count', 'text-halo-color', clusterPalette.halo)
      }
      if (map.getLayer(BUYER_HEATMAP_LAYER_ID)) {
        map.setPaintProperty(BUYER_HEATMAP_LAYER_ID, 'heatmap-color', [
          'interpolate',
          ['linear'],
          ['heatmap-density'],
          0, heatmapStops[0],
          0.2, heatmapStops[1],
          0.45, heatmapStops[2],
          0.7, heatmapStops[3],
          1, heatmapStops[4],
        ])
      }
      if (map.getLayer('command-buyer-cluster-glow')) {
        map.setPaintProperty('command-buyer-cluster-glow', 'circle-color', `${buyerAccent}33`)
      }
      if (map.getLayer('command-buyer-cluster-core')) {
        map.setPaintProperty('command-buyer-cluster-core', 'circle-stroke-color', buyerAccent)
      }
      if (map.getLayer('command-buyer-purchase-core')) {
        map.setPaintProperty('command-buyer-purchase-core', 'circle-stroke-color', ['case', ['==', ['get', 'isSelectedBuyer'], 1], '#fff7d6', `${buyerAccent}dd`])
      }
      if (map.getLayer('command-buyer-profile-label')) {
        map.setPaintProperty('command-buyer-profile-label', 'text-color', theme.baseStyleTone === 'light_street' ? '#0f172a' : clusterPalette.label)
        map.setPaintProperty('command-buyer-profile-label', 'text-halo-color', theme.baseStyleTone === 'light_street' ? 'rgba(255,255,255,0.94)' : clusterPalette.halo)
      }
      if (map.getLayer('command-buyer-trail-glow')) {
        map.setPaintProperty('command-buyer-trail-glow', 'line-color', ['coalesce', ['get', 'color'], buyerAccent])
      }
      if (map.getLayer('command-buyer-trail-line')) {
        map.setPaintProperty('command-buyer-trail-line', 'line-color', ['coalesce', ['get', 'color'], buyerAccent])
      }
      if (map.getLayer(SOLD_COMPS_LAYER_IDS.marker)) {
        map.setPaintProperty(SOLD_COMPS_LAYER_IDS.marker, 'circle-color', soldCompColor)
      }
      if (map.getLayer(SOLD_COMPS_LAYER_IDS.label)) {
        map.setPaintProperty(SOLD_COMPS_LAYER_IDS.label, 'text-color', soldCompColor)
        map.setPaintProperty(
          SOLD_COMPS_LAYER_IDS.label,
          'text-halo-color',
          theme.baseStyleTone === 'light_street' ? 'rgba(255,255,255,0.95)' : theme.baseStyleTone === 'matrix' ? 'rgba(2, 8, 5, 0.95)' : 'rgba(15, 8, 10, 0.95)',
        )
      }
      if (map.getLayer(SOLD_COMPS_CLUSTER_LAYER_IDS.glow)) {
        map.setPaintProperty(SOLD_COMPS_CLUSTER_LAYER_IDS.glow, 'circle-color', `${soldCompColor}40`)
      }
      if (map.getLayer(SOLD_COMPS_CLUSTER_LAYER_IDS.core)) {
        map.setPaintProperty(SOLD_COMPS_CLUSTER_LAYER_IDS.core, 'circle-color', soldCompColor)
      }

      const puTokens = getMapThemeTokens(theme.id)
      const puPinTokensForTheme = getMapPinThemeTokens(theme.id)
      if (map.getLayer(PROPERTY_UNIVERSE_LAYER_IDS.clusterRing)) {
        map.setPaintProperty(
          PROPERTY_UNIVERSE_LAYER_IDS.clusterRing,
          'circle-color',
          buildClusterHaloExpr(puPinTokensForTheme.clusterGlow) as maplibregl.ExpressionSpecification,
        )
      }
      if (map.getLayer(PROPERTY_UNIVERSE_LAYER_IDS.clusterCore)) {
        map.setPaintProperty(
          PROPERTY_UNIVERSE_LAYER_IDS.clusterCore,
          'circle-color',
          buildClusterSemanticCoreExpr(puPinTokensForTheme.clusterFill) as maplibregl.ExpressionSpecification,
        )
        map.setPaintProperty(
          PROPERTY_UNIVERSE_LAYER_IDS.clusterCore,
          'circle-stroke-color',
          buildClusterSemanticStrokeExpr(puPinTokensForTheme.clusterBorder) as maplibregl.ExpressionSpecification,
        )
      }
      if (map.getLayer(PROPERTY_UNIVERSE_LAYER_IDS.clusterCount)) {
        map.setPaintProperty(PROPERTY_UNIVERSE_LAYER_IDS.clusterCount, 'text-color', puTokens.clusterLabelColor)
        map.setPaintProperty(PROPERTY_UNIVERSE_LAYER_IDS.clusterCount, 'text-halo-color', puTokens.clusterLabelHalo)
      }
      const puPinTokens = getMapPinThemeTokens(theme.id)
      if (map.getLayer(PROPERTY_UNIVERSE_LAYER_IDS.markerGlow)) {
        map.setPaintProperty(PROPERTY_UNIVERSE_LAYER_IDS.markerGlow, 'circle-color', ['coalesce', ['get', 'icon_color'], PIN_ICON_COLOR_EXPR] as unknown as maplibregl.ExpressionSpecification)
      }
      if (map.getLayer(PROPERTY_UNIVERSE_LAYER_IDS.markerGlass)) {
        map.setPaintProperty(PROPERTY_UNIVERSE_LAYER_IDS.markerGlass, 'circle-color', ['coalesce', ['get', 'glass_color'], puPinTokens.glassFill] as maplibregl.ExpressionSpecification)
      }
      if (map.getLayer(PROPERTY_UNIVERSE_LAYER_IDS.markerRing)) {
        map.setPaintProperty(PROPERTY_UNIVERSE_LAYER_IDS.markerRing, 'circle-stroke-color', PIN_RING_STROKE_EXPR as maplibregl.ExpressionSpecification)
      }
      if (map.getLayer(PROPERTY_UNIVERSE_LAYER_IDS.markers)) {
        map.setPaintProperty(PROPERTY_UNIVERSE_LAYER_IDS.markers, 'icon-color', ['coalesce', ['get', 'icon_color'], PIN_ICON_COLOR_EXPR] as unknown as maplibregl.ExpressionSpecification)
        map.setPaintProperty(PROPERTY_UNIVERSE_LAYER_IDS.markers, 'icon-halo-color', ['coalesce', ['get', 'ring_color'], puPinTokens.ambientAccent] as maplibregl.ExpressionSpecification)
      }
      applyPropertyTileThemePaint(map, theme.id)

      const themeIdentity = getCommandMapThemeIdentity(theme.id)
      if (map.getLayer(SELLER_PINS_LAYER_IDS.glow)) {
        map.setPaintProperty(SELLER_PINS_LAYER_IDS.glow, 'circle-color', PIN_ASSET_GLOW_COLOR_EXPR)
        map.setPaintProperty(SELLER_PINS_LAYER_IDS.glow, 'circle-opacity', UNIVERSAL_PIN_GLOW_OPACITY_EXPR as maplibregl.ExpressionSpecification)
      }
      if (map.getLayer(SELLER_PINS_LAYER_IDS.ring)) {
        map.setPaintProperty(SELLER_PINS_LAYER_IDS.ring, 'circle-stroke-color', UNIVERSAL_PIN_RING_STROKE_EXPR as maplibregl.ExpressionSpecification)
        map.setPaintProperty(SELLER_PINS_LAYER_IDS.ring, 'circle-stroke-width', UNIVERSAL_PIN_RING_WIDTH_EXPR as maplibregl.ExpressionSpecification)
      }
      if (map.getLayer(SELLER_PINS_LAYER_IDS.pulse)) {
        map.setPaintProperty(SELLER_PINS_LAYER_IDS.pulse, 'circle-color', PIN_ASSET_GLOW_COLOR_EXPR)
      }
      if (map.getLayer(SELLER_PINS_LAYER_IDS.core)) {
        map.setPaintProperty(SELLER_PINS_LAYER_IDS.core, 'circle-color', ['coalesce', ['get', 'glass_color'], themeIdentity.pinGlassBody] as maplibregl.ExpressionSpecification)
        map.setPaintProperty(SELLER_PINS_LAYER_IDS.core, 'circle-opacity', UNIVERSAL_PIN_GLASS_OPACITY_EXPR as maplibregl.ExpressionSpecification)
      }
      if (map.getLayer(SELLER_PINS_LAYER_IDS.icon)) {
        map.setPaintProperty(SELLER_PINS_LAYER_IDS.icon, 'icon-color', PIN_ICON_COLOR_COALESCED_EXPR as maplibregl.ExpressionSpecification)
        map.setPaintProperty(SELLER_PINS_LAYER_IDS.icon, 'icon-halo-color', PIN_ASSET_GLOW_COLOR_EXPR)
        map.setPaintProperty(
          SELLER_PINS_LAYER_IDS.icon,
          'icon-size',
          (isMobileRef.current ? PIN_ICON_SCALE_TOUCH_EXPR : UNIVERSAL_PIN_ICON_SCALE_EXPR) as maplibregl.ExpressionSpecification,
        )
      }
      if (map.getLayer(SELLER_PINS_LAYER_IDS.clusterGlow)) {
        map.setPaintProperty(SELLER_PINS_LAYER_IDS.clusterGlow, 'circle-color', buildSellerClusterRingExpr(themeIdentity.clusterTint) as maplibregl.ExpressionSpecification)
      }
      if (map.getLayer(SELLER_PINS_LAYER_IDS.clusterCore)) {
        map.setPaintProperty(SELLER_PINS_LAYER_IDS.clusterCore, 'circle-color', buildSellerClusterCoreExpr(clusterPalette.core) as maplibregl.ExpressionSpecification)
        map.setPaintProperty(SELLER_PINS_LAYER_IDS.clusterCore, 'circle-stroke-color', buildSellerClusterStrokeExpr(clusterPalette.stroke) as maplibregl.ExpressionSpecification)
      }
      if (map.getLayer(SELLER_PINS_LAYER_IDS.clusterCount)) {
        map.setPaintProperty(SELLER_PINS_LAYER_IDS.clusterCount, 'text-color', clusterPalette.label)
        map.setPaintProperty(SELLER_PINS_LAYER_IDS.clusterCount, 'text-halo-color', clusterPalette.halo)
      }
    }

    const ensureThemeOverlayInfrastructure = (map: maplibregl.Map) => {
      if (!map.getSource(THEME_TINT_SOURCE_ID)) {
        map.addSource(THEME_TINT_SOURCE_ID, {
          type: 'geojson',
          data: THEME_TINT_GEOJSON,
        })
      }
      if (!map.getSource(THEME_GRID_SOURCE_ID)) {
        map.addSource(THEME_GRID_SOURCE_ID, {
          type: 'geojson',
          data: THEME_GRID_GEOJSON,
        })
      }
      if (!map.getSource(THEME_RADAR_SOURCE_ID)) {
        map.addSource(THEME_RADAR_SOURCE_ID, {
          type: 'geojson',
          data: THEME_RADAR_GEOJSON,
        })
      }

      const beforeId = map.getLayer('command-pin-cluster-glow') ? 'command-pin-cluster-glow' : undefined
      if (!map.getLayer(THEME_TINT_LAYER_ID)) {
        map.addLayer({
          id: THEME_TINT_LAYER_ID,
          type: 'fill',
          source: THEME_TINT_SOURCE_ID,
          paint: {
            'fill-color': 'rgba(4, 8, 18, 0.18)',
            'fill-opacity': 0,
          },
        }, beforeId)
      }
      if (!map.getLayer(THEME_GRID_LAYER_ID)) {
        map.addLayer({
          id: THEME_GRID_LAYER_ID,
          type: 'line',
          source: THEME_GRID_SOURCE_ID,
          paint: {
            'line-color': 'rgba(99, 215, 255, 0.16)',
            'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0.5, 10, 0.8],
            'line-opacity': 0,
          },
          layout: {
            visibility: 'none',
            'line-cap': 'round',
            'line-join': 'round',
          },
        }, beforeId)
      }
      if (!map.getLayer(THEME_RADAR_LAYER_ID)) {
        map.addLayer({
          id: THEME_RADAR_LAYER_ID,
          type: 'line',
          source: THEME_RADAR_SOURCE_ID,
          paint: {
            'line-color': 'rgba(0, 255, 136, 0.14)',
            'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0.5, 10, 1.1],
            'line-opacity': 0,
            'line-dasharray': [1.5, 2.5],
          },
          layout: {
            visibility: 'none',
            'line-cap': 'round',
            'line-join': 'round',
          },
        }, beforeId)
      }
    }

    const applyThemeOverlayLayers = (map: maplibregl.Map, theme: CommandMapThemeDefinition) => {
      ensureThemeOverlayInfrastructure(map)
      const tone = theme.baseStyleTone
      const tintColor =
        tone === 'matrix' ? 'rgba(0, 170, 95, 0.16)'
          : tone === 'red_ops' ? 'rgba(170, 45, 52, 0.18)'
            : tone === 'blueprint' ? 'rgba(35, 130, 185, 0.16)'
              : tone === 'executive' ? 'rgba(195, 160, 80, 0.16)'
                : tone === 'radar_night' ? 'rgba(28, 130, 88, 0.16)'
                  : tone === 'monochrome' ? 'rgba(0, 0, 0, 0.22)'
                    : tone === 'light_street' ? 'rgba(255, 255, 255, 0.01)'
                      : 'rgba(28, 68, 130, 0.14)'
      const tintOpacity =
        tone === 'light_street' ? 0
          : tone === 'monochrome' ? 0.14
            : tone === 'executive' ? 0.12
              : tone === 'red_ops' ? 0.14
                : tone === 'blueprint' ? 0.12
                  : tone === 'radar_night' || tone === 'matrix' ? 0.12
                    : tone === 'dark_ops' ? 0.1
                      : 0.1
      const showGrid = tone === 'matrix' || tone === 'blueprint'
      const showRadar = tone === 'radar_night'

      if (map.getLayer(THEME_TINT_LAYER_ID)) {
        map.setPaintProperty(THEME_TINT_LAYER_ID, 'fill-color', tintColor)
        map.setPaintProperty(THEME_TINT_LAYER_ID, 'fill-opacity', theme.id === 'satellite' || theme.id === 'terrain' ? 0 : tintOpacity)
        map.setLayoutProperty(THEME_TINT_LAYER_ID, 'visibility', theme.id === 'satellite' || theme.id === 'terrain' ? 'none' : 'visible')
      }
      if (map.getLayer(THEME_GRID_LAYER_ID)) {
        map.setPaintProperty(THEME_GRID_LAYER_ID, 'line-color', tone === 'matrix' ? 'rgba(0, 255, 136, 0.1)' : 'rgba(105, 215, 255, 0.1)')
        map.setPaintProperty(THEME_GRID_LAYER_ID, 'line-opacity', showGrid ? 0.2 : 0)
        map.setLayoutProperty(THEME_GRID_LAYER_ID, 'visibility', showGrid ? 'visible' : 'none')
      }
      if (map.getLayer(THEME_RADAR_LAYER_ID)) {
        map.setPaintProperty(THEME_RADAR_LAYER_ID, 'line-color', 'rgba(114, 255, 178, 0.12)')
        map.setPaintProperty(THEME_RADAR_LAYER_ID, 'line-opacity', showRadar ? 0.18 : 0)
        map.setLayoutProperty(THEME_RADAR_LAYER_ID, 'visibility', showRadar ? 'visible' : 'none')
      }
    }

    const customAttachmentCount = (map: maplibregl.Map): number => {
      const layers = map.getStyle()?.layers ?? []
      return layers.filter((layer) => isCustomLayer((layer as StyleLayerLike).id)).length
    }

    const ensureSatelliteHybridOverlay = async (map: maplibregl.Map) => {
      if (mapStyleModeRef.current !== 'satellite') return
      const darkStyle = await fetchDarkStyleSpec()
      if (!darkStyle) return

      if (darkStyle.glyphs && !map.getStyle?.()?.glyphs) {
        // No runtime setter exists; retained through the base style spec above.
      }

      Object.entries(darkStyle.sources ?? {}).forEach(([sourceId, source]) => {
        if (sourceId === 'satellite') return
        if (!map.getSource(sourceId)) {
          map.addSource(sourceId, source as any)
        }
      })

      const candidateLayers = (darkStyle.layers ?? [])
        .map((layer) => layer as StyleLayerLike)
        .filter((layer) => !isCustomLayer(layer.id))
        .filter((layer) => layer.type === 'line' || layer.type === 'symbol')
        .filter((layer) => classifyBaseLayer(layer).length > 0)

      candidateLayers.forEach((layer) => {
        const nextId = hybridOverlayLayerId(layer.id)
        if (map.getLayer(nextId)) return
        try {
          map.addLayer(
            cloneLayerWithId(layer, nextId) as maplibregl.AddLayerObject,
            map.getLayer('command-pin-cluster-glow') ? 'command-pin-cluster-glow' : undefined,
          )
        } catch {
          // Skip incompatible overlay layers but keep the hybrid map alive.
        }
      })
    }

    const syncBasemapPresentation = async (map: maplibregl.Map) => {
      await ensureSatelliteHybridOverlay(map)
      applyOverlayVisibility(map)
      applyThemeBasemapPaint(map, activeThemeRef.current)
      applyThemeOverlayLayers(map, activeThemeRef.current)
      updateCustomThemeLayers(map, activeThemeRef.current)
    }

    const addMapLayers = (map: maplibregl.Map) => {
      loadPropertyIcons(map)
      const rawData = geojsonRef.current

      if (!map.getSource(RAW_SOURCE_ID)) {
        map.addSource(RAW_SOURCE_ID, {
          type: 'geojson',
          data: rawData,
        })
      }

      if (!map.getSource(CLUSTER_SOURCE_ID)) {
        map.addSource(CLUSTER_SOURCE_ID, {
          type: 'geojson',
          data: rawData,
          cluster: true,
          clusterRadius: 54,
          clusterMaxZoom: 11,
        })
      }

      if (!map.getSource(BUYER_PURCHASE_SOURCE_ID)) {
        map.addSource(BUYER_PURCHASE_SOURCE_ID, {
          type: 'geojson',
          data: buyerPurchasesGeojsonRef.current,
          cluster: true,
          clusterRadius: 60,
          clusterMaxZoom: 10,
        })
      }

      if (!map.getSource(BUYER_PROFILE_SOURCE_ID)) {
        map.addSource(BUYER_PROFILE_SOURCE_ID, {
          type: 'geojson',
          data: buyerProfilesGeojsonRef.current,
        })
      }

      if (!map.getSource(BUYER_TRAIL_SOURCE_ID)) {
        map.addSource(BUYER_TRAIL_SOURCE_ID, {
          type: 'geojson',
          data: buyerTrailGeojsonRef.current,
        })
      }

      if (!map.getSource(CENSUS_SOURCE_ID)) {
        map.addSource(CENSUS_SOURCE_ID, { type: 'geojson', data: censusGeojsonRef.current })
      }

      const clusterGlowAnchor = map.getLayer('command-pin-cluster-glow') ? 'command-pin-cluster-glow' : undefined

      if (!map.getLayer(CENSUS_LAYER_IDS.fill)) {
        map.addLayer({
          id: CENSUS_LAYER_IDS.fill,
          type: 'fill',
          source: CENSUS_SOURCE_ID,
          paint: {
            'fill-color': ['coalesce', ['get', 'fillColor'], 'rgba(0,0,0,0)'],
            'fill-opacity': 0.28,
          },
          layout: { visibility: 'none' },
        }, clusterGlowAnchor)
      }

      if (!map.getLayer(CENSUS_LAYER_IDS.line)) {
        map.addLayer({
          id: CENSUS_LAYER_IDS.line,
          type: 'line',
          source: CENSUS_SOURCE_ID,
          paint: {
            'line-color': 'rgba(205, 221, 243, 0.18)',
            'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.4, 8, 0.8, 12, 1.2],
            'line-opacity': 0.52,
          },
          layout: { visibility: 'none' },
        }, clusterGlowAnchor)
      }

      if (!map.getLayer(CENSUS_LAYER_IDS.hoverLine)) {
        map.addLayer({
          id: CENSUS_LAYER_IDS.hoverLine,
          type: 'line',
          source: CENSUS_SOURCE_ID,
          paint: {
            'line-color': 'rgba(255, 255, 255, 0.88)',
            'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.8, 8, 1.4, 12, 2.1],
            'line-opacity': 0.92,
          },
          filter: ['==', ['get', 'id'], ''],
          layout: { visibility: 'none' },
        })
      }


      if (!map.getSource(BUYER_DEMAND_SOURCE_ID)) {
        map.addSource(BUYER_DEMAND_SOURCE_ID, { type: 'geojson', data: buyerDemandGeojsonRef.current })
      }

      if (!map.getSource(SELLER_PINS_SOURCE_ID)) {
        map.addSource(SELLER_PINS_SOURCE_ID, {
          type: 'geojson',
          data: sellerPinsGeojsonRef.current,
          cluster: true,
          clusterRadius: 42,
          clusterMaxZoom: SELLER_PINS_CLUSTER_MAX_ZOOM,
          clusterProperties: SELLER_PIN_CLUSTER_PROPERTIES as Record<string, maplibregl.ExpressionSpecification>,
        })
      }

      if (!map.getLayer(SELLER_PINS_LAYER_IDS.hit)) {
        map.addLayer({
          id: SELLER_PINS_LAYER_IDS.hit,
          type: 'circle',
          source: SELLER_PINS_SOURCE_ID,
          filter: ['!', ['has', 'point_count']],
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 14, 12, 20],
            'circle-color': '#000000',
            'circle-opacity': 0,
          },
          layout: { visibility: 'none' },
        })
      }

      if (!map.getLayer(SELLER_PINS_LAYER_IDS.glow)) {
        map.addLayer({
          id: SELLER_PINS_LAYER_IDS.glow,
          type: 'circle',
          source: SELLER_PINS_SOURCE_ID,
          filter: ['!', ['has', 'point_count']],
          paint: {
            'circle-radius': ['+', ['interpolate', ['linear'], ['zoom'], 6, 10, 12, 16], ['*', ['coalesce', ['get', 'glow_strength'], 0.5], 5]],
            'circle-color': PIN_ASSET_GLOW_COLOR_EXPR,
            'circle-opacity': UNIVERSAL_PIN_GLOW_OPACITY_EXPR as maplibregl.ExpressionSpecification,
            'circle-blur': 0.52,
          },
          layout: { visibility: 'none' },
        })
      }

      if (!map.getLayer(SELLER_PINS_LAYER_IDS.ring)) {
        map.addLayer({
          id: SELLER_PINS_LAYER_IDS.ring,
          type: 'circle',
          source: SELLER_PINS_SOURCE_ID,
          filter: ['!', ['has', 'point_count']],
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 10, 12, 14],
            'circle-color': 'rgba(0,0,0,0)',
            'circle-stroke-color': UNIVERSAL_PIN_RING_STROKE_EXPR as maplibregl.ExpressionSpecification,
            'circle-stroke-width': UNIVERSAL_PIN_RING_WIDTH_EXPR as maplibregl.ExpressionSpecification,
            'circle-opacity': 0,
            'circle-stroke-opacity': ['*', ['coalesce', ['get', 'ring_opacity'], 0.92], ['coalesce', ['get', 'focus_opacity'], 1]],
          },
          layout: { visibility: 'none' },
        })
      }

      if (!map.getLayer(SELLER_PINS_LAYER_IDS.pulse)) {
        map.addLayer({
          id: SELLER_PINS_LAYER_IDS.pulse,
          type: 'circle',
          source: SELLER_PINS_SOURCE_ID,
          filter: ['all', ['!', ['has', 'point_count']], ['!=', ['get', 'pulse_style'], 'none']],
          paint: {
            'circle-radius': 14,
            'circle-color': PIN_ASSET_GLOW_COLOR_EXPR,
            'circle-opacity': 0,
            'circle-blur': 0.4,
          },
          layout: { visibility: 'none' },
        })
      }

      // Transparent hit-area — interactions bound here, icon renders above
      if (!map.getLayer(SELLER_PINS_LAYER_IDS.core)) {
        map.addLayer({
          id: SELLER_PINS_LAYER_IDS.core,
          type: 'circle',
          source: SELLER_PINS_SOURCE_ID,
          filter: ['!', ['has', 'point_count']],
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 7.2, 12, 9.6],
            'circle-color': ['coalesce', ['get', 'glass_color'], 'rgba(8,12,18,0.82)'],
            'circle-opacity': UNIVERSAL_PIN_GLASS_OPACITY_EXPR as maplibregl.ExpressionSpecification,
            'circle-stroke-color': ['coalesce', ['get', 'ring_color'], ['get', 'pin_color'], '#38d0f0'],
            'circle-stroke-width': 1.2,
            'circle-stroke-opacity': ['*', 0.42, ['coalesce', ['get', 'focus_opacity'], 1]],
          },
          layout: { visibility: 'none' },
        })
      }

      // Property type icon — SDF symbol drawn over existing command-pin circles.
      // Uses RAW_SOURCE_ID so it shares the same data as the circle layers
      // and propTypeSlug is available via featureCollectionForPins.
      const spIconLayerId = SELLER_PINS_LAYER_IDS.icon
      if (!map.getLayer(spIconLayerId)) {
        map.addLayer({
          id: spIconLayerId,
          type: 'symbol',
          source: SELLER_PINS_SOURCE_ID,
          layout: {
            'icon-image': PIN_ICON_IMAGE_BY_SLUG_EXPR as maplibregl.ExpressionSpecification,
            'icon-size': UNIVERSAL_PIN_ICON_SCALE_EXPR as maplibregl.ExpressionSpecification,
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            'icon-pitch-alignment': 'map',
            'icon-rotation-alignment': 'map',
          },
          paint: {
            'icon-color': ['coalesce', ['get', 'icon_color'], PIN_ICON_COLOR_COALESCED_EXPR] as unknown as maplibregl.ExpressionSpecification,
            'icon-opacity': ['max', 0.96, ['coalesce', ['get', 'focus_opacity'], ['get', 'focusOpacity'], 1]],
            'icon-halo-color': PIN_ASSET_GLOW_COLOR_EXPR,
            'icon-halo-width': 1.4,
            'icon-halo-blur': 0.8,
          },
        } as maplibregl.LayerSpecification)
      }

      if (!map.getLayer(SELLER_PINS_LAYER_IDS.clusterGlow)) {
        const clusterIdentity = getCommandMapThemeIdentity(activeThemeRef.current.id)
        map.addLayer({
          id: SELLER_PINS_LAYER_IDS.clusterGlow,
          type: 'circle',
          source: SELLER_PINS_SOURCE_ID,
          filter: ['has', 'point_count'],
          paint: {
            'circle-radius': ['step', ['get', 'point_count'], 28, 20, 36, 80, 44, 200, 54, 500, 64],
            'circle-color': buildSellerClusterRingExpr(clusterIdentity.clusterTint) as maplibregl.ExpressionSpecification,
            'circle-opacity': 1,
            'circle-blur': 0.9,
          },
          layout: { visibility: 'none' },
        })
      }

      if (!map.getLayer(SELLER_PINS_LAYER_IDS.clusterCore)) {
        const clusterPalette = activeThemeRef.current.clusterPalette
        map.addLayer({
          id: SELLER_PINS_LAYER_IDS.clusterCore,
          type: 'circle',
          source: SELLER_PINS_SOURCE_ID,
          filter: ['has', 'point_count'],
          paint: {
            'circle-radius': ['step', ['get', 'point_count'], 15, 20, 19, 80, 23, 200, 27, 500, 31],
            'circle-color': buildSellerClusterCoreExpr(clusterPalette.core) as maplibregl.ExpressionSpecification,
            'circle-stroke-color': buildSellerClusterStrokeExpr(clusterPalette.stroke) as maplibregl.ExpressionSpecification,
            'circle-stroke-width': 2,
            'circle-opacity': 0.96,
          },
          layout: { visibility: 'none' },
        })
      }

      if (!map.getLayer(SELLER_PINS_LAYER_IDS.clusterCount)) {
        map.addLayer({
          id: SELLER_PINS_LAYER_IDS.clusterCount,
          type: 'symbol',
          source: SELLER_PINS_SOURCE_ID,
          filter: ['has', 'point_count'],
          layout: {
            'text-field': ['get', 'point_count_abbreviated'],
            'text-font': ['DIN Offc Pro Medium', 'Open Sans Semibold'],
            'text-size': 11,
            'text-allow-overlap': true,
            visibility: 'none',
          },
          paint: {
            'text-color': 'rgba(200,230,250,0.92)',
            'text-halo-color': 'rgba(3,4,8,0.6)',
            'text-halo-width': 1,
          },
        })
      }

      if (!map.getLayer(BUYER_DEMAND_LAYER_IDS.activity6mo)) {
        map.addLayer({
          id: BUYER_DEMAND_LAYER_IDS.activity6mo, type: 'circle', source: BUYER_DEMAND_SOURCE_ID,
          filter: ['==', ['get', 'metric'], 'buyer_activity_6mo'],
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['get', 'score'], 0, 5, 100, 22],
            'circle-color': '#14b8a6', 'circle-opacity': 0.56, 'circle-blur': 0.25,
            'circle-stroke-width': 1, 'circle-stroke-color': 'rgba(20,184,166,0.4)',
          },
          layout: { visibility: 'none' },
        })
      }
      if (!map.getLayer(BUYER_DEMAND_LAYER_IDS.investorDemand)) {
        map.addLayer({
          id: BUYER_DEMAND_LAYER_IDS.investorDemand, type: 'circle', source: BUYER_DEMAND_SOURCE_ID,
          filter: ['==', ['get', 'metric'], 'investor_demand'],
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['get', 'score'], 0, 5, 100, 22],
            'circle-color': '#f97316', 'circle-opacity': 0.56, 'circle-blur': 0.25,
            'circle-stroke-width': 1, 'circle-stroke-color': 'rgba(249,115,22,0.4)',
          },
          layout: { visibility: 'none' },
        })
      }
      if (!map.getLayer(BUYER_DEMAND_LAYER_IDS.buyerHeat)) {
        map.addLayer({
          id: BUYER_DEMAND_LAYER_IDS.buyerHeat, type: 'circle', source: BUYER_DEMAND_SOURCE_ID,
          filter: ['==', ['get', 'metric'], 'buyer_heat'],
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['get', 'score'], 0, 5, 100, 24],
            'circle-color': '#22c55e', 'circle-opacity': 0.56, 'circle-blur': 0.2,
            'circle-stroke-width': 1, 'circle-stroke-color': 'rgba(34,197,94,0.4)',
          },
          layout: { visibility: 'none' },
        })
      }
      if (!map.getLayer(BUYER_DEMAND_LAYER_IDS.soldPrice)) {
        map.addLayer({
          id: BUYER_DEMAND_LAYER_IDS.soldPrice, type: 'circle', source: BUYER_DEMAND_SOURCE_ID,
          filter: ['==', ['get', 'metric'], 'sold_price'],
          paint: {
            'circle-radius': 8,
            'circle-color': '#eab308', 'circle-opacity': 0.52, 'circle-blur': 0.2,
            'circle-stroke-width': 1, 'circle-stroke-color': 'rgba(234,179,8,0.4)',
          },
          layout: { visibility: 'none' },
        })
      }
      if (!map.getLayer(BUYER_DEMAND_LAYER_IDS.soldPriceLabel)) {
        map.addLayer({
          id: BUYER_DEMAND_LAYER_IDS.soldPriceLabel, type: 'symbol', source: BUYER_DEMAND_SOURCE_ID,
          filter: ['==', ['get', 'metric'], 'sold_price'],
          layout: {
            'text-field': ['get', 'priceLabel'],
            'text-size': 10,
            'text-font': ['Open Sans Semibold'],
            'text-offset': [0, 1.2],
            'text-allow-overlap': false,
            visibility: 'none',
          },
          paint: {
            'text-color': '#eab308',
            'text-halo-color': 'rgba(8,10,15,0.88)',
            'text-halo-width': 1.2,
          },
          minzoom: 8,
        })
      }

      if (!map.getSource(SOLD_COMPS_SOURCE_ID)) {
        map.addSource(SOLD_COMPS_SOURCE_ID, { 
          type: 'geojson', 
          data: soldCompsGeojsonRef.current,
          cluster: true,
          clusterRadius: 50,
          clusterMaxZoom: 11
        })
      }

      if (!map.getLayer(SOLD_COMPS_LAYER_IDS.hit)) {
        map.addLayer({
          id: SOLD_COMPS_LAYER_IDS.hit,
          type: 'circle',
          source: SOLD_COMPS_SOURCE_ID,
          filter: ['!', ['has', 'point_count']],
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 12, 14, 16],
            'circle-color': 'rgba(0,0,0,0)',
            'circle-stroke-width': 0,
          },
          layout: { visibility: 'none' },
          minzoom: 6,
        })
      }

      if (!map.getLayer(SOLD_COMPS_LAYER_IDS.marker)) {
        // Comp glow bloom — cool blue-white for retail, green-cyan for investor
        map.addLayer({
          id: `${SOLD_COMPS_LAYER_IDS.marker}-glow`,
          type: 'circle',
          source: SOLD_COMPS_SOURCE_ID,
          filter: ['!', ['has', 'point_count']],
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 14, 14, 20],
            'circle-color': [
              'match', ['get', 'buyer_type_label'],
              'Local Investor',        '#22c55e',
              'Out of State Investor', '#22c55e',
              'Institutional Buyer',   '#22c55e',
              '#38d0f0',
            ],
            'circle-opacity': 0.12,
            'circle-blur': 0.9,
          },
          layout: { visibility: 'none' },
          minzoom: 6,
        })

        // Comp core — analytical square/diamond shape via circle with stroke
        map.addLayer({
          id: SOLD_COMPS_LAYER_IDS.marker,
          type: 'circle',
          source: SOLD_COMPS_SOURCE_ID,
          filter: ['!', ['has', 'point_count']],
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 5, 14, 7.5],
            'circle-color': 'rgba(7,11,22,0.82)',
            'circle-stroke-width': 1.8,
            'circle-stroke-color': [
              'match', ['get', 'buyer_type_label'],
              'Local Investor',        '#22c55e',
              'Out of State Investor', '#22c55e',
              'Institutional Buyer',   '#10b981',
              // retail / unknown
              'rgba(56,208,240,0.85)',
            ],
            'circle-opacity': 0,
            'circle-stroke-opacity': 0,
          },
          layout: { visibility: 'none' },
          minzoom: 6,
        })

        map.addLayer({
          id: SOLD_COMPS_LAYER_IDS.icon,
          type: 'symbol',
          source: SOLD_COMPS_SOURCE_ID,
          filter: ['!', ['has', 'point_count']],
          layout: {
            'icon-image': PIN_ICON_IMAGE_BY_SLUG_EXPR,
            'icon-size': [
              'interpolate', ['linear'], ['zoom'],
              8, 0.22,
              14, 0.44,
              16, 0.56,
            ],
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            'icon-pitch-alignment': 'map',
            'icon-rotation-alignment': 'map',
          },
          paint: {
            'icon-color': '#ef4444',
            'icon-opacity': 1.0,
            'icon-halo-color': '#ef4444',
            'icon-halo-width': 1.2,
            'icon-halo-blur': 1.5,
          },
          minzoom: 6,
        })
      }

      if (!map.getLayer(SOLD_COMPS_LAYER_IDS.label)) {
        map.addLayer({
          id: SOLD_COMPS_LAYER_IDS.label,
          type: 'symbol',
          source: SOLD_COMPS_SOURCE_ID,
          filter: ['!', ['has', 'point_count']],
          layout: {
            'text-field': [
              'step',
              ['zoom'],
              ['get', 'salePriceLabel'],
              11,
              ['concat', ['get', 'sourceShort'], 'SOLD ', ['get', 'salePriceLabel']]
            ],
            'text-font': ['Open Sans Semibold'],
            'text-size': ['interpolate', ['linear'], ['zoom'], 10, 10, 14, 12],
            'text-anchor': 'left',
            'text-offset': [0.8, 0],
            'text-allow-overlap': true,
            'text-ignore-placement': true,
            visibility: 'none',
          },
          paint: {
            'text-color': '#ef4444',
            'text-halo-color': 'rgba(15, 8, 10, 0.95)',
            'text-halo-width': 1.5,
          },
          minzoom: 8,
        })
      }

      if (!map.getLayer(SOLD_COMPS_CLUSTER_LAYER_IDS.glow)) {
        map.addLayer({
          id: SOLD_COMPS_CLUSTER_LAYER_IDS.glow,
          type: 'circle',
          source: SOLD_COMPS_SOURCE_ID,
          filter: ['has', 'point_count'],
          paint: {
            'circle-radius': ['step', ['get', 'point_count'], 22, 20, 28, 80, 34, 200, 40, 500, 48],
            'circle-color': 'rgba(56,208,240,0.06)',
            'circle-blur': 1.1,
          },
          layout: { visibility: 'none' },
        })
      }

      if (!map.getLayer(SOLD_COMPS_CLUSTER_LAYER_IDS.core)) {
        map.addLayer({
          id: SOLD_COMPS_CLUSTER_LAYER_IDS.core,
          type: 'circle',
          source: SOLD_COMPS_SOURCE_ID,
          filter: ['has', 'point_count'],
          paint: {
            'circle-radius': ['step', ['get', 'point_count'], 11, 20, 14, 80, 17, 200, 21, 500, 25],
            'circle-color': 'rgba(7,11,22,0.84)',
            'circle-stroke-width': 1.5,
            'circle-stroke-color': 'rgba(56,208,240,0.55)',
          },
          layout: { visibility: 'none' },
        })
      }

      if (!map.getLayer(SOLD_COMPS_CLUSTER_LAYER_IDS.count)) {
        map.addLayer({
          id: SOLD_COMPS_CLUSTER_LAYER_IDS.count,
          type: 'symbol',
          source: SOLD_COMPS_SOURCE_ID,
          filter: ['has', 'point_count'],
          layout: {
            'text-field': ['get', 'point_count_abbreviated'],
            'text-font': ['DIN Offc Pro Medium', 'Open Sans Semibold'],
            'text-size': ['step', ['get', 'point_count'], 10, 20, 11, 80, 12],
            'text-allow-overlap': true,
            visibility: 'none',
          },
          paint: {
            'text-color': 'rgba(200,230,250,0.90)',
            'text-halo-color': 'rgba(3,4,8,0.6)',
            'text-halo-width': 1,
          },
        })
      }

      if (!map.getLayer('command-pin-cluster-glow')) {
        const clusterPalette = activeThemeRef.current.clusterPalette
        map.addLayer({
          id: 'command-pin-cluster-glow',
          type: 'circle',
          source: CLUSTER_SOURCE_ID,
          filter: ['has', 'point_count'],
          paint: {
            'circle-radius': ['step', ['get', 'point_count'], 20, 20, 28, 80, 36, 200, 46, 500, 56],
            'circle-color': clusterPalette.glow,
            'circle-opacity': 0.18,
            'circle-blur': 0.6,
          },
        })
      }

      if (!map.getLayer('command-pin-cluster-core')) {
        const clusterPalette = activeThemeRef.current.clusterPalette
        map.addLayer({
          id: 'command-pin-cluster-core',
          type: 'circle',
          source: CLUSTER_SOURCE_ID,
          filter: ['has', 'point_count'],
          paint: {
            'circle-radius': ['step', ['get', 'point_count'], 14, 20, 18, 80, 22, 200, 26, 500, 30],
            'circle-color': clusterPalette.core,
            'circle-stroke-color': clusterPalette.stroke,
            'circle-stroke-width': 1.8,
            'circle-opacity': 0.96,
          },
        })
      }

      if (!map.getLayer('command-pin-cluster-count')) {
        const clusterPalette = activeThemeRef.current.clusterPalette
        map.addLayer({
          id: 'command-pin-cluster-count',
          type: 'symbol',
          source: CLUSTER_SOURCE_ID,
          filter: ['has', 'point_count'],
          layout: {
            'text-field': ['get', 'point_count_abbreviated'],
            'text-size': 12,
            'text-font': ['Open Sans Bold'],
            'text-allow-overlap': true,
          },
          paint: {
            'text-color': clusterPalette.label,
            'text-halo-color': clusterPalette.halo,
            'text-halo-width': 1.2,
          },
        })
      }

      const addPointLayers = (suffix: 'raw' | 'clustered', sourceId: string, filter?: any) => {
        const layerFilter = filter ?? true
        if (!map.getLayer(`command-pin-glow-${suffix}`)) {
          map.addLayer({
            id: `command-pin-glow-${suffix}`,
            type: 'circle',
            source: sourceId,
            ...(filter ? { filter: layerFilter } : {}),
            paint: {
              'circle-radius': ['+', 14, ['*', ['get', 'glowStrength'], 18]],
              'circle-blur': 1,
              'circle-opacity': ['*', ['case', ['==', ['get', 'glowStrength'], 1], 0.36, ['>=', ['get', 'glowStrength'], 0.8], 0.28, ['>=', ['get', 'glowStrength'], 0.52], 0.22, 0.14], ['get', 'focusOpacity']],
              'circle-color': PIN_ASSET_GLOW_COLOR_EXPR,
            },
          })
        }

        if (!map.getLayer(`command-pin-pulse-${suffix}`)) {
          map.addLayer({
            id: `command-pin-pulse-${suffix}`,
            type: 'circle',
            source: sourceId,
            ...(filter ? { filter: layerFilter } : {}),
            paint: {
              'circle-radius': ['match', ['get', 'pulseTier'], 'fast', 20, 'medium_fast', 18, 'medium', 16, 'slow', 14, 'very_slow', 12, 10],
              'circle-opacity': ['*', ['case', ['==', ['get', 'pulseMode'], 'none'], 0, ['match', ['get', 'pulseTier'], 'fast', 0.22, 'medium_fast', 0.18, 'medium', 0.14, 'slow', 0.10, 'very_slow', 0, 0]], ['get', 'focusOpacity']],
              'circle-color': PIN_ASSET_GLOW_COLOR_EXPR,
              'circle-stroke-width': ['case', ['==', ['get', 'pulseMode'], 'none'], 0, ['match', ['get', 'pulseTier'], 'fast', 1.8, 'medium_fast', 1.5, 'medium', 1.3, 'slow', 1.1, 'very_slow', 0, 0]],
              'circle-stroke-color': PIN_ASSET_GLOW_COLOR_EXPR,
            },
          })
        }

        if (!map.getLayer(`command-pin-unread-ring-${suffix}`)) {
          map.addLayer({
            id: `command-pin-unread-ring-${suffix}`,
            type: 'circle',
            source: sourceId,
            ...(filter ? { filter: layerFilter } : {}),
            paint: {
              'circle-radius': 12.5,
              'circle-color': 'transparent',
              'circle-stroke-width': ['case', ['==', ['get', 'unreadRingColor'], 'transparent'], 0, 2.1],
              'circle-stroke-color': ['get', 'unreadRingColor'],
              'circle-stroke-opacity': ['*', 0.94, ['get', 'focusOpacity']],
            },
          })
        }

        if (!map.getLayer(`command-pin-offer-ring-${suffix}`)) {
          map.addLayer({
            id: `command-pin-offer-ring-${suffix}`,
            type: 'circle',
            source: sourceId,
            ...(filter ? { filter: layerFilter } : {}),
            paint: {
              'circle-radius': 14.5,
              'circle-color': 'transparent',
              'circle-stroke-width': ['case', ['==', ['get', 'offerRingColor'], 'transparent'], 0, 2.2],
              'circle-stroke-color': ['get', 'offerRingColor'],
              'circle-stroke-opacity': ['*', 0.96, ['get', 'focusOpacity']],
            },
          })
        }

        if (!map.getLayer(`command-pin-contract-ring-${suffix}`)) {
          map.addLayer({
            id: `command-pin-contract-ring-${suffix}`,
            type: 'circle',
            source: sourceId,
            ...(filter ? { filter: layerFilter } : {}),
            paint: {
              'circle-radius': 16.5,
              'circle-color': 'transparent',
              'circle-stroke-width': ['case', ['==', ['get', 'contractRingColor'], 'transparent'], 0, 2.2],
              'circle-stroke-color': ['get', 'contractRingColor'],
              'circle-stroke-opacity': ['*', 0.92, ['get', 'focusOpacity']],
            },
          })
        }

        if (!map.getLayer(`command-pin-core-${suffix}`)) {
          map.addLayer({
            id: `command-pin-core-${suffix}`,
            type: 'circle',
            source: sourceId,
            ...(filter ? { filter: layerFilter } : {}),
            paint: {
              'circle-radius': ['case', ['==', ['get', 'selected'], 1], 7.8, 6.6],
              'circle-color': ['get', 'stageColor'],
              'circle-stroke-width': 0,
              'circle-stroke-color': 'rgba(0,0,0,0)',
              'circle-opacity': 0,
            },
          })
        }

        if (!map.getLayer(`command-pin-icon-${suffix}`)) {
          map.addLayer({
            id: `command-pin-icon-${suffix}`,
            type: 'symbol',
            source: sourceId,
            ...(filter ? { filter: layerFilter } : {}),
            layout: {
              'icon-image': PIN_ICON_IMAGE_BY_SLUG_EXPR,
              'icon-size': [
                'interpolate', ['linear'], ['zoom'],
                6,  0.22,
                10, 0.32,
                13, 0.44,
                16, 0.56,
              ],
              'icon-allow-overlap': true,
              'icon-ignore-placement': true,
              'icon-pitch-alignment': 'map',
              'icon-rotation-alignment': 'map',
            },
            paint: {
              'icon-color': PIN_ICON_COLOR_COALESCED_EXPR,
              'icon-opacity': ['*', ['case', ['==', ['get', 'lockState'], 1], 0.9, 0.98], ['get', 'focusOpacity']],
              'icon-halo-color': PIN_ASSET_GLOW_COLOR_EXPR,
              'icon-halo-width': 1.2,
              'icon-halo-blur': 1.5,
            },
          })
        }

        if (!map.getLayer(`command-pin-warning-badge-${suffix}`)) {
          map.addLayer({
            id: `command-pin-warning-badge-${suffix}`,
            type: 'symbol',
            source: sourceId,
            ...(filter ? { filter: layerFilter } : {}),
            layout: {
              'text-field': ['case', ['==', ['get', 'queueBlockedBadge'], 1], '⛔', ['==', ['get', 'needsReviewBadge'], 1], '⚠', ['==', ['get', 'followUpDueBadge'], 1], '⏰', ['==', ['get', 'suppressedBadge'], 1], '🔒', ''],
              'text-size': 11,
              'text-offset': [1.05, -1.05],
              'text-allow-overlap': true,
            },
            paint: {
              'text-color': ['case', ['==', ['get', 'suppressedBadge'], 1], '#ff6b63', ['==', ['get', 'queueBlockedBadge'], 1], '#ff6b63', ['==', ['get', 'followUpDueBadge'], 1], '#ffd166', '#ffd166'],
              'text-halo-color': 'rgba(8,10,15,0.92)',
              'text-halo-width': 1.4,
              'text-opacity': ['get', 'focusOpacity'],
            },
          })
        }
      }

      addPointLayers('raw', RAW_SOURCE_ID)
      addPointLayers('clustered', CLUSTER_SOURCE_ID, ['!', ['has', 'point_count']])

      if (!map.getLayer(BUYER_HEATMAP_LAYER_ID)) {
        const heatmapStops = activeThemeRef.current.heatmapStops
        map.addLayer({
          id: BUYER_HEATMAP_LAYER_ID,
          type: 'heatmap',
          source: BUYER_PURCHASE_SOURCE_ID,
          maxzoom: 12,
          paint: {
            'heatmap-weight': ['coalesce', ['get', 'heatWeight'], 0.3],
            'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 4, 0.55, 10, 1.2],
            'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 4, 18, 10, 42],
            'heatmap-opacity': 0.42,
            'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, heatmapStops[0], 0.2, heatmapStops[1], 0.45, heatmapStops[2], 0.7, heatmapStops[3], 1, heatmapStops[4]],
          },
          layout: { visibility: 'none' },
        })
      }

      if (!map.getLayer('command-buyer-cluster-glow')) {
        map.addLayer({
          id: 'command-buyer-cluster-glow',
          type: 'circle',
          source: BUYER_PURCHASE_SOURCE_ID,
          filter: ['has', 'point_count'],
          paint: {
            'circle-radius': ['step', ['get', 'point_count'], 18, 10, 24, 30, 30, 75, 38],
            'circle-color': '#f0b25a',
            'circle-opacity': 0.18,
            'circle-blur': 0.9,
          },
          layout: { visibility: 'none' },
        })
      }

      if (!map.getLayer('command-buyer-cluster-core')) {
        map.addLayer({
          id: 'command-buyer-cluster-core',
          type: 'circle',
          source: BUYER_PURCHASE_SOURCE_ID,
          filter: ['has', 'point_count'],
          paint: {
            'circle-radius': ['step', ['get', 'point_count'], 12, 10, 16, 30, 20, 75, 24],
            'circle-color': '#10141d',
            'circle-stroke-color': '#f0b25a',
            'circle-stroke-width': 1.5,
            'circle-opacity': 0.95,
          },
          layout: { visibility: 'none' },
        })
      }

      if (!map.getLayer('command-buyer-cluster-count')) {
        map.addLayer({
          id: 'command-buyer-cluster-count',
          type: 'symbol',
          source: BUYER_PURCHASE_SOURCE_ID,
          filter: ['has', 'point_count'],
          layout: {
            'text-field': ['get', 'point_count_abbreviated'],
            'text-size': 11,
            'text-font': ['Open Sans Bold'],
            'text-allow-overlap': true,
            visibility: 'none',
          },
          paint: {
            'text-color': '#fff7e8',
            'text-halo-color': 'rgba(8,10,15,0.92)',
            'text-halo-width': 1.1,
          },
        })
      }

      if (!map.getLayer('command-buyer-purchase-glow')) {
        map.addLayer({
          id: 'command-buyer-purchase-glow',
          type: 'circle',
          source: BUYER_PURCHASE_SOURCE_ID,
          filter: ['!', ['has', 'point_count']],
          paint: {
            'circle-radius': ['coalesce', ['get', 'radiusWeight'], 10],
            'circle-color': ['get', 'pointColor'],
            'circle-opacity': ['*', ['get', 'focusOpacity'], ['case', ['==', ['get', 'isRecent'], 1], 0.34, 0.16]],
            'circle-blur': 1,
          },
          layout: { visibility: 'none' },
        })
      }

      if (!map.getLayer('command-buyer-purchase-core')) {
        map.addLayer({
          id: 'command-buyer-purchase-core',
          type: 'circle',
          source: BUYER_PURCHASE_SOURCE_ID,
          filter: ['!', ['has', 'point_count']],
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 4.2, 11, 7.8],
            'circle-color': ['get', 'pointColor'],
            'circle-stroke-color': ['case', ['==', ['get', 'isSelectedBuyer'], 1], '#fff7d6', '#fff4de'],
            'circle-stroke-width': ['case', ['==', ['get', 'isSelectedBuyer'], 1], 2.2, 1.2],
            'circle-opacity': ['*', ['get', 'focusOpacity'], ['case', ['==', ['get', 'isRecent'], 1], 1, 0.78]],
          },
          layout: { visibility: 'none' },
        })
      }

      if (!map.getLayer('command-buyer-profile-core')) {
        map.addLayer({
          id: 'command-buyer-profile-core',
          type: 'circle',
          source: BUYER_PROFILE_SOURCE_ID,
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 7, 11, 11],
            'circle-color': ['get', 'pointColor'],
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 1.1,
            'circle-opacity': ['*', ['get', 'focusOpacity'], 0.9],
          },
          layout: { visibility: 'none' },
        })
      }

      if (!map.getLayer('command-buyer-profile-label')) {
        map.addLayer({
          id: 'command-buyer-profile-label',
          type: 'symbol',
          source: BUYER_PROFILE_SOURCE_ID,
          layout: {
            'text-field': [
              'format',
              ['get', 'buyerName'], {},
              '\n', {},
              ['get', 'buyerType'], { 'font-scale': 0.85 }
            ],
            'text-size': 10,
            'text-font': ['Open Sans Semibold'],
            'text-offset': [0, 1.3],
            'text-allow-overlap': false,
            visibility: 'none',
          },
          paint: {
            'text-color': '#eef4ff',
            'text-halo-color': 'rgba(8,10,15,0.9)',
            'text-halo-width': 1,
            'text-opacity': ['*', ['get', 'focusOpacity'], 0.9],
          },
        })
      }

      if (!map.getLayer('command-buyer-trail-glow')) {
        map.addLayer({
          id: 'command-buyer-trail-glow',
          type: 'line',
          source: BUYER_TRAIL_SOURCE_ID,
          paint: {
            'line-color': ['coalesce', ['get', 'color'], '#7ee7ff'],
            'line-width': ['interpolate', ['linear'], ['zoom'], 6, 4, 12, 10],
            'line-opacity': 0.14,
            'line-blur': 1.1,
          },
          layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
        })
      }

      if (!map.getLayer('command-buyer-trail-line')) {
        map.addLayer({
          id: 'command-buyer-trail-line',
          type: 'line',
          source: BUYER_TRAIL_SOURCE_ID,
          paint: {
            'line-color': ['coalesce', ['get', 'color'], '#7ee7ff'],
            'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.3, 12, 2.6],
            'line-opacity': 0.8,
          },
          layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
        })
      }
      // ── SOURCE A: National / market aggregate clusters (canonical totals) ───
      const puTokens = getMapThemeTokens(activeThemeRef.current.id)
      const puPinTokens = getMapPinThemeTokens(activeThemeRef.current.id)
      const puAnchor = map.getLayer('command-pin-cluster-glow') ? 'command-pin-cluster-glow' : undefined

      if (!map.getSource(MARKET_AGGREGATE_SOURCE_ID)) {
        map.addSource(MARKET_AGGREGATE_SOURCE_ID, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        })
      }

      if (!map.getLayer(MARKET_AGGREGATE_LAYER_IDS.halo)) {
        map.addLayer({
          id: MARKET_AGGREGATE_LAYER_IDS.halo,
          type: 'circle',
          source: MARKET_AGGREGATE_SOURCE_ID,
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['coalesce', ['get', 'property_count'], ['get', 'point_count'], 1],
              100, 22, 1000, 34, 5000, 48, 20000, 64, 100000, 80],
            'circle-color': buildClusterHaloExpr(puPinTokens.clusterGlow) as maplibregl.ExpressionSpecification,
            'circle-blur': 0.7,
            'circle-opacity': 0.82,
          },
          layout: { visibility: 'none' },
        }, puAnchor)
      }

      if (!map.getLayer(MARKET_AGGREGATE_LAYER_IDS.core)) {
        map.addLayer({
          id: MARKET_AGGREGATE_LAYER_IDS.core,
          type: 'circle',
          source: MARKET_AGGREGATE_SOURCE_ID,
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['coalesce', ['get', 'property_count'], ['get', 'point_count'], 1],
              100, 14, 1000, 22, 5000, 30, 20000, 38, 100000, 48],
            'circle-color': buildClusterSemanticCoreExpr(puPinTokens.clusterFill) as maplibregl.ExpressionSpecification,
            'circle-stroke-width': 2,
            'circle-stroke-color': buildClusterSemanticStrokeExpr(puPinTokens.clusterBorder) as maplibregl.ExpressionSpecification,
            'circle-opacity': 0.92,
          },
          layout: { visibility: 'none' },
        }, puAnchor)
      }

      if (!map.getLayer(MARKET_AGGREGATE_LAYER_IDS.count)) {
        map.addLayer({
          id: MARKET_AGGREGATE_LAYER_IDS.count,
          type: 'symbol',
          source: MARKET_AGGREGATE_SOURCE_ID,
          layout: {
            'text-field': CLUSTER_COUNT_TEXT_EXPR as maplibregl.ExpressionSpecification,
            'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Bold'],
            'text-size': ['interpolate', ['linear'], ['coalesce', ['get', 'property_count'], ['get', 'point_count'], 1], 100, 10, 1000, 12, 10000, 14],
            'text-allow-overlap': true,
            visibility: 'none',
          },
          paint: {
            'text-color': puTokens.clusterLabelColor,
            'text-halo-color': puTokens.clusterLabelHalo,
            'text-halo-width': 1.2,
          },
        }, puAnchor)
      }

      // MVT property tiles must install before legacy GeoJSON universe layers.
      ensurePropertyTileSourceAndLayers(map, activeThemeRef.current.id, puAnchor)

      // ── SOURCE B: Property universe — asset icon + status ring ─────────────
      if (!map.getSource(PROPERTY_UNIVERSE_SOURCE_ID)) {
        map.addSource(PROPERTY_UNIVERSE_SOURCE_ID, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
          cluster: true,
          clusterRadius: 46,
          clusterMaxZoom: PROPERTY_UNIVERSE_CLUSTER_MAX_ZOOM,
          clusterProperties: ACQUISITION_RADAR_CLUSTER_PROPERTIES as Record<string, maplibregl.ExpressionSpecification>,
        })
      }

      if (!map.getLayer(PROPERTY_UNIVERSE_LAYER_IDS.clusterRing)) {
        map.addLayer({
          id: PROPERTY_UNIVERSE_LAYER_IDS.clusterRing,
          type: 'circle',
          source: PROPERTY_UNIVERSE_SOURCE_ID,
          filter: ['has', 'point_count'],
          paint: {
            'circle-radius': CLUSTER_HALO_RADIUS_EXPR as maplibregl.ExpressionSpecification,
            'circle-color': buildClusterHaloExpr(puPinTokens.clusterGlow) as maplibregl.ExpressionSpecification,
            'circle-blur': 0.75,
            'circle-opacity': 0.88,
          },
          layout: { visibility: 'none' },
        }, puAnchor)
      }

      if (!map.getLayer(PROPERTY_UNIVERSE_LAYER_IDS.clusterCore)) {
        map.addLayer({
          id: PROPERTY_UNIVERSE_LAYER_IDS.clusterCore,
          type: 'circle',
          source: PROPERTY_UNIVERSE_SOURCE_ID,
          filter: ['has', 'point_count'],
          paint: {
            'circle-radius': CLUSTER_RADIUS_EXPR as maplibregl.ExpressionSpecification,
            'circle-color': buildClusterSemanticCoreExpr(puPinTokens.clusterFill) as maplibregl.ExpressionSpecification,
            'circle-stroke-width': 2,
            'circle-stroke-color': buildClusterSemanticStrokeExpr(puPinTokens.clusterBorder) as maplibregl.ExpressionSpecification,
            'circle-opacity': 0.94,
          },
          layout: { visibility: 'none' },
        }, puAnchor)
      }

      if (!map.getLayer(PROPERTY_UNIVERSE_LAYER_IDS.clusterIcon)) {
        map.addLayer({
          id: PROPERTY_UNIVERSE_LAYER_IDS.clusterIcon,
          type: 'symbol',
          source: PROPERTY_UNIVERSE_SOURCE_ID,
          filter: ['has', 'point_count'],
          layout: {
            'icon-image': buildClusterDominantIconExpr() as maplibregl.ExpressionSpecification,
            'icon-size': ['step', ['get', 'point_count'], 0.18, 50, 0.22, 150, 0.26],
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            visibility: 'none',
          },
          paint: {
            'icon-color': puPinTokens.neutralIcon,
            'icon-opacity': 0.42,
          },
        }, puAnchor)
      }

      if (!map.getLayer(PROPERTY_UNIVERSE_LAYER_IDS.clusterCount)) {
        map.addLayer({
          id: PROPERTY_UNIVERSE_LAYER_IDS.clusterCount,
          type: 'symbol',
          source: PROPERTY_UNIVERSE_SOURCE_ID,
          filter: ['has', 'point_count'],
          layout: {
            'text-field': ['step', ['get', 'point_count'],
              ['to-string', ['get', 'point_count']],
              1000, ['concat', ['to-string', ['/', ['round', ['/', ['get', 'point_count'], 100]], 10]], 'k'],
            ],
            'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Bold'],
            'text-size': 11,
            'text-allow-overlap': true,
            visibility: 'none',
          },
          paint: {
            'text-color': puTokens.clusterLabelColor,
            'text-halo-color': puTokens.clusterLabelHalo,
            'text-halo-width': 1,
          },
        }, puAnchor)
      }

      if (!map.getLayer(PROPERTY_UNIVERSE_LAYER_IDS.markerHit)) {
        map.addLayer({
          id: PROPERTY_UNIVERSE_LAYER_IDS.markerHit,
          type: 'circle',
          source: PROPERTY_UNIVERSE_SOURCE_ID,
          filter: ['!', ['has', 'point_count']],
          paint: {
            'circle-radius': PIN_HIT_RADIUS_EXPR as maplibregl.ExpressionSpecification,
            'circle-color': 'rgba(0,0,0,0)',
            'circle-opacity': 0,
          },
          layout: { visibility: 'none' },
        }, puAnchor)
      }

      if (!map.getLayer(PROPERTY_UNIVERSE_LAYER_IDS.markerGlow)) {
        map.addLayer({
          id: PROPERTY_UNIVERSE_LAYER_IDS.markerGlow,
          type: 'circle',
          source: PROPERTY_UNIVERSE_SOURCE_ID,
          filter: ['!', ['has', 'point_count']],
          paint: {
            'circle-radius': PIN_HALO_RADIUS_EXPR as maplibregl.ExpressionSpecification,
            'circle-blur': 0.62,
            'circle-opacity': PIN_HALO_OPACITY_EXPR as maplibregl.ExpressionSpecification,
            'circle-color': ['coalesce', ['get', 'ring_color'], ['get', 'icon_color'], PIN_ICON_COLOR_EXPR] as unknown as maplibregl.ExpressionSpecification,
          },
          layout: { visibility: 'none' },
        }, puAnchor)
      }

      if (!map.getLayer(PROPERTY_UNIVERSE_LAYER_IDS.markerPulse)) {
        map.addLayer({
          id: PROPERTY_UNIVERSE_LAYER_IDS.markerPulse,
          type: 'circle',
          source: PROPERTY_UNIVERSE_SOURCE_ID,
          filter: MOTION_PIN_FILTER as maplibregl.FilterSpecification,
          paint: {
            'circle-radius': 12,
            'circle-color': ['coalesce', ['get', 'ring_color'], ['get', 'icon_color'], PIN_ICON_COLOR_EXPR] as unknown as maplibregl.ExpressionSpecification,
            'circle-opacity': 0,
            'circle-blur': 0.35,
          },
          layout: { visibility: 'none' },
        }, puAnchor)
      }

      if (!map.getLayer(PROPERTY_UNIVERSE_LAYER_IDS.markerGlass)) {
        map.addLayer({
          id: PROPERTY_UNIVERSE_LAYER_IDS.markerGlass,
          type: 'circle',
          source: PROPERTY_UNIVERSE_SOURCE_ID,
          filter: ['!', ['has', 'point_count']],
          paint: {
            'circle-radius': PIN_GLASS_RADIUS_EXPR as maplibregl.ExpressionSpecification,
            'circle-color': ['coalesce', ['get', 'glass_color'], puPinTokens.glassFill] as maplibregl.ExpressionSpecification,
            'circle-opacity': ['*', ['coalesce', ['get', 'glass_opacity'], 0.84], ['coalesce', ['get', 'base_opacity'], 1]] as maplibregl.ExpressionSpecification,
            'circle-stroke-width': 0,
          },
          layout: { visibility: 'none' },
        }, puAnchor)
      }

      if (!map.getLayer(PROPERTY_UNIVERSE_LAYER_IDS.markerRing)) {
        map.addLayer({
          id: PROPERTY_UNIVERSE_LAYER_IDS.markerRing,
          type: 'circle',
          source: PROPERTY_UNIVERSE_SOURCE_ID,
          filter: ['!', ['has', 'point_count']],
          paint: {
            'circle-radius': PIN_GLASS_RADIUS_EXPR as maplibregl.ExpressionSpecification,
            'circle-color': 'rgba(0,0,0,0)',
            'circle-stroke-color': PIN_RING_STROKE_EXPR as maplibregl.ExpressionSpecification,
            'circle-stroke-width': PIN_RING_WIDTH_EXPR as maplibregl.ExpressionSpecification,
            'circle-stroke-opacity': ['coalesce', ['get', 'ring_opacity'], 0.92] as maplibregl.ExpressionSpecification,
          },
          layout: { visibility: 'none' },
        }, puAnchor)
      }

      if (!map.getLayer(PROPERTY_UNIVERSE_LAYER_IDS.markers)) {
        map.addLayer({
          id: PROPERTY_UNIVERSE_LAYER_IDS.markers,
          type: 'symbol',
          source: PROPERTY_UNIVERSE_SOURCE_ID,
          filter: ['!', ['has', 'point_count']],
          layout: {
            'icon-image': PIN_ICON_IMAGE_EXPR as maplibregl.ExpressionSpecification,
            'icon-size': PIN_ICON_SCALE_EXPR as maplibregl.ExpressionSpecification,
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            visibility: 'none',
          },
          paint: {
            'icon-color': ['coalesce', ['get', 'icon_color'], PIN_ICON_COLOR_EXPR] as unknown as maplibregl.ExpressionSpecification,
            'icon-opacity': [
              'max',
              0.96,
              ['*', puTokens.markerIconOpacity, ['coalesce', ['get', 'base_opacity'], 1]],
            ] as maplibregl.ExpressionSpecification,
            'icon-halo-color': ['coalesce', ['get', 'ring_color'], puPinTokens.ambientAccent] as maplibregl.ExpressionSpecification,
            'icon-halo-width': 1.1,
          },
        }, puAnchor)
      }

      if (!propUnivHandlersRegisteredRef.current) {
        propUnivHandlersRegisteredRef.current = true

        const handlePropertyUniverseClusterClick = (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
          ;(e as { _clickHandled?: boolean })._clickHandled = true
          const feature = e.features?.[0]
          if (!feature?.geometry || feature.geometry.type !== 'Point') return
          const clusterId = feature.properties?.cluster_id as number
          const coords = feature.geometry.coordinates as [number, number]
          const src = map.getSource(PROPERTY_UNIVERSE_SOURCE_ID) as maplibregl.GeoJSONSource
          void src.getClusterExpansionZoom(clusterId).then((zoom) => {
            map.easeTo({ center: coords, zoom: Math.max(zoom, map.getZoom() + 0.8), duration: 700 })
          })
        }

        const handlePropertyUniversePinClick = (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
          ;(e as { _clickHandled?: boolean })._clickHandled = true
          const feature = e.features?.[0]
          if (!feature?.properties) return
          const props = feature.properties as Record<string, unknown>
          const propertyId = text(props.property_id || props.propertyId)
          if (!propertyId) return
          const coordinates = (feature.geometry as Point).coordinates as [number, number]
          hoverPopupRef.current?.remove()
          setSelectedClusterSummary(null)
          setSelectedCensusFeature(null)
          setSelectedBuyerPurchase(null)
          setSelectedSoldComp(null)
          const { anchor, containerSize } = buildMapCardContainerContext(map, containerRef.current, coordinates)
          const masterOwnerId = text(props.master_owner_id || props.owner_id)
          onSelectSellerContextRef.current?.({
            propertyId,
            masterOwnerId: masterOwnerId || undefined,
            sourceView: 'map',
            intent: 'open_seller',
          })
          setHoveredMapCard(null)
          setSelectedMapCard({
            kind: 'seller',
            intent: 'selected',
            id: propertyId,
            anchor,
            coordinates,
            feature: props,
            containerSize,
          })
          if (!map.getBounds().contains(coordinates)) map.easeTo({ center: coordinates, duration: 500 })
        }

        const handlePropertyUniversePinHover = (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
          const feature = e.features?.[0]
          if (!feature?.properties || selectedMapCardRef.current?.kind === 'seller') return
          const props = feature.properties as Record<string, unknown>
          const propertyId = text(props.property_id || props.propertyId)
          if (!propertyId) return
          const coordinates = (feature.geometry as Point).coordinates as [number, number]
          if (clearPinHoverTimerRef.current) {
            clearTimeout(clearPinHoverTimerRef.current)
            clearPinHoverTimerRef.current = null
          }
          const { anchor, containerSize } = buildMapCardContainerContext(map, containerRef.current, coordinates)
          let pixelPoint = { x: anchor.x, y: anchor.y }
          try { pixelPoint = map.project(coordinates) } catch { /* ignore */ }
          map.getCanvas().style.cursor = 'pointer'
          setHoveredMapCard({
            kind: 'seller',
            intent: 'hover',
            id: propertyId,
            anchor: { x: pixelPoint.x, y: pixelPoint.y },
            coordinates,
            feature: props,
            containerSize,
          })
        }

        const clearPropertyUniverseHover = () => {
          if (clearPinHoverTimerRef.current) clearTimeout(clearPinHoverTimerRef.current)
          clearPinHoverTimerRef.current = setTimeout(() => {
            if (selectedMapCardRef.current?.kind === 'seller') return
            setHoveredMapCard(null)
          }, 120)
        }

        map.on('click', PROPERTY_UNIVERSE_LAYER_IDS.clusterCore, handlePropertyUniverseClusterClick)
        map.on('click', PROPERTY_UNIVERSE_LAYER_IDS.clusterRing, handlePropertyUniverseClusterClick)
        const propUnivPinLayers = [
          PROPERTY_UNIVERSE_LAYER_IDS.markerHit,
          PROPERTY_UNIVERSE_LAYER_IDS.markerGlow,
          PROPERTY_UNIVERSE_LAYER_IDS.markerGlass,
          PROPERTY_UNIVERSE_LAYER_IDS.markerRing,
          PROPERTY_UNIVERSE_LAYER_IDS.markers,
        ]
        for (const lid of propUnivPinLayers) {
          map.on('click', lid, handlePropertyUniversePinClick)
        }
        map.on('mouseenter', PROPERTY_UNIVERSE_LAYER_IDS.markerHit, handlePropertyUniversePinHover)
        map.on('mouseleave', PROPERTY_UNIVERSE_LAYER_IDS.markerHit, clearPropertyUniverseHover)
        for (const lid of [PROPERTY_UNIVERSE_LAYER_IDS.clusterCore, ...propUnivPinLayers]) {
          map.on('mouseenter', lid, () => { map.getCanvas().style.cursor = 'pointer' })
          map.on('mouseleave', lid, () => { map.getCanvas().style.cursor = '' })
        }
      }

      if (!propTilesHandlersRegisteredRef.current) {
        propTilesHandlersRegisteredRef.current = true
        const tilePinLayers = [
          PROPERTY_TILES_LAYER_IDS.hit,
          PROPERTY_TILES_LAYER_IDS.glass,
          PROPERTY_TILES_LAYER_IDS.ring,
          PROPERTY_TILES_LAYER_IDS.icon,
        ]
        const handlePropertyTilePinClick = (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
          ;(e as { _clickHandled?: boolean })._clickHandled = true
          const feature = e.features?.[0]
          if (!feature?.properties) return
          const props = feature.properties as Record<string, unknown>
          const propertyId = text(props.property_id || props.propertyId)
          if (!propertyId) return
          const coordinates = (feature.geometry as Point).coordinates as [number, number]
          hoverPopupRef.current?.remove()
          setSelectedClusterSummary(null)
          setSelectedCensusFeature(null)
          setSelectedBuyerPurchase(null)
          setSelectedSoldComp(null)
          const { anchor, containerSize } = buildMapCardContainerContext(map, containerRef.current, coordinates)
          const sellerPin = sellerPinsByPropertyIdRef.current.get(propertyId)
          const masterOwnerId = text(sellerPin?.master_owner_id || props.master_owner_id || props.owner_id)
          onSelectSellerContextRef.current?.({
            propertyId,
            masterOwnerId: masterOwnerId || undefined,
            sourceView: 'map',
            intent: 'open_seller',
          })
          setHoveredMapCard(null)
          setSelectedMapCard({
            kind: 'seller',
            intent: 'selected',
            id: propertyId,
            anchor,
            coordinates,
            feature: sellerPin ? { ...sellerPin, ...props } : props,
            containerSize,
          })
          if (!map.getBounds().contains(coordinates)) map.easeTo({ center: coordinates, duration: 500 })
        }
        const handlePropertyTilePinHover = (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
          const feature = e.features?.[0]
          if (!feature?.properties || selectedMapCardRef.current?.kind === 'seller') return
          const props = feature.properties as Record<string, unknown>
          const propertyId = text(props.property_id || props.propertyId)
          if (!propertyId) return
          const coordinates = (feature.geometry as Point).coordinates as [number, number]
          if (clearPinHoverTimerRef.current) {
            clearTimeout(clearPinHoverTimerRef.current)
            clearPinHoverTimerRef.current = null
          }
          const sellerPin = sellerPinsByPropertyIdRef.current.get(propertyId)
          const { anchor, containerSize } = buildMapCardContainerContext(map, containerRef.current, coordinates)
          let pixelPoint = { x: anchor.x, y: anchor.y }
          try { pixelPoint = map.project(coordinates) } catch { /* ignore */ }
          map.getCanvas().style.cursor = 'pointer'
          setHoveredMapCard({
            kind: 'seller',
            intent: 'hover',
            id: propertyId,
            anchor: { x: pixelPoint.x, y: pixelPoint.y },
            coordinates,
            feature: sellerPin ? { ...sellerPin, ...props } : props,
            containerSize,
          })
        }

        const clearPropertyTileHover = () => {
          if (clearPinHoverTimerRef.current) clearTimeout(clearPinHoverTimerRef.current)
          clearPinHoverTimerRef.current = setTimeout(() => {
            if (selectedMapCardRef.current?.kind === 'seller') return
            setHoveredMapCard(null)
          }, 120)
        }

        for (const lid of tilePinLayers) {
          map.on('click', lid, handlePropertyTilePinClick)
          map.on('mouseenter', lid, lid === PROPERTY_TILES_LAYER_IDS.hit ? handlePropertyTilePinHover : () => { map.getCanvas().style.cursor = 'pointer' })
          map.on('mouseleave', lid, lid === PROPERTY_TILES_LAYER_IDS.hit ? clearPropertyTileHover : () => { map.getCanvas().style.cursor = '' })
        }
      }

      if (!map.getSource(SELECTED_STAR_SOURCE_ID)) {
        map.addSource(SELECTED_STAR_SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      }
      if (!map.getLayer(SELECTED_STAR_LAYER_ID)) {
        map.addLayer({
          id: SELECTED_STAR_LAYER_ID,
          type: 'symbol',
          source: SELECTED_STAR_SOURCE_ID,
          layout: { visibility: 'none', 'icon-image': PIN_ICON.selected, 'icon-size': 0 },
          paint: { 'icon-opacity': 0 },
        })
      }

      syncLayerVisibility(map, activityModeRef.current)
    }

    const installPropertyTileStack = (targetMap: maplibregl.Map) => {
      const tileAnchor = targetMap.getLayer('command-pin-cluster-glow') ? 'command-pin-cluster-glow' : undefined
      try {
        ensurePropertyTileSourceAndLayers(targetMap, activeThemeRef.current.id, tileAnchor)
      } catch (err) {
        console.warn('[CommandMap] property tile source/layers failed to install', err)
      }
    }

    const applyCommandMapTheme = (map: maplibregl.Map, nextThemeId: MapStyleMode) => {
      const theme = getCommandMapTheme(nextThemeId)
      const nextBaseStyleId = getCommandMapBaseStyleId(nextThemeId)
      const mode = isCommandMapBasemapTheme(nextThemeId) || theme.id === 'light_street' ? 'basemap' : 'overlay'
      const shouldSwapBaseStyle = nextBaseStyleId !== activeBaseStyleIdRef.current

      activeThemeRef.current = theme
      mapStyleModeRef.current = nextThemeId

      if (!shouldSwapBaseStyle) {
        if (map.isStyleLoaded()) {
          void syncBasemapPresentation(map)
        } else {
          const applyOnce = () => {
            map.off('styledata', applyOnce)
            void syncBasemapPresentation(map)
          }
          map.on('styledata', applyOnce)
        }
        scheduleMapResize(true)
        setBaseStyleLoading(false)
        setStyleFallbackWarning(null)
        if (import.meta.env.DEV) {
          console.log('[CommandMapTheme]', {
            theme: nextThemeId,
            mode,
            setStyleCalled: false,
            styleUrl: theme.mapStyleUrl ?? null,
            loadMs: 0,
            reattachCount: customAttachmentCount(map),
            fallbackUsed: false,
          })
        }
        return
      }

      const requestSeq = ++styleLoadSeqRef.current
      activeBaseStyleIdRef.current = nextBaseStyleId
      setBaseStyleLoading(true)
      setStyleFallbackWarning(null)
      styleLoadStartedAtRef.current = performance.now()
      if (styleLoadTimerRef.current) clearTimeout(styleLoadTimerRef.current)
      styleLoadTimerRef.current = setTimeout(() => {
        if (requestSeq !== styleLoadSeqRef.current || styleFallbackGuardRef.current) return
        styleFallbackGuardRef.current = true
        const fallbackTheme = getCommandMapTheme(theme.fallbackThemeId)
        setStyleFallbackWarning(`${theme.label} failed to load cleanly. Falling back to ${fallbackTheme.label}.`)
        activeBaseStyleIdRef.current = getCommandMapBaseStyleId(fallbackTheme.id)
        setMapStyleMode(fallbackTheme.id)
      }, 6500)
      map.setStyle(resolveStyle(nextThemeId))
      map.once('style.load', () => {
        if (requestSeq !== styleLoadSeqRef.current) return
        propUnivHandlersRegisteredRef.current = false
        propTilesHandlersRegisteredRef.current = false
        try { addMapLayers(map) } catch { /* getSource/getLayer guards handle duplicates */ }
        installPropertyTileStack(map)
        void syncBasemapPresentation(map)
        syncLayerVisibility(map, activityModeRef.current)
        scheduleMapResize(true)
        if (styleLoadTimerRef.current) {
          clearTimeout(styleLoadTimerRef.current)
          styleLoadTimerRef.current = null
        }
        styleFallbackGuardRef.current = false
        setBaseStyleLoading(false)
        setStyleFallbackWarning(null)
        activeBaseStyleIdRef.current = getCommandMapBaseStyleId(mapStyleModeRef.current)
        if (import.meta.env.DEV) {
          const styleLoadMs = styleLoadStartedAtRef.current
            ? Math.round(performance.now() - styleLoadStartedAtRef.current)
            : null
          console.log('[CommandMapTheme]', {
            theme: mapStyleModeRef.current,
            mode,
            setStyleCalled: true,
            styleUrl: theme.mapStyleUrl ?? null,
            loadMs: styleLoadMs,
            reattachCount: customAttachmentCount(map),
            fallbackUsed: false,
          })
        }
      })
      if (import.meta.env.DEV) {
        console.log('[CommandMapTheme]', {
          theme: nextThemeId,
          mode,
          setStyleCalled: true,
          styleUrl: theme.mapStyleUrl ?? null,
          loadMs: null,
          reattachCount: 0,
          fallbackUsed: false,
        })
      }
    }
    applyCommandMapThemeRef.current = applyCommandMapTheme

    let initCancelled = false
    let map: maplibregl.Map | null = null
    let canvas: HTMLCanvasElement | null = null
    let handleContextLost: ((event: Event) => void) | null = null
    let handleContextRestored: (() => void) | null = null

    const bootMap = async () => {
      const containerEl = containerRef.current
      if (!containerEl || initCancelled) return

      await waitForMapContainerReady(containerEl, () => initCancelled)
      if (initCancelled || mapRef.current) return

      const center: [number, number] = selectedPin ? [selectedPin.lng, selectedPin.lat] : [-96, 37.8]
      setBaseStyleLoading(true)
      styleLoadStartedAtRef.current = performance.now()

      const webglProbe = probeWebGLAvailability()
      if (!webglProbe.ok) {
        console.error('[CommandMap] WebGL preflight failed', webglProbe)
        mapContextLostRef.current = true
        setMapWebglBlocked(webglProbe.blocked)
        setMapInitError(webglProbe.reason)
        setMapContextLost(true)
        setBaseStyleLoading(false)
        if (styleLoadTimerRef.current) {
          clearTimeout(styleLoadTimerRef.current)
          styleLoadTimerRef.current = null
        }
        return
      }

      try {
        map = new maplibregl.Map({
          container: containerEl,
          style: resolveStyle(mapStyleModeRef.current),
          center,
          zoom: zoomedIn ? 10.5 : 4.4,
          minZoom: 2,
          maxZoom: 18,
          attributionControl: false,
          dragRotate: false,
          pitchWithRotate: false,
          transformRequest: buildPropertyTileTransformRequest(),
          canvasContextAttributes: {
            antialias: false,
            preserveDrawingBuffer: false,
            powerPreference: 'default',
            failIfMajorPerformanceCaveat: false,
            desynchronized: false,
          },
        })
      } catch (error) {
        const parsed = parseMapWebGLError(error)
        console.error('[CommandMap] WebGL initialization failed', error)
        mapContextLostRef.current = true
        setMapWebglBlocked(parsed.blocked)
        setMapInitError(webglBlockedUserMessage(parsed))
        setMapContextLost(true)
        setBaseStyleLoading(false)
        if (styleLoadTimerRef.current) {
          clearTimeout(styleLoadTimerRef.current)
          styleLoadTimerRef.current = null
        }
        return
      }

      if (!map || initCancelled) return

      const mapInstance = map
      mapRef.current = mapInstance
    if (import.meta.env.DEV || isMapVerificationMode() || isMapDiagnosticsDebugEnabled()) {
      ;(window as unknown as { __nexusCommandMap?: maplibregl.Map }).__nexusCommandMap = mapInstance
    }
    mapContextLostRef.current = false
    setMapInitError(null)
    setMapWebglBlocked(false)
    activeBaseStyleIdRef.current = getCommandMapBaseStyleId(mapStyleModeRef.current)
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right')

    mapInstance.on('error', (event) => {
      const err = (event as { error?: Error & { type?: string; statusMessage?: string } }).error
      if (!err) return
      const parsed = parseMapWebGLError(err)
      const type = err.type ?? ''
      if (type === 'webglcontextcreationerror' || parsed.message === 'Failed to initialize WebGL' || parsed.blocked) {
        console.error('[CommandMap] Map runtime WebGL error', err)
        mapContextLostRef.current = true
        setMapWebglBlocked(parsed.blocked)
        setMapInitError(webglBlockedUserMessage(parsed))
        setMapContextLost(true)
        setBaseStyleLoading(false)
      }
    })

    canvas = mapInstance.getCanvas?.() ?? null
    handleContextLost = (event: Event) => {
      console.warn('[CommandMap] WebGL context lost')
      event.preventDefault()
      if (mapContextLossOverlayTimerRef.current) clearTimeout(mapContextLossOverlayTimerRef.current)
      mapContextLossOverlayTimerRef.current = setTimeout(() => {
        mapContextLossOverlayTimerRef.current = null
        if (!mapRef.current) return
        try {
          const canvas = mapRef.current.getCanvas()
          const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
          if (gl && !gl.isContextLost()) return
        } catch { /* fall through to overlay */ }
        mapContextLostRef.current = true
        setMapInitError('Map renderer lost its graphics context')
        setMapContextLost(true)
      }, 800)
    }
    handleContextRestored = () => {
      console.info('[CommandMap] WebGL context restored')
      if (mapContextLossOverlayTimerRef.current) {
        clearTimeout(mapContextLossOverlayTimerRef.current)
        mapContextLossOverlayTimerRef.current = null
      }
      mapContextLostRef.current = false
      setMapInitError(null)
      setMapWebglBlocked(false)
      setMapContextLost(false)
      requestAnimationFrame(() => {
        try {
          mapRef.current?.resize()
        } catch { /* ignore */ }
      })
    }
    if (handleContextLost) canvas?.addEventListener('webglcontextlost', handleContextLost, false)
    if (handleContextRestored) canvas?.addEventListener('webglcontextrestored', handleContextRestored, false)
    if (styleLoadTimerRef.current) clearTimeout(styleLoadTimerRef.current)
    styleLoadTimerRef.current = setTimeout(() => {
      if (styleFallbackGuardRef.current) return
      styleFallbackGuardRef.current = true
      const fallbackTheme = getCommandMapTheme(activeThemeRef.current.fallbackThemeId)
      setStyleFallbackWarning(`${activeThemeRef.current.label} failed to load cleanly. Falling back to ${fallbackTheme.label}.`)
      setMapStyleMode(fallbackTheme.id)
    }, 6500)

    const handleStyleReady = () => {
      propUnivHandlersRegisteredRef.current = false
      propTilesHandlersRegisteredRef.current = false
      try {
        addMapLayers(mapInstance)
      } catch (err) {
        console.warn('[CommandMap] addMapLayers error during style.load — layers may be partially missing', err)
      }
      installPropertyTileStack(mapInstance)
      applySellerPinFieldPresentation(mapInstance, {
        sellerPinsEnabled: sellerPinLayersRef.current.sellerPins,
        viewportZoom: mapInstance.getZoom(),
        geojson: sellerPinsGeojsonRef.current,
      })
      void syncBasemapPresentation(mapInstance)
      scheduleMapResize(true)
      const styleLoadMs = styleLoadStartedAtRef.current ? Math.round(performance.now() - styleLoadStartedAtRef.current) : null
      const reattachCount = customAttachmentCount(mapInstance)
      if (styleLoadTimerRef.current) {
        clearTimeout(styleLoadTimerRef.current)
        styleLoadTimerRef.current = null
      }
      styleFallbackGuardRef.current = false
      setBaseStyleLoading(false)
      setStyleFallbackWarning(null)
      activeBaseStyleIdRef.current = getCommandMapBaseStyleId(mapStyleModeRef.current)
      if (import.meta.env.DEV) {
        console.log('[CommandMapTheme]', {
          theme: mapStyleModeRef.current,
          mode: isCommandMapBasemapTheme(mapStyleModeRef.current) || mapStyleModeRef.current === 'light_street' ? 'basemap' : 'overlay',
          setStyleCalled: true,
          styleUrl: getCommandMapTheme(mapStyleModeRef.current).mapStyleUrl ?? null,
          loadMs: styleLoadMs ?? 0,
          reattachCount,
          fallbackUsed: false,
        })
        console.log('[CommandMapPerf]', {
          theme: mapStyleModeRef.current,
          zoom: Number(mapInstance.getZoom().toFixed(2)),
          boundsKey: 'style-load',
          rpcMs: null,
          pinsReturned: sellerPinsRaw.length,
          pinsRendered: sellerPins.length,
          cacheHit: false,
          styleLoadMs,
          sourceReattached: reattachCount > 0,
        })
      }
    }

    mapInstance.on('styleimagemissing', (event) => {
      if (Object.values(PIN_ICON).includes(event.id as (typeof PIN_ICON)[keyof typeof PIN_ICON])) {
        loadPropertyIcons(mapInstance)
      }
    })

    mapInstance.on('load', () => {
      handleStyleReady()

      const handlePinClick = (event: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        ;(event as any)._clickHandled = true
        const feature = event.features?.[0]
        if (!feature) return
        const id = String(feature.properties?.conversation_id || '')
        if (!id) return
        hoverPopupRef.current?.remove()
        setSelectedClusterSummary(null)
        setSelectedCensusFeature(null)
        setSelectedBuyerPurchase(null)
        setSelectedPinId(id)
        onSelectThreadIdRef.current?.(id)
        const props = feature.properties as unknown as CommandMapPin
        const hydratedThread = hydratedThreadsByIdRef.current.get(id)
          || hydratedThreadsByKeyRef.current.get(id)
          || null
        const sellerRecord = commandMapPinToSellerCardRecord(props, hydratedThread as Record<string, unknown> | null)
        const coordinates = (feature.geometry as Point).coordinates as [number, number]
        const { anchor, containerSize } = buildMapCardContainerContext(mapInstance, containerRef.current, coordinates)
        const mobile = isMobileRef.current
        const existingSeller = selectedMapCardRef.current?.kind === 'seller'
          ? selectedMapCardRef.current
          : hoveredMapCardRef.current?.kind === 'seller'
            ? hoveredMapCardRef.current
            : null

        if (mobile) {
          if (existingSeller?.id === id && existingSeller.intent === 'hover') {
            setSelectedMapCard({ ...existingSeller, intent: 'selected', anchor, containerSize, coordinates })
            setHoveredMapCard(null)
          } else {
            setSelectedMapCard(null)
            setHoveredMapCard({
              kind: 'seller',
              intent: 'hover',
              id,
              anchor,
              coordinates,
              feature: sellerRecord,
              containerSize,
            })
          }
        } else {
          setHoveredMapCard(null)
          setSelectedMapCard({
            kind: 'seller',
            intent: 'selected',
            id,
            anchor,
            coordinates,
            feature: sellerRecord,
            containerSize,
          })
        }

        const bounds = mapInstance.getBounds()
        if (!bounds.contains(coordinates)) {
          mapInstance.easeTo({ center: coordinates, duration: 500 })
        }
      }

      const handleClusterClick = (event: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        ;(event as any)._clickHandled = true
        const feature = event.features?.[0]
        if (!feature) return
        const clusterId = Number(feature.properties?.cluster_id)
        const coordinates = (feature.geometry as Point).coordinates as [number, number]
        setSelectedBuyerPurchase(null)
        setSelectedClusterSummary(null)
        if (Number.isFinite(clusterId)) {
          buildClusterSummaryFromLeaves(clusterId, coordinates, 'selected')
        }
        const source = safeGetSource(map, CLUSTER_SOURCE_ID) as (maplibregl.GeoJSONSource & {
          getClusterExpansionZoom?: (id: number, cb: (error: Error | null, zoom: number) => void) => void
        }) | null
        if (!source?.getClusterExpansionZoom || !Number.isFinite(clusterId)) return
        source.getClusterExpansionZoom(clusterId, (error, zoom) => {
          if (error) return
          mapInstance.easeTo({
            center: coordinates,
            zoom,
            duration: 500,
          })
        })
      }

      const showSellerHoverCard = (
        record: Record<string, unknown>,
        coordinates: [number, number],
        cardId: string,
      ) => {
        if (mapContextLostRef.current || !isStyleSafe(map)) return
        if (selectedMapCardRef.current?.kind === 'seller') return

        const existingHover = hoveredMapCardRef.current
        if (
          existingHover?.kind === 'seller'
          && existingHover.intent === 'hover'
          && existingHover.id === cardId
        ) {
          cancelClearPinHover()
          return
        }

        cancelClearPinHover()
        setHoveredClusterSummary(null)
        hoverPopupRef.current?.remove()
        hoverPopupRef.current = null

        const propertyId = text(record.property_id || record.propertyId)
        const cachedPin = propertyId ? sellerPinDetailsCacheRef.current.get(propertyId) : null
        const mergedRecord = cachedPin
          ? sanitizeSellerPinRecord({ ...record, ...cachedPin } as Partial<CommandMapSellerPin>)
          : sanitizeSellerPinRecord(record as Partial<CommandMapSellerPin>)

        let pixelPoint = { x: 0, y: 0 }
        try {
          pixelPoint = mapInstance.project(coordinates)
        } catch {
          return
        }
        const containerEl = containerRef.current
        const containerBounds = containerEl?.getBoundingClientRect()
        const containerWidth = containerBounds?.width ?? window.innerWidth
        const containerHeight = containerBounds?.height ?? window.innerHeight
        mapInstance.getCanvas().style.cursor = 'pointer'
        setHoveredMapCard({
          kind: 'seller',
          intent: 'hover',
          id: cardId,
          anchor: { x: pixelPoint.x, y: pixelPoint.y },
          coordinates,
          feature: mergedRecord as Record<string, unknown>,
          containerSize: { width: containerWidth, height: containerHeight },
        })
      }

      const handlePinHover = (event: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        const feature = event.features?.[0]
        if (!feature?.properties) return
        const props = feature.properties as unknown as CommandMapPin
        const hydratedThread = hydratedThreadsByIdRef.current.get(props.conversation_id)
          || hydratedThreadsByKeyRef.current.get(props.conversation_id)
          || null
        const sellerRecord = commandMapPinToSellerCardRecord(props, hydratedThread as Record<string, unknown> | null)
        const coordinates = (feature.geometry as Point).coordinates as [number, number]
        showSellerHoverCard(
          sellerRecord,
          coordinates,
          String(props.property_id || props.conversation_id || coordinates.join(',')),
        )
      }

      const clearPinHover = () => {
        // Hover-intent delay: when moving between pin sub-layers (core → ring → glow),
        // MapLibre fires mouseleave then mouseenter rapidly. The 120ms delay prevents
        // the hover popup from flickering by giving the next mouseenter time to cancel.
        sellerClusterHoverSeq += 1
        if (clearPinHoverTimerRef.current) clearTimeout(clearPinHoverTimerRef.current)
        clearPinHoverTimerRef.current = setTimeout(() => {
          clearPinHoverTimerRef.current = null
          hoverPopupRef.current?.remove()
          hoverPopupRef.current = null
          setHoveredClusterSummary(null)
          setHoveredMapCard(null)
        }, 120)
      }

      const cancelClearPinHover = () => {
        if (clearPinHoverTimerRef.current) {
          clearTimeout(clearPinHoverTimerRef.current)
          clearPinHoverTimerRef.current = null
        }
      }

      const handleSellerPinHover = (event: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        const feature = event.features?.[0]
        if (!feature?.properties) return
        const props = feature.properties as unknown as Partial<CommandMapSellerPin>
        const coordinates = (feature.geometry as Point).coordinates as [number, number]
        if (DEBUG_MAP_CARDS) console.debug('[MapCard] seller hover', { id: props.property_id, feature: props })
        showSellerHoverCard(
          props as Record<string, unknown>,
          coordinates,
          String(props.property_id || coordinates.join(',')),
        )
      }

      let sellerClusterHoverSeq = 0
      const handleSellerPinClusterHover = (event: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        const feature = event.features?.[0]
        if (!feature?.properties) return
        const clusterId = Number(feature.properties?.cluster_id)
        if (!Number.isFinite(clusterId)) return
        const coordinates = (feature.geometry as Point).coordinates as [number, number]
        const hoverSeq = ++sellerClusterHoverSeq
        const source = safeGetSource(map, SELLER_PINS_SOURCE_ID) as (maplibregl.GeoJSONSource & {
          getClusterLeaves?: (
            clusterId: number,
            limit: number,
            offset: number,
            callback: (error: Error | null, features: maplibregl.MapGeoJSONFeature[]) => void,
          ) => void
        }) | null
        if (!source?.getClusterLeaves) return
        source.getClusterLeaves(clusterId, 24, 0, (error, leaves) => {
          if (hoverSeq !== sellerClusterHoverSeq) return
          if (error || !leaves?.length) return
          const bestLeaf = leaves
            .map((leaf) => leaf.properties as Record<string, unknown>)
            .sort((left, right) => (
              Number(right.render_priority ?? 0) - Number(left.render_priority ?? 0)
              || Number(right.priority_score ?? 0) - Number(left.priority_score ?? 0)
            ))[0]
          if (!bestLeaf) return
          showSellerHoverCard(
            bestLeaf,
            coordinates,
            `seller-cluster-${clusterId}-${String(bestLeaf.property_id ?? '')}`,
          )
        })
      }

      const handleSellerPinClusterClick = (event: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        ;(event as any)._clickHandled = true
        const feature = event.features?.[0]
        if (!feature) return
        const clusterId = feature.properties?.cluster_id
        const coordinates = (feature.geometry as Point).coordinates as [number, number]
        const source = safeGetSource(map, SELLER_PINS_SOURCE_ID) as (maplibregl.GeoJSONSource & {
          getClusterExpansionZoom?: (id: number, cb: (error: Error | null, zoom: number) => void) => void
        }) | null
        if (!source?.getClusterExpansionZoom || clusterId === undefined) return
        source.getClusterExpansionZoom(clusterId, (error, zoom) => {
          if (error) return
          mapInstance.easeTo({ center: coordinates, zoom: Math.max(zoom, mapInstance.getZoom() + 1), duration: 500 })
        })
      }

      const handleSellerPinClick = (event: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        ;(event as any)._clickHandled = true
        const feature = event.features?.[0]
        if (!feature?.properties) return
        const props = sanitizeSellerPinRecord(feature.properties as unknown as Partial<CommandMapSellerPin>)
        const propertyId = String(props.property_id || '')
        if (!propertyId) return
        hoverPopupRef.current?.remove()
        hoverPopupRef.current = null
        setSelectedClusterSummary(null)
        setSelectedCensusFeature(null)
        setSelectedBuyerPurchase(null)
        setSelectedSoldComp(null)
        const coordinates = (feature.geometry as Point).coordinates as [number, number]
        const { anchor, containerSize } = buildMapCardContainerContext(mapInstance, containerRef.current, coordinates)

        const matchedThread = hydratedThreadsByPropertyIdRef.current.get(propertyId)
          || visibleHydratedThreadsRef.current.find((thread) => text((thread as any).propertyId || (thread as any).property_id) === propertyId)
          || hydratedThreadsByIdRef.current.get(propertyId)
          || hydratedThreadsByKeyRef.current.get(propertyId)

        const masterOwnerId = text((props as any).master_owner_id || (props as any).owner_id || (props as any).seller_id || (props as any).prospect_id)
        onSelectSellerContextRef.current?.({
          propertyId,
          masterOwnerId: masterOwnerId || undefined,
          sourceView: 'map',
          intent: 'open_seller',
        })

        const cardId = matchedThread ? matchedThread.id : propertyId
        const mergedFeature = matchedThread
          ? { ...props, ...matchedThread as unknown as Record<string, unknown> }
          : props as Record<string, unknown>

        if (matchedThread) {
          setSelectedPinId(matchedThread.id)
          onSelectThreadIdRef.current?.(matchedThread.id)
        } else {
          setSelectedPinId(propertyId)
        }

        const mobile = isMobileRef.current
        const existingSeller = selectedMapCardRef.current?.kind === 'seller'
          ? selectedMapCardRef.current
          : hoveredMapCardRef.current?.kind === 'seller'
            ? hoveredMapCardRef.current
            : null

        const nextCard: MapCardState = {
          kind: 'seller',
          intent: 'selected',
          id: cardId,
          anchor,
          coordinates,
          feature: mergedFeature,
          containerSize,
        }

        if (mobile) {
          if (existingSeller?.id === cardId && existingSeller.intent === 'hover') {
            setSelectedMapCard({ ...existingSeller, ...nextCard, intent: 'selected' })
            setHoveredMapCard(null)
          } else if (existingSeller?.id === cardId && existingSeller.intent === 'selected') {
            return
          } else {
            setSelectedMapCard(null)
            setHoveredMapCard({ ...nextCard, intent: 'hover' })
          }
        } else {
          setHoveredMapCard(null)
          setSelectedMapCard(nextCard)
        }

        const bounds = mapInstance.getBounds()
        if (!bounds.contains(coordinates)) {
          mapInstance.easeTo({ center: coordinates, duration: 500 })
        }
      }


      const handleClusterHover = (event: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        const feature = event.features?.[0]
        if (!feature) return
        const clusterId = Number(feature.properties?.cluster_id)
        const coordinates = (feature.geometry as Point).coordinates as [number, number]
        if (!Number.isFinite(clusterId)) return
        buildClusterSummaryFromLeaves(clusterId, coordinates, 'hover')
      }

      const clearClusterHover = () => {
        setHoveredClusterSummary(null)
      }

      const handleBuyerHover = (event: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        cancelClearPinHover()
        setHoveredClusterSummary(null)
        const feature = event.features?.[0]
        const props = feature?.properties as BuyerFeatureProps | undefined
        if (!feature || !props) return
        const coordinates = (feature.geometry as Point).coordinates as [number, number]
        const popup = hoverPopupRef.current ?? new maplibregl.Popup({
          closeButton: false,
          closeOnClick: false,
          offset: 18,
          className: 'nx-icm-hover-popup',
          maxWidth: '360px',
        })
        popup
          .setLngLat(coordinates)
          .setHTML(buildBuyerHoverMarkup(props, mapStyleModeRef.current))
          .addTo(mapInstance)
        hoverPopupRef.current = popup
      }

      const handleBuyerClick = (event: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        ;(event as any)._clickHandled = true
        const feature = event.features?.[0]
        const props = feature?.properties as BuyerFeatureProps | undefined
        if (!feature || !props) return
        cancelClearPinHover()
        hoverPopupRef.current?.remove()
        hoverPopupRef.current = null
        setSelectedClusterSummary(null)
        setSelectedCensusFeature(null)
        const exactPurchase = buyerPurchasesRef.current.find((purchase) =>
          purchase.buyerKey === props.buyerKey && purchase.propertyAddressFull === props.propertyAddressFull,
        ) || buyerPurchasesRef.current.find((purchase) => purchase.buyerKey === props.buyerKey) || null
        setSelectedBuyerPurchase(exactPurchase)
        onSelectBuyerKeyRef.current?.(props.buyerKey || null)
        const coordinates = (feature.geometry as Point).coordinates as [number, number]
        mapInstance.easeTo({ center: coordinates, zoom: Math.max(mapInstance.getZoom(), 11.8), duration: 560 })
      }

      const handleSoldCompHover = (event: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        if (mapContextLostRef.current || !isStyleSafe(map)) return
        if (selectedMapCardRef.current?.kind === 'sold_comp') return
        const feature = event.features?.[0]
        const props = feature?.properties as RecentSoldComp | undefined
        if (!feature || !props) return
        const coordinates = (feature.geometry as Point).coordinates as [number, number]
        const cardId = String(props.property_id || coordinates.join(','))
        const existingHover = hoveredMapCardRef.current
        if (
          existingHover?.kind === 'sold_comp'
          && existingHover.intent === 'hover'
          && existingHover.id === cardId
        ) {
          cancelClearPinHover()
          return
        }
        cancelClearPinHover()
        let pixelPoint = { x: 0, y: 0 }
        try {
          pixelPoint = mapInstance.project(coordinates)
        } catch {
          return
        }
        const containerEl = containerRef.current
        const containerBounds = containerEl?.getBoundingClientRect()
        const containerWidth = containerBounds?.width ?? window.innerWidth
        const containerHeight = containerBounds?.height ?? window.innerHeight
        hoverPopupRef.current?.remove()
        hoverPopupRef.current = null
        mapInstance.getCanvas().style.cursor = 'pointer'
        if (DEBUG_MAP_CARDS) console.debug('[MapCard] comp hover', { id: props.property_id, feature: props })

        const rawComp = soldComps.find((item) => String(item.property_id) === String(props.property_id)) || props

        setHoveredMapCard({
          kind: 'sold_comp',
          intent: 'hover',
          id: cardId,
          anchor: { x: pixelPoint.x, y: pixelPoint.y },
          coordinates,
          feature: rawComp as unknown as Record<string, unknown>,
          containerSize: { width: containerWidth, height: containerHeight },
        })
      }

      const handleSoldCompClick = (event: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        ;(event as any)._clickHandled = true
        const feature = event.features?.[0]
        const props = feature?.properties as RecentSoldComp | undefined
        if (!feature || !props) return
        cancelClearPinHover()
        hoverPopupRef.current?.remove()
        hoverPopupRef.current = null
        setHoveredMapCard(null)
        setSelectedClusterSummary(null)
        setSelectedCensusFeature(null)
        setSelectedBuyerPurchase(null)
        const coordinates = (feature.geometry as Point).coordinates as [number, number]
        const pixelPoint = mapInstance.project(coordinates)
        const containerEl = containerRef.current
        const containerBounds = containerEl?.getBoundingClientRect()
        const containerWidth = containerBounds?.width ?? window.innerWidth
        const containerHeight = containerBounds?.height ?? window.innerHeight
        if (DEBUG_MAP_CARDS) console.debug('[MapCard] comp click selected', { id: props.property_id, feature: props })
        
        const rawComp = soldComps.find((item) => String(item.property_id) === String(props.property_id)) || props

        setSelectedMapCard({
          kind: 'sold_comp',
          intent: 'selected',
          id: String(props.property_id || coordinates.join(',')),
          anchor: { x: pixelPoint.x, y: pixelPoint.y },
          coordinates,
          feature: rawComp as unknown as Record<string, unknown>,
          containerSize: { width: containerWidth, height: containerHeight },
        })
        mapInstance.easeTo({ center: coordinates, zoom: Math.max(mapInstance.getZoom(), 11.8), duration: 560 })
      }

      const handleBuyerClusterClick = (event: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        ;(event as any)._clickHandled = true
        const feature = event.features?.[0]
        if (!feature) return
        const clusterId = Number(feature.properties?.cluster_id)
        const source = safeGetSource(map, BUYER_PURCHASE_SOURCE_ID) as (maplibregl.GeoJSONSource & {
          getClusterExpansionZoom?: (id: number, cb: (error: Error | null, zoom: number) => void) => void
        }) | null
        if (!source?.getClusterExpansionZoom || !Number.isFinite(clusterId)) return
        source.getClusterExpansionZoom(clusterId, (error, zoom) => {
          if (error) return
          mapInstance.easeTo({
            center: (feature.geometry as Point).coordinates as [number, number],
            zoom,
            duration: 500,
          })
        })
      }

      const renderCensusTooltip = (feature: CensusOverlayFeature, metricLabel: string, displayValue: string) => `
        <article class="nx-icm-hover" style="${cardThemeStyleAttr(mapStyleModeRef.current)}">
          <div class="nx-icm-hover__body">
            <div class="nx-icm-hover__head">
              <div>
                <p class="nx-icm-hover__eyebrow">${feature.geography_type}</p>
                <h4>${escapeHtml(feature.name)}</h4>
              </div>
              <span class="nx-icm-hover__status nx-icm-hover__status--accent">${escapeHtml(displayValue)}</span>
            </div>
            <p class="nx-icm-hover__address">${escapeHtml(metricLabel)}</p>
            <div class="nx-icm-hover__stats">
              <div class="nx-icm-hover__metric"><div class="nx-icm-hover__metric-copy"><span>Income</span><strong>${escapeHtml(formatCompactCurrency(feature.metric_values.median_household_income ?? null))}</strong></div></div>
              <div class="nx-icm-hover__metric"><div class="nx-icm-hover__metric-copy"><span>Vacancy</span><strong>${escapeHtml(formatPercent(feature.metric_values.vacancy_rate ?? NaN))}</strong></div></div>
              <div class="nx-icm-hover__metric"><div class="nx-icm-hover__metric-copy"><span>Renter%</span><strong>${escapeHtml(formatPercent(feature.metric_values.renter_occupied_percent ?? NaN))}</strong></div></div>
              <div class="nx-icm-hover__metric"><div class="nx-icm-hover__metric-copy"><span>Opp Score</span><strong>${escapeHtml(String(feature.metric_values.investor_opportunity_score ?? '—'))}</strong></div></div>
            </div>
            <div class="nx-icm-hover__message"><p>${escapeHtml(feature.summary)}</p></div>
          </div>
        </article>
      `

      const handleCensusHover = (event: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        if (!activeCensusMetricRef.current) return
        const hovered = event.features?.[0]
        const featureId = String(hovered?.properties?.id || '')
        const overlayFeature = censusOverlayFeaturesRef.current.find((item) => item.id === featureId)
        if (!overlayFeature) return
        setHoveredCensusFeature({ feature: overlayFeature, mode: 'hover' })
        const popup = hoverPopupRef.current ?? new maplibregl.Popup({
          closeButton: false,
          closeOnClick: false,
          offset: 18,
          className: 'nx-icm-hover-popup',
          maxWidth: '360px',
        })
        popup
          .setLngLat(event.lngLat)
          .setHTML(renderCensusTooltip(overlayFeature, String(hovered?.properties?.metric || activeCensusMetricRef.current), String(hovered?.properties?.displayValue || '—')))
          .addTo(mapInstance)
        hoverPopupRef.current = popup
      }

      const clearCensusHover = () => {
        hoverPopupRef.current?.remove()
        setHoveredCensusFeature(null)
      }

      const handleCensusClick = (event: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        ;(event as any)._clickHandled = true
        if (!activeCensusMetricRef.current) return
        const clicked = event.features?.[0]
        const featureId = String(clicked?.properties?.id || '')
        const overlayFeature = censusOverlayFeaturesRef.current.find((item) => item.id === featureId)
        if (!overlayFeature) return
        setSelectedCensusFeature({ feature: overlayFeature, mode: 'selected' })
      }

      const handleSoldCompClusterClick = (event: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        ;(event as any)._clickHandled = true
        const feature = event.features?.[0]
        if (!feature) return
        const clusterId = Number(feature.properties?.cluster_id)
        const source = safeGetSource(map, SOLD_COMPS_SOURCE_ID) as (maplibregl.GeoJSONSource & {
          getClusterExpansionZoom?: (id: number, cb: (error: Error | null, zoom: number) => void) => void
        }) | null
        if (!source?.getClusterExpansionZoom || !Number.isFinite(clusterId)) return
        source.getClusterExpansionZoom(clusterId, (error, zoom) => {
          if (error) return
          const coordinates = (feature.geometry as Point).coordinates as [number, number]
          mapInstance.easeTo({ center: coordinates, zoom: zoom + 0.5, duration: 420 })
        })
      }

      mapInstance.on('click', 'command-pin-core-raw', handlePinClick)
      mapInstance.on('click', 'command-pin-core-clustered', handlePinClick)
      mapInstance.on('click', 'command-pin-icon-raw', handlePinClick)
      mapInstance.on('click', 'command-pin-icon-clustered', handlePinClick)
      mapInstance.on('click', 'command-pin-cluster-core', handleClusterClick)
      mapInstance.on('click', CENSUS_LAYER_IDS.fill, handleCensusClick)
      mapInstance.on('click', 'command-buyer-purchase-core', handleBuyerClick)
      mapInstance.on('click', 'command-buyer-profile-core', handleBuyerClick)
      mapInstance.on('click', 'command-buyer-cluster-core', handleBuyerClusterClick)
      mapInstance.on('click', SOLD_COMPS_LAYER_IDS.hit, handleSoldCompClick)
      mapInstance.on('click', SOLD_COMPS_LAYER_IDS.marker, handleSoldCompClick)
      mapInstance.on('click', SOLD_COMPS_LAYER_IDS.label, handleSoldCompClick)
      mapInstance.on('click', SOLD_COMPS_CLUSTER_LAYER_IDS.core, handleSoldCompClusterClick)
      mapInstance.on('click', SELLER_PINS_LAYER_IDS.hit, handleSellerPinClick)
      mapInstance.on('click', SELLER_PINS_LAYER_IDS.core, handleSellerPinClick)
      mapInstance.on('click', SELLER_PINS_LAYER_IDS.icon, handleSellerPinClick)
      mapInstance.on('click', SELLER_PINS_LAYER_IDS.clusterCore, handleSellerPinClusterClick)
      mapInstance.on('click', (event) => {
        if ((event as any)._clickHandled) return
        if (mapContextLostRef.current || !isStyleSafe(map)) return
        // Use circle/fill layers only for background-click detection — exclude symbol
        // layers (icon, label) which can crash MapLibre's hit detection when the
        // symbol bucket string table is not yet populated.
        const rendered = safeQueryRenderedFeatures(mapInstance, event.point, [
          'command-pin-core-raw', 'command-pin-core-clustered', 'command-pin-cluster-core',
          'command-buyer-purchase-core', 'command-buyer-profile-core', 'command-buyer-cluster-core',
          SOLD_COMPS_LAYER_IDS.hit, SOLD_COMPS_LAYER_IDS.marker, SOLD_COMPS_CLUSTER_LAYER_IDS.core,
          SELLER_PINS_LAYER_IDS.hit, SELLER_PINS_LAYER_IDS.core, SELLER_PINS_LAYER_IDS.clusterCore,
          PROPERTY_UNIVERSE_LAYER_IDS.clusterCore,
          PROPERTY_UNIVERSE_LAYER_IDS.markerGlow,
          PROPERTY_UNIVERSE_LAYER_IDS.markerGlass,
          PROPERTY_UNIVERSE_LAYER_IDS.markerRing,
        ])
        if (rendered.length === 0) {
          setSelectedBuyerPurchase(null)
          setSelectedSoldComp(null)
          setCompCardAnchor(null)
          setSelectedMapCard(null)
          setHoveredMapCard(null)
          setSelectedClusterSummary(null)
          setSelectedCensusFeature(null)
          onBackgroundClickRef.current?.()
        }
      })
      mapInstance.on('mouseenter', 'command-pin-core-raw', handlePinHover)
      mapInstance.on('mouseenter', 'command-pin-core-clustered', handlePinHover)
      // Do NOT register mouseenter on symbol layers (command-pin-icon-*) — see cursor
      // comment above. The circle core layers provide sufficient hover coverage.
      mapInstance.on('mouseenter', 'command-pin-cluster-core', handleClusterHover)
      mapInstance.on('mouseenter', CENSUS_LAYER_IDS.fill, handleCensusHover)
      mapInstance.on('mouseenter', 'command-buyer-purchase-core', handleBuyerHover)
      mapInstance.on('mouseenter', 'command-buyer-profile-core', handleBuyerHover)
      mapInstance.on('mouseenter', SOLD_COMPS_LAYER_IDS.hit, handleSoldCompHover)
      // sold-comps-marker/label are symbol layers — hit layer covers hover without layer churn
      // Single wide hit layer avoids rapid mouseenter/mouseleave churn across ring/glow/pulse.
      mapInstance.on('mouseenter', SELLER_PINS_LAYER_IDS.hit, handleSellerPinHover)
      mapInstance.on('mouseenter', SELLER_PINS_LAYER_IDS.clusterCore, handleSellerPinClusterHover)
      mapInstance.on('mouseleave', 'command-pin-core-raw', clearPinHover)
      mapInstance.on('mouseleave', 'command-pin-core-clustered', clearPinHover)
      mapInstance.on('mouseleave', 'command-pin-cluster-core', clearClusterHover)
      mapInstance.on('mouseleave', CENSUS_LAYER_IDS.fill, clearCensusHover)
      mapInstance.on('mouseleave', 'command-buyer-purchase-core', clearPinHover)
      mapInstance.on('mouseleave', 'command-buyer-profile-core', clearPinHover)
      mapInstance.on('mouseleave', SOLD_COMPS_LAYER_IDS.hit, clearPinHover)
      mapInstance.on('mouseleave', SELLER_PINS_LAYER_IDS.hit, clearPinHover)
      mapInstance.on('mouseleave', SELLER_PINS_LAYER_IDS.clusterCore, clearPinHover)

      const pulseConfig: Record<PinFeatureProps['pulseTier'], { baseRadius: number; maxAdd: number; baseOpacity: number; speed: number }> = {
        fast: { baseRadius: 13, maxAdd: 8, baseOpacity: 0.26, speed: 1.65 },
        medium_fast: { baseRadius: 12, maxAdd: 6.5, baseOpacity: 0.2, speed: 1.2 },
        medium: { baseRadius: 11, maxAdd: 5, baseOpacity: 0.15, speed: 0.85 },
        slow: { baseRadius: 10, maxAdd: 3.5, baseOpacity: 0.1, speed: 0.55 },
        very_slow: { baseRadius: 9, maxAdd: 1.5, baseOpacity: 0, speed: 0 },
        none: { baseRadius: 8, maxAdd: 0, baseOpacity: 0, speed: 0 },
      }

      let frame = 0
      let pulsesSuppressed = false
      const animate = () => {
        const activeMap = mapRef.current
        if (!activeMap) return
        frame = (frame + 1) % 360
        const shouldAnimatePins =
          !reducedMotionRef.current
          && performanceSettingsRef.current?.animation === 'full'
          && geojsonRef.current.features.length <= 180
        if (!shouldAnimatePins) {
          if (!pulsesSuppressed) {
            try {
              ;(['command-pin-pulse-raw', 'command-pin-pulse-clustered'] as const).forEach((layerId) => {
                if (!activeMap.getLayer(layerId)) return
                activeMap.setPaintProperty(layerId, 'circle-opacity', 0)
              })
            } catch {
              // Keep map resilient.
            }
            pulsesSuppressed = true
          }
        } else {
          pulsesSuppressed = false
        }
        const makeRadiusExpr = (tier: PinFeatureProps['pulseTier'], modeValue: PinFeatureProps['pulseMode']) => {
          const cfg = pulseConfig[tier]
          const phase = frame / 60
          const wave =
            modeValue === 'triple'
              ? Math.max(0, Math.sin(phase * 3.2))
              : cfg.speed === 0
                ? 0
                : (Math.sin(phase * cfg.speed) + 1) / 2
          return cfg.baseRadius + wave * cfg.maxAdd
        }
        const makeOpacityExpr = (tier: PinFeatureProps['pulseTier'], modeValue: PinFeatureProps['pulseMode']) => {
          const cfg = pulseConfig[tier]
          const phase = frame / 60
          const wave =
            modeValue === 'triple'
              ? Math.max(0, Math.sin(phase * 3.2))
              : cfg.speed === 0
                ? 0
                : (Math.sin(phase * cfg.speed) + 1) / 2
          return cfg.baseOpacity * (1 - wave * 0.55)
        }
        try {
          if (shouldAnimatePins) {
          ;(['command-pin-pulse-raw', 'command-pin-pulse-clustered'] as const).forEach((layerId) => {
            if (!activeMap.getLayer(layerId)) return
            activeMap.setPaintProperty(layerId, 'circle-radius', [
              'case',
              ['==', ['get', 'pulseMode'], 'none'], 8,
              ['==', ['get', 'pulseMode'], 'ripple'], makeRadiusExpr('medium_fast', 'ripple'),
              ['==', ['get', 'pulseMode'], 'triple'], makeRadiusExpr('fast', 'triple'),
              ['match', ['get', 'pulseTier'],
                'fast', makeRadiusExpr('fast', 'continuous'),
                'medium_fast', makeRadiusExpr('medium_fast', 'continuous'),
                'medium', makeRadiusExpr('medium', 'continuous'),
                'slow', makeRadiusExpr('slow', 'continuous'),
                'very_slow', makeRadiusExpr('very_slow', 'continuous'),
                makeRadiusExpr('none', 'continuous'),
              ],
            ])
            activeMap.setPaintProperty(layerId, 'circle-opacity', [
              '*',
              ['case',
                ['==', ['get', 'pulseMode'], 'none'], 0,
                ['==', ['get', 'pulseMode'], 'ripple'], makeOpacityExpr('medium_fast', 'ripple'),
                ['==', ['get', 'pulseMode'], 'triple'], makeOpacityExpr('fast', 'triple'),
                ['match', ['get', 'pulseTier'],
                  'fast', makeOpacityExpr('fast', 'continuous'),
                  'medium_fast', makeOpacityExpr('medium_fast', 'continuous'),
                  'medium', makeOpacityExpr('medium', 'continuous'),
                  'slow', makeOpacityExpr('slow', 'continuous'),
                  'very_slow', 0,
                  0,
                ],
              ],
              ['get', 'focusOpacity'],
            ])
          })

          if (shouldAnimatePins && activeMap.getLayer(SELLER_PINS_LAYER_IDS.pulse) && sellerPinLayers.sellerPins) {
            activeMap.setPaintProperty(SELLER_PINS_LAYER_IDS.pulse, 'circle-radius', [
              'match', ['coalesce', ['get', 'pulse_style'], 'none'],
              'pulse_strong', makeRadiusExpr('fast', 'continuous'),
              'pulse_soft', makeRadiusExpr('slow', 'continuous'),
              'pulse_warning', makeRadiusExpr('medium_fast', 'ripple'),
              'pulse_rotating', makeRadiusExpr('medium', 'triple'),
              makeRadiusExpr('none', 'continuous')
            ])
            activeMap.setPaintProperty(SELLER_PINS_LAYER_IDS.pulse, 'circle-opacity', [
              'match', ['coalesce', ['get', 'pulse_style'], 'none'],
              'pulse_strong', makeOpacityExpr('fast', 'continuous'),
              'pulse_soft', makeOpacityExpr('slow', 'continuous'),
              'pulse_warning', makeOpacityExpr('medium_fast', 'ripple'),
              'pulse_rotating', makeOpacityExpr('medium', 'triple'),
              0
            ])
          }

          if (shouldAnimatePins && activeMap.getLayer(PROPERTY_TILES_LAYER_IDS.pulse) && sellerPinLayers.sellerPins) {
            const motionRadius = (motion: string) => acquisitionRadarPulseRadius(motion, frame, 11)
            const motionOpacity = (motion: string) => acquisitionRadarPulseOpacity(motion, frame, 0.28)
            activeMap.setPaintProperty(PROPERTY_TILES_LAYER_IDS.pulse, 'circle-radius', [
              'match', ['coalesce', ['feature-state', 'motion'], 'static'],
              'breathing', motionRadius('breathing'),
              'follow_up_pulse', motionRadius('follow_up_pulse'),
              'reply_ripple', motionRadius('reply_ripple'),
              'urgent_pulse', motionRadius('urgent_pulse'),
              'failure_flicker', motionRadius('failure_flicker'),
              0,
            ])
            activeMap.setPaintProperty(PROPERTY_TILES_LAYER_IDS.pulse, 'circle-opacity', [
              '*',
              ['coalesce', ['feature-state', 'base_opacity'], 1],
              ['match', ['coalesce', ['feature-state', 'motion'], 'static'],
                'breathing', motionOpacity('breathing'),
                'follow_up_pulse', motionOpacity('follow_up_pulse'),
                'reply_ripple', motionOpacity('reply_ripple'),
                'urgent_pulse', motionOpacity('urgent_pulse'),
                'failure_flicker', motionOpacity('failure_flicker'),
                0,
              ],
            ])
          }

          if (shouldAnimatePins && activeMap.getLayer(PROPERTY_UNIVERSE_LAYER_IDS.markerPulse) && sellerPinLayers.sellerPins) {
            const motionRadius = (motion: string) => acquisitionRadarPulseRadius(motion, frame, 11)
            const motionOpacity = (motion: string) => acquisitionRadarPulseOpacity(motion, frame, 0.28)
            activeMap.setPaintProperty(PROPERTY_UNIVERSE_LAYER_IDS.markerPulse, 'circle-radius', [
              'match', ['coalesce', ['get', 'motion'], 'static'],
              'breathing', motionRadius('breathing'),
              'follow_up_pulse', motionRadius('follow_up_pulse'),
              'reply_ripple', motionRadius('reply_ripple'),
              'urgent_pulse', motionRadius('urgent_pulse'),
              'failure_flicker', motionRadius('failure_flicker'),
              0,
            ])
            activeMap.setPaintProperty(PROPERTY_UNIVERSE_LAYER_IDS.markerPulse, 'circle-opacity', [
              '*',
              ['coalesce', ['get', 'base_opacity'], 1],
              ['match', ['coalesce', ['get', 'motion'], 'static'],
                'breathing', motionOpacity('breathing'),
                'follow_up_pulse', motionOpacity('follow_up_pulse'),
                'reply_ripple', motionOpacity('reply_ripple'),
                'urgent_pulse', motionOpacity('urgent_pulse'),
                'failure_flicker', motionOpacity('failure_flicker'),
                0,
              ],
            ])
          }
          }

        } catch {
          return
        }
        animationRef.current = requestAnimationFrame(animate)
      }
      animationRef.current = requestAnimationFrame(animate)

      // Only register cursor changes on circle/fill layers — NOT symbol layers.
      // Symbol layer mouseenter triggers MapLibre hit detection on every mousemove
      // which crashes with "Out of bounds" when the symbol bucket string table is
      // not yet populated (race condition during tile loading).
      ;(['command-pin-core-raw', 'command-pin-core-clustered', 'command-pin-cluster-core', 'command-buyer-purchase-core', 'command-buyer-profile-core', 'command-buyer-cluster-core', SOLD_COMPS_LAYER_IDS.hit, SOLD_COMPS_LAYER_IDS.marker, SOLD_COMPS_CLUSTER_LAYER_IDS.core, ...SELLER_PIN_HOVER_LAYER_IDS, PROPERTY_UNIVERSE_LAYER_IDS.clusterCore, PROPERTY_UNIVERSE_LAYER_IDS.clusterRing, PROPERTY_UNIVERSE_LAYER_IDS.markerHit, PROPERTY_UNIVERSE_LAYER_IDS.markerGlass, PROPERTY_UNIVERSE_LAYER_IDS.markerRing] as const).forEach((layerId) => {
        const hoverMap = mapRef.current
        if (!hoverMap?.getLayer(layerId)) return
        hoverMap.on('mouseenter', layerId, () => { hoverMap.getCanvas().style.cursor = 'pointer' })
        hoverMap.on('mouseleave', layerId, () => { hoverMap.getCanvas().style.cursor = '' })
      })
    })

    mapInstance.on('style.load', () => {
      handleStyleReady()
    })

    let sellerPinIdleSyncTimer: ReturnType<typeof setTimeout> | null = null
    mapInstance.on('idle', () => {
      if (!sellerPinLayersRef.current.sellerPins || sellerPinsGeojsonRef.current.features.length === 0) return
      if (sellerPinIdleSyncTimer) clearTimeout(sellerPinIdleSyncTimer)
      sellerPinIdleSyncTimer = setTimeout(() => {
        sellerPinIdleSyncTimer = null
        const liveMap = mapRef.current
        if (!isStyleSafe(liveMap)) return
        applySellerPinFieldPresentation(liveMap, {
          sellerPinsEnabled: sellerPinLayersRef.current.sellerPins,
          viewportZoom: liveMap.getZoom(),
          geojson: sellerPinsGeojsonRef.current,
        })
      }, 96)
    })

      scheduleMapResize(true)
    }

    void bootMap()

    return () => {
      initCancelled = true
      if (mapContextLossOverlayTimerRef.current) {
        clearTimeout(mapContextLossOverlayTimerRef.current)
        mapContextLossOverlayTimerRef.current = null
      }
      if (handleContextLost) canvas?.removeEventListener('webglcontextlost', handleContextLost)
      if (handleContextRestored) canvas?.removeEventListener('webglcontextrestored', handleContextRestored)
      if (animationRef.current !== null) cancelAnimationFrame(animationRef.current)
      if (styleLoadTimerRef.current) clearTimeout(styleLoadTimerRef.current)
      if (clearPinHoverTimerRef.current) clearTimeout(clearPinHoverTimerRef.current)
      hoverPopupRef.current?.remove()
      applyCommandMapThemeRef.current = null
      propUnivHandlersRegisteredRef.current = false
      propTilesHandlersRegisteredRef.current = false
      if (map) {
        try { map.remove() } catch { /* ignore errors during context-lost teardown */ }
      }
      mapRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapContainerKey])

  useEffect(() => {
    if (mapContextLostRef.current || !isStyleSafe(mapRef.current)) return
    safeSetGeoJsonSourceData(mapRef.current, RAW_SOURCE_ID, geojson)
    safeSetGeoJsonSourceData(mapRef.current, CLUSTER_SOURCE_ID, geojson)
    safeSetGeoJsonSourceData(mapRef.current, BUYER_PURCHASE_SOURCE_ID, buyerPurchasesGeojson)
    safeSetGeoJsonSourceData(mapRef.current, BUYER_PROFILE_SOURCE_ID, buyerProfilesGeojson)
    safeSetGeoJsonSourceData(mapRef.current, BUYER_TRAIL_SOURCE_ID, buyerTrailGeojson)
  }, [buyerProfilesGeojson, buyerPurchasesGeojson, buyerTrailGeojson, geojson])

  useEffect(() => {
    if (mapContextLostRef.current || !isStyleSafe(mapRef.current)) return
    safeSetGeoJsonSourceData(mapRef.current, SELECTED_STAR_SOURCE_ID, selectedStarGeojson)
  }, [selectedStarGeojson])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    applyCommandMapThemeRef.current?.(map, mapStyleMode)
  }, [mapStyleMode])

  useEffect(() => {
    if (!isMapVerificationMode()) return
    const win = window as unknown as { __nexusSetMapTheme?: (themeId: MapStyleMode) => void }
    win.__nexusSetMapTheme = (themeId) => setMapStyleMode(themeId)
    return () => {
      delete win.__nexusSetMapTheme
    }
  }, [])

  // ── Two-scale property source fetch (SOURCE A aggregates + SOURCE B properties) ─
  useEffect(() => {
    const map = mapRef.current
    if (!isStyleSafe(map) || baseStyleLoading) return
    if (!viewportBounds) return
    if (!sellerPinLayers.sellerPins) return

    propertyUniverseAbortRef.current?.abort()
    propertyUniverseAbortRef.current = new AbortController()
    const signal = propertyUniverseAbortRef.current.signal
    const fetchMode = getMapPropertyFetchMode(viewportZoom)
    const tileBacked = shouldUseVectorTileSource(viewportZoom)

    void fetchMapProperties({
      lat_min: viewportBounds.south,
      lat_max: viewportBounds.north,
      lng_min: viewportBounds.west,
      lng_max: viewportBounds.east,
      zoom: Math.round(viewportZoom * 10) / 10,
      ...(tileBacked ? { counts_only: true } : {}),
    }, signal).then((result) => {
      if (!result.ok || signal.aborted) return
      const payload = result.data.data
      const features = payload.features as GeoJSON.Feature<Point>[]

      const aggregateTotal = shouldUseAggregateSource(viewportZoom)
        ? (features.reduce((sum, f) => sum + Number((f.properties as Record<string, unknown>)?.property_count ?? 0), 0))
        : undefined

      setMapPropertyDiagnostics((current) => ({
        mode: String(payload.mode ?? fetchMode),
        fetchMode,
        sourceMode: tileBacked ? 'mvt_tiles' : (shouldUseAggregateSource(viewportZoom) ? 'aggregates' : 'legacy_geojson'),
        zoom: viewportZoom,
        source: tileBacked ? 'canonical_property_tiles' : String(payload.source ?? fetchMode),
        totalCanonical: payload.counts.total_canonical,
        totalInBounds: payload.counts.total_in_bounds,
        aggregateTotal,
        returnedFeatures: tileBacked ? 0 : payload.counts.returned,
        representedFeatures: current?.representedFeatures ?? 0,
        representedPropertyTotal: current?.representedPropertyTotal,
        clipped: Boolean(payload.counts.clipped),
        paginationBoundary: payload.counts.pagination_boundary ?? null,
        tileBacked: tileBacked || Boolean((payload.counts as { tile_backed?: boolean }).tile_backed),
        coveringTiles: current?.coveringTiles,
        decodedTileFeatures: current?.decodedTileFeatures,
        uniqueTilePropertyIds: current?.uniqueTilePropertyIds,
        duplicateIds: current?.duplicateIds,
        tileCanonicalDifference: current?.tileCanonicalDifference,
        renderedIndividualIcons: current?.renderedIndividualIcons,
        renderedClusters: current?.renderedClusters,
        clusteredPropertyTotal: current?.clusteredPropertyTotal,
        renderedHalos: current?.renderedHalos,
        collisionHiddenEstimate: current?.collisionHiddenEstimate,
        selectedBreakouts: current?.selectedBreakouts,
        liveBreakouts: current?.liveBreakouts,
        invariantViolations: current?.invariantViolations,
        duplicateRenderedMarkers: current?.duplicateRenderedMarkers,
      }))

      if (shouldUseAggregateSource(viewportZoom)) {
        marketAggregateRawFeaturesRef.current = features
        const aggSrc = map.getSource(MARKET_AGGREGATE_SOURCE_ID) as maplibregl.GeoJSONSource | undefined
        aggSrc?.setData({ type: 'FeatureCollection', features })
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.log('[MapSource:A] market aggregates', {
            zoom: viewportZoom,
            band: getMapZoomBand(viewportZoom),
            markets: features.length,
            totalCanonical: payload.counts.total_canonical ?? payload.counts.total_in_bounds,
          })
        }
        return
      }

      if (tileBacked) {
        propertyUniverseRawFeaturesRef.current = []
        const src = map.getSource(PROPERTY_UNIVERSE_SOURCE_ID) as maplibregl.GeoJSONSource | undefined
        src?.setData({ type: 'FeatureCollection', features: [] })
        const enrichmentPins = Array.from(sellerPinsByPropertyIdRef.current.values())
        if (enrichmentPins.length > 0) {
          applyPropertyTileEnrichmentStates(
            map,
            enrichmentPins,
            activeThemeRef.current.id,
            mapMode,
            selectedPropertyId,
          )
        }
        return
      }
    }).catch(() => { /* aborted or network error */ })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewportBounds, viewportZoom, baseStyleLoading, sellerPinLayers.sellerPins, selectedPropertyId, mapStyleMode, mapMode])

  // ── Zoom-band layer visibility (no blank ranges) ──────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!isStyleSafe(map) || baseStyleLoading) return

    const applyZoomBandVisibility = () => {
      const zoom = map.getZoom()
      const showPropertyField = sellerPinLayers.sellerPins
      const showAggregates = showPropertyField && shouldUseAggregateSource(zoom)
      const sellerPinFieldActive = shouldPresentSellerPinGeojsonField(
        showPropertyField,
        zoom,
        sellerPinsGeojsonRef.current.features.length,
      )
      const showTiles = showPropertyField && shouldUseVectorTileSource(zoom) && !sellerPinFieldActive
      const showPropertyLevel = showPropertyField && shouldUsePropertySource(zoom) && !sellerPinFieldActive
      const showPropertyClusters = showPropertyLevel && zoom < ACQUISITION_RADAR_ZOOM.streetMin
      const showPropertyMarkers = showPropertyLevel && (
        zoom >= ACQUISITION_RADAR_ZOOM.streetMin
        || zoom >= (isMobile ? 11.5 : 11.5)
      )
      const vis = (v: boolean) => v ? 'visible' : 'none'

      for (const lid of Object.values(MARKET_AGGREGATE_LAYER_IDS)) {
        if (map.getLayer(lid)) map.setLayoutProperty(lid, 'visibility', vis(showAggregates))
      }

      for (const lid of ALL_PROPERTY_TILE_LAYER_IDS) {
        if (map.getLayer(lid)) map.setLayoutProperty(lid, 'visibility', vis(showTiles))
      }

      for (const lid of [
        PROPERTY_UNIVERSE_LAYER_IDS.clusterRing,
        PROPERTY_UNIVERSE_LAYER_IDS.clusterCore,
        PROPERTY_UNIVERSE_LAYER_IDS.clusterIcon,
        PROPERTY_UNIVERSE_LAYER_IDS.clusterCount,
      ]) {
        if (map.getLayer(lid)) map.setLayoutProperty(lid, 'visibility', vis(showPropertyClusters))
      }
      const markerLayerIds = [
        PROPERTY_UNIVERSE_LAYER_IDS.markerHit,
        PROPERTY_UNIVERSE_LAYER_IDS.markerGlow,
        PROPERTY_UNIVERSE_LAYER_IDS.markerGlass,
        PROPERTY_UNIVERSE_LAYER_IDS.markerRing,
        PROPERTY_UNIVERSE_LAYER_IDS.markerPulse,
        PROPERTY_UNIVERSE_LAYER_IDS.markers,
      ]
      for (const lid of markerLayerIds) {
        if (map.getLayer(lid)) map.setLayoutProperty(lid, 'visibility', vis(showPropertyMarkers))
      }

      if (showPropertyMarkers) {
        const pinVisibilityFilter = buildIndividualPinVisibilityFilter(selectedPropertyId) as maplibregl.FilterSpecification
        const motionFilter = [
          'all',
          pinVisibilityFilter,
          ['!=', ['coalesce', ['get', 'motion'], 'static'], 'static'],
        ] as maplibregl.FilterSpecification
        for (const lid of markerLayerIds) {
          if (!map.getLayer(lid)) continue
          if (lid === PROPERTY_UNIVERSE_LAYER_IDS.markerPulse) {
            map.setFilter(lid, motionFilter)
          } else {
            map.setFilter(lid, pinVisibilityFilter)
          }
        }
      }
    }

    applyZoomBandVisibility()
    map.on('moveend', applyZoomBandVisibility)
    map.on('zoomend', applyZoomBandVisibility)
    return () => {
      map.off('moveend', applyZoomBandVisibility)
      map.off('zoomend', applyZoomBandVisibility)
    }
  }, [baseStyleLoading, isMobile, sellerPinLayers.sellerPins, sellerPinsGeojson, viewportZoom, selectedPropertyId])

  useEffect(() => {
    const map = mapRef.current
    if (!isStyleSafe(map) || baseStyleLoading) return

    const updateMapAccounting = () => {
      const zoom = map.getZoom()
      const bounds = map.getBounds()
      const boundsBox = {
        west: bounds.getWest(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        north: bounds.getNorth(),
      }

      const visual = countVisualRepresentation(map, zoom)
      const violations = assertMapRenderInvariants(map)
      const duplicateMarkers = findDuplicateRenderedPropertyIds(map)

      let represented = 0
      let representedPropertyTotal = 0
      let coveringTiles: number | undefined
      let decodedTileFeatures: number | undefined
      let uniqueTilePropertyIds: number | undefined
      let duplicateIds: number | undefined
      let tileCanonicalDifference: number | undefined

      if (shouldUseVectorTileSource(zoom)) {
        const tileQuery = queryUniqueTilePropertiesInBounds(map, boundsBox)
        coveringTiles = getCoveringTileCoords(boundsBox, zoom).length
        decodedTileFeatures = tileQuery.decodedFeatureCount
        uniqueTilePropertyIds = tileQuery.uniquePropertyIds.size
        duplicateIds = tileQuery.duplicatePropertyIdCount
        represented = visual.renderedIndividualIcons
        representedPropertyTotal = tileQuery.uniquePropertyIds.size
        const canonicalInBounds = mapPropertyDiagnostics?.totalInBounds
        if (canonicalInBounds != null) {
          tileCanonicalDifference = computeTileAccountingDelta(canonicalInBounds, tileQuery.uniquePropertyIds.size)
        }
      } else if (shouldUseAggregateSource(zoom)) {
        represented = visual.clusteredPropertyTotal
        representedPropertyTotal = visual.clusteredPropertyTotal
      } else {
        represented = visual.renderedIndividualIcons + visual.clusteredPropertyTotal
        representedPropertyTotal = represented
      }

      setMapPropertyDiagnostics((current) => {
        const base = current ?? {
          mode: 'accounting',
          zoom,
          source: shouldUseVectorTileSource(zoom) ? 'canonical_property_tiles' : 'canonical_spatial_clusters',
          returnedFeatures: 0,
          representedFeatures: represented,
          representedPropertyTotal,
          clipped: false,
        }
        const canonicalInBounds = base.totalInBounds
        const tileDelta = (
          shouldUseVectorTileSource(zoom)
          && canonicalInBounds != null
          && uniqueTilePropertyIds != null
        )
          ? computeTileAccountingDelta(canonicalInBounds, uniqueTilePropertyIds)
          : tileCanonicalDifference

        const next: MapPropertyDiagnostics = {
          ...base,
          zoom,
          sourceMode: shouldUseVectorTileSource(zoom)
            ? 'mvt_tiles'
            : (shouldUseAggregateSource(zoom) ? 'aggregates' : 'legacy_geojson'),
          tileBacked: shouldUseVectorTileSource(zoom),
          aggregateTotal: shouldUseAggregateSource(zoom) ? visual.clusteredPropertyTotal : base.aggregateTotal,
          representedFeatures: represented,
          representedPropertyTotal,
          coveringTiles,
          decodedTileFeatures,
          uniqueTilePropertyIds,
          duplicateIds,
          tileCanonicalDifference: tileDelta,
          renderedIndividualIcons: visual.renderedIndividualIcons,
          renderedClusters: visual.renderedClusters,
          clusteredPropertyTotal: visual.clusteredPropertyTotal,
          renderedHalos: visual.renderedHalos,
          collisionHiddenEstimate: visual.collisionHiddenEstimate,
          selectedBreakouts: visual.selectedBreakouts,
          liveBreakouts: visual.liveBreakouts,
          invariantViolations: violations.length,
          duplicateRenderedMarkers: duplicateMarkers.length,
          sellerPinsEnabled: sellerPinLayersRef.current.sellerPins,
          sellerPinsRpcReturned: sellerPinsPerf.pinsReturned,
          sellerPinsGeojsonFeatures: sellerPinsGeojsonRef.current.features.length,
        }
        if (import.meta.env.DEV || isMapVerificationMode()) {
          ;(window as unknown as { __nexusMapDiagnostics?: MapPropertyDiagnostics | null }).__nexusMapDiagnostics = next
          ;(window as unknown as { __nexusMapInvariantViolations?: typeof violations }).__nexusMapInvariantViolations = violations
          ;(window as unknown as { __nexusMapDuplicateMarkers?: string[] }).__nexusMapDuplicateMarkers = duplicateMarkers
        }
        return next
      })
    }

    map.on('idle', updateMapAccounting)
    map.on('moveend', updateMapAccounting)
    updateMapAccounting()
    return () => {
      map.off('idle', updateMapAccounting)
      map.off('moveend', updateMapAccounting)
    }
  }, [baseStyleLoading, sellerPinsPerf.pinsReturned, sellerPinsGeojson, viewportZoom, viewportBounds, sellerPinLayers.sellerPins])

  useEffect(() => {
    const map = mapRef.current
    if (!isStyleSafe(map)) return
    if (!map.getLayer(PROPERTY_UNIVERSE_LAYER_IDS.markers)) return
    map.setLayoutProperty(
      PROPERTY_UNIVERSE_LAYER_IDS.markers,
      'icon-size',
      (isMobile ? PIN_ICON_SCALE_TOUCH_EXPR : PIN_ICON_SCALE_EXPR) as maplibregl.ExpressionSpecification,
    )
    if (map.getLayer(SELLER_PINS_LAYER_IDS.icon)) {
      map.setLayoutProperty(
        SELLER_PINS_LAYER_IDS.icon,
        'icon-size',
        (isMobile ? PIN_ICON_SCALE_TOUCH_EXPR : UNIVERSAL_PIN_ICON_SCALE_EXPR) as maplibregl.ExpressionSpecification,
      )
    }
    for (const layerId of ['command-pin-icon-raw', 'command-pin-icon-clustered'] as const) {
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(
          layerId,
          'icon-size',
          (isMobile ? PIN_ICON_SCALE_TOUCH_EXPR : UNIVERSAL_PIN_ICON_SCALE_EXPR) as maplibregl.ExpressionSpecification,
        )
      }
    }
  }, [isMobile])

  useEffect(() => {
    const map = mapRef.current
    if (!isStyleSafe(map) || propertyUniverseRawFeaturesRef.current.length === 0) return
    const enriched = enrichPropertyUniverseFeatures(
      propertyUniverseRawFeaturesRef.current,
      activeThemeRef.current.id,
      selectedPropertyId,
      mapMode,
    )
    const src = map.getSource(PROPERTY_UNIVERSE_SOURCE_ID) as maplibregl.GeoJSONSource | undefined
    src?.setData({ type: 'FeatureCollection', features: enriched })
  }, [selectedPropertyId, mapStyleMode, baseStyleLoading, mapMode])

  useEffect(() => {
    const map = mapRef.current
    if (!isStyleSafe(map)) return
    const layers = map.getStyle()?.layers ?? []
    layers.forEach((layer) => {
      const typedLayer = layer as StyleLayerLike
      if (!typedLayer.id || isCustomLayer(typedLayer.id)) return
      const categories = classifyBaseLayer(typedLayer)
      if (categories.length === 0) return
      const visible = categories.every((category) => mapOverlays[category])
      if (map.getLayer(typedLayer.id)) {
        map.setLayoutProperty(typedLayer.id, 'visibility', visible ? 'visible' : 'none')
      }
    })
  }, [mapOverlays])

  useEffect(() => {
    if (!mapRef.current) return
    mapRef.current.easeTo({
      pitch: mapDimension === '3d' ? 58 : 0,
      bearing: mapDimension === '3d' ? -18 : 0,
      duration: 550,
    })
  }, [mapDimension])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    let timeout: ReturnType<typeof setTimeout> | null = null
    const syncViewport = () => {
      const bounds = map.getBounds()
      setViewportBounds({
        west: bounds.getWest(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        north: bounds.getNorth(),
      })
      setViewportZoom(map.getZoom())
    }
    syncViewport()
    const onMoveEnd = () => {
      if (timeout) clearTimeout(timeout)
      timeout = setTimeout(syncViewport, 90)
    }
    map.on('moveend', onMoveEnd)
    return () => {
      if (timeout) clearTimeout(timeout)
      map.off('moveend', onMoveEnd)
    }
  }, [mapRef.current])

  useEffect(() => {
    const map = mapRef.current
    if (!isStyleSafe(map)) return
    const clusteredMode =
      (activityMode !== 'sends' && !activeKpiFilter)
      || (performanceSettings.clusterAggressiveness === 'high' && map.getZoom() < 12.5)
    const sellerPinFieldReady = sellerPinLayers.sellerPins
      && sellerPinsGeojsonRef.current.features.length > 0
    const sellerThreadsVisible = buyerLayers.sellerThreads && !sellerPinFieldReady
    RAW_LAYER_IDS.forEach((layerId) => {
      if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', sellerThreadsVisible ? (clusteredMode ? 'none' : 'visible') : 'none')
    })
    CLUSTER_POINT_LAYER_IDS.forEach((layerId) => {
      if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', sellerThreadsVisible ? (clusteredMode ? 'visible' : 'none') : 'none')
    })
    CLUSTER_LAYER_IDS.forEach((layerId) => {
      if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', sellerThreadsVisible ? (clusteredMode ? 'visible' : 'none') : 'none')
    })
  }, [activeKpiFilter, activityMode, buyerLayers.sellerThreads, performanceSettings.clusterAggressiveness, sellerPinLayers.sellerPins, sellerPinsGeojson, baseStyleLoading])

  useEffect(() => {
    const map = mapRef.current
    if (!isStyleSafe(map)) return
    const purchasesVisible = buyerLayers.buyerRecentPurchases || buyerLayers.buyerMatches
    BUYER_PURCHASE_CLUSTER_IDS.forEach((layerId) => {
      if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', purchasesVisible ? 'visible' : 'none')
    })
    BUYER_PURCHASE_LAYER_IDS.forEach((layerId) => {
      if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', purchasesVisible ? 'visible' : 'none')
    })
    BUYER_PROFILE_LAYER_IDS.forEach((layerId) => {
      if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', buyerLayers.buyerProfiles ? 'visible' : 'none')
    })
    BUYER_TRAIL_LAYER_IDS.forEach((layerId) => {
      if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', selectedBuyerKey && buyerLayers.buyerFocusMode ? 'visible' : 'none')
    })
    ALL_SOLD_COMPS_LAYER_IDS.forEach((layerId) => {
      if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', buyerLayers.recentSoldComps ? 'visible' : 'none')
    })
    if (map.getLayer(BUYER_HEATMAP_LAYER_ID)) {
      map.setLayoutProperty(BUYER_HEATMAP_LAYER_ID, 'visibility', buyerLayers.buyerHeatmap && performanceSettings.showHeatEffects ? 'visible' : 'none')
    }
  }, [buyerLayers, performanceSettings.showHeatEffects, selectedBuyerKey, baseStyleLoading])

  // ── Census overlay loading (viewport + zoom aware) ─────────────────────────
  useEffect(() => {
    if (!activeCensusMetric) {
      setCensusGeojson({ type: 'FeatureCollection', features: [] })
      setCensusOverlayFeatures([])
      setCensusOverlayLegend(null)
      setCensusOverlayMessage('')
      setCensusOverlayLoading(false)
      setHoveredCensusFeature(null)
      setSelectedCensusFeature(null)
      return
    }

    let cancelled = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    const cache = new Map<string, { ts: number; features: CensusOverlayFeature[]; geojson: FeatureCollection<Polygon, GeoJsonProperties>; message: string }>()
    let requestSeq = 0

    const loadOverlay = () => {
      const map = mapRef.current
      if (!map) return
      const bounds = map.getBounds()
      const queryBounds = {
        west: bounds.getWest(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        north: bounds.getNorth(),
      }
      const cacheKey = `${activeCensusMetric}:${buildViewportCacheKey({ minLng: queryBounds.west, minLat: queryBounds.south, maxLng: queryBounds.east, maxLat: queryBounds.north }, map.getZoom(), 'census')}`
      const cached = cache.get(cacheKey)
      if (cached && (Date.now() - cached.ts) < 120_000) {
        setCensusGeojson(cached.geojson)
        setCensusOverlayFeatures(cached.features)
        setCensusOverlayLegend(getCensusOverlayLegend(activeCensusMetric))
        setCensusOverlayMessage(cached.message)
        setCensusOverlayLoading(false)
        return
      }
      const seq = ++requestSeq
      setCensusOverlayLoading(true)
      void loadNationwideCensusOverlay(activeCensusMetric, queryBounds, map.getZoom()).then((result) => {
        if (cancelled || seq !== requestSeq) return
        const geojson = buildOverlayGeoJson(result.features, activeCensusMetric)
        const metricValues = result.features.map((feature) => {
          const properties = geojson.features.find((geoFeature) => String(geoFeature.properties?.id) === feature.id)?.properties
          return Number(properties?.metricValue ?? 0)
        }).filter(Number.isFinite)
        const range = metricValues.length > 0
          ? { min: Math.min(...metricValues), max: Math.max(...metricValues) }
          : undefined
        const emptyMessage = 'Census overlay not initialized — no census_geo_metrics loaded.'
        setCensusGeojson(geojson)
        setCensusOverlayFeatures(result.features)
        setCensusOverlayLegend(getCensusOverlayLegend(activeCensusMetric, range))
        setCensusOverlayMessage(result.features.length === 0 ? emptyMessage : (result.message || ''))
        setCensusOverlayLoading(false)
        cache.set(cacheKey, { ts: Date.now(), features: result.features, geojson, message: result.features.length === 0 ? emptyMessage : (result.message || '') })
      }).catch(() => {
        if (cancelled || seq !== requestSeq) return
        setCensusGeojson({ type: 'FeatureCollection', features: [] })
        setCensusOverlayFeatures([])
        setCensusOverlayLegend(getCensusOverlayLegend(activeCensusMetric))
        setCensusOverlayMessage('Run Census Sync for selected viewport.')
        setCensusOverlayLoading(false)
      })
    }

    loadOverlay()

    const map = mapRef.current
    const onMoveEnd = () => {
      if (timeout) clearTimeout(timeout)
      timeout = setTimeout(loadOverlay, 450)
    }
    map?.on('moveend', onMoveEnd)

    return () => {
      cancelled = true
      if (timeout) clearTimeout(timeout)
      map?.off('moveend', onMoveEnd)
    }
  }, [activeCensusMetric])

  // ── Census intelligence for selected thread ────────────────────────────────
  useEffect(() => {
    if (!selectedThread) { setSelectedThreadCensus(null); return }
    loadCensusForProperty(selectedThread).then(setSelectedThreadCensus).catch(() => setSelectedThreadCensus(null))
  }, [selectedThread?.id])

  useEffect(() => {
    setHoveredCensusFeature(null)
    setSelectedCensusFeature(null)
  }, [activeCensusMetric])

  const buildClusterSummaryFromLeaves = (clusterId: number, coordinates: [number, number], mode: 'hover' | 'selected') => {
    const source = safeGetSource(mapRef.current, CLUSTER_SOURCE_ID) as (maplibregl.GeoJSONSource & {
      getClusterLeaves?: (
        clusterId: number,
        limit: number,
        offset: number,
        callback: (error: Error | null, features: maplibregl.MapGeoJSONFeature[]) => void
      ) => void
    }) | undefined
    if (!source?.getClusterLeaves) return
    source.getClusterLeaves(clusterId, 50, 0, (error, features) => {
      if (error) return
      const leaves = (features ?? []).map((feature) => feature.properties as unknown as PinFeatureProps)
      const hotCount = leaves.filter((leaf) => (leaf.priority_score ?? 0) >= 92).length
      const reviewCount = leaves.filter((leaf) => leaf.inbox_bucket === 'needs_review' || leaf.activity_state === 'needs_review').length
      const replyCount = leaves.filter((leaf) => leaf.inbox_bucket === 'new_replies' || leaf.activity_state === 'replied').length
      const avgValue = leaves.reduce((sum, leaf) => sum + (leaf.estimated_value ?? 0), 0) / Math.max(leaves.filter((leaf) => Number.isFinite(leaf.estimated_value ?? NaN)).length, 1)
      const avgEquity = leaves.reduce((sum, leaf) => sum + (leaf.equity_percent ?? 0), 0) / Math.max(leaves.filter((leaf) => Number.isFinite(leaf.equity_percent ?? NaN)).length, 1)
      const markets = Array.from(new Set(leaves.map((leaf) => leaf.market).filter(Boolean)))
      const summary: ClusterCensusSummary = {
        id: `${clusterId}:${coordinates[0]}:${coordinates[1]}`,
        title: mode === 'selected' ? 'Selected Cluster' : 'Hovered Cluster',
        subtitle: markets.slice(0, 2).join(' • ') || 'Live cluster summary',
        itemCount: leaves.length,
        metrics: [
          { label: 'Threads', value: `${leaves.length}` },
          { label: 'Hot', value: `${hotCount}` },
          { label: 'New Replies', value: `${replyCount}` },
          { label: 'Needs Review', value: `${reviewCount}` },
          { label: 'Avg Value', value: Number.isFinite(avgValue) ? formatCompactCurrency(avgValue) : '—' },
          { label: 'Avg Equity', value: Number.isFinite(avgEquity) && avgEquity > 0 ? formatPercent(avgEquity) : '—' },
        ],
      }
      if (mode === 'selected') {
        setSelectedClusterSummary(summary)
      } else {
        setHoveredClusterSummary(summary)
      }
    })
  }

  const visibleBoundsCensusPanel = useMemo(() => {
    const marketsInView = Array.from(new Set(visiblePins.map((pin) => pin.market).filter(Boolean)))
    const hotCount = visiblePins.filter((pin) => (pin.priority_score ?? 0) >= 92).length
    const replyCount = visiblePins.filter((pin) => pin.inbox_bucket === 'new_replies' || pin.activity_state === 'replied').length
    const reviewCount = visiblePins.filter((pin) => pin.inbox_bucket === 'needs_review' || pin.activity_state === 'needs_review').length
    const suppressedCount = visiblePins.filter((pin) => pin.suppression_status !== 'clear').length
    return {
      title: 'Visible Bounds Summary',
      subtitle: marketsInView.slice(0, 3).join(' • ') || 'National command view',
      metrics: [
        { label: 'Visible Pins', value: `${visiblePins.length}` },
        { label: 'Markets', value: `${marketsInView.length}` },
        { label: 'Hot Sellers', value: `${hotCount}` },
        { label: 'New Replies', value: `${replyCount}` },
        { label: 'Needs Review', value: `${reviewCount}` },
        { label: 'Suppressed', value: `${suppressedCount}` },
      ],
    }
  }, [visiblePins])

  const censusPanelModel = useMemo(() => {
    const overlaySelection = selectedCensusFeature?.feature || hoveredCensusFeature?.feature || null
    if (selectedThread && selectedThreadCensus) {
      return {
        title: 'Selected Property Census',
        subtitle: resolveAddress(selectedHydratedThread ?? null, selectedPin),
        data: selectedThreadCensus,
        metrics: undefined,
        emptyMessage: undefined,
      }
    }
    if (overlaySelection) {
      return {
        title: selectedCensusFeature ? 'Selected Geography' : 'Hovered Geography',
        subtitle: overlaySelection.name,
        data: {
          state: overlaySelection.state,
          county: overlaySelection.county,
          zip: overlaySelection.zip,
          census_tract: overlaySelection.tract,
          population_density: overlaySelection.metric_values.population_density,
          vacancy_rate: overlaySelection.metric_values.vacancy_rate,
          renter_occupied_percent: overlaySelection.metric_values.renter_occupied_percent,
          owner_occupied_percent: overlaySelection.metric_values.owner_occupied_percent,
          median_household_income: overlaySelection.metric_values.median_household_income,
          median_home_value: overlaySelection.metric_values.median_home_value,
          median_gross_rent: overlaySelection.metric_values.median_gross_rent,
          median_age: overlaySelection.metric_values.median_age,
          investor_opportunity_score: overlaySelection.metric_values.investor_opportunity_score,
          acquisition_pressure_score: overlaySelection.metric_values.acquisition_pressure_score,
          investor_signal_summary: overlaySelection.summary,
        } as CensusData,
        metrics: undefined,
        emptyMessage: censusOverlayMessage || undefined,
      }
    }
    if (selectedClusterSummary) {
      return {
        title: selectedClusterSummary.title,
        subtitle: selectedClusterSummary.subtitle,
        data: null,
        metrics: selectedClusterSummary.metrics,
        emptyMessage: 'Cluster census intelligence is summarized from visible mapped threads.',
      }
    }
    if (hoveredClusterSummary) {
      return {
        title: hoveredClusterSummary.title,
        subtitle: hoveredClusterSummary.subtitle,
        data: null,
        metrics: hoveredClusterSummary.metrics,
        emptyMessage: 'Hover another cluster to inspect its live composition.',
      }
    }
    return {
      title: visibleBoundsCensusPanel.title,
      subtitle: visibleBoundsCensusPanel.subtitle,
      data: null,
      metrics: visibleBoundsCensusPanel.metrics,
      emptyMessage: 'Census metrics will hydrate when you select a property or inspect a cluster.',
    }
  }, [censusOverlayMessage, hoveredCensusFeature, hoveredClusterSummary, selectedCensusFeature, selectedClusterSummary, selectedHydratedThread, selectedPin, selectedThread, selectedThreadCensus, visibleBoundsCensusPanel])



  // ── Buyer demand layer data loading ───────────────────────────────────────
  useEffect(() => {
    const activeMetrics = (Object.entries(buyerDemandLayers) as Array<[keyof BuyerDemandLayerToggles, boolean]>)
      .filter(([, on]) => on)
      .map(([key]) => {
        const metricMap: Record<keyof BuyerDemandLayerToggles, BuyerDemandMetric> = {
          activity6mo: 'buyer_activity_6mo',
          investorDemand: 'investor_demand',
          buyerHeat: 'buyer_heat',
          soldPrice: 'sold_price',
        }
        return metricMap[key]
      })

    if (activeMetrics.length === 0) {
      setBuyerDemandGeojson(EMPTY_GEOJSON)
      return
    }

    let cancelled = false
    Promise.all(activeMetrics.map((m) => loadBuyerDemandLayerPoints(m))).then((results) => {
      if (cancelled) return
      const allPoints: BuyerDemandLayerPoint[] = results.flat()
      const features = allPoints.map((pt) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [pt.lng, pt.lat] as [number, number] },
        properties: {
          id: pt.id, metric: pt.metric, score: pt.score, value: pt.value,
          label: pt.label, geo_key: pt.geo_key, geo_level: pt.geo_level,
          priceLabel: pt.metric === 'sold_price' ? formatShortPrice(pt.value) : '',
        },
      }))
      setBuyerDemandGeojson({ type: 'FeatureCollection', features })
    }).catch(() => { /* silent */ })
    return () => { cancelled = true }
  }, [buyerDemandLayers])

  // ── Sold comps data loading ───────────────────────────────────────────────
  useEffect(() => {
    if (!buyerLayers.recentSoldComps) {
      setSoldCompsGeojson(EMPTY_GEOJSON)
      setSoldComps([])
      return
    }

    let cancelled = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    const cache = new Map<string, { ts: number; comps: RecentSoldComp[] }>()
    let requestSeq = 0

    const loadComps = () => {
      const map = mapRef.current
      if (!map) return
      if (map.getZoom() < 6) {
        setSoldCompsGeojson(EMPTY_GEOJSON)
        setSoldComps([])
        setSoldCompsLoading(false)
        return
      }
      const bounds = map.getBounds()
      const queryBounds = {
        minLng: bounds.getWest(),
        minLat: bounds.getSouth(),
        maxLng: bounds.getEast(),
        maxLat: bounds.getNorth(),
      }
      const cacheKey = buildViewportCacheKey(queryBounds, map.getZoom(), `sold:${filters.market || 'all'}:${getPinRenderCap(map.getZoom(), performanceSettings, 'sold_comp')}`)
      const cached = cache.get(cacheKey)
      const now = Date.now()
      const ttlMs = 90_000
      if (cached && (now - cached.ts) < ttlMs) {
        const features = cached.comps.slice(0, getPinRenderCap(map.getZoom(), performanceSettings, 'sold_comp')).map((comp) => {
          const price = comp.sale_price ?? comp.mls_sold_price ?? 0
          let sourceShort = ''
          if (comp.sale_source === 'MLS Sold') sourceShort = 'MLS '
          else if (comp.sale_source === 'Public Record Sold') sourceShort = 'PR '
          else if (comp.sale_source === 'Off-Market Sold') sourceShort = 'OM '
          return {
            type: 'Feature' as const,
            geometry: { type: 'Point' as const, coordinates: [comp.longitude, comp.latitude] as [number, number] },
            properties: { ...comp, id: `sold-comp-${comp.property_id}`, layer: 'sold_comp', salePriceLabel: formatShortPrice(price), sourceShort, propTypeSlug: normalizePropertyTypeSlug(comp.property_type ?? comp.normalized_asset_class ?? 'default') },
          }
        })
        setSoldComps(cached.comps)
        setSoldCompsGeojson({ type: 'FeatureCollection', features })
        setSoldCompsLoading(false)
        return
      }
      const seq = ++requestSeq
      setSoldCompsLoading(true)
      loadSoldCompsInBounds(queryBounds, {
        monthsBack: 6,
        limit: getPinRenderCap(map.getZoom(), performanceSettings, 'sold_comp'),
        selectedMarket: filters.market || undefined,
      }).then((comps) => {
        if (cancelled || seq !== requestSeq) return
        cache.set(cacheKey, { ts: Date.now(), comps })
        setSoldComps(comps)
        const features = comps.slice(0, getPinRenderCap(map.getZoom(), performanceSettings, 'sold_comp')).map((comp) => {
          const price = comp.sale_price ?? comp.mls_sold_price ?? 0
          let sourceShort = ''
          if (comp.sale_source === 'MLS Sold') sourceShort = 'MLS '
          else if (comp.sale_source === 'Public Record Sold') sourceShort = 'PR '
          else if (comp.sale_source === 'Off-Market Sold') sourceShort = 'OM '

          return {
            type: 'Feature' as const,
            geometry: { type: 'Point' as const, coordinates: [comp.longitude, comp.latitude] as [number, number] },
            properties: {
              ...comp,
              id: `sold-comp-${comp.property_id}`,
              layer: 'sold_comp',
              salePriceLabel: formatShortPrice(price),
              sourceShort,
              propTypeSlug: normalizePropertyTypeSlug(comp.property_type ?? comp.normalized_asset_class ?? 'default'),
            },
          }
        })
        setSoldCompsGeojson({ type: 'FeatureCollection', features })
        setSoldCompsLoading(false)
      }).catch(() => {
        if (cancelled || seq !== requestSeq) return
        setSoldCompsGeojson(EMPTY_GEOJSON)
        setSoldComps([])
        setSoldCompsLoading(false)
      })
    }

    loadComps()

    const map = mapRef.current
    const onMoveEnd = () => {
      if (timeout) clearTimeout(timeout)
      timeout = setTimeout(loadComps, 420)
    }
    map?.on('moveend', onMoveEnd)

    return () => {
      cancelled = true
      if (timeout) clearTimeout(timeout)
      map?.off('moveend', onMoveEnd)
    }
  }, [buyerLayers.recentSoldComps, filters.market, performanceSettings])

  // ── Seller Pins data loading ──────────────────────────────────────────────
  useEffect(() => {
    if (!sellerPinLayers.sellerPins) {
      setSellerPins([])
      setSellerPinsGeojson(EMPTY_GEOJSON)
      setSellerPinsPerf((current) => ({ ...current, shown: 0, loadedAt: Date.now() }))
      return
    }

    if (paused) {
      if (import.meta.env.DEV) console.log('[HeavyPanelLoadSkipped] InboxCommandMap: paused (inbox or messages loading)')
      return
    }

    const scheduleLoad = (stage: MapLoadStage = 'stage_2', delayMs = 320) => {
      if (sellerPinsFetchTimerRef.current) clearTimeout(sellerPinsFetchTimerRef.current)
      sellerPinsFetchTimerRef.current = setTimeout(() => {
        sellerPinsFetchTimerRef.current = null
        void loadPins(stage)
      }, delayMs)
    }

    const loadPins = async (stage: MapLoadStage = 'stage_2') => {
      const map = mapRef.current
      if (!map) return

      const zoom = map.getZoom()
      const bounds = map.getBounds()
      const queryBounds = {
        minLng: bounds.getWest(),
        minLat: bounds.getSouth(),
        maxLng: bounds.getEast(),
        maxLat: bounds.getNorth(),
      }

      const maxRows = Math.max(
        300,
        Math.min(
          getPinRenderCap(zoom, performanceSettings, 'seller'),
          stage === 'stage_1' ? 500 : 150000,
        ),
      )
      const cacheKey = buildViewportCacheKey(queryBounds, zoom, `seller:${maxRows}:density:${performanceSettings.markerDensity}:mode:${performanceSettings.performanceMode}`)
      const now = Date.now()
      const ttlMs = 60_000
      const cached = sellerPinsCacheRef.current.get(cacheKey)
      const requestSeq = ++sellerPinsRequestSeqRef.current
      const sampled = (pins: CommandMapSellerPin[]) => pins.length >= maxRows
      const applyPins = (pins: CommandMapSellerPin[], cacheHit: boolean, rpcMs: number | null) => {
        setSellerPinsRaw(pins)
        setSellerPinsPerf({
          shown: pins.length,
          cap: maxRows,
          capHit: sampled(pins),
          cacheHit,
          loadedAt: now,
          sampled: sampled(pins),
          rpcMs,
          pinsReturned: pins.length,
        })
        if (import.meta.env.DEV) {
          console.log('[CommandMapPerf]', {
            theme: mapStyleModeRef.current,
            zoom: Number(zoom.toFixed(2)),
            boundsKey: cacheKey,
            rpcMs,
            pinsReturned: pins.length,
            pinsRendered: sellerPins.length,
            cacheHit,
            styleLoadMs: null,
            sourceReattached: false,
          })
        }
      }

      if (cached && (now - cached.ts) < ttlMs) {
        applyPins(cached.pins, true, 0)
        setSellerPinsLoading(false)
        return
      }

      sellerPinsAbortRef.current?.abort()
      const controller = new AbortController()
      sellerPinsAbortRef.current = controller
      setSellerPinsLoading(true)
      const startedAt = performance.now()
      try {
        const pins = await loadCommandMapSellerPins(queryBounds, zoom, maxRows, { signal: controller.signal })
        if (requestSeq !== sellerPinsRequestSeqRef.current) return
        sellerPinsCacheRef.current.set(cacheKey, { ts: Date.now(), pins })
        if (sellerPinsCacheRef.current.size > 24) {
          const firstKey = sellerPinsCacheRef.current.keys().next().value
          if (firstKey) sellerPinsCacheRef.current.delete(firstKey)
        }
        applyPins(pins, false, Math.round(performance.now() - startedAt))
        setSellerPinsLoading(false)
      } catch {
        if (controller.signal.aborted || requestSeq !== sellerPinsRequestSeqRef.current) return
        setSellerPinsRaw([])
        setSellerPins([])
        setSellerPinsGeojson(EMPTY_GEOJSON)
        setSellerPinsPerf((current) => ({ ...current, shown: 0, capHit: false, cacheHit: false, loadedAt: Date.now(), sampled: false, rpcMs: null, pinsReturned: 0 }))
        setSellerPinsLoading(false)
      }
    }

    void loadPins('stage_1')
    const stage2Timer = setTimeout(() => {
      void loadPins('stage_2')
    }, 180)

    const map = mapRef.current
    const onMoveEnd = () => {
      scheduleLoad('stage_2')
    }
    map?.on('moveend', onMoveEnd)

    return () => {
      if (sellerPinsFetchTimerRef.current) {
        clearTimeout(sellerPinsFetchTimerRef.current)
        sellerPinsFetchTimerRef.current = null
      }
      sellerPinsAbortRef.current?.abort()
      clearTimeout(stage2Timer)
      map?.off('moveend', onMoveEnd)
    }
  }, [performanceSettings.markerDensity, performanceSettings.performanceMode, sellerPinLayers.sellerPins, paused])

  useEffect(() => {
    if (!sellerPinLayers.sellerPins) return
    const byPropertyId = new Map<string, CommandMapSellerPin>()
    sellerPinsRaw.forEach((pin) => {
      const key = text(pin.property_id)
      if (key) byPropertyId.set(key, pin)
    })
    if (sellerPinLayers.notContacted) {
      pinPipeline.mapped.forEach((threadPin) => {
        const propertyId = text(threadPin.property_id)
        if (!propertyId || byPropertyId.has(propertyId)) return
        if (!isValidCoord(threadPin.lat, threadPin.lng)) return
        const fallbackPin = toFallbackSellerPin(threadPin)
        if (resolveEffectiveSellerState(fallbackPin) === 'not_contacted') {
          byPropertyId.set(propertyId, fallbackPin)
        }
      })
    }
    const mergedPins = Array.from(byPropertyId.values())
    const nextFilteredPins = mergedPins.filter((pin) => {
      const effectiveSellerState = resolveEffectiveSellerState(pin)
      if (!sellerPinLayers.notContacted && effectiveSellerState === 'not_contacted') return false
      if (!sellerPinLayers.contacted && effectiveSellerState === 'contacted') return false
      if (!sellerPinLayers.newReplies && effectiveSellerState === 'new_reply') return false
      if (!sellerPinLayers.positive && effectiveSellerState === 'positive_intent') return false
      if (!sellerPinLayers.negotiating && effectiveSellerState === 'negotiating') return false
      if (!sellerPinLayers.hot && effectiveSellerState === 'hot') return false
      if (!sellerPinLayers.issues && effectiveSellerState === 'issue') return false
      if (!sellerPinLayers.blocked && effectiveSellerState === 'blocked') return false
      if (!sellerPinLayers.queued && pin.execution_state === 'queued') return false
      if (!sellerPinLayers.scheduled && pin.execution_state === 'scheduled') return false
      if (!sellerPinLayers.ready && pin.execution_state === 'ready') return false
      if (!sellerPinLayers.activeSending && pin.execution_state === 'active') return false
      if (!sellerPinLayers.sent && pin.execution_state === 'sent') return false
      if (!sellerPinLayers.delivered && pin.execution_state === 'delivered') return false
      if (!sellerPinLayers.failedIssue && pin.execution_state === 'issue') return false
      return true
    })
    const normalizedFilteredPins = nextFilteredPins.map((pin) => sanitizeSellerPinRecord(pin))
    const themeId = activeThemeRef.current.id
    const dataKey = `${mapStyleMode}:${mapMode}:${normalizedFilteredPins.length}:${normalizedFilteredPins[0]?.property_id || ''}:${normalizedFilteredPins[normalizedFilteredPins.length - 1]?.property_id || ''}`
    const enrichmentByPropertyId = new Map<string, CommandMapSellerPin>()
    normalizedFilteredPins.forEach((pin) => {
      const key = text(pin.property_id)
      if (key) enrichmentByPropertyId.set(key, pin)
    })
    sellerPinsByPropertyIdRef.current = enrichmentByPropertyId
    setSellerPins(normalizedFilteredPins)
    if (dataKey !== lastSellerPinsDataKeyRef.current) {
      lastSellerPinsDataKeyRef.current = dataKey
      setSellerPinsPerf((current) => ({ ...current, shown: normalizedFilteredPins.length }))
    }
    const nextSellerPinsGeojson = buildSellerPinsFeatureCollection(
      normalizedFilteredPins,
      themeId,
      mapMode,
      selectedPropertyId,
    )
    sellerPinsGeojsonRef.current = nextSellerPinsGeojson
    setSellerPinsGeojson(nextSellerPinsGeojson)
    const map = mapRef.current
    if (isStyleSafe(map)) {
      applySellerPinFieldPresentation(map, {
        sellerPinsEnabled: sellerPinLayers.sellerPins,
        viewportZoom: map.getZoom(),
        geojson: nextSellerPinsGeojson,
      })
    }
  }, [mapMode, mapStyleMode, pinPipeline.mapped, selectedPropertyId, sellerPinLayers, sellerPinsRaw])

  // ── Push census + buyer demand GeoJSON to map sources ─────────────────────
  useEffect(() => {
    if (mapContextLostRef.current || !isStyleSafe(mapRef.current)) return
    safeSetGeoJsonSourceData(mapRef.current, CENSUS_SOURCE_ID, censusGeojson as Parameters<maplibregl.GeoJSONSource['setData']>[0])
  }, [censusGeojson])

  useEffect(() => {
    if (mapContextLostRef.current || !isStyleSafe(mapRef.current)) return
    safeSetGeoJsonSourceData(mapRef.current, BUYER_DEMAND_SOURCE_ID, buyerDemandGeojson as Parameters<maplibregl.GeoJSONSource['setData']>[0])
  }, [buyerDemandGeojson])

  useEffect(() => {
    if (mapContextLostRef.current || !isStyleSafe(mapRef.current)) return
    safeSetGeoJsonSourceData(mapRef.current, SOLD_COMPS_SOURCE_ID, soldCompsGeojson as Parameters<maplibregl.GeoJSONSource['setData']>[0])
  }, [soldCompsGeojson])

  useEffect(() => {
    if (mapContextLostRef.current || !isStyleSafe(mapRef.current)) return
    safeSetGeoJsonSourceData(mapRef.current, SELLER_PINS_SOURCE_ID, sellerPinsGeojson as Parameters<maplibregl.GeoJSONSource['setData']>[0])
  }, [sellerPinsGeojson])

  useEffect(() => {
    const map = mapRef.current
    if (!isStyleSafe(map)) return
    applySellerPinFieldPresentation(map, {
      sellerPinsEnabled: sellerPinLayers.sellerPins,
      viewportZoom,
      geojson: sellerPinsGeojsonRef.current,
    })
    const spGlowLayerId = `${SOLD_COMPS_LAYER_IDS.marker}-glow`
    // Keep comp glow aligned with comp marker visibility
    if (map.getLayer(spGlowLayerId)) {
      const compVisible = map.getLayoutProperty(SOLD_COMPS_LAYER_IDS.marker, 'visibility') ?? 'none'
      map.setLayoutProperty(spGlowLayerId, 'visibility', compVisible)
    }
  }, [sellerPinLayers.sellerPins, baseStyleLoading, viewportZoom])

  useEffect(() => {
    const map = mapRef.current
    if (!isStyleSafe(map) || !sellerPinLayers.sellerPins) return
    const pointFilter: maplibregl.FilterSpecification = ['!', ['has', 'point_count']]
    const clusterFilter: maplibregl.FilterSpecification = ['has', 'point_count']
    if (map.getLayer(SELLER_PINS_LAYER_IDS.hit)) map.setFilter(SELLER_PINS_LAYER_IDS.hit, pointFilter)
    if (map.getLayer(SELLER_PINS_LAYER_IDS.core)) map.setFilter(SELLER_PINS_LAYER_IDS.core, pointFilter)
    if (map.getLayer(SELLER_PINS_LAYER_IDS.icon)) map.setFilter(SELLER_PINS_LAYER_IDS.icon, pointFilter)
    if (map.getLayer(SELLER_PINS_LAYER_IDS.glow)) map.setFilter(SELLER_PINS_LAYER_IDS.glow, pointFilter)
    if (map.getLayer(SELLER_PINS_LAYER_IDS.ring)) map.setFilter(SELLER_PINS_LAYER_IDS.ring, pointFilter)
    if (map.getLayer(SELLER_PINS_LAYER_IDS.clusterGlow)) map.setFilter(SELLER_PINS_LAYER_IDS.clusterGlow, clusterFilter)
    if (map.getLayer(SELLER_PINS_LAYER_IDS.clusterCore)) map.setFilter(SELLER_PINS_LAYER_IDS.clusterCore, clusterFilter)
    if (map.getLayer(SELLER_PINS_LAYER_IDS.clusterCount)) map.setFilter(SELLER_PINS_LAYER_IDS.clusterCount, clusterFilter)
    if (map.getLayer(SELLER_PINS_LAYER_IDS.pulse)) {
      map.setFilter(SELLER_PINS_LAYER_IDS.pulse, [
        'all',
        pointFilter,
        ['in', ['coalesce', ['get', 'pulse_style'], 'none'], ['literal', ['pulse_strong', 'pulse_soft', 'pulse_warning', 'pulse_rotating']]],
      ])
    }
  }, [sellerPinLayers.sellerPins, viewportZoom, baseStyleLoading])

  // ── Census layer visibility + hovered outline ─────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!isStyleSafe(map)) return
    const visible = Boolean(activeCensusMetric && censusGeojson.features.length > 0)
    if (map.getLayer(CENSUS_LAYER_IDS.fill)) map.setLayoutProperty(CENSUS_LAYER_IDS.fill, 'visibility', visible ? 'visible' : 'none')
    if (map.getLayer(CENSUS_LAYER_IDS.line)) map.setLayoutProperty(CENSUS_LAYER_IDS.line, 'visibility', visible ? 'visible' : 'none')
    if (map.getLayer(CENSUS_LAYER_IDS.hoverLine)) {
      map.setLayoutProperty(CENSUS_LAYER_IDS.hoverLine, 'visibility', visible ? 'visible' : 'none')
      const highlightedId = selectedCensusFeature?.feature.id || hoveredCensusFeature?.feature.id || ''
      map.setFilter(CENSUS_LAYER_IDS.hoverLine, ['==', ['get', 'id'], highlightedId])
    }
  }, [activeCensusMetric, censusGeojson.features.length, hoveredCensusFeature?.feature.id, selectedCensusFeature?.feature.id])


  // ── Buyer demand layer visibility ─────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!isStyleSafe(map)) return
    ALL_BUYER_DEMAND_LAYER_IDS.forEach((layerId) => {
      if (map.getLayer(layerId)) {
        const metricMap: Record<string, keyof BuyerDemandLayerToggles> = {
          [BUYER_DEMAND_LAYER_IDS.activity6mo]: 'activity6mo',
          [BUYER_DEMAND_LAYER_IDS.investorDemand]: 'investorDemand',
          [BUYER_DEMAND_LAYER_IDS.buyerHeat]: 'buyerHeat',
          [BUYER_DEMAND_LAYER_IDS.soldPrice]: 'soldPrice',
          [BUYER_DEMAND_LAYER_IDS.soldPriceLabel]: 'soldPrice',
        }
        const key = metricMap[layerId]
        const visible = key ? buyerDemandLayers[key] : false
        map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none')
      }
    })
  }, [buyerDemandLayers])

  useEffect(() => {
    if (isMapVerificationMode()) return
    if (!mapRef.current || !selectedThread?.id) return
    if (!focusPin || !isMappableCoord(focusPin.lat, focusPin.lng)) return
    const selectionKey = [
      selectedThread.id,
      focusPin.conversation_id,
      focusPin.lat,
      focusPin.lng,
    ].join(':')
    if (lastAutoNavSelectionRef.current === selectionKey) return
    lastAutoNavSelectionRef.current = selectionKey
    mapRef.current.easeTo({
      center: [focusPin.lng, focusPin.lat],
      zoom: Math.max(mapRef.current.getZoom(), zoomedIn ? 13 : 11.25),
      duration: 680,
      offset: dockTier === 'full' ? [150, 0] : [0, 0],
    })
  }, [dockTier, focusPin?.conversation_id, focusPin?.lat, focusPin?.lng, selectedThread?.id, zoomedIn])

  const markets = Array.from(new Set(allPins.map((pin) => pin.market).filter(Boolean))).sort()
  const stages = LIFECYCLE_STAGE_ORDER.filter((code) =>
    allPins.some((pin) => normalizeLifecycleStage(pin.lifecycle_stage || pin.conversation_stage) === code),
  )
  const statuses = OPERATIONAL_STATUS_ORDER.filter((code) =>
    allPins.some((pin) => normalizeOperationalStatus(pin.operational_status || pin.conversation_status) === code),
  )
  const temperatures = Array.from(new Set(allPins.map((pin) => normalizeLeadTemperature(pin.lead_temperature)).filter(Boolean))).sort()
  const automationStatuses = Array.from(new Set(allPins.map((pin) => pin.automation_status).filter(Boolean))).sort()
  const selectedUnmapped = useMemo(
    () => selectedHydratedThread ? buildMapPin(selectedHydratedThread).unmapped : null,
    [selectedHydratedThread],
  )
  const emptyStateMessage = useMemo(() => {
    if (visiblePins.length > 0) return null
    if (sellerPinLayers.sellerPins && sellerPins.length > 0) return null
    if (filteredPins.length === 0 && allPins.length > 0) {
      return `No mapped pins match the current filters.${pinPipeline.unmapped.length > 0 ? ` ${pinPipeline.unmapped.length} conversations are missing coordinates.` : ''}`
    }
    if (allPins.length === 0 && pinPipeline.unmapped.length > 0) {
      return `No mapped pins found. ${pinPipeline.unmapped.length} conversations are missing coordinates.`
    }
    if (allPins.length === 0) {
      return 'No mapped pins found for the current inbox mode.'
    }
    return 'No visible pins found.'
  }, [allPins.length, filteredPins.length, pinPipeline.unmapped.length, visiblePins.length, sellerPins.length, sellerPinLayers.sellerPins])

  const openActivityTarget = (event: LiveActivityEvent, center: [number, number] | null) => {
    if (event.targetType === 'seller' && event.targetId) {
      const resolvedCenter = center ?? centerMapOnActivity(event)
      if (!resolvedCenter) return
      setSelectedPinId(event.targetId)
      onSelectThreadId?.(event.targetId)
      const thread = hydratedThreadsById.get(event.targetId)
        || hydratedThreadsByKey.get(event.targetId)
        || threads.find((item) => item.id === event.targetId || String((item as any).threadKey || '') === event.targetId)
        || null
      const pin = visiblePins.find((item) => item.conversation_id === event.targetId)
        || filteredPins.find((item) => item.conversation_id === event.targetId)
      const sellerRecord = thread
        ? { ...(thread as unknown as Record<string, unknown>) }
        : pin
          ? commandMapPinToSellerCardRecord(pin, null)
          : { property_id: event.targetId }
      const { anchor, containerSize } = buildMapCardContainerContext(mapRef.current, containerRef.current, resolvedCenter)
      setHoveredMapCard(null)
      setSelectedMapCard({
        kind: 'seller',
        intent: 'selected',
        id: event.targetId,
        anchor,
        coordinates: resolvedCenter,
        feature: sellerRecord,
        containerSize,
      })
    }
    if (event.targetType === 'buyer' && event.targetId) {
      const purchase = filteredBuyerPurchases.find((item) => item.buyerKey === event.targetId)
      if (purchase) {
        setSelectedBuyerPurchase(purchase)
        onSelectBuyerKeyRef.current?.(purchase.buyerKey)
      }
    }
    if (event.targetType === 'sold_comp' && event.targetId) {
      const comp = soldComps.find((item) => String(item.property_id) === event.targetId)
      if (comp) {
        setSelectedSoldComp(comp)
        const lat = Number(comp.latitude)
        const lng = Number(comp.longitude)
        const containerEl = containerRef.current
        const containerBounds = containerEl?.getBoundingClientRect()
        const containerWidth = containerBounds?.width ?? window.innerWidth
        const containerHeight = containerBounds?.height ?? window.innerHeight
        const coordinates: [number, number] = [lng, lat]
        const pixelPoint = mapRef.current ? mapRef.current.project(coordinates) : { x: containerWidth / 2, y: containerHeight / 2 }
        
        setSelectedMapCard({
          kind: 'sold_comp',
          intent: 'selected',
          id: String(comp.property_id),
          anchor: { x: pixelPoint.x, y: pixelPoint.y },
          coordinates,
          feature: comp as unknown as Record<string, unknown>,
          containerSize: { width: containerWidth, height: containerHeight },
        })
      }
    }
  }

  const handleActivityFocus = (event: LiveActivityEvent) => {
    onSelectActivity?.(event)
    const center = centerMapOnActivity(event)
    openActivityTarget(event, center)
    if (center) {
      mapRef.current?.easeTo({
        center,
        zoom: Math.max(mapRef.current?.getZoom() ?? 10.8, 12.4),
        duration: 620,
      })
    }
  }

  const handleActivitySelect = (event: LiveActivityEvent) => {
    onSelectActivity?.(event)
    const center = centerMapOnActivity(event)
    openActivityTarget(event, center)
  }

  return (
    <div
      ref={rootRef}
      style={mapThemeStyle}
      className={cls(
        'nx-icm',
        `nx-icm--${dockTier}`,
        `nx-icm--theme-${mapStyleMode}`,
        mapThemeRootClassName(mapStyleMode),
        activeThemeDefinition.overlayClassName,
        mapStyleMode === 'matrix' && 'matrix-grid-overlay matrix-control-panel matrix-card-scanline matrix-pin-glow',
        mapMode === 'command' && 'is-command-mode',
        `is-layout-${layoutMode}`,
        filtersOpen && 'is-controls-open',
        fullHeight && 'nx-icm--full',
        isUltrawide && 'is-ultrawide',
        liveActivitySettings.displayMode === 'hidden' && 'is-live-activity-hidden',
        liveActivitySettings.displayMode === 'docked' && 'is-live-activity-docked',
        isMobile && 'is-mobile-map',
      )}
    >
      {!commandMode && <div ref={controlsRef} className="nx-icm__toolbar">
        <div className="nx-icm__header">
          <div className="nx-icm__header-badge">
            <span>Live Map</span>
            <strong>{visiblePins.length}</strong>
          </div>
          <div className="nx-icm__header-actions">
            <button type="button" className={cls('nx-icm__mode-tab', filtersOpen && 'is-active')} onClick={() => setFiltersOpen((open) => !open)}>
              Map Controls
            </button>
          </div>
        </div>
        {filtersOpen && (
          <div className="nx-icm__controls-popover">
            <div className="nx-icm__controls-drawer-header">
              <div className="nx-icm__controls-drawer-title">
                <span className="nx-icm__controls-drawer-eyebrow">Map Command</span>
                <span className="nx-icm__controls-style-badge">{activeThemeDefinition.label}</span>
              </div>
              <button type="button" className="nx-icm__controls-close" aria-label="Close map controls" onClick={() => setFiltersOpen(false)}>✕</button>
            </div>
            <div className="nx-icm__controls-tabs" role="tablist" aria-label="Map controls tabs">
              {CONTROLS_TABS.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  className={cls('nx-icm__controls-tab', activeControlsTab === tab.key && 'is-active')}
                  onClick={() => setActiveControlsTab(tab.key)}
                >
                  {tab.key === 'filters' && activeFilterCount > 0 ? `Filters · ${activeFilterCount}` : tab.label}
                </button>
              ))}
            </div>
            <div className="nx-icm__controls-panel">
              {activeControlsTab === 'modes' && (
                <>
                  {/* Mode selector — premium 2-column cards */}
                  <div className="nx-icm__controls-group">
                    <div className="nx-icm__map-mode-grid">
                      {MAP_MODES.map((mode) => (
                        <button
                          key={mode.key}
                          type="button"
                          className={cls('nx-icm__map-mode-card', mapMode === mode.key && 'is-active')}
                          onClick={() => setMapMode(mode.key)}
                        >
                          <div className="nx-icm__map-mode-header">
                            <span className="nx-icm__map-mode-name">{mode.label}</span>
                            <div className="nx-icm__map-mode-swatches">
                              {mode.swatches.map((color) => (
                                <span key={color} className="nx-icm__map-mode-swatch" style={{ background: color }} />
                              ))}
                            </div>
                          </div>
                          <span className="nx-icm__map-mode-desc">{mode.description}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Active Overlays — mode-contextual */}
                  <div className="nx-icm__controls-group">
                    <div className="nx-icm__controls-headerline">
                      <span className="nx-icm__controls-label">Active Overlays</span>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button type="button" className={cls('nx-icm__mode-tab nx-icm__mode-tab--sm', sourceMode === 'all_active_coordinate_threads' && 'is-active')} onClick={() => onSourceModeChange?.('all_active_coordinate_threads')}>All</button>
                        <button type="button" className={cls('nx-icm__mode-tab nx-icm__mode-tab--sm', sourceMode === 'visible_threads' && 'is-active')} onClick={() => onSourceModeChange?.('visible_threads')}>Filtered</button>
                      </div>
                    </div>
                    <div className="nx-icm__layer-toggle-grid">
                      {mapMode === 'acquisition' && (<>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={sellerPinLayers.sellerPins} onChange={(e) => setSellerPinLayers((c) => ({ ...c, sellerPins: e.target.checked }))} /><span>Seller Leads</span></label>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={buyerLayers.sellerThreads} onChange={(e) => setBuyerLayers((c) => ({ ...c, sellerThreads: e.target.checked }))} /><span>Active Threads</span></label>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={sellerPinLayers.hot} onChange={(e) => setSellerPinLayers((c) => ({ ...c, hot: e.target.checked }))} /><span>Hot Sellers</span></label>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={sellerPinLayers.newReplies} onChange={(e) => setSellerPinLayers((c) => ({ ...c, newReplies: e.target.checked }))} /><span>New Replies</span></label>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={sellerPinLayers.negotiating} onChange={(e) => setSellerPinLayers((c) => ({ ...c, negotiating: e.target.checked }))} /><span>Negotiating</span></label>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={sellerPinLayers.issues} onChange={(e) => setSellerPinLayers((c) => ({ ...c, issues: e.target.checked }))} /><span>Issues / Urgent</span></label>
                      </>)}
                      {mapMode === 'buyer_demand' && (<>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={buyerLayers.buyerMatches} onChange={(e) => setBuyerLayers((c) => ({ ...c, buyerMatches: e.target.checked }))} /><span>Buyer Comps</span></label>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={buyerLayers.buyerHeatmap} onChange={(e) => setBuyerLayers((c) => ({ ...c, buyerHeatmap: e.target.checked }))} /><span>Buyer Heatmap</span></label>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={buyerLayers.repeatBuyers} onChange={(e) => setBuyerLayers((c) => ({ ...c, repeatBuyers: e.target.checked }))} /><span>Repeat Buyers</span></label>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={buyerLayers.corporateBuyers} onChange={(e) => setBuyerLayers((c) => ({ ...c, corporateBuyers: e.target.checked }))} /><span>Corp. Buyers</span></label>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={buyerLayers.localInvestors} onChange={(e) => setBuyerLayers((c) => ({ ...c, localInvestors: e.target.checked }))} /><span>Local Investors</span></label>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={buyerLayers.flippers} onChange={(e) => setBuyerLayers((c) => ({ ...c, flippers: e.target.checked }))} /><span>Flippers</span></label>
                      </>)}
                      {mapMode === 'opportunity_heat' && (<>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={sellerPinLayers.sellerPins} onChange={(e) => setSellerPinLayers((c) => ({ ...c, sellerPins: e.target.checked }))} /><span>Property Universe</span></label>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={buyerDemandLayers.investorDemand} onChange={(e) => setBuyerDemandLayers((c) => ({ ...c, investorDemand: e.target.checked }))} /><span>Motivation Heat</span></label>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={buyerDemandLayers.activity6mo} onChange={(e) => setBuyerDemandLayers((c) => ({ ...c, activity6mo: e.target.checked }))} /><span>Equity Heat</span></label>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={buyerDemandLayers.buyerHeat} onChange={(e) => setBuyerDemandLayers((c) => ({ ...c, buyerHeat: e.target.checked }))} /><span>Distress Heat</span></label>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={censusLayers.vacancyHeat} onChange={(e) => setSingleCensusMetric('vacancyHeat', e.target.checked)} /><span>Vacancy / Census</span></label>
                      </>)}
                      {mapMode === 'execution' && (<>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={sellerPinLayers.queued} onChange={(e) => setSellerPinLayers((c) => ({ ...c, queued: e.target.checked }))} /><span>Queued</span></label>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={sellerPinLayers.scheduled} onChange={(e) => setSellerPinLayers((c) => ({ ...c, scheduled: e.target.checked }))} /><span>Scheduled</span></label>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={sellerPinLayers.ready} onChange={(e) => setSellerPinLayers((c) => ({ ...c, ready: e.target.checked }))} /><span>Ready / Active</span></label>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={sellerPinLayers.sent} onChange={(e) => setSellerPinLayers((c) => ({ ...c, sent: e.target.checked }))} /><span>Sent</span></label>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={sellerPinLayers.delivered} onChange={(e) => setSellerPinLayers((c) => ({ ...c, delivered: e.target.checked }))} /><span>Delivered</span></label>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={sellerPinLayers.failedIssue} onChange={(e) => setSellerPinLayers((c) => ({ ...c, failedIssue: e.target.checked }))} /><span>Failed / Issues</span></label>
                      </>)}
                      {mapMode === 'comps' && (<>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={buyerLayers.recentSoldComps} onChange={(e) => setBuyerLayers((c) => ({ ...c, recentSoldComps: e.target.checked }))} /><span>Sold Comps</span></label>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={buyerLayers.buyerMatches} onChange={(e) => setBuyerLayers((c) => ({ ...c, buyerMatches: e.target.checked }))} /><span>Buyer Comps</span></label>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={buyerDemandLayers.soldPrice} onChange={(e) => setBuyerDemandLayers((c) => ({ ...c, soldPrice: e.target.checked }))} /><span>Sold Price Labels</span></label>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={buyerDemandLayers.activity6mo} onChange={(e) => setBuyerDemandLayers((c) => ({ ...c, activity6mo: e.target.checked }))} /><span>Activity 6mo</span></label>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={buyerLayers.buyerProfiles} onChange={(e) => setBuyerLayers((c) => ({ ...c, buyerProfiles: e.target.checked }))} /><span>Buyer Profiles</span></label>
                      </>)}
                      {(mapMode === 'territory') && (<>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={sellerPinLayers.sellerPins} onChange={(e) => setSellerPinLayers((c) => ({ ...c, sellerPins: e.target.checked }))} /><span>Property Universe</span></label>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={mapOverlays.zip} onChange={(e) => setMapOverlays((c) => ({ ...c, zip: e.target.checked }))} /><span>ZIP Boundaries</span></label>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={mapOverlays.cities} onChange={(e) => setMapOverlays((c) => ({ ...c, cities: e.target.checked }))} /><span>Cities</span></label>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={mapOverlays.roads} onChange={(e) => setMapOverlays((c) => ({ ...c, roads: e.target.checked }))} /><span>Roads</span></label>
                      </>)}
                      {mapMode === 'census' && CENSUS_TOGGLE_DEFS.map((def) => (
                        <label key={def.key} className="nx-icm__layer-toggle" style={{ '--layer-accent': def.color } as CSSProperties}>
                          <input type="checkbox" checked={censusLayers[def.key]} onChange={(e) => setSingleCensusMetric(def.key, e.target.checked)} />
                          <span>{def.label}</span>
                        </label>
                      ))}
                      {mapMode === 'command' && (<>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={sellerPinLayers.sellerPins} onChange={(e) => setSellerPinLayers((c) => ({ ...c, sellerPins: e.target.checked }))} /><span>Command Surface</span></label>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={sellerPinLayers.hot} onChange={(e) => setSellerPinLayers((c) => ({ ...c, hot: e.target.checked }))} /><span>Hot / Urgent</span></label>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={sellerPinLayers.newReplies} onChange={(e) => setSellerPinLayers((c) => ({ ...c, newReplies: e.target.checked }))} /><span>New Replies</span></label>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={sellerPinLayers.negotiating} onChange={(e) => setSellerPinLayers((c) => ({ ...c, negotiating: e.target.checked }))} /><span>Negotiating</span></label>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={sellerPinLayers.issues} onChange={(e) => setSellerPinLayers((c) => ({ ...c, issues: e.target.checked }))} /><span>Follow-Up / Issues</span></label>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={sellerPinLayers.queued} onChange={(e) => setSellerPinLayers((c) => ({ ...c, queued: e.target.checked }))} /><span>Live Automations</span></label>
                      </>)}
                    </div>
                  </div>

                  {/* Advanced Overlays — collapsed by default */}
                  <div className="nx-icm__controls-group nx-icm__advanced-layers">
                    <button type="button" className="nx-icm__advanced-toggle" onClick={() => setAdvancedLayersOpen((v) => !v)}>
                      <span className="nx-icm__controls-label">Advanced Overlays</span>
                      <span className="nx-icm__advanced-arrow">{advancedLayersOpen ? '▲' : '▼'}</span>
                    </button>
                    {advancedLayersOpen && (
                      <div className="nx-icm__layer-toggle-grid">
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={mapOverlays.roads} onChange={(e) => setMapOverlays((c) => ({ ...c, roads: e.target.checked }))} /><span>Roads</span></label>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={mapOverlays.cities} onChange={(e) => setMapOverlays((c) => ({ ...c, cities: e.target.checked }))} /><span>Cities</span></label>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={mapOverlays.poi} onChange={(e) => setMapOverlays((c) => ({ ...c, poi: e.target.checked }))} /><span>POI</span></label>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={mapOverlays.zip} onChange={(e) => setMapOverlays((c) => ({ ...c, zip: e.target.checked }))} /><span>ZIP</span></label>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={sellerPinLayers.notContacted} onChange={(e) => setSellerPinLayers((c) => ({ ...c, notContacted: e.target.checked }))} /><span>Not Contacted</span></label>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={sellerPinLayers.contacted} onChange={(e) => setSellerPinLayers((c) => ({ ...c, contacted: e.target.checked }))} /><span>Contacted</span></label>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={sellerPinLayers.positive} onChange={(e) => setSellerPinLayers((c) => ({ ...c, positive: e.target.checked }))} /><span>Raw Seller Signals</span></label>
                        <label className="nx-icm__layer-toggle"><input type="checkbox" checked={buyerLayers.offMarketBuyers} onChange={(e) => setBuyerLayers((c) => ({ ...c, offMarketBuyers: e.target.checked }))} /><span>Raw Buyer Signals</span></label>
                      </div>
                    )}
                  </div>

                  {/* Activity focus */}
                  <div className="nx-icm__controls-group">
                    <span className="nx-icm__controls-label">Activity Focus</span>
                    <div className="nx-icm__controls-segment">
                      {([
                        ['all', 'All'],
                        ['threads', 'Threads'],
                        ['sends', 'Sends'],
                        ['follow_ups', 'Follow-Ups'],
                      ] as Array<[InboxMapActivityMode, string]>).map(([value, label]) => (
                        <button key={value} type="button" className={cls('nx-icm__mode-tab', activityMode === value && 'is-active')} onClick={() => setActivityMode(value)}>
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
              {activeControlsTab === 'filters' && (
                <>
                  {/* Filter header — count + search */}
                  <div className="nx-icm__filter-header">
                    <div className="nx-icm__filter-header-meta">
                      {activeFilterCount > 0 && (
                        <span className="nx-icm__filter-active-count">{activeFilterCount} active</span>
                      )}
                    </div>
                    <input
                      className="nx-icm__filter-search"
                      type="search"
                      placeholder="Search 200+ filters..."
                      value={filterSearch}
                      onChange={(e) => setFilterSearch(e.target.value)}
                    />
                  </div>

                  {/* Preset segment chips */}
                  <div className="nx-icm__filter-preset-row">
                    {FILTER_PRESETS.map((preset) => (
                      <button key={preset.key} type="button" className="nx-icm__filter-preset-chip" onClick={() => setFilters((c) => ({ ...c, ...preset.filters }))}>
                        {preset.label}
                      </button>
                    ))}
                    {activeFilterCount > 0 && (
                      <button type="button" className="nx-icm__filter-preset-chip nx-icm__filter-preset-chip--clear" onClick={() => { setFilters(defaultFilters); setActiveKpiFilter(null) }}>
                        Clear {activeFilterCount}
                      </button>
                    )}
                  </div>

                  {/* Filter category tabs */}
                  <div className="nx-icm__filter-cat-tabs">
                    {FILTER_CATEGORIES.map((cat) => (
                      <button key={cat.key} type="button" className={cls('nx-icm__filter-cat-tab', filterCategory === cat.key && 'is-active')} onClick={() => setFilterCategory(cat.key)}>
                        {cat.label}
                      </button>
                    ))}
                  </div>

                  {/* Property filters */}
                  {filterCategory === 'property' && (
                    <>
                      <div className="nx-icm__controls-group">
                        <span className="nx-icm__controls-label">Asset &amp; Use</span>
                        <div className="nx-icm__filter-grid">
                          <select className="nx-icm__field" value={filters.propertyType} onChange={(e) => setFilters((c) => ({ ...c, propertyType: e.target.value }))}>
                            <option value="">All Asset Types</option>
                            {['SFR', '2–4 Units', '5+ Units', 'Storage', 'Retail', 'Office', 'Industrial', 'Land', 'Mixed Use'].map((t) => <option key={t} value={t}>{t}</option>)}
                          </select>
                        </div>
                      </div>
                      <div className="nx-icm__controls-group">
                        <span className="nx-icm__controls-label">Ownership</span>
                        <div className="nx-icm__layer-toggle-grid">
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Owner Occupied</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Absentee Owner</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Out-of-State</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Corporate Owner</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Trust Owner</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Ownership Yrs</span></label>
                        </div>
                      </div>
                      <div className="nx-icm__controls-group">
                        <span className="nx-icm__controls-label">Distress Signals</span>
                        <div className="nx-icm__layer-toggle-grid">
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Vacant</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Tax Delinquent</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Active Lien</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Foreclosure</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Pre-Foreclosure</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Auction</span></label>
                        </div>
                      </div>
                      <div className="nx-icm__controls-group">
                        <span className="nx-icm__controls-label">Scores</span>
                        <div className="nx-icm__layer-toggle-grid">
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Motivation Score</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Acq Score</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Deal Strength</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Distress Score</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Opp Score</span></label>
                        </div>
                      </div>
                      <div className="nx-icm__controls-group">
                        <span className="nx-icm__controls-label">Value &amp; Equity</span>
                        <div className="nx-icm__layer-toggle-grid">
                          <label className="nx-icm__layer-toggle"><input type="checkbox" checked={filters.highEquity} onChange={(e) => setFilters((c) => ({ ...c, highEquity: e.target.checked }))} /><span>High Equity</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Equity %</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Est Value</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Cash Offer</span></label>
                        </div>
                      </div>
                    </>
                  )}

                  {/* Prospect filters */}
                  {filterCategory === 'prospect' && (
                    <>
                      <div className="nx-icm__controls-group">
                        <div className="nx-icm__controls-headerline">
                          <span className="nx-icm__controls-label">KPI Focus</span>
                          <label className="nx-icm__checkbox" style={{ fontSize: 11, minHeight: 28 }}>
                            <input type="checkbox" checked={showKpiBadges} onChange={(e) => setShowKpiBadges(e.target.checked)} />
                            Badges
                          </label>
                        </div>
                        <div className="nx-icm__controls-segment">
                          {kpiChips.map((chip) => (
                            <button key={chip.key} type="button" className={cls('nx-icm__kpi-chip', activeKpiFilter === chip.key && 'is-active')} onClick={() => setActiveKpiFilter((c) => c === chip.key ? null : chip.key)} style={{ '--icm-kpi-tone': chip.tone } as CSSProperties}>
                              <span>{chip.label}</span><strong>{chip.count}</strong>
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="nx-icm__controls-group">
                        <span className="nx-icm__controls-label">Conversation</span>
                        <div className="nx-icm__filter-grid">
                          <select className="nx-icm__field" value={filters.market} onChange={(e) => setFilters((c) => ({ ...c, market: e.target.value }))}><option value="">All Markets</option>{markets.map((m) => <option key={m} value={m}>{m}</option>)}</select>
                          <select className="nx-icm__field" value={filters.stage} onChange={(e) => setFilters((c) => ({ ...c, stage: e.target.value }))}><option value="">All Stages</option>{stages.map((s) => <option key={s} value={s}>{LIFECYCLE_STAGE_META[s].shortLabel} {LIFECYCLE_STAGE_META[s].label}</option>)}</select>
                          <select className="nx-icm__field" value={filters.status} onChange={(e) => setFilters((c) => ({ ...c, status: e.target.value }))}><option value="">All Statuses</option>{statuses.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}</select>
                          <select className="nx-icm__field" value={filters.leadTemperature} onChange={(e) => setFilters((c) => ({ ...c, leadTemperature: e.target.value }))}><option value="">All Temps</option>{temperatures.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select>
                          <select className="nx-icm__field" value={filters.disposition} onChange={(e) => setFilters((c) => ({ ...c, disposition: e.target.value }))}><option value="">All Dispositions</option>{DISPOSITION_ORDER.map((d) => <option key={d} value={d}>{d.replace(/_/g, ' ')}</option>)}</select>
                          <select className="nx-icm__field" value={filters.contactability} onChange={(e) => setFilters((c) => ({ ...c, contactability: e.target.value }))}><option value="">All Contactability</option>{CONTACTABILITY_ORDER.map((c) => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}</select>
                        </div>
                        <div className="nx-icm__layer-toggle-grid" style={{ marginTop: 6 }}>
                          <label className="nx-icm__layer-toggle"><input type="checkbox" checked={filters.unreadOnly} onChange={(e) => setFilters((c) => ({ ...c, unreadOnly: e.target.checked }))} /><span>Unread</span></label>
                          <label className="nx-icm__layer-toggle"><input type="checkbox" checked={filters.followUpDue} onChange={(e) => setFilters((c) => ({ ...c, followUpDue: e.target.checked }))} /><span>Follow-Up Due</span></label>
                          <label className="nx-icm__layer-toggle"><input type="checkbox" checked={filters.archiveOnly} onChange={(e) => setFilters((c) => ({ ...c, archiveOnly: e.target.checked }))} /><span>Archived</span></label>
                          <label className="nx-icm__layer-toggle"><input type="checkbox" checked={filters.snoozeOnly} onChange={(e) => setFilters((c) => ({ ...c, snoozeOnly: e.target.checked }))} /><span>Snoozed</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Last Reply</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Last Inbound</span></label>
                        </div>
                      </div>
                      <div className="nx-icm__controls-group">
                        <span className="nx-icm__controls-label">Outreach</span>
                        <div className="nx-icm__filter-grid">
                          <select className="nx-icm__field" value={filters.automationStatus} onChange={(e) => setFilters((c) => ({ ...c, automationStatus: e.target.value }))}><option value="">All Automation</option>{automationStatuses.map((s) => <option key={s} value={s}>{s}</option>)}</select>
                        </div>
                        <div className="nx-icm__layer-toggle-grid" style={{ marginTop: 6 }}>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Last Contacted</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Touch Count</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Campaign</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Agent Persona</span></label>
                        </div>
                      </div>
                      <div className="nx-icm__controls-group">
                        <span className="nx-icm__controls-label">Contactability</span>
                        <div className="nx-icm__layer-toggle-grid">
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>SMS Eligible</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Has Phone</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Has Email</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Phone Conf.</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Excl. Suppressed</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Excl. DNC/Opt-Out</span></label>
                        </div>
                      </div>
                      <div className="nx-icm__controls-group">
                        <span className="nx-icm__controls-label">Intent Signals</span>
                        <div className="nx-icm__layer-toggle-grid">
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Positive</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Negotiating</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Price Mentioned</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Timeline Mentioned</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Not Interested</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Wrong Number</span></label>
                        </div>
                      </div>
                    </>
                  )}

                  {/* Owner filters */}
                  {filterCategory === 'owner' && (
                    <>
                      <div className="nx-icm__controls-group">
                        <span className="nx-icm__controls-label">Identity</span>
                        <div className="nx-icm__layer-toggle-grid">
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Individual</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Corporate</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Trust</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Institutional</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>HF Exclusion</span></label>
                        </div>
                      </div>
                      <div className="nx-icm__controls-group">
                        <span className="nx-icm__controls-label">Portfolio</span>
                        <div className="nx-icm__layer-toggle-grid">
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Portfolio Size</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Multi-Property</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Total Equity</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Landlord Signal</span></label>
                        </div>
                      </div>
                      <div className="nx-icm__controls-group">
                        <span className="nx-icm__controls-label">Location</span>
                        <div className="nx-icm__layer-toggle-grid">
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Mailing State</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Mailing City</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Out-of-State</span></label>
                        </div>
                      </div>
                      <div className="nx-icm__controls-group">
                        <span className="nx-icm__controls-label">Contact Quality</span>
                        <div className="nx-icm__layer-toggle-grid">
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Best Phone</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Best Email</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Phone Conf.</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Best Channel</span></label>
                        </div>
                      </div>
                    </>
                  )}

                  {/* Buyer filters */}
                  {filterCategory === 'buyer' && (
                    <>
                      {buyerFilters && (
                        <>
                          <datalist id="buyer-markets">{buyerFilterOptions.markets.map((v) => <option key={v} value={v} />)}</datalist>
                          <datalist id="buyer-property-types">{buyerFilterOptions.propertyTypes.map((v) => <option key={v} value={v} />)}</datalist>
                          <div className="nx-icm__controls-group">
                            <div className="nx-icm__controls-headerline">
                              <span className="nx-icm__controls-label">Buyer Activity</span>
                              <div style={{ display: 'flex', gap: 6 }}>
                                {buyerFilterCount > 0 && <span className="nx-icm__pill-note">{buyerFilterCount} active</span>}
                                <button type="button" className="nx-icm__mode-tab" onClick={clearBuyerFilters}>Clear</button>
                              </div>
                            </div>
                            <div className="nx-icm__filter-grid">
                              <select className="nx-icm__field" value={buyerFilters.activityWindowDays} onChange={(e) => onBuyerFiltersChange?.({ activityWindowDays: Number(e.target.value) as BuyerMapFilters['activityWindowDays'] })}>{[30, 90, 180, 365].map((d) => <option key={d} value={d}>{d}d window</option>)}</select>
                              <select className="nx-icm__field" value={buyerFilters.radiusMiles} onChange={(e) => onBuyerFiltersChange?.({ radiusMiles: Number(e.target.value) as BuyerMapFilters['radiusMiles'] })}>{[1, 3, 5, 10].map((m) => <option key={m} value={m}>{m} mi radius</option>)}</select>
                              <input className="nx-icm__field" list="buyer-markets" value={buyerFilters.market} onChange={(e) => onBuyerFiltersChange?.({ market: e.target.value })} placeholder="Market" />
                              <input className="nx-icm__field" list="buyer-property-types" value={buyerFilters.propertyType} onChange={(e) => onBuyerFiltersChange?.({ propertyType: e.target.value })} placeholder="Property Type" />
                            </div>
                          </div>
                        </>
                      )}
                      <div className="nx-icm__controls-group">
                        <span className="nx-icm__controls-label">Buyer Type</span>
                        <div className="nx-icm__layer-toggle-grid">
                          <label className="nx-icm__layer-toggle"><input type="checkbox" checked={buyerLayers.repeatBuyers} onChange={(e) => setBuyerLayers((c) => ({ ...c, repeatBuyers: e.target.checked }))} /><span>Repeat Buyer</span></label>
                          <label className="nx-icm__layer-toggle"><input type="checkbox" checked={buyerLayers.corporateBuyers} onChange={(e) => setBuyerLayers((c) => ({ ...c, corporateBuyers: e.target.checked }))} /><span>Corporate</span></label>
                          <label className="nx-icm__layer-toggle"><input type="checkbox" checked={buyerLayers.localInvestors} onChange={(e) => setBuyerLayers((c) => ({ ...c, localInvestors: e.target.checked }))} /><span>Local Investor</span></label>
                          <label className="nx-icm__layer-toggle"><input type="checkbox" checked={buyerLayers.flippers} onChange={(e) => setBuyerLayers((c) => ({ ...c, flippers: e.target.checked }))} /><span>Flipper</span></label>
                          <label className="nx-icm__layer-toggle"><input type="checkbox" checked={buyerLayers.builders} onChange={(e) => setBuyerLayers((c) => ({ ...c, builders: e.target.checked }))} /><span>Builder</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Retail Excl.</span></label>
                        </div>
                      </div>
                      <div className="nx-icm__controls-group">
                        <span className="nx-icm__controls-label">Asset Match</span>
                        <div className="nx-icm__layer-toggle-grid">
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Asset Type</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Units</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Sqft Range</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Year Built</span></label>
                        </div>
                      </div>
                      <div className="nx-icm__controls-group">
                        <span className="nx-icm__controls-label">Price Metrics</span>
                        <div className="nx-icm__layer-toggle-grid">
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>Purchase Price</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>PPSF</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>PPU</span></label>
                          <label className="nx-icm__layer-toggle is-placeholder"><input type="checkbox" disabled /><span>% of ARV</span></label>
                        </div>
                      </div>
                      {!buyerFilters && (
                        <div className="nx-icm__controls-group">
                          <p className="nx-icm__placeholder-note">Select a thread with buyer data to unlock comp filters.</p>
                        </div>
                      )}
                    </>
                  )}

                  {/* Saved segments */}
                  {filterCategory === 'saved' && (
                    <div className="nx-icm__controls-group">
                      <p className="nx-icm__placeholder-note">Saved segments coming soon. Build a filter set and pin it for instant recall.</p>
                    </div>
                  )}
                </>
              )}
              {activeControlsTab === 'style' && (
                <>
                  <div className="nx-icm__controls-group">
                    <span className="nx-icm__controls-label">Map Preset</span>
                    <div className="nx-icm__style-card-grid">
                      {CINEMATIC_THEME_DEFINITIONS.map((theme) => {
                        const themeData = COMMAND_MAP_THEME_OPTIONS.find((t) => t.id === theme.id)
                        if (!themeData) return null
                        return (
                          <button
                            key={theme.id}
                            type="button"
                            className={cls('nx-icm__style-card', mapStyleMode === theme.id && 'is-active')}
                            onClick={() => setMapStyleMode(theme.id)}
                          >
                            <span className="nx-icm__style-card-swatch" style={{ background: themeData.clusterPalette.core }} />
                            <div className="nx-icm__style-card-body">
                              <span className="nx-icm__style-card-name">{theme.label}</span>
                              <span className="nx-icm__style-card-desc">{theme.description}</span>
                            </div>
                            <div className="nx-icm__style-card-right">
                              {mapStyleMode === theme.id && <span className="nx-icm__style-card-check">✓</span>}
                              <span className="nx-icm__style-card-best-for">{theme.bestFor}</span>
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                  <div className="nx-icm__controls-group">
                    <span className="nx-icm__controls-label">Dimension</span>
                    <div className="nx-icm__controls-segment">
                      <button type="button" className={cls('nx-icm__mode-tab', mapDimension === '2d' && 'is-active')} onClick={() => setMapDimension('2d')}>2D</button>
                      <button type="button" className={cls('nx-icm__mode-tab', mapDimension === '3d' && 'is-active')} onClick={() => setMapDimension('3d')}>3D</button>
                    </div>
                  </div>
                  <div className="nx-icm__controls-group">
                    <span className="nx-icm__controls-label">Cinematic Controls</span>
                    <div className="nx-icm__cinematic-rows">
                      <div className="nx-icm__cinematic-row">
                        <span>Live Pulses</span>
                        <div style={{ display: 'flex', gap: 4 }}>
                          {(['off', 'subtle', 'full'] as const).map((v) => (
                            <button key={v} type="button" className={cls('nx-icm__mode-tab nx-icm__mode-tab--sm', cinematicControls.livePulses === v && 'is-active')} onClick={() => setCinematicControls((c) => ({ ...c, livePulses: v }))}>{v}</button>
                          ))}
                        </div>
                      </div>
                      <div className="nx-icm__cinematic-row">
                        <span>Pin Glow</span>
                        <div style={{ display: 'flex', gap: 4 }}>
                          {(['off', 'subtle', 'full'] as const).map((v) => (
                            <button key={v} type="button" className={cls('nx-icm__mode-tab nx-icm__mode-tab--sm', cinematicControls.pinGlow === v && 'is-active')} onClick={() => setCinematicControls((c) => ({ ...c, pinGlow: v }))}>{v}</button>
                          ))}
                        </div>
                      </div>
                      <div className="nx-icm__cinematic-row">
                        <span>Event Trail</span>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button type="button" className={cls('nx-icm__mode-tab nx-icm__mode-tab--sm', !cinematicControls.eventTrail && 'is-active')} onClick={() => setCinematicControls((c) => ({ ...c, eventTrail: false }))}>off</button>
                          <button type="button" className={cls('nx-icm__mode-tab nx-icm__mode-tab--sm', cinematicControls.eventTrail && 'is-active')} onClick={() => setCinematicControls((c) => ({ ...c, eventTrail: true }))}>on</button>
                        </div>
                      </div>
                      <div className="nx-icm__cinematic-row">
                        <span>Sound FX</span>
                        <div style={{ display: 'flex', gap: 4 }}>
                          {(['off', 'soft', 'full'] as const).map((v) => (
                            <button key={v} type="button" className={cls('nx-icm__mode-tab nx-icm__mode-tab--sm', cinematicControls.soundFx === v && 'is-active')} onClick={() => setCinematicControls((c) => ({ ...c, soundFx: v }))}>{v}</button>
                          ))}
                        </div>
                      </div>
                      <div className="nx-icm__cinematic-row">
                        <span>Map Atmosphere</span>
                        <div style={{ display: 'flex', gap: 4 }}>
                          {(['clean', 'cinematic', 'tactical'] as const).map((v) => (
                            <button key={v} type="button" className={cls('nx-icm__mode-tab nx-icm__mode-tab--sm', cinematicControls.mapAtmosphere === v && 'is-active')} onClick={() => setCinematicControls((c) => ({ ...c, mapAtmosphere: v }))}>{v}</button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                </>
              )}
              {activeControlsTab === 'intel' && (
                <>
                  {/* Panel visibility toggles — owns key/census/KPI globally */}
                  <div className="nx-icm__controls-group">
                    <span className="nx-icm__controls-label">Panel Visibility</span>
                    <div className="nx-icm__intel-panel-toggles">
                      <label className="nx-icm__intel-panel-toggle">
                        <input type="checkbox" checked={showLegendPanel} onChange={(e) => setShowLegendPanel(e.target.checked)} />
                        <div className="nx-icm__intel-panel-toggle-body">
                          <span>Show Map Key</span>
                          <small>Color legend overlay</small>
                        </div>
                      </label>
                      <label className="nx-icm__intel-panel-toggle">
                        <input type="checkbox" checked={showCensusDock} onChange={(e) => setShowCensusDock(e.target.checked)} />
                        <div className="nx-icm__intel-panel-toggle-body">
                          <span>Show Census Dock</span>
                          <small>Left-side census panel</small>
                        </div>
                      </label>
                    </div>
                  </div>

                  {/* Census Intelligence */}
                  <div className="nx-icm__controls-group">
                    <span className="nx-icm__controls-label">Census Intelligence</span>
                    <div className="nx-icm__census-toggle-grid">
                      {CENSUS_TOGGLE_DEFS.map((def) => (
                        <button
                          key={def.key}
                          type="button"
                          className={cls('nx-icm__census-toggle-btn', censusLayers[def.key] && 'is-active')}
                          style={{ '--census-accent': def.color } as CSSProperties}
                          onClick={() => setSingleCensusMetric(def.key, !censusLayers[def.key])}
                        >
                          <span className="nx-icm__census-toggle-dot" />
                          <span>{def.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Selected Property Intel */}
                  <div className="nx-icm__controls-group">
                    <span className="nx-icm__controls-label">Selected Property</span>
                    {selectedPin ? (
                      <div className="nx-icm__intel-property-rows">
                        <div className="nx-icm__intel-row"><span>Address</span><strong>{selectedPin.address || '—'}</strong></div>
                        <div className="nx-icm__intel-row"><span>Asset Type</span><strong>{selectedPin.property_type || '—'}</strong></div>
                        {selectedPin.motivation_score != null && (
                          <div className="nx-icm__intel-row"><span>Motivation</span><strong>{selectedPin.motivation_score}</strong></div>
                        )}
                        {selectedPin.final_acquisition_score != null && (
                          <div className="nx-icm__intel-row"><span>Acq Score</span><strong>{selectedPin.final_acquisition_score}</strong></div>
                        )}
                        {censusPanelModel.data?.investor_opportunity_score != null && (
                          <div className="nx-icm__intel-row"><span>Opp Score</span><strong>{censusPanelModel.data.investor_opportunity_score.toFixed(1)}</strong></div>
                        )}
                        {buyerCommandData?.summary && (
                          <>
                            <div className="nx-icm__intel-row"><span>Buyer Demand</span><strong>{buyerCommandData.summary.demandLabel}</strong></div>
                            <div className="nx-icm__intel-row"><span>Active Matches</span><strong>{buyerCommandData.summary.activeBuyerMatches}</strong></div>
                            <div className="nx-icm__intel-row"><span>Nearby Buys</span><strong>{buyerCommandData.summary.recentPurchasesNearby}</strong></div>
                          </>
                        )}
                      </div>
                    ) : (
                      <div className="nx-icm__intel-skeleton">
                        <span>Select a property on the map</span>
                      </div>
                    )}
                  </div>

                  {/* Area Signals */}
                  <div className="nx-icm__controls-group">
                    <span className="nx-icm__controls-label">Area Signals</span>
                    {censusPanelModel.data ? (
                      <div className="nx-icm__area-signal-list">
                        {(censusPanelModel.data.renter_occupied_percent ?? 0) > 0.5 && (
                          <div className="nx-icm__area-signal is-warning">High renter concentration</div>
                        )}
                        {(censusPanelModel.data.vacancy_rate ?? 0) > 0.1 && (
                          <div className="nx-icm__area-signal is-warning">High vacancy rate</div>
                        )}
                        {(censusPanelModel.data.owner_occupied_percent ?? 1) < 0.4 && (
                          <div className="nx-icm__area-signal is-warning">Low owner occupancy</div>
                        )}
                        {buyerCommandData?.summary && (buyerCommandData.summary.recentPurchasesNearby ?? 0) > 3 && (
                          <div className="nx-icm__area-signal is-positive">Strong buyer activity nearby</div>
                        )}
                        {(censusPanelModel.data.investor_opportunity_score ?? 0) > 70 && (
                          <div className="nx-icm__area-signal is-positive">High investor opportunity score</div>
                        )}
                        {!censusPanelModel.data.renter_occupied_percent && !censusPanelModel.data.vacancy_rate && (
                          <div className="nx-icm__intel-skeleton"><span>Census signals load with area data</span></div>
                        )}
                      </div>
                    ) : (
                      <div className="nx-icm__intel-skeleton">
                        <span>Select a property or region for area signals</span>
                      </div>
                    )}
                  </div>

                  {/* Map Legend — inline, no auto-show on drawer open */}
                  <div className="nx-icm__controls-group">
                    <span className="nx-icm__controls-label">Map Legend</span>
                    <div className="nx-icm__legend-grid is-expanded">
                      {(sellerPinLayers.sellerPins ? SELLER_PINS_LEGEND_ITEMS : MAP_LEGEND_ITEMS).map((item) => (
                        <div key={item.label} className="nx-icm__legend-row">
                          <span
                            className="nx-icm__legend-chip"
                            style={{
                              backgroundColor: 'isRing' in item && item.isRing ? 'transparent' : item.color,
                              border: 'isRing' in item && item.isRing ? `2px solid ${item.color}` : 'none',
                            }}
                          />
                          <span className="nx-icm__legend-label">{item.label}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
              {activeControlsTab === 'performance' && (
                <>
                  <div className="nx-icm__controls-group">
                    <span className="nx-icm__controls-label">Performance Mode</span>
                    <div className="nx-icm__controls-segment">
                      {(['auto', 'quality', 'balanced', 'speed'] as const).map((value) => (
                        <button key={value} type="button" className={cls('nx-icm__mode-tab', performanceSettings.performanceMode === value && 'is-active')} onClick={() => patchPerformanceSettings({ performanceMode: value })}>
                          {value}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="nx-icm__controls-grid">
                    <div className="nx-icm__controls-group">
                      <span className="nx-icm__controls-label">Marker Density</span>
                      <div className="nx-icm__controls-segment">
                        {(['low', 'medium', 'high'] as const).map((value) => (
                          <button key={value} type="button" className={cls('nx-icm__mode-tab', performanceSettings.markerDensity === value && 'is-active')} onClick={() => patchPerformanceSettings({ markerDensity: value })}>
                            {value}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="nx-icm__controls-group">
                      <span className="nx-icm__controls-label">Animation</span>
                      <div className="nx-icm__controls-segment">
                        {(['full', 'reduced', 'off'] as const).map((value) => (
                          <button key={value} type="button" className={cls('nx-icm__mode-tab', performanceSettings.animation === value && 'is-active')} onClick={() => patchPerformanceSettings({ animation: value })}>
                            {value}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="nx-icm__controls-grid">
                    <div className="nx-icm__controls-group">
                      <span className="nx-icm__controls-label">Live Activity</span>
                      <div className="nx-icm__controls-segment">
                        {(['hidden', 'minimal', 'compact', 'expanded', 'docked'] as const).map((value) => (
                          <button
                            key={value}
                            type="button"
                            className={cls('nx-icm__mode-tab', liveActivitySettings.displayMode === value && 'is-active')}
                            onClick={() => {
                              patchLiveActivitySettings({ visible: value !== 'hidden', displayMode: value })
                              patchPerformanceSettings({ liveActivityMode: value })
                            }}
                          >
                            {value}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="nx-icm__controls-group">
                      <span className="nx-icm__controls-label">Cluster</span>
                      <div className="nx-icm__controls-segment">
                        {(['low', 'medium', 'high'] as const).map((value) => (
                          <button key={value} type="button" className={cls('nx-icm__mode-tab', performanceSettings.clusterAggressiveness === value && 'is-active')} onClick={() => patchPerformanceSettings({ clusterAggressiveness: value })}>
                            {value}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="nx-icm__controls-group">
                    <span className="nx-icm__controls-label">Effects</span>
                    <div className="nx-icm__controls-segment">
                      <label className="nx-icm__checkbox">
                        <input type="checkbox" checked={performanceSettings.showHeatEffects} onChange={(e) => patchPerformanceSettings({ showHeatEffects: e.target.checked })} />
                        Heat Effects
                      </label>
                      <label className="nx-icm__checkbox">
                        <input type="checkbox" checked={liveActivitySettings.onlyCurrentBounds} onChange={(e) => patchLiveActivitySettings({ onlyCurrentBounds: e.target.checked })} />
                        Bounds-Locked Feed
                      </label>
                    </div>
                  </div>
                </>
              )}
            </div>
            <div className="nx-icm__controls-footer">
              <button type="button" className="nx-icm__mode-tab" onClick={() => {
                setFilters(defaultFilters)
                setActiveKpiFilter(null)
              }}>
                Clear Filters
              </button>
              <button type="button" className="nx-icm__mode-tab is-active" onClick={() => setFiltersOpen(false)}>
                Done
              </button>
            </div>
          </div>
        )}
      </div>}


      <div key={mapContainerKey} ref={containerRef} className="nx-icm__canvas" />

      {tempLocation && (
        <aside className="cc-map-dossier" style={{ position: 'absolute', top: '16px', right: '16px', zIndex: 10, width: '320px' }}>
          <div className="cc-map-dossier__top">
            <strong>{tempLocation.label}</strong>
            <span>{tempLocation.placeType || 'Location'}</span>
          </div>
          <span className="cc-map-dossier__address">
            {tempLocation.latitude.toFixed(4)}, {tempLocation.longitude.toFixed(4)}
          </span>
          <div className="cc-map-dossier__meta">
            <span>{tempLocation.source} source</span>
          </div>
          <div className="cc-map-dossier__actions">
            <button
              type="button"
              className="is-active"
              onClick={() => {
                if (tempMarkerRef.current) {
                  tempMarkerRef.current.remove()
                  tempMarkerRef.current = null
                }
                setTempLocation(null)
              }}
            >
              Dismiss
            </button>
            <button
              type="button"
              onClick={() => {
                window.dispatchEvent(new CustomEvent('nexus:command-action', { detail: { action: 'search-leads', location: tempLocation } }))
              }}
            >
              Find Leads
            </button>
          </div>
        </aside>
      )}

      <MapPropertyDiagnosticsOverlay
        diagnostics={mapPropertyDiagnostics}
        visible={isMapDiagnosticsDebugEnabled() && Boolean(mapPropertyDiagnostics)}
      />

      {(baseStyleLoading || sellerPinsLoading || styleFallbackWarning) && (
        <div className="nx-icm__map-status" aria-live="polite">
          {baseStyleLoading && <span className="nx-icm__map-status-pill">Loading {getCommandMapTheme(mapStyleMode).label} base style…</span>}
          {sellerPinsLoading && <span className="nx-icm__map-status-pill">Hydrating seller pins…</span>}
          {styleFallbackWarning && <span className="nx-icm__map-status-pill is-warning">{styleFallbackWarning}</span>}
        </div>
      )}

      {!filtersOpen && selectedThread && buyerCommandData?.summary && layoutMode !== 'compact' && (
        <aside className="nx-icm__buyer-demand-dock">
          <span className="nx-icm__buyer-demand-label">Buyer Demand</span>
          <strong>{buyerCommandData.summary.demandLabel}</strong>
          <small>{buyerCommandData.summary.topBuyerMatch} • {buyerCommandData.summary.activeBuyerMatches} matches • {buyerCommandData.summary.recentPurchasesNearby} nearby purchases</small>
          <div className="nx-icm__buyer-demand-actions">
            <button type="button" className={cls('nx-icm__mode-tab', buyerLayers.buyerRecentPurchases && 'is-active')} onClick={() => setBuyerLayers((current) => ({ ...current, buyerRecentPurchases: !current.buyerRecentPurchases }))}>
              Buyer Activity
            </button>
            <button type="button" className={cls('nx-icm__mode-tab', buyerLayers.buyerMatches && 'is-active')} onClick={() => setBuyerLayers((current) => ({ ...current, buyerMatches: !current.buyerMatches }))}>
              Matches
            </button>
            <button type="button" className={cls('nx-icm__mode-tab', buyerLayers.buyerHeatmap && 'is-active')} onClick={() => setBuyerLayers((current) => ({ ...current, buyerHeatmap: !current.buyerHeatmap }))}>
              Heatmap
            </button>
            <button type="button" className={cls('nx-icm__mode-tab', buyerLayers.repeatBuyers && 'is-active')} onClick={() => setBuyerLayers((current) => ({ ...current, repeatBuyers: !current.repeatBuyers }))}>
              Repeat
            </button>
            <button type="button" className={cls('nx-icm__mode-tab', buyerLayers.corporateBuyers && 'is-active')} onClick={() => setBuyerLayers((current) => ({ ...current, corporateBuyers: !current.corporateBuyers }))}>
              Corporate
            </button>
          </div>
          {buyerCommandData.summary.topMarkets.length > 0 && (
            <div className="nx-icm__buyer-selection-shell">
              <span className="nx-icm__buyer-demand-label">Top Buyer Markets</span>
              <div className="nx-icm__buyer-demand-actions">
                {buyerCommandData.summary.topMarkets.slice(0, 4).map((market) => (
                  <button
                    key={market}
                    type="button"
                    className={cls('nx-icm__mode-tab', buyerFilters?.market === market && 'is-active')}
                    onClick={() => onBuyerFiltersChange?.({ market })}
                  >
                    {market}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="nx-icm__buyer-selection-shell">
            <span className="nx-icm__buyer-demand-label">Top Buyers</span>
            {buyerCommandData.profilePoints.slice(0, 4).map((profile) => (
              <button
                key={profile.buyerKey}
                type="button"
                className={cls('nx-icm-buyer-card', selectedBuyerKey === profile.buyerKey && 'is-selected')}
                onClick={() => onSelectBuyerKey?.(profile.buyerKey)}
              >
                <div className="nx-icm-buyer-card__head">
                  <strong>{profile.buyerName}</strong>
                  <small>{profile.buyerGrade} • {profile.purchaseCount} buys</small>
                </div>
                <div className="nx-icm-buyer-card__summary">
                  <span>{profile.market || 'Market Unknown'}</span>
                  <strong>{formatCompactCurrency(profile.avgPurchasePrice)}</strong>
                </div>
              </button>
            ))}
          </div>
        </aside>
      )}

      {!filtersOpen && layoutMode !== 'compact' && showCensusDock && (
        <aside className="nx-icm__census-dock nx-icm__buyer-demand-dock" style={{ top: buyerCommandData?.summary ? '324px' : '94px', maxHeight: 'calc(100vh - 350px)', overflowY: 'auto' }}>
          <div className="nx-icm__dock-headline">
            <span className="nx-icm__buyer-demand-label" style={{ color: '#a78bfa' }}>Census Intelligence</span>
            <button type="button" className="nx-icm__mode-tab" onClick={() => setShowCensusDock(false)}>Hide</button>
          </div>
          {activeCensusMetric && (
            <strong>{censusOverlayLegend?.title || activeCensusMetric.replace(/_/g, ' ')}</strong>
          )}
          {censusOverlayLoading && <small>Refreshing visible geography overlay…</small>}
          {!censusOverlayLoading && censusOverlayMessage && <small>{censusOverlayMessage}</small>}
          <div className="nx-icm__buyer-demand-actions" style={{ marginTop: '8px', marginBottom: '12px' }}>
            {CENSUS_TOGGLE_DEFS.map((def) => (
              <button
                type="button"
                key={def.key}
                className={cls('nx-icm__mode-tab', censusLayers[def.key] && 'is-active')}
                style={censusLayers[def.key] ? { borderColor: def.color, boxShadow: `0 0 10px ${def.color}44` } : undefined}
                onClick={() => setSingleCensusMetric(def.key, !censusLayers[def.key])}
              >
                <span className="nx-icm__census-legend-dot" style={{ display: 'inline-block', width: '6px', height: '6px', borderRadius: '50%', background: def.color, marginRight: '6px' }} />
                {def.label}
              </button>
            ))}
          </div>
          <CensusIntelPanel
            data={censusPanelModel.data}
            styleMode={mapStyleMode}
            title={censusPanelModel.title}
            subtitle={censusPanelModel.subtitle}
            metrics={censusPanelModel.metrics}
            emptyMessage={censusPanelModel.emptyMessage}
          />
        </aside>
      )}

      {!filtersOpen && layoutMode !== 'compact' && showLegendPanel && (
        <aside className="nx-icm__legend-panel">
          <div className="nx-icm__dock-headline">
            <span className="nx-icm__buyer-demand-label">{activeCensusMetric ? 'Census Legend' : 'Map Legend'}</span>
            <button type="button" className="nx-icm__mode-tab" onClick={() => setShowLegendPanel(false)}>Hide</button>
          </div>
          {activeCensusMetric && censusOverlayLegend ? (
            <div className="nx-icm__census-legend-card">
              <strong>{censusOverlayLegend.title}</strong>
              <div className="nx-icm__census-legend-bar">
                {censusOverlayLegend.stops.map((stop) => <span key={`${stop.value}-${stop.color}`} style={{ background: stop.color }} />)}
              </div>
              <div className="nx-icm__census-legend-scale">
                <span>{censusOverlayLegend.lowLabel}</span>
                <span>{censusOverlayLegend.rangeLabel}</span>
                <span>{censusOverlayLegend.highLabel}</span>
              </div>
              {(selectedCensusFeature?.feature || hoveredCensusFeature?.feature) && (
                <div className="nx-icm__census-legend-focus">
                  <span>Focused Geography</span>
                  <strong>{(selectedCensusFeature?.feature || hoveredCensusFeature?.feature)?.name}</strong>
                </div>
              )}
            </div>
          ) : null}
          {sellerPinLayers.sellerPins && (
            <div className="nx-icm__census-legend-card" style={{ marginBottom: 12 }}>
              <strong>Seller Pins: {sellerPins.length.toLocaleString()} shown</strong>
              <div className="nx-icm__census-legend-scale" style={{ flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
                <span style={{ opacity: 0.8 }}>
                  Zoom {mapRef.current?.getZoom().toFixed(1) || '--'} · {sellerPinsPerf.cacheHit ? 'Cached' : 'Live'} · {sellerPinsPerf.loadedAt ? `${Math.max(0, Math.round((Date.now() - sellerPinsPerf.loadedAt) / 1000))}s ago` : '—'}
                </span>
                <span style={{ opacity: 0.8 }}>
                  Cap {sellerPinsPerf.cap.toLocaleString()} · {sellerPinsPerf.capHit ? 'Cap hit' : 'Under cap'} · RPC {sellerPinsPerf.rpcMs ?? '—'}ms
                </span>
                {sellerPinsLoading && <span style={{ color: '#38bdf8' }}>Loading new area...</span>}
                {sellerPinsPerf.sampled && !sellerPinsLoading && (
                  <span style={{ color: '#f59e0b' }}>Showing top {sellerPinsPerf.cap.toLocaleString()} sellers in viewport. Zoom in for more.</span>
                )}
              </div>
            </div>
          )}
          <div className="nx-icm__legend-grid">
            {(sellerPinLayers.sellerPins ? SELLER_PINS_LEGEND_ITEMS : MAP_LEGEND_ITEMS).map((item) => (
              <div key={item.label} className="nx-icm__legend-row">
                <span
                  className="nx-icm__legend-chip"
                  style={{
                    backgroundColor: 'isRing' in item && item.isRing ? 'transparent' : item.color,
                    border: 'isRing' in item && item.isRing ? `2px solid ${item.color}` : 'none'
                  }}
                />
                <span className="nx-icm__legend-label">{item.label}</span>
              </div>
            ))}
          </div>
        </aside>
      )}

      {emptyStateMessage && (
        <div className="nx-icm__no-pins-toast">
          <div className="nx-icm__no-pins-toast-body">
            <span className="nx-icm__no-pins-toast-title">No visible pins</span>
            <span className="nx-icm__no-pins-toast-sub">{emptyStateMessage}</span>
          </div>
          {selectedHiddenByFilters && selectedBasePin && (
            <button type="button" className="nx-icm__no-pins-toast-action" onClick={() => setShowSelectedHidden(true)}>
              Show Selected
            </button>
          )}
        </div>
      )}

      {!isMobile && selectedUnmapped ? (
        <div className="nx-icm__empty" style={{ top: '56px', left: '50%', transform: 'translateX(-50%)', padding: '12px 16px' }}>
          <div className="nx-icm__empty-title">Selected Conversation Is Unmapped</div>
          <p className="nx-icm__empty-sub">No coordinates are available for {selectedUnmapped.seller_name || 'this conversation'}.</p>
        </div>
      ) : null}

      {!isMobile && selectedHiddenByFilters && selectedBasePin && !showSelectedHidden ? (
        <div className="nx-icm__empty" style={{ top: '56px', left: '50%', transform: 'translateX(-50%)', padding: '12px 16px' }}>
          <div className="nx-icm__empty-title">Selected Hidden By Filters</div>
          <p className="nx-icm__empty-sub">The selected conversation has coordinates but is excluded by the current filters.</p>
          <button type="button" className="nx-icm__mode-tab is-active" onClick={() => setShowSelectedHidden(true)}>
            Show Selected
          </button>
        </div>
      ) : null}

      {dockTier === 'full' && showKpiBadges && !filtersOpen && !commandMode && <div className="nx-icm__overlay-kpis" aria-label="Map mode KPIs">
        {kpiChips.map((chip) => (
          <button
            key={chip.key}
            type="button"
            className={cls('nx-icm__overlay-kpi', activeKpiFilter === chip.key && 'is-active')}
            onClick={() => setActiveKpiFilter((current) => current === chip.key ? null : chip.key)}
            style={{ '--icm-kpi-tone': chip.tone } as CSSProperties}
          >
            <span>{chip.label}</span>
            <strong>{chip.count}</strong>
          </button>
        ))}
      </div>}

      {!commandMode && (
        <CommandMapLiveActivityRail
          feed={liveActivityFeed}
          settings={liveActivitySettings}
          isUltrawide={isUltrawide}
          isMobile={isMobile}
          reducedMotion={prefersReducedMotion || performanceSettings.animation !== 'full'}
          conversationOpen={mobileConversationOpen}
          composerActive={mobileConversationOpen}
          sellerCardExpanded={Boolean(activeSellerMapCard?.intent === 'selected')}
          sellerCardPeek={Boolean(activeSellerMapCard?.intent === 'hover')}
          onSettingsChange={patchLiveActivitySettings}
          onPerformanceChange={patchPerformanceSettings}
          onSelectEvent={handleActivitySelect}
          onFocusEvent={handleActivityFocus}
        />
      )}

      {selectedBuyerPurchase && (
        <div className="nx-icm__buyer-selection-shell">
          <BuyerSelectionCard
            purchase={selectedBuyerPurchase}
            purchases={selectedBuyerTrailPurchases}
            matches={buyerCommandData?.matches ?? []}
            profile={selectedBuyerProfile}
            onSelectBuyer={(buyerKey) => onSelectBuyerKeyRef.current?.(buyerKey)}
          />
        </div>
      )}

      {activeSellerMapCard ? (
        <MapEntityCard
          key={activeSellerMapCard.id}
          card={activeSellerMapCard}
          subject={selectedThread}
          onClose={() => {
            if (activeSellerMapCard.intent === 'selected' && isMobile) {
              setSelectedMapCard(null)
              setHoveredMapCard({
                ...activeSellerMapCard,
                intent: 'hover',
              })
              return
            }
            setSelectedMapCard(null)
            setHoveredMapCard(null)
            onBackgroundClickRef.current?.()
          }}
          onCenterMap={(lng, lat) => mapRef.current?.easeTo({ center: [lng, lat], zoom: Math.max(mapRef.current?.getZoom() ?? 11.8, 11.8), duration: 560 })}
          onPeekToFocus={() => {
            setSelectedMapCard({
              ...activeSellerMapCard,
              intent: 'selected',
            })
            setHoveredMapCard(null)
          }}
          sellerDraftText={quickReplyDraft}
          onSellerDraftChange={onQuickReplyDraftChange}
          onSellerSend={onQuickReplySend}
          sellerMessagingDisabled={quickReplyDisabled}
          clearHoverTimerRef={clearPinHoverTimerRef}
          cancelClearHover={() => {
            if (clearPinHoverTimerRef.current) {
              clearTimeout(clearPinHoverTimerRef.current)
              clearPinHoverTimerRef.current = null
            }
          }}
        />
      ) : null}

      {hoveredMapCard?.kind === 'sold_comp' && !selectedMapCard && (
        <MapEntityCard
          card={hoveredMapCard}
          subject={selectedThread}
          onClose={() => setHoveredMapCard(null)}
          onCenterMap={(lng, lat) => mapRef.current?.easeTo({ center: [lng, lat], zoom: Math.max(mapRef.current?.getZoom() ?? 11.8, 11.8), duration: 560 })}
          clearHoverTimerRef={clearPinHoverTimerRef}
          cancelClearHover={() => {
            if (clearPinHoverTimerRef.current) {
              clearTimeout(clearPinHoverTimerRef.current)
              clearPinHoverTimerRef.current = null
            }
          }}
        />
      )}

      {selectedMapCard?.kind === 'sold_comp' ? (
        <MapEntityCard
          card={selectedMapCard}
          subject={selectedThread}
          onClose={() => {
            setSelectedMapCard(null)
            onBackgroundClickRef.current?.()
          }}
          onCenterMap={(lng, lat) => mapRef.current?.easeTo({ center: [lng, lat], zoom: Math.max(mapRef.current?.getZoom() ?? 11.8, 11.8), duration: 560 })}
          onOpenCompIntel={() => {
            const comp = selectedMapCard.feature as unknown as RecentSoldComp
            setDealIntelSheet({ type: 'comp', comp })
          }}
          clearHoverTimerRef={clearPinHoverTimerRef}
          cancelClearHover={() => {
            if (clearPinHoverTimerRef.current) {
              clearTimeout(clearPinHoverTimerRef.current)
              clearPinHoverTimerRef.current = null
            }
          }}
        />
      ) : null}

      {dealIntelSheet && (
        <DealIntelligenceSideSheet
          data={dealIntelSheet}
          onClose={() => setDealIntelSheet(null)}
        />
      )}

      {mapContextLost && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 999, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'rgba(8,10,15,0.94)', gap: 12, padding: '0 24px', textAlign: 'center' }}>
          <p style={{ color: '#e2e8f0', margin: 0, fontSize: 14, fontWeight: 600 }}>Map renderer unavailable</p>
          <p style={{ color: '#94a3b8', margin: 0, fontSize: 13, maxWidth: 420 }}>
            {mapInitError || (mapWebglBlocked
              ? 'Chrome blocked WebGL on this tab after repeated graphics context loss. Reload the full page to restore the map.'
              : 'The command map paused its graphics context. Reload the map to continue.')}
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
            {mapWebglBlocked ? (
              <button
                type="button"
                className="nx-icm__mode-tab is-active"
                onClick={() => window.location.reload()}
              >
                Reload page
              </button>
            ) : (
              <button
                type="button"
                className="nx-icm__mode-tab is-active"
                onClick={() => {
                  mapContextLostRef.current = false
                  setMapInitError(null)
                  setMapWebglBlocked(false)
                  setMapContextLost(false)
                  const existing = mapRef.current
                  if (existing) {
                    try { existing.remove() } catch { /* ignore teardown errors */ }
                    mapRef.current = null
                  }
                  window.setTimeout(() => {
                    setMapContainerKey((k) => k + 1)
                    mapContainerKeyRef.current += 1
                  }, 200)
                }}
              >
                Reload map
              </button>
            )}
            {!mapWebglBlocked ? (
              <button
                type="button"
                className="nx-icm__mode-tab"
                onClick={() => window.location.reload()}
              >
                Reload page
              </button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}
