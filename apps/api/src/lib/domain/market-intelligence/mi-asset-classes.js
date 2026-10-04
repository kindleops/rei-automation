/**
 * MARKET INTELLIGENCE: one normalized asset-class model (brief §18, §46).
 *
 * The authority is lib/acquisition/assetTaxonomy.js, the same resolver the
 * offer engine and Comps use. "Duplex", "2-family", "2–4" and "small MF" mean
 * the same thing everywhere because this module never classifies a raw string
 * itself: it asks resolveAssetClass() and only maps the canonical class to the
 * coarser buckets an operator filters a market by.
 *
 * One adaptation, documented in the audit: the taxonomy files a GENERIC
 * "Multi-Family" label with NO unit count as 5+. For market statistics that is
 * a guess (19,962 corpus rows carry the label, 7,835 have no unit count). So
 * such rows form their own bucket, mf_unknown. It is counted in Multifamily
 * coverage and never folded into 2–4 or 5+. Unit count still governs whenever
 * it is present (unit_count_governs_residential_lane).
 *
 * Price per unit (brief §49) needs price > 0 AND a valid positive unit count.
 * Implausible unit counts are excluded: under 350 sq ft per unit, the same
 * floor as the comp engine's unitCountCredible.
 */
import { ASSET_CLASS, classifyAssetToken, resolveAssetClass } from '@/lib/acquisition/assetTaxonomy.js'

/** Bucket codes stored per sale (Uint8). Order is the wire order. */
export const MI_ASSETS = Object.freeze(['unknown', 'sfr', 'mf_2_4', 'mf_5_plus', 'mf_unknown', 'land', 'commercial', 'other_res'])
export const ASSET_CODE = Object.freeze(Object.fromEntries(MI_ASSETS.map((a, i) => [a, i])))

/** Operator filters (brief §18). `available` is decided from the loaded corpus, never assumed. */
export const ASSET_FILTERS = Object.freeze([
  { id: 'all', label: 'All', members: null },
  { id: 'sfr', label: 'SFR', members: ['sfr'] },
  { id: 'mf_2_4', label: '2–4 units', members: ['mf_2_4'] },
  { id: 'mf_5_plus', label: '5+ units', members: ['mf_5_plus'] },
  { id: 'mf', label: 'All multifamily', members: ['mf_2_4', 'mf_5_plus', 'mf_unknown'] },
  { id: 'land', label: 'Land', members: ['land'] },
  { id: 'commercial', label: 'Commercial', members: ['commercial'] },
])

export const ASSET_LABEL = Object.freeze({
  unknown: 'Type not recorded', sfr: 'Single family', mf_2_4: '2–4 units', mf_5_plus: '5+ units',
  mf_unknown: 'Multifamily, no usable unit count', land: 'Land', commercial: 'Commercial', other_res: 'Condo / townhouse / mobile',
})

export const MF_BUCKETS = Object.freeze(['mf_2_4', 'mf_5_plus', 'mf_unknown'])
export const MIN_SQFT_PER_UNIT = 350

const GENERIC_MULTI = /multi[\s_-]*(family|unit)|\bmulti\b/gi

/** True when a raw label resolves to 5+ ONLY because it says "multi". */
export function isGenericMultiLabel(raw) {
  const v = String(raw ?? '')
  if (!v) return false
  if (classifyAssetToken(v).class !== ASSET_CLASS.MULTIFAMILY_5_PLUS) return false
  return classifyAssetToken(v.replace(GENERIC_MULTI, ' ')).class !== ASSET_CLASS.MULTIFAMILY_5_PLUS
}

const fromCanonical = (cls) => {
  switch (cls) {
    case ASSET_CLASS.SINGLE_FAMILY: return 'sfr'
    case ASSET_CLASS.RESIDENTIAL_2_TO_4: return 'mf_2_4'
    case ASSET_CLASS.MULTIFAMILY_5_PLUS: return 'mf_5_plus'
    case ASSET_CLASS.CONDOMINIUM: case ASSET_CLASS.TOWNHOUSE: case ASSET_CLASS.MOBILE_HOME: return 'other_res'
    case ASSET_CLASS.LAND: return 'land'
    case ASSET_CLASS.COMMERCIAL: case ASSET_CLASS.STORAGE: return 'commercial'
    default: return 'unknown'
  }
}

/** Pure: one sale's raw type + units → MI bucket (via the canonical resolver). */
export function miAssetOf(rawType, units) {
  const u = units === null || units === undefined || units === '' ? null : Number(units)
  const resolved = resolveAssetClass({ property_type: rawType ?? null, units_count: Number.isFinite(u) ? u : null })
  // A known unit count > 1 already decided 2–4 vs 5+ (resolveAssetClass); only a
  // generic label WITHOUT a usable unit count is unknown.
  const unitsDecide = u !== null && Number.isFinite(u) && u > 1
  if (resolved.class === ASSET_CLASS.MULTIFAMILY_5_PLUS && !unitsDecide && isGenericMultiLabel(rawType)) {
    return 'mf_unknown'
  }
  return fromCanonical(resolved.class)
}

/** Memoised classifier for a load: the corpus has a handful of raw types × unit counts. */
export function createAssetClassifier() {
  const memo = new Map()
  return (rawType, units) => {
    const key = `${rawType ?? ''}|${units ?? ''}`
    let code = memo.get(key)
    if (code === undefined) { code = ASSET_CODE[miAssetOf(rawType, units)]; memo.set(key, code) }
    return code
  }
}

/** Set of bucket codes a filter id admits; null = every sale. Unknown filter id → null with ok:false. */
export function assetFilterCodes(filterId) {
  const f = ASSET_FILTERS.find((x) => x.id === (filterId || 'all'))
  if (!f) return { ok: false, codes: null }
  return { ok: true, id: f.id, label: f.label, codes: f.members ? new Set(f.members.map((m) => ASSET_CODE[m])) : null }
}

/** Price-per-unit evidence rule (brief §49). */
export function isPricePerUnitEvidence({ price, units, sqft, assetCode }) {
  if (!(price > 0)) return false
  if (!(units > 0) || !Number.isFinite(units)) return false
  if (assetCode !== ASSET_CODE.mf_2_4 && assetCode !== ASSET_CODE.mf_5_plus) return false
  if (sqft !== null && sqft !== undefined && Number.isFinite(sqft) && sqft > 0 && sqft / units < MIN_SQFT_PER_UNIT) return false
  return true
}
