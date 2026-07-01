/**
 * Canonical map marker keys — one key per property for icon selection.
 * Maps normalizeMapAssetType() output + raw fields into stable marker keys.
 */

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
]

const UNMAPPED_TYPES = new Set()

/**
 * @param {object} row
 * @param {string} [assetType] - output of normalizeMapAssetType
 * @returns {string}
 */
export function resolveCanonicalMapMarkerKey(row, assetType) {
  const at = String(assetType ?? '').toLowerCase()
  const raw = [
    row?.property_type,
    row?.asset_type,
    row?.property_group,
    row?.deal_list_label,
    row?.deal_list_normalized,
    row?.commercial_category,
  ].map((v) => String(v ?? '').toLowerCase()).join(' ')

  switch (at) {
    case 'sfr':
    case 'condo':
    case 'townhome':
      return 'single_family'
    case 'multifamily_small':
      return 'multifamily_2_4'
    case 'multifamily_large':
    case 'mhp':
      return 'multifamily_5_plus'
    case 'shopping_plaza':
    case 'retail':
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
      return 'commercial_other'
    case 'unknown':
      break
    default:
      break
  }

  if (/duplex|triplex|quadplex|2.?4|24unit/.test(raw)) return 'multifamily_2_4'
  if (/apartment|5\+|multifamily|mf5|50\+/.test(raw)) return 'multifamily_5_plus'
  if (/strip|retail|shopping|storefront|plaza/.test(raw)) return 'retail_strip'
  if (/storage|self.?storage/.test(raw)) return 'storage'
  if (/office|medical office/.test(raw)) return 'office'
  if (/industrial|warehouse|distribution|manufacturing|flex/.test(raw)) return 'industrial'
  if (/land|vacant|lot|parcel|agricultural/.test(raw)) return 'land'
  if (/commercial|hotel|mixed/.test(raw)) return 'commercial_other'
  if (/sfr|single|residential|house|detached|townhome|condo/.test(raw)) return 'single_family'

  const rawType = String(row?.property_type ?? row?.asset_type ?? '').trim()
  if (rawType) UNMAPPED_TYPES.add(rawType)
  return 'unknown'
}

export function drainUnmappedPropertyTypes() {
  const values = [...UNMAPPED_TYPES]
  UNMAPPED_TYPES.clear()
  return values
}