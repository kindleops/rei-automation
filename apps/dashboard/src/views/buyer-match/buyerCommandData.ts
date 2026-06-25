import { useEffect, useMemo, useState } from 'react'
import type { InboxWorkflowThread } from '../../lib/data/inboxWorkflowData'
import { getSupabaseClient } from '../../lib/supabaseClient'

export type BuyerNumericFilter = number | ''

export type BuyerMapFilters = {
  buyerType: string
  buyerTier: string
  activityWindowDays: 30 | 90 | 180 | 365
  radiusMiles: 1 | 3 | 5 | 10
  buyerSourceTypes: string[]
  buyerRoles: string[]
  buyerIdentityTags: string[]
  assetTypes: string[]
  dealTypes: string[]
  locationTags: string[]
  matchTags: string[]
  buyerName: string
  entityName: string
  mailingName: string
  companyName: string
  buyerPhone: string
  buyerEmail: string
  buyerMarket: string
  buyerState: string
  buyerZip: string
  market: string
  submarket: string
  county: string
  city: string
  state: string
  zip: string
  neighborhood: string
  schoolDistrict: string
  censusTract: string
  opportunityZone: string
  propertyType: string
  assetClass: string
  condition: string
  renovationLevel: string
  occupancy: string
  vacancy: string
  minPurchaseCount: number
  maxPurchaseCount: BuyerNumericFilter
  minMatchScore: number
  maxMatchScore: BuyerNumericFilter
  minDispoPriorityScore: number
  maxDispoPriorityScore: BuyerNumericFilter
  lastPurchaseDateFrom: string
  lastPurchaseDateTo: string
  firstPurchaseDateFrom: string
  firstPurchaseDateTo: string
  minVelocityScore: BuyerNumericFilter
  maxVelocityScore: BuyerNumericFilter
  minAveragePurchasePrice: BuyerNumericFilter
  maxAveragePurchasePrice: BuyerNumericFilter
  minMedianPurchasePrice: BuyerNumericFilter
  maxMedianPurchasePrice: BuyerNumericFilter
  minHighestPurchasePrice: BuyerNumericFilter
  maxHighestPurchasePrice: BuyerNumericFilter
  minLowestPurchasePrice: BuyerNumericFilter
  maxLowestPurchasePrice: BuyerNumericFilter
  minTotalSpend: BuyerNumericFilter
  maxTotalSpend: BuyerNumericFilter
  minCashPurchasePercent: BuyerNumericFilter
  maxCashPurchasePercent: BuyerNumericFilter
  minDaysSinceLastBuy: BuyerNumericFilter
  maxDaysSinceLastBuy: BuyerNumericFilter
  minBeds: BuyerNumericFilter
  maxBeds: BuyerNumericFilter
  minBaths: BuyerNumericFilter
  maxBaths: BuyerNumericFilter
  minUnits: BuyerNumericFilter
  maxUnits: BuyerNumericFilter
  minSqft: BuyerNumericFilter
  maxSqft: BuyerNumericFilter
  minLotSqft: BuyerNumericFilter
  maxLotSqft: BuyerNumericFilter
  minAcreage: BuyerNumericFilter
  maxAcreage: BuyerNumericFilter
  yearBuiltMin: BuyerNumericFilter
  yearBuiltMax: BuyerNumericFilter
  effectiveYearBuiltMin: BuyerNumericFilter
  effectiveYearBuiltMax: BuyerNumericFilter
  minStories: BuyerNumericFilter
  maxStories: BuyerNumericFilter
  minSalePrice: BuyerNumericFilter
  maxSalePrice: BuyerNumericFilter
  minPricePerSqft: BuyerNumericFilter
  maxPricePerSqft: BuyerNumericFilter
  minPricePerUnit: BuyerNumericFilter
  maxPricePerUnit: BuyerNumericFilter
  minArv: BuyerNumericFilter
  maxArv: BuyerNumericFilter
  minDiscountPercent: BuyerNumericFilter
  maxDiscountPercent: BuyerNumericFilter
  minSpreadPotential: BuyerNumericFilter
  maxSpreadPotential: BuyerNumericFilter
  minEstimatedRehab: BuyerNumericFilter
  maxEstimatedRehab: BuyerNumericFilter
  minEquityPercent: BuyerNumericFilter
  maxEquityPercent: BuyerNumericFilter
  soldDateFrom: string
  soldDateTo: string
  recordingDateFrom: string
  recordingDateTo: string
  minDistanceFromSubject: BuyerNumericFilter
  maxDistanceFromSubject: BuyerNumericFilter
  minConfidenceScore: BuyerNumericFilter
  maxConfidenceScore: BuyerNumericFilter
  minDemandScore: BuyerNumericFilter
  maxDemandScore: BuyerNumericFilter
  exitStrategyMatch: string
}

export const defaultBuyerMapFilters: BuyerMapFilters = {
  buyerType: '',
  buyerTier: '',
  activityWindowDays: 180,
  radiusMiles: 5,
  buyerSourceTypes: [],
  buyerRoles: [],
  buyerIdentityTags: [],
  assetTypes: [],
  dealTypes: [],
  locationTags: [],
  matchTags: [],
  buyerName: '',
  entityName: '',
  mailingName: '',
  companyName: '',
  buyerPhone: '',
  buyerEmail: '',
  buyerMarket: '',
  buyerState: '',
  buyerZip: '',
  market: '',
  submarket: '',
  county: '',
  city: '',
  state: '',
  zip: '',
  neighborhood: '',
  schoolDistrict: '',
  censusTract: '',
  opportunityZone: '',
  propertyType: '',
  assetClass: '',
  condition: '',
  renovationLevel: '',
  occupancy: '',
  vacancy: '',
  minPurchaseCount: 0,
  maxPurchaseCount: '',
  minMatchScore: 60,
  maxMatchScore: '',
  minDispoPriorityScore: 0,
  maxDispoPriorityScore: '',
  lastPurchaseDateFrom: '',
  lastPurchaseDateTo: '',
  firstPurchaseDateFrom: '',
  firstPurchaseDateTo: '',
  minVelocityScore: '',
  maxVelocityScore: '',
  minAveragePurchasePrice: '',
  maxAveragePurchasePrice: '',
  minMedianPurchasePrice: '',
  maxMedianPurchasePrice: '',
  minHighestPurchasePrice: '',
  maxHighestPurchasePrice: '',
  minLowestPurchasePrice: '',
  maxLowestPurchasePrice: '',
  minTotalSpend: '',
  maxTotalSpend: '',
  minCashPurchasePercent: '',
  maxCashPurchasePercent: '',
  minDaysSinceLastBuy: '',
  maxDaysSinceLastBuy: '',
  minBeds: '',
  maxBeds: '',
  minBaths: '',
  maxBaths: '',
  minUnits: '',
  maxUnits: '',
  minSqft: '',
  maxSqft: '',
  minLotSqft: '',
  maxLotSqft: '',
  minAcreage: '',
  maxAcreage: '',
  yearBuiltMin: '',
  yearBuiltMax: '',
  effectiveYearBuiltMin: '',
  effectiveYearBuiltMax: '',
  minStories: '',
  maxStories: '',
  minSalePrice: '',
  maxSalePrice: '',
  minPricePerSqft: '',
  maxPricePerSqft: '',
  minPricePerUnit: '',
  maxPricePerUnit: '',
  minArv: '',
  maxArv: '',
  minDiscountPercent: '',
  maxDiscountPercent: '',
  minSpreadPotential: '',
  maxSpreadPotential: '',
  minEstimatedRehab: '',
  maxEstimatedRehab: '',
  minEquityPercent: '',
  maxEquityPercent: '',
  soldDateFrom: '',
  soldDateTo: '',
  recordingDateFrom: '',
  recordingDateTo: '',
  minDistanceFromSubject: '',
  maxDistanceFromSubject: '',
  minConfidenceScore: '',
  maxConfidenceScore: '',
  minDemandScore: '',
  maxDemandScore: '',
  exitStrategyMatch: '',
}

export type BuyerCategory = 'institutional' | 'landlord' | 'flipper' | 'builder' | 'general'

export type BuyerProfileSummary = {
  buyerKey: string
  buyerName: string
  buyerType: string
  buyerTier: string
  buyerGrade: string
  isCorporateBuyer: boolean
  isRepeatBuyer: boolean
  isRealBuyer: boolean
  isLocalBuyer: boolean
  isOffMarketBuyer: boolean
  isRetailOrNoise: boolean
  marketsActive: string[]
  statesActive: string[]
  zipsActive: string[]
  topMarkets: string[]
  topStates: string[]
  topZips: string[]
  propertyTypeFocus: string[]
  assetClassesBought: string[]
  avgPurchasePrice: number | null
  medianPurchasePrice: number | null
  purchaseCountTotal: number | null
  purchaseCount6mo: number | null
  purchaseCount12mo: number | null
  lastPurchaseDate: string | null
  velocityScore: number | null
  marketFocusScore: number | null
  assetFitScore: number | null
  cashBuyerScore: number | null
  dispoPriorityScore: number | null
  confidenceScore: number | null
  buyerSummary: string
  recommendedAction: string
  buyerExitStrategy: string
  offMarketPurchaseCount: number | null
  mlsPurchaseCount: number | null
  category: BuyerCategory
}

export type BuyerMatchSummary = {
  matchKey: string
  buyerKey: string
  buyerProfileId: string
  buyerName: string
  buyerTier: string
  buyerGrade: string
  propertyId: string
  masterOwnerId: string
  ownerKey: string
  propertyAddressFull: string
  propertyAddressCity: string
  propertyAddressState: string
  propertyAddressZip: string
  market: string
  propertyType: string
  targetPrice: number | null
  estimatedValue: number | null
  estimatedRepairCost: number | null
  potentialSpread: number | null
  matchScore: number | null
  marketFitScore: number | null
  priceFitScore: number | null
  assetFitScore: number | null
  velocityScore: number | null
  confidence: number | null
  reasonForMatch: string
  recommendedAction: string
  dispositionStrategy: string
  matchStatus: string
  topMarkets: string[]
  topZips: string[]
  assetClassesBought: string[]
  medianPurchasePrice: number | null
  category: BuyerCategory
}

export type BuyerRecentPurchase = {
  propertyId: string
  propertyAddressFull: string
  propertyAddressCity: string
  propertyAddressState: string
  propertyAddressZip: string
  market: string
  propertyType: string
  ownerName: string
  buyerName: string
  buyerNameClean: string
  buyerKey: string
  saleDate: string | null
  salePrice: number | null
  estimatedValue: number | null
  buildingSquareFeet: number | null
  unitsCount: number | null
  totalBedrooms: number | null
  totalBaths: number | null
  yearBuilt: number | null
  pricePerSqft: number | null
  pricePerUnit: number | null
  latitude: number
  longitude: number
  buyerEntityStrength: string
  buyerBuyBoxSignal: string
  buyerActivitySignal: string
  compQualityScore: number | null
  resaleMarginScore: number | null
  investorFitScore: number | null
  arvEstimate: number | null
  compConfidenceScore: number | null
  dealGrade: string
  isCorporateBuyer: boolean
  isOffMarketPurchase: boolean
  isRetailOrNoise: boolean
  category: BuyerCategory
  distanceMiles: number | null
}

export type BuyerProfilePoint = {
  buyerKey: string
  buyerName: string
  buyerType: string
  buyerTier: string
  buyerGrade: string
  isCorporateBuyer: boolean
  isRepeatBuyer: boolean
  isLocalBuyer: boolean
  isOffMarketBuyer: boolean
  isRetailOrNoise: boolean
  category: BuyerCategory
  latitude: number
  longitude: number
  market: string
  state: string
  zip: string
  propertyTypes: string[]
  purchaseCount: number
  avgPurchasePrice: number | null
  recentPurchaseDate: string | null
  velocityScore: number | null
  dispoPriorityScore: number | null
  confidenceScore: number | null
}

export type BuyerDemandSummary = {
  activeBuyerMatches: number
  topBuyerMatch: string
  averageMatchScore: number | null
  recentPurchasesNearby: number
  buyerDemandScore: number
  demandLabel: 'Limited' | 'Moderate' | 'Strong'
  strongestBuyerType: string
  likelyExitStrategy: string
  dispoConfidence: number
  recommendedAction: string
  realBuyerCount: number
  repeatBuyerCount: number
  corporateBuyerCount: number
  localBuyerCount: number
  offMarketBuyerCount: number
  noiseBuyerCount: number
  topMarkets: string[]
}

export type BuyerCommandData = {
  profiles: BuyerProfileSummary[]
  matches: BuyerMatchSummary[]
  recentPurchases: BuyerRecentPurchase[]
  profilePoints: BuyerProfilePoint[]
  summary: BuyerDemandSummary | null
  loading: boolean
  error: string | null
  hasLiveProfiles: boolean
  hasLiveMatches: boolean
}

type PropertyContext = {
  propertyId: string
  masterOwnerId: string
  propertyAddressFull: string
  market: string
  state: string
  zip: string
  propertyType: string
  estimatedValue: number | null
  lat: number | null
  lng: number | null
}

const asText = (value: unknown, fallback = ''): string => {
  const text = String(value ?? '').trim()
  return text || fallback
}

const asNumber = (value: unknown): number | null => {
  const next = Number(String(value ?? '').replace(/[,$\s]/g, ''))
  return Number.isFinite(next) ? next : null
}

const asBoolean = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value
  const lowered = asText(value).toLowerCase()
  return lowered === 'true' || lowered === 't' || lowered === '1' || lowered === 'yes'
}

const asStringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map((item) => asText(item)).filter(Boolean)
  const text = asText(value)
  if (!text) return []
  return text.split(',').map((item) => item.trim()).filter(Boolean)
}

const lower = (value: unknown): string => asText(value).toLowerCase()

const categoryFromSignals = (...values: Array<unknown>): BuyerCategory => {
  const haystack = values.map((value) => lower(value)).join(' ')
  if (haystack.includes('fund') || haystack.includes('institution') || haystack.includes('secretary')) return 'institutional'
  if (haystack.includes('builder') || haystack.includes('new construction') || haystack.includes('build')) return 'builder'
  if (haystack.includes('flip') || haystack.includes('rehab') || haystack.includes('off-market')) return 'flipper'
  if (haystack.includes('rental') || haystack.includes('landlord') || haystack.includes('hold')) return 'landlord'
  return 'general'
}

const clamp = (value: number, min = 0, max = 100): number => Math.max(min, Math.min(max, value))

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

const propertyContextFromThread = (thread: InboxWorkflowThread | null): PropertyContext | null => {
  if (!thread) return null
  const row = thread as unknown as Record<string, unknown>
  const lat = asNumber(row.lat ?? row.latitude)
  const lng = asNumber(row.lng ?? row.longitude)
  return {
    propertyId: asText(row.propertyId ?? row.property_id),
    masterOwnerId: asText(row.ownerId ?? row.master_owner_id),
    propertyAddressFull: asText(row.propertyAddressFull ?? row.property_address_full ?? row.propertyAddress),
    market: asText(row.market ?? row.marketName ?? row.marketId),
    state: asText(row.property_address_state ?? row.state),
    zip: asText(row.property_address_zip ?? row.zip),
    propertyType: asText(row.propertyType ?? row.property_type),
    estimatedValue: asNumber(row.estimatedValue ?? row.estimated_value),
    lat,
    lng,
  }
}

const supportsQuery = (error: unknown): boolean => {
  const code = (error as { code?: string } | null)?.code
  return code !== '42P01' && code !== '42703'
}

const fetchFirstAvailable = async <T,>(
  tables: string[],
  run: (table: string) => Promise<{ data: T[] | null; error: unknown }>,
): Promise<{ rows: T[]; table: string | null; error: string | null }> => {
  for (const table of tables) {
    const { data, error } = await run(table)
    if (!error) return { rows: data ?? [], table, error: null }
    if (!supportsQuery(error)) continue
    return { rows: [], table, error: error instanceof Error ? error.message : String(error) }
  }
  return { rows: [], table: null, error: null }
}

const toBuyerProfile = (row: Record<string, unknown>): BuyerProfileSummary => {
  const buyerGrade = asText(row.buyer_grade, asText(row.buyer_tier, 'Watchlist'))
  const confidenceScore = asNumber(row.buyer_confidence_score ?? row.confidence_score)
  const purchaseCount6mo = asNumber(row.purchase_count_6mo)
  const purchaseCount12mo = asNumber(row.purchase_count_12mo)
  const markets = asStringArray(row.top_markets ?? row.markets_active)
  const states = asStringArray(row.top_states ?? row.states_active)
  const zips = asStringArray(row.top_zips ?? row.zips_active)
  const propertyTypes = asStringArray(row.property_types_bought ?? row.property_type_focus)
  const assetClasses = asStringArray(row.asset_classes_bought)
  const isCorporateBuyer = asBoolean(row.is_corporate_buyer)
  const isRepeatBuyer = asBoolean(row.is_repeat_buyer) || (purchaseCount12mo ?? 0) >= 2
  const isRealBuyer = asBoolean(row.is_real_buyer) || ['A+', 'A', 'B'].includes(buyerGrade)
  const isLocalBuyer = asBoolean(row.is_local_buyer)
  const isOffMarketBuyer = asBoolean(row.is_off_market_buyer) || (asNumber(row.off_market_purchase_count) ?? 0) > 0
  const isRetailOrNoise = asBoolean(row.is_retail_or_noise) || ['Noise', 'Watchlist'].includes(buyerGrade)
  const buyerType = isCorporateBuyer ? 'Corporate Buyer' : 'Individual Buyer'
  const recommendedAction =
    buyerGrade === 'A+' || buyerGrade === 'A'
      ? 'Prioritize for Buyer Match and route into the live buyer overlay.'
      : buyerGrade === 'B'
        ? 'Keep in the active pool and verify buy-box fit before blast.'
        : isRetailOrNoise
          ? 'Separate from real buyer flow until repeat activity is confirmed.'
          : 'Review manually before promoting to active buyer pool.'

  return {
    buyerKey: asText(row.buyer_entity_key, asText(row.buyer_key, 'buyer')),
    buyerName: asText(row.buyer_display_name, asText(row.buyer_name, 'Property Buyer')),
    buyerType,
    buyerTier: buyerGrade,
    buyerGrade,
    isCorporateBuyer,
    isRepeatBuyer,
    isRealBuyer,
    isLocalBuyer,
    isOffMarketBuyer,
    isRetailOrNoise,
    marketsActive: markets,
    statesActive: states,
    zipsActive: zips,
    topMarkets: markets,
    topStates: states,
    topZips: zips,
    propertyTypeFocus: propertyTypes,
    assetClassesBought: assetClasses,
    avgPurchasePrice: asNumber(row.avg_purchase_price),
    medianPurchasePrice: asNumber(row.median_purchase_price),
    purchaseCountTotal: purchaseCount12mo,
    purchaseCount6mo,
    purchaseCount12mo,
    lastPurchaseDate: asText(row.last_purchase_date) || null,
    velocityScore: purchaseCount6mo != null ? clamp(purchaseCount6mo * 12) : null,
    marketFocusScore: asNumber(row.markets_active_count) != null ? clamp((asNumber(row.markets_active_count) ?? 0) * 18) : null,
    assetFitScore: propertyTypes.length > 0 ? clamp(propertyTypes.length * 18) : null,
    cashBuyerScore: isOffMarketBuyer ? clamp(((asNumber(row.off_market_purchase_count) ?? 0) / Math.max(purchaseCount12mo ?? 1, 1)) * 100) : 0,
    dispoPriorityScore: confidenceScore,
    confidenceScore,
    buyerSummary: asText(row.buyer_signal_summary, asText(row.buyer_summary, 'Buyer entity intelligence is loading.')),
    recommendedAction,
    buyerExitStrategy:
      assetClasses.join(' ').includes('multifamily')
        ? 'Rental Hold'
        : isOffMarketBuyer
          ? 'Value-Add / Flip'
          : 'Rental Hold / Retail Exit',
    offMarketPurchaseCount: asNumber(row.off_market_purchase_count),
    mlsPurchaseCount: asNumber(row.mls_purchase_count),
    category: categoryFromSignals(
      buyerType,
      buyerGrade,
      row.buyer_signal_summary,
      assetClasses.join(' '),
      propertyTypes.join(' '),
    ),
  }
}

const toBuyerMatch = (
  row: Record<string, unknown>,
  context: PropertyContext | null,
): BuyerMatchSummary => {
  const buyerGrade = asText(row.buyer_grade, 'Watchlist')
  const assetClassesBought = asStringArray(row.asset_classes_bought)
  const topMarkets = asStringArray(row.top_markets)
  const topZips = asStringArray(row.top_zips)
  return {
    matchKey: asText(row.buyer_entity_key, crypto.randomUUID?.() ?? 'match'),
    buyerKey: asText(row.buyer_entity_key, 'buyer'),
    buyerProfileId: asText(row.buyer_entity_key, 'buyer'),
    buyerName: asText(row.buyer_display_name, 'Property Buyer'),
    buyerTier: buyerGrade,
    buyerGrade,
    propertyId: context?.propertyId || '',
    masterOwnerId: context?.masterOwnerId || '',
    ownerKey: context?.masterOwnerId || '',
    propertyAddressFull: context?.propertyAddressFull || 'Property Unknown',
    propertyAddressCity: '',
    propertyAddressState: context?.state || '',
    propertyAddressZip: context?.zip || '',
    market: context?.market || 'Market Unknown',
    propertyType: context?.propertyType || 'Unknown',
    targetPrice: context?.estimatedValue ?? null,
    estimatedValue: context?.estimatedValue ?? null,
    estimatedRepairCost: null,
    potentialSpread: null,
    matchScore: asNumber(row.match_score),
    marketFitScore: asNumber(row.match_score),
    priceFitScore: null,
    assetFitScore: null,
    velocityScore: asNumber(row.purchase_count_6mo) != null ? clamp((asNumber(row.purchase_count_6mo) ?? 0) * 10) : null,
    confidence: asNumber(row.buyer_confidence_score),
    reasonForMatch: asText(row.reason_matched, 'Buyer matched on geography, activity, and buy-box overlap.'),
    recommendedAction: 'View Buyer Purchases',
    dispositionStrategy:
      assetClassesBought.join(' ').includes('multifamily')
        ? 'Rental Hold'
        : buyerGrade === 'A+' || buyerGrade === 'A'
          ? 'Fast Dispo'
          : 'Selective Outreach',
    matchStatus: 'ready',
    topMarkets,
    topZips,
    assetClassesBought,
    medianPurchasePrice: asNumber(row.median_purchase_price),
    category: categoryFromSignals(buyerGrade, row.reason_matched, assetClassesBought.join(' '), topMarkets.join(' ')),
  }
}

const toRecentPurchase = (
  row: Record<string, unknown>,
  context: PropertyContext | null,
  profile: BuyerProfileSummary | null,
): BuyerRecentPurchase | null => {
  const latitude = asNumber(row.latitude)
  const longitude = asNumber(row.longitude)
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
  const salePrice = asNumber(row.sale_price)
  const sqft = asNumber(row.building_square_feet)
  const distanceMiles =
    context?.lat != null && context?.lng != null
      ? haversineMiles(context.lat, context.lng, latitude as number, longitude as number)
      : null
  return {
    propertyId: asText(row.property_id, asText(row.id)),
    propertyAddressFull: asText(row.property_address_full, 'Property Unknown'),
    propertyAddressCity: asText(row.property_address_city),
    propertyAddressState: asText(row.property_address_state),
    propertyAddressZip: asText(row.property_address_zip),
    market: asText(row.market, 'Market Unknown'),
    propertyType: asText(row.property_type, 'Unknown'),
    ownerName: asText(row.owner_name, asText(row.owner_1_name, asText(row.owner_2_name))),
    buyerName: asText(row.buyer_display_name, profile?.buyerName || 'Property Buyer'),
    buyerNameClean: asText(row.buyer_entity_key, profile?.buyerKey || 'buyer'),
    buyerKey: asText(row.buyer_entity_key, profile?.buyerKey || 'buyer'),
    saleDate: asText(row.sale_date) || null,
    salePrice,
    estimatedValue: null,
    buildingSquareFeet: sqft,
    unitsCount: null,
    totalBedrooms: asNumber(row.total_bedrooms),
    totalBaths: asNumber(row.total_baths),
    yearBuilt: asNumber(row.year_built),
    pricePerSqft: salePrice != null && sqft != null && sqft > 0 ? salePrice / sqft : null,
    pricePerUnit: null,
    latitude: latitude as number,
    longitude: longitude as number,
    buyerEntityStrength: profile?.buyerGrade || 'Watchlist',
    buyerBuyBoxSignal:
      profile?.assetClassesBought.join(', ')
      || profile?.propertyTypeFocus.join(', ')
      || asText(row.normalized_asset_class, asText(row.property_type)),
    buyerActivitySignal: profile?.buyerSummary || 'Live buyer activity',
    compQualityScore: profile?.confidenceScore ?? null,
    resaleMarginScore: null,
    investorFitScore: profile?.confidenceScore ?? null,
    arvEstimate: null,
    compConfidenceScore: profile?.confidenceScore ?? null,
    dealGrade: profile?.buyerGrade || 'Watchlist',
    isCorporateBuyer: asBoolean(row.is_corporate_buyer) || Boolean(profile?.isCorporateBuyer),
    isOffMarketPurchase: asBoolean(row.is_off_market_purchase),
    isRetailOrNoise: Boolean(profile?.isRetailOrNoise),
    category: categoryFromSignals(
      profile?.buyerType,
      profile?.buyerSummary,
      row.property_type,
      row.normalized_asset_class,
      row.market,
    ),
    distanceMiles,
  }
}

const buildProfilePoints = (
  profiles: BuyerProfileSummary[],
  purchases: BuyerRecentPurchase[],
): BuyerProfilePoint[] => {
  const purchasesByBuyer = new Map<string, BuyerRecentPurchase[]>()
  purchases.forEach((purchase) => {
    const bucket = purchasesByBuyer.get(purchase.buyerKey) ?? []
    bucket.push(purchase)
    purchasesByBuyer.set(purchase.buyerKey, bucket)
  })

  return profiles
    .map((profile) => {
      const items = purchasesByBuyer.get(profile.buyerKey) ?? []
      const latest = [...items].sort((left, right) => new Date(right.saleDate || 0).getTime() - new Date(left.saleDate || 0).getTime())[0] ?? null
      return {
        buyerKey: profile.buyerKey,
        buyerName: profile.buyerName,
        buyerType: profile.buyerType,
        buyerTier: profile.buyerTier,
        buyerGrade: profile.buyerGrade,
        isCorporateBuyer: profile.isCorporateBuyer,
        isRepeatBuyer: profile.isRepeatBuyer,
        isLocalBuyer: profile.isLocalBuyer,
        isOffMarketBuyer: profile.isOffMarketBuyer,
        isRetailOrNoise: profile.isRetailOrNoise,
        category: profile.category,
        latitude: latest?.latitude ?? 0,
        longitude: latest?.longitude ?? 0,
        market: latest?.market || profile.topMarkets[0] || '',
        state: latest?.propertyAddressState || profile.topStates[0] || '',
        zip: latest?.propertyAddressZip || profile.topZips[0] || '',
        propertyTypes: profile.propertyTypeFocus,
        purchaseCount: profile.purchaseCount6mo ?? profile.purchaseCount12mo ?? items.length,
        avgPurchasePrice: profile.avgPurchasePrice,
        recentPurchaseDate: latest?.saleDate ?? profile.lastPurchaseDate ?? null,
        velocityScore: profile.velocityScore,
        dispoPriorityScore: profile.dispoPriorityScore,
        confidenceScore: profile.confidenceScore,
      }
    })
    .filter((point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude) && point.latitude !== 0 && point.longitude !== 0)
}

const computeDemandSummary = (
  profiles: BuyerProfileSummary[],
  matches: BuyerMatchSummary[],
  purchases: BuyerRecentPurchase[],
): BuyerDemandSummary | null => {
  if (profiles.length === 0 && matches.length === 0 && purchases.length === 0) return null
  const topMatch = [...matches].sort((left, right) => (right.matchScore ?? 0) - (left.matchScore ?? 0))[0] ?? null
  const nearbyPurchases = purchases.filter((purchase) => purchase.distanceMiles == null || purchase.distanceMiles <= 5)
  const avgMatchScore = matches.length > 0
    ? Math.round(matches.reduce((sum, item) => sum + (item.matchScore ?? 0), 0) / matches.length)
    : null
  const avgConfidence = profiles.length > 0
    ? profiles.reduce((sum, item) => sum + (item.confidenceScore ?? 0), 0) / profiles.length
    : matches.length > 0
      ? matches.reduce((sum, item) => sum + (item.confidence ?? 0), 0) / matches.length
      : 0
  const realBuyerCount = profiles.filter((profile) => profile.isRealBuyer).length
  const repeatBuyerCount = profiles.filter((profile) => profile.isRepeatBuyer).length
  const corporateBuyerCount = profiles.filter((profile) => profile.isCorporateBuyer).length
  const localBuyerCount = profiles.filter((profile) => profile.isLocalBuyer).length
  const offMarketBuyerCount = profiles.filter((profile) => profile.isOffMarketBuyer).length
  const noiseBuyerCount = profiles.filter((profile) => profile.isRetailOrNoise).length
  const demandScore = clamp(
    Math.round(
      (avgMatchScore ?? 54) * 0.42 +
      Math.min(realBuyerCount, 20) * 1.6 +
      Math.min(repeatBuyerCount, 15) * 1.2 +
      Math.min(nearbyPurchases.length, 25) * 1.1 +
      avgConfidence * 0.16,
    ),
  )
  const demandLabel: BuyerDemandSummary['demandLabel'] =
    demandScore >= 78 ? 'Strong' : demandScore >= 58 ? 'Moderate' : 'Limited'
  const topMarkets = Array.from(new Set(profiles.flatMap((profile) => profile.topMarkets).filter(Boolean))).slice(0, 5)
  const strongestBuyerType =
    profiles.sort((left, right) => (right.purchaseCount6mo ?? 0) - (left.purchaseCount6mo ?? 0))[0]?.buyerType
    || topMatch?.buyerGrade
    || 'Investor'
  const likelyExitStrategy =
    topMatch?.dispositionStrategy
    || profiles.find((profile) => profile.isOffMarketBuyer)?.buyerExitStrategy
    || profiles[0]?.buyerExitStrategy
    || 'Rental Hold / Value-Add'
  const recommendedAction =
    demandScore >= 80
      ? 'Work the real buyer pool first, then expand to local/off-market operators.'
      : demandScore >= 58
        ? 'Tighten the match radius and prioritize repeat buyers with fresh activity.'
        : 'Keep noise separated and widen market/price tolerance before blast.'

  return {
    activeBuyerMatches: matches.length,
    topBuyerMatch: topMatch?.buyerName || profiles[0]?.buyerName || 'No live buyer yet',
    averageMatchScore: avgMatchScore,
    recentPurchasesNearby: nearbyPurchases.length,
    buyerDemandScore: demandScore,
    demandLabel,
    strongestBuyerType,
    likelyExitStrategy,
    dispoConfidence: clamp(Math.round(avgConfidence)),
    recommendedAction,
    realBuyerCount,
    repeatBuyerCount,
    corporateBuyerCount,
    localBuyerCount,
    offMarketBuyerCount,
    noiseBuyerCount,
    topMarkets,
  }
}

const hasTextMatch = (haystack: unknown, needle: string): boolean =>
  !needle || lower(haystack).includes(lower(needle))

const passesNumericRange = (value: number | null | undefined, min?: BuyerNumericFilter, max?: BuyerNumericFilter): boolean => {
  if (min !== '' && min != null && (value == null || value < min)) return false
  if (max !== '' && max != null && (value == null || value > max)) return false
  return true
}

const passesDateRange = (value: string | null | undefined, from?: string, to?: string): boolean => {
  const ts = value ? new Date(value).getTime() : NaN
  if (from) {
    const fromTs = new Date(from).getTime()
    if (!Number.isFinite(ts) || ts < fromTs) return false
  }
  if (to) {
    const toTs = new Date(to).getTime()
    if (!Number.isFinite(ts) || ts > toTs) return false
  }
  return true
}

const daysSince = (value: string | null | undefined): number | null => {
  const ts = value ? new Date(value).getTime() : NaN
  if (!Number.isFinite(ts)) return null
  return Math.max(0, Math.floor((Date.now() - ts) / 86400_000))
}

const includesAny = (active: string[], candidates: Array<string | null | undefined>): boolean =>
  active.length === 0 || active.some((item) => candidates.some((candidate) => lower(candidate) === lower(item)))

const deriveProfileRoleTags = (profile: BuyerProfileSummary): string[] => {
  const tags = new Set<string>()
  tags.add(profile.isOffMarketBuyer ? 'off_market_buyer' : 'mls_buyer')
  if (profile.isRepeatBuyer) tags.add('repeat_buyer')
  if (profile.isCorporateBuyer) tags.add('corporate_buyer')
  if (profile.isLocalBuyer) tags.add('local_investor')
  if (!profile.isLocalBuyer) tags.add('out_of_state_buyer')
  if (profile.isRetailOrNoise) tags.add('retail_noise')
  if (profile.category === 'institutional') tags.add('institutional_buyer')
  if (profile.category === 'builder') tags.add('builder')
  if (profile.category === 'landlord') tags.add('landlord')
  if (profile.category === 'flipper') tags.add('flipper')
  if (!profile.isCorporateBuyer) tags.add('individual_buyer')
  if (profile.cashBuyerScore != null && profile.cashBuyerScore >= 65) tags.add('cash_buyer')
  if (profile.cashBuyerScore != null && profile.cashBuyerScore < 65) tags.add('financed_purchase')
  if (lower(profile.buyerSummary).includes('wholesale')) tags.add('wholesaler')
  if (lower(profile.buyerSummary).includes('hard money')) tags.add('hard_money_buyer')
  if (profile.isOffMarketBuyer) tags.add('public_record_buyer')
  return Array.from(tags)
}

export const useBuyerCommandData = (
  selectedThread: InboxWorkflowThread | null,
  filters: BuyerMapFilters,
  options: { enabled?: boolean } = {},
): BuyerCommandData => {
  const enabled = options.enabled !== false
  const [state, setState] = useState<BuyerCommandData>({
    profiles: [],
    matches: [],
    recentPurchases: [],
    profilePoints: [],
    summary: null,
    loading: false,
    error: null,
    hasLiveProfiles: false,
    hasLiveMatches: false,
  })

  const context = useMemo(() => propertyContextFromThread(selectedThread), [selectedThread])

  useEffect(() => {
    if (!enabled || !context) {
      setState((current) => ({
        ...current,
        profiles: [],
        matches: [],
        recentPurchases: [],
        profilePoints: [],
        summary: null,
        loading: false,
        error: null,
      }))
      return
    }

    let active = true
    let cancelIdle: (() => void) | null = null
    setState((current) => ({ ...current, loading: true, error: null }))

    const load = async () => {
      const supabase = getSupabaseClient()

      const profileResult = await fetchFirstAvailable<Record<string, unknown>>(
        ['v_buyer_entity_leaderboard', 'top_buyer_profiles', 'buyer_profiles_computed', 'buyer_profiles'],
        async (table) => {
          const query = supabase
            .from(table)
            .select('*')
            .order(table === 'v_buyer_entity_leaderboard' ? 'buyer_confidence_score' : 'dispo_priority_score', { ascending: false, nullsFirst: false })
            .limit(200)

          return await query
        },
      )

      const purchaseResult = await fetchFirstAvailable<Record<string, unknown>>(
        ['v_buyer_entity_purchases', 'recently_sold_properties_computed', 'recently_sold_properties'],
        async (table) => {
          let query = supabase
            .from(table)
            .select('*')
            .not('latitude', 'is', null)
            .not('longitude', 'is', null)
            .order('sale_date', { ascending: false, nullsFirst: false })
            .limit(500)

          const market = filters.market || context.market
          const state = filters.state || context.state
          const propertyType = filters.propertyType || context.propertyType

          if (market && table === 'v_buyer_entity_purchases') query = query.eq('market', market)
          else if (state) query = query.eq('property_address_state', state)
          if (filters.zip || context.zip) query = query.eq('property_address_zip', filters.zip || context.zip)
          if (propertyType) query = query.eq('property_type', propertyType)

          return await query
        },
      )

      let matchRows: Record<string, unknown>[] = []
      let matchError: string | null = null
      if (context.propertyId) {
        const { data, error } = await supabase.rpc('get_buyers_for_property', {
          p_property_id: context.propertyId,
          p_limit: 40,
        })
        matchRows = (data ?? []) as Record<string, unknown>[]
        matchError = error ? (error instanceof Error ? error.message : String(error)) : null
      }

      if (!active) return

      const rawProfiles = profileResult.rows.map(toBuyerProfile)
      const profiles = rawProfiles.filter((profile) => {
        const market = filters.market || context.market
        const state = filters.state || context.state
        const zip = filters.zip || context.zip
        const propertyType = filters.propertyType || context.propertyType
        const roleTags = deriveProfileRoleTags(profile)
        if (filters.buyerType && lower(profile.buyerType) !== lower(filters.buyerType)) return false
        if (filters.buyerTier && lower(profile.buyerTier) !== lower(filters.buyerTier)) return false
        if (!hasTextMatch(profile.buyerName, filters.buyerName)) return false
        if (!hasTextMatch(profile.buyerName, filters.companyName)) return false
        if (!hasTextMatch(profile.buyerName, filters.entityName)) return false
        if (!hasTextMatch(profile.buyerName, filters.mailingName)) return false
        if (filters.buyerIdentityTags.includes('llc_corp') && !/llc|inc|corp|company|holdings|lp|l\.p\./i.test(profile.buyerName)) return false
        if (filters.buyerIdentityTags.includes('individual_buyer') && profile.isCorporateBuyer) return false
        if (filters.buyerRoles.length > 0 && !filters.buyerRoles.every((role) => roleTags.includes(role))) return false
        if (!passesNumericRange(profile.purchaseCount12mo, filters.minPurchaseCount, filters.maxPurchaseCount)) return false
        if (!passesNumericRange(profile.dispoPriorityScore, filters.minDispoPriorityScore, filters.maxDispoPriorityScore)) return false
        if (!passesNumericRange(profile.confidenceScore, filters.minConfidenceScore, filters.maxConfidenceScore)) return false
        if (!passesNumericRange(profile.velocityScore, filters.minVelocityScore, filters.maxVelocityScore)) return false
        if (!passesNumericRange(profile.avgPurchasePrice, filters.minAveragePurchasePrice, filters.maxAveragePurchasePrice)) return false
        if (!passesNumericRange(profile.medianPurchasePrice, filters.minMedianPurchasePrice, filters.maxMedianPurchasePrice)) return false
        if (!passesNumericRange(profile.cashBuyerScore, filters.minCashPurchasePercent, filters.maxCashPurchasePercent)) return false
        if (!passesNumericRange(daysSince(profile.lastPurchaseDate), filters.minDaysSinceLastBuy, filters.maxDaysSinceLastBuy)) return false
        if (!passesDateRange(profile.lastPurchaseDate, filters.lastPurchaseDateFrom, filters.lastPurchaseDateTo)) return false
        if (market && profile.topMarkets.length > 0 && !profile.topMarkets.some((value) => lower(value) === lower(market))) return false
        if (!market && state && profile.topStates.length > 0 && !profile.topStates.some((value) => lower(value) === lower(state))) return false
        if (zip && profile.topZips.length > 0 && !profile.topZips.includes(zip)) return false
        if (propertyType && profile.propertyTypeFocus.length > 0 && !profile.propertyTypeFocus.some((value) => lower(value) === lower(propertyType))) return false
        if (filters.assetClass && profile.assetClassesBought.length > 0 && !profile.assetClassesBought.some((value) => lower(value) === lower(filters.assetClass))) return false
        if (filters.assetTypes.length > 0 && !includesAny(filters.assetTypes, [...profile.propertyTypeFocus, ...profile.assetClassesBought])) return false
        if (filters.buyerMarket && profile.topMarkets.length > 0 && !profile.topMarkets.some((value) => lower(value) === lower(filters.buyerMarket))) return false
        if (filters.buyerState && profile.topStates.length > 0 && !profile.topStates.some((value) => lower(value) === lower(filters.buyerState))) return false
        if (filters.buyerZip && profile.topZips.length > 0 && !profile.topZips.includes(filters.buyerZip)) return false
        return true
      })

      const profilesByKey = new Map(profiles.map((profile) => [profile.buyerKey, profile]))
      const matches = matchRows
        .map((row) => toBuyerMatch(row, context))
        .filter((match) => {
          if (!passesNumericRange(match.matchScore, filters.minMatchScore, filters.maxMatchScore)) return false
          if (!passesNumericRange(match.confidence, filters.minConfidenceScore, filters.maxConfidenceScore)) return false
          if (filters.exitStrategyMatch && lower(match.dispositionStrategy) !== lower(filters.exitStrategyMatch)) return false
          const profile = profilesByKey.get(match.buyerKey)
          if (profile && (profile.dispoPriorityScore ?? 0) < filters.minDispoPriorityScore) return false
          if (filters.matchTags.includes('price_match') && (match.priceFitScore ?? 0) <= 0) return false
          if (filters.matchTags.includes('asset_match') && (match.assetFitScore ?? 0) <= 0) return false
          if (filters.matchTags.includes('location_match') && (match.marketFitScore ?? 0) <= 0) return false
          if (filters.matchTags.includes('velocity_match') && (match.velocityScore ?? 0) <= 0) return false
          return true
        })

      const cutoff = Date.now() - filters.activityWindowDays * 86400_000
      const recentPurchases = purchaseResult.rows
        .map((row) => toRecentPurchase(row, context, profilesByKey.get(asText(row.buyer_entity_key ?? row.buyer_key)) ?? null))
        .filter((purchase): purchase is BuyerRecentPurchase => Boolean(purchase))
        .filter((purchase) => {
          const saleTs = new Date(purchase.saleDate || 0).getTime()
          if (Number.isFinite(saleTs) && saleTs < cutoff) return false
          const market = filters.market || context.market
          const state = filters.state || context.state
          const zip = filters.zip || context.zip
          const propertyType = filters.propertyType || context.propertyType
          if (zip && purchase.propertyAddressZip && purchase.propertyAddressZip !== zip) return false
          if (market && purchase.market && lower(purchase.market) !== lower(market)) return false
          if (!market && state && purchase.propertyAddressState && lower(purchase.propertyAddressState) !== lower(state)) return false
          if (propertyType && purchase.propertyType && lower(purchase.propertyType) !== lower(propertyType)) return false
          if (context.lat != null && context.lng != null && purchase.distanceMiles != null && purchase.distanceMiles > filters.radiusMiles) return false
          if (!hasTextMatch(purchase.buyerName, filters.buyerName)) return false
          if (!hasTextMatch(purchase.buyerName, filters.companyName)) return false
          if (filters.assetTypes.length > 0 && !includesAny(filters.assetTypes, [purchase.propertyType])) return false
          if (!passesNumericRange(purchase.salePrice, filters.minSalePrice, filters.maxSalePrice)) return false
          if (!passesNumericRange(purchase.pricePerSqft, filters.minPricePerSqft, filters.maxPricePerSqft)) return false
          if (!passesNumericRange(purchase.pricePerUnit, filters.minPricePerUnit, filters.maxPricePerUnit)) return false
          if (!passesNumericRange(purchase.totalBedrooms, filters.minBeds, filters.maxBeds)) return false
          if (!passesNumericRange(purchase.totalBaths, filters.minBaths, filters.maxBaths)) return false
          if (!passesNumericRange(purchase.unitsCount, filters.minUnits, filters.maxUnits)) return false
          if (!passesNumericRange(purchase.buildingSquareFeet, filters.minSqft, filters.maxSqft)) return false
          if (!passesNumericRange(purchase.yearBuilt, filters.yearBuiltMin, filters.yearBuiltMax)) return false
          if (!passesNumericRange(purchase.distanceMiles, filters.minDistanceFromSubject, filters.maxDistanceFromSubject)) return false
          if (!passesDateRange(purchase.saleDate, filters.soldDateFrom || filters.lastPurchaseDateFrom, filters.soldDateTo || filters.lastPurchaseDateTo)) return false
          if (filters.dealTypes.includes('off_market') && !purchase.isOffMarketPurchase) return false
          if (filters.dealTypes.includes('mls') && purchase.isOffMarketPurchase) return false
          if (filters.dealTypes.includes('corporate_buyer') && !purchase.isCorporateBuyer) return false
          return true
        })

      const liveProfiles = profiles.filter((profile) => !profile.isRetailOrNoise)
      const profilePoints = buildProfilePoints(liveProfiles, recentPurchases)
        .filter((point) => point.purchaseCount >= filters.minPurchaseCount)
      const summary = computeDemandSummary(profiles, matches, recentPurchases)

      setState({
        profiles,
        matches,
        recentPurchases,
        profilePoints,
        summary,
        loading: false,
        error: profileResult.error || purchaseResult.error || matchError,
        hasLiveProfiles: profiles.length > 0,
        hasLiveMatches: matches.length > 0,
      })
    }

    const run = () => {
      load().catch((error: unknown) => {
        if (!active) return
        setState((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        }))
      })
    }

    import('../../shared/idleDefer').then(({ runWhenBrowserIdle }) => {
      if (!active) return
      cancelIdle = runWhenBrowserIdle(run, 3000)
    }).catch(() => run())

    return () => {
      active = false
      cancelIdle?.()
    }
  }, [context, filters, enabled])

  return state
}
