// ─── NATIONWIDE ZIP ACQUISITION ECONOMICS (8.5.20-b, owner directive Phase 5) ─
// A model of CASH-ACQUISITION economics per
//   ZIP × property type × condition band × value band
// built from EXISTING recorded sales (public.mv_map_market_sales; buyer classification
// from its is_investor / buyer_kind flags) — never listings, never paid enrichment.
//
// Per cell it records: sample size (priced arm's-length sales), classified investor /
// retail counts, liquidity (sales per month), investor share, cash share, the INVESTOR
// DISCOUNT VS RETAIL (1 − median investor price-to-value ÷ median retail price-to-value,
// so the property mix cancels), its p25 / p75 band, the typical buyer exit, a confidence
// and the window / last update.
//
// HIERARCHICAL PRIORS (ZIP → county → metro → state). A thin ZIP cell is shrunk toward
// the nearest parent with evidence (empirical-Bayes weight k = PRIOR_STRENGTH), and the
// row SAYS SO: prior_level ('zip' = own evidence only | 'county' | 'metro' | 'state' |
// 'none'), prior_label ('shrunk_toward:county' | 'prior_only:metro' …), own_weight.
//
// NEVER ONE UNIVERSAL % PER ZIP: every statistic is per cell, carries a band, and a
// lookup returns mao_guidance whose precision is
//   'local'            only when the ZIP cell itself has ≥ LOCAL_MIN investor AND retail
//                      sales and confidence ≥ LOCAL_MIN_CONFIDENCE;
//   'indicative_band'  a band from a prior or a thin cell — context, never a number to offer;
//   'none'             no evidence at any level.
// No precise local MAO without evidence; the Decision Engine's MAO stays the authority.
//
// Unknown is unknown: unclassified buyers are neither investors nor retail.
export const ZIP_MODEL_VERSION = 'zip-acq-econ.v1'
export const PROPERTY_TYPES = Object.freeze(['sfr', 'mf_2_4', 'mf_5_plus', 'land_vacant_residential', 'land_development', 'commercial'])
export const CONDITION_BANDS = Object.freeze(['all', 'light', 'moderate', 'heavy', 'unknown'])
export const VALUE_BANDS = Object.freeze(['all', 'lt_100k', '100k_200k', '200k_350k', '350k_600k', '600k_plus'])
export const PRIOR_LEVELS = Object.freeze(['zip', 'county', 'metro', 'state', 'none'])
export const MAO_PRECISION = Object.freeze(['none', 'indicative_band', 'local'])
export const ZIP_MODEL_RULES = Object.freeze({
  window_months: 12,
  min_side_for_discount: 3, // investor AND retail priced-to-value samples
  prior_strength: 10, // k in (n·own + k·prior) / (n + k)
  local_min: 20,
  local_min_confidence: 0.6,
  prior_min_side: 10, // a parent level is a usable prior only with ≥ 10 investor AND ≥ 10 retail ratio samples
  ratio_min: 0.15, // price-to-value outside [0.15, 2.5] is not a usable observation
  ratio_max: 2.5,
  min_price: 10_000, // nominal / family transfers ($1, $10 deeds) are not sales
})

const num = (v) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const pos = (v) => { const n = num(v); return n != null && n > 0 ? n : null }
const r3 = (n) => (n == null ? null : Math.round(n * 1000) / 1000)
const quant = (xs, q) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b)
  if (!s.length) return null
  const p = (s.length - 1) * q
  const lo = Math.floor(p)
  const hi = Math.ceil(p)
  return s[lo] + (s[hi] - s[lo]) * (p - lo)
}
const med = (xs) => quant(xs, 0.5)

/** Property type from a recorded-sale row (type text + units). null = not modelled. */
export function propertyTypeOf(row) {
  const t = String(row?.property_type ?? '').toLowerCase()
  const units = num(row?.units)
  if (/vacant|land|lot/.test(t)) return /develop|commercial|industrial|acre/.test(t) || (pos(row?.lot_acreage) ?? 0) >= 2 ? 'land_development' : 'land_vacant_residential'
  if (/apartment/.test(t) || (/multi/.test(t) && units != null && units >= 5)) return 'mf_5_plus'
  if (/multi|duplex|triplex|fourplex|quad/.test(t)) return units != null && units >= 5 ? 'mf_5_plus' : 'mf_2_4'
  if (/single|sfr|townhouse|townhome|condo|residential/.test(t)) return 'sfr'
  if (/commercial|retail|office|industrial|warehouse|mixed/.test(t)) return 'commercial'
  return null
}
/** Value band from the recorded value (estimated_value), else the price. */
export function valueBandOf(value) {
  const v = pos(value)
  if (v == null) return null
  if (v < 100_000) return 'lt_100k'
  if (v < 200_000) return '100k_200k'
  if (v < 350_000) return '200k_350k'
  if (v < 600_000) return '350k_600k'
  return '600k_plus'
}
/** Condition band from a repair-to-value ratio or a condition label; 'unknown' when neither. */
export function conditionBandOf({ repair_to_value = null, condition = null } = {}) {
  const r = num(repair_to_value)
  if (r != null && r >= 0) return r < 0.1 ? 'light' : r < 0.25 ? 'moderate' : 'heavy'
  const c = String(condition ?? '').toLowerCase()
  if (/excellent|good|updated|renovated|turnkey/.test(c)) return 'light'
  if (/average|fair/.test(c)) return 'moderate'
  if (/poor|unsound|distress|gut|heavy/.test(c)) return 'heavy'
  return 'unknown'
}
/** Buyer side: 'investor' | 'retail' | 'unknown' (unclassified is never retail). */
export function buyerSideOf(row) {
  if (row?.is_investor === true || String(row?.buyer_kind || '').toLowerCase() === 'company') return 'investor'
  if (String(row?.buyer_kind || '').toLowerCase() === 'person' && row?.is_investor !== true) return 'retail'
  return 'unknown'
}

/** One normalized observation (null when unusable). */
export function observationOf(row, { nowMs }) {
  const price = row?.is_priced === false ? null : pos(row?.price)
  const t = Date.parse(String(row?.sold_on ?? ''))
  if (price == null || price < ZIP_MODEL_RULES.min_price || !Number.isFinite(t)) return null
  if (row?.is_arms_length === false) return null
  if (nowMs - t > ZIP_MODEL_RULES.window_months * 30.44 * 864e5 || t > nowMs) return null
  const type = propertyTypeOf(row)
  if (!type) return null
  const value = pos(row?.estimated_value)
  const ratio = value ? price / value : null
  return {
    zip: String(row?.zip || '').slice(0, 5), type, side: buyerSideOf(row), cash: row?.is_cash_purchase === true ? true : row?.is_cash_purchase === false ? false : null,
    price, ratio: ratio != null && ratio >= ZIP_MODEL_RULES.ratio_min && ratio <= ZIP_MODEL_RULES.ratio_max ? ratio : null,
    value_band: valueBandOf(value ?? price), condition_band: conditionBandOf({ repair_to_value: row?.repair_to_value, condition: row?.condition }), sold_on: new Date(t).toISOString().slice(0, 10),
    archetype: row?.buyer_archetype && row.buyer_archetype !== 'insufficient_evidence' ? String(row.buyer_archetype) : null,
  }
}

/** Raw statistics for one group of observations. */
export function cellStats(obs = []) {
  const inv = obs.filter((o) => o.side === 'investor')
  const ret = obs.filter((o) => o.side === 'retail')
  const invR = inv.map((o) => o.ratio).filter((x) => x != null)
  const retR = ret.map((o) => o.ratio).filter((x) => x != null)
  const cashKnown = obs.filter((o) => o.cash != null)
  const classified = inv.length + ret.length
  const enough = invR.length >= ZIP_MODEL_RULES.min_side_for_discount && retR.length >= ZIP_MODEL_RULES.min_side_for_discount
  const retMed = med(retR)
  const discount = enough && retMed ? 1 - med(invR) / retMed : null
  const p25 = enough && retMed ? 1 - quant(invR, 0.75) / retMed : null // a high investor ratio = a small discount
  const p75 = enough && retMed ? 1 - quant(invR, 0.25) / retMed : null
  const arche = {}
  for (const o of inv) if (o.archetype) arche[o.archetype] = (arche[o.archetype] || 0) + 1
  const topArch = Object.entries(arche).sort((a, b) => b[1] - a[1])[0]?.[0] || null
  const invShare = classified >= 5 ? inv.length / classified : null
  const cashShare = cashKnown.length >= 5 ? cashKnown.filter((o) => o.cash).length / cashKnown.length : null
  const exit = invShare == null ? 'unknown' : invShare >= 0.35 ? (topArch && /rental|holder|multifamily/.test(topArch) ? 'investor_rental_hold' : 'investor_cash_resale') : 'retail_resale'
  const n = Math.min(invR.length, retR.length)
  return {
    sample_size: obs.length, investor_n: inv.length, retail_n: ret.length, unclassified_n: obs.length - classified,
    investor_ratio_n: invR.length, retail_ratio_n: retR.length,
    sales_per_month: r3(obs.length / ZIP_MODEL_RULES.window_months),
    investor_share: r3(invShare), cash_share: r3(cashShare),
    investor_discount_vs_retail: r3(discount), discount_p25: r3(p25), discount_p75: r3(p75),
    typical_exit: exit, top_investor_archetype: topArch,
    confidence: enough ? r3(Math.min(0.9, Math.sqrt(n) / 7)) : 0,
    window_start: obs.map((o) => o.sold_on).sort()[0] || null,
    window_end: obs.map((o) => o.sold_on).sort().pop() || null,
  }
}

const key = (...p) => p.join('|')

/**
 * Build cells for every ZIP present in `rows`, with priors from county / metro / state
 * groups computed over the SAME rows (the build scope is recorded on every row).
 * @param {Array<object>} rows      recorded-sale rows (mv_map_market_sales shape + repair_to_value / condition when known)
 * @param {Record<string,{ county?:string, metro?:string, state?:string }>} geo  zip → parents
 * @param {{ now?: number|string, scope?: string }} [opts]
 */
export function buildZipCells(rows = [], geo = {}, { now = Date.now(), scope = 'unspecified' } = {}) {
  const nowMs = typeof now === 'number' ? now : Date.parse(now)
  const obs = rows.map((r) => observationOf(r, { nowMs })).filter(Boolean)
  const groups = new Map()
  const push = (k, o) => { if (!groups.has(k)) groups.set(k, []); groups.get(k).push(o) }
  for (const o of obs) {
    const g = geo[o.zip] || {}
    const levels = [['zip', o.zip], ['county', g.county], ['metro', g.metro], ['state', g.state]].filter(([, v]) => v)
    for (const [lvl, id] of levels) {
      for (const vb of ['all', o.value_band]) {
        for (const cb of ['all', o.condition_band]) push(key(lvl, id, o.type, cb, vb), o)
      }
    }
  }
  const stats = new Map([...groups.entries()].map(([k, v]) => [k, cellStats(v)]))
  const zipKeys = [...stats.keys()].filter((k) => k.startsWith('zip|'))
  const lastUpdate = new Date(nowMs).toISOString()
  const cells = []
  for (const k of zipKeys) {
    const [, zip, type, cb, vb] = k.split('|')
    const own = stats.get(k)
    const g = geo[zip] || {}
    let prior = null
    for (const [lvl, id] of [['county', g.county], ['metro', g.metro], ['state', g.state]]) {
      if (!id) continue
      // the same cell at the parent level; failing that, the parent's all-condition cell for this value band
      // a thin parent is skipped (a 3-vs-4 county is noise, not a prior): move up the hierarchy
      const usable = (s) => s && s.investor_discount_vs_retail != null && Math.min(s.investor_ratio_n, s.retail_ratio_n) >= ZIP_MODEL_RULES.prior_min_side
      const s = [stats.get(key(lvl, id, type, cb, vb)), stats.get(key(lvl, id, type, 'all', vb)), stats.get(key(lvl, id, type, 'all', 'all'))].find(usable)
      if (s) { prior = { level: lvl, id, s }; break }
    }
    cells.push(composeCell({ zip, type, cb, vb, own, prior, scope, lastUpdate }))
  }
  return { version: ZIP_MODEL_VERSION, built_at: lastUpdate, scope, observations: obs.length, cells }
}

/** One stored row: own evidence, shrinkage toward the labelled prior, MAO-guidance precision. */
export function composeCell({ zip, type, cb, vb, own, prior, scope, lastUpdate }) {
  const n = Math.min(own.investor_ratio_n, own.retail_ratio_n)
  const k = ZIP_MODEL_RULES.prior_strength
  let est = own.investor_discount_vs_retail
  let lo = own.discount_p25
  let hi = own.discount_p75
  let prior_level = 'zip'
  let prior_label = 'own_evidence_only'
  let own_weight = 1
  if (prior && own.investor_discount_vs_retail != null) {
    own_weight = n / (n + k)
    est = own_weight * own.investor_discount_vs_retail + (1 - own_weight) * prior.s.investor_discount_vs_retail
    lo = own.discount_p25 != null && prior.s.discount_p25 != null ? own_weight * own.discount_p25 + (1 - own_weight) * prior.s.discount_p25 : prior.s.discount_p25
    hi = own.discount_p75 != null && prior.s.discount_p75 != null ? own_weight * own.discount_p75 + (1 - own_weight) * prior.s.discount_p75 : prior.s.discount_p75
    prior_level = prior.level
    prior_label = `shrunk_toward:${prior.level}`
  } else if (prior) {
    own_weight = 0
    est = prior.s.investor_discount_vs_retail
    lo = prior.s.discount_p25
    hi = prior.s.discount_p75
    prior_level = prior.level
    prior_label = `prior_only:${prior.level}`
  } else if (own.investor_discount_vs_retail == null) {
    prior_level = 'none'
    prior_label = 'no_evidence_at_any_level'
    own_weight = 0
  }
  const conf = prior_level === 'zip' ? own.confidence : prior_level === 'none' ? 0 : r3(own_weight * own.confidence + (1 - own_weight) * prior.s.confidence * 0.6)
  const local = prior_level === 'zip' && own.investor_n >= ZIP_MODEL_RULES.local_min && own.retail_n >= ZIP_MODEL_RULES.local_min && own.confidence >= ZIP_MODEL_RULES.local_min_confidence
  const mao_precision = est == null ? 'none' : local ? 'local' : 'indicative_band'
  return {
    model_version: ZIP_MODEL_VERSION, zip5: zip, property_type: type, condition_band: cb, value_band: vb,
    ...own,
    investor_discount_vs_retail_own: own.investor_discount_vs_retail,
    investor_discount_vs_retail: r3(est), discount_p25: r3(lo), discount_p75: r3(hi),
    prior_level, prior_label, prior_geo: prior ? `${prior.level}:${prior.id}` : null, own_weight: r3(own_weight),
    confidence: conf, mao_precision, build_scope: scope, last_update: lastUpdate,
  }
}

/**
 * Lookup for a subject: the most specific cell available, honest about what it is.
 * Never returns a single "universal" percentage — a band + precision + labels.
 */
export function lookupZipEconomics(cells = [], { zip5, property_type, condition_band = 'all', value_band = 'all' } = {}) {
  const tries = [[condition_band, value_band], ['all', value_band], [condition_band, 'all'], ['all', 'all']]
  for (const [cb, vb] of tries) {
    const c = cells.find((x) => x.zip5 === zip5 && x.property_type === property_type && x.condition_band === cb && x.value_band === vb)
    if (!c) continue
    return {
      found: true,
      cell: { zip5, property_type, condition_band: cb, value_band: vb, matched_exactly: cb === condition_band && vb === value_band },
      investor_discount_band: c.discount_p25 != null && c.discount_p75 != null ? [c.discount_p25, c.discount_p75] : null,
      investor_discount_point: c.mao_precision === 'local' ? c.investor_discount_vs_retail : null,
      liquidity: { sales_per_month: c.sales_per_month, investor_share: c.investor_share, cash_share: c.cash_share },
      typical_exit: c.typical_exit, sample_size: c.sample_size, confidence: c.confidence,
      prior_level: c.prior_level, prior_label: c.prior_label, last_update: c.last_update,
      mao_guidance: { precision: c.mao_precision, note: c.mao_precision === 'local' ? 'local evidence: context for the engine, not an offer' : c.mao_precision === 'indicative_band' ? 'indicative band only — no precise local MAO from this evidence' : 'no evidence' },
    }
  }
  return { found: false, mao_guidance: { precision: 'none', note: 'no cell for this ZIP × type' } }
}
