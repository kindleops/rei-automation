/**
 * Normalizes a property row from public.properties into a canonical map asset type.
 * Used for icon selection, cluster coloring, and layer filtering on the map.
 *
 * Inspection order: commercial/special types first (most specific), then residential.
 */

export const MAP_ASSET_TYPES = [
  'sfr', 'condo', 'townhome',
  'multifamily_small', 'multifamily_large',
  'storage', 'shopping_plaza', 'retail',
  'office', 'industrial', 'warehouse',
  'mixed_use', 'hotel', 'mhp', 'land',
  'commercial', 'unknown',
]

/**
 * @param {object} p - row from public.properties
 * @returns {string} MapAssetType
 */
export function normalizeMapAssetType(p) {
  const lower = (s) => (s ?? '').toString().toLowerCase().replace(/[\s\-_\/]/g, '')

  const fields = [
    p.deal_list_label, p.deal_list_type, p.deal_list_normalized,
    p.commercial_category, p.commercial_subcategory,
    p.asset_subclass, p.normalized_asset_subclass,
    p.asset_class, p.normalized_asset_class,
    p.asset_type, p.property_group, p.property_subtype,
    p.source_list_label, p.source_list_type,
    p.list_label, p.list_type,
    p.property_use, p.land_use, p.building_class, p.property_type,
  ].map(lower)

  const match = (...patterns) =>
    patterns.some((pat) => fields.some((f) => f && f.includes(pat)))

  // ── Commercial special types (most specific first) ──────────────────────
  if (match('selfstorage', 'selfstor', 'storageunit', 'storagepark') || lower(p.deal_list_normalized ?? '').includes('storage')) return 'storage'
  if (Number(p.storage_units) > 0) return 'storage'

  if (
    match('stripcenter', 'stripmall', 'shoppingcenter', 'retailcenter', 'shopplaza', 'outletcenter') ||
    (match('plaza') && !match('officeplaza')) ||
    match('shoppingstrip')
  ) return 'shopping_plaza'
  if (Number(p.strip_center_units) > 0) return 'shopping_plaza'

  if (match('hotel', 'motel', 'hospitality', 'lodging', 'resort', 'inn', 'hostel')) return 'hotel'

  if (
    match('mobilehomepark', 'manufacturedhousing', 'manufacturedhomecommunity', 'mobilepark') ||
    fields.some((f) => f === 'mhp')
  ) return 'mhp'

  if (match('mixeduse', 'mixuse', 'mixed-use')) return 'mixed_use'

  if (
    match('officebuild', 'officepark', 'officecampus', 'medicaloffice', 'professionaloffice', 'officespace') ||
    (match('office') && !match('homeoffice'))
  ) return 'office'

  if (match('warehouse', 'warehousing')) return 'warehouse'
  if (match('industrial', 'manufacturing', 'flexindustrial', 'flexspace', 'distribution', 'logistics', 'rdspace')) return 'industrial'

  if (match('retail', 'retailbuilding', 'retailspace')) return 'retail'

  if (match('vacantland', 'emptylo', 'undevelopedland', 'rawland', 'unimprovedland')) return 'land'
  if (match('land', 'lot', 'parcel') && !match('landlord')) return 'land'

  // Commercial catch-all
  if (Number(p.commercial_units) > 0) return 'commercial'
  if (match('commercial')) return 'commercial'

  // ── Residential classification ───────────────────────────────────────────
  const units = Math.max(
    Number(p.units_count) || 0,
    Number(p.multifamily_units) || 0,
  )
  const pt = lower(p.property_type ?? '')

  if (units >= 5) return 'multifamily_large'
  if (units >= 2 && units <= 4) return 'multifamily_small'

  if (pt.includes('apartment') || pt.includes('apart')) {
    return units >= 5 || units === 0 ? 'multifamily_large' : 'multifamily_small'
  }
  if (pt.includes('multifam') || pt.includes('multi-fam') || pt.includes('multifamily')) {
    return units >= 5 || units === 0 ? 'multifamily_large' : 'multifamily_small'
  }
  if (pt.includes('duplex') || pt.includes('triplex') || pt.includes('fourplex') || pt.includes('4plex') || pt.includes('24unit') || pt.includes('2to4')) return 'multifamily_small'
  if (pt.includes('condo') || pt.includes('condominium')) return 'condo'
  if (pt.includes('townhome') || pt.includes('townhouse') || pt.includes('town home')) return 'townhome'
  if (pt.includes('sfr') || pt.includes('singlefam') || pt.includes('single-fam') || pt.includes('single family') || pt.includes('singlefamily')) return 'sfr'
  if (pt.includes('mobile') || pt.includes('manufactured') || pt.includes('modular')) return 'sfr'
  if (pt.includes('residential') || pt.includes('house') || pt.includes('detached')) return 'sfr'

  return 'unknown'
}
