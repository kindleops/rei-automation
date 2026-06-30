import type { CompRecord } from '../../domain/deal-intelligence/deal-intelligence.types'

export const MAP_FOCUS_COMP_EVENT = 'nexus:map-focus-comp'
export const MAP_FOCUS_WORKSPACE_EVENT = 'nexus:map-focus-workspace'

const PENDING_MAP_COMP_KEY = 'nx.pending-map-comp'

export type MapFocusCompPayload = {
  propertyId?: string | null
  compId?: string | null
  address?: string | null
  city?: string | null
  state?: string | null
  zip?: string | null
  latitude?: number | null
  longitude?: number | null
  salePrice?: number | null
  saleDate?: string | null
  propertyType?: string | null
  assetClass?: string | null
  units?: number | null
  sqft?: number | null
  bedrooms?: number | null
  bathrooms?: number | null
  yearBuilt?: number | null
  ppsf?: number | null
  ppu?: number | null
  buyerName?: string | null
  isMlsSale?: boolean | null
  isOffMarket?: boolean | null
  isCorporateBuyer?: boolean | null
}

export function buildMapFocusCompFromRecord(comp: CompRecord): MapFocusCompPayload {
  const address = comp.address || null
  const parts = address ? address.split(',').map((part) => part.trim()) : []
  return {
    propertyId: comp.id || null,
    compId: comp.id || null,
    address,
    city: parts.length >= 2 ? parts[parts.length - 2] : null,
    state: parts.length >= 1 ? parts[parts.length - 1]?.match(/\b[A-Z]{2}\b/)?.[0] ?? null : null,
    zip: parts.join(' ').match(/\b\d{5}(?:-\d{4})?\b/)?.[0] ?? null,
    latitude: comp.latitude ?? null,
    longitude: comp.longitude ?? null,
    salePrice: comp.sale_price ?? null,
    saleDate: comp.sale_date ?? null,
    propertyType: comp.property_type ?? null,
    assetClass: comp.asset_class ?? null,
    units: comp.units ?? null,
    sqft: comp.sqft ?? null,
    bedrooms: comp.bedrooms ?? null,
    bathrooms: comp.bathrooms ?? null,
    yearBuilt: comp.year_built ?? null,
    ppsf: comp.ppsf ?? null,
    ppu: comp.ppu ?? null,
    buyerName: comp.buyer_name ?? null,
    isMlsSale: comp.is_mls_sale ?? null,
    isOffMarket: comp.is_off_market ?? null,
    isCorporateBuyer: comp.is_corporate_buyer ?? null,
  }
}

export function peekPendingMapComp(): MapFocusCompPayload | null {
  if (typeof window === 'undefined') return null
  const raw = sessionStorage.getItem(PENDING_MAP_COMP_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as MapFocusCompPayload
  } catch {
    return null
  }
}

export function consumePendingMapComp(): MapFocusCompPayload | null {
  const pending = peekPendingMapComp()
  if (typeof window !== 'undefined') sessionStorage.removeItem(PENDING_MAP_COMP_KEY)
  return pending
}

export function mapFocusPayloadToSoldCompFeature(payload: MapFocusCompPayload): Record<string, unknown> {
  const propertyId = String(payload.propertyId || payload.compId || payload.address || 'comp')
  return {
    property_id: propertyId,
    property_address_full: payload.address || 'Comparable property',
    property_address_city: payload.city || '',
    property_address_state: payload.state || '',
    property_address_zip: payload.zip || '',
    latitude: payload.latitude ?? null,
    longitude: payload.longitude ?? null,
    sale_price: payload.salePrice ?? null,
    sale_date: payload.saleDate ?? null,
    mls_sold_price: payload.isMlsSale ? payload.salePrice ?? null : null,
    property_type: payload.propertyType ?? null,
    normalized_asset_class: payload.assetClass ?? null,
    units_count: payload.units ?? null,
    building_square_feet: payload.sqft ?? null,
    total_bedrooms: payload.bedrooms ?? null,
    total_baths: payload.bathrooms ?? null,
    year_built: payload.yearBuilt ?? null,
    computed_ppsf: payload.ppsf ?? null,
    ppu: payload.ppu ?? null,
    owner_name: payload.buyerName ?? null,
    is_corporate_owner: payload.isCorporateBuyer ?? null,
  }
}

/** Opens Command Map and focuses a sold comp card at its coordinates. */
export function openInboxMapComp(comp: MapFocusCompPayload) {
  if (typeof window === 'undefined') return
  sessionStorage.setItem(PENDING_MAP_COMP_KEY, JSON.stringify(comp))
  window.dispatchEvent(new CustomEvent(MAP_FOCUS_WORKSPACE_EVENT))
  window.dispatchEvent(new CustomEvent(MAP_FOCUS_COMP_EVENT, { detail: { comp } }))
  window.setTimeout(() => {
    window.dispatchEvent(new CustomEvent(MAP_FOCUS_COMP_EVENT, { detail: { comp } }))
  }, 280)
}