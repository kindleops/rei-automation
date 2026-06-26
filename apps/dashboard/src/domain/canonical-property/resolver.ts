import type { DealContext } from '../../lib/data/dealContext'
import type { InboxWorkflowThread } from '../../lib/data/inboxWorkflowData'
import type { AnyRecord } from '../../lib/data/shared'
import { resolveCoordinatesFromContext } from '../comp-intelligence/coordinate-resolver'

export interface CanonicalPropertyRecord {
  property_id: string
  source_property_id: string | null
  parcel_id: string | null
  apn: string | null
  normalized_address: string
  display_address: string
  latitude: number | null
  longitude: number | null
  square_feet: number | null
  lot_size: number | null
  units: number | null
  bedrooms: number | null
  bathrooms: number | null
  year_built: number | null
  asset_type: string | null
  property_type: string | null
  market: string | null
  city: string | null
  county: string | null
  state: string | null
  zip: string | null
  owner_id: string | null
  master_owner_id: string | null
  opportunity_id: string | null
  thread_key: string | null
  coordinate_source: string
  coordinate_confidence: number
  data_source: string
  data_timestamp: string | null
  is_subject_resolved: boolean
  is_market_fallback: boolean
  coordinate_failure_reason: string | null
}

function clean(value: unknown): string {
  return String(value ?? '').trim()
}

function parsePositiveNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(String(value).replace(/,/g, ''))
  if (!Number.isFinite(n)) return null
  if (n <= 0) return null
  return n
}

function normalizeAssetType(value: unknown, propertyType?: unknown): string {
  const raw = clean(value || propertyType).toLowerCase()
  if (!raw) return 'single_family'
  if (raw.includes('multi') || raw.includes('apartment') || raw.includes('unit')) return 'multifamily'
  if (raw.includes('land') || raw.includes('vacant') || raw.includes('lot')) return 'land'
  if (raw.includes('commercial') || raw.includes('retail') || raw.includes('industrial')) return 'commercial'
  if (raw.includes('single') || raw.includes('sfr') || raw.includes('sfh') || raw === 'sfr') return 'single_family'
  return raw
}

function pickPropertyBag(
  dealContext?: DealContext | null,
  thread?: InboxWorkflowThread | null,
): AnyRecord {
  const t = thread as unknown as AnyRecord | null
  const property = (dealContext?.property ?? {}) as AnyRecord
  const rawPayload = (property.raw_payload_json ?? property.raw_payload) as AnyRecord | undefined
  return { ...property, ...(rawPayload ?? {}), ...(t ?? {}) }
}

function resolveSquareFeet(bag: AnyRecord): number | null {
  const candidates = [
    bag.building_square_feet,
    bag.square_feet,
    bag.sqft,
    bag.living_square_feet,
    bag.gross_living_area,
    bag.total_sqft,
    bag.building_sqft,
  ]
  for (const value of candidates) {
    const parsed = parsePositiveNumber(value)
    if (parsed) return parsed
  }
  return null
}

export function resolveCanonicalProperty({
  dealContext = null,
  thread = null,
  opportunityId = null,
  propertyRecord = null,
}: {
  dealContext?: DealContext | null
  thread?: InboxWorkflowThread | null
  opportunityId?: string | null
  propertyRecord?: AnyRecord | null
}): CanonicalPropertyRecord | null {
  const t = thread as unknown as AnyRecord | null
  const bag = { ...pickPropertyBag(dealContext, thread), ...(propertyRecord ?? {}) }

  const propertyId = clean(
    dealContext?.propertyId ||
      dealContext?.property_id ||
      t?.propertyId ||
      t?.property_id ||
      bag.property_id,
  )
  if (!propertyId) return null

  const rawPayload = (propertyRecord?.raw_payload_json
    ?? propertyRecord?.raw_payload
    ?? bag.raw_payload_json
    ?? bag.raw_payload) as AnyRecord | undefined

  const coords = resolveCoordinatesFromContext({
    dealContext: dealContext as unknown as AnyRecord | null,
    thread: t,
    property: bag,
    rawPayload,
    propertyRecord: propertyRecord ?? null,
  })

  const displayAddress = clean(
    dealContext?.propertyAddress ||
      dealContext?.property_address_full ||
      bag.property_address_full ||
      bag.property_address ||
      t?.propertyAddress ||
      t?.property_address ||
      t?.subject,
  )

  const squareFeet = resolveSquareFeet(bag)

  return {
    property_id: propertyId,
    source_property_id: clean(bag.property_export_id || bag.source_property_id) || null,
    parcel_id: clean(bag.apn_parcel_id || bag.parcel_id) || null,
    apn: clean(bag.apn_parcel_id || bag.apn) || null,
    normalized_address: displayAddress,
    display_address: displayAddress,
    latitude: coords.latitude,
    longitude: coords.longitude,
    square_feet: squareFeet,
    lot_size: parsePositiveNumber(bag.lot_square_feet ?? bag.lot_size),
    units: parsePositiveNumber(bag.units_count ?? bag.units),
    bedrooms: parsePositiveNumber(bag.total_bedrooms ?? bag.bedrooms ?? bag.beds),
    bathrooms: parsePositiveNumber(bag.total_baths ?? bag.bathrooms ?? bag.baths),
    year_built: parsePositiveNumber(bag.year_built ?? bag.effective_year_built),
    asset_type: normalizeAssetType(
      bag.normalized_asset_class ?? bag.asset_class ?? bag.asset_type,
      bag.property_type ?? dealContext?.property_type,
    ),
    property_type: clean(bag.property_type ?? dealContext?.property_type) || null,
    market: clean(bag.market ?? dealContext?.market) || null,
    city: clean(bag.property_address_city ?? bag.city) || null,
    county: clean(bag.property_address_county_name ?? bag.property_county_name ?? bag.county) || null,
    state: clean(bag.property_address_state ?? bag.state ?? dealContext?.propertyState) || null,
    zip: clean(bag.property_address_zip ?? bag.property_zip ?? bag.zip ?? dealContext?.propertyZip) || null,
    owner_id: clean(dealContext?.masterOwnerId ?? dealContext?.master_owner_id ?? t?.master_owner_id) || null,
    master_owner_id: clean(dealContext?.masterOwnerId ?? dealContext?.master_owner_id ?? t?.master_owner_id) || null,
    opportunity_id: clean(opportunityId ?? dealContext?.opportunityId) || null,
    thread_key: clean(dealContext?.threadKey ?? dealContext?.thread_key ?? t?.thread_key) || null,
    coordinate_source: coords.coordinate_source,
    coordinate_confidence: coords.coordinate_confidence,
    data_source: 'canonical_property_resolver_v1',
    data_timestamp: clean(bag.updated_at) || null,
    is_subject_resolved: coords.is_subject_resolved,
    is_market_fallback: coords.is_market_fallback,
    coordinate_failure_reason: coords.failure_reason,
  }
}