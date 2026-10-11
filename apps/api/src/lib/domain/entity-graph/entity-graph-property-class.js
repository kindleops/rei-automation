/**
 * ENTITY GRAPH · THE CANONICAL PROPERTY TYPE (owner P0, 2026-10-10: "not just
 * 'Other' but storage, mixed use, office, etc." and the junk facet values
 * "SFR", "Town", "Multifamily 5+" with one property each).
 *
 * ONE classification, a pure function of the vendor evidence already in the
 * database — it derives, it never overwrites a vendor column, and it never
 * invents: no evidence → null ("Not classified"), never a guess.
 *
 * TAXONOMY (group → type)
 *   Residential     Single Family · Townhouse · Condo · Mobile/Manufactured ·
 *                   Duplex · Triplex · Fourplex · Multifamily 5+ ·
 *                   Multifamily (units unknown)
 *   Land            Land
 *   Commercial      Retail/Strip Center · Office · Industrial/Warehouse ·
 *                   Self Storage · Mixed Use · Hotel/Motel · Mobile Home Park ·
 *                   Other Commercial
 *   Special purpose Government/Exempt · Agricultural
 *
 * "Multifamily (units unknown)" exists because the vendor's generic uses
 * ("Multi-Family Dwellings (Generic, 2+)", "Apartments (generic)") say 2+ units
 * without saying how many: when the unit count is missing or not credible the
 * honest answer is "multifamily, count unknown", not Duplex and not 5+.
 *
 * PRECEDENCE (first that applies; `basis` names it, `confidence` grades it)
 *   1. property_use — DealMachine's standardized land use, observed per
 *      property (seller.property_use_observation, 96% of the universe). A use
 *      that NAMES the type (Duplex, Self-Storage, Hotel…) is high confidence;
 *      medium when the recorded unit count contradicts it; low when the
 *      property carries conflicting observations.
 *   2. a generic multifamily use / vendor type + the unit count, when the
 *      count is CREDIBLE (the acquisition engine's unitCountCredible rule:
 *      more than one unit needs ≥ 350 sq ft per unit when the floor area is
 *      known) → Duplex / Triplex / Fourplex / Multifamily 5+ (medium);
 *      otherwise Multifamily (units unknown) (low).
 *   3. the vendor's own asset classifier / deal list / type tokens
 *      (asset_subclass, acquisition_bucket, property flags "Storage Units",
 *      "Strip Malls", "Apartment Building 5+ Units") (medium).
 *   4. the vendor property_type, normalized (case, "SFR", "Multi-family")
 *      (medium), with property_class for "Other" (Commercial → Other
 *      Commercial, Exempt → Government/Exempt) (low).
 * Vendor raw values stay available, unchanged, as "Property type (vendor raw)"
 * (properties.property_type) and "Property use (vendor)" (the observation).
 */

const clean = (v) => String(v ?? '').trim()
const lower = (v) => clean(v).toLowerCase()
const num = (v) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export const PROPERTY_TYPE_TAXONOMY = Object.freeze({
  Residential: Object.freeze(['Single Family', 'Townhouse', 'Condo', 'Mobile/Manufactured', 'Duplex', 'Triplex', 'Fourplex', 'Multifamily 5+', 'Multifamily (units unknown)']),
  Land: Object.freeze(['Land']),
  Commercial: Object.freeze(['Retail/Strip Center', 'Office', 'Industrial/Warehouse', 'Self Storage', 'Mixed Use', 'Hotel/Motel', 'Mobile Home Park', 'Other Commercial']),
  'Special purpose': Object.freeze(['Government/Exempt', 'Agricultural']),
})
export const PROPERTY_TYPE_GROUP_OF = Object.freeze(Object.fromEntries(
  Object.entries(PROPERTY_TYPE_TAXONOMY).flatMap(([group, types]) => types.map((t) => [t, group])),
))
export const PROPERTY_TYPES = Object.freeze(Object.keys(PROPERTY_TYPE_GROUP_OF))

/** The acquisition engine's floor-area rule (acquisitionDecisionEngine.unitCountCredible). */
export const MIN_CREDIBLE_SQFT_PER_UNIT = 350

/**
 * Is the recorded unit count usable? More than one unit is credible only when
 * the floor area (if recorded) can hold it.
 * @returns {number|null} the credible count (≥ 1), or null
 */
export function credibleUnits(units, sqft) {
  const u = num(units)
  if (u === null || u < 1) return null
  const whole = Math.round(u)
  if (whole <= 1) return 1
  const s = num(sqft)
  if (s !== null && s > 0 && s / whole < MIN_CREDIBLE_SQFT_PER_UNIT) return null
  return whole
}

const MF_BY_UNITS = (units) => (units === 2 ? 'Duplex' : units === 3 ? 'Triplex' : units === 4 ? 'Fourplex' : units >= 5 ? 'Multifamily 5+' : null)

/**
 * The vendor's standardized property use → canonical type.
 * `named` = the use states the type itself (high confidence);
 * `generic` = multifamily of unstated size (resolved by the unit count);
 * `skip` = says nothing about the type (fall through to the next source).
 */
const USE_RULES = [
  // residential — named
  [/^single family residential \(assumed\)$/, 'Single Family', 'assumed'],
  [/^residential \(general\) \(single\)$/, 'Single Family', 'assumed'],
  [/^(single family residential|bungalow)/, 'Single Family', 'named'],
  [/^rural\/agricultural residence/, 'Single Family', 'assumed'],
  [/^townhouse/, 'Townhouse', 'named'],
  [/^condominium|^condo\b|residential condominium/, 'Condo', 'named'],
  [/^planned unit development/, 'Single Family', 'assumed'],
  [/^mobile\/manufactured home/, 'Mobile/Manufactured', 'named'],
  [/^(mobile home park|manufactured home park|trailer park)/, 'Mobile Home Park', 'named'],
  [/^duplex/, 'Duplex', 'named'],
  [/^triplex/, 'Triplex', 'named'],
  [/^(quadruplex|fourplex|quadplex)/, 'Fourplex', 'named'],
  [/^(apartment house \(5\+ units\)|highrise apartments|garden apartment|apartment complex)/, 'Multifamily 5+', 'named'],
  // land (before the generic multifamily rule: "Multi-Family-Vacant Land" is land)
  [/vacant land|^farm land|^agricultural \/ rural$|^(residential|commercial|industrial|recreational|multi-family)-vacant/, 'Land', 'named'],
  [/^(multi-family dwellings \(generic|apartments \(generic\)|residential income \(general\)|multi-family|multifamily)/, null, 'generic'],
  // commercial — named
  [/mixed use/, 'Mixed Use', 'named'],
  [/mini-warehouse|self-storage|self storage/, 'Self Storage', 'named'],
  [/shopping center|strip center|retail|department store|restaurant|store\b|stores\b/, 'Retail/Strip Center', 'named'],
  [/^office|office building|professional building|medical office/, 'Office', 'named'],
  [/warehouse|industrial|manufacturing/, 'Industrial/Warehouse', 'named'],
  [/^(hotel|motel)/, 'Hotel/Motel', 'named'],
  [/boarding house|rooming house|convalescent|nursing home|car wash|parking lot|commercial building|^commercial \(general\)$/, 'Other Commercial', 'named'],
  // special purpose
  [/^exempt|governmental|county owned|^public use/, 'Government/Exempt', 'named'],
  [/agricultur/, 'Agricultural', 'named'],
  // says nothing about the type
  [/use not specified|^miscellaneous|misc residential improvement/, null, 'skip'],
]

export function classifyPropertyUse(use) {
  const u = lower(use)
  if (!u) return null
  for (const [re, type, how] of USE_RULES) if (re.test(u)) return { type, how }
  return { type: null, how: 'unmapped' }
}

/** properties.property_type (vendor raw) → canonical, case/abbreviation-normalized. */
export function normalizeVendorPropertyType(value) {
  const v = lower(value).replace(/[\s_]+/g, ' ')
  if (!v) return null
  if (/^(single family|sfr|sfh|single family residential|residential)$/.test(v)) return { type: 'Single Family' }
  if (/^town ?(house|home)s?$|^town$/.test(v)) return { type: 'Townhouse' }
  if (/^condo(minium)?s?$/.test(v)) return { type: 'Condo' }
  if (/^(mobile|manufactured)( home)?s?$/.test(v)) return { type: 'Mobile/Manufactured' }
  if (/^(vacant )?land$|^lot$/.test(v)) return { type: 'Land' }
  if (/^multi ?-?family 5\+|^apartment building 5\+/.test(v)) return { type: 'Multifamily 5+' }
  if (/^(multi ?-?family|apartments?)$/.test(v)) return { type: null, generic: true }
  if (/^duplex$/.test(v)) return { type: 'Duplex' }
  if (/^triplex$/.test(v)) return { type: 'Triplex' }
  if (/^(fourplex|quadplex|quadruplex)$/.test(v)) return { type: 'Fourplex' }
  if (/^other$/.test(v)) return { type: null, other: true }
  return { type: null, unmapped: true }
}

/** The vendor's own asset classifier / deal-list / type tokens (DealMachine sheet cohort). */
function vendorAssetEvidence(row) {
  const sub = lower(row.asset_subclass)
  if (/storage/.test(sub)) return 'Self Storage'
  if (/strip|retail/.test(sub)) return 'Retail/Strip Center'
  if (/mixed/.test(sub)) return 'Mixed Use'
  if (/mobile home park/.test(sub)) return 'Mobile Home Park'
  const bucket = clean(row.acquisition_bucket).toUpperCase()
  if (bucket === 'STORAGE_FACILITIES') return 'Self Storage'
  if (bucket === 'STRIP_CENTERS') return 'Retail/Strip Center'
  if (bucket === 'MOBILE_HOME_PARKS') return 'Mobile Home Park'
  if (bucket === 'MIXED_USE') return 'Mixed Use'
  const flags = lower(row.property_flags_text)
  if (/(^|;\s*)storage units(\s*;|$)/.test(flags)) return 'Self Storage'
  if (/(^|;\s*)strip malls(\s*;|$)/.test(flags)) return 'Retail/Strip Center'
  return null
}

/**
 * @param {object} row  properties columns (property_type, property_class, units_count,
 *                      building_square_feet, asset_subclass, acquisition_bucket, property_flags_text)
 * @param {{ uses?: string[] }} evidence  the property's property_use observations
 * @returns {{ type: string|null, group: string|null, confidence: 'high'|'medium'|'low'|null, basis: string|null }}
 */
export function classifyPropertyType(row = {}, { uses = [] } = {}) {
  const out = (type, confidence, basis) => ({ type, group: type ? PROPERTY_TYPE_GROUP_OF[type] : null, confidence: type ? confidence : null, basis: type ? basis : null })
  const units = credibleUnits(row.units_count, row.building_square_feet)
  const rawUnits = num(row.units_count)
  const distinctUses = [...new Set((uses || []).map(clean).filter(Boolean))]
  const conflicting = distinctUses.length > 1

  // 1 + 2: the observed property use
  let genericMulti = false
  const useHits = distinctUses.map(classifyPropertyUse).filter(Boolean)
  const namedTypes = [...new Set(useHits.filter((h) => h.type).map((h) => h.type))]
  if (namedTypes.length === 1) {
    const hit = useHits.find((h) => h.type === namedTypes[0])
    const type = namedTypes[0]
    const group = PROPERTY_TYPE_GROUP_OF[type]
    // a named single-unit use with a credible multi-unit count (or a named 2–4 use whose count disagrees) is still the named type, graded down
    const singleNamed = ['Single Family', 'Townhouse', 'Condo', 'Mobile/Manufactured'].includes(type)
    const countDisagrees = group === 'Residential' && (
      (singleNamed && units !== null && units > 1)
      || (['Duplex', 'Triplex', 'Fourplex', 'Multifamily 5+'].includes(type) && rawUnits !== null && rawUnits >= 1 && MF_BY_UNITS(units ?? 0) !== type)
    )
    const confidence = conflicting ? 'low' : hit.how === 'assumed' || countDisagrees ? 'medium' : 'high'
    return out(type, confidence, conflicting ? 'property_use_conflict' : 'property_use')
  }
  if (namedTypes.length > 1) {
    // two observations name different types — not resolvable without inventing
    return out(null, null, null)
  }
  if (useHits.some((h) => h.how === 'generic')) genericMulti = true

  // 3: the vendor's own classifier / deal list / type tokens
  const vendorAsset = vendorAssetEvidence(row)
  if (vendorAsset) return out(vendorAsset, 'medium', 'vendor_asset_class')

  // 4: the vendor property type, normalized
  const vendor = normalizeVendorPropertyType(row.property_type)
  if (genericMulti || vendor?.generic || /apartment building 5\+ units/i.test(clean(row.property_flags_text))) {
    const byUnits = units !== null && units >= 2 ? MF_BY_UNITS(units) : null
    if (byUnits) return out(byUnits, 'medium', genericMulti ? 'property_use_units' : 'vendor_type_units')
    if (/apartment building 5\+ units/i.test(clean(row.property_flags_text))) return out('Multifamily 5+', 'medium', 'vendor_flag')
    return out('Multifamily (units unknown)', 'low', genericMulti ? 'property_use' : 'vendor_type')
  }
  if (vendor?.type) return out(vendor.type, distinctUses.length ? 'low' : 'medium', 'vendor_type')
  if (vendor?.other) {
    const cls = lower(row.property_class)
    if (cls === 'commercial' || cls === 'industrial') return out(cls === 'industrial' ? 'Industrial/Warehouse' : 'Other Commercial', 'low', 'vendor_class')
    if (cls === 'exempt') return out('Government/Exempt', 'low', 'vendor_class')
    if (/^agric/.test(cls)) return out('Agricultural', 'low', 'vendor_class')
    if (cls === 'vacant') return out('Land', 'low', 'vendor_class')
  }
  return out(null, null, null)
}
