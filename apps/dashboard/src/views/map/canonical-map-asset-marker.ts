/**
 * Canonical map marker keys — single source of truth for asset-type icons.
 * Every property resolves to exactly one marker_key for sprite selection.
 */

import { PIN_ICON } from './pin-icons'

export const CANONICAL_MAP_MARKER_KEYS = [
  'single_family',
  'multifamily_2_4',
  'multifamily_5_plus',
  'retail_strip',
  'storage',
  'office',
  'industrial',
  'land',
  'commercial_other',
  'unknown',
] as const

export type CanonicalMapMarkerKey = typeof CANONICAL_MAP_MARKER_KEYS[number]

const lower = (v: unknown) => String(v ?? '').trim().toLowerCase()

export const resolveCanonicalMapMarkerKey = (input: {
  assetType?: string | null
  propertyType?: string | null
  property_type?: string | null
  marker_key?: string | null
}): CanonicalMapMarkerKey => {
  const preset = lower(input.marker_key).replace(/[\s-]+/g, '_')
  if ((CANONICAL_MAP_MARKER_KEYS as readonly string[]).includes(preset)) {
    return preset as CanonicalMapMarkerKey
  }

  const at = lower(input.assetType)
  const raw = [
    input.propertyType,
    input.property_type,
    input.assetType,
  ].map(lower).join(' ')

  switch (at) {
    case 'sfr':
    case 'condo':
    case 'townhome':
    case 'single_family':
      return 'single_family'
    case 'multifamily_small':
    case 'multifamily_2_4':
      return 'multifamily_2_4'
    case 'multifamily_large':
    case 'multifamily_5_plus':
    case 'mhp':
      return 'multifamily_5_plus'
    case 'shopping_plaza':
    case 'retail':
    case 'retail_strip':
      return 'retail_strip'
    case 'storage':
      return 'storage'
    case 'office':
      return 'office'
    case 'industrial':
    case 'warehouse':
      return 'industrial'
    case 'land':
      return 'land'
    case 'hotel':
    case 'mixed_use':
    case 'commercial':
    case 'commercial_other':
      return 'commercial_other'
    default:
      break
  }

  if (/duplex|triplex|quadplex|2.?4|24unit|mf24/.test(raw)) return 'multifamily_2_4'
  if (/apartment|5\+|multifamily.?5|mf5|50\+|tower/.test(raw)) return 'multifamily_5_plus'
  if (/strip|retail|shopping|storefront|plaza/.test(raw)) return 'retail_strip'
  if (/storage|self.?storage/.test(raw)) return 'storage'
  if (/office|medical office/.test(raw)) return 'office'
  if (/industrial|warehouse|distribution|manufacturing|flex/.test(raw)) return 'industrial'
  if (/land|vacant|lot|parcel|agricultural/.test(raw)) return 'land'
  if (/commercial|hotel|mixed/.test(raw)) return 'commercial_other'
  if (/sfr|single|residential|house|detached|townhome|condo/.test(raw)) return 'single_family'

  return 'unknown'
}

export const MARKER_KEY_TO_PIN_ICON: Record<CanonicalMapMarkerKey, string> = {
  single_family: PIN_ICON.sfr,
  multifamily_2_4: PIN_ICON.multi,
  multifamily_5_plus: PIN_ICON.apt,
  retail_strip: PIN_ICON.retail,
  storage: PIN_ICON.storage,
  office: PIN_ICON.office,
  industrial: PIN_ICON.industrial,
  land: PIN_ICON.land,
  commercial_other: PIN_ICON.comm,
  unknown: PIN_ICON.default,
}

export const MARKER_KEY_ICON_COLORS: Record<CanonicalMapMarkerKey, string> = {
  single_family: '#66B8FF',
  multifamily_2_4: '#8D82FF',
  multifamily_5_plus: '#D46CFF',
  retail_strip: '#FFB84D',
  storage: '#38D2B3',
  office: '#64D8FF',
  industrial: '#FF795B',
  land: '#7EDB63',
  commercial_other: '#C2CAD7',
  unknown: '#9AA6B8',
}

export const buildMarkerKeyIconImageExpr = (): unknown[] => [
  'match', ['coalesce', ['get', 'marker_key'], ['get', 'asset_family'], 'unknown'],
  'single_family', PIN_ICON.sfr,
  'multifamily_2_4', PIN_ICON.multi,
  'multifamily_5_plus', PIN_ICON.apt,
  'retail_strip', PIN_ICON.retail,
  'storage', PIN_ICON.storage,
  'office', PIN_ICON.office,
  'industrial', PIN_ICON.industrial,
  'land', PIN_ICON.land,
  'commercial_other', PIN_ICON.comm,
  'sfr', PIN_ICON.sfr,
  'mf24', PIN_ICON.multi,
  'mf5plus', PIN_ICON.apt,
  'retail', PIN_ICON.retail,
  'commercial', PIN_ICON.comm,
  PIN_ICON.default,
]

export const buildMarkerKeyIconColorExpr = (): unknown[] => [
  'match', ['coalesce', ['get', 'marker_key'], ['get', 'asset_family'], 'unknown'],
  'single_family', MARKER_KEY_ICON_COLORS.single_family,
  'multifamily_2_4', MARKER_KEY_ICON_COLORS.multifamily_2_4,
  'multifamily_5_plus', MARKER_KEY_ICON_COLORS.multifamily_5_plus,
  'retail_strip', MARKER_KEY_ICON_COLORS.retail_strip,
  'storage', MARKER_KEY_ICON_COLORS.storage,
  'office', MARKER_KEY_ICON_COLORS.office,
  'industrial', MARKER_KEY_ICON_COLORS.industrial,
  'land', MARKER_KEY_ICON_COLORS.land,
  'commercial_other', MARKER_KEY_ICON_COLORS.commercial_other,
  'sfr', MARKER_KEY_ICON_COLORS.single_family,
  'mf24', MARKER_KEY_ICON_COLORS.multifamily_2_4,
  'mf5plus', MARKER_KEY_ICON_COLORS.multifamily_5_plus,
  'retail', MARKER_KEY_ICON_COLORS.retail_strip,
  'commercial', MARKER_KEY_ICON_COLORS.commercial_other,
  MARKER_KEY_ICON_COLORS.unknown,
]