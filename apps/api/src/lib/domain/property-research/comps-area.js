// ─── COMPS + LOCAL AREA (8.5.20-b) ───────────────────────────────────────────
// assembleCompsAndArea() — pure. Evidence ONLY, with uncertainty. Nothing here prices
// the property: the value and the MAO stay the Decision Engine's (offer-plan.js reads
// them from property_acquisition_scores). This module describes the market around it.
//
// SOURCES (existing; no paid enrichment):
//   engine comps      property_acquisition_scores.evidence.selected_comps (the engine's own
//                     sold set — the as-is anchor reads the same list)
//   sold comps        public.v_recent_sold_comps (the engine's comp pool) near the subject
//   market sales      public.mv_map_market_sales (recorded sales with investor / cash /
//                     arm's-length flags) near the subject — absorption + investor activity
//   listings          public web via the agent web tool ONLY (AGENT_WEB_RESEARCH_ENABLED);
//                     every item is evidence_kind 'listing' and carries its citation url
//   area aggregates   reivesti.geo_transaction_aggregates / buyer_demand_aggregates,
//                     public.exchange_flood_exposure_cells, housing-stock fields of
//                     public.exchange_market_fundamentals_cells, the ZIP economics cell
//
// LISTINGS ≠ SALES (binding). A listing price, a web page that reports a sale, an MLS
// list price — none of them is a sale. soldOnly() is the one gate every value statistic
// passes through; it drops any item whose evidence_kind is not 'sale'.
//
// FAIR HOUSING. Area evidence is property + market evidence only. The fundamentals
// whitelist keeps housing-stock fields (housing units, vacancy, year built, unit mix,
// gross rent); population, households, income, tenure shares and any composition field
// are never read (AREA_FUNDAMENTALS_FIELDS).
import { stripProtectedAttributes } from '../opportunity-economics/classify-opportunity.js'
import { field } from './provenance.js'

export const COMPS_AREA_VERSION = 'comps-area.v1'
export const EVIDENCE_KINDS = Object.freeze(['sale', 'listing'])
export const AREA_FUNDAMENTALS_FIELDS = Object.freeze(['housing_units', 'vacancy_rate', 'median_year_built', 'median_gross_rent', 'units_2_4_share', 'units_5plus_share', 'vintage', 'geo_level', 'geo_name'])
export const COMPS_RULES = Object.freeze({ radius_miles: 1.5, months: 12, min_sold_for_stats: 3, recent_months: 6 })

const num = (v) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const pos = (v) => { const n = num(v); return n != null && n > 0 ? n : null }
const iso = (v) => { const t = Date.parse(String(v ?? '')); return Number.isFinite(t) ? new Date(t).toISOString() : null }
const median = (xs) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (!s.length) return null
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const r0 = (n) => (n == null ? null : Math.round(n))
const r3 = (n) => (n == null ? null : Math.round(n * 1000) / 1000)

export function haversineMiles(a, b) {
  if (!a || !b || num(a.lat) == null || num(b.lat) == null || num(a.lng) == null || num(b.lng) == null) return null
  const R = 3958.8
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/** THE gate: only recorded sales feed a value statistic. */
export function soldOnly(items = []) {
  return (items || []).filter((i) => i && i.evidence_kind === 'sale' && pos(i.price) != null)
}

/**
 * A source row is a LISTING (never a sale) when it says so, or when its source / status
 * names a listing (list price, active, pending, for sale). Such rows keep their data but
 * are labelled 'listing' so soldOnly() drops them from every value statistic.
 */
const LISTING_SOURCE_RE = /(listing|list_price|for_sale|active|pending|contingent|asking)/i
export function isListingRow(r) {
  if (!r || typeof r !== 'object') return false
  if (r.evidence_kind && r.evidence_kind !== 'sale') return true
  return [r.source, r.sale_source, r.price_source, r.status, r.mls_status].some((v) => v != null && LISTING_SOURCE_RE.test(String(v)))
}
const kindOf = (r) => (isListingRow(r) ? 'listing' : 'sale')

/** Normalize an engine selected_comp into a sale evidence item. */
export function saleFromEngineComp(c) {
  return { evidence_kind: kindOf(c), origin: 'engine.selected_comps', source: String(c?.source || c?.sale_source || 'engine_comp').slice(0, 40), price: pos(c?.sale_price), date: (iso(c?.sale_date || c?.sold_date) || '').slice(0, 10) || null, distance_miles: num(c?.distance_miles), ppsf: null, units: null, ref: c?.comp_id ? String(c.comp_id).slice(0, 64) : null }
}
/** Normalize a v_recent_sold_comps row (subject-relative distance computed by the caller or here). */
export function saleFromSoldComp(r, subject = null) {
  const d = num(r?.distance_miles) ?? haversineMiles(subject, { lat: num(r?.latitude), lng: num(r?.longitude) })
  return { evidence_kind: kindOf(r), origin: 'public.v_recent_sold_comps', source: String(r?.sale_source || 'recorded').slice(0, 40), price: pos(r?.sale_price), date: (iso(r?.sale_date) || '').slice(0, 10) || null, distance_miles: d == null ? null : Math.round(d * 100) / 100, ppsf: pos(r?.computed_ppsf) ?? pos(r?.ppsf), units: pos(r?.units_count), condition: r?.building_condition ? String(r.building_condition).slice(0, 40) : null, year_built: pos(r?.year_built), ref: r?.id ? String(r.id).slice(0, 64) : null }
}
/** Normalize an mv_map_market_sales row (recorded sale; investor / cash flags). */
export function saleFromMarketSale(r, subject = null) {
  const d = num(r?.distance_miles) ?? haversineMiles(subject, { lat: num(r?.lat), lng: num(r?.lng) })
  return { evidence_kind: kindOf(r), origin: 'public.mv_map_market_sales', source: String(r?.source || 'recorded').slice(0, 40), price: r?.is_priced === false ? null : pos(r?.price), date: (iso(r?.sold_on) || '').slice(0, 10) || null, distance_miles: d == null ? null : Math.round(d * 100) / 100, ppsf: pos(r?.ppsf), units: pos(r?.units), investor: r?.is_investor === true ? true : r?.is_investor === false ? false : null, cash: r?.is_cash_purchase === true ? true : r?.is_cash_purchase === false ? false : null, arms_length: r?.is_arms_length === false ? false : r?.is_arms_length === true ? true : null, year_built: pos(r?.year_built), ref: r?.comp_id ? String(r.comp_id).slice(0, 64) : null }
}
/** A web listing (never a sale). status: active | pending | off_market | sold_reported | unknown. */
export function listingFromWeb(l) {
  const status = ['active', 'pending', 'contingent', 'off_market', 'withdrawn', 'expired', 'sold_reported'].includes(String(l?.status || '').toLowerCase()) ? String(l.status).toLowerCase() : 'unknown'
  return { evidence_kind: 'listing', origin: 'public_web', status, list_price: pos(l?.list_price ?? l?.price), days_on_market: num(l?.days_on_market), price_reductions: num(l?.price_reductions), original_list_price: pos(l?.original_list_price), url: l?.url ? String(l.url).slice(0, 300) : null, retrieved_at: iso(l?.retrieved_at), is_subject: l?.is_subject === true }
}

const monthsAgo = (d, nowMs) => (d ? (nowMs - Date.parse(d)) / (30.44 * 864e5) : null)

/**
 * @param {object} a
 * @param {{ lat:number, lng:number }|null} a.subject      subject location
 * @param {string} [a.lane]                                 economics lane (sfr | mf_2_4 | mf_5_plus | land | commercial_other)
 * @param {number|null} [a.units]                           subject units (MF same-unit filter)
 * @param {Array} [a.engine_comps]                           PAS evidence.selected_comps
 * @param {Array} [a.sold_comps]                             v_recent_sold_comps rows
 * @param {Array} [a.market_sales]                           mv_map_market_sales rows
 * @param {Array} [a.listings]                               web listing items (each with url)
 * @param {object} [a.area]                                  { geo_transactions, buyer_demand, flood, fundamentals, zip_cell, permitting_notes }
 * @param {number|string} [a.now]
 */
export function assembleCompsAndArea(input = {}) {
  const { value: a } = stripProtectedAttributes(input || {})
  const nowMs = typeof a.now === 'number' ? a.now : Date.parse(a.now || '') || Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const subject = a.subject && num(a.subject.lat) != null ? { lat: num(a.subject.lat), lng: num(a.subject.lng) } : null
  const units = pos(a.units)
  const lane = a.lane || 'unknown'
  const sameUnits = (s) => !(lane === 'mf_2_4' && units && s.units && s.units !== units)
  const inWindow = (s) => {
    const m = monthsAgo(s.date, nowMs)
    return m != null && m >= 0 && m <= COMPS_RULES.months && (s.distance_miles == null || s.distance_miles <= COMPS_RULES.radius_miles)
  }

  // ── sold evidence ──
  const engineSales = (a.engine_comps || []).map(saleFromEngineComp)
  const soldRows = (a.sold_comps || []).map((r) => saleFromSoldComp(r, subject))
  const marketRows = (a.market_sales || []).map((r) => saleFromMarketSale(r, subject))
  // the incoming arrays may carry anything: a listing slipped into a sales array is dropped here
  const sold = soldOnly([...soldRows, ...engineSales]).filter(inWindow).filter(sameUnits)
  const market = soldOnly(marketRows).filter(inWindow)
  const armsLength = market.filter((s) => s.arms_length !== false)
  const listings = (a.listings || []).map(listingFromWeb).filter((l) => l.url)
  const rejectedAsListings = [...(a.sold_comps || []), ...(a.engine_comps || []), ...(a.market_sales || [])].filter(isListingRow).length

  const prices = sold.map((s) => s.price)
  const ppsf = sold.map((s) => s.ppsf).filter(Boolean)
  const recent = sold.filter((s) => monthsAgo(s.date, nowMs) <= COMPS_RULES.recent_months).map((s) => s.price)
  const older = sold.filter((s) => monthsAgo(s.date, nowMs) > COMPS_RULES.recent_months).map((s) => s.price)
  const latestSold = sold.map((s) => s.date).filter(Boolean).sort().pop() || null
  const enough = sold.length >= COMPS_RULES.min_sold_for_stats
  const soldSrc = { source: 'public.v_recent_sold_comps+engine.selected_comps', as_of: latestSold, kind: 'derived' }

  const investors = armsLength.filter((s) => s.investor === true)
  const classified = armsLength.filter((s) => s.investor != null)
  const cash = armsLength.filter((s) => s.cash === true)
  const cashKnown = armsLength.filter((s) => s.cash != null)
  const latestMarket = market.map((s) => s.date).filter(Boolean).sort().pop() || null
  const mktSrc = { source: 'public.mv_map_market_sales', as_of: latestMarket, kind: 'derived' }
  const perMonth = market.length ? market.length / COMPS_RULES.months : null
  const investorPrices = investors.map((s) => s.price)
  const retailPrices = classified.filter((s) => s.investor === false).map((s) => s.price)
  const invMed = median(investorPrices)
  const retMed = median(retailPrices)

  const active = listings.filter((l) => !l.is_subject && ['active', 'pending', 'contingent'].includes(l.status))
  const subjectListing = listings.find((l) => l.is_subject) || null
  const lstAt = listings.map((l) => l.retrieved_at).filter(Boolean).sort().pop() || null
  const lstSrc = { source: 'web:listings', as_of: lstAt, kind: 'inferred' }
  const mos = perMonth && active.length ? active.length / perMonth : null

  // development feasibility (land / lots): finished-home sales nearby → typical lot share
  let development = null
  if (lane === 'land') {
    const finished = median(market.filter((s) => (s.units || 1) === 1).map((s) => s.price))
    development = {
      finished_home_median: field(r0(finished), { ...mktSrc, confidence: market.length >= 8 ? 0.6 : market.length >= 3 ? 0.4 : 0 }),
      new_construction_share: field(market.length >= 5 ? r3(market.filter((s) => s.year_built && s.year_built >= new Date(nowMs).getUTCFullYear() - 3).length / market.length) : null, { ...mktSrc, confidence: 0.4 }),
    }
  }

  const ar = a.area || {}
  const gt = ar.geo_transactions || null
  const bd = ar.buyer_demand || null
  const fl = ar.flood || null
  const fundRaw = ar.fundamentals || null
  const fund = fundRaw ? Object.fromEntries(Object.entries(fundRaw).filter(([k]) => AREA_FUNDAMENTALS_FIELDS.includes(k))) : null

  const comps = {
    sold_count: field(sold.length, { ...soldSrc, as_of: latestSold || nowIso, confidence: 1 }),
    sold_median_price: field(enough ? r0(median(prices)) : null, { ...soldSrc, confidence: enough ? Math.min(0.85, 0.4 + sold.length * 0.05) : 0 }),
    sold_price_range: field(enough ? [Math.min(...prices), Math.max(...prices)] : null, { ...soldSrc, confidence: enough ? 0.6 : 0 }),
    sold_median_ppsf: field(ppsf.length >= COMPS_RULES.min_sold_for_stats ? r0(median(ppsf)) : null, { ...soldSrc, confidence: 0.55 }),
    price_trend_recent_vs_prior: field(recent.length >= 3 && older.length >= 3 ? r3(median(recent) / median(older) - 1) : null, { ...soldSrc, confidence: 0.35 }),
  }
  const market_activity = {
    recorded_sales_12m: field(market.length, { ...mktSrc, as_of: latestMarket || nowIso, confidence: 1 }),
    absorption_sales_per_month: field(perMonth == null ? null : Math.round(perMonth * 100) / 100, { ...mktSrc, confidence: market.length >= 6 ? 0.6 : 0.3 }),
    investor_share: field(classified.length >= 5 ? r3(investors.length / classified.length) : null, { ...mktSrc, confidence: classified.length >= 12 ? 0.6 : 0.35 }),
    cash_share: field(cashKnown.length >= 5 ? r3(cash.length / cashKnown.length) : null, { ...mktSrc, confidence: 0.45 }),
    investor_median_price: field(investorPrices.length >= 3 ? r0(invMed) : null, { ...mktSrc, confidence: investorPrices.length >= 6 ? 0.55 : 0.35 }),
    investor_discount_vs_retail: field(investorPrices.length >= 3 && retailPrices.length >= 3 && retMed ? r3(1 - invMed / retMed) : null, { ...mktSrc, confidence: investorPrices.length >= 6 && retailPrices.length >= 6 ? 0.5 : 0.3 }),
    liquidity: field(perMonth == null ? null : perMonth >= 4 ? 'high' : perMonth >= 1.5 ? 'moderate' : 'low', { ...mktSrc, confidence: market.length >= 6 ? 0.55 : 0.3 }),
  }
  const listings_section = {
    subject_listing: field(subjectListing ? { status: subjectListing.status, list_price: subjectListing.list_price, days_on_market: subjectListing.days_on_market, price_reductions: subjectListing.price_reductions } : null, { ...lstSrc, confidence: subjectListing ? 0.45 : 0 }),
    active_or_pending_nearby: field(listings.length ? active.length : null, { ...lstSrc, confidence: 0.35 }),
    median_list_price: field(active.filter((l) => l.list_price).length >= 3 ? r0(median(active.map((l) => l.list_price).filter(Boolean))) : null, { ...lstSrc, confidence: 0.3 }),
    median_days_on_market: field(active.filter((l) => l.days_on_market != null).length >= 3 ? r0(median(active.map((l) => l.days_on_market).filter((x) => x != null))) : null, { ...lstSrc, confidence: 0.3 }),
    price_reduction_share: field(active.length >= 3 && active.some((l) => l.price_reductions != null) ? r3(active.filter((l) => (l.price_reductions || 0) > 0).length / active.length) : null, { ...lstSrc, confidence: 0.3 }),
    months_of_inventory: field(mos == null ? null : Math.round(mos * 10) / 10, { source: 'derived:web_listings/mv_map_market_sales', as_of: lstAt, kind: 'inferred', confidence: 0.25 }),
  }
  const neighborhood = {
    zip_median_price: field(pos(gt?.median_price), { source: 'reivesti.geo_transaction_aggregates', as_of: iso(gt?.as_of) || iso(gt?.window_end), kind: 'derived', confidence: num(gt?.confidence) != null ? Math.min(0.8, num(gt.confidence)) : 0.4 }),
    zip_cash_purchase_share: field(num(gt?.cash_purchase_share), { source: 'reivesti.geo_transaction_aggregates', as_of: iso(gt?.as_of) || iso(gt?.window_end), kind: 'derived', confidence: 0.45 }),
    zip_corporate_buyer_share: field(num(bd?.corporate_buyer_share), { source: 'reivesti.buyer_demand_aggregates', as_of: iso(bd?.as_of) || iso(bd?.window_end), kind: 'derived', confidence: num(bd?.confidence) != null ? Math.min(0.8, num(bd.confidence)) : 0.4 }),
    zip_repeat_buyer_share: field(num(bd?.repeat_buyer_share), { source: 'reivesti.buyer_demand_aggregates', as_of: iso(bd?.as_of) || iso(bd?.window_end), kind: 'derived', confidence: 0.4 }),
    flood_sfha_share: field(num(fl?.sfha_share), { source: 'public.exchange_flood_exposure_cells', as_of: iso(fl?.retrieved_at), kind: 'recorded', confidence: fl?.coverage_state === 'complete' ? 0.7 : 0.45 }),
    housing_stock: field(fund && Object.keys(fund).length ? fund : null, { source: 'public.exchange_market_fundamentals_cells', as_of: fund?.vintage ? `${fund.vintage}-12-31` : null, kind: 'recorded', confidence: 0.5 }),
    zip_acquisition_economics: field(ar.zip_cell || null, { source: 'public.zip_acquisition_economics', as_of: iso(ar.zip_cell?.last_update), kind: 'derived', confidence: num(ar.zip_cell?.confidence) ?? 0 }),
    permitting_notes: field(ar.permitting_notes || null, { source: 'web:permitting', as_of: iso(ar.permitting_retrieved_at), kind: 'inferred', confidence: 0.3 }),
  }

  const reasons = []
  if (!enough) reasons.push(`thin_sold_evidence:${sold.length}_within_${COMPS_RULES.radius_miles}mi_${COMPS_RULES.months}m`)
  if (!listings.length) reasons.push('no_listing_evidence_web_not_run_or_empty')
  if (classified.length < 5) reasons.push('investor_classification_thin')
  if (!subject) reasons.push('subject_location_unknown_distance_not_filtered')
  const level = !enough || !subject ? 'high' : reasons.length > 1 ? 'medium' : 'low'

  return {
    version: COMPS_AREA_VERSION,
    sections: { comps, market_activity, listings: listings_section, neighborhood, ...(development ? { development } : {}) },
    sold_items: sold.slice(0, 25),
    listing_items: listings.slice(0, 15),
    evidence_counts: { sold: sold.length, market_sales: market.length, listings: listings.length, listings_rejected_from_sales: rejectedAsListings },
    uncertainty: { level, reasons },
  }
}
