/**
 * Frontend mirror of the API's map-asset-type classification.
 * Works on property records returned by the map endpoint.
 */

export type MapAssetType =
  | 'sfr'
  | 'condo'
  | 'townhome'
  | 'multifamily_small'
  | 'multifamily_large'
  | 'storage'
  | 'shopping_plaza'
  | 'retail'
  | 'office'
  | 'industrial'
  | 'warehouse'
  | 'mixed_use'
  | 'hotel'
  | 'mhp'
  | 'land'
  | 'commercial'
  | 'unknown'

export type MapMarkerState =
  | 'base_property'
  | 'not_contacted'
  | 'queued'
  | 'scheduled'
  | 'active_sending'
  | 'sent'
  | 'delivered'
  | 'new_reply'
  | 'positive'
  | 'negotiating'
  | 'hot'
  | 'needs_review'
  | 'blocked'
  | 'suppressed'
  | 'buyer_comp'
  | 'sold_comp'

// ─── Icon slug mapping ───────────────────────────────────────────────────────

export const ASSET_TYPE_TO_PIN_ICON: Record<MapAssetType, string> = {
  sfr: 'nexus-pin-sfr',
  condo: 'nexus-pin-sfr',
  townhome: 'nexus-pin-sfr',
  multifamily_small: 'nexus-pin-multi',
  multifamily_large: 'nexus-pin-apt',
  storage: 'nexus-pin-storage',
  shopping_plaza: 'nexus-pin-retail',
  retail: 'nexus-pin-retail',
  office: 'nexus-pin-office',
  industrial: 'nexus-pin-industrial',
  warehouse: 'nexus-pin-industrial',
  mixed_use: 'nexus-pin-comm',
  hotel: 'nexus-pin-hotel',
  mhp: 'nexus-pin-mhp',
  land: 'nexus-pin-land',
  commercial: 'nexus-pin-comm',
  unknown: 'nexus-pin-default',
}

// ─── Marker state colors ─────────────────────────────────────────────────────

export const MARKER_STATE_COLORS: Record<MapMarkerState, string> = {
  hot: '#d4404c',
  new_reply: '#38d0f0',
  positive: '#2cb87a',
  negotiating: '#d89530',
  needs_review: '#d89530',
  blocked: '#d4404c',
  queued: '#5b9cf6',
  scheduled: '#5b9cf6',
  active_sending: '#5b9cf6',
  sent: '#3db87a',
  delivered: '#2cb87a',
  suppressed: '#4e6e88',
  buyer_comp: '#7c3aed',
  sold_comp: '#c2410c',
  not_contacted: '#4e6e88',
  base_property: '#64748b',
}

// ─── MapLibre expression builders ────────────────────────────────────────────

/** MapLibre expression: icon-image from assetType feature property */
export const ASSET_ICON_MAPLIBRE_EXPR = [
  'match', ['get', 'assetType'],
  'sfr', 'nexus-pin-sfr',
  'condo', 'nexus-pin-sfr',
  'townhome', 'nexus-pin-sfr',
  'multifamily_small', 'nexus-pin-multi',
  'multifamily_large', 'nexus-pin-apt',
  'storage', 'nexus-pin-storage',
  'shopping_plaza', 'nexus-pin-retail',
  'retail', 'nexus-pin-retail',
  'office', 'nexus-pin-office',
  'industrial', 'nexus-pin-industrial',
  'warehouse', 'nexus-pin-industrial',
  'mixed_use', 'nexus-pin-comm',
  'hotel', 'nexus-pin-hotel',
  'mhp', 'nexus-pin-mhp',
  'land', 'nexus-pin-land',
  'commercial', 'nexus-pin-comm',
  'nexus-pin-default',
]

/** MapLibre expression: circle/icon color from markerState feature property */
export const MARKER_STATE_COLOR_EXPR = [
  'match', ['get', 'markerState'],
  'hot', '#d4404c',
  'new_reply', '#38d0f0',
  'positive', '#2cb87a',
  'negotiating', '#d89530',
  'needs_review', '#d89530',
  'blocked', '#d4404c',
  'queued', '#5b9cf6',
  'scheduled', '#5b9cf6',
  'active_sending', '#5b9cf6',
  'sent', '#3db87a',
  'delivered', '#2cb87a',
  'suppressed', '#4e6e88',
  'buyer_comp', '#7c3aed',
  'sold_comp', '#c2410c',
  'not_contacted', '#4e6e88',
  '#64748b', // base_property default
]

/** Marker state priority: hot > new_reply > positive > negotiating > others */
export function markerStatePriority(state: MapMarkerState): number {
  const order: Record<MapMarkerState, number> = {
    hot: 100,
    new_reply: 90,
    positive: 80,
    negotiating: 70,
    needs_review: 60,
    blocked: 55,
    active_sending: 50,
    delivered: 45,
    sent: 40,
    queued: 35,
    scheduled: 30,
    buyer_comp: 25,
    sold_comp: 20,
    not_contacted: 10,
    base_property: 5,
    suppressed: 1,
  }
  return order[state] ?? 0
}
