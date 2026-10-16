// Zoning text → density hints (8.5.20-b). Shared by the property dossier and the
// negotiation judgment. A HINT from the recorded zoning string + lot area only — never
// an entitlement determination (that needs the jurisdiction's code; the judgment says so).
export const LAND_DENSITY_RE = /\b(r-?[2-9]|rm|r-?m|mf|multi|pud|planned|c-?\d|commercial|mixed|mu-?\d?|townhome|duplex|high density|medium density)\b/i
export const LAND_SINGLE_RE = /\b(r-?1|rs-?\d*|sf-?\d*|r1|single[- ]family|rural residential|ag|a-?1|agricultur)\b/i

const pos = (v) => { const n = Number(v); return v != null && v !== '' && typeof v !== 'boolean' && Number.isFinite(n) && n > 0 ? n : null }

/** 'single_family' | 'density_permitting' | 'unclassified' | 'unknown' */
export function zoningClass(zoning) {
  const z = String(zoning ?? '').trim()
  if (!z) return 'unknown'
  if (LAND_DENSITY_RE.test(z)) return 'density_permitting'
  if (LAND_SINGLE_RE.test(z)) return 'single_family'
  return 'unclassified'
}

/**
 * Potential units — INFERRED from zoning text + lot size only.
 * @returns {{ value: { min:number|null, max:number|null, basis:string }|null, confidence:number, zoning_class:string }}
 */
export function inferPotentialUnits({ zoning = null, lot_sqft = null, units = null } = {}) {
  const zc = zoningClass(zoning)
  const lot = pos(lot_sqft)
  if (zc === 'single_family') return { value: { min: 1, max: Math.max(1, pos(units) || 1), basis: 'zoning_text_single_family' }, confidence: 0.45, zoning_class: zc }
  if (zc === 'density_permitting') {
    // a coarse band only: ~1 unit per 2,500-5,000 sf of lot where the zone permits density
    const max = lot ? Math.max(2, Math.floor(lot / 2500)) : null
    const min = lot ? Math.max(1, Math.floor(lot / 5000)) : null
    return { value: { min, max, basis: 'zoning_text_density_permitting_lot_area_band' }, confidence: lot ? 0.3 : 0.2, zoning_class: zc }
  }
  return { value: null, confidence: 0, zoning_class: zc }
}
