import { getSupabaseClient } from '../supabaseClient'
import {
  asBoolean,
  asIso,
  asNumber,
  asString,
  getFirst,
  isDev,
  safeArray,
  shouldUseSupabase,
  type AnyRecord,
} from './shared'

export const PROPERTY_RAW_FIELD_GROUPS = [
  {
    id: 'identity',
    title: 'Identity',
    fields: [
      'property_export_id',
      'property_id',
      'upsert_key',
      'master_owner_id',
      'master_key',
      'owner_id',
      'owner_match_key',
      'owner_match_key_full',
      'owner_name_addr_key',
      'source_system',
      'export_version',
      'exported_at_utc',
      'created_at',
      'updated_at',
      'row_hash',
    ],
  },
  {
    id: 'location',
    title: 'Address / Location',
    fields: [
      'property_address_full',
      'property_address',
      'property_address2',
      'property_address_city',
      'property_address_county_name',
      'property_address_state',
      'property_address_zip',
      'property_address_range',
      'property_county_name',
      'property_state',
      'property_zip',
      'market',
      'market_region',
      'latitude',
      'longitude',
      'apn_parcel_id',
      'situs_census_tract',
      'legal_description',
      'subdivision_name',
      'school_district_name',
      'zoning',
      'flood_zone',
      'geographic_features',
    ],
  },
  {
    id: 'owner',
    title: 'Owner',
    fields: [
      'owner_name',
      'owner_type',
      'owner_location',
      'owner_address_full',
      'owner_address',
      'owner_address2',
      'owner_address_city',
      'owner_address_line_1',
      'owner_address_line_2',
      'owner_address_state',
      'owner_address_zip',
      'owner_lastname',
      'owner_1_firstname',
      'owner_1_lastname',
      'owner_1_name',
      'owner_2_firstname',
      'owner_2_lastname',
      'owner_2_name',
      'is_corporate_owner',
      'out_of_state_owner',
      'removed_owner',
      'ownership_years',
    ],
  },
  {
    id: 'valuation',
    title: 'Valuation / Equity',
    fields: [
      'estimated_value',
      'equity_amount',
      'equity_percent',
      'total_loan_balance',
      'total_loan_payment',
      'total_loan_amt',
      'cash_offer',
      'tax_amt',
      'tax_year',
      'offer_vs_loan',
      'offer_vs_sale_price',
      'offer_ppsf',
      'offer_ppu',
      'offer_ppbd',
      'offer_ppls',
    ],
  },
  {
    id: 'sale',
    title: 'Sale / Recording',
    fields: [
      'sale_date',
      'sale_price',
      'saleprice',
      'document_type',
      'recording_date',
      'default_date',
      'last_sale_doc_type',
    ],
  },
  {
    id: 'structure',
    title: 'Structure',
    fields: [
      'property_type',
      'property_class',
      'units_count',
      'building_square_feet',
      'year_built',
      'effective_year_built',
      'total_baths',
      'total_bedrooms',
      'lot_acreage',
      'lot_square_feet',
      'lot_nbr',
      'lot_size_depth_feet',
      'lot_size_frontage_feet',
      'num_of_fireplaces',
      'stories',
      'style',
      'topography',
      'sum_buildings_nbr',
      'sum_commercial_units',
      'sum_garage_sqft',
      'avg_sqft_per_unit',
      'beds_per_unit',
      'sqft_range',
      'search_profile_hash',
    ],
  },
  {
    id: 'condition',
    title: 'Condition / Rehab',
    fields: [
      'air_conditioning',
      'basement',
      'building_condition',
      'building_quality',
      'construction_type',
      'county_land_use_code',
      'exterior_walls',
      'floor_cover',
      'garage',
      'heating_fuel_type',
      'heating_type',
      'interior_walls',
      'other_rooms',
      'pool',
      'porch',
      'patio',
      'deck',
      'driveway',
      'roof_cover',
      'roof_type',
      'sewer',
      'water',
      'rehab_level',
      'estimated_repair_cost',
      'estimated_repair_cost_per_sqft',
    ],
  },
  {
    id: 'distress',
    title: 'Distress / Motivation',
    fields: [
      'tax_delinquent',
      'tax_delinquent_year',
      'active_lien',
      'lienholder_name',
      'past_due_amount',
      'seller_tags_text',
      'seller_tags_json',
      'property_flags_text',
      'property_flags_json',
      'podio_tags',
      'structured_motivation_score',
      'deal_strength_score',
      'tag_distress_score',
      'final_acquisition_score',
      'ai_score',
      'market_status_label',
      'market_status_value',
      'market_sub_status',
      'contact_status',
      'options',
      'highlighted',
    ],
  },
  {
    id: 'assessment',
    title: 'Assessment',
    fields: [
      'assd_improvement_value',
      'assd_land_value',
      'assd_total_value',
      'assd_year',
      'calculated_improvement_value',
      'calculated_land_value',
      'calculated_total_value',
    ],
  },
  {
    id: 'mls',
    title: 'MLS',
    fields: [
      'mls_current_listing_price',
      'mls_market_status',
      'mls_sold_date',
      'mls_sold_price',
    ],
  },
  {
    id: 'hoa',
    title: 'HOA',
    fields: ['hoa1_name', 'hoa1_type', 'hoa_fee_amount'],
  },
  {
    id: 'media',
    title: 'Media',
    fields: ['map_image', 'satellite_image', 'streetview_image'],
  },
  {
    id: 'system',
    title: 'System',
    fields: [
      'upsert_key',
      'source_system',
      'export_version',
      'exported_at_utc',
      'row_hash',
      'created_at',
      'updated_at',
    ],
  },
  {
    id: 'raw_payload',
    title: 'Raw Payload JSON',
    fields: ['raw_payload_json'],
  },
] as const

export type PropertyRawFieldGroup = (typeof PROPERTY_RAW_FIELD_GROUPS)[number]

export interface PropertyMedia {
  map: string | null
  satellite: string | null
  street: string | null
  mapImage: string | null
  satelliteImage: string | null
  streetviewImage: string | null
}

export interface PropertyOwnerSnapshot {
  name: string | null
  type: string | null
  location: string | null
  mailingAddress: string | null
  isCorporate: boolean
  outOfState: boolean
  removed: boolean
  ownershipYears: number | null
  matchKey: string | null
  matchKeyFull: string | null
}

export interface PropertyValuationSnapshot {
  estimatedValue: number | null
  equityAmount: number | null
  equityPercent: number | null
  totalLoanBalance: number | null
  totalLoanPayment: number | null
  totalLoanAmount: number | null
  cashOffer: number | null
  taxAmount: number | null
  taxYear: number | null
  assessedImprovementValue: number | null
  assessedLandValue: number | null
  assessedTotalValue: number | null
  assessedYear: number | null
  calculatedImprovementValue: number | null
  calculatedLandValue: number | null
  calculatedTotalValue: number | null
  offerVsLoan: number | null
  offerVsSalePrice: number | null
  offerPpsf: number | null
  offerPpu: number | null
  offerPpbd: number | null
  offerPpls: number | null
}

export interface PropertySaleSnapshot {
  saleDate: string | null
  salePrice: number | null
  salePriceAlt: number | null
  documentType: string | null
  recordingDate: string | null
  defaultDate: string | null
  lastSaleDocType: string | null
}

export interface PropertyStructureSnapshot {
  propertyType: string | null
  propertyClass: string | null
  unitsCount: number | null
  buildingSqft: number | null
  yearBuilt: number | null
  effectiveYearBuilt: number | null
  beds: number | null
  baths: number | null
  lotAcreage: number | null
  lotSqft: number | null
  lotNumber: string | null
  lotDepthFeet: number | null
  lotFrontageFeet: number | null
  fireplaces: number | null
  stories: number | null
  style: string | null
  topography: string | null
  buildings: number | null
  commercialUnits: number | null
  garageSqft: number | null
  avgSqftPerUnit: number | null
  bedsPerUnit: number | null
  sqftRange: string | null
  searchProfileHash: string | null
}

export interface PropertyConditionSnapshot {
  airConditioning: string | null
  basement: string | null
  buildingCondition: string | null
  buildingQuality: string | null
  constructionType: string | null
  countyLandUseCode: string | null
  exteriorWalls: string | null
  floorCover: string | null
  garage: string | null
  heatingFuelType: string | null
  heatingType: string | null
  interiorWalls: string | null
  otherRooms: string | null
  pool: string | null
  porch: string | null
  patio: string | null
  deck: string | null
  driveway: string | null
  roofCover: string | null
  roofType: string | null
  sewer: string | null
  water: string | null
  rehabLevel: string | null
  estimatedRepairCost: number | null
  estimatedRepairCostPerSqft: number | null
}

export interface PropertyDistressSnapshot {
  taxDelinquent: boolean
  taxDelinquentYear: number | null
  activeLien: boolean
  lienholderName: string | null
  pastDueAmount: number | null
  floodZone: string | null
  sellerTagsText: string | null
  sellerTagsJson: unknown
  propertyFlagsText: string | null
  propertyFlagsJson: unknown
  podioTags: unknown
  structuredMotivationScore: number | null
  dealStrengthScore: number | null
  tagDistressScore: number | null
  finalAcquisitionScore: number | null
  aiScore: number | null
  marketStatusLabel: string | null
  marketStatusValue: string | null
  marketSubStatus: string | null
  contactStatus: string | null
  options: unknown
  highlighted: boolean
}

export interface PropertyMlsSnapshot {
  currentListingPrice: number | null
  marketStatus: string | null
  soldDate: string | null
  soldPrice: number | null
}

export interface PropertyHoaSnapshot {
  name: string | null
  type: string | null
  feeAmount: number | null
}

export interface PropertySystemSnapshot {
  upsertKey: string | null
  sourceSystem: string | null
  exportVersion: string | null
  exportedAtUtc: string | null
  rowHash: string | null
  createdAt: string | null
  updatedAt: string | null
  rawPayloadJson: unknown
}

export interface PropertyRecord {
  id: string
  propertyId: string | null
  propertyExportId: string | null
  masterOwnerId: string | null
  masterKey: string | null
  ownerId: string | null
  ownerMatchKey: string | null
  ownerMatchKeyFull: string | null
  ownerNameAddrKey: string | null
  address: string
  street: string | null
  address2: string | null
  city: string | null
  state: string | null
  zip: string | null
  county: string | null
  market: string | null
  marketRegion: string | null
  apnParcelId: string | null
  situsCensusTract: string | null
  owner: PropertyOwnerSnapshot
  valuation: PropertyValuationSnapshot
  sale: PropertySaleSnapshot
  structure: PropertyStructureSnapshot
  condition: PropertyConditionSnapshot
  distress: PropertyDistressSnapshot
  mls: PropertyMlsSnapshot
  hoa: PropertyHoaSnapshot
  media: PropertyMedia
  system: PropertySystemSnapshot
  ownerName: string | null
  ownerType: string | null
  ownerLocation: string | null
  ownerAddress: string | null
  ownershipYears: number | null
  sellerTags: string[]
  propertyType: string | null
  propertyClass: string | null
  estimatedValue: number | null
  equityAmount: number | null
  equityPercent: number | null
  loanBalance: number | null
  totalLoanPayment: number | null
  totalLoanAmount: number | null
  taxAmount: number | null
  taxYear: number | null
  taxDelinquent: boolean
  taxDelinquentYear: number | null
  activeLien: boolean
  lienholderName: string | null
  saleDate: string | null
  salePrice: number | null
  salePriceAlt: number | null
  documentType: string | null
  lastSaleDocType: string | null
  recordingDate: string | null
  defaultDate: string | null
  beds: number | null
  baths: number | null
  sqft: number | null
  units: number | null
  yearBuilt: number | null
  effectiveYearBuilt: number | null
  lotSqft: number | null
  lotAcreage: number | null
  lat: number | null
  lng: number | null
  buildingCondition: string | null
  quality: string | null
  constructionType: string | null
  airConditioning: string | null
  basement: string | null
  garage: string | null
  roofCover: string | null
  roofType: string | null
  sewer: string | null
  water: string | null
  heatingType: string | null
  heatingFuelType: string | null
  exteriorWalls: string | null
  floorCover: string | null
  interiorWalls: string | null
  pool: string | null
  porch: string | null
  patio: string | null
  deck: string | null
  driveway: string | null
  zoning: string | null
  legalDescription: string | null
  subdivisionName: string | null
  schoolDistrictName: string | null
  floodZone: string | null
  geographicFeatures: string | null
  hoaName: string | null
  hoaType: string | null
  hoaFeeAmount: number | null
  marketStatusLabel: string | null
  marketStatusValue: string | null
  marketSubStatus: string | null
  cashOffer: number | null
  finalAcquisitionScore: number | null
  dealStrengthScore: number | null
  structuredMotivationScore: number | null
  tagDistressScore: number | null
  aiScore: number | null
  rehabLevel: string | null
  estimatedRepairCost: number | null
  propertyFlags: string[]
  allTags: string[]
  images: PropertyMedia
  distressSignals: string[]
  priorityScore: number
  raw: AnyRecord
}

export interface PropertyFilters {
  market?: string
  propertyType?: string
  ownerType?: string
  equity?: 'all' | '50plus' | '100k' | '250k' | 'freeclear'
  taxDelinquent?: 'all' | 'yes' | 'no'
  activeLien?: 'all' | 'yes' | 'no'
  search?: string
  quickFilters?: string[]
  advanced?: PropertyFilterClause[]
}

export type PropertyFilterOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'is_empty'
  | 'is_not_empty'
  | 'greater_than'
  | 'less_than'
  | 'greater_or_equal'
  | 'less_or_equal'
  | 'between'
  | 'is_true'
  | 'is_false'
  | 'before'
  | 'after'
  | 'on'
  | 'includes'
  | 'excludes'
  | 'contains_text'

export interface PropertyFilterClause {
  id: string
  fieldKey: string
  operator: PropertyFilterOperator
  value?: string | number | boolean | Array<string | number>
  valueTo?: string | number
}

export interface PropertySort {
  column: string
  ascending?: boolean
  nullsFirst?: boolean
}

export interface PropertyQueryParams {
  page?: number
  pageSize?: number
  from?: number
  to?: number
  search?: string
  filters?: PropertyFilters
  sort?: PropertySort
  includeContexts?: boolean
}

export interface PropertyPageResult {
  records: PropertyRecord[]
  totalCount: number
  page: number
  pageSize: number
}

export interface PropertyFacetOptions {
  marketOptions: string[]
  propertyTypeOptions: string[]
  ownerTypeOptions: string[]
  marketStatusOptions: string[]
  rehabLevelOptions: string[]
}

export interface PropertyStats {
  totalProperties: number
  highEquityCount: number
  distressCount: number
  avgPriorityScore: number
  taxDelinquentCount: number
  activeLienCount: number
  freeClearCount: number
}

export interface PropertyMapPoint {
  id: string
  propertyId: string | null
  address: string
  lat: number
  lng: number
  priorityScore: number
  distressSignals: string[]
  market: string | null
}

export interface PropertyProspectContext {
  id: string
  name: string
  relationship: string | null
  stage: string | null
  status: string | null
  language: string | null
  raw: AnyRecord
}

export interface PropertyPhoneContext {
  id: string
  phoneNumber: string
  type: string | null
  status: string | null
  smsStatus: string | null
  confidence: number | null
  rank: number | null
  lastContacted: string | null
  lastReply: string | null
  raw: AnyRecord
}

export interface PropertyEmailContext {
  id: string
  email: string
  status: string | null
  verificationStatus: string | null
  confidence: number | null
  rank: number | null
  raw: AnyRecord
}

export interface PropertyOwnerContext {
  id: string
  name: string | null
  type: string | null
  location: string | null
  mailingAddress: string | null
  raw: AnyRecord
}

export interface PropertyContactContext {
  phones: PropertyPhoneContext[]
  emails: PropertyEmailContext[]
  prospects: PropertyProspectContext[]
  primaryPhone: PropertyPhoneContext | null
  primaryEmail: PropertyEmailContext | null
  bestPhoneConfidence: number | null
  bestChannel: string | null
  bestContactWindow: string | null
  language: string | null
}

export interface PropertyMessageEvent {
  id: string
  direction: 'inbound' | 'outbound' | 'unknown'
  body: string
  status: string | null
  deliveryStatus: string | null
  sentiment: string | null
  timestamp: string | null
  toPhoneNumber: string | null
  fromPhoneNumber: string | null
  raw: AnyRecord
}

export interface PropertyQueueItem {
  id: string
  status: string
  priority: string | null
  message: string | null
  scheduledAt: string | null
  sentAt: string | null
  updatedAt: string | null
  toPhoneNumber: string | null
  raw: AnyRecord
}

export interface PropertyOfferItem {
  id: string
  strategy: string | null
  amount: number | null
  status: string | null
  confidence: number | null
  updatedAt: string | null
  raw: AnyRecord
}

export interface PropertyContractItem {
  id: string
  status: string | null
  offerId: string | null
  updatedAt: string | null
  raw: AnyRecord
}

export interface PropertyOfferPathway {
  offers: PropertyOfferItem[]
  contracts: PropertyContractItem[]
  latestOffer: PropertyOfferItem | null
  activeContract: PropertyContractItem | null
}

export interface PropertyQueueContext {
  items: PropertyQueueItem[]
  latest: PropertyQueueItem | null
  lastOutboundAt: string | null
  lastInboundAt: string | null
  messageCount: number
  deliveryState: string | null
}

export interface PropertyIntelligenceContext {
  owner: PropertyOwnerContext | null
  contacts: PropertyContactContext
  messages: PropertyMessageEvent[]
  queue: PropertyQueueContext
  offerPathway: PropertyOfferPathway
}

export interface PropertyIntelligenceModel {
  properties: PropertyRecord[]
  contextsByPropertyId: Record<string, PropertyIntelligenceContext>
  marketOptions: string[]
  propertyTypeOptions: string[]
  ownerTypeOptions: string[]
}

interface RelatedRows {
  masterOwners: AnyRecord[]
  prospects: AnyRecord[]
  phones: AnyRecord[]
  emails: AnyRecord[]
  messages: AnyRecord[]
  queue: AnyRecord[]
  offers: AnyRecord[]
  contracts: AnyRecord[]
}

const moneyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

const numberFormatter = new Intl.NumberFormat('en-US')

const percentFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 0,
})

export const formatMoney = (value: unknown): string => {
  const amount = toNumber(value)
  return amount === null ? 'N/A' : moneyFormatter.format(amount)
}

export const formatPercent = (value: unknown): string => {
  const amount = toNumber(value)
  return amount === null ? 'N/A' : `${percentFormatter.format(amount)}%`
}

export const formatDate = (value: unknown): string => {
  const iso = asIso(value)
  if (!iso) return 'N/A'
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(iso))
}

export const formatNumber = (value: unknown): string => {
  const amount = toNumber(value)
  return amount === null ? 'N/A' : numberFormatter.format(amount)
}

const toText = (value: unknown): string | null => {
  const text = asString(value, '').trim()
  return text ? text : null
}

const toNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null
  const parsed = asNumber(value, Number.NaN)
  return Number.isFinite(parsed) ? parsed : null
}

const normalizeId = (value: unknown): string =>
  asString(value, '').trim().toLowerCase().replace(/[^a-z0-9]/g, '')

const normalizePhone = (value: unknown): string =>
  asString(value, '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')

const safeJson = (value: unknown): unknown => {
  if (typeof value !== 'string') return value ?? null
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

const parseSellerTags = (row: AnyRecord): string[] => {
  const tags = new Set<string>()
  const text = toText(getFirst(row, ['seller_tags_text', 'tags']))
  if (text) {
    text
      .split(/[,|;]+/)
      .map((tag) => tag.trim())
      .filter(Boolean)
      .forEach((tag) => tags.add(tag))
  }

  const json = safeJson(getFirst(row, ['seller_tags_json']))
  if (Array.isArray(json)) {
    json
      .map((tag) => asString(tag, '').trim())
      .filter(Boolean)
      .forEach((tag) => tags.add(tag))
  }

  if (json && typeof json === 'object' && !Array.isArray(json)) {
    Object.entries(json as Record<string, unknown>).forEach(([key, value]) => {
      if (asBoolean(value, false)) tags.add(key)
    })
  }

  return Array.from(tags)
}

const titleizeTag = (value: string): string =>
  value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase())

const addTagValue = (tags: Set<string>, value: unknown) => {
  if (value === null || value === undefined || value === '') return
  if (Array.isArray(value)) {
    value.forEach((item) => addTagValue(tags, item))
    return
  }
  if (typeof value === 'object') {
    Object.entries(value as Record<string, unknown>).forEach(([key, nestedValue]) => {
      if (typeof nestedValue === 'string') addTagValue(tags, nestedValue)
      else if (Array.isArray(nestedValue)) addTagValue(tags, nestedValue)
      else if (asBoolean(nestedValue, false)) addTagValue(tags, key)
    })
    return
  }
  asString(value, '')
    .split(/[,|;]+/)
    .map(titleizeTag)
    .filter(Boolean)
    .forEach((tag) => tags.add(tag))
}

const parseTagsFromFields = (row: AnyRecord, fields: string[]): string[] => {
  const tags = new Set<string>()
  fields.forEach((field) => addTagValue(tags, safeJson(row[field])))
  return Array.from(tags)
}

const truthyField = (value: unknown) => {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (!normalized || ['none', 'no', 'false', '0', 'n/a', 'unknown'].includes(normalized)) return false
  }
  return asBoolean(value, Boolean(value))
}

const resolveRawProperty = (row: AnyRecord | PropertyRecord): AnyRecord => {
  if ('raw' in row && row.raw && typeof row.raw === 'object' && !Array.isArray(row.raw)) {
    return row.raw as AnyRecord
  }
  return row as AnyRecord
}

export const getPropertyMedia = (row: AnyRecord | PropertyRecord): PropertyMedia => {
  const raw = resolveRawProperty(row)
  const mapImage = toText(getFirst(raw, ['map_image']))
  const satelliteImage = toText(getFirst(raw, ['satellite_image']))
  const streetviewImage = toText(getFirst(raw, ['streetview_image']))
  return {
    map: mapImage,
    satellite: satelliteImage,
    street: streetviewImage,
    mapImage,
    satelliteImage,
    streetviewImage,
  }
}

export const getPropertyDistressSignals = (row: AnyRecord | PropertyRecord): string[] => {
  const raw = resolveRawProperty(row)
  const tags: string[] = 'allTags' in row && Array.isArray(row.allTags)
    ? row.allTags
    : parseTagsFromFields(raw, ['seller_tags_text', 'seller_tags_json', 'property_flags_text', 'property_flags_json', 'podio_tags'])
  const tagText = tags.join(' ').toLowerCase()
  const signals = new Set<string>()

  if (asBoolean(getFirst(raw, ['tax_delinquent']), false)) signals.add('Tax Delinquent')
  if (asBoolean(getFirst(raw, ['active_lien']), false)) signals.add('Active Lien')
  if (toText(getFirst(raw, ['lienholder_name']))) signals.add('Lienholder')
  if (toNumber(getFirst(raw, ['past_due_amount']))) signals.add('Past Due')
  if (toText(getFirst(raw, ['default_date']))) signals.add('Default')
  if (tagText.includes('foreclosure')) signals.add('Foreclosure')
  if (tagText.includes('vacant')) signals.add('Vacant')
  if (tagText.includes('distress')) signals.add('Distressed')
  if (tagText.includes('probate')) signals.add('Probate')
  if (tagText.includes('absentee')) signals.add('Absentee')
  if (tagText.includes('tired landlord')) signals.add('Tired Landlord')
  if (tagText.includes('senior owner')) signals.add('Senior Owner')
  if (tagText.includes('heavily dated')) signals.add('Heavily Dated')
  const floodZone = toText(getFirst(raw, ['flood_zone']))
  if (floodZone) signals.add(`Flood Zone ${floodZone}`)
  const marketStatus = toText(getFirst(raw, ['market_status_label']))
  if (marketStatus && /distress|pre|foreclosure|auction|delinquent/i.test(marketStatus)) {
    signals.add(marketStatus)
  }

  return Array.from(signals)
}

export const getPropertyPriorityScore = (row: AnyRecord | PropertyRecord): number => {
  const raw = resolveRawProperty(row)
  const suppliedScore = toNumber(getFirst(raw, ['final_acquisition_score', 'deal_strength_score', 'ai_score']))
  if (suppliedScore !== null) return Math.max(0, Math.min(100, Math.round(suppliedScore)))
  const estimated = toNumber(getFirst(raw, ['estimated_value'])) ?? 0
  const equity = toNumber(getFirst(raw, ['equity_amount'])) ?? 0
  const equityPercent = toNumber(getFirst(raw, ['equity_percent'])) ?? (estimated > 0 ? (equity / estimated) * 100 : 0)
  const ownershipYears = toNumber(getFirst(raw, ['ownership_years'])) ?? 0
  const distressCount = getPropertyDistressSignals(raw).length
  const defaultBoost = toText(getFirst(raw, ['default_date'])) ? 10 : 0
  const freeClearBoost = (toNumber(getFirst(raw, ['total_loan_balance'])) ?? 0) <= 0 && equity > 0 ? 10 : 0

  return Math.min(
    100,
    Math.round(
      Math.min(38, equityPercent * 0.38) +
        Math.min(24, equity / 15000) +
        Math.min(20, distressCount * 7) +
        Math.min(8, ownershipYears / 2) +
        defaultBoost +
        freeClearBoost,
    ),
  )
}

export const getPropertyOpportunityType = (row: AnyRecord | PropertyRecord): string => {
  const raw = resolveRawProperty(row)
  const propertyType = asString(getFirst(raw, ['property_type']), '').toLowerCase()
  const rehabLevel = asString(getFirst(raw, ['rehab_level']), '').toLowerCase()
  const equityPercent = toNumber(getFirst(raw, ['equity_percent'])) ?? 0
  const taxDelinquent = asBoolean(getFirst(raw, ['tax_delinquent']), false)
  const activeLien = asBoolean(getFirst(raw, ['active_lien']), false)
  const loanBalance = toNumber(getFirst(raw, ['total_loan_balance'])) ?? 0
  const distressSignals = getPropertyDistressSignals(raw)

  if (propertyType.includes('multi')) return 'Multifamily'
  if (rehabLevel.includes('structural')) return 'Rehab'
  if (loanBalance <= 0 && equityPercent >= 40) return 'Free & Clear'
  if (equityPercent >= 50) return 'High Equity'
  if (taxDelinquent || activeLien) return 'Distress'
  if (distressSignals.length > 0) return 'Distress'
  return 'Core Acquisition'
}

export const getPropertyViewPreset = (row: AnyRecord | PropertyRecord): string => {
  const raw = resolveRawProperty(row)
  const opportunityType = getPropertyOpportunityType(raw)
  if (opportunityType === 'Distress') return 'distress'
  if (opportunityType === 'High Equity' || opportunityType === 'Free & Clear') return 'equity'
  if (opportunityType === 'Rehab') return 'rehab'
  if (opportunityType === 'Multifamily') return 'multifamily'
  return 'command'
}

const fullAddress = (row: AnyRecord) => {
  const explicit = toText(getFirst(row, ['property_address_full']))
  if (explicit) return explicit
  const parts = [
    toText(getFirst(row, ['property_address'])),
    toText(getFirst(row, ['property_address_city'])),
    toText(getFirst(row, ['property_address_state', 'property_state'])),
    toText(getFirst(row, ['property_address_zip', 'property_zip'])),
  ].filter(Boolean)
  return parts.length ? parts.join(', ') : 'Address unavailable'
}

export const normalizeProperty = (row: AnyRecord, index = 0): PropertyRecord => {
  const estimatedValue = toNumber(getFirst(row, ['estimated_value']))
  const equityAmount = toNumber(getFirst(row, ['equity_amount']))
  const equityPercent = toNumber(getFirst(row, ['equity_percent'])) ??
    (estimatedValue && equityAmount ? Math.round((equityAmount / estimatedValue) * 100) : null)
  const id =
    toText(getFirst(row, ['property_id'])) ??
    toText(getFirst(row, ['property_export_id'])) ??
      toText(getFirst(row, ['upsert_key'])) ??
      `property-${index + 1}`
  const images = getPropertyMedia(row)
  const sellerTags = parseSellerTags(row)
  const propertyFlags = parseTagsFromFields(row, ['property_flags_text', 'property_flags_json', 'podio_tags'])
  const allTags = Array.from(new Set([...sellerTags, ...propertyFlags].map(titleizeTag)))
  const owner: PropertyOwnerSnapshot = {
    name: toText(getFirst(row, ['owner_name', 'owner_full_name', 'full_name'])),
    type: toText(getFirst(row, ['owner_type'])),
    location: toText(getFirst(row, ['owner_location'])),
    mailingAddress: toText(getFirst(row, ['owner_address_full', 'owner_address', 'owner_address_line_1'])),
    isCorporate: truthyField(getFirst(row, ['is_corporate_owner'])),
    outOfState: truthyField(getFirst(row, ['out_of_state_owner'])),
    removed: truthyField(getFirst(row, ['removed_owner'])),
    ownershipYears: toNumber(getFirst(row, ['ownership_years'])),
    matchKey: toText(getFirst(row, ['owner_match_key'])),
    matchKeyFull: toText(getFirst(row, ['owner_match_key_full'])),
  }
  const valuation: PropertyValuationSnapshot = {
    estimatedValue,
    equityAmount,
    equityPercent,
    totalLoanBalance: toNumber(getFirst(row, ['total_loan_balance'])),
    totalLoanPayment: toNumber(getFirst(row, ['total_loan_payment'])),
    totalLoanAmount: toNumber(getFirst(row, ['total_loan_amt'])),
    cashOffer: toNumber(getFirst(row, ['cash_offer'])),
    taxAmount: toNumber(getFirst(row, ['tax_amt'])),
    taxYear: toNumber(getFirst(row, ['tax_year'])),
    assessedImprovementValue: toNumber(getFirst(row, ['assd_improvement_value'])),
    assessedLandValue: toNumber(getFirst(row, ['assd_land_value'])),
    assessedTotalValue: toNumber(getFirst(row, ['assd_total_value'])),
    assessedYear: toNumber(getFirst(row, ['assd_year'])),
    calculatedImprovementValue: toNumber(getFirst(row, ['calculated_improvement_value'])),
    calculatedLandValue: toNumber(getFirst(row, ['calculated_land_value'])),
    calculatedTotalValue: toNumber(getFirst(row, ['calculated_total_value'])),
    offerVsLoan: toNumber(getFirst(row, ['offer_vs_loan'])),
    offerVsSalePrice: toNumber(getFirst(row, ['offer_vs_sale_price'])),
    offerPpsf: toNumber(getFirst(row, ['offer_ppsf'])),
    offerPpu: toNumber(getFirst(row, ['offer_ppu'])),
    offerPpbd: toNumber(getFirst(row, ['offer_ppbd'])),
    offerPpls: toNumber(getFirst(row, ['offer_ppls'])),
  }
  const sale: PropertySaleSnapshot = {
    saleDate: asIso(getFirst(row, ['sale_date'])),
    salePrice: toNumber(getFirst(row, ['sale_price'])),
    salePriceAlt: toNumber(getFirst(row, ['saleprice'])),
    documentType: toText(getFirst(row, ['document_type'])),
    recordingDate: asIso(getFirst(row, ['recording_date'])),
    defaultDate: asIso(getFirst(row, ['default_date'])),
    lastSaleDocType: toText(getFirst(row, ['last_sale_doc_type'])),
  }
  const structure: PropertyStructureSnapshot = {
    propertyType: toText(getFirst(row, ['property_type'])),
    propertyClass: toText(getFirst(row, ['property_class'])),
    unitsCount: toNumber(getFirst(row, ['units_count'])),
    buildingSqft: toNumber(getFirst(row, ['building_square_feet'])),
    yearBuilt: toNumber(getFirst(row, ['year_built'])),
    effectiveYearBuilt: toNumber(getFirst(row, ['effective_year_built'])),
    beds: toNumber(getFirst(row, ['total_bedrooms'])),
    baths: toNumber(getFirst(row, ['total_baths'])),
    lotAcreage: toNumber(getFirst(row, ['lot_acreage'])),
    lotSqft: toNumber(getFirst(row, ['lot_square_feet'])),
    lotNumber: toText(getFirst(row, ['lot_nbr'])),
    lotDepthFeet: toNumber(getFirst(row, ['lot_size_depth_feet'])),
    lotFrontageFeet: toNumber(getFirst(row, ['lot_size_frontage_feet'])),
    fireplaces: toNumber(getFirst(row, ['num_of_fireplaces'])),
    stories: toNumber(getFirst(row, ['stories'])),
    style: toText(getFirst(row, ['style'])),
    topography: toText(getFirst(row, ['topography'])),
    buildings: toNumber(getFirst(row, ['sum_buildings_nbr'])),
    commercialUnits: toNumber(getFirst(row, ['sum_commercial_units'])),
    garageSqft: toNumber(getFirst(row, ['sum_garage_sqft'])),
    avgSqftPerUnit: toNumber(getFirst(row, ['avg_sqft_per_unit'])),
    bedsPerUnit: toNumber(getFirst(row, ['beds_per_unit'])),
    sqftRange: toText(getFirst(row, ['sqft_range'])),
    searchProfileHash: toText(getFirst(row, ['search_profile_hash'])),
  }
  const condition: PropertyConditionSnapshot = {
    airConditioning: toText(getFirst(row, ['air_conditioning'])),
    basement: toText(getFirst(row, ['basement'])),
    buildingCondition: toText(getFirst(row, ['building_condition'])),
    buildingQuality: toText(getFirst(row, ['building_quality'])),
    constructionType: toText(getFirst(row, ['construction_type'])),
    countyLandUseCode: toText(getFirst(row, ['county_land_use_code'])),
    exteriorWalls: toText(getFirst(row, ['exterior_walls'])),
    floorCover: toText(getFirst(row, ['floor_cover'])),
    garage: toText(getFirst(row, ['garage'])),
    heatingFuelType: toText(getFirst(row, ['heating_fuel_type'])),
    heatingType: toText(getFirst(row, ['heating_type'])),
    interiorWalls: toText(getFirst(row, ['interior_walls'])),
    otherRooms: toText(getFirst(row, ['other_rooms'])),
    pool: toText(getFirst(row, ['pool'])),
    porch: toText(getFirst(row, ['porch'])),
    patio: toText(getFirst(row, ['patio'])),
    deck: toText(getFirst(row, ['deck'])),
    driveway: toText(getFirst(row, ['driveway'])),
    roofCover: toText(getFirst(row, ['roof_cover'])),
    roofType: toText(getFirst(row, ['roof_type'])),
    sewer: toText(getFirst(row, ['sewer'])),
    water: toText(getFirst(row, ['water'])),
    rehabLevel: toText(getFirst(row, ['rehab_level'])),
    estimatedRepairCost: toNumber(getFirst(row, ['estimated_repair_cost'])),
    estimatedRepairCostPerSqft: toNumber(getFirst(row, ['estimated_repair_cost_per_sqft'])),
  }
  const distress: PropertyDistressSnapshot = {
    taxDelinquent: asBoolean(getFirst(row, ['tax_delinquent']), false),
    taxDelinquentYear: toNumber(getFirst(row, ['tax_delinquent_year'])),
    activeLien: asBoolean(getFirst(row, ['active_lien']), false),
    lienholderName: toText(getFirst(row, ['lienholder_name'])),
    pastDueAmount: toNumber(getFirst(row, ['past_due_amount'])),
    floodZone: toText(getFirst(row, ['flood_zone'])),
    sellerTagsText: toText(getFirst(row, ['seller_tags_text'])),
    sellerTagsJson: safeJson(getFirst(row, ['seller_tags_json'])),
    propertyFlagsText: toText(getFirst(row, ['property_flags_text'])),
    propertyFlagsJson: safeJson(getFirst(row, ['property_flags_json'])),
    podioTags: safeJson(getFirst(row, ['podio_tags'])),
    structuredMotivationScore: toNumber(getFirst(row, ['structured_motivation_score'])),
    dealStrengthScore: toNumber(getFirst(row, ['deal_strength_score'])),
    tagDistressScore: toNumber(getFirst(row, ['tag_distress_score'])),
    finalAcquisitionScore: toNumber(getFirst(row, ['final_acquisition_score'])),
    aiScore: toNumber(getFirst(row, ['ai_score'])),
    marketStatusLabel: toText(getFirst(row, ['market_status_label'])),
    marketStatusValue: toText(getFirst(row, ['market_status_value'])),
    marketSubStatus: toText(getFirst(row, ['market_sub_status'])),
    contactStatus: toText(getFirst(row, ['contact_status'])),
    options: safeJson(getFirst(row, ['options'])),
    highlighted: truthyField(getFirst(row, ['highlighted'])),
  }
  const mls: PropertyMlsSnapshot = {
    currentListingPrice: toNumber(getFirst(row, ['mls_current_listing_price'])),
    marketStatus: toText(getFirst(row, ['mls_market_status'])),
    soldDate: asIso(getFirst(row, ['mls_sold_date'])),
    soldPrice: toNumber(getFirst(row, ['mls_sold_price'])),
  }
  const hoa: PropertyHoaSnapshot = {
    name: toText(getFirst(row, ['hoa1_name'])),
    type: toText(getFirst(row, ['hoa1_type'])),
    feeAmount: toNumber(getFirst(row, ['hoa_fee_amount'])),
  }
  const system: PropertySystemSnapshot = {
    upsertKey: toText(getFirst(row, ['upsert_key'])),
    sourceSystem: toText(getFirst(row, ['source_system'])),
    exportVersion: toText(getFirst(row, ['export_version'])),
    exportedAtUtc: asIso(getFirst(row, ['exported_at_utc'])),
    rowHash: toText(getFirst(row, ['row_hash'])),
    createdAt: asIso(getFirst(row, ['created_at'])),
    updatedAt: asIso(getFirst(row, ['updated_at'])),
    rawPayloadJson: safeJson(getFirst(row, ['raw_payload_json'])),
  }

  return {
    id,
    propertyId: toText(getFirst(row, ['property_id'])),
    propertyExportId: toText(getFirst(row, ['property_export_id'])),
    masterOwnerId: toText(getFirst(row, ['master_owner_id'])),
    masterKey: toText(getFirst(row, ['master_key'])),
    ownerId: toText(getFirst(row, ['owner_id'])),
    ownerMatchKey: owner.matchKey,
    ownerMatchKeyFull: owner.matchKeyFull,
    ownerNameAddrKey: toText(getFirst(row, ['owner_name_addr_key'])),
    address: fullAddress(row),
    street: toText(getFirst(row, ['property_address'])),
    address2: toText(getFirst(row, ['property_address2'])),
    city: toText(getFirst(row, ['property_address_city'])),
    state: toText(getFirst(row, ['property_address_state', 'property_state'])),
    zip: toText(getFirst(row, ['property_address_zip', 'property_zip'])),
    county: toText(getFirst(row, ['property_address_county_name', 'property_county_name'])),
    market: toText(getFirst(row, ['market'])),
    marketRegion: toText(getFirst(row, ['market_region'])),
    apnParcelId: toText(getFirst(row, ['apn_parcel_id'])),
    situsCensusTract: toText(getFirst(row, ['situs_census_tract'])),
    owner,
    valuation,
    sale,
    structure,
    condition,
    distress,
    mls,
    hoa,
    media: images,
    system,
    ownerName: owner.name,
    ownerType: owner.type,
    ownerLocation: owner.location,
    ownerAddress: owner.mailingAddress,
    ownershipYears: owner.ownershipYears,
    sellerTags,
    propertyType: structure.propertyType,
    propertyClass: structure.propertyClass,
    estimatedValue,
    equityAmount,
    equityPercent,
    loanBalance: valuation.totalLoanBalance,
    totalLoanPayment: valuation.totalLoanPayment,
    totalLoanAmount: valuation.totalLoanAmount,
    taxAmount: valuation.taxAmount,
    taxYear: valuation.taxYear,
    taxDelinquent: distress.taxDelinquent,
    taxDelinquentYear: distress.taxDelinquentYear,
    activeLien: distress.activeLien,
    lienholderName: distress.lienholderName,
    saleDate: sale.saleDate,
    salePrice: sale.salePrice,
    salePriceAlt: sale.salePriceAlt,
    documentType: sale.documentType,
    lastSaleDocType: sale.lastSaleDocType,
    recordingDate: sale.recordingDate,
    defaultDate: sale.defaultDate,
    beds: structure.beds,
    baths: structure.baths,
    sqft: structure.buildingSqft,
    units: structure.unitsCount,
    yearBuilt: structure.yearBuilt,
    effectiveYearBuilt: structure.effectiveYearBuilt,
    lotSqft: structure.lotSqft,
    lotAcreage: structure.lotAcreage,
    lat: toNumber(getFirst(row, ['latitude'])),
    lng: toNumber(getFirst(row, ['longitude'])),
    buildingCondition: condition.buildingCondition,
    quality: condition.buildingQuality,
    constructionType: condition.constructionType,
    airConditioning: condition.airConditioning,
    basement: condition.basement,
    garage: condition.garage,
    roofCover: condition.roofCover,
    roofType: condition.roofType,
    sewer: condition.sewer,
    water: condition.water,
    heatingType: condition.heatingType,
    heatingFuelType: condition.heatingFuelType,
    exteriorWalls: condition.exteriorWalls,
    floorCover: condition.floorCover,
    interiorWalls: condition.interiorWalls,
    pool: condition.pool,
    porch: condition.porch,
    patio: condition.patio,
    deck: condition.deck,
    driveway: condition.driveway,
    zoning: toText(getFirst(row, ['zoning'])),
    legalDescription: toText(getFirst(row, ['legal_description'])),
    subdivisionName: toText(getFirst(row, ['subdivision_name'])),
    schoolDistrictName: toText(getFirst(row, ['school_district_name'])),
    floodZone: distress.floodZone,
    geographicFeatures: toText(getFirst(row, ['geographic_features'])),
    hoaName: hoa.name,
    hoaType: hoa.type,
    hoaFeeAmount: hoa.feeAmount,
    marketStatusLabel: distress.marketStatusLabel,
    marketStatusValue: distress.marketStatusValue,
    marketSubStatus: distress.marketSubStatus,
    cashOffer: valuation.cashOffer,
    finalAcquisitionScore: distress.finalAcquisitionScore,
    dealStrengthScore: distress.dealStrengthScore,
    structuredMotivationScore: distress.structuredMotivationScore,
    tagDistressScore: distress.tagDistressScore,
    aiScore: distress.aiScore,
    rehabLevel: condition.rehabLevel,
    estimatedRepairCost: condition.estimatedRepairCost,
    propertyFlags,
    allTags,
    images,
    distressSignals: getPropertyDistressSignals({ ...row, seller_tags_json: allTags }),
    priorityScore: getPropertyPriorityScore(row),
    raw: row,
  }
}

const mockRows = (): AnyRecord[] => [
  {
    property_id: 'prop-001',
    property_export_id: 'export-hou-001',
    master_owner_id: 'mown-001',
    owner_id: 'own-001',
    property_address_full: '1289 Oak Ridge Dr, Houston, TX 77002',
    property_address: '1289 Oak Ridge Dr',
    property_address_city: 'Houston',
    property_address_state: 'TX',
    property_address_zip: '77002',
    property_address_county_name: 'Harris',
    market: 'Houston',
    market_region: 'Texas Triangle',
    owner_name: 'Diana Alvarez',
    owner_type: 'Individual',
    owner_location: 'Houston, TX',
    owner_address_full: '1289 Oak Ridge Dr, Houston, TX 77002',
    ownership_years: 9,
    seller_tags_text: 'high-equity,tax-delinquent,engaged',
    property_type: 'Single Family',
    property_class: 'Residential',
    estimated_value: 328000,
    equity_amount: 176000,
    equity_percent: 54,
    total_loan_balance: 152000,
    total_loan_payment: 1410,
    total_loan_amt: 168000,
    tax_amt: 4200,
    tax_year: 2024,
    tax_delinquent: true,
    tax_delinquent_year: 2022,
    active_lien: false,
    sale_date: '2016-08-18',
    sale_price: 192000,
    document_type: 'Deed',
    last_sale_doc_type: 'Warranty Deed',
    recording_date: '2016-08-22',
    building_square_feet: 1820,
    total_bedrooms: 4,
    total_baths: 2,
    units_count: 1,
    year_built: 1978,
    effective_year_built: 1998,
    lot_square_feet: 7200,
    lot_acreage: 0.17,
    latitude: 29.7604,
    longitude: -95.3698,
    building_condition: 'Average',
    building_quality: 'C+',
    construction_type: 'Frame',
    air_conditioning: 'Central',
    basement: 'None',
    garage: 'Attached',
    roof_cover: 'Composition shingle',
    sewer: 'Public',
    water: 'Public',
    created_at: new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(),
    updated_at: new Date(Date.now() - 1000 * 60 * 14).toISOString(),
  },
  {
    property_id: 'prop-002',
    property_export_id: 'export-dal-002',
    master_owner_id: 'mown-002',
    owner_id: 'own-002',
    property_address_full: '445 Canyon Bend Ct, Dallas, TX 75201',
    property_address: '445 Canyon Bend Ct',
    property_address_city: 'Dallas',
    property_address_state: 'TX',
    property_address_zip: '75201',
    property_address_county_name: 'Dallas',
    market: 'Dallas',
    market_region: 'North Texas',
    owner_name: 'Oakline Holdings LLC',
    owner_type: 'Company',
    owner_location: 'Austin, TX',
    owner_address_full: '900 Main St Suite 400, Austin, TX 78701',
    ownership_years: 7,
    seller_tags_text: 'multifamily,offer-ready',
    property_type: 'Multifamily',
    property_class: 'Residential Income',
    estimated_value: 811000,
    equity_amount: 312000,
    equity_percent: 38,
    total_loan_balance: 499000,
    total_loan_payment: 4510,
    total_loan_amt: 520000,
    tax_amt: 11740,
    tax_year: 2024,
    tax_delinquent: false,
    active_lien: false,
    sale_date: '2019-03-11',
    sale_price: 650000,
    document_type: 'Deed',
    building_square_feet: 6400,
    total_bedrooms: 8,
    total_baths: 6,
    units_count: 4,
    year_built: 1991,
    lot_square_feet: 14000,
    lot_acreage: 0.32,
    latitude: 32.7767,
    longitude: -96.797,
    building_condition: 'Good',
    building_quality: 'B',
    construction_type: 'Masonry',
    air_conditioning: 'Central',
    garage: 'Surface lot',
    roof_cover: 'Composition shingle',
    sewer: 'Public',
    water: 'Public',
    created_at: new Date(Date.now() - 1000 * 60 * 60 * 72).toISOString(),
    updated_at: new Date(Date.now() - 1000 * 60 * 33).toISOString(),
  },
  {
    property_id: 'prop-004',
    property_export_id: 'export-sat-004',
    master_owner_id: 'mown-004',
    owner_id: 'own-004',
    property_address_full: '617 Birchwood Pl, San Antonio, TX 78201',
    property_address: '617 Birchwood Pl',
    property_address_city: 'San Antonio',
    property_address_state: 'TX',
    property_address_zip: '78201',
    property_address_county_name: 'Bexar',
    market: 'San Antonio',
    market_region: 'Central Texas',
    owner_name: 'Robert Simmons',
    owner_type: 'Individual',
    owner_location: 'San Antonio, TX',
    owner_address_full: '4400 Military Dr W, San Antonio, TX 78228',
    ownership_years: 28,
    seller_tags_text: 'foreclosure,vacant,distressed,tax-lien',
    property_type: 'Single Family',
    property_class: 'Residential',
    estimated_value: 185000,
    equity_amount: 185000,
    equity_percent: 100,
    total_loan_balance: 0,
    tax_amt: 6800,
    tax_year: 2024,
    tax_delinquent: true,
    tax_delinquent_year: 2021,
    active_lien: true,
    lienholder_name: 'Bexar County Tax Office',
    sale_date: '1998-02-04',
    sale_price: 76000,
    document_type: 'Deed',
    default_date: '2025-11-12',
    building_square_feet: 1100,
    total_bedrooms: 3,
    total_baths: 1,
    units_count: 1,
    year_built: 1962,
    effective_year_built: 1981,
    lot_square_feet: 5800,
    lot_acreage: 0.13,
    latitude: 29.4241,
    longitude: -98.4936,
    building_condition: 'Below average',
    building_quality: 'C-',
    construction_type: 'Frame',
    air_conditioning: 'Window units',
    basement: 'None',
    garage: 'None',
    roof_cover: 'Composition shingle',
    sewer: 'Public',
    water: 'Public',
    flood_zone: 'X',
    market_status_label: 'Distressed',
    market_status_value: 'distressed',
    market_sub_status: 'Tax delinquent',
    created_at: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
    updated_at: new Date(Date.now() - 1000 * 60 * 8).toISOString(),
  },
]

const mockRelatedRows = (): RelatedRows => ({
  masterOwners: [
    { master_owner_id: 'mown-001', owner_name: 'Diana Alvarez', owner_type: 'Individual', owner_location: 'Houston, TX', owner_address_full: '1210 Post Oak Rd, Houston, TX 77056' },
    { master_owner_id: 'mown-002', owner_name: 'Oakline Holdings LLC', owner_type: 'LLC', owner_location: 'Dallas, TX', owner_address_full: '2001 Cedar Springs Rd, Dallas, TX 75201' },
    { master_owner_id: 'mown-004', owner_name: 'Robert Simmons', owner_type: 'Individual', owner_location: 'San Antonio, TX', owner_address_full: '4400 Military Dr W, San Antonio, TX 78228' },
  ],
  prospects: [
    { prospect_id: 'pros-001', master_owner_id: 'mown-001', full_name: 'Diana Alvarez', relationship_type: 'Owner', lead_stage: 'Negotiation', status: 'Engaged', language: 'English' },
    { prospect_id: 'pros-002', master_owner_id: 'mown-002', full_name: 'Neil Burke', relationship_type: 'Manager', lead_stage: 'Qualified', status: 'Offer ready', language: 'English' },
  ],
  phones: [
    { phone_id: 'ph-001', master_owner_id: 'mown-001', property_id: 'prop-001', phone_number: '+1 (713) 555-0174', phone_type: 'Mobile', sms_status: 'Valid', status: 'Verified', score: 91, rank: 1, last_contacted: new Date(Date.now() - 1000 * 60 * 44).toISOString(), last_reply: new Date(Date.now() - 1000 * 60 * 5).toISOString() },
    { phone_id: 'ph-002', master_owner_id: 'mown-002', property_id: 'prop-002', phone_number: '+1 (214) 555-0108', phone_type: 'Mobile', sms_status: 'Valid', status: 'Verified', score: 86, rank: 1 },
  ],
  emails: [
    { email_id: 'em-001', master_owner_id: 'mown-001', property_id: 'prop-001', email: 'diana.alvarez@example.com', verification_status: 'Valid', status: 'Verified', score: 88, rank: 1 },
    { email_id: 'em-002', master_owner_id: 'mown-002', property_id: 'prop-002', email: 'operations@oaklineholdings.com', verification_status: 'Valid', status: 'Verified', score: 82, rank: 1 },
  ],
  messages: [
    { event_id: 'me-001', master_owner_id: 'mown-001', property_id: 'prop-001', direction: 'inbound', status: 'received', delivery_status: 'delivered', sentiment: 'hot', message_text: 'Can you send me a number today?', to_phone_number: '+1 (713) 555-0174', created_at: new Date(Date.now() - 1000 * 60 * 5).toISOString() },
    { event_id: 'me-002', master_owner_id: 'mown-002', property_id: 'prop-002', direction: 'inbound', status: 'received', delivery_status: 'delivered', sentiment: 'warm', message_text: 'I can talk later this afternoon.', to_phone_number: '+1 (214) 555-0108', created_at: new Date(Date.now() - 1000 * 60 * 17).toISOString() },
  ],
  queue: [
    { queue_id: 'sq-001', master_owner_id: 'mown-001', property_id: 'prop-001', queue_status: 'ready', priority: 'high', to_phone_number: '+1 (713) 555-0174', message_text: 'Hi Diana, quick follow up on Oak Ridge.', scheduled_at: new Date(Date.now() + 1000 * 60 * 20).toISOString(), updated_at: new Date(Date.now() - 1000 * 60 * 3).toISOString() },
    { queue_id: 'sq-004', master_owner_id: 'mown-004', property_id: 'prop-004', queue_status: 'approval', priority: 'urgent', to_phone_number: '+1 (210) 555-0198', message_text: 'Robert, we can close quickly if the timing helps.', scheduled_at: new Date(Date.now() + 1000 * 60 * 8).toISOString(), updated_at: new Date(Date.now() - 1000 * 60 * 8).toISOString() },
  ],
  offers: [
    { snapshot_id: 'off-001', master_owner_id: 'mown-001', property_id: 'prop-001', strategy: 'cash', offer_amount: 242000, status: 'draft', confidence: 82, updated_at: new Date(Date.now() - 1000 * 60 * 26).toISOString() },
    { snapshot_id: 'off-002', master_owner_id: 'mown-002', property_id: 'prop-002', strategy: 'novation', offer_amount: 603000, status: 'ready', confidence: 79, updated_at: new Date(Date.now() - 1000 * 60 * 47).toISOString() },
  ],
  contracts: [
    { contract_id: 'ct-002', master_owner_id: 'mown-002', property_id: 'prop-002', offer_id: 'off-002', status: 'pending', updated_at: new Date(Date.now() - 1000 * 60 * 61).toISOString() },
  ],
})

const safeSelect = async (table: string, limit = 3000): Promise<AnyRecord[]> => {
  try {
    const supabase = getSupabaseClient()
    const { data, error } = await supabase.from(table).select('*').limit(limit)
    if (error) {
      if (isDev) console.warn(`[NEXUS] propertyData ${table} fallback`, error.message)
      return []
    }
    return safeArray(data as unknown as AnyRecord[])
  } catch (error) {
    if (isDev) console.warn(`[NEXUS] propertyData ${table} unavailable`, error)
    return []
  }
}

export const normalizePropertyFilters = (filters?: PropertyFilters): PropertyFilters => ({
  market: filters?.market && filters.market !== 'All Markets' ? filters.market : undefined,
  propertyType:
    filters?.propertyType && filters.propertyType !== 'All Types' ? filters.propertyType : undefined,
  ownerType: filters?.ownerType && filters.ownerType !== 'All Owners' ? filters.ownerType : undefined,
  equity: filters?.equity ?? 'all',
  taxDelinquent: filters?.taxDelinquent ?? 'all',
  activeLien: filters?.activeLien ?? 'all',
  search: filters?.search?.trim() ? filters.search.trim() : undefined,
  quickFilters: filters?.quickFilters ?? [],
  advanced: filters?.advanced ?? [],
})

const buildSearchOr = (search: string) => {
  const escaped = search.replace(/,/g, ' ')
  return [
    `property_address_full.ilike.%${escaped}%`,
    `property_address.ilike.%${escaped}%`,
    `property_address_city.ilike.%${escaped}%`,
    `market.ilike.%${escaped}%`,
    `owner_name.ilike.%${escaped}%`,
    `owner_type.ilike.%${escaped}%`,
    `property_type.ilike.%${escaped}%`,
    `seller_tags_text.ilike.%${escaped}%`,
    `property_flags_text.ilike.%${escaped}%`,
  ].join(',')
}

const applyQuickFilter = (query: any, key: string) => {
  switch (key) {
    case 'High Equity':
      return query.gte('equity_percent', 50)
    case 'Free & Clear':
      return query.or('total_loan_balance.eq.0,offer_vs_loan.ilike.%free and clear%')
    case 'Tax Delinquent':
      return query.eq('tax_delinquent', true)
    case 'Active Lien':
      return query.eq('active_lien', true)
    case 'Absentee Owner':
      return query.eq('out_of_state_owner', true)
    case 'Corporate Owner':
      return query.eq('is_corporate_owner', true)
    case 'Out of State Owner':
      return query.eq('out_of_state_owner', true)
    case 'Multifamily':
      return query.ilike('property_type', '%multi%')
    case 'Off Market':
      return query.not('mls_market_status', 'ilike', '%active%')
    case 'Structural Rehab':
      return query.ilike('rehab_level', '%structural%')
    case 'Long Term Owner':
      return query.gte('ownership_years', 10)
    case 'Senior Owner':
      return query.or('seller_tags_text.ilike.%senior owner%,property_flags_text.ilike.%senior owner%')
    case 'Tired Landlord':
      return query.or('seller_tags_text.ilike.%tired landlord%,property_flags_text.ilike.%tired landlord%')
    case 'Heavily Dated':
      return query.or('seller_tags_text.ilike.%heavily dated%,property_flags_text.ilike.%heavily dated%')
    case 'Cash Offer Candidate':
      return query.not('cash_offer', 'is', null)
    case 'Highlighted':
      return query.eq('highlighted', true)
    default:
      return query
  }
}

const applyAdvancedClauseToSupabase = (query: any, clause: PropertyFilterClause) => {
  const column = clause.fieldKey
  const value = clause.value
  const valueTo = clause.valueTo
  switch (clause.operator) {
    case 'equals':
      return query.eq(column, value)
    case 'not_equals':
      return query.neq(column, value)
    case 'contains':
      return query.ilike(column, `%${asString(value, '')}%`)
    case 'not_contains':
      return query.not(column, 'ilike', `%${asString(value, '')}%`)
    case 'starts_with':
      return query.ilike(column, `${asString(value, '')}%`)
    case 'greater_than':
      return query.gt(column, value)
    case 'less_than':
      return query.lt(column, value)
    case 'greater_or_equal':
      return query.gte(column, value)
    case 'less_or_equal':
      return query.lte(column, value)
    case 'between':
      return query.gte(column, value).lte(column, valueTo ?? value)
    case 'before':
      return query.lt(column, value)
    case 'after':
      return query.gt(column, value)
    case 'on':
      return query.eq(column, value)
    case 'is_true':
      return query.eq(column, true)
    case 'is_false':
      return query.eq(column, false)
    case 'is_empty':
      return query.is(column, null)
    case 'is_not_empty':
      return query.not(column, 'is', null)
    case 'includes':
      return query.contains(column, Array.isArray(value) ? value : [value])
    case 'excludes':
      return query.not(column, 'cs', Array.isArray(value) ? value : [value])
    case 'contains_text':
      return query.ilike(column, `%${asString(value, '')}%`)
    default:
      return query
  }
}

export const buildSupabasePropertyQuery = (params?: PropertyQueryParams) => {
  const normalized = normalizePropertyFilters(params?.filters)
  const supabase = getSupabaseClient()
  let query: any = supabase.from('properties').select('*', { count: 'exact' })

  if (normalized.market) query = query.eq('market', normalized.market)
  if (normalized.propertyType) query = query.eq('property_type', normalized.propertyType)
  if (normalized.ownerType) query = query.eq('owner_type', normalized.ownerType)
  if (normalized.taxDelinquent === 'yes') query = query.eq('tax_delinquent', true)
  if (normalized.taxDelinquent === 'no') query = query.eq('tax_delinquent', false)
  if (normalized.activeLien === 'yes') query = query.eq('active_lien', true)
  if (normalized.activeLien === 'no') query = query.eq('active_lien', false)
  if (normalized.equity === '50plus') query = query.gte('equity_percent', 50)
  if (normalized.equity === '100k') query = query.gte('equity_amount', 100000)
  if (normalized.equity === '250k') query = query.gte('equity_amount', 250000)
  if (normalized.equity === 'freeclear') {
    query = query.or('total_loan_balance.eq.0,offer_vs_loan.ilike.%free and clear%')
  }

  if (normalized.search) query = query.or(buildSearchOr(normalized.search))

  for (const quickFilter of normalized.quickFilters ?? []) {
    query = applyQuickFilter(query, quickFilter)
  }

  for (const clause of normalized.advanced ?? []) {
    query = applyAdvancedClauseToSupabase(query, clause)
  }

  const sort = params?.sort ?? { column: 'final_acquisition_score', ascending: false }
  query = query.order(sort.column, { ascending: sort.ascending ?? false, nullsFirst: sort.nullsFirst ?? false })

  const pageSize = Math.max(1, params?.pageSize ?? 50)
  const page = Math.max(1, params?.page ?? 1)
  const from = params?.from ?? (page - 1) * pageSize
  const to = params?.to ?? (from + pageSize - 1)

  return { query: query.range(from, to), page, pageSize, from, to }
}

const applyAdvancedClauseClient = (property: PropertyRecord, clause: PropertyFilterClause): boolean => {
  const rawValue = property.raw[clause.fieldKey]
  const valueText = rawFieldValue(rawValue).toLowerCase()
  const compareText = asString(clause.value, '').toLowerCase()
  const valueNumber = toNumber(rawValue)
  const compareNumber = toNumber(clause.value)
  const compareToNumber = toNumber(clause.valueTo)
  switch (clause.operator) {
    case 'equals':
      return valueText === compareText
    case 'not_equals':
      return valueText !== compareText
    case 'contains':
    case 'contains_text':
      return valueText.includes(compareText)
    case 'not_contains':
      return !valueText.includes(compareText)
    case 'starts_with':
      return valueText.startsWith(compareText)
    case 'greater_than':
      return valueNumber !== null && compareNumber !== null ? valueNumber > compareNumber : false
    case 'less_than':
      return valueNumber !== null && compareNumber !== null ? valueNumber < compareNumber : false
    case 'greater_or_equal':
      return valueNumber !== null && compareNumber !== null ? valueNumber >= compareNumber : false
    case 'less_or_equal':
      return valueNumber !== null && compareNumber !== null ? valueNumber <= compareNumber : false
    case 'between':
      return valueNumber !== null && compareNumber !== null && compareToNumber !== null
        ? valueNumber >= compareNumber && valueNumber <= compareToNumber
        : false
    case 'is_true':
      return truthyField(rawValue)
    case 'is_false':
      return !truthyField(rawValue)
    case 'is_empty':
      return !hasMeaningfulValue(rawValue)
    case 'is_not_empty':
      return hasMeaningfulValue(rawValue)
    default:
      return true
  }
}

const applyQuickFilterClient = (property: PropertyRecord, key: string): boolean => {
  switch (key) {
    case 'High Equity': return (property.equityPercent ?? 0) >= 50
    case 'Free & Clear': return (property.loanBalance ?? 0) <= 0 || asString(property.raw.offer_vs_loan, '').toLowerCase().includes('free and clear')
    case 'Tax Delinquent': return property.taxDelinquent
    case 'Active Lien': return property.activeLien
    case 'Absentee Owner': return property.owner.outOfState || property.distressSignals.includes('Absentee')
    case 'Corporate Owner': return property.owner.isCorporate
    case 'Out of State Owner': return property.owner.outOfState
    case 'Multifamily': return asString(property.propertyType, '').toLowerCase().includes('multi')
    case 'Off Market': return !asString(property.mls.marketStatus, '').toLowerCase().includes('active')
    case 'Structural Rehab': return asString(property.rehabLevel, '').toLowerCase().includes('structural')
    case 'Long Term Owner': return (property.ownershipYears ?? 0) >= 10 || property.propertyFlags.some((tag) => /long term owner/i.test(tag))
    case 'Senior Owner': return property.allTags.some((tag) => /senior owner/i.test(tag))
    case 'Tired Landlord': return property.allTags.some((tag) => /tired landlord/i.test(tag))
    case 'Heavily Dated': return property.allTags.some((tag) => /heavily dated/i.test(tag))
    case 'Cash Offer Candidate': return (property.cashOffer ?? 0) > 0
    case 'Highlighted': return asBoolean(property.raw.highlighted, false)
    default: return true
  }
}

const fetchRelatedRowsForProperties = async (properties: PropertyRecord[]): Promise<RelatedRows> => {
  if (!shouldUseSupabase()) return mockRelatedRows()
  const propertyIds = Array.from(new Set(properties.flatMap((property) => [property.propertyId, property.id]).filter(Boolean)))
  const ownerIds = Array.from(new Set(properties.flatMap((property) => [property.masterOwnerId, property.ownerId]).filter(Boolean)))
  if (propertyIds.length === 0 && ownerIds.length === 0) {
    return {
      masterOwners: [],
      prospects: [],
      phones: [],
      emails: [],
      messages: [],
      queue: [],
      offers: [],
      contracts: [],
    }
  }

  const supabase = getSupabaseClient()
  const take = (rows: AnyRecord[] | null | undefined) => safeArray(rows as AnyRecord[])

  const [masterOwners, prospects, phones, emails, messages, queue, offers, contracts] = await Promise.all([
    ownerIds.length
      ? supabase.from('master_owners').select('*').in('master_owner_id', ownerIds).limit(1000)
      : Promise.resolve({ data: [], error: null }),
    ownerIds.length
      ? supabase.from('prospects').select('*').in('master_owner_id', ownerIds).limit(1500)
      : Promise.resolve({ data: [], error: null }),
    propertyIds.length
      ? supabase.from('phones').select('*').in('property_id', propertyIds).limit(2000)
      : Promise.resolve({ data: [], error: null }),
    propertyIds.length
      ? supabase.from('emails').select('*').in('property_id', propertyIds).limit(2000)
      : Promise.resolve({ data: [], error: null }),
    propertyIds.length
      ? supabase.from('message_events').select('*').in('property_id', propertyIds).order('created_at', { ascending: false }).limit(3000)
      : Promise.resolve({ data: [], error: null }),
    propertyIds.length
      ? supabase.from('send_queue').select('*').in('property_id', propertyIds).order('updated_at', { ascending: false }).limit(3000)
      : Promise.resolve({ data: [], error: null }),
    propertyIds.length
      ? supabase.from('property_cash_offer_snapshots').select('*').in('property_id', propertyIds).order('updated_at', { ascending: false }).limit(1000)
      : Promise.resolve({ data: [], error: null }),
    propertyIds.length
      ? supabase.from('contracts').select('*').in('property_id', propertyIds).order('updated_at', { ascending: false }).limit(1000)
      : Promise.resolve({ data: [], error: null }),
  ])

  return {
    masterOwners: take(masterOwners.data),
    prospects: take(prospects.data),
    phones: take(phones.data),
    emails: take(emails.data),
    messages: take(messages.data),
    queue: take(queue.data),
    offers: take(offers.data),
    contracts: take(contracts.data),
  }
}

const fetchRelatedRows = async (): Promise<RelatedRows> => {
  if (!shouldUseSupabase()) return mockRelatedRows()
  const [masterOwners, prospects, phones, emails, messages, queue, offers, contracts] = await Promise.all([
    safeSelect('master_owners'),
    safeSelect('prospects'),
    safeSelect('phones'),
    safeSelect('emails'),
    safeSelect('message_events'),
    safeSelect('send_queue'),
    safeSelect('property_cash_offer_snapshots'),
    safeSelect('contracts'),
  ])
  return { masterOwners, prospects, phones, emails, messages, queue, offers, contracts }
}

const propertyLinkValues = (property: PropertyRecord, contacts?: PropertyContactContext) => ({
  propertyIds: [property.propertyId, property.propertyExportId, property.id].map(normalizeId).filter(Boolean),
  ownerIds: [property.masterOwnerId, property.ownerId, property.masterKey].map(normalizeId).filter(Boolean),
  prospectIds: contacts?.prospects.map((prospect) => normalizeId(prospect.id)).filter(Boolean) ?? [],
  phones: contacts?.phones.map((phone) => normalizePhone(phone.phoneNumber)).filter(Boolean) ?? [],
})

const linkedRows = (property: PropertyRecord, rows: AnyRecord[], contacts?: PropertyContactContext) => {
  const link = propertyLinkValues(property, contacts)
  return rows.filter((row) => {
    const rowPropertyIds = [
      getFirst(row, ['property_id']),
      getFirst(row, ['property_export_id']),
      getFirst(row, ['upsert_key']),
    ].map(normalizeId)
    const rowOwnerIds = [
      getFirst(row, ['master_owner_id']),
      getFirst(row, ['owner_id']),
      getFirst(row, ['seller_id']),
      getFirst(row, ['master_key']),
      getFirst(row, ['id']),
    ].map(normalizeId)
    const rowProspectIds = [getFirst(row, ['prospect_id'])].map(normalizeId)
    const rowPhones = [
      getFirst(row, ['to_phone_number']),
      getFirst(row, ['from_phone_number']),
      getFirst(row, ['phone_number']),
      getFirst(row, ['phone']),
      getFirst(row, ['canonical_e164']),
      getFirst(row, ['seller_phone']),
    ].map(normalizePhone)

    return (
      rowPropertyIds.some((id) => id && link.propertyIds.includes(id)) ||
      rowOwnerIds.some((id) => id && link.ownerIds.includes(id)) ||
      rowProspectIds.some((id) => id && link.prospectIds.includes(id)) ||
      rowPhones.some((phone) => phone && link.phones.includes(phone))
    )
  })
}

const latest = <T extends { timestamp?: string | null; updatedAt?: string | null; scheduledAt?: string | null }>(items: T[]) =>
  [...items].sort((a, b) => {
    const aTime = new Date(a.timestamp ?? a.updatedAt ?? a.scheduledAt ?? 0).getTime()
    const bTime = new Date(b.timestamp ?? b.updatedAt ?? b.scheduledAt ?? 0).getTime()
    return bTime - aTime
  })

export const fetchPropertiesPage = async (params?: PropertyQueryParams): Promise<PropertyPageResult> => {
  const pageSize = Math.max(1, params?.pageSize ?? 50)
  const page = Math.max(1, params?.page ?? 1)

  if (!shouldUseSupabase()) {
    const all = mockRows().map(normalizeProperty)
    const filtered = applyPropertyFilters(all, params?.filters)
    const from = (page - 1) * pageSize
    const to = from + pageSize
    return {
      records: filtered.slice(from, to),
      totalCount: filtered.length,
      page,
      pageSize,
    }
  }

  const { query } = buildSupabasePropertyQuery(params)
  const { data, error, count } = await query
  if (error) {
    if (isDev) console.warn('[NEXUS] fetchPropertiesPage fallback', error.message)
    return { records: [], totalCount: 0, page, pageSize }
  }

  return {
    records: safeArray(data as unknown as AnyRecord[]).map((row, index) => normalizeProperty(row, index)),
    totalCount: count ?? 0,
    page,
    pageSize,
  }
}

export const fetchPropertyCount = async (params?: PropertyQueryParams): Promise<number> => {
  if (!shouldUseSupabase()) {
    return applyPropertyFilters(mockRows().map(normalizeProperty), params?.filters).length
  }
  const supabase = getSupabaseClient()
  const normalized = normalizePropertyFilters(params?.filters)
  let query: any = supabase.from('properties').select('*', { count: 'exact', head: true })
  if (normalized.market) query = query.eq('market', normalized.market)
  if (normalized.propertyType) query = query.eq('property_type', normalized.propertyType)
  if (normalized.ownerType) query = query.eq('owner_type', normalized.ownerType)
  if (normalized.search) query = query.or(buildSearchOr(normalized.search))
  const { count } = await query
  return count ?? 0
}

export const fetchPropertyStats = async (params?: PropertyQueryParams): Promise<PropertyStats> => {
  const page = await fetchPropertiesPage({ ...params, page: 1, pageSize: 200 })
  const totalProperties = page.totalCount
  const highEquityCount = page.records.filter((property) => (property.equityPercent ?? 0) >= 50).length
  const distressCount = page.records.filter((property) => property.distressSignals.length > 0).length
  const taxDelinquentCount = page.records.filter((property) => property.taxDelinquent).length
  const activeLienCount = page.records.filter((property) => property.activeLien).length
  const freeClearCount = page.records.filter((property) => (property.loanBalance ?? 0) <= 0).length
  const avgPriorityScore =
    page.records.length > 0
      ? Math.round(page.records.reduce((sum, property) => sum + property.priorityScore, 0) / page.records.length)
      : 0

  return {
    totalProperties,
    highEquityCount,
    distressCount,
    avgPriorityScore,
    taxDelinquentCount,
    activeLienCount,
    freeClearCount,
  }
}

export const fetchPropertyFacetOptions = async (): Promise<PropertyFacetOptions> => {
  const page = await fetchPropertiesPage({ page: 1, pageSize: 500, sort: { column: 'updated_at', ascending: false } })
  return {
    marketOptions: optionList(page.records.map((property) => property.market), 'All Markets'),
    propertyTypeOptions: optionList(page.records.map((property) => property.propertyType), 'All Types'),
    ownerTypeOptions: optionList(page.records.map((property) => property.ownerType), 'All Owners'),
    marketStatusOptions: optionList(page.records.map((property) => property.marketStatusLabel), 'All Market Statuses'),
    rehabLevelOptions: optionList(page.records.map((property) => property.rehabLevel), 'All Rehab Levels'),
  }
}

export const fetchPropertyMapPoints = async (params?: PropertyQueryParams): Promise<PropertyMapPoint[]> => {
  const page = await fetchPropertiesPage({ ...params, pageSize: params?.pageSize ?? 500 })
  return page.records
    .filter((property) => property.lat !== null && property.lng !== null)
    .map((property) => ({
      id: property.id,
      propertyId: property.propertyId,
      address: property.address,
      lat: property.lat as number,
      lng: property.lng as number,
      priorityScore: property.priorityScore,
      distressSignals: property.distressSignals,
      market: property.market,
    }))
}

export const fetchProperties = async (filters?: PropertyFilters): Promise<PropertyRecord[]> => {
  const page = await fetchPropertiesPage({ page: 1, pageSize: 50, filters })
  return page.records
}

export const fetchPropertyById = async (propertyId: string): Promise<PropertyRecord | null> => {
  const normalizedId = normalizeId(propertyId)
  if (!shouldUseSupabase()) {
    return mockRows().map(normalizeProperty).find((property) =>
      [property.id, property.propertyId, property.propertyExportId].some((id) => normalizeId(id) === normalizedId),
    ) ?? null
  }

  const supabase = getSupabaseClient()
  const { data, error } = await supabase
    .from('properties')
    .select('*')
    .or(`property_id.eq.${propertyId},property_export_id.eq.${propertyId},upsert_key.eq.${propertyId}`)
    .limit(1)
    .maybeSingle()

  if (error || !data) return null
  return normalizeProperty(data as AnyRecord)
}

export const fetchPropertyContacts = async (property: PropertyRecord): Promise<PropertyContactContext> => {
  const rows = await fetchRelatedRows()
  return buildContacts(property, rows)
}

export const fetchPropertyMessages = async (property: PropertyRecord): Promise<PropertyMessageEvent[]> => {
  const rows = await fetchRelatedRows()
  const contacts = buildContacts(property, rows)
  return buildMessages(property, rows, contacts)
}

export const fetchPropertyQueue = async (property: PropertyRecord): Promise<PropertyQueueContext> => {
  const rows = await fetchRelatedRows()
  const contacts = buildContacts(property, rows)
  const messages = buildMessages(property, rows, contacts)
  return buildQueue(property, rows, contacts, messages)
}

export const fetchPropertyOfferPathway = async (property: PropertyRecord): Promise<PropertyOfferPathway> => {
  const rows = await fetchRelatedRows()
  return buildOfferPathway(property, rows)
}

export const fetchPropertyIntelligenceModel = async (
  params?: PropertyQueryParams,
): Promise<PropertyIntelligenceModel> => {
  const page = await fetchPropertiesPage(params)
  const properties = page.records
  const relatedRows = await fetchRelatedRowsForProperties(properties)

  const contextsByPropertyId = properties.reduce<Record<string, PropertyIntelligenceContext>>((acc, property) => {
    const owner = buildOwner(property, relatedRows)
    const contacts = buildContacts(property, relatedRows)
    const messages = buildMessages(property, relatedRows, contacts)
    acc[property.id] = {
      owner,
      contacts,
      messages,
      queue: buildQueue(property, relatedRows, contacts, messages),
      offerPathway: buildOfferPathway(property, relatedRows),
    }
    return acc
  }, {})

  return {
    properties,
    contextsByPropertyId,
    marketOptions: optionList(properties.map((property) => property.market), 'All Markets'),
    propertyTypeOptions: optionList(properties.map((property) => property.propertyType), 'All Types'),
    ownerTypeOptions: optionList(properties.map((property) => property.ownerType), 'All Owners'),
  }
}

const buildOwner = (property: PropertyRecord, rows: RelatedRows): PropertyOwnerContext | null => {
  const row = linkedRows(property, rows.masterOwners)[0]
  if (!row) return null

  return {
    id: toText(getFirst(row, ['master_owner_id', 'id', 'owner_id'])) ?? property.masterOwnerId ?? property.ownerId ?? property.id,
    name: toText(getFirst(row, ['owner_name', 'name', 'full_name', 'display_name'])) ?? property.ownerName,
    type: toText(getFirst(row, ['owner_type', 'type', 'entity_type'])) ?? property.ownerType,
    location: toText(getFirst(row, ['owner_location', 'location', 'mailing_city_state'])) ?? property.ownerLocation,
    mailingAddress: toText(getFirst(row, ['owner_address_full', 'mailing_address_full', 'address_full', 'mailing_address'])) ?? property.ownerAddress,
    raw: row,
  }
}

const buildContacts = (property: PropertyRecord, rows: RelatedRows): PropertyContactContext => {
  const prospects = linkedRows(property, rows.prospects).map((row, index): PropertyProspectContext => ({
    id: toText(getFirst(row, ['prospect_id', 'id'])) ?? `prospect-${index + 1}`,
    name: toText(getFirst(row, ['full_name', 'prospect_name', 'name', 'owner_name'])) ?? 'Unknown Prospect',
    relationship: toText(getFirst(row, ['relationship_type', 'relationship'])),
    stage: toText(getFirst(row, ['lead_stage', 'seller_stage', 'stage'])),
    status: toText(getFirst(row, ['status', 'outreach_status'])),
    language: toText(getFirst(row, ['language'])),
    raw: row,
  }))

  const lightContacts: PropertyContactContext = {
    prospects,
    phones: [],
    emails: [],
    primaryPhone: null,
    primaryEmail: null,
    bestPhoneConfidence: null,
    bestChannel: null,
    bestContactWindow: null,
    language: prospects[0]?.language ?? null,
  }

  const phones = linkedRows(property, rows.phones, lightContacts)
    .map((row, index): PropertyPhoneContext => ({
      id: toText(getFirst(row, ['phone_id', 'id'])) ?? `phone-${index + 1}`,
      phoneNumber: toText(getFirst(row, ['phone_number', 'phone', 'to_phone_number'])) ?? 'Unknown phone',
      type: toText(getFirst(row, ['phone_type', 'type'])),
      status: toText(getFirst(row, ['status', 'verification_status'])),
      smsStatus: toText(getFirst(row, ['sms_status', 'deliverability_status'])),
      confidence: toNumber(getFirst(row, ['confidence', 'score', 'phone_score'])),
      rank: toNumber(getFirst(row, ['rank', 'priority_rank'])),
      lastContacted: asIso(getFirst(row, ['last_contacted', 'last_contacted_at'])),
      lastReply: asIso(getFirst(row, ['last_reply', 'last_reply_at'])),
      raw: row,
    }))
    .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || (b.confidence ?? 0) - (a.confidence ?? 0))

  const contactContext = { ...lightContacts, phones, primaryPhone: phones[0] ?? null }

  const emails = linkedRows(property, rows.emails, contactContext)
    .map((row, index): PropertyEmailContext => ({
      id: toText(getFirst(row, ['email_id', 'id'])) ?? `email-${index + 1}`,
      email: toText(getFirst(row, ['email', 'email_address'])) ?? 'Unknown email',
      status: toText(getFirst(row, ['status'])),
      verificationStatus: toText(getFirst(row, ['verification_status', 'email_status'])),
      confidence: toNumber(getFirst(row, ['confidence', 'score', 'email_score'])),
      rank: toNumber(getFirst(row, ['rank', 'priority_rank'])),
      raw: row,
    }))
    .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || (b.confidence ?? 0) - (a.confidence ?? 0))

  return {
    ...contactContext,
    emails,
    primaryEmail: emails[0] ?? null,
    bestPhoneConfidence: phones[0]?.confidence ?? null,
    bestChannel: phones.length > 0 ? 'SMS' : emails.length > 0 ? 'Email' : null,
    bestContactWindow: toText(getFirst(prospects[0]?.raw ?? {}, ['best_contact_window', 'contact_window'])) ?? null,
    language: prospects[0]?.language ?? null,
  }
}

const buildMessages = (
  property: PropertyRecord,
  rows: RelatedRows,
  contacts: PropertyContactContext,
): PropertyMessageEvent[] =>
  latest(
    linkedRows(property, rows.messages, contacts).map((row, index): PropertyMessageEvent => {
      const directionText = asString(getFirst(row, ['direction', 'message_direction', 'source_app']), '').toLowerCase()
      const direction =
        directionText.includes('in') || asBoolean(getFirst(row, ['inbound']), false)
          ? 'inbound'
          : directionText.includes('out') || asBoolean(getFirst(row, ['outbound']), false)
            ? 'outbound'
            : 'unknown'

      return {
        id: toText(getFirst(row, ['event_id', 'message_id', 'id'])) ?? `message-${index + 1}`,
        direction,
        body: toText(getFirst(row, ['message_text', 'body', 'message', 'content'])) ?? '',
        status: toText(getFirst(row, ['status', 'event_status'])),
        deliveryStatus: toText(getFirst(row, ['delivery_status', 'provider_delivery_status'])),
        sentiment: toText(getFirst(row, ['sentiment', 'ai_sentiment'])),
        timestamp: asIso(getFirst(row, ['created_at', 'timestamp', 'sent_at', 'received_at'])),
        toPhoneNumber: toText(getFirst(row, ['to_phone_number', 'to_phone', 'phone_number'])),
        fromPhoneNumber: toText(getFirst(row, ['from_phone_number', 'from_phone'])),
        raw: row,
      }
    }),
  )

const buildQueue = (
  property: PropertyRecord,
  rows: RelatedRows,
  contacts: PropertyContactContext,
  messages: PropertyMessageEvent[],
): PropertyQueueContext => {
  const items = latest(
    linkedRows(property, rows.queue, contacts).map((row, index): PropertyQueueItem => ({
      id: toText(getFirst(row, ['queue_id', 'id', 'queue_key'])) ?? `queue-${index + 1}`,
      status: toText(getFirst(row, ['queue_status', 'status'])) ?? 'unknown',
      priority: toText(getFirst(row, ['priority', 'risk_level'])),
      message: toText(getFirst(row, ['message_text', 'body', 'content'])),
      scheduledAt: asIso(getFirst(row, ['scheduled_at', 'scheduled_for', 'send_at'])),
      sentAt: asIso(getFirst(row, ['sent_at'])),
      updatedAt: asIso(getFirst(row, ['updated_at', 'created_at', 'scheduled_at'])),
      toPhoneNumber: toText(getFirst(row, ['to_phone_number', 'phone_number', 'phone'])),
      raw: row,
    })),
  )

  const lastOutbound = messages.find((message) => message.direction === 'outbound')
  const lastInbound = messages.find((message) => message.direction === 'inbound')
  const deliveryState = items[0]?.status ?? messages.find((message) => message.deliveryStatus)?.deliveryStatus ?? null

  return {
    items,
    latest: items[0] ?? null,
    lastOutboundAt: lastOutbound?.timestamp ?? null,
    lastInboundAt: lastInbound?.timestamp ?? null,
    messageCount: messages.length,
    deliveryState,
  }
}

const buildOfferPathway = (property: PropertyRecord, rows: RelatedRows): PropertyOfferPathway => {
  const offers = latest(
    linkedRows(property, rows.offers).map((row, index): PropertyOfferItem => ({
      id: toText(getFirst(row, ['snapshot_id', 'offer_id', 'id'])) ?? `offer-${index + 1}`,
      strategy: toText(getFirst(row, ['strategy', 'offer_strategy', 'offer_type'])),
      amount: toNumber(getFirst(row, ['offer_amount', 'cash_offer', 'recommended_offer', 'amount'])),
      status: toText(getFirst(row, ['status', 'offer_status'])),
      confidence: toNumber(getFirst(row, ['confidence', 'ai_confidence', 'confidence_score'])),
      updatedAt: asIso(getFirst(row, ['updated_at', 'created_at'])),
      raw: row,
    })),
  )
  const contracts = latest(
    linkedRows(property, rows.contracts).map((row, index): PropertyContractItem => ({
      id: toText(getFirst(row, ['contract_id', 'id'])) ?? `contract-${index + 1}`,
      status: toText(getFirst(row, ['status', 'contract_status'])),
      offerId: toText(getFirst(row, ['offer_id', 'linked_offer_id'])),
      updatedAt: asIso(getFirst(row, ['updated_at', 'created_at', 'sent_at'])),
      raw: row,
    })),
  )

  return {
    offers,
    contracts,
    latestOffer: offers[0] ?? null,
    activeContract: contracts.find((contract) => /active|pending|sent|signed/i.test(contract.status ?? '')) ?? contracts[0] ?? null,
  }
}

const applyPropertyFilters = (properties: PropertyRecord[], filters?: PropertyFilters) => {
  const normalizedFilters = normalizePropertyFilters(filters)
  const search = normalizedFilters.search?.trim().toLowerCase()
  return properties.filter((property) => {
    if (normalizedFilters.market && property.market !== normalizedFilters.market) return false
    if (normalizedFilters.propertyType && property.propertyType !== normalizedFilters.propertyType) return false
    if (normalizedFilters.ownerType && property.ownerType !== normalizedFilters.ownerType) return false
    if (normalizedFilters.equity === '50plus' && (property.equityPercent ?? 0) < 50) return false
    if (normalizedFilters.equity === '100k' && (property.equityAmount ?? 0) < 100000) return false
    if (normalizedFilters.equity === '250k' && (property.equityAmount ?? 0) < 250000) return false
    if (normalizedFilters.equity === 'freeclear' && !((property.loanBalance ?? 0) <= 0 && (property.equityAmount ?? 0) > 0)) return false
    if (normalizedFilters.taxDelinquent === 'yes' && !property.taxDelinquent) return false
    if (normalizedFilters.taxDelinquent === 'no' && property.taxDelinquent) return false
    if (normalizedFilters.activeLien === 'yes' && !property.activeLien) return false
    if (normalizedFilters.activeLien === 'no' && property.activeLien) return false

    for (const quickFilter of normalizedFilters.quickFilters ?? []) {
      if (!applyQuickFilterClient(property, quickFilter)) return false
    }

    for (const clause of normalizedFilters.advanced ?? []) {
      if (!applyAdvancedClauseClient(property, clause)) return false
    }

    if (!search) return true
    return [
      property.address,
      property.market,
      property.marketRegion,
      property.ownerName,
      property.ownerType,
      property.propertyType,
      property.distressSignals.join(' '),
      property.sellerTags.join(' '),
    ].some((value) => value?.toLowerCase().includes(search))
  })
}

const optionList = (values: Array<string | null>, allLabel: string): string[] => [
  allLabel,
  ...Array.from(new Set(values.filter((value): value is string => Boolean(value)))).sort((a, b) => a.localeCompare(b)),
]

export const hasMeaningfulValue = (value: unknown): boolean => {
  if (value === null || value === undefined || value === '') return false
  if (typeof value === 'string') return !['n/a', 'unknown', 'none', 'null'].includes(value.trim().toLowerCase())
  return true
}

export const rawFieldLabel = (field: string): string =>
  field
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')

export const rawFieldValue = (value: unknown): string => {
  if (!hasMeaningfulValue(value)) return 'N/A'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'number') return numberFormatter.format(value)
  if (Array.isArray(value)) return value.join(', ')
  if (typeof value === 'object') return JSON.stringify(value)
  const iso = asIso(value)
  if (typeof value === 'string' && iso && /\d{4}-\d{2}-\d{2}|T\d{2}:/i.test(value)) return formatDate(value)
  return asString(value, 'N/A')
}

export const yesNo = (value: unknown): string => (truthyField(value) ? 'Yes' : 'No')
