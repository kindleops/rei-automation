// ─── ZIP PRIOR FOR OFFER PLANS (8.5.21-b, owner directive Phase 7 / item 3) ───
// When the Decision Engine's evidence is thin (no engine row, not offer-ready, few comps),
// the offer plan carries a LABELLED market prior from the ZIP acquisition-economics model
// (zip-model.js): ZIP × property type × condition band × value band, falling back
// county → metro → state when the subject's ZIP has no cell.
//
// What it is: CONTEXT for an operator — "investors here pay about 8-17 % under retail for
// this kind of property" — with its level, sample, confidence and as-of date.
// What it is NOT: an offer, a MAO, or a universal per-ZIP percentage. Rules:
//   • precision is 'local' ONLY when the subject ZIP's own cell is local (zip-model rules);
//     every fallback is 'indicative_band' — never a point;
//   • an indicative investor PRICE band is produced only from a sourced value reference
//     (the engine's valuation_mid, else the recorded AVM, labelled) — never invented;
//   • no level with evidence ⇒ { available: false } (unknown is unknown, not 0 %).
import { lookupZipEconomics, valueBandOf, conditionBandOf } from './zip-model.js'

export const ZIP_PRIOR_VERSION = 'zip-prior.v1'
export const ZIP_PRIOR_LEVELS = Object.freeze(['zip', 'county', 'metro', 'state'])

const num = (v) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const pos = (v) => { const n = num(v); return n != null && n > 0 ? n : null }
const r3 = (n) => (n == null ? null : Math.round(n * 1000) / 1000)
const r0 = (n) => (n == null ? null : Math.round(n))

/** Offer-plan lane → zip-model property type. */
export function zipTypeOfLane(lane, property = {}) {
  if (lane === 'sfr') return 'sfr'
  if (lane === 'mf_2_4') return 'mf_2_4'
  if (lane === 'mf_5_plus') return 'mf_5_plus'
  if (lane === 'land') return property?.is_development_land === true || (pos(property?.lot_acreage) ?? 0) >= 2 ? 'land_development' : 'land_vacant_residential'
  if (lane === 'commercial_other') return 'commercial'
  return null
}

/** Sample-weighted pool of parent-level cells (same type / bands) — a fallback, labelled as such. */
function poolCells(cells) {
  const usable = cells.filter((c) => c.discount_p25 != null && c.discount_p75 != null && num(c.sample_size) > 0)
  if (!usable.length) return null
  const w = usable.reduce((s, c) => s + num(c.sample_size), 0)
  const avg = (k) => r3(usable.reduce((s, c) => s + num(c[k]) * num(c.sample_size), 0) / w)
  return {
    discount_p25: avg('discount_p25'),
    discount_p75: avg('discount_p75'),
    sample_size: w,
    cells: usable.length,
    confidence: r3(Math.min(...usable.map((c) => num(c.confidence) ?? 0)) * 0.6),
    last_update: usable.map((c) => c.last_update).filter(Boolean).sort().pop() || null,
  }
}

/**
 * @param {object} a
 * @param {Array} a.cells               zip-model cells (public.zip_acquisition_economics rows or a memory build)
 * @param {string|null} a.zip5
 * @param {string|null} a.property_type zip-model type (zipTypeOfLane)
 * @param {string} [a.condition_band]
 * @param {string} [a.value_band]
 * @param {Record<string,{county?:string,metro?:string,state?:string}>} [a.geo]  zip5 → parents (for every cell zip + the subject)
 */
export function resolveZipPrior({ cells = [], zip5 = null, property_type = null, condition_band = 'all', value_band = 'all', geo = {} } = {}) {
  if (!property_type) return { version: ZIP_PRIOR_VERSION, available: false, reason: 'property_type_not_modelled' }
  if (zip5) {
    const own = lookupZipEconomics(cells, { zip5, property_type, condition_band, value_band })
    if (own.found && own.investor_discount_band) {
      return {
        version: ZIP_PRIOR_VERSION, available: true, level: 'zip',
        label: own.prior_label === 'own_evidence_only' ? 'zip:own_evidence' : `zip:${own.prior_label}`,
        cell: own.cell, investor_discount_band: own.investor_discount_band, investor_discount_point: own.investor_discount_point,
        precision: own.mao_guidance.precision, sample_size: own.sample_size, confidence: own.confidence, last_update: own.last_update,
        liquidity: own.liquidity, typical_exit: own.typical_exit, source: 'public.zip_acquisition_economics',
      }
    }
  }
  const parents = (zip5 && geo[zip5]) || {}
  for (const level of ['county', 'metro', 'state']) {
    const id = parents[level]
    if (!id) continue
    const members = cells.filter((c) => c.property_type === property_type && (geo[c.zip5] || {})[level] === id)
    const tries = [[condition_band, value_band], ['all', value_band], [condition_band, 'all'], ['all', 'all']]
    for (const [cb, vb] of tries) {
      const pool = poolCells(members.filter((c) => c.condition_band === cb && c.value_band === vb))
      if (!pool) continue
      return {
        version: ZIP_PRIOR_VERSION, available: true, level, label: `fallback:${level}`,
        cell: { zip5, property_type, condition_band: cb, value_band: vb, matched_exactly: cb === condition_band && vb === value_band, parent: `${level}:${id}` },
        investor_discount_band: [pool.discount_p25, pool.discount_p75], investor_discount_point: null, precision: 'indicative_band',
        sample_size: pool.sample_size, pooled_cells: pool.cells, confidence: pool.confidence, last_update: pool.last_update, source: 'public.zip_acquisition_economics (pooled)',
      }
    }
  }
  return { version: ZIP_PRIOR_VERSION, available: false, reason: zip5 ? 'no_cell_at_zip_county_metro_state' : 'zip_unknown' }
}

/**
 * The plan-facing prior: the band applied to a SOURCED value reference. Never an offer.
 * @param {object} prior   resolveZipPrior()
 * @param {{ value:number, source:string, as_of?:string|null }|null} reference
 */
export function indicativeInvestorBand(prior, reference) {
  if (!prior?.available || !prior.investor_discount_band) return null
  const v = pos(reference?.value)
  if (!v) return { price_band: null, reason: 'no_sourced_value_reference' }
  const [lo, hi] = prior.investor_discount_band
  return {
    // a larger discount ⇒ a lower investor price
    price_band: [r0(v * (1 - Math.max(lo, hi))), r0(v * (1 - Math.min(lo, hi)))],
    value_reference: { value: r0(v), source: reference.source, as_of: reference.as_of ?? null },
    role: 'indicative_context_not_an_offer',
  }
}

/** Bands for a subject from the property record (value band from a sourced value, condition from recorded repairs). */
export function subjectBands({ value = null, repairs = null, condition = null } = {}) {
  const v = pos(value)
  return { value_band: valueBandOf(v) || 'all', condition_band: conditionBandOf({ repair_to_value: v && num(repairs) != null ? num(repairs) / v : null, condition }) }
}
