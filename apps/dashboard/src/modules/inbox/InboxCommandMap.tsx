import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { FeatureCollection, GeoJsonProperties, LineString, Point, Polygon } from 'geojson'
import { getThreadMessages, type ThreadMessage } from '../../lib/data/inboxData'
import type { InboxWorkflowThread } from '../../lib/data/inboxWorkflowData'
import type { MapSourceMode } from './inbox-layout-state'
import { buildConversationDecision } from './inbox-decisioning'
import { buildStreetViewUrl } from './inbox-normalization'
import type { ViewLayoutMode } from './view-layout'
import { SellerIntelligenceCard } from './components/SellerIntelligenceCard'
import {
  defaultBuyerMapFilters,
  type BuyerCommandData,
  type BuyerMapFilters,
  type BuyerProfilePoint,
  type BuyerRecentPurchase,
} from '../buyer/buyerCommandData'
import { loadBuyerDemandLayerPoints, type BuyerDemandMetric, type BuyerDemandLayerPoint, formatShortPrice } from '../../lib/data/buyerActivityMapData'
import { loadCensusForProperty, calculateInvestorOpportunityScore, type CensusData } from '../../lib/data/censusData'
import { loadSoldCompsInBounds, type RecentSoldComp, loadCommandMapSellerPinDetail, loadCommandMapSellerPins, type CommandMapSellerPin } from '../../lib/data/commandMapData'
import {
  centerMapOnActivity,
  loadLiveActivityFeed,
  type CommandMapActivityEvent,
  type CommandMapActivityPinSource,
  type CommandMapBounds,
  type CommandMapPerformanceSettings,
} from './commandMapLiveActivity'
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
  type MapStyleMode,
} from './commandMapThemes'
import { loadPropertyIcons, normalizePropertyTypeSlug, PIN_ICON } from '../dashboard/live/map/pin-icons'

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
  'seller-pins-icon',
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
  glow: 'seller-pins-glow',
  pulse: 'seller-pins-pulse',
  ring: 'seller-pins-ring',
  core: 'seller-pins-core',
  icon: 'seller-pins-icon',
  clusterGlow: 'seller-pins-cluster-glow',
  clusterCore: 'seller-pins-cluster-core',
  clusterCount: 'seller-pins-cluster-count',
} as const
const ALL_SELLER_PINS_LAYER_IDS = Object.values(SELLER_PINS_LAYER_IDS)

const SELLER_PINS_SETTINGS_KEY = 'nexus.commandMap.sellerPinSettings.v2'
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

type ControlsTab = 'view' | 'seller_layers' | 'buyer_layers' | 'census' | 'filters' | 'map_style'

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
  { key: 'view', label: 'View' },
  { key: 'seller_layers', label: 'Seller Layers' },
  { key: 'buyer_layers', label: 'Buyer Layers' },
  { key: 'census', label: 'Census' },
  { key: 'filters', label: 'Filters' },
  { key: 'map_style', label: 'Map Style' },
]
const BUYER_SOURCE_OPTIONS = [
  ['off_market_buyer', 'Off-Market Buyer'],
  ['mls_buyer', 'MLS Buyer'],
  ['public_record_buyer', 'Public Record Buyer'],
  ['repeat_buyer', 'Repeat Buyer'],
  ['cash_buyer', 'Cash Buyer'],
  ['hard_money_buyer', 'Hard Money Buyer'],
  ['institutional_buyer', 'Institutional Buyer'],
  ['corporate_buyer', 'Corporate Buyer'],
  ['local_investor', 'Local Investor'],
  ['out_of_state_buyer', 'Out-of-State Buyer'],
  ['retail_noise', 'Retail / Noise'],
  ['builder', 'Builder'],
  ['landlord', 'Landlord'],
  ['flipper', 'Flipper'],
  ['wholesaler', 'Wholesaler'],
] as const
const BUYER_IDENTITY_OPTIONS = [
  ['llc_corp', 'LLC / Corp'],
  ['individual_buyer', 'Individual Buyer'],
] as const
const BUYER_ASSET_OPTIONS = [
  'Single Family',
  'Duplex',
  'Triplex',
  'Fourplex',
  'Multifamily 5+',
  'Commercial',
  'Land',
  'Mobile Home',
  'Condo',
  'Townhome',
  'Mixed Use',
  'Industrial',
  'Retail',
  'Office',
  'Storage',
] as const
const BUYER_DEAL_OPTIONS = [
  ['off_market', 'MLS vs Off-Market'],
  ['mls', 'MLS Buyer'],
  ['corporate_buyer', 'Buyer Paid Cash'],
] as const
const BUYER_MATCH_OPTIONS = [
  ['price_match', 'Price Match'],
  ['asset_match', 'Asset Match'],
  ['location_match', 'Location Match'],
  ['velocity_match', 'Velocity Match'],
] as const
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

const joinName = (...parts: Array<string | null | undefined>): string | null => {
  const value = parts.map((part) => text(part)).filter(Boolean).join(' ').trim()
  return value || null
}

const resolveSellerPinDisplayName = (record: Partial<CommandMapSellerPin>): string => (
  text(record.seller_display_name)
  || text(record.owner_display_name)
  || text(record.owner_name)
  || text((record as Record<string, unknown>).prospect_name as string)
  || text((record as Record<string, unknown>).contact_name as string)
  || text(record.entity_name)
  || joinName((record as Record<string, unknown>).first_name as string | null | undefined, (record as Record<string, unknown>).last_name as string | null | undefined)
  || text(record.seller_name)
  || 'Unknown Seller'
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
    text(pin.seller_display_name)
    || text(pin.owner_display_name)
    || text(pin.owner_name)
    || text(pin.entity_name)
    || text(pin.seller_name),
  )
  const hasAddress = Boolean(text(pin.property_address_full) || text(pin.property_address))
  const hasPhysical = [pin.total_bedrooms, pin.total_baths, pin.building_square_feet, pin.year_built].some((value) => nullIfZeroish(value ?? null) !== null)
  const hasFinancial = [pin.estimated_value, pin.equity_amount, pin.equity_percent, pin.estimated_repair_cost, pin.final_acquisition_score, pin.motivation_score].some((value) => nullIfZeroish(value ?? null) !== null)
  return !hasDisplayName || !hasAddress || (!hasPhysical && !hasFinancial)
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

const stageColor = (pin: CommandMapPin, styleMode: MapStyleMode = 'dark_ops'): string => {
  const tone =
    styleMode === 'red_ops' ? {
      neutral: '#c8a3a0',
      engaged: '#ff8b7d',
      reply: '#ff6e66',
      positive: '#ffb07a',
      negotiating: '#ff7f93',
      hot: '#ffd166',
      issue: '#ff3b30',
      contract: '#ff9f8a',
      offer: '#ffba7a',
      overdue: '#ff4d4d',
    } : styleMode === 'midnight' ? {
      neutral: '#8aa0c9',
      engaged: '#8fb3ff',
      reply: '#7fc8ff',
      positive: '#7ed9c3',
      negotiating: '#c0b3ff',
      hot: '#f3c96b',
      issue: '#ff7a7a',
      contract: '#7ec4d9',
      offer: '#c8b88b',
      overdue: '#ff8b8b',
    } : styleMode === 'blueprint' ? {
      neutral: '#7aa6b7',
      engaged: '#56c9df',
      reply: '#66e8f2',
      positive: '#54e6cf',
      negotiating: '#7dcff2',
      hot: '#9be7f8',
      issue: '#ff8c86',
      contract: '#6ac9df',
      offer: '#8de9f3',
      overdue: '#ff9f99',
    } : styleMode === 'light_street' ? {
      neutral: '#64748b',
      engaged: '#2563eb',
      reply: '#0ea5e9',
      positive: '#059669',
      negotiating: '#7c3aed',
      hot: '#ca8a04',
      issue: '#dc2626',
      contract: '#0f766e',
      offer: '#0891b2',
      overdue: '#dc2626',
    } : styleMode === 'terrain' ? {
      neutral: '#8a9a63',
      engaged: '#5c8d4c',
      reply: '#68a68e',
      positive: '#74c365',
      negotiating: '#8ea476',
      hot: '#c8a85d',
      issue: '#d66b5f',
      contract: '#7fa46b',
      offer: '#9db86f',
      overdue: '#d95b53',
    } : styleMode === 'minimal_black' ? {
      neutral: '#c0c8d2',
      engaged: '#aeb8c6',
      reply: '#d4dbe4',
      positive: '#c8d2de',
      negotiating: '#b8c2ce',
      hot: '#e2e8f0',
      issue: '#f08a8a',
      contract: '#d7dee8',
      offer: '#d0d8e2',
      overdue: '#ef7f7f',
    } : styleMode === 'acquisition_radar' ? {
      neutral: '#7bc7a2',
      engaged: '#62e0b0',
      reply: '#7cf7cf',
      positive: '#72ffb2',
      negotiating: '#98efc4',
      hot: '#c8ff7a',
      issue: '#ff7a7a',
      contract: '#8dffc3',
      offer: '#baff8f',
      overdue: '#ff6767',
    } : styleMode === 'matrix' ? {
      neutral: '#5f9f7f',
      engaged: '#00d88a',
      reply: '#3cffb0',
      positive: '#00ff88',
      negotiating: '#7de8b6',
      hot: '#c8ff4d',
      issue: '#ff3b3b',
      contract: '#00f79d',
      offer: '#9fff69',
      overdue: '#ff4747',
    } : {
      neutral: '#97a3b6',
      engaged: '#3b82f6',
      reply: '#38bdf8',
      positive: '#22c55e',
      negotiating: '#a855f7',
      hot: '#eab308',
      issue: '#ef4444',
      contract: '#14b8a6',
      offer: '#30d158',
      overdue: '#ff453a',
    }
  if (pin.activity_state === 'queued') return '#5d6a7b'
  if (pin.activity_state === 'sending' || pin.activity_state === 'sent') return tone.engaged
  if (pin.activity_state === 'delivered') return tone.positive
  if (pin.activity_state === 'failed' || pin.activity_state === 'opted_out' || pin.activity_state === 'queue_blocked') return tone.issue
  if (pin.activity_state === 'replied') return tone.reply
  if (pin.activity_state === 'overdue') return tone.overdue
  if (pin.activity_state === 'due_now') return tone.hot
  if (pin.activity_state === 'due_later_today') return tone.engaged
  if (pin.activity_state === 'due_tomorrow') return tone.contract
  if (pin.activity_state === 'stale_no_response') return tone.neutral
  if (pin.suppression_status !== 'clear') return tone.issue
  const stage = lower(pin.conversation_stage)
  if (stage.includes('contract')) return tone.contract
  if (stage.includes('offer_ready') || stage.includes('offer_sent') || stage.includes('offer')) return tone.offer
  if (stage.includes('negotiat') || stage.includes('seller_counter')) return tone.negotiating
  if (stage.includes('price_received')) return tone.negotiating
  if (stage.includes('price_discussion') || stage.includes('underwriting')) return tone.negotiating
  if (stage.includes('interest') || stage.includes('ownership')) return tone.reply
  if (stage.includes('new')) return tone.neutral
  return tone.neutral
}

const glowStrength = (priorityScore: number): number => {
  if (priorityScore >= 90) return 1
  if (priorityScore >= 70) return 0.8
  if (priorityScore >= 40) return 0.52
  return 0.2
}

const badgeColor = (pin: CommandMapPin, styleMode: MapStyleMode = 'dark_ops'): string => {
  if (pin.suppression_status !== 'clear') return stageColor({ ...pin, activity_state: 'failed' }, styleMode)
  if (lower(pin.contract_status).includes('active')) return stageColor({ ...pin, activity_state: 'due_tomorrow' }, styleMode)
  if (lower(pin.offer_status).includes('ready')) return stageColor({ ...pin, activity_state: 'delivered' }, styleMode)
  return stageColor(pin, styleMode)
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
  if (styleMode === 'matrix' || styleMode === 'acquisition_radar') {
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
  if (styleMode === 'midnight') {
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
  if (styleMode === 'minimal_black') {
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
    const darkOpsTheme = getCommandMapTheme('dark_ops')
    const darkStyleUrl = darkOpsTheme.mapStyleUrl
    if (!darkStyleUrl) return null
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

const isCustomLayer = (id?: string) => !id ? false : id.startsWith('command-') || id.startsWith('census-') || id.startsWith('buyer-demand-') || id.startsWith('sold-comps-')
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
    inbox_bucket: decision.inbox_bucket,
    lead_temperature: decision.lead_temperature,
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
  if (filters.stage && pin.conversation_stage !== filters.stage) return false
  if (filters.status && pin.conversation_status !== filters.status) return false
  if (filters.leadTemperature && pin.lead_temperature !== filters.leadTemperature) return false
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
        stageColor: stageColor(pin, styleMode),
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
        unreadRingColor: pin.unread && pin.last_message_direction === 'inbound' ? '#3b82f6' : 'transparent',
        offerRingColor: lower(pin.offer_status).includes('ready') || lower(pin.offer_status).includes('sent') ? '#30d158' : 'transparent',
        contractRingColor: lower(pin.contract_status).includes('active') ? '#14b8a6' : 'transparent',
        badgeColor: badgeColor(pin, styleMode),
        pinCount: 1,
        lockState: pin.suppression_status !== 'clear' ? 1 : 0,
        needsReviewBadge: pin.inbox_bucket === 'needs_review' ? 1 : 0,
        followUpDueBadge: pin.inbox_bucket === 'follow_up_due' || pin.activity_state === 'due_now' || pin.activity_state === 'due_later_today' || pin.activity_state === 'due_tomorrow' || pin.activity_state === 'overdue' ? 1 : 0,
        suppressedBadge: pin.suppression_status !== 'clear' ? 1 : 0,
        queueBlockedBadge: pin.activity_state === 'queue_blocked' ? 1 : 0,
        propTypeSlug: normalizePropertyTypeSlug(pin.property_type ?? ''),
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

const sanitizeStyleSpec = (style: maplibregl.StyleSpecification): maplibregl.StyleSpecification | null => {
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

const resolveStyle = (styleMode: MapStyleMode): maplibregl.StyleSpecification => {
  const theme = getCommandMapTheme(styleMode)
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
    case 'minimal_black': return 'map-theme-monochrome'
    case 'midnight': return 'map-theme-executive'
    case 'terrain': return 'map-theme-terrain'
    case 'acquisition_radar': return 'map-theme-night-vision'
    case 'light_street': return 'map-theme-light-street'
    default: return `map-theme-${String(styleMode).replace(/_/g, '-')}`
  }
}

const canvasFilterForTheme = (styleMode: MapStyleMode): string => {
  if (styleMode === 'red_ops') return 'sepia(0.9) hue-rotate(320deg) saturate(3) brightness(0.92) contrast(1.35)'
  if (styleMode === 'midnight') return 'sepia(0.55) hue-rotate(196deg) saturate(2.2) brightness(0.92) contrast(1.26)'
  if (styleMode === 'blueprint') return 'hue-rotate(172deg) saturate(3) brightness(0.96) contrast(1.32)'
  if (styleMode === 'light_street') return 'none'
  if (styleMode === 'terrain') return 'saturate(1.1) contrast(1.05)'
  if (styleMode === 'minimal_black') return 'grayscale(1) brightness(1.02) contrast(1.28)'
  if (styleMode === 'acquisition_radar') return 'hue-rotate(94deg) saturate(2.4) brightness(0.95) contrast(1.26)'
  if (styleMode === 'matrix') return 'hue-rotate(108deg) saturate(3) brightness(0.9) contrast(1.34)'
  if (styleMode === 'satellite') return 'none'
  return 'brightness(0.95) contrast(1.16) saturate(1.15)'
}

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

const sellerCardMaxWidthForLayout = (layoutMode: ViewLayoutMode): string => {
  if (layoutMode === 'compact') return '360px'
  if (layoutMode === 'medium') return '392px'
  if (layoutMode === 'expanded') return '420px'
  return '440px'
}

const buildHoverCardMarkup = (record: Record<string, unknown>, layoutMode: ViewLayoutMode): string =>
  renderToStaticMarkup(
    <SellerIntelligenceCard
      record={record}
      layoutMode={layoutMode}
      variant="hover"
    />,
  )

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
        <div class="nx-icm-hover__metric"><div class="nx-icm-hover__metric-copy"><span>Purchase Date</span><strong>${escapeHtml(buyer.saleDate ? formatRelative(buyer.saleDate) : 'Unknown')}</strong></div></div>
        <div class="nx-icm-hover__metric"><div class="nx-icm-hover__metric-copy"><span>Buyer Type</span><strong>${escapeHtml(buyer.buyerType || buyer.category || 'Investor')}</strong></div></div>
        <div class="nx-icm-hover__metric"><div class="nx-icm-hover__metric-copy"><span>Type / Asset</span><strong>${escapeHtml(buyer.propertyType || buyer.buyerActivitySignal || 'Buyer')}</strong></div></div>
        <div class="nx-icm-hover__metric"><div class="nx-icm-hover__metric-copy"><span>PPSF</span><strong>${buyer.pricePerSqft ? escapeHtml(formatCurrency(buyer.pricePerSqft)) : '—'}</strong></div></div>
        <div class="nx-icm-hover__metric"><div class="nx-icm-hover__metric-copy"><span>Source</span><strong>${escapeHtml(buyer.sourceLabel || 'Buyer')}</strong></div></div>
        <div class="nx-icm-hover__metric"><div class="nx-icm-hover__metric-copy"><span>Distance</span><strong>${buyer.distanceMiles ? `${buyer.distanceMiles.toFixed(1)} mi` : '—'}</strong></div></div>
        <div class="nx-icm-hover__metric"><div class="nx-icm-hover__metric-copy"><span>Match Score</span><strong>${buyer.matchScore ? `${Math.round(buyer.matchScore)}/100` : '—'}</strong></div></div>
        <div class="nx-icm-hover__metric"><div class="nx-icm-hover__metric-copy"><span>Activity</span><strong>${escapeHtml(buyer.buyerActivitySignal || buyer.market || 'Live')}</strong></div></div>
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
  const imageUrl = text(anyComp.streetview_image) || text(anyComp.map_image) || text(comp.satellite_image) || buildStreetViewUrl(comp.property_address_full) || ''
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

const buildSoldCompHoverMarkup = (comp: RecentSoldComp, styleMode: MapStyleMode, subject?: { latitude?: number | null; longitude?: number | null } | null, zoom: number = 14): string => {
  const intelligence = buildSoldCompPresentation(comp, subject, zoom)
  const themeStyle = cardThemeStyleAttr(styleMode)
  return `
  <article class="nx-icm-hover nx-icm-hover--sold-comp ${intelligence.variant === 'multifamily' ? 'is-multifamily' : 'is-residential'}" style="${escapeHtml(themeStyle)} --nx-sold-comp-accent:${escapeHtml(intelligence.accentHex)};">
    <div class="nx-sold-comp__body">
      <div class="nx-sold-comp__sold-header">
        <div class="nx-sold-comp__sold-type">${escapeHtml(intelligence.sourceLabel.toUpperCase())}</div>
        <div class="nx-sold-comp__hero">
          <div>
          <div class="nx-sold-comp__price">${escapeHtml(intelligence.salePrice)}</div>
            <p class="nx-sold-comp__eyebrow">Sold ${escapeHtml(intelligence.saleDate)}</p>
          </div>
        </div>
      </div>

      ${intelligence.imageUrl ? `
        <div class="nx-sold-comp__media">
          <img src="${escapeHtml(intelligence.imageUrl)}" alt="${escapeHtml(comp.property_address_full || 'Sold comp')} preview" loading="lazy" />
          <div class="nx-sold-comp__media-scrim"></div>
          <span class="nx-sold-comp__media-badge">${escapeHtml(intelligence.imageLabel)}</span>
        </div>
      ` : ''}

      <section class="nx-sold-comp__address-block">
        <div class="nx-sold-comp__address-topline">
          <div class="nx-sold-comp__address">${escapeHtml(comp.property_address_full || 'Property Unknown')}</div>
          <span class="nx-sold-comp__property-badge">${escapeHtml(intelligence.propertyLabel)}</span>
        </div>
        <div class="nx-sold-comp__meta-row">
          ${intelligence.distanceLabel ? `<span class="nx-sold-comp__distance">${escapeHtml(intelligence.distanceLabel)}</span>` : ''}
          ${intelligence.subtypeLabel ? `<span class="nx-sold-comp__dot"></span><span>${escapeHtml(intelligence.subtypeLabel)}</span>` : ''}
        </div>
      </section>

      <section class="nx-sold-comp__buyer-row">
        <div class="nx-sold-comp__buyer-avatar">${escapeHtml(intelligence.buyerInitials)}</div>
        <div class="nx-sold-comp__buyer-copy">
          <div class="nx-sold-comp__buyer-name">${escapeHtml(intelligence.buyerName)}</div>
          <div class="nx-sold-comp__badge-stack">
            <span class="nx-icm-hover__status nx-icm-hover__status--${intelligence.buyerTone}">${escapeHtml(intelligence.buyerType)}</span>
            <span class="nx-sold-comp__micro-pill">${escapeHtml(intelligence.entityLabel)}</span>
          </div>
        </div>
      </section>

      <section class="nx-sold-comp__metrics ${intelligence.variant === 'multifamily' ? 'is-multifamily' : 'is-residential'}">
        ${intelligence.headlineMetrics.map((metric) => `
          <div class="nx-sold-comp__metric ${metric.emphasis === 'accent' ? 'is-accent' : ''} ${metric.emphasis === 'hero' ? 'is-hero' : ''}">
            <span>${escapeHtml(metric.label)}</span>
            <strong>${escapeHtml(metric.value)}</strong>
          </div>
        `).join('')}
      </section>

      <section class="nx-sold-comp__metrics is-support ${intelligence.variant === 'multifamily' ? 'is-multifamily' : 'is-residential'}">
        ${intelligence.supportMetrics.map((metric) => `
          <div class="nx-sold-comp__metric ${metric.emphasis === 'accent' ? 'is-accent' : ''}">
            <span>${escapeHtml(metric.label)}</span>
            <strong>${escapeHtml(metric.value)}</strong>
          </div>
        `).join('')}
      </section>

      <section class="nx-sold-comp__chip-section">
        <div class="nx-sold-comp__chips">
          ${intelligence.intelligenceChips.map((chip) => `
            <div class="nx-sold-comp__chip ${chip.tone ? `is-${chip.tone}` : ''}">
              <span>${escapeHtml(chip.label)}</span>
              <strong>${escapeHtml(chip.value)}</strong>
            </div>
          `).join('')}
        </div>
        <p class="nx-sold-comp__why">${escapeHtml(intelligence.whyItMatters)}</p>
      </section>
    </div>
  </article>
`
}

const SoldCompSelectionCard = ({
  comp,
  subject,
  onCenterMap,
  onClose,
}: {
  comp: RecentSoldComp | null
  subject?: any | null
  onCenterMap: (lng: number, lat: number) => void
  onClose: () => void
}) => {
  if (!comp) return null
  const imageUrl = comp.streetview_image || comp.satellite_image || buildStreetViewUrl(comp.property_address_full) || ''
  
  const price = comp.mls_sold_price ?? comp.sale_price ?? 0
  const priceLabel = formatCurrency(price)
  const ppsf = comp.computed_ppsf ?? comp.arv_ppsf ?? (price && comp.building_square_feet ? Math.round(price / comp.building_square_feet) : null)
  
  const sourceLabel = comp.sale_source || 'Unknown Sale Source'
  const ownerLabel = comp.owner_type_label || 'Unknown Owner Type'
  const buyerLabel = comp.buyer_type_label || 'Unknown Buyer Type'

  const sectionLabelStyle: React.CSSProperties = {
    fontSize: '10px',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: 'rgba(255,255,255,0.4)',
    marginBottom: '12px',
    borderBottom: '1px solid rgba(255,255,255,0.1)',
    paddingBottom: '4px',
    display: 'block'
  }

  const dataRowStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '6px 0',
    borderBottom: '1px solid rgba(255,255,255,0.05)',
    fontSize: '13px'
  }

  const dataLabelStyle: React.CSSProperties = {
    opacity: 0.6
  }

  const dataValueStyle: React.CSSProperties = {
    fontWeight: 600
  }

  const distance = (subject?.latitude && subject?.longitude) 
    ? haversineMiles(subject.latitude, subject.longitude, comp.latitude, comp.longitude)
    : null

  return (
    <article className="nx-icm-buyer-card" style={{ 
      borderColor: '#ef4444', 
      width: '420px', 
      maxHeight: '90vh', 
      overflowY: 'auto',
      background: 'rgba(15, 12, 12, 0.98)',
      backdropFilter: 'blur(10px)',
      boxShadow: '0 20px 50px rgba(0,0,0,0.5)',
      padding: 0
    }}>
      <div style={{ position: 'relative', height: '180px', width: '100%' }}>
        {imageUrl ? (
          <img src={imageUrl} alt="Property" style={{ width: '100%', height: '100%', objectFit: 'cover' }} loading="lazy" />
        ) : (
          <div style={{ width: '100%', height: '100%', background: '#1a1a1a', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.2)' }}>No Preview Available</div>
        )}
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'linear-gradient(to bottom, rgba(0,0,0,0.4), transparent 40%, rgba(0,0,0,0.9))' }} />
        <button 
          type="button" 
          onClick={onClose}
          style={{ position: 'absolute', top: '12px', right: '12px', background: 'rgba(0,0,0,0.5)', border: '1px solid rgba(255,255,255,0.2)', color: '#fff', padding: '4px 12px', borderRadius: '4px', fontSize: '11px', cursor: 'pointer', zIndex: 10 }}
        >
          Close
        </button>
        <div style={{ position: 'absolute', bottom: '16px', left: '20px', zIndex: 5 }}>
          <div style={{ color: '#ef4444', fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', marginBottom: '4px' }}>
            {sourceLabel} • {comp.sale_date ? new Date(comp.sale_date).toLocaleDateString() : 'Unknown Date'}
          </div>
          <div style={{ fontSize: '32px', fontWeight: 900, color: '#fff', letterSpacing: '-0.02em', lineHeight: 1 }}>{priceLabel}</div>
          <div style={{ fontSize: '14px', color: 'rgba(255,255,255,0.7)', marginTop: '4px' }}>{comp.property_address_full}</div>
        </div>
      </div>

      <div style={{ padding: '24px' }}>
        <div style={{ display: 'flex', gap: '8px', marginBottom: '24px' }}>
          <span style={{ background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', padding: '4px 8px', borderRadius: '2px', fontSize: '10px', fontWeight: 700, border: '1px solid rgba(239, 68, 68, 0.3)' }}>{ownerLabel}</span>
          <span style={{ background: comp.is_institutional_buyer ? 'rgba(168, 85, 247, 0.1)' : 'rgba(59, 130, 246, 0.1)', color: comp.is_institutional_buyer ? '#a855f7' : '#3b82f6', padding: '4px 8px', borderRadius: '2px', fontSize: '10px', fontWeight: 700, border: comp.is_institutional_buyer ? '1px solid rgba(168, 85, 247, 0.3)' : '1px solid rgba(59, 130, 246, 0.3)' }}>{buyerLabel}</span>
          {distance !== null && (
            <span style={{ background: 'rgba(255, 255, 255, 0.05)', color: 'rgba(255,255,255,0.6)', padding: '4px 8px', borderRadius: '2px', fontSize: '10px', fontWeight: 700, border: '1px solid rgba(255, 255, 255, 0.1)' }}>{distance.toFixed(2)} mi away</span>
          )}
        </div>

        <section style={{ marginBottom: '24px' }}>
          <label style={sectionLabelStyle}>Property Profile</label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 24px' }}>
            <div style={dataRowStyle}><span style={dataLabelStyle}>Type</span><span style={dataValueStyle}>{comp.property_type || '—'}</span></div>
            <div style={dataRowStyle}><span style={dataLabelStyle}>Class</span><span style={dataValueStyle}>{comp.normalized_asset_class || '—'}</span></div>
            <div style={dataRowStyle}><span style={dataLabelStyle}>Beds / Baths</span><span style={dataValueStyle}>{comp.total_bedrooms ?? '—'} / {comp.total_baths ?? '—'}</span></div>
            <div style={dataRowStyle}><span style={dataLabelStyle}>Sqft</span><span style={dataValueStyle}>{formatInteger(comp.building_square_feet)}</span></div>
            <div style={dataRowStyle}><span style={dataLabelStyle}>Units</span><span style={dataValueStyle}>{comp.units_count ?? 1}</span></div>
            <div style={dataRowStyle}><span style={dataLabelStyle}>Year Built</span><span style={dataValueStyle}>{comp.year_built ?? '—'}</span></div>
            <div style={dataRowStyle}><span style={dataLabelStyle}>Lot Size</span><span style={dataValueStyle}>{comp.lot_acreage ? `${comp.lot_acreage} ac` : comp.lot_square_feet ? `${formatInteger(comp.lot_square_feet)} sqft` : '—'}</span></div>
            <div style={dataRowStyle}><span style={dataLabelStyle}>Condition</span><span style={dataValueStyle}>{comp.building_condition || 'Average'}</span></div>
          </div>
        </section>

        <section style={{ marginBottom: '24px' }}>
          <label style={sectionLabelStyle}>Sale Intelligence</label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 24px' }}>
            <div style={dataRowStyle}><span style={dataLabelStyle}>MLS Sold Price</span><span style={dataValueStyle}>{formatCurrency(comp.mls_sold_price)}</span></div>
            <div style={dataRowStyle}><span style={dataLabelStyle}>Public Sale Price</span><span style={dataValueStyle}>{formatCurrency(comp.sale_price)}</span></div>
            <div style={dataRowStyle}><span style={dataLabelStyle}>Price / Sqft</span><span style={dataValueStyle}>{formatCurrency(ppsf)}</span></div>
            <div style={dataRowStyle}><span style={dataLabelStyle}>Deal Grade</span><span style={{ ...dataValueStyle, color: '#22c55e' }}>{comp.deal_grade || 'A'}</span></div>
            <div style={dataRowStyle}><span style={dataLabelStyle}>Confidence</span><span style={dataValueStyle}>{comp.comp_confidence_score ? `${Math.round(comp.comp_confidence_score)}/100` : '—'}</span></div>
            <div style={dataRowStyle}><span style={dataLabelStyle}>ARV Estimate</span><span style={dataValueStyle}>{formatCurrency(comp.arv_estimate)}</span></div>
          </div>
        </section>

        <section style={{ marginBottom: '24px' }}>
          <label style={sectionLabelStyle}>Buyer Intelligence</label>
          <div style={dataRowStyle}><span style={dataLabelStyle}>Owner/Buyer Name</span><span style={dataValueStyle}>{comp.owner_name || '—'}</span></div>
          <div style={dataRowStyle}><span style={dataLabelStyle}>Buyer Type</span><span style={dataValueStyle}>{buyerLabel}</span></div>
          {comp.is_institutional_buyer && (
            <>
              <div style={dataRowStyle}><span style={dataLabelStyle}>Institution Match</span><span style={{ ...dataValueStyle, color: '#a855f7' }}>{comp.institutional_match_name}</span></div>
              <div style={dataRowStyle}><span style={dataLabelStyle}>Match Method</span><span style={dataValueStyle}>{comp.institutional_match_method} ({comp.institutional_match_confidence})</span></div>
            </>
          )}
          <div style={dataRowStyle}><span style={dataLabelStyle}>Corporate Owner</span><span style={dataValueStyle}>{comp.is_corporate_owner ? 'YES' : 'NO'}</span></div>
        </section>

        {subject && (
          <section style={{ marginBottom: '24px' }}>
            <label style={sectionLabelStyle}>Comp Matching</label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 24px' }}>
              <div style={dataRowStyle}><span style={dataLabelStyle}>Distance</span><span style={dataValueStyle}>{distance?.toFixed(2)} mi</span></div>
              <div style={dataRowStyle}><span style={dataLabelStyle}>Similarity</span><span style={dataValueStyle}>{comp.comp_confidence_score ? `${Math.round(comp.comp_confidence_score)}%` : '—'}</span></div>
              <div style={dataRowStyle}><span style={dataLabelStyle}>Asset Class</span><span style={{ ...dataValueStyle, color: subject.normalized_asset_class === comp.normalized_asset_class ? '#22c55e' : '#ef4444' }}>{subject.normalized_asset_class === comp.normalized_asset_class ? 'MATCH' : 'MISMATCH'}</span></div>
              <div style={dataRowStyle}><span style={dataLabelStyle}>Sqft Delta</span><span style={dataValueStyle}>{Math.abs((subject.building_square_feet || 0) - (comp.building_square_feet || 0))} sqft</span></div>
              <div style={dataRowStyle}><span style={dataLabelStyle}>Beds Match</span><span style={dataValueStyle}>{subject.total_bedrooms === comp.total_bedrooms ? 'YES' : 'NO'}</span></div>
              <div style={dataRowStyle}><span style={dataLabelStyle}>Year Delta</span><span style={dataValueStyle}>{comp.year_built && subject.year_built ? Math.abs(comp.year_built - subject.year_built) : '—'} yrs</span></div>
            </div>
          </section>
        )}

        {!subject && (
          <div style={{ padding: '12px', background: 'rgba(59, 130, 246, 0.1)', border: '1px solid rgba(59, 130, 246, 0.3)', borderRadius: '4px', fontSize: '11px', color: '#3b82f6', marginBottom: '24px', textAlign: 'center' }}>
            Select a property to use this comp in ARV analysis.
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginTop: '32px' }}>
          <button 
            type="button" 
            className="nx-icm__mode-tab" 
            style={{ width: '100%', height: '40px', background: '#ef4444', color: '#fff', fontWeight: 700, border: 'none', opacity: subject ? 1 : 0.5 }}
            disabled={!subject}
            onClick={() => alert('TODO: Add ARV/Comp Intelligence UI connection')}
          >
            ADD TO ARV
          </button>
          <button 
            type="button" 
            className="nx-icm__mode-tab" 
            style={{ width: '100%', height: '40px', background: 'transparent', border: '1px solid rgba(255,255,255,0.2)', color: 'rgba(255,255,255,0.6)' }}
            onClick={() => alert('TODO: Add Exclude Comp UI connection')}
          >
            EXCLUDE COMP
          </button>
          <button 
            type="button" 
            className="nx-icm__mode-tab" 
            style={{ width: '100%', height: '40px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff' }}
            onClick={() => alert('TODO: Open Comp Intelligence View')}
          >
            INTEL VIEW
          </button>
          <button 
            type="button" 
            className="nx-icm__mode-tab" 
            style={{ width: '100%', height: '40px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff' }}
            onClick={() => onCenterMap(comp.longitude, comp.latitude)}
          >
            CENTER MAP
          </button>
        </div>
      </div>
    </article>
  )
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

const MiniThreadPopup = ({
  thread,
  messages,

  loading,
  draftText,
  disabled,
  onDraftChange,
  onSend,
  onClose,
  onOpenDealIntelligence,
  layoutMode,
}: {
  thread: InboxWorkflowThread | null
  messages: ThreadMessage[]
  loading: boolean
  draftText: string
  disabled: boolean
  onDraftChange: (value: string) => void
  onSend: () => void
  onClose: () => void
  onOpenDealIntelligence?: () => void
  layoutMode: ViewLayoutMode
}) => (
  <div onClick={(event) => event.stopPropagation()}>
    <SellerIntelligenceCard
      record={thread as Record<string, unknown> | null}
      layoutMode={layoutMode}
      variant="selected"
      messages={messages}
      loading={loading}
      draftText={draftText}
      disabled={disabled}
      onDraftChange={onDraftChange}
      onSend={onSend}
      onClose={onClose}
      onOpenDealIntelligence={onOpenDealIntelligence}
    />
  </div>
)

// ── Lightweight in-map conversation panel ────────────────────────────────────
// Renders the full SMS history for a contacted seller pin without requiring
// a navigation away from the map. Heavy ChatThread is intentionally not reused
// here because it needs a full InboxWorkflowThread and ships the operator rail,
// phase-3 intelligence, and action buttons that are out of scope for the popup.

const fmtTime = (iso: string): string => {
  try {
    const d = new Date(iso)
    const diff = (Date.now() - d.getTime()) / 1000
    if (diff < 60) return 'just now'
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  } catch {
    return ''
  }
}

const deliveryColor = (status: string): string => {
  const s = status.toLowerCase()
  if (s === 'delivered') return '#30d158'
  if (s === 'sent') return '#64d2ff'
  if (s === 'failed') return '#ff453a'
  if (s === 'queued' || s === 'approval') return '#ffd60a'
  return '#97a3b6'
}

const MapConversationPanel = ({
  pin,
  onOpenInbox,
  onOpenQueue,
}: {
  pin: CommandMapSellerPin
  onOpenInbox?: () => void
  onOpenQueue?: () => void
}) => {
  const threadKey = (pin as any).thread_key as string | null | undefined
  const [messages, setMessages] = useState<ThreadMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(false)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!threadKey) { setLoading(false); return }
    let cancelled = false
    setLoading(true)
    setErr(false)
    getThreadMessages(threadKey)
      .then((msgs) => { if (!cancelled) { setMessages(msgs); setLoading(false) } })
      .catch(() => { if (!cancelled) { setErr(true); setLoading(false) } })
    return () => { cancelled = true }
  }, [threadKey])

  useEffect(() => {
    if (!loading && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [messages, loading])

  const sellerName = pin.seller_name || 'Unknown Seller'
  const address = pin.property_address_full || ''

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0, background: 'rgba(8,14,24,0.97)', borderRadius: 12, border: '1px solid rgba(99,215,255,0.18)', overflow: 'hidden', maxHeight: 480, minWidth: 280 }}>
      {/* Compact header */}
      <div style={{ padding: '10px 12px 8px', borderBottom: '1px solid rgba(99,215,255,0.10)', flexShrink: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 13, color: '#e2e8f0', lineHeight: 1.3 }}>{sellerName}</div>
        {address && <div style={{ fontSize: 11, color: '#64748b', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{address}</div>}
        <div style={{ marginTop: 4, fontSize: 10, color: '#4d8fff', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
          {pin.sent_count ? `${pin.sent_count} sent` : 'Conversation'}
          {pin.latest_message_at ? ` · ${fmtTime(pin.latest_message_at)}` : ''}
        </div>
      </div>

      {/* Message list */}
      <div ref={listRef} style={{ flex: '1 1 0', overflowY: 'auto', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6, minHeight: 60, maxHeight: 320 }}>
        {loading && (
          <div style={{ textAlign: 'center', padding: '20px 0', color: '#64748b', fontSize: 12 }}>Loading conversation…</div>
        )}
        {!loading && err && (
          <div style={{ textAlign: 'center', padding: '16px 0', color: '#ff6b63', fontSize: 12 }}>Could not load messages. Open full inbox to view.</div>
        )}
        {!loading && !err && !threadKey && (
          <div style={{ textAlign: 'center', padding: '16px 0', color: '#64748b', fontSize: 12 }}>No thread key — open full inbox to view this conversation.</div>
        )}
        {!loading && !err && threadKey && messages.length === 0 && (
          <div style={{ textAlign: 'center', padding: '16px 0', color: '#64748b', fontSize: 12 }}>No messages found for this thread.</div>
        )}
        {messages.slice(-50).map((msg) => {
          const isOut = msg.direction === 'outbound'
          return (
            <div key={msg.id} style={{ display: 'flex', flexDirection: 'column', alignItems: isOut ? 'flex-end' : 'flex-start', gap: 2 }}>
              <div style={{
                maxWidth: '85%',
                padding: '6px 10px',
                borderRadius: isOut ? '10px 10px 2px 10px' : '10px 10px 10px 2px',
                background: isOut ? 'rgba(77,143,255,0.22)' : 'rgba(255,255,255,0.07)',
                border: `1px solid ${isOut ? 'rgba(77,143,255,0.3)' : 'rgba(255,255,255,0.09)'}`,
                fontSize: 12.5,
                lineHeight: 1.5,
                color: '#e2e8f0',
                wordBreak: 'break-word',
              }}>
                {msg.body || <em style={{ color: '#64748b' }}>No content</em>}
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', paddingInline: 2 }}>
                <span style={{ fontSize: 10, color: '#475569' }}>{fmtTime(msg.createdAt || msg.timelineAt)}</span>
                {isOut && msg.deliveryStatus && (
                  <span style={{ fontSize: 10, color: deliveryColor(msg.deliveryStatus) }}>{msg.deliveryStatus}</span>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Footer actions — read-only for now; full reply lives in inbox */}
      <div style={{ padding: '8px 10px', borderTop: '1px solid rgba(99,215,255,0.10)', display: 'flex', gap: 6, flexShrink: 0 }}>
        {onOpenInbox && (
          <button
            type="button"
            className="nx-seller-card__mini-action is-primary"
            style={{ flex: 1 }}
            onClick={onOpenInbox}
          >
            Open Full Inbox
          </button>
        )}
        {onOpenQueue && (
          <button
            type="button"
            className="nx-seller-card__mini-action"
            onClick={onOpenQueue}
          >
            Queue
          </button>
        )}
      </div>
    </div>
  )
}

type SellerPinCardMode = 'conversation' | 'queued' | 'uncontacted' | 'property'

const resolveEffectiveSellerState = (pin: Partial<CommandMapSellerPin>): string => {
  const normalized = lower(pin.seller_state).replace(/\s+/g, '_')
  const inboxCategory = lower(pin.inbox_category).replace(/\s+/g, '_')
  if (!normalized || normalized === 'none' || normalized === 'null' || normalized === 'unknown') {
    if (inboxCategory === 'not_contacted') return 'not_contacted'
    if (inboxCategory === 'new_reply') return 'new_reply'
    if (inboxCategory === 'needs_review') return 'issue'
    if (inboxCategory === 'suppressed' || inboxCategory === 'dnc_suppressed') return 'blocked'
    return 'not_contacted'
  }
  if (normalized === 'new_replies') return 'new_reply'
  if (normalized === 'positive') return 'positive_intent'
  return normalized
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
})

const resolveSellerPinCardMode = (pin: CommandMapSellerPin): SellerPinCardMode => {
  const state = resolveEffectiveSellerState(pin)
  const hasMsg = Boolean(pin.latest_message_at)
    || Number(pin.sent_count ?? 0) > 0
    || Number(pin.delivered_count ?? 0) > 0
    || (state !== '' && state !== 'not_contacted')
  if (hasMsg) return 'conversation'
  const hasQueue = Number(pin.queued_count ?? 0) > 0
    || Number(pin.scheduled_count ?? 0) > 0
    || Number(pin.ready_count ?? 0) > 0
    || lower(pin.execution_state).includes('queue')
    || lower(pin.execution_state).includes('scheduled')
    || lower(pin.execution_state).includes('ready')
  if (hasQueue) return 'queued'
  if (!state || state === 'not_contacted') return 'uncontacted'
  return 'property'
}

const MiniSellerPinPopup = ({
  pin,
  layoutMode,
  onClose,
  onOpenProperty,
  onOpenQueue,
  hydrating = false,
  hydrationFailed = false,
}: {
  pin: CommandMapSellerPin
  layoutMode: ViewLayoutMode
  onClose: () => void
  onOpenProperty?: () => void
  onOpenQueue?: () => void
  hydrating?: boolean
  hydrationFailed?: boolean
}) => {
  const mode = resolveSellerPinCardMode(pin)

  if (hydrating) {
    return (
      <div onClick={(event) => event.stopPropagation()} style={{ minWidth: 320, padding: '18px 16px', borderRadius: 12, background: 'rgba(8,14,24,0.97)', border: '1px solid rgba(99,215,255,0.18)', color: '#e2e8f0' }}>
        <strong style={{ display: 'block', marginBottom: 6 }}>Hydrating seller record…</strong>
        <p style={{ margin: 0, color: '#94a3b8', fontSize: 12 }}>Loading full owner and property context before opening the card.</p>
      </div>
    )
  }

  // Conversation mode: render the full SMS thread inline without any click-through.
  // The SellerIntelligenceCard header (property image, address, scores) is skipped
  // here to save vertical space in the popup — the conversation panel has its own
  // compact header.
  if (mode === 'conversation') {
    return (
      <div onClick={(event) => event.stopPropagation()} style={{ position: 'relative' }}>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{ position: 'absolute', top: 6, right: 8, zIndex: 1, background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', fontSize: 16, lineHeight: 1 }}
        >
          ×
        </button>
        <MapConversationPanel
          pin={pin}
          onOpenInbox={onOpenProperty}
          onOpenQueue={onOpenQueue ?? undefined}
        />
      </div>
    )
  }

  // Queued / uncontacted / property modes: show the seller intelligence card
  // with a contextual action strip beneath it.
  return (
    <div onClick={(event) => event.stopPropagation()}>
      <SellerIntelligenceCard
        record={pin as unknown as Record<string, unknown>}
        layoutMode={layoutMode}
        variant="selected"
        messages={[]}
        loading={false}
        disabled
        onClose={onClose}
        onOpenConversation={onOpenProperty}
      />

      {mode === 'queued' && (
        <div style={{ marginTop: 8, padding: '10px 12px', borderRadius: 10, background: 'rgba(15,23,38,0.94)', border: '1px solid rgba(245,185,76,0.22)' }}>
          <p style={{ margin: '0 0 6px', color: '#f5b94c', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            {lower(pin.execution_state) || 'Queued'} · {pin.next_scheduled_for ? `Scheduled ${new Date(pin.next_scheduled_for).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : 'Pending send'}
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {onOpenQueue && <button type="button" className="nx-seller-card__mini-action is-primary" onClick={onOpenQueue}>Open Queue</button>}
            <button type="button" className="nx-seller-card__mini-action" onClick={onOpenProperty}>Open Property</button>
          </div>
        </div>
      )}

      {mode === 'uncontacted' && (
        <div style={{ marginTop: 8, padding: '10px 12px', borderRadius: 10, background: 'rgba(15,23,38,0.94)', border: '1px solid rgba(148,163,184,0.22)' }}>
          <p style={{ margin: '0 0 6px', color: '#94a3b8', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em' }}>No outreach yet</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="nx-seller-card__mini-action is-primary" onClick={onOpenProperty}>Open Dossier</button>
            {onOpenQueue && <button type="button" className="nx-seller-card__mini-action" onClick={onOpenQueue}>View Queue</button>}
          </div>
        </div>
      )}

      {mode === 'property' && (
        <div style={{ marginTop: 8, padding: '10px 12px', borderRadius: 10, background: 'rgba(15,23,38,0.94)', border: '1px solid rgba(148,163,184,0.16)' }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="nx-seller-card__mini-action is-primary" onClick={onOpenProperty}>Open Property</button>
            {onOpenQueue && <button type="button" className="nx-seller-card__mini-action" onClick={onOpenQueue}>Open Queue</button>}
          </div>
        </div>
      )}

      {hydrationFailed && (
        <div style={{ marginTop: 8, padding: '10px 12px', borderRadius: 10, background: 'rgba(38,15,15,0.92)', border: '1px solid rgba(255,107,99,0.18)', color: '#ffd6d1', fontSize: 12 }}>
          Full hydration could not be loaded for this pin. Showing the best available seller record.
        </div>
      )}
    </div>
  )
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
}

const defaultFilters: MapFilterState = {
  market: '',
  stage: '',
  status: '',
  leadTemperature: '',
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

export function InboxCommandMap({
  threads,
  visibleThreads,
  buyerCommandData = null,
  buyerFilters = undefined,
  onBuyerFiltersChange,
  selectedBuyerKey = null,
  onSelectBuyerKey,
  selectedThread,
  selectedThreadMessages = [],
  selectedThreadMessagesLoading = false,
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
  initialActivityMode = 'threads',
  initialMapStyleMode = 'dark_ops',
  initialFilters,
  initialMapOverlays,
  onStateChange,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const controlsRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const animationRef = useRef<number | null>(null)
  const hoverPopupRef = useRef<maplibregl.Popup | null>(null)
  const threadPopupRef = useRef<maplibregl.Popup | null>(null)
  const threadPopupRootRef = useRef<Root | null>(null)
  const threadPopupHostRef = useRef<HTMLDivElement | null>(null)
  const activeThreadPopupRef = useRef<{ id: string; coordinates: [number, number] } | null>(null)
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
  useEffect(() => {
    selectedThreadRef.current = selectedThread
  }, [selectedThread])
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
  const [selectedPinId, setSelectedPinId] = useState<string | null>(selectedThread?.id ?? null)
  const [showSelectedHidden, setShowSelectedHidden] = useState(false)
  const [buyerLayers, setBuyerLayers] = useState<BuyerLayerToggles>(defaultBuyerLayerToggles)
  const [sellerPinLayers, setSellerPinLayers] = useState<SellerPinLayerToggles>(() => {
    try {
      const stored = localStorage.getItem(SELLER_PINS_SETTINGS_KEY)
      if (!stored) return defaultSellerPinLayers
      // Merge stored with defaults so any missing keys (e.g. notContacted from
      // an old save before the key existed) fall back to defaultSellerPinLayers
      // instead of being undefined (which is falsy and hides pins).
      return { ...defaultSellerPinLayers, ...JSON.parse(stored) }
    } catch {
      return defaultSellerPinLayers
    }
  })
  
  useEffect(() => {
    localStorage.setItem(SELLER_PINS_SETTINGS_KEY, JSON.stringify(sellerPinLayers))
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
  const sellerPinHydrationAbortRef = useRef<AbortController | null>(null)
  const sellerPinsFetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sellerPinsAbortRef = useRef<AbortController | null>(null)
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
  const [selectedSoldComp, setSelectedSoldComp] = useState<RecentSoldComp | null>(null)
  const [selectedThreadCensus, setSelectedThreadCensus] = useState<CensusData | null>(null)
  const [selectedBuyerPurchase, setSelectedBuyerPurchase] = useState<BuyerRecentPurchase | null>(null)
  const [hoveredClusterSummary, setHoveredClusterSummary] = useState<ClusterCensusSummary | null>(null)
  const [selectedClusterSummary, setSelectedClusterSummary] = useState<ClusterCensusSummary | null>(null)
  const [showLegendPanel, setShowLegendPanel] = useState(true)
  const [showCensusDock, setShowCensusDock] = useState(true)

  const [filtersOpen, setFiltersOpen] = useState(false)
  const [activeControlsTab, setActiveControlsTab] = useState<ControlsTab>('view')
  const [dockTier, setDockTier] = useState<'mini' | 'compact' | 'full'>('full')
  const [mapStyleMode, setMapStyleMode] = useState<MapStyleMode>(initialMapStyleMode)
  const [baseStyleLoading, setBaseStyleLoading] = useState(false)
  const [styleFallbackWarning, setStyleFallbackWarning] = useState<string | null>(null)

  const scheduleMapResize = () => {
    const map = mapRef.current
    if (!map) return
    const runResize = () => {
      try {
        map.resize()
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
  }
  const [mapDimension, setMapDimension] = useState<'2d' | '3d'>('2d')
  const [mapOverlays, setMapOverlays] = useState<MapOverlayToggles>({ ...defaultMapOverlays, ...initialMapOverlays })
  const [activeThreadPopup, setActiveThreadPopup] = useState<{ id: string; coordinates: [number, number] } | null>(null)
  const [activeSellerPinPopup, setActiveSellerPinPopup] = useState<{ pin: CommandMapSellerPin; coordinates: [number, number]; hydrating?: boolean; hydrationFailed?: boolean } | null>(null)
  const [showKpiBadges, setShowKpiBadges] = useState(true)
  const [activeKpiFilter, setActiveKpiFilter] = useState<MapKpiFilterKey | null>(null)
  const [viewportBounds, setViewportBounds] = useState<CommandMapBounds | null>(null)
  const [viewportZoom, setViewportZoom] = useState(zoomedIn ? 10.5 : 4.4)
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
    return hydratedThreadsById.get(selectedThread.id)
      || hydratedThreadsByKey.get(String((selectedThread as any).threadKey || selectedThread.id))
      || selectedThread
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
    () => visiblePins.find((pin) => pin.conversation_id === (selectedPinId || selectedHydratedThread?.id))
      ?? baseVisiblePins.find((pin) => pin.conversation_id === (selectedPinId || selectedHydratedThread?.id))
      ?? visiblePins[0]
      ?? baseVisiblePins[0]
      ?? selectedBasePin,
    [baseVisiblePins, selectedBasePin, selectedPinId, selectedHydratedThread?.id, visiblePins],
  )
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
  const popupThread = useMemo(() => {
    if (!activeThreadPopup?.id) return null
    return hydratedThreadsById.get(activeThreadPopup.id)
      || hydratedThreadsByKey.get(activeThreadPopup.id)
      || threads.find((thread) => thread.id === activeThreadPopup.id || String((thread as any).threadKey || '') === activeThreadPopup.id)
      || null
  }, [activeThreadPopup?.id, hydratedThreadsById, hydratedThreadsByKey, threads])
  const geojson = useMemo(
    () => featureCollectionForPins(visiblePins, selectedPin?.conversation_id ?? null, activeKpiFilter, mapStyleMode),
    [activeKpiFilter, mapStyleMode, visiblePins, selectedPin?.conversation_id],
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
      '--nx-map-canvas-filter': canvasFilterForTheme(mapStyleMode),
    } as CSSProperties),
    [activeThemeDefinition, mapStyleMode],
  )
  const toggleBuyerFilterArray = (
    key: 'buyerSourceTypes' | 'buyerRoles' | 'buyerIdentityTags' | 'assetTypes' | 'dealTypes' | 'locationTags' | 'matchTags',
    value: string,
  ) => {
    if (!buyerFilters) return
    const current = buyerFilters[key]
    const next = current.includes(value) ? current.filter((item) => item !== value) : [...current, value]
    onBuyerFiltersChange?.({ [key]: next } as Partial<BuyerMapFilters>)
  }
  const clearBuyerFilters = () => onBuyerFiltersChange?.(defaultBuyerMapFilters)
  const liveActivityEvents = useMemo(() => (
    loadLiveActivityFeed({
      pins: visiblePins as CommandMapActivityPinSource[],
      threadsById: hydratedThreadsById,
      buyerPurchases: filteredBuyerPurchases,
      soldComps,
      settings: liveActivitySettings,
      selectedMarket: filters.market || selectedPin?.market || null,
      bounds: viewportBounds,
      selectedThread: selectedHydratedThread,
    })
  ), [visiblePins, hydratedThreadsById, filteredBuyerPurchases, soldComps, liveActivitySettings, filters.market, viewportBounds, selectedHydratedThread, selectedPin?.market])
  const debugStats = useMemo(() => ({
    allPinsCount: allPins.length,
    filteredPinsCount: filteredPins.length,
    visiblePinsCount: visiblePins.length,
    buyerPurchasesCount: filteredBuyerPurchases.length,
    buyerProfilesCount: filteredBuyerProfiles.length,
    liveActivityEventsCount: liveActivityEvents.length,
    unmappedCount: pinPipeline.unmapped.length,
    activeMode: activityMode,
    activeFilters: filters,
  }), [activityMode, allPins.length, filteredBuyerProfiles.length, filteredBuyerPurchases.length, filteredPins.length, filters, liveActivityEvents.length, pinPipeline.unmapped.length, visiblePins.length])

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
  activeThreadPopupRef.current = activeThreadPopup
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
      setSelectedClusterSummary(null)
      setActiveSellerPinPopup(null)
    }
  }, [selectedThread?.id])

  useEffect(() => {
    if (!selectedThread || activeThreadPopup?.id !== selectedThread.id) return
    const pin = visiblePins.find((item) => item.conversation_id === selectedThread.id)
      || filteredPins.find((item) => item.conversation_id === selectedThread.id)
      || selectedBasePin
    if (!pin) return
    setActiveThreadPopup((current) => (
      current?.id === selectedThread.id
        ? { ...current, coordinates: [pin.lng, pin.lat] }
        : current
    ))
  }, [activeThreadPopup?.id, filteredPins, selectedBasePin, selectedThread, visiblePins])

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
    const map = mapRef.current
    if (!map || (!activeThreadPopup && !activeSellerPinPopup)) {
      threadPopupRootRef.current?.unmount()
      threadPopupRootRef.current = null
      threadPopupHostRef.current = null
      threadPopupRef.current?.remove()
      threadPopupRef.current = null
      return
    }

    if (!threadPopupHostRef.current) {
      threadPopupHostRef.current = document.createElement('div')
      threadPopupHostRef.current.className = 'nx-icm-thread-popup-host'
    }
    if (!threadPopupRootRef.current && threadPopupHostRef.current) {
      const host = threadPopupHostRef.current
      threadPopupRootRef.current = createRoot(host)
    }
    if (!threadPopupRootRef.current || !threadPopupHostRef.current) return

    const popupCoordinates = activeThreadPopup?.coordinates ?? activeSellerPinPopup?.coordinates
    const isSelectedThreadActive = Boolean(activeThreadPopup && selectedThread?.id === activeThreadPopup.id)
    const popupMessages = isSelectedThreadActive ? selectedThreadMessages : []
    const popupLoading = isSelectedThreadActive ? selectedThreadMessagesLoading : true
    const popupDraft = isSelectedThreadActive ? quickReplyDraft : ''
    const popupDisabled = !isSelectedThreadActive || quickReplyDisabled

    if (!threadPopupRootRef.current) return
    if (activeSellerPinPopup && !activeThreadPopup) {
      const sellerPin = activeSellerPinPopup.pin
      const hasQueue = Number(sellerPin.queued_count ?? 0) > 0
        || Number(sellerPin.scheduled_count ?? 0) > 0
        || Number(sellerPin.ready_count ?? 0) > 0
        || lower(sellerPin.execution_state).includes('queue')
        || lower(sellerPin.execution_state).includes('scheduled')
        || lower(sellerPin.execution_state).includes('ready')
      threadPopupRootRef.current.render(
        <MiniSellerPinPopup
          pin={sellerPin}
          layoutMode={layoutMode}
          hydrating={activeSellerPinPopup.hydrating}
          hydrationFailed={activeSellerPinPopup.hydrationFailed}
          onClose={() => setActiveSellerPinPopup(null)}
          onOpenProperty={() => {
            const propertyId = text((sellerPin as any).property_id)
            const masterOwnerId = text((sellerPin as any).master_owner_id || (sellerPin as any).owner_id || (sellerPin as any).seller_id || (sellerPin as any).prospect_id)
            onSelectSellerContextRef.current?.({
              propertyId: propertyId || undefined,
              masterOwnerId: masterOwnerId || undefined,
              sourceView: 'map',
              intent: 'open_seller',
            })
          }}
          onOpenQueue={hasQueue ? () => {
            const propertyId = text((sellerPin as any).property_id)
            const masterOwnerId = text((sellerPin as any).master_owner_id || (sellerPin as any).owner_id || (sellerPin as any).seller_id || (sellerPin as any).prospect_id)
            onSelectSellerContextRef.current?.({
              propertyId: propertyId || undefined,
              masterOwnerId: masterOwnerId || undefined,
              sourceView: 'map',
              intent: 'open_queue',
            })
          } : undefined}
        />,
      )
    } else {
      threadPopupRootRef.current.render(
        <MiniThreadPopup
          thread={popupThread}
          messages={popupMessages}
          loading={popupLoading}
          draftText={popupDraft}
          disabled={popupDisabled}
          layoutMode={layoutMode}
          onDraftChange={(value) => {
            if (!isSelectedThreadActive) return
            onQuickReplyDraftChange?.(value)
          }}
          onSend={() => {
            if (!isSelectedThreadActive || !popupDraft.trim()) return
            void onQuickReplySend?.(popupDraft)
          }}
          onClose={() => setActiveThreadPopup(null)}
          onOpenDealIntelligence={popupThread ? () => onOpenDealIntelligenceRef.current?.(popupThread.id) : undefined}
        />,
      )
    }

    const popup = threadPopupRef.current ?? new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      closeOnMove: false,
      offset: 18,
      className: 'nx-icm-thread-popup',
      maxWidth: sellerCardMaxWidthForLayout(layoutMode),
      focusAfterOpen: false,
    })

    popup
      .setLngLat(popupCoordinates as [number, number])
      .setDOMContent(threadPopupHostRef.current)
      .addTo(map)

    threadPopupRef.current = popup
  }, [
    activeThreadPopup,
    activeSellerPinPopup,
    onQuickReplyDraftChange,
    onQuickReplySend,
    popupThread,
    quickReplyDisabled,
    quickReplyDraft,
    selectedThread?.id,
    selectedThreadMessages,
    selectedThreadMessagesLoading,
  ])

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
    setActiveControlsTab((current) => current || 'view')
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
    const map = mapRef.current
    if (!map) return
    const onWindowResize = () => scheduleMapResize()
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') scheduleMapResize()
    }
    window.addEventListener('resize', onWindowResize)
    document.addEventListener('visibilitychange', onVisibilityChange)
    if (containerRef.current && typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => {
        scheduleMapResize()
      })
      observer.observe(containerRef.current)
      return () => {
        window.removeEventListener('resize', onWindowResize)
        document.removeEventListener('visibilitychange', onVisibilityChange)
        observer.disconnect()
      }
    }
    return () => {
      window.removeEventListener('resize', onWindowResize)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  useEffect(() => {
    scheduleMapResize()
  }, [filtersOpen, layoutMode, dockTier, fullHeight, commandMode])

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

  useEffect(() => {
    if (!activeSellerPinPopup) return
    if (activeSellerPinPopup.hydrating || activeSellerPinPopup.hydrationFailed) return
    const currentPin = activeSellerPinPopup.pin
    const propertyId = text(currentPin.property_id)
    if (!propertyId || !needsSellerPinHydration(currentPin)) {
      if (activeSellerPinPopup.hydrating) {
        setActiveSellerPinPopup((popup) => popup ? { ...popup, hydrating: false } : popup)
      }
      return
    }

    const cached = sellerPinDetailsCacheRef.current.get(propertyId)
    if (cached) {
      setActiveSellerPinPopup((popup) => {
        if (!popup || text(popup.pin.property_id) !== propertyId) return popup
        return { ...popup, pin: sanitizeSellerPinRecord({ ...popup.pin, ...cached }), hydrating: false, hydrationFailed: false }
      })
      return
    }

    sellerPinHydrationAbortRef.current?.abort()
    const controller = new AbortController()
    sellerPinHydrationAbortRef.current = controller
    setActiveSellerPinPopup((popup) => popup && text(popup.pin.property_id) === propertyId ? { ...popup, hydrating: true } : popup)

    loadCommandMapSellerPinDetail(propertyId, { signal: controller.signal })
      .then((detail) => {
        if (!detail) return
        const hydrated = sanitizeSellerPinRecord({ ...currentPin, ...detail })
        sellerPinDetailsCacheRef.current.set(propertyId, hydrated)
        setActiveSellerPinPopup((popup) => {
        if (!popup || text(popup.pin.property_id) !== propertyId) return popup
          return { ...popup, pin: hydrated, hydrating: false, hydrationFailed: false }
        })
      })
      .catch(() => {
        if (controller.signal.aborted) return
        setActiveSellerPinPopup((popup) => popup && text(popup.pin.property_id) === propertyId ? { ...popup, hydrating: false, hydrationFailed: true } : popup)
      })

    return () => controller.abort()
  }, [activeSellerPinPopup])

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
      const layers = map.getStyle()?.layers ?? []
      const tone = theme.baseStyleTone
      layers.forEach((layer) => {
        const typedLayer = layer as StyleLayerLike
        if (!typedLayer.id || isCustomLayer(typedLayer.id)) return
        const id = lower(typedLayer.id)
        const sourceLayer = lower(typedLayer['source-layer'])
        const token = `${id} ${sourceLayer}`

        try {
          if (typedLayer.type === 'background') {
            map.setPaintProperty(
              typedLayer.id,
              'background-color',
              tone === 'light_street' ? '#edf3f8'
                : tone === 'terrain' ? '#111613'
                  : tone === 'matrix' ? '#020805'
                    : tone === 'red_ops' ? '#14080a'
                      : tone === 'midnight' ? '#060b16'
                        : tone === 'blueprint' ? '#071821'
                          : tone === 'minimal_black' ? '#040506'
                            : tone === 'acquisition_radar' ? '#071510'
                              : '#070d15',
            )
          }
          if (typedLayer.type === 'fill') {
            const fillColor =
              tone === 'light_street'
                ? (token.includes('water') ? '#dbeafe' : token.includes('park') || token.includes('landcover') || token.includes('landuse') ? '#eaf4e8' : '#f8fbfd')
                : tone === 'terrain'
                  ? (token.includes('water') ? '#14241b' : token.includes('park') || token.includes('landcover') || token.includes('landuse') ? '#1d2818' : '#171a16')
                  : tone === 'matrix'
                    ? (token.includes('water') ? '#03120d' : token.includes('park') || token.includes('landcover') || token.includes('landuse') ? '#07150f' : '#050a08')
                    : tone === 'red_ops'
                      ? (token.includes('water') ? '#24090d' : token.includes('park') || token.includes('landcover') || token.includes('landuse') ? '#1b0d10' : '#18090b')
                      : tone === 'midnight'
                        ? (token.includes('water') ? '#09182d' : token.includes('park') || token.includes('landcover') || token.includes('landuse') ? '#101628' : '#0b1120')
                        : tone === 'blueprint'
                          ? (token.includes('water') ? '#082538' : token.includes('park') || token.includes('landcover') || token.includes('landuse') ? '#0c1f2a' : '#07131d')
                          : tone === 'minimal_black'
                            ? (token.includes('water') ? '#07090c' : token.includes('park') || token.includes('landcover') || token.includes('landuse') ? '#090c10' : '#040506')
                            : tone === 'acquisition_radar'
                              ? (token.includes('water') ? '#071f19' : token.includes('park') || token.includes('landcover') || token.includes('landuse') ? '#0a1814' : '#07110f')
                              : (token.includes('water') ? '#0e2034' : token.includes('park') || token.includes('landcover') || token.includes('landuse') ? '#0d1520' : '#0a1220')
            map.setPaintProperty(typedLayer.id, 'fill-color', fillColor)
            map.setPaintProperty(typedLayer.id, 'fill-opacity', tone === 'terrain' ? 0.18 : tone === 'light_street' ? 0.84 : tone === 'minimal_black' ? 0.96 : 0.9)
          }
          if (typedLayer.type === 'line') {
            const roadColor =
              tone === 'light_street'
                ? (token.includes('road') || token.includes('transport') || token.includes('highway') ? '#9aa7b7' : '#cbd5e1')
                : tone === 'terrain'
                  ? (token.includes('road') || token.includes('transport') || token.includes('highway') ? '#93a172' : '#45533a')
                  : tone === 'matrix'
                    ? (token.includes('road') || token.includes('transport') || token.includes('highway') ? '#0f7b4f' : '#114733')
                    : tone === 'red_ops'
                      ? (token.includes('road') || token.includes('transport') || token.includes('highway') ? '#8f2e34' : '#5a1d22')
                      : tone === 'midnight'
                        ? (token.includes('road') || token.includes('transport') || token.includes('highway') ? '#4e6fbf' : '#29375a')
                        : tone === 'blueprint'
                          ? (token.includes('road') || token.includes('transport') || token.includes('highway') ? '#4cb7df' : '#1f6d87')
                          : tone === 'minimal_black'
                            ? (token.includes('road') || token.includes('transport') || token.includes('highway') ? '#58616e' : '#2b3038')
                            : tone === 'acquisition_radar'
                              ? (token.includes('road') || token.includes('transport') || token.includes('highway') ? '#26b879' : '#175f45')
                              : '#3a81ae'
            map.setPaintProperty(typedLayer.id, 'line-color', roadColor)
            map.setPaintProperty(typedLayer.id, 'line-opacity', token.includes('road') || token.includes('highway') ? (tone === 'minimal_black' ? 0.66 : 0.9) : 0.72)
          }
          if (typedLayer.type === 'symbol') {
            const textColor =
              tone === 'light_street'
                ? (token.includes('postal') || token.includes('zip') ? '#475569' : token.includes('poi') ? '#64748b' : token.includes('place') || token.includes('city') || token.includes('town') ? '#0f172a' : '#334155')
                : tone === 'terrain'
                  ? (token.includes('postal') || token.includes('zip') ? '#f1e7ba' : token.includes('poi') ? '#cfdb9c' : token.includes('place') || token.includes('city') || token.includes('town') ? '#f7f5d0' : '#e4efb6')
                  : tone === 'matrix'
                    ? (token.includes('postal') || token.includes('zip') ? '#6debb0' : token.includes('poi') ? '#5ccf97' : token.includes('place') || token.includes('city') || token.includes('town') ? '#d8ffe8' : '#8bd6b0')
                    : tone === 'red_ops'
                      ? (token.includes('postal') || token.includes('zip') ? '#ffb7a8' : token.includes('poi') ? '#f28f82' : token.includes('place') || token.includes('city') || token.includes('town') ? '#ffd4c9' : '#d8898d')
                      : tone === 'midnight'
                        ? (token.includes('postal') || token.includes('zip') ? '#9cbcff' : token.includes('poi') ? '#8da8de' : token.includes('place') || token.includes('city') || token.includes('town') ? '#eef4ff' : '#b6caef')
                        : tone === 'blueprint'
                          ? (token.includes('postal') || token.includes('zip') ? '#95e5ff' : token.includes('poi') ? '#74d2f7' : token.includes('place') || token.includes('city') || token.includes('town') ? '#dff7ff' : '#9ccce0')
                          : tone === 'minimal_black'
                            ? (token.includes('postal') || token.includes('zip') ? '#a4b4c7' : token.includes('poi') ? '#8492a6' : token.includes('place') || token.includes('city') || token.includes('town') ? '#e2e8f0' : '#a4b0bf')
                            : tone === 'acquisition_radar'
                              ? (token.includes('postal') || token.includes('zip') ? '#98f8c6' : token.includes('poi') ? '#7ce9b2' : token.includes('place') || token.includes('city') || token.includes('town') ? '#e6fff0' : '#9fe4c2')
                              : (token.includes('postal') || token.includes('zip') ? '#9edfff' : token.includes('poi') ? '#7ed6ff' : token.includes('place') || token.includes('city') || token.includes('town') ? '#eef8ff' : '#9fbbd7')
            if (typedLayer.paint && 'text-color' in typedLayer.paint) map.setPaintProperty(typedLayer.id, 'text-color', textColor)
            if (typedLayer.paint && 'text-halo-color' in typedLayer.paint) map.setPaintProperty(typedLayer.id, 'text-halo-color', tone === 'light_street' ? 'rgba(255,255,255,0.96)' : tone === 'matrix' ? 'rgba(2,8,5,0.94)' : tone === 'red_ops' ? 'rgba(20,8,10,0.92)' : 'rgba(8,10,15,0.92)')
            if (typedLayer.paint && 'icon-color' in typedLayer.paint) map.setPaintProperty(typedLayer.id, 'icon-color', tone === 'light_street' ? '#64748b' : tone === 'matrix' ? '#00c46a' : tone === 'red_ops' ? '#ff7a72' : tone === 'blueprint' ? '#57d5ff' : tone === 'acquisition_radar' ? '#6affb7' : '#7ecfff')
          }
          if (typedLayer.type === 'raster') {
            const saturation =
              tone === 'satellite' ? -0.12
                : tone === 'light_street' ? 0
                  : tone === 'terrain' ? 0.18
                    : tone === 'minimal_black' ? -1
                      : tone === 'blueprint' ? 0.7
                        : tone === 'acquisition_radar' || tone === 'matrix' ? 0.34
                          : tone === 'red_ops' ? 0.02 : -0.28
            const contrast =
              tone === 'light_street' ? 0.04
                : tone === 'terrain' ? 0.12
                  : tone === 'minimal_black' ? 0.3
                    : tone === 'blueprint' ? 0.38
                      : tone === 'midnight' ? 0.22
                        : tone === 'red_ops' ? 0.34 : 0.24
            const brightnessMin =
              tone === 'light_street' ? 0.1
                : tone === 'satellite' ? 0.05
                  : tone === 'terrain' ? 0.05
                    : tone === 'matrix' ? 0.02
                      : tone === 'acquisition_radar' ? 0.03
                        : 0.02
            const brightnessMax =
              tone === 'light_street' ? 1
                : tone === 'satellite' ? 0.92
                  : tone === 'terrain' ? 0.84
                    : tone === 'matrix' ? 0.82
                      : tone === 'acquisition_radar' ? 0.84
                        : tone === 'blueprint' ? 0.68
                          : tone === 'minimal_black' ? 0.64
                            : tone === 'red_ops' ? 0.82 : 0.8
            const hueRotate =
              tone === 'red_ops' ? 320
                : tone === 'blueprint' ? 170
                  : tone === 'acquisition_radar' ? 100
                    : tone === 'matrix' ? 112
                      : 0
            map.setPaintProperty(typedLayer.id, 'raster-saturation', saturation)
            map.setPaintProperty(typedLayer.id, 'raster-contrast', contrast)
            map.setPaintProperty(typedLayer.id, 'raster-brightness-min', brightnessMin)
            map.setPaintProperty(typedLayer.id, 'raster-brightness-max', brightnessMax)
            map.setPaintProperty(typedLayer.id, 'raster-hue-rotate', hueRotate)
          }
        } catch {
          // Keep map resilient when a style layer lacks a property.
        }
      })
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
        tone === 'matrix' ? 'rgba(0, 176, 92, 0.13)'
          : tone === 'red_ops' ? 'rgba(146, 26, 32, 0.18)'
            : tone === 'blueprint' ? 'rgba(24, 120, 182, 0.15)'
              : tone === 'midnight' ? 'rgba(56, 88, 182, 0.12)'
                : tone === 'acquisition_radar' ? 'rgba(32, 134, 82, 0.15)'
                  : tone === 'minimal_black' ? 'rgba(0, 0, 0, 0.14)'
                    : tone === 'light_street' ? 'rgba(255, 255, 255, 0.01)'
                      : 'rgba(22, 56, 108, 0.11)'
      const tintOpacity =
        tone === 'light_street' ? 0
          : tone === 'minimal_black' ? 0.16
            : tone === 'midnight' ? 0.2
              : tone === 'red_ops' ? 0.26
                : tone === 'blueprint' ? 0.24
                  : tone === 'acquisition_radar' || tone === 'matrix' ? 0.26
                    : 0.16
      const showGrid = tone === 'matrix' || tone === 'blueprint'
      const showRadar = tone === 'matrix' || tone === 'acquisition_radar'

      if (map.getLayer(THEME_TINT_LAYER_ID)) {
        map.setPaintProperty(THEME_TINT_LAYER_ID, 'fill-color', tintColor)
        map.setPaintProperty(THEME_TINT_LAYER_ID, 'fill-opacity', theme.id === 'satellite' || theme.id === 'terrain' ? 0 : tintOpacity)
        map.setLayoutProperty(THEME_TINT_LAYER_ID, 'visibility', theme.id === 'satellite' || theme.id === 'terrain' ? 'none' : 'visible')
      }
      if (map.getLayer(THEME_GRID_LAYER_ID)) {
        map.setPaintProperty(THEME_GRID_LAYER_ID, 'line-color', tone === 'matrix' ? 'rgba(0, 255, 136, 0.14)' : 'rgba(105, 215, 255, 0.14)')
        map.setPaintProperty(THEME_GRID_LAYER_ID, 'line-opacity', showGrid ? 0.5 : 0)
        map.setLayoutProperty(THEME_GRID_LAYER_ID, 'visibility', showGrid ? 'visible' : 'none')
      }
      if (map.getLayer(THEME_RADAR_LAYER_ID)) {
        map.setPaintProperty(THEME_RADAR_LAYER_ID, 'line-color', tone === 'matrix' ? 'rgba(0, 255, 136, 0.18)' : 'rgba(114, 255, 178, 0.18)')
        map.setPaintProperty(THEME_RADAR_LAYER_ID, 'line-opacity', showRadar ? 0.44 : 0)
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

      if (darkStyle.glyphs && !map.getStyle().glyphs) {
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
          clusterRadius: 40,
          clusterMaxZoom: 11,
        })
      }

      if (!map.getLayer(SELLER_PINS_LAYER_IDS.glow)) {
        map.addLayer({
          id: SELLER_PINS_LAYER_IDS.glow,
          type: 'circle',
          source: SELLER_PINS_SOURCE_ID,
          filter: ['!', ['has', 'point_count']],
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 14, 12, 22],
            'circle-color': ['coalesce', ['get', 'pin_color'], '#38d0f0'],
            'circle-opacity': 0.18,
            'circle-blur': 1.0,
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
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 9, 12, 13],
            'circle-color': 'rgba(0,0,0,0)',
            'circle-stroke-color': ['coalesce', ['get', 'execution_ring_color'], ['get', 'pin_color'], 'rgba(56,208,240,0.4)'],
            'circle-stroke-width': 1.4,
            'circle-opacity': 0,
            'circle-stroke-opacity': 0.65,
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
            'circle-color': ['coalesce', ['get', 'pin_color'], '#38d0f0'],
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
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 3.2, 12, 5.2],
            'circle-color': ['coalesce', ['get', 'pin_color'], '#38d0f0'],
            'circle-opacity': 0,
            'circle-stroke-color': 'rgba(8,12,18,0)',
            'circle-stroke-width': 0,
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
            'icon-image': [
              'match', ['get', 'propTypeSlug'],
              'sfr',   PIN_ICON.sfr,
              'multi', PIN_ICON.multi,
              'apt',   PIN_ICON.apt,
              'land',  PIN_ICON.land,
              'comm',  PIN_ICON.comm,
              PIN_ICON.default,
            ],
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
            'icon-color': ['coalesce', ['get', 'pin_color'], '#38d0f0'],
            'icon-opacity': ['coalesce', ['get', 'focusOpacity'], 1],
            'icon-halo-color': ['coalesce', ['get', 'pin_color'], '#38d0f0'],
            'icon-halo-width': 1.2,
            'icon-halo-blur': 1.5,
          },
        } as maplibregl.LayerSpecification)
      }

      if (!map.getLayer(SELLER_PINS_LAYER_IDS.clusterGlow)) {
        map.addLayer({
          id: SELLER_PINS_LAYER_IDS.clusterGlow,
          type: 'circle',
          source: SELLER_PINS_SOURCE_ID,
          filter: ['has', 'point_count'],
          paint: {
            'circle-radius': ['step', ['get', 'point_count'], 26, 20, 34, 80, 42, 200, 52, 500, 62],
            'circle-color': [
              'step', ['get', 'point_count'],
              'rgba(56,208,240,0.06)',
              20,  'rgba(245,184,73,0.07)',
              80,  'rgba(212,64,76,0.08)',
            ],
            'circle-opacity': 1,
            'circle-blur': 1.2,
          },
          layout: { visibility: 'none' },
        })
      }

      if (!map.getLayer(SELLER_PINS_LAYER_IDS.clusterCore)) {
        map.addLayer({
          id: SELLER_PINS_LAYER_IDS.clusterCore,
          type: 'circle',
          source: SELLER_PINS_SOURCE_ID,
          filter: ['has', 'point_count'],
          paint: {
            'circle-radius': ['step', ['get', 'point_count'], 14, 20, 18, 80, 22, 200, 26, 500, 30],
            'circle-color': 'rgba(7,11,22,0.84)',
            'circle-stroke-color': [
              'step', ['get', 'point_count'],
              'rgba(56,208,240,0.62)',
              20,  'rgba(245,184,73,0.66)',
              80,  'rgba(212,64,76,0.72)',
            ],
            'circle-stroke-width': 1.5,
            'circle-opacity': 1,
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
            'icon-image': [
              'match', ['get', 'propTypeSlug'],
              'sfr',   PIN_ICON.sfr,
              'multi', PIN_ICON.multi,
              'apt',   PIN_ICON.apt,
              'land',  PIN_ICON.land,
              'comm',  PIN_ICON.comm,
              PIN_ICON.default,
            ],
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
              'circle-opacity': ['*', ['case', ['==', ['get', 'glowStrength'], 1], 0.44, ['>=', ['get', 'glowStrength'], 0.8], 0.32, ['>=', ['get', 'glowStrength'], 0.52], 0.22, 0.12], ['get', 'focusOpacity']],
              'circle-color': ['get', 'stageColor'],
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
              'circle-opacity': ['*', ['case', ['==', ['get', 'pulseMode'], 'none'], 0, ['match', ['get', 'pulseTier'], 'fast', 0.28, 'medium_fast', 0.22, 'medium', 0.18, 'slow', 0.12, 'very_slow', 0, 0]], ['get', 'focusOpacity']],
              'circle-color': ['get', 'stageColor'],
              'circle-stroke-width': ['case', ['==', ['get', 'pulseMode'], 'none'], 0, ['match', ['get', 'pulseTier'], 'fast', 1.8, 'medium_fast', 1.5, 'medium', 1.3, 'slow', 1.1, 'very_slow', 0, 0]],
              'circle-stroke-color': ['get', 'stageColor'],
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
              'icon-image': [
                'match', ['get', 'propTypeSlug'],
                'sfr',   PIN_ICON.sfr,
                'multi', PIN_ICON.multi,
                'apt',   PIN_ICON.apt,
                'land',  PIN_ICON.land,
                'comm',  PIN_ICON.comm,
                PIN_ICON.default,
              ],
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
              'icon-color': ['get', 'stageColor'],
              'icon-opacity': ['*', ['case', ['==', ['get', 'lockState'], 1], 0.9, 0.98], ['get', 'focusOpacity']],
              'icon-halo-color': ['get', 'stageColor'],
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
      syncLayerVisibility(map, activityModeRef.current)
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
        scheduleMapResize()
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

    const center: [number, number] = selectedPin ? [selectedPin.lng, selectedPin.lat] : [-96, 37.8]
    setBaseStyleLoading(true)
    styleLoadStartedAtRef.current = performance.now()
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: resolveStyle(mapStyleModeRef.current),
      center,
      zoom: zoomedIn ? 10.5 : 4.4,
      minZoom: 2,
      maxZoom: 18,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
    })
    mapRef.current = map
    activeBaseStyleIdRef.current = getCommandMapBaseStyleId(mapStyleModeRef.current)
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right')
    if (styleLoadTimerRef.current) clearTimeout(styleLoadTimerRef.current)
    styleLoadTimerRef.current = setTimeout(() => {
      if (styleFallbackGuardRef.current) return
      styleFallbackGuardRef.current = true
      const fallbackTheme = getCommandMapTheme(activeThemeRef.current.fallbackThemeId)
      setStyleFallbackWarning(`${activeThemeRef.current.label} failed to load cleanly. Falling back to ${fallbackTheme.label}.`)
      setMapStyleMode(fallbackTheme.id)
    }, 6500)

    const handleStyleReady = () => {
      addMapLayers(map)
      void syncBasemapPresentation(map)
      scheduleMapResize()
      const styleLoadMs = styleLoadStartedAtRef.current ? Math.round(performance.now() - styleLoadStartedAtRef.current) : null
      const reattachCount = customAttachmentCount(map)
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
          zoom: Number(map.getZoom().toFixed(2)),
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

    map.on('load', () => {
      handleStyleReady()

      const handlePinClick = (event: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        const feature = event.features?.[0]
        if (!feature) return
        const id = String(feature.properties?.conversation_id || '')
        if (!id) return
        hoverPopupRef.current?.remove()
        threadPopupRef.current?.remove()
        setSelectedClusterSummary(null)
        setSelectedCensusFeature(null)
        setActiveSellerPinPopup(null)
        setSelectedPinId(id)
        onSelectThreadIdRef.current?.(id)
        const coordinates = (feature.geometry as Point).coordinates as [number, number]
        setActiveThreadPopup({ id, coordinates })
        map.easeTo({ center: coordinates, zoom: Math.max(map.getZoom(), 12), duration: 700 })
      }

      const handleClusterClick = (event: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        const feature = event.features?.[0]
        if (!feature) return
        const clusterId = Number(feature.properties?.cluster_id)
        const coordinates = (feature.geometry as Point).coordinates as [number, number]
        setActiveThreadPopup(null)
        setActiveSellerPinPopup(null)
        setSelectedBuyerPurchase(null)
        setSelectedClusterSummary(null)
        if (Number.isFinite(clusterId)) {
          buildClusterSummaryFromLeaves(clusterId, coordinates, 'selected')
        }
        const source = map.getSource(CLUSTER_SOURCE_ID) as (maplibregl.GeoJSONSource & {
          getClusterExpansionZoom?: (id: number, cb: (error: Error | null, zoom: number) => void) => void
        }) | undefined
        if (!source?.getClusterExpansionZoom || !Number.isFinite(clusterId)) return
        source.getClusterExpansionZoom(clusterId, (error, zoom) => {
          if (error) return
          map.easeTo({
            center: coordinates,
            zoom,
            duration: 500,
          })
        })
      }

      const handlePinHover = (event: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        setHoveredClusterSummary(null)
        const feature = event.features?.[0]
        if (!feature?.properties) return
        const props = feature.properties as unknown as CommandMapPin
        const hydratedThread = hydratedThreadsByIdRef.current.get(props.conversation_id)
          || hydratedThreadsByKeyRef.current.get(props.conversation_id)
          || null
        const sellerRecord = { ...((hydratedThread as Record<string, unknown> | null) ?? {}), ...props }
        const coordinates = (feature.geometry as Point).coordinates as [number, number]
        const popup = hoverPopupRef.current ?? new maplibregl.Popup({
          closeButton: false,
          closeOnClick: false,
          offset: 18,
          className: 'nx-icm-hover-popup',
          maxWidth: sellerCardMaxWidthForLayout(layoutMode),
        })
        popup
          .setLngLat(coordinates)
          .setHTML(buildHoverCardMarkup(sellerRecord, layoutMode))
          .addTo(map)
        hoverPopupRef.current = popup
      }

      const clearPinHover = () => {
        hoverPopupRef.current?.remove()
        setHoveredClusterSummary(null)
      }

      const handleSellerPinHover = (event: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        setHoveredClusterSummary(null)
        const feature = event.features?.[0]
        if (!feature?.properties) return
        const props = sanitizeSellerPinRecord(feature.properties as unknown as Partial<CommandMapSellerPin>)
        const coordinates = (feature.geometry as Point).coordinates as [number, number]
        const popup = hoverPopupRef.current ?? new maplibregl.Popup({
          closeButton: false,
          closeOnClick: false,
          offset: 18,
          className: 'nx-icm-hover-popup',
          maxWidth: sellerCardMaxWidthForLayout(layoutMode),
        })
        popup
          .setLngLat(coordinates)
          .setHTML(buildHoverCardMarkup(props as Record<string, unknown>, layoutMode))
          .addTo(map)
        hoverPopupRef.current = popup
      }

      const handleSellerPinClusterClick = (event: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        const feature = event.features?.[0]
        if (!feature) return
        const clusterId = feature.properties?.cluster_id
        const coordinates = (feature.geometry as Point).coordinates as [number, number]
        const source = map.getSource(SELLER_PINS_SOURCE_ID) as (maplibregl.GeoJSONSource & {
          getClusterExpansionZoom?: (id: number, cb: (error: Error | null, zoom: number) => void) => void
        }) | undefined
        if (!source?.getClusterExpansionZoom || clusterId === undefined) return
        source.getClusterExpansionZoom(clusterId, (error, zoom) => {
          if (error) return
          map.easeTo({ center: coordinates, zoom: Math.max(zoom, map.getZoom() + 1), duration: 500 })
        })
      }

      const handleSellerPinClick = (event: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        const feature = event.features?.[0]
        if (!feature?.properties) return
        const props = sanitizeSellerPinRecord(feature.properties as unknown as Partial<CommandMapSellerPin>)
        const propertyId = String(props.property_id || '')
        if (!propertyId) return
        hoverPopupRef.current?.remove()
        threadPopupRef.current?.remove()
        setSelectedClusterSummary(null)
        setSelectedCensusFeature(null)
        setSelectedBuyerPurchase(null)
        setSelectedSoldComp(null)
        const coordinates = (feature.geometry as Point).coordinates as [number, number]
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

        if (matchedThread) {
          setSelectedPinId(matchedThread.id)
          onSelectThreadIdRef.current?.(matchedThread.id)
          setActiveThreadPopup({ id: matchedThread.id, coordinates })
          setActiveSellerPinPopup(null)
        } else {
          setSelectedPinId(propertyId)
          setActiveThreadPopup(null)
          setActiveSellerPinPopup({ pin: props, coordinates, hydrating: false, hydrationFailed: false })
        }

        // Only pan/zoom if the pin is outside the current viewport. Do NOT
        // force-zoom to 14: that causes a jarring recenter and resets the user's
        // zoom level, which is unexpected when the pin is already visible.
        const bounds = map.getBounds()
        const [pinLng, pinLat] = coordinates
        const isPinVisible = bounds.contains([pinLng, pinLat])
        if (!isPinVisible) {
          map.easeTo({ center: coordinates, duration: 500 })
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
          .addTo(map)
        hoverPopupRef.current = popup
      }

      const handleBuyerClick = (event: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        const feature = event.features?.[0]
        const props = feature?.properties as BuyerFeatureProps | undefined
        if (!feature || !props) return
        setSelectedClusterSummary(null)
        setSelectedCensusFeature(null)
        const exactPurchase = buyerPurchasesRef.current.find((purchase) =>
          purchase.buyerKey === props.buyerKey && purchase.propertyAddressFull === props.propertyAddressFull,
        ) || buyerPurchasesRef.current.find((purchase) => purchase.buyerKey === props.buyerKey) || null
        setSelectedBuyerPurchase(exactPurchase)
        onSelectBuyerKeyRef.current?.(props.buyerKey || null)
        const coordinates = (feature.geometry as Point).coordinates as [number, number]
        map.easeTo({ center: coordinates, zoom: Math.max(map.getZoom(), 11.8), duration: 560 })
      }

      const handleSoldCompHover = (event: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        const feature = event.features?.[0]
        const props = feature?.properties as RecentSoldComp | undefined
        if (!feature || !props) return
        const coordinates = (feature.geometry as Point).coordinates as [number, number]
        hoverPopupRef.current?.remove()
        const popup = new maplibregl.Popup({
          closeButton: false,
          closeOnClick: false,
          offset: 18,
          className: 'nx-icm-hover-popup',
          maxWidth: sellerCardMaxWidthForLayout(layoutMode),
        })
        popup
          .setLngLat(coordinates)
          .setHTML(buildSoldCompHoverMarkup(props, mapStyleModeRef.current, selectedThreadRef.current, map.getZoom()))
          .addTo(map)
        hoverPopupRef.current = popup
      }

      const handleSoldCompClick = (event: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        const feature = event.features?.[0]
        const props = feature?.properties as RecentSoldComp | undefined
        if (!feature || !props) return
        setSelectedClusterSummary(null)
        setSelectedCensusFeature(null)
        setSelectedBuyerPurchase(null)
        setSelectedSoldComp(props)
        const coordinates = (feature.geometry as Point).coordinates as [number, number]
        map.easeTo({ center: coordinates, zoom: Math.max(map.getZoom(), 11.8), duration: 560 })
      }

      const handleBuyerClusterClick = (event: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        const feature = event.features?.[0]
        if (!feature) return
        const clusterId = Number(feature.properties?.cluster_id)
        const source = map.getSource(BUYER_PURCHASE_SOURCE_ID) as (maplibregl.GeoJSONSource & {
          getClusterExpansionZoom?: (id: number, cb: (error: Error | null, zoom: number) => void) => void
        }) | undefined
        if (!source?.getClusterExpansionZoom || !Number.isFinite(clusterId)) return
        source.getClusterExpansionZoom(clusterId, (error, zoom) => {
          if (error) return
          map.easeTo({
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
          .addTo(map)
        hoverPopupRef.current = popup
      }

      const clearCensusHover = () => {
        hoverPopupRef.current?.remove()
        setHoveredCensusFeature(null)
      }

      const handleCensusClick = (event: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        if (!activeCensusMetricRef.current) return
        const clicked = event.features?.[0]
        const featureId = String(clicked?.properties?.id || '')
        const overlayFeature = censusOverlayFeaturesRef.current.find((item) => item.id === featureId)
        if (!overlayFeature) return
        setSelectedCensusFeature({ feature: overlayFeature, mode: 'selected' })
      }

      const handleSoldCompClusterClick = (event: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        const feature = event.features?.[0]
        if (!feature) return
        const clusterId = Number(feature.properties?.cluster_id)
        const source = map.getSource(SOLD_COMPS_SOURCE_ID) as (maplibregl.GeoJSONSource & {
          getClusterExpansionZoom?: (id: number, cb: (error: Error | null, zoom: number) => void) => void
        }) | undefined
        if (!source?.getClusterExpansionZoom || !Number.isFinite(clusterId)) return
        source.getClusterExpansionZoom(clusterId, (error, zoom) => {
          if (error) return
          const coordinates = (feature.geometry as Point).coordinates as [number, number]
          map.easeTo({ center: coordinates, zoom: zoom + 0.5, duration: 420 })
        })
      }

      map.on('click', 'command-pin-core-raw', handlePinClick)
      map.on('click', 'command-pin-core-clustered', handlePinClick)
      map.on('click', 'command-pin-icon-raw', handlePinClick)
      map.on('click', 'command-pin-icon-clustered', handlePinClick)
      map.on('click', 'command-pin-cluster-core', handleClusterClick)
      map.on('click', CENSUS_LAYER_IDS.fill, handleCensusClick)
      map.on('click', 'command-buyer-purchase-core', handleBuyerClick)
      map.on('click', 'command-buyer-profile-core', handleBuyerClick)
      map.on('click', 'command-buyer-cluster-core', handleBuyerClusterClick)
      map.on('click', SOLD_COMPS_LAYER_IDS.hit, handleSoldCompClick)
      map.on('click', SOLD_COMPS_LAYER_IDS.marker, handleSoldCompClick)
      map.on('click', SOLD_COMPS_LAYER_IDS.label, handleSoldCompClick)
      map.on('click', SOLD_COMPS_CLUSTER_LAYER_IDS.core, handleSoldCompClusterClick)
      map.on('click', SELLER_PINS_LAYER_IDS.core, handleSellerPinClick)
      map.on('click', SELLER_PINS_LAYER_IDS.icon, handleSellerPinClick)
      map.on('click', SELLER_PINS_LAYER_IDS.clusterCore, handleSellerPinClusterClick)
      map.on('click', (event) => {
        const rendered = map.queryRenderedFeatures(event.point, {
          layers: ['command-pin-core-raw', 'command-pin-core-clustered', 'command-pin-icon-raw', 'command-pin-icon-clustered', 'command-pin-cluster-core', 'command-buyer-purchase-core', 'command-buyer-profile-core', 'command-buyer-cluster-core', SOLD_COMPS_LAYER_IDS.hit, SOLD_COMPS_LAYER_IDS.marker, SOLD_COMPS_LAYER_IDS.icon, SOLD_COMPS_LAYER_IDS.label, SOLD_COMPS_CLUSTER_LAYER_IDS.core, SELLER_PINS_LAYER_IDS.core, SELLER_PINS_LAYER_IDS.clusterCore],
        })
        if (rendered.length === 0) {
          setActiveThreadPopup(null)
          setActiveSellerPinPopup(null)
          setSelectedBuyerPurchase(null)
          setSelectedSoldComp(null)
          setSelectedClusterSummary(null)
          setSelectedCensusFeature(null)
          onBackgroundClickRef.current?.()
        }
      })
      map.on('mouseenter', 'command-pin-core-raw', handlePinHover)
      map.on('mouseenter', 'command-pin-core-clustered', handlePinHover)
      map.on('mouseenter', 'command-pin-icon-raw', handlePinHover)
      map.on('mouseenter', 'command-pin-icon-clustered', handlePinHover)
      map.on('mouseenter', 'command-pin-cluster-core', handleClusterHover)
      map.on('mouseenter', CENSUS_LAYER_IDS.fill, handleCensusHover)
      map.on('mouseenter', 'command-buyer-purchase-core', handleBuyerHover)
      map.on('mouseenter', 'command-buyer-profile-core', handleBuyerHover)
      map.on('mouseenter', SOLD_COMPS_LAYER_IDS.hit, handleSoldCompHover)
      map.on('mouseenter', SOLD_COMPS_LAYER_IDS.marker, handleSoldCompHover)
      map.on('mouseenter', SOLD_COMPS_LAYER_IDS.label, handleSoldCompHover)
      map.on('mouseenter', SELLER_PINS_LAYER_IDS.core, handleSellerPinHover)
      map.on('mouseenter', SELLER_PINS_LAYER_IDS.icon, handleSellerPinHover)
      map.on('mouseenter', SELLER_PINS_LAYER_IDS.ring, handleSellerPinHover)
      map.on('mouseenter', SELLER_PINS_LAYER_IDS.glow, handleSellerPinHover)
      map.on('mouseleave', 'command-pin-core-raw', clearPinHover)
      map.on('mouseleave', 'command-pin-core-clustered', clearPinHover)
      map.on('mouseleave', 'command-pin-icon-raw', clearPinHover)
      map.on('mouseleave', 'command-pin-icon-clustered', clearPinHover)
      map.on('mouseleave', 'command-pin-cluster-core', clearClusterHover)
      map.on('mouseleave', CENSUS_LAYER_IDS.fill, clearCensusHover)
      map.on('mouseleave', 'command-buyer-purchase-core', clearPinHover)
      map.on('mouseleave', 'command-buyer-profile-core', clearPinHover)
      map.on('mouseleave', SOLD_COMPS_LAYER_IDS.hit, clearPinHover)
      map.on('mouseleave', SOLD_COMPS_LAYER_IDS.marker, clearPinHover)
      map.on('mouseleave', SOLD_COMPS_LAYER_IDS.label, clearPinHover)
      map.on('mouseleave', SELLER_PINS_LAYER_IDS.core, clearPinHover)
      map.on('mouseleave', SELLER_PINS_LAYER_IDS.icon, clearPinHover)
      map.on('mouseleave', SELLER_PINS_LAYER_IDS.ring, clearPinHover)
      map.on('mouseleave', SELLER_PINS_LAYER_IDS.glow, clearPinHover)

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
        if (!mapRef.current) return
        const shouldAnimatePins =
          !reducedMotionRef.current
          && performanceSettingsRef.current?.animation === 'full'
          && geojsonRef.current.features.length <= 180
        if (!shouldAnimatePins) {
          if (!pulsesSuppressed) {
            try {
              ;(['command-pin-pulse-raw', 'command-pin-pulse-clustered'] as const).forEach((layerId) => {
                if (!map.getLayer(layerId)) return
                map.setPaintProperty(layerId, 'circle-opacity', 0)
              })
            } catch {
              // Keep map resilient.
            }
            pulsesSuppressed = true
          }
          animationRef.current = requestAnimationFrame(animate)
          return
        }
        pulsesSuppressed = false
        frame = (frame + 1) % 360
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
          ;(['command-pin-pulse-raw', 'command-pin-pulse-clustered'] as const).forEach((layerId) => {
            if (!map.getLayer(layerId)) return
            map.setPaintProperty(layerId, 'circle-radius', [
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
            map.setPaintProperty(layerId, 'circle-opacity', [
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

          if (map.getLayer(SELLER_PINS_LAYER_IDS.pulse) && sellerPinLayers.sellerPins) {
            map.setPaintProperty(SELLER_PINS_LAYER_IDS.pulse, 'circle-radius', [
              'match', ['coalesce', ['get', 'pulse_style'], 'none'],
              'pulse_strong', makeRadiusExpr('fast', 'continuous'),
              'pulse_soft', makeRadiusExpr('slow', 'continuous'),
              'pulse_warning', makeRadiusExpr('medium_fast', 'ripple'),
              'pulse_rotating', makeRadiusExpr('medium', 'triple'),
              makeRadiusExpr('none', 'continuous')
            ])
            map.setPaintProperty(SELLER_PINS_LAYER_IDS.pulse, 'circle-opacity', [
              'match', ['coalesce', ['get', 'pulse_style'], 'none'],
              'pulse_strong', makeOpacityExpr('fast', 'continuous'),
              'pulse_soft', makeOpacityExpr('slow', 'continuous'),
              'pulse_warning', makeOpacityExpr('medium_fast', 'ripple'),
              'pulse_rotating', makeOpacityExpr('medium', 'triple'),
              0
            ])
          }

        } catch {
          return
        }
        animationRef.current = requestAnimationFrame(animate)
      }
      animationRef.current = requestAnimationFrame(animate)

      ;(['command-pin-core-raw', 'command-pin-core-clustered', 'command-pin-icon-raw', 'command-pin-icon-clustered', 'command-pin-cluster-core', 'command-buyer-purchase-core', 'command-buyer-profile-core', 'command-buyer-cluster-core', SOLD_COMPS_LAYER_IDS.marker, SOLD_COMPS_LAYER_IDS.icon, SOLD_COMPS_LAYER_IDS.label, SOLD_COMPS_CLUSTER_LAYER_IDS.core, SELLER_PINS_LAYER_IDS.core] as const).forEach((layerId) => {
        if (mapRef.current?.getLayer(layerId)) {
          map.on('mouseenter', layerId, () => { map.getCanvas().style.cursor = 'pointer' })
          map.on('mouseleave', layerId, () => { map.getCanvas().style.cursor = '' })
        }
      })
    })

    map.on('style.load', () => {
      handleStyleReady()
    })

    return () => {
      if (animationRef.current !== null) cancelAnimationFrame(animationRef.current)
      if (styleLoadTimerRef.current) clearTimeout(styleLoadTimerRef.current)
      hoverPopupRef.current?.remove()
      threadPopupRootRef.current?.unmount()
      threadPopupRootRef.current = null
      threadPopupHostRef.current = null
      threadPopupRef.current?.remove()
      threadPopupRef.current = null
      applyCommandMapThemeRef.current = null
      map.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    const rawSource = mapRef.current?.getSource(RAW_SOURCE_ID) as maplibregl.GeoJSONSource | undefined
    const clusterSource = mapRef.current?.getSource(CLUSTER_SOURCE_ID) as maplibregl.GeoJSONSource | undefined
    const buyerPurchaseSource = mapRef.current?.getSource(BUYER_PURCHASE_SOURCE_ID) as maplibregl.GeoJSONSource | undefined
    const buyerProfileSource = mapRef.current?.getSource(BUYER_PROFILE_SOURCE_ID) as maplibregl.GeoJSONSource | undefined
    const buyerTrailSource = mapRef.current?.getSource(BUYER_TRAIL_SOURCE_ID) as maplibregl.GeoJSONSource | undefined
    rawSource?.setData(geojson)
    clusterSource?.setData(geojson)
    buyerPurchaseSource?.setData(buyerPurchasesGeojson)
    buyerProfileSource?.setData(buyerProfilesGeojson)
    buyerTrailSource?.setData(buyerTrailGeojson)
  }, [buyerProfilesGeojson, buyerPurchasesGeojson, buyerTrailGeojson, geojson])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    applyCommandMapThemeRef.current?.(map, mapStyleMode)
  }, [mapStyleMode])

  useEffect(() => {
    if (!mapRef.current?.isStyleLoaded()) return
    const layers = mapRef.current.getStyle()?.layers ?? []
    layers.forEach((layer) => {
      const typedLayer = layer as StyleLayerLike
      if (!typedLayer.id || isCustomLayer(typedLayer.id)) return
      const categories = classifyBaseLayer(typedLayer)
      if (categories.length === 0) return
      const visible = categories.every((category) => mapOverlays[category])
      if (mapRef.current?.getLayer(typedLayer.id)) {
        mapRef.current.setLayoutProperty(typedLayer.id, 'visibility', visible ? 'visible' : 'none')
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
    if (!map) return
    const clusteredMode =
      (activityMode !== 'sends' && !activeKpiFilter)
      || (performanceSettings.clusterAggressiveness === 'high' && map.getZoom() < 12.5)
    const sellerVisible = buyerLayers.sellerThreads
    RAW_LAYER_IDS.forEach((layerId) => {
      if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', sellerVisible ? (clusteredMode ? 'none' : 'visible') : 'none')
    })
    CLUSTER_POINT_LAYER_IDS.forEach((layerId) => {
      if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', sellerVisible ? (clusteredMode ? 'visible' : 'none') : 'none')
    })
    CLUSTER_LAYER_IDS.forEach((layerId) => {
      if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', sellerVisible ? (clusteredMode ? 'visible' : 'none') : 'none')
    })
  }, [activeKpiFilter, activityMode, buyerLayers.sellerThreads, performanceSettings.clusterAggressiveness, baseStyleLoading])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
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
    const source = mapRef.current?.getSource(CLUSTER_SOURCE_ID) as (maplibregl.GeoJSONSource & {
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
  }, [performanceSettings.markerDensity, performanceSettings.performanceMode, sellerPinLayers.sellerPins])

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
    const palette = activeThemeRef.current.pinPalette
    const dataKey = `${mapStyleMode}:${normalizedFilteredPins.length}:${normalizedFilteredPins[0]?.property_id || ''}:${normalizedFilteredPins[normalizedFilteredPins.length - 1]?.property_id || ''}`
    setSellerPins(normalizedFilteredPins)
    if (dataKey === lastSellerPinsDataKeyRef.current) return
    const features = normalizedFilteredPins.map((normalizedPin) => {
      const sellerState = resolveEffectiveSellerState(normalizedPin)
      const executionState = lower(normalizedPin.execution_state)
      const resolvedPinColor =
        normalizedPin.pin_color
        || palette[sellerState]
        || palette[executionState]
        || palette.not_contacted
      const executionRingColor =
        normalizedPin.execution_ring_color
        || (executionState ? palette[executionState] : undefined)
        || 'transparent'
      return ({
        type: 'Feature' as const,
        id: `seller-pin-${normalizedPin.property_id}`,
        geometry: { type: 'Point' as const, coordinates: [normalizedPin.lng, normalizedPin.lat] as [number, number] },
        properties: {
          ...normalizedPin,
          id: `seller-pin-${normalizedPin.property_id}`,
          pin_color: resolvedPinColor,
          execution_ring_color: executionRingColor,
          propTypeSlug: normalizePropertyTypeSlug(normalizedPin.property_type ?? 'default'),
        },
      })
    })
    setSellerPinsGeojson({ type: 'FeatureCollection', features })
    lastSellerPinsDataKeyRef.current = dataKey
    setSellerPinsPerf((current) => ({ ...current, shown: normalizedFilteredPins.length }))
    
    console.log(`[CommandMap] 📍 Diagnostics Report:
      Raw Seller Pins (Viewport): ${mergedPins.length}
      Filtered-Out Seller Pins: ${mergedPins.length - normalizedFilteredPins.length}
      Rendered Seller Pins: ${normalizedFilteredPins.length}
      Rendered Buyer Comps: ${soldCompsGeojsonRef.current?.features?.length ?? 0}
      Current Zoom: ${mapRef.current?.getZoom()?.toFixed(2) ?? 'Unknown'}
    `)
  }, [mapStyleMode, pinPipeline.mapped, sellerPinLayers, sellerPinsRaw])

  // ── Push census + buyer demand GeoJSON to map sources ─────────────────────
  useEffect(() => {
    const censusSource = mapRef.current?.getSource(CENSUS_SOURCE_ID) as maplibregl.GeoJSONSource | undefined
    censusSource?.setData(censusGeojson as Parameters<maplibregl.GeoJSONSource['setData']>[0])
  }, [censusGeojson])

  useEffect(() => {
    const bdSource = mapRef.current?.getSource(BUYER_DEMAND_SOURCE_ID) as maplibregl.GeoJSONSource | undefined
    bdSource?.setData(buyerDemandGeojson as Parameters<maplibregl.GeoJSONSource['setData']>[0])
  }, [buyerDemandGeojson])

  useEffect(() => {
    const scSource = mapRef.current?.getSource(SOLD_COMPS_SOURCE_ID) as maplibregl.GeoJSONSource | undefined
    scSource?.setData(soldCompsGeojson as Parameters<maplibregl.GeoJSONSource['setData']>[0])
  }, [soldCompsGeojson])

  useEffect(() => {
    const spSource = mapRef.current?.getSource(SELLER_PINS_SOURCE_ID) as maplibregl.GeoJSONSource | undefined
    spSource?.setData(sellerPinsGeojson as Parameters<maplibregl.GeoJSONSource['setData']>[0])
  }, [sellerPinsGeojson])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const visible = sellerPinLayers.sellerPins
    const spIconLayerId = 'seller-pins-icon'
    const spGlowLayerId = `${SOLD_COMPS_LAYER_IDS.marker}-glow`
    const allSpLayers = [...ALL_SELLER_PINS_LAYER_IDS, spIconLayerId]
    allSpLayers.forEach((layerId) => {
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none')
      }
    })
    // Keep comp glow aligned with comp marker visibility
    if (map.getLayer(spGlowLayerId)) {
      const compVisible = map.getLayoutProperty(SOLD_COMPS_LAYER_IDS.marker, 'visibility') ?? 'none'
      map.setLayoutProperty(spGlowLayerId, 'visibility', compVisible)
    }
  }, [sellerPinLayers.sellerPins, baseStyleLoading])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !sellerPinLayers.sellerPins) return
    const pointFilter: maplibregl.FilterSpecification = ['!', ['has', 'point_count']]
    const clusterFilter: maplibregl.FilterSpecification = ['has', 'point_count']
    if (map.getLayer(SELLER_PINS_LAYER_IDS.core)) map.setFilter(SELLER_PINS_LAYER_IDS.core, pointFilter)
    if (map.getLayer(SELLER_PINS_LAYER_IDS.icon)) map.setFilter(SELLER_PINS_LAYER_IDS.icon, pointFilter)
    if (map.getLayer(SELLER_PINS_LAYER_IDS.glow)) map.setFilter(SELLER_PINS_LAYER_IDS.glow, pointFilter)
    if (map.getLayer(SELLER_PINS_LAYER_IDS.ring)) map.setFilter(SELLER_PINS_LAYER_IDS.ring, pointFilter)
    if (map.getLayer(SELLER_PINS_LAYER_IDS.clusterGlow)) map.setFilter(SELLER_PINS_LAYER_IDS.clusterGlow, clusterFilter)
    if (map.getLayer(SELLER_PINS_LAYER_IDS.clusterCore)) map.setFilter(SELLER_PINS_LAYER_IDS.clusterCore, clusterFilter)
    if (map.getLayer(SELLER_PINS_LAYER_IDS.clusterCount)) map.setFilter(SELLER_PINS_LAYER_IDS.clusterCount, clusterFilter)
    if (map.getLayer(SELLER_PINS_LAYER_IDS.pulse)) {
      map.setFilter(SELLER_PINS_LAYER_IDS.pulse, ['in', ['coalesce', ['get', 'pulse_style'], 'none'], ['literal', ['pulse_strong', 'pulse_warning', 'pulse_rotating']]])
    }
  }, [sellerPinLayers.sellerPins, viewportZoom, baseStyleLoading])

  // ── Census layer visibility + hovered outline ─────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
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
    if (!map) return
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
    if (!mapRef.current || visiblePins.length === 0) return
    if (selectedPin) {
      mapRef.current.easeTo({
        center: [selectedPin.lng, selectedPin.lat],
        zoom: Math.max(mapRef.current.getZoom(), zoomedIn ? 13 : 11.25),
        duration: 680,
        offset: dockTier === 'full' ? [150, 0] : [0, 0],
      })
      return
    }
    const uniqueCoords = new Map<string, [number, number]>()
    visiblePins.forEach((pin) => {
      uniqueCoords.set(`${pin.lng}:${pin.lat}`, [pin.lng, pin.lat])
    })
    const coords = Array.from(uniqueCoords.values())
    const padding =
      dockTier === 'full'
        ? { top: 116, right: 72, bottom: 118, left: 36 }
        : dockTier === 'compact'
          ? { top: 92, right: 64, bottom: 90, left: 24 }
          : { top: 72, right: 24, bottom: 132, left: 24 }

    if (coords.length === 1) {
      mapRef.current.easeTo({ center: coords[0], zoom: zoomedIn ? 12 : 8, duration: 500 })
      return
    }
    const bounds = coords.reduce(
      (acc, [lng, lat]) => ({
        minLng: Math.min(acc.minLng, lng),
        maxLng: Math.max(acc.maxLng, lng),
        minLat: Math.min(acc.minLat, lat),
        maxLat: Math.max(acc.maxLat, lat),
      }),
      { minLng: Infinity, maxLng: -Infinity, minLat: Infinity, maxLat: -Infinity },
    )
    mapRef.current.fitBounds([[bounds.minLng, bounds.minLat], [bounds.maxLng, bounds.maxLat]], {
      padding,
      duration: 550,
      maxZoom: zoomedIn ? 13 : 11,
    })
  }, [dockTier, selectedPin?.conversation_id, visiblePins.length > 0, zoomedIn])

  const markets = Array.from(new Set(allPins.map((pin) => pin.market).filter(Boolean))).sort()
  const stages = Array.from(new Set(allPins.map((pin) => pin.conversation_stage).filter(Boolean))).sort()
  const statuses = Array.from(new Set(allPins.map((pin) => pin.conversation_status).filter(Boolean))).sort()
  const temperatures = Array.from(new Set(allPins.map((pin) => pin.lead_temperature).filter(Boolean))).sort()
  const automationStatuses = Array.from(new Set(allPins.map((pin) => pin.automation_status).filter(Boolean))).sort()
  const propertyTypes = Array.from(new Set(allPins.map((pin) => pin.property_type).filter(Boolean))).sort()
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

  const handleActivitySelect = (event: CommandMapActivityEvent) => {
    onSelectActivity?.(event)
    const center = centerMapOnActivity(event)
    if (event.targetType === 'seller' && event.targetId) {
      setSelectedPinId(event.targetId)
      setActiveSellerPinPopup(null)
      onSelectThreadId?.(event.targetId)
      if (center) setActiveThreadPopup({ id: event.targetId, coordinates: center })
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
      if (comp) setSelectedSoldComp(comp)
    }
    if (center) {
      mapRef.current?.easeTo({
        center,
        zoom: Math.max(mapRef.current?.getZoom() ?? 10.8, 12.4),
        duration: 620,
      })
    }
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
        `is-layout-${layoutMode}`,
        filtersOpen && 'is-controls-open',
        fullHeight && 'nx-icm--full',
        isUltrawide && 'is-ultrawide',
        liveActivitySettings.displayMode === 'hidden' && 'is-live-activity-hidden',
        liveActivitySettings.displayMode === 'docked' && 'is-live-activity-docked',
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
            <div className="nx-icm__controls-tabs" role="tablist" aria-label="Map controls tabs">
              {CONTROLS_TABS.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  className={cls('nx-icm__controls-tab', activeControlsTab === tab.key && 'is-active')}
                  onClick={() => setActiveControlsTab(tab.key)}
                >
                  {tab.key === 'buyer_layers' ? `Buyer Layers${buyerFilterCount > 0 ? ` · ${buyerFilterCount}` : ''}` : tab.label}
                </button>
              ))}
            </div>
            <div className="nx-icm__controls-panel">
              {activeControlsTab === 'view' && (
                <>
                  <div className="nx-icm__controls-group">
                    <span className="nx-icm__controls-label">View Mode</span>
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
                  <div className="nx-icm__controls-grid">
                    <div className="nx-icm__controls-group">
                      <span className="nx-icm__controls-label">Pin Scope</span>
                      <div className="nx-icm__controls-segment">
                        <button type="button" className={cls('nx-icm__mode-tab', sourceMode === 'all_active_coordinate_threads' && 'is-active')} onClick={() => onSourceModeChange?.('all_active_coordinate_threads')}>
                          All Pins
                        </button>
                        <button type="button" className={cls('nx-icm__mode-tab', sourceMode === 'visible_threads' && 'is-active')} onClick={() => onSourceModeChange?.('visible_threads')}>
                          Filtered Pins
                        </button>
                      </div>
                    </div>
                    <div className="nx-icm__controls-group">
                      <div className="nx-icm__controls-headerline">
                        <span className="nx-icm__controls-label">KPI Focus</span>
                        <label className="nx-icm__checkbox">
                          <input type="checkbox" checked={showKpiBadges} onChange={(event) => setShowKpiBadges(event.target.checked)} />
                          KPI Badges
                        </label>
                      </div>
                      <div className="nx-icm__controls-segment">
                        {kpiChips.map((chip) => (
                          <button
                            key={chip.key}
                            type="button"
                            className={cls('nx-icm__kpi-chip', activeKpiFilter === chip.key && 'is-active')}
                            onClick={() => setActiveKpiFilter((current) => current === chip.key ? null : chip.key)}
                            style={{ '--icm-kpi-tone': chip.tone } as CSSProperties}
                          >
                            <span>{chip.label}</span>
                            <strong>{chip.count}</strong>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="nx-icm__controls-group">
                    <span className="nx-icm__controls-label">Map UI</span>
                    <div className="nx-icm__controls-segment">
                      <label className="nx-icm__checkbox">
                        <input type="checkbox" checked={showLegendPanel} onChange={(event) => setShowLegendPanel(event.target.checked)} />
                        Map Key
                      </label>
                      <label className="nx-icm__checkbox">
                        <input type="checkbox" checked={showCensusDock} onChange={(event) => setShowCensusDock(event.target.checked)} />
                        Census Intelligence
                      </label>
                    </div>
                  </div>
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
                      <span className="nx-icm__controls-label">Live Activity Mode</span>
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
                      <span className="nx-icm__controls-label">Cluster Aggressiveness</span>
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
                    <span className="nx-icm__controls-label">Performance Effects</span>
                    <div className="nx-icm__controls-segment">
                      <label className="nx-icm__checkbox">
                        <input type="checkbox" checked={performanceSettings.showHeatEffects} onChange={(event) => patchPerformanceSettings({ showHeatEffects: event.target.checked })} />
                        Show Heat Effects
                      </label>
                      <label className="nx-icm__checkbox">
                        <input type="checkbox" checked={liveActivitySettings.onlyCurrentBounds} onChange={(event) => patchLiveActivitySettings({ onlyCurrentBounds: event.target.checked })} />
                        Bounds-Locked Feed
                      </label>
                    </div>
                  </div>
                  <div className="nx-icm__controls-group">
                    <span className="nx-icm__controls-label">Map Legend</span>
                    <div className="nx-icm__legend-grid is-expanded">
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
                  </div>
                </>
              )}
              {activeControlsTab === 'seller_layers' && (
                <>
                  <div className="nx-icm__controls-group">
                    <span className="nx-icm__controls-label">Seller Thread Layers</span>
                    <div className="nx-icm__controls-segment">
                      <label className="nx-icm__checkbox"><input type="checkbox" checked={sellerPinLayers.sellerPins} onChange={(e) => setSellerPinLayers((current) => ({ ...current, sellerPins: e.target.checked }))} />Live Seller Pins</label>
                      <label className="nx-icm__checkbox"><input type="checkbox" checked={buyerLayers.sellerThreads} onChange={(e) => setBuyerLayers((current) => ({ ...current, sellerThreads: e.target.checked }))} />Inbox Threads</label>
                      <label className="nx-icm__checkbox"><input type="checkbox" checked={mapOverlays.roads} onChange={(e) => setMapOverlays((current) => ({ ...current, roads: e.target.checked }))} />Roads</label>
                      <label className="nx-icm__checkbox"><input type="checkbox" checked={mapOverlays.cities} onChange={(e) => setMapOverlays((current) => ({ ...current, cities: e.target.checked }))} />Cities</label>
                      <label className="nx-icm__checkbox"><input type="checkbox" checked={mapOverlays.poi} onChange={(e) => setMapOverlays((current) => ({ ...current, poi: e.target.checked }))} />POI</label>
                      <label className="nx-icm__checkbox"><input type="checkbox" checked={mapOverlays.zip} onChange={(e) => setMapOverlays((current) => ({ ...current, zip: e.target.checked }))} />ZIP</label>
                    </div>
                  </div>
                  {sellerPinLayers.sellerPins && (
                    <>
                      <div className="nx-icm__controls-group">
                        <span className="nx-icm__controls-label">Seller State Filters</span>
                        <div className="nx-icm__controls-segment">
                          <label className="nx-icm__checkbox"><input type="checkbox" checked={sellerPinLayers.notContacted} onChange={(e) => setSellerPinLayers((c) => ({ ...c, notContacted: e.target.checked }))} />Not Contacted</label>
                          <label className="nx-icm__checkbox"><input type="checkbox" checked={sellerPinLayers.contacted} onChange={(e) => setSellerPinLayers((c) => ({ ...c, contacted: e.target.checked }))} />Contacted</label>
                          <label className="nx-icm__checkbox"><input type="checkbox" checked={sellerPinLayers.newReplies} onChange={(e) => setSellerPinLayers((c) => ({ ...c, newReplies: e.target.checked }))} />New Replies</label>
                          <label className="nx-icm__checkbox"><input type="checkbox" checked={sellerPinLayers.positive} onChange={(e) => setSellerPinLayers((c) => ({ ...c, positive: e.target.checked }))} />Positive</label>
                          <label className="nx-icm__checkbox"><input type="checkbox" checked={sellerPinLayers.negotiating} onChange={(e) => setSellerPinLayers((c) => ({ ...c, negotiating: e.target.checked }))} />Negotiating</label>
                          <label className="nx-icm__checkbox"><input type="checkbox" checked={sellerPinLayers.hot} onChange={(e) => setSellerPinLayers((c) => ({ ...c, hot: e.target.checked }))} />Hot</label>
                          <label className="nx-icm__checkbox"><input type="checkbox" checked={sellerPinLayers.issues} onChange={(e) => setSellerPinLayers((c) => ({ ...c, issues: e.target.checked }))} />Issues</label>
                          <label className="nx-icm__checkbox"><input type="checkbox" checked={sellerPinLayers.blocked} onChange={(e) => setSellerPinLayers((c) => ({ ...c, blocked: e.target.checked }))} />Blocked</label>
                        </div>
                      </div>
                      <div className="nx-icm__controls-group">
                        <span className="nx-icm__controls-label">Execution Filters</span>
                        <div className="nx-icm__controls-segment">
                          <label className="nx-icm__checkbox"><input type="checkbox" checked={sellerPinLayers.queued} onChange={(e) => setSellerPinLayers((c) => ({ ...c, queued: e.target.checked }))} />Queued</label>
                          <label className="nx-icm__checkbox"><input type="checkbox" checked={sellerPinLayers.scheduled} onChange={(e) => setSellerPinLayers((c) => ({ ...c, scheduled: e.target.checked }))} />Scheduled</label>
                          <label className="nx-icm__checkbox"><input type="checkbox" checked={sellerPinLayers.ready} onChange={(e) => setSellerPinLayers((c) => ({ ...c, ready: e.target.checked }))} />Ready</label>
                          <label className="nx-icm__checkbox"><input type="checkbox" checked={sellerPinLayers.activeSending} onChange={(e) => setSellerPinLayers((c) => ({ ...c, activeSending: e.target.checked }))} />Active/Sending</label>
                          <label className="nx-icm__checkbox"><input type="checkbox" checked={sellerPinLayers.sent} onChange={(e) => setSellerPinLayers((c) => ({ ...c, sent: e.target.checked }))} />Sent</label>
                          <label className="nx-icm__checkbox"><input type="checkbox" checked={sellerPinLayers.delivered} onChange={(e) => setSellerPinLayers((c) => ({ ...c, delivered: e.target.checked }))} />Delivered</label>
                          <label className="nx-icm__checkbox"><input type="checkbox" checked={sellerPinLayers.failedIssue} onChange={(e) => setSellerPinLayers((c) => ({ ...c, failedIssue: e.target.checked }))} />Failed/Issue</label>
                        </div>
                      </div>
                    </>
                  )}
                </>
              )}
              {activeControlsTab === 'buyer_layers' && (
                <>
                  <div className="nx-icm__controls-group">
                    <span className="nx-icm__controls-label">Buyer Intelligence Layers</span>
                    <div className="nx-icm__controls-segment">
                      <label className="nx-icm__checkbox"><input type="checkbox" checked={buyerLayers.buyerFocusMode} onChange={(e) => setBuyerLayers((current) => ({ ...current, buyerFocusMode: e.target.checked }))} />Buyer Focus Mode</label>
                      <label className="nx-icm__checkbox"><input type="checkbox" checked={buyerLayers.buyerMatches} onChange={(e) => setBuyerLayers((current) => ({ ...current, buyerMatches: e.target.checked }))} />Buyer Matches</label>
                      <label className="nx-icm__checkbox"><input type="checkbox" checked={buyerLayers.buyerRecentPurchases} onChange={(e) => setBuyerLayers((current) => ({ ...current, buyerRecentPurchases: e.target.checked }))} />Buyer Activity</label>
                      <label className="nx-icm__checkbox"><input type="checkbox" checked={buyerLayers.buyerHeatmap} onChange={(e) => setBuyerLayers((current) => ({ ...current, buyerHeatmap: e.target.checked }))} />Buyer Heatmap</label>
                      <label className="nx-icm__checkbox"><input type="checkbox" checked={buyerLayers.buyerProfiles} onChange={(e) => setBuyerLayers((current) => ({ ...current, buyerProfiles: e.target.checked }))} />Buyer Profiles</label>
                      <label className="nx-icm__checkbox"><input type="checkbox" checked={buyerLayers.recentSoldComps} onChange={(e) => setBuyerLayers((current) => ({ ...current, recentSoldComps: e.target.checked }))} />Sold Comps</label>
                      <label className="nx-icm__checkbox"><input type="checkbox" checked={buyerLayers.repeatBuyers} onChange={(e) => setBuyerLayers((current) => ({ ...current, repeatBuyers: e.target.checked }))} />Repeat Buyers</label>
                      <label className="nx-icm__checkbox"><input type="checkbox" checked={buyerLayers.corporateBuyers} onChange={(e) => setBuyerLayers((current) => ({ ...current, corporateBuyers: e.target.checked }))} />Corporate Buyers</label>
                      <label className="nx-icm__checkbox"><input type="checkbox" checked={buyerLayers.localInvestors} onChange={(e) => setBuyerLayers((current) => ({ ...current, localInvestors: e.target.checked }))} />Local Investors</label>
                      <label className="nx-icm__checkbox"><input type="checkbox" checked={buyerLayers.offMarketBuyers} onChange={(e) => setBuyerLayers((current) => ({ ...current, offMarketBuyers: e.target.checked }))} />Off-Market Buyers</label>
                      <label className="nx-icm__checkbox"><input type="checkbox" checked={buyerLayers.retailNoise} onChange={(e) => setBuyerLayers((current) => ({ ...current, retailNoise: e.target.checked }))} />Retail / Noise</label>
                      <label className="nx-icm__checkbox"><input type="checkbox" checked={buyerLayers.institutional} onChange={(e) => setBuyerLayers((current) => ({ ...current, institutional: e.target.checked }))} />Institutional</label>
                      <label className="nx-icm__checkbox"><input type="checkbox" checked={buyerLayers.landlords} onChange={(e) => setBuyerLayers((current) => ({ ...current, landlords: e.target.checked }))} />Landlords</label>
                      <label className="nx-icm__checkbox"><input type="checkbox" checked={buyerLayers.flippers} onChange={(e) => setBuyerLayers((current) => ({ ...current, flippers: e.target.checked }))} />Flippers</label>
                      <label className="nx-icm__checkbox"><input type="checkbox" checked={buyerLayers.builders} onChange={(e) => setBuyerLayers((current) => ({ ...current, builders: e.target.checked }))} />Builders</label>
                    </div>
                  </div>
                  <div className="nx-icm__controls-group">
                    <span className="nx-icm__controls-label">Buyer Demand Layers</span>
                    <div className="nx-icm__controls-segment">
                      <label className="nx-icm__checkbox"><input type="checkbox" checked={buyerDemandLayers.activity6mo} onChange={(e) => setBuyerDemandLayers((c) => ({ ...c, activity6mo: e.target.checked }))} />Buyer Activity 6mo</label>
                      <label className="nx-icm__checkbox"><input type="checkbox" checked={buyerDemandLayers.investorDemand} onChange={(e) => setBuyerDemandLayers((c) => ({ ...c, investorDemand: e.target.checked }))} />Investor Demand</label>
                      <label className="nx-icm__checkbox"><input type="checkbox" checked={buyerDemandLayers.buyerHeat} onChange={(e) => setBuyerDemandLayers((c) => ({ ...c, buyerHeat: e.target.checked }))} />Buyer Heat</label>
                      <label className="nx-icm__checkbox"><input type="checkbox" checked={buyerDemandLayers.soldPrice} onChange={(e) => setBuyerDemandLayers((c) => ({ ...c, soldPrice: e.target.checked }))} />Sold Price Labels</label>
                    </div>
                  </div>
                  {selectedThread && buyerCommandData?.summary && (
                    <div className="nx-icm__controls-group">
                      <span className="nx-icm__controls-label">Buyer Demand Summary</span>
                      <div className="nx-icm__buyer-summary">
                        <div><span>Buyer Demand</span><strong>{buyerCommandData.summary.demandLabel}</strong></div>
                        <div><span>Top Match</span><strong>{buyerCommandData.summary.topBuyerMatch}</strong></div>
                        <div><span>Active Matches</span><strong>{buyerCommandData.summary.activeBuyerMatches}</strong></div>
                        <div><span>Avg Match Score</span><strong>{buyerCommandData.summary.averageMatchScore ?? '—'}</strong></div>
                        <div><span>Nearby Purchases</span><strong>{buyerCommandData.summary.recentPurchasesNearby}</strong></div>
                        <div><span>Dispo Confidence</span><strong>{buyerCommandData.summary.dispoConfidence}%</strong></div>
                      </div>
                      <p className="nx-icm__buyer-summary-note">{buyerCommandData.summary.recommendedAction}</p>
                      {buyerCommandData.summary.topMarkets.length > 0 && (
                        <div className="nx-icm__controls-segment">
                          {buyerCommandData.summary.topMarkets.slice(0, 5).map((market) => (
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
                      )}
                    </div>
                  )}
                  {buyerFilters && (
                    <>
                      <datalist id="buyer-markets">
                        {buyerFilterOptions.markets.map((value) => <option key={value} value={value} />)}
                      </datalist>
                      <datalist id="buyer-states">
                        {buyerFilterOptions.states.map((value) => <option key={value} value={value} />)}
                      </datalist>
                      <datalist id="buyer-zips">
                        {buyerFilterOptions.zips.map((value) => <option key={value} value={value} />)}
                      </datalist>
                      <datalist id="buyer-property-types">
                        {buyerFilterOptions.propertyTypes.map((value) => <option key={value} value={value} />)}
                      </datalist>
                      <datalist id="buyer-asset-classes">
                        {buyerFilterOptions.assetClasses.map((value) => <option key={value} value={value} />)}
                      </datalist>
                      <datalist id="buyer-names">
                        {buyerFilterOptions.buyerNames.map((value) => <option key={value} value={value} />)}
                      </datalist>
                      <datalist id="buyer-exit-strategies">
                        {buyerFilterOptions.exitStrategies.map((value) => <option key={value} value={value} />)}
                      </datalist>

                      <div className="nx-icm__controls-group">
                        <div className="nx-icm__controls-headerline">
                          <span className="nx-icm__controls-label">Buyer Filters</span>
                          <div className="nx-icm__controls-segment">
                            <span className="nx-icm__pill-note">{buyerFilterCount} active</span>
                            <button type="button" className="nx-icm__mode-tab" onClick={clearBuyerFilters}>Clear Buyer Filters</button>
                          </div>
                        </div>
                        <div className="nx-icm__filter-grid">
                          <select className="nx-icm__field" value={buyerFilters.activityWindowDays} onChange={(e) => onBuyerFiltersChange?.({ activityWindowDays: Number(e.target.value) as BuyerMapFilters['activityWindowDays'] })}>
                            {[30, 90, 180, 365].map((days) => <option key={days} value={days}>{days} day window</option>)}
                          </select>
                          <select className="nx-icm__field" value={buyerFilters.radiusMiles} onChange={(e) => onBuyerFiltersChange?.({ radiusMiles: Number(e.target.value) as BuyerMapFilters['radiusMiles'] })}>
                            {[1, 3, 5, 10].map((miles) => <option key={miles} value={miles}>{miles} mile radius</option>)}
                          </select>
                          <input className="nx-icm__field" list="buyer-markets" value={buyerFilters.market} onChange={(e) => onBuyerFiltersChange?.({ market: e.target.value })} placeholder="Market" />
                          <input className="nx-icm__field" list="buyer-property-types" value={buyerFilters.propertyType} onChange={(e) => onBuyerFiltersChange?.({ propertyType: e.target.value })} placeholder="Property Type" />
                        </div>
                      </div>

                      <div className="nx-icm__controls-grid nx-icm__controls-grid--buyer">
                        <div className="nx-icm__controls-group">
                          <span className="nx-icm__controls-label">A. Buyer Source / Type</span>
                          <div className="nx-icm__controls-segment nx-icm__controls-segment--pills">
                            {BUYER_SOURCE_OPTIONS.map(([value, label]) => (
                              <button key={value} type="button" className={cls('nx-icm__mode-tab', buyerFilters.buyerRoles.includes(value) && 'is-active')} onClick={() => toggleBuyerFilterArray('buyerRoles', value)}>
                                {label}
                              </button>
                            ))}
                          </div>
                        </div>

                        <div className="nx-icm__controls-group">
                          <span className="nx-icm__controls-label">B. Buyer Identity</span>
                          <div className="nx-icm__filter-grid">
                            <input className="nx-icm__field" list="buyer-names" value={buyerFilters.buyerName} onChange={(e) => onBuyerFiltersChange?.({ buyerName: e.target.value })} placeholder="Buyer Name" />
                            <input className="nx-icm__field" value={buyerFilters.entityName} onChange={(e) => onBuyerFiltersChange?.({ entityName: e.target.value })} placeholder="Entity Name" />
                            <input className="nx-icm__field" value={buyerFilters.mailingName} onChange={(e) => onBuyerFiltersChange?.({ mailingName: e.target.value })} placeholder="Mailing Name" />
                            <input className="nx-icm__field" value={buyerFilters.companyName} onChange={(e) => onBuyerFiltersChange?.({ companyName: e.target.value })} placeholder="Company Name" />
                            <input className="nx-icm__field" value={buyerFilters.buyerPhone} onChange={(e) => onBuyerFiltersChange?.({ buyerPhone: e.target.value })} placeholder="Buyer Phone" />
                            <input className="nx-icm__field" value={buyerFilters.buyerEmail} onChange={(e) => onBuyerFiltersChange?.({ buyerEmail: e.target.value })} placeholder="Buyer Email" />
                            <input className="nx-icm__field" list="buyer-markets" value={buyerFilters.buyerMarket} onChange={(e) => onBuyerFiltersChange?.({ buyerMarket: e.target.value })} placeholder="Buyer Market" />
                            <input className="nx-icm__field" list="buyer-states" value={buyerFilters.buyerState} onChange={(e) => onBuyerFiltersChange?.({ buyerState: e.target.value })} placeholder="Buyer State" />
                            <input className="nx-icm__field" list="buyer-zips" value={buyerFilters.buyerZip} onChange={(e) => onBuyerFiltersChange?.({ buyerZip: e.target.value })} placeholder="Buyer ZIP" />
                          </div>
                          <div className="nx-icm__controls-segment nx-icm__controls-segment--pills">
                            {BUYER_IDENTITY_OPTIONS.map(([value, label]) => (
                              <button key={value} type="button" className={cls('nx-icm__mode-tab', buyerFilters.buyerIdentityTags.includes(value) && 'is-active')} onClick={() => toggleBuyerFilterArray('buyerIdentityTags', value)}>
                                {label}
                              </button>
                            ))}
                          </div>
                        </div>

                        <div className="nx-icm__controls-group">
                          <span className="nx-icm__controls-label">C. Purchase Behavior</span>
                          <div className="nx-icm__filter-grid">
                            <input className="nx-icm__field" type="number" min={0} value={buyerFilters.minPurchaseCount} onChange={(e) => onBuyerFiltersChange?.({ minPurchaseCount: Number(e.target.value) || 0 })} placeholder="Purchase Count Min" />
                            <input className="nx-icm__field" type="number" min={0} value={buyerFilters.maxPurchaseCount} onChange={(e) => onBuyerFiltersChange?.({ maxPurchaseCount: e.target.value === '' ? '' : Number(e.target.value) })} placeholder="Purchase Count Max" />
                            <input className="nx-icm__field" type="date" value={buyerFilters.lastPurchaseDateFrom} onChange={(e) => onBuyerFiltersChange?.({ lastPurchaseDateFrom: e.target.value })} />
                            <input className="nx-icm__field" type="date" value={buyerFilters.lastPurchaseDateTo} onChange={(e) => onBuyerFiltersChange?.({ lastPurchaseDateTo: e.target.value })} />
                            <input className="nx-icm__field" type="number" min={0} value={buyerFilters.minAveragePurchasePrice} onChange={(e) => onBuyerFiltersChange?.({ minAveragePurchasePrice: e.target.value === '' ? '' : Number(e.target.value) })} placeholder="Avg Purchase Min" />
                            <input className="nx-icm__field" type="number" min={0} value={buyerFilters.maxAveragePurchasePrice} onChange={(e) => onBuyerFiltersChange?.({ maxAveragePurchasePrice: e.target.value === '' ? '' : Number(e.target.value) })} placeholder="Avg Purchase Max" />
                            <input className="nx-icm__field" type="number" min={0} max={100} value={buyerFilters.minCashPurchasePercent} onChange={(e) => onBuyerFiltersChange?.({ minCashPurchasePercent: e.target.value === '' ? '' : Number(e.target.value) })} placeholder="Cash Purchase % Min" />
                            <input className="nx-icm__field" type="number" min={0} max={100} value={buyerFilters.maxCashPurchasePercent} onChange={(e) => onBuyerFiltersChange?.({ maxCashPurchasePercent: e.target.value === '' ? '' : Number(e.target.value) })} placeholder="Cash Purchase % Max" />
                            <input className="nx-icm__field" type="number" min={0} max={100} value={buyerFilters.minVelocityScore} onChange={(e) => onBuyerFiltersChange?.({ minVelocityScore: e.target.value === '' ? '' : Number(e.target.value) })} placeholder="Velocity Min" />
                            <input className="nx-icm__field" type="number" min={0} max={100} value={buyerFilters.maxVelocityScore} onChange={(e) => onBuyerFiltersChange?.({ maxVelocityScore: e.target.value === '' ? '' : Number(e.target.value) })} placeholder="Velocity Max" />
                            <input className="nx-icm__field" type="number" min={0} value={buyerFilters.minDaysSinceLastBuy} onChange={(e) => onBuyerFiltersChange?.({ minDaysSinceLastBuy: e.target.value === '' ? '' : Number(e.target.value) })} placeholder="Days Since Last Buy Min" />
                            <input className="nx-icm__field" type="number" min={0} value={buyerFilters.maxDaysSinceLastBuy} onChange={(e) => onBuyerFiltersChange?.({ maxDaysSinceLastBuy: e.target.value === '' ? '' : Number(e.target.value) })} placeholder="Days Since Last Buy Max" />
                          </div>
                        </div>

                        <div className="nx-icm__controls-group">
                          <span className="nx-icm__controls-label">D. Asset Filters</span>
                          <div className="nx-icm__filter-grid">
                            <input className="nx-icm__field" list="buyer-property-types" value={buyerFilters.propertyType} onChange={(e) => onBuyerFiltersChange?.({ propertyType: e.target.value })} placeholder="Property Type" />
                            <input className="nx-icm__field" list="buyer-asset-classes" value={buyerFilters.assetClass} onChange={(e) => onBuyerFiltersChange?.({ assetClass: e.target.value })} placeholder="Asset Class" />
                          </div>
                          <div className="nx-icm__controls-segment nx-icm__controls-segment--pills">
                            {BUYER_ASSET_OPTIONS.map((value) => (
                              <button key={value} type="button" className={cls('nx-icm__mode-tab', buyerFilters.assetTypes.includes(value) && 'is-active')} onClick={() => toggleBuyerFilterArray('assetTypes', value)}>
                                {value}
                              </button>
                            ))}
                          </div>
                        </div>

                        <div className="nx-icm__controls-group">
                          <span className="nx-icm__controls-label">E. Physical Property Filters</span>
                          <div className="nx-icm__filter-grid">
                            <input className="nx-icm__field" type="number" value={buyerFilters.minBeds} onChange={(e) => onBuyerFiltersChange?.({ minBeds: e.target.value === '' ? '' : Number(e.target.value) })} placeholder="Beds Min" />
                            <input className="nx-icm__field" type="number" value={buyerFilters.maxBeds} onChange={(e) => onBuyerFiltersChange?.({ maxBeds: e.target.value === '' ? '' : Number(e.target.value) })} placeholder="Beds Max" />
                            <input className="nx-icm__field" type="number" value={buyerFilters.minBaths} onChange={(e) => onBuyerFiltersChange?.({ minBaths: e.target.value === '' ? '' : Number(e.target.value) })} placeholder="Baths Min" />
                            <input className="nx-icm__field" type="number" value={buyerFilters.maxBaths} onChange={(e) => onBuyerFiltersChange?.({ maxBaths: e.target.value === '' ? '' : Number(e.target.value) })} placeholder="Baths Max" />
                            <input className="nx-icm__field" type="number" value={buyerFilters.minUnits} onChange={(e) => onBuyerFiltersChange?.({ minUnits: e.target.value === '' ? '' : Number(e.target.value) })} placeholder="Units Min" />
                            <input className="nx-icm__field" type="number" value={buyerFilters.maxUnits} onChange={(e) => onBuyerFiltersChange?.({ maxUnits: e.target.value === '' ? '' : Number(e.target.value) })} placeholder="Units Max" />
                            <input className="nx-icm__field" type="number" value={buyerFilters.minSqft} onChange={(e) => onBuyerFiltersChange?.({ minSqft: e.target.value === '' ? '' : Number(e.target.value) })} placeholder="Sq Ft Min" />
                            <input className="nx-icm__field" type="number" value={buyerFilters.maxSqft} onChange={(e) => onBuyerFiltersChange?.({ maxSqft: e.target.value === '' ? '' : Number(e.target.value) })} placeholder="Sq Ft Max" />
                            <input className="nx-icm__field" type="number" value={buyerFilters.yearBuiltMin} onChange={(e) => onBuyerFiltersChange?.({ yearBuiltMin: e.target.value === '' ? '' : Number(e.target.value) })} placeholder="Year Built Min" />
                            <input className="nx-icm__field" type="number" value={buyerFilters.yearBuiltMax} onChange={(e) => onBuyerFiltersChange?.({ yearBuiltMax: e.target.value === '' ? '' : Number(e.target.value) })} placeholder="Year Built Max" />
                            <input className="nx-icm__field" value={buyerFilters.condition} onChange={(e) => onBuyerFiltersChange?.({ condition: e.target.value })} placeholder="Condition" />
                            <input className="nx-icm__field" value={buyerFilters.renovationLevel} onChange={(e) => onBuyerFiltersChange?.({ renovationLevel: e.target.value })} placeholder="Renovation Level" />
                          </div>
                        </div>

                        <div className="nx-icm__controls-group">
                          <span className="nx-icm__controls-label">F. Deal / Comp Filters</span>
                          <div className="nx-icm__filter-grid">
                            <input className="nx-icm__field" type="number" value={buyerFilters.minSalePrice} onChange={(e) => onBuyerFiltersChange?.({ minSalePrice: e.target.value === '' ? '' : Number(e.target.value) })} placeholder="Sale Price Min" />
                            <input className="nx-icm__field" type="number" value={buyerFilters.maxSalePrice} onChange={(e) => onBuyerFiltersChange?.({ maxSalePrice: e.target.value === '' ? '' : Number(e.target.value) })} placeholder="Sale Price Max" />
                            <input className="nx-icm__field" type="number" value={buyerFilters.minPricePerSqft} onChange={(e) => onBuyerFiltersChange?.({ minPricePerSqft: e.target.value === '' ? '' : Number(e.target.value) })} placeholder="Price / Sq Ft Min" />
                            <input className="nx-icm__field" type="number" value={buyerFilters.maxPricePerSqft} onChange={(e) => onBuyerFiltersChange?.({ maxPricePerSqft: e.target.value === '' ? '' : Number(e.target.value) })} placeholder="Price / Sq Ft Max" />
                            <input className="nx-icm__field" type="date" value={buyerFilters.soldDateFrom} onChange={(e) => onBuyerFiltersChange?.({ soldDateFrom: e.target.value })} />
                            <input className="nx-icm__field" type="date" value={buyerFilters.soldDateTo} onChange={(e) => onBuyerFiltersChange?.({ soldDateTo: e.target.value })} />
                          </div>
                          <div className="nx-icm__controls-segment nx-icm__controls-segment--pills">
                            {BUYER_DEAL_OPTIONS.map(([value, label]) => (
                              <button key={value} type="button" className={cls('nx-icm__mode-tab', buyerFilters.dealTypes.includes(value) && 'is-active')} onClick={() => toggleBuyerFilterArray('dealTypes', value)}>
                                {label}
                              </button>
                            ))}
                          </div>
                        </div>

                        <div className="nx-icm__controls-group">
                          <span className="nx-icm__controls-label">G. Location Filters</span>
                          <div className="nx-icm__filter-grid">
                            <input className="nx-icm__field" list="buyer-markets" value={buyerFilters.market} onChange={(e) => onBuyerFiltersChange?.({ market: e.target.value })} placeholder="Market" />
                            <input className="nx-icm__field" value={buyerFilters.submarket} onChange={(e) => onBuyerFiltersChange?.({ submarket: e.target.value })} placeholder="Submarket" />
                            <input className="nx-icm__field" value={buyerFilters.county} onChange={(e) => onBuyerFiltersChange?.({ county: e.target.value })} placeholder="County" />
                            <input className="nx-icm__field" value={buyerFilters.city} onChange={(e) => onBuyerFiltersChange?.({ city: e.target.value })} placeholder="City" />
                            <input className="nx-icm__field" list="buyer-zips" value={buyerFilters.zip} onChange={(e) => onBuyerFiltersChange?.({ zip: e.target.value })} placeholder="ZIP" />
                            <input className="nx-icm__field" value={buyerFilters.neighborhood} onChange={(e) => onBuyerFiltersChange?.({ neighborhood: e.target.value })} placeholder="Neighborhood" />
                            <input className="nx-icm__field" value={buyerFilters.censusTract} onChange={(e) => onBuyerFiltersChange?.({ censusTract: e.target.value })} placeholder="Census Tract" />
                            <input className="nx-icm__field" value={buyerFilters.schoolDistrict} onChange={(e) => onBuyerFiltersChange?.({ schoolDistrict: e.target.value })} placeholder="School District" />
                            <input className="nx-icm__field" type="number" value={buyerFilters.minDistanceFromSubject} onChange={(e) => onBuyerFiltersChange?.({ minDistanceFromSubject: e.target.value === '' ? '' : Number(e.target.value) })} placeholder="Distance Min" />
                            <input className="nx-icm__field" type="number" value={buyerFilters.maxDistanceFromSubject} onChange={(e) => onBuyerFiltersChange?.({ maxDistanceFromSubject: e.target.value === '' ? '' : Number(e.target.value) })} placeholder="Distance Max" />
                          </div>
                        </div>

                        <div className="nx-icm__controls-group">
                          <span className="nx-icm__controls-label">H. Buyer Match Filters</span>
                          <div className="nx-icm__filter-grid">
                            <input className="nx-icm__field" type="number" min={0} max={100} value={buyerFilters.minMatchScore} onChange={(e) => onBuyerFiltersChange?.({ minMatchScore: Number(e.target.value) || 0 })} placeholder="Buyer Match Score Min" />
                            <input className="nx-icm__field" type="number" min={0} max={100} value={buyerFilters.maxMatchScore} onChange={(e) => onBuyerFiltersChange?.({ maxMatchScore: e.target.value === '' ? '' : Number(e.target.value) })} placeholder="Buyer Match Score Max" />
                            <input className="nx-icm__field" type="number" min={0} max={100} value={buyerFilters.minConfidenceScore} onChange={(e) => onBuyerFiltersChange?.({ minConfidenceScore: e.target.value === '' ? '' : Number(e.target.value) })} placeholder="Confidence Score Min" />
                            <input className="nx-icm__field" type="number" min={0} max={100} value={buyerFilters.maxConfidenceScore} onChange={(e) => onBuyerFiltersChange?.({ maxConfidenceScore: e.target.value === '' ? '' : Number(e.target.value) })} placeholder="Confidence Score Max" />
                            <input className="nx-icm__field" type="number" min={0} max={100} value={buyerFilters.minDispoPriorityScore} onChange={(e) => onBuyerFiltersChange?.({ minDispoPriorityScore: Number(e.target.value) || 0 })} placeholder="Demand Score Min" />
                            <input className="nx-icm__field" type="number" min={0} max={100} value={buyerFilters.maxDispoPriorityScore} onChange={(e) => onBuyerFiltersChange?.({ maxDispoPriorityScore: e.target.value === '' ? '' : Number(e.target.value) })} placeholder="Demand Score Max" />
                            <input className="nx-icm__field" list="buyer-exit-strategies" value={buyerFilters.exitStrategyMatch} onChange={(e) => onBuyerFiltersChange?.({ exitStrategyMatch: e.target.value })} placeholder="Exit Strategy Match" />
                          </div>
                          <div className="nx-icm__controls-segment nx-icm__controls-segment--pills">
                            {BUYER_MATCH_OPTIONS.map(([value, label]) => (
                              <button key={value} type="button" className={cls('nx-icm__mode-tab', buyerFilters.matchTags.includes(value) && 'is-active')} onClick={() => toggleBuyerFilterArray('matchTags', value)}>
                                {label}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    </>
                  )}
                </>
              )}
              {activeControlsTab === 'census' && (
                <>
                  <div className="nx-icm__controls-group">
                    <span className="nx-icm__controls-label">Census Layers</span>
                    <div className="nx-icm__controls-segment">
                      {CENSUS_TOGGLE_DEFS.map((def) => (
                        <label key={def.key} className="nx-icm__checkbox">
                          <input type="checkbox" checked={censusLayers[def.key]} onChange={(e) => setSingleCensusMetric(def.key, e.target.checked)} />
                          {def.label}
                        </label>
                      ))}
                    </div>
                  </div>
                  <div className="nx-icm__controls-group">
                    <span className="nx-icm__controls-label">Census UI</span>
                    <div className="nx-icm__controls-segment">
                      <label className="nx-icm__checkbox">
                        <input type="checkbox" checked={showCensusDock} onChange={(event) => setShowCensusDock(event.target.checked)} />
                        Show Census Intelligence
                      </label>
                      <label className="nx-icm__checkbox">
                        <input type="checkbox" checked={showLegendPanel} onChange={(event) => setShowLegendPanel(event.target.checked)} />
                        Show Map Key
                      </label>
                    </div>
                  </div>
                  <CensusIntelPanel
                    data={censusPanelModel.data}
                    styleMode={mapStyleMode}
                    title={censusPanelModel.title}
                    subtitle={censusPanelModel.subtitle}
                    metrics={censusPanelModel.metrics}
                    emptyMessage={censusPanelModel.emptyMessage}
                  />
                </>
              )}
              {activeControlsTab === 'filters' && (
                <div className="nx-icm__controls-group">
                  <span className="nx-icm__controls-label">Thread Filters</span>
                  <div className="nx-icm__filter-grid">
                    <select className="nx-icm__field" value={filters.market} onChange={(e) => setFilters((current) => ({ ...current, market: e.target.value }))}>
                      <option value="">All Markets</option>
                      {markets.map((market) => <option key={market} value={market}>{market}</option>)}
                    </select>
                    <select className="nx-icm__field" value={filters.stage} onChange={(e) => setFilters((current) => ({ ...current, stage: e.target.value }))}>
                      <option value="">All Stages</option>
                      {stages.map((stage) => <option key={stage} value={stage}>{stage.replace(/_/g, ' ')}</option>)}
                    </select>
                    <select className="nx-icm__field" value={filters.status} onChange={(e) => setFilters((current) => ({ ...current, status: e.target.value }))}>
                      <option value="">All Statuses</option>
                      {statuses.map((status) => <option key={status} value={status}>{status.replace(/_/g, ' ')}</option>)}
                    </select>
                    <select className="nx-icm__field" value={filters.leadTemperature} onChange={(e) => setFilters((current) => ({ ...current, leadTemperature: e.target.value }))}>
                      <option value="">All Temperatures</option>
                      {temperatures.map((temperature) => <option key={temperature} value={temperature}>{temperature.replace(/_/g, ' ')}</option>)}
                    </select>
                    <select className="nx-icm__field" value={filters.automationStatus} onChange={(e) => setFilters((current) => ({ ...current, automationStatus: e.target.value }))}>
                      <option value="">All Automation</option>
                      {automationStatuses.map((status) => <option key={status} value={status}>{status}</option>)}
                    </select>
                    <select className="nx-icm__field" value={filters.propertyType} onChange={(e) => setFilters((current) => ({ ...current, propertyType: e.target.value }))}>
                      <option value="">All Property Types</option>
                      {propertyTypes.map((type) => <option key={type} value={type}>{type}</option>)}
                    </select>
                    <label className="nx-icm__checkbox"><input type="checkbox" checked={filters.unreadOnly} onChange={(e) => setFilters((current) => ({ ...current, unreadOnly: e.target.checked }))} />Unread</label>
                    <label className="nx-icm__checkbox"><input type="checkbox" checked={filters.followUpDue} onChange={(e) => setFilters((current) => ({ ...current, followUpDue: e.target.checked }))} />Follow-Up Due</label>
                    <label className="nx-icm__checkbox"><input type="checkbox" checked={filters.highEquity} onChange={(e) => setFilters((current) => ({ ...current, highEquity: e.target.checked }))} />High Equity</label>
                  </div>
                </div>
              )}
              {activeControlsTab === 'map_style' && (
                <>
                  <div className="nx-icm__controls-group">
                    <span className="nx-icm__controls-label">Map Style</span>
                    <div className="nx-icm__controls-segment">
                      {COMMAND_MAP_THEME_OPTIONS.map((theme) => (
                        <button key={theme.id} type="button" className={cls('nx-icm__mode-tab', mapStyleMode === theme.id && 'is-active')} onClick={() => setMapStyleMode(theme.id)}>
                          {theme.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="nx-icm__controls-group">
                    <span className="nx-icm__controls-label">Dimension</span>
                    <div className="nx-icm__controls-segment">
                      <button type="button" className={cls('nx-icm__mode-tab', mapDimension === '2d' && 'is-active')} onClick={() => setMapDimension('2d')}>
                        2D
                      </button>
                      <button type="button" className={cls('nx-icm__mode-tab', mapDimension === '3d' && 'is-active')} onClick={() => setMapDimension('3d')}>
                        3D
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
            <div className="nx-icm__controls-actions">
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

      <div ref={containerRef} className="nx-icm__canvas" />
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
        <div className="nx-icm__empty">
          <div className="nx-icm__empty-title">No Visible Pins</div>
          <p className="nx-icm__empty-sub">{emptyStateMessage}</p>
          {selectedHiddenByFilters && selectedBasePin && (
            <button type="button" className="nx-icm__mode-tab is-active" onClick={() => setShowSelectedHidden(true)}>
              Show Selected
            </button>
          )}
        </div>
      )}

      {selectedUnmapped && (
        <div className="nx-icm__empty" style={{ top: '56px', left: '50%', transform: 'translateX(-50%)', padding: '12px 16px' }}>
          <div className="nx-icm__empty-title">Selected Conversation Is Unmapped</div>
          <p className="nx-icm__empty-sub">No coordinates are available for {selectedUnmapped.seller_name || 'this conversation'}.</p>
        </div>
      )}

      {selectedHiddenByFilters && selectedBasePin && !showSelectedHidden && (
        <div className="nx-icm__empty" style={{ top: '56px', left: '50%', transform: 'translateX(-50%)', padding: '12px 16px' }}>
          <div className="nx-icm__empty-title">Selected Hidden By Filters</div>
          <p className="nx-icm__empty-sub">The selected conversation has coordinates but is excluded by the current filters.</p>
          <button type="button" className="nx-icm__mode-tab is-active" onClick={() => setShowSelectedHidden(true)}>
            Show Selected
          </button>
        </div>
      )}

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
          events={liveActivityEvents}
          settings={liveActivitySettings}
          performanceSettings={performanceSettings}
          isUltrawide={isUltrawide}
          reducedMotion={prefersReducedMotion || performanceSettings.animation !== 'full'}
          onSettingsChange={patchLiveActivitySettings}
          onPerformanceChange={patchPerformanceSettings}
          onSelectEvent={handleActivitySelect}
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

      {selectedSoldComp && (
        <div className="nx-icm__buyer-selection-shell">
          <SoldCompSelectionCard
            comp={selectedSoldComp}
            subject={selectedThread}
            onCenterMap={(lng, lat) => mapRef.current?.easeTo({ center: [lng, lat], zoom: Math.max(mapRef.current?.getZoom() ?? 11.8, 11.8), duration: 560 })}
            onClose={() => setSelectedSoldComp(null)}
          />
        </div>
      )}
    </div>
  )
}
