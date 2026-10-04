/**
 * COMPS INTELLIGENCE — the valuation-evidence workspace for one subject.
 *
 * Read-only. This is an EVIDENCE surface; it never becomes a second pricing
 * authority:
 *
 *   SYSTEM SET   the comps the acquisition engine actually priced from, read
 *                from the stored decision (property_acquisition_scores
 *                evidence.selected_comps). Canonical; never rewritten here.
 *   CANDIDATES   every sale in the operator's radius/window, judged by the
 *                engine's OWN scoreComparable() — the same eligibility rules,
 *                feature breakdown, adjusted price and weight it prices with.
 *   EXCLUDED     candidates the engine rejects (its reason codes), plus
 *                recorded transactions that are not market sales (nominal
 *                price, non-arm's-length, foreclosure/transfer deeds).
 *
 * Two corpora, one scale:
 *   engine_pool          get_comp_candidates_for_subject (bounded, spatial)
 *   transaction_corpus   comps_market_evidence over comp_private canonical
 *                        transactions (bounded, spatial; privacy-safe buyers)
 * A recorded transaction that duplicates a pool sale is folded into it (its
 * arm's-length / cash / deed / buyer facts enrich the pool row).
 *
 * Every read is bounded (≤100 pool + ≤250 corpus rows) and spatially
 * indexed, so the shape holds when the national corpus grows by ~500K.
 *
 * ENGINE FIDELITY (2026-10-01). An engine-pool candidate is scored from the
 * same row the engine builds in loadComparableProperties — the RPC row
 * overlaid with the engine's detail columns — not from a display row. Scored
 * that way at the engine's computed_at, all 12 stored system comps of two
 * live subjects (SFR + 4-unit) reproduce their stored score, completeness,
 * weight and adjusted price exactly. The display row had been scoring
 * candidates at ~half the engine's data completeness and as non-MLS sales.
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import {
  detectPackageClusters,
  loadSubjectProperty,
  normalizePropertyFeatures,
  scoreComparable,
} from '@/lib/acquisition/acquisitionDecisionEngine.js'
import { buyerFromPurchaseInfo } from '../deal-intelligence/deal-record-sections.js'
import { canonicalFlag, canonicalPropertyIds } from './canonical-property-ids.js'
import { REASON_LABELS } from './comps-reason-labels.js'
import { displayableCompanyName } from '../entity-graph/buyer-name-privacy.js'
import { ENGINE_COMP_DETAIL_COLUMNS, engineRulesFor, engineSearchWindow } from './comps-engine-rules.js'
import { BUYER_MATCH_SALES_SOURCE, loadBuyerMatchSales } from '../buyer-match/buyer-match-sales.js'

const DAY = 86_400_000
const clean = (v) => String(v ?? '').trim()
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const pos = (v) => { const n = num(v); return n !== null && n > 0 ? n : null }
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
const arr = (v) => (Array.isArray(v) ? v : [])
const round = (v, d = 0) => (num(v) === null ? null : Math.round(Number(v) * 10 ** d) / 10 ** d)
const median = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const m = Math.floor(v.length / 2)
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}

export const RADIUS_OPTIONS = [0.5, 1, 2, 3, 5, 10]
export const MONTH_OPTIONS = [6, 12, 18, 24, 36]

export { REASON_LABELS }

const FAMILY_LABEL = { residential: 'Single family', multifamily: 'Multifamily', commercial: 'Commercial', land: 'Land', condo: 'Condo', single_family: 'Single family', apartment: 'Apartments 5+', mobile_home: 'Mobile home' }

/** Engine asset family → comp_market_cells asset_family. */
function cellFamily(subject) {
  const f = clean(subject.asset_family).toLowerCase()
  const units = num(subject.units) ?? 1
  if (f === 'multifamily') return units >= 5 ? 'apartments_5plus' : 'small_multifamily_2_4'
  if (f === 'land') return 'land'
  if (f === 'commercial') return 'commercial_other'
  return 'sfr'
}

/** Engine asset family → transaction-corpus family. */
function corpusFamily(subject) {
  const f = clean(subject.asset_family).toLowerCase()
  const units = num(subject.units) ?? 1
  if (f === 'multifamily') return units >= 5 ? 'apartment' : 'multifamily'
  if (f === 'land') return 'land'
  if (f === 'commercial') return 'commercial'
  return 'single_family'
}

/** The dimensions that make a comp comparable, per asset class. */
export function dimensionsFor(family) {
  const f = clean(family).toLowerCase()
  if (f === 'multifamily' || f === 'apartment') return ['units', 'sqft', 'year_built', 'distance', 'recency', 'asset']
  if (f === 'land') return ['lot_sqft', 'distance', 'recency', 'asset']
  if (f === 'commercial') return ['sqft', 'year_built', 'distance', 'recency', 'asset']
  return ['sqft', 'beds', 'baths', 'year_built', 'lot_sqft', 'distance', 'recency', 'asset']
}

/**
 * Observable subject-vs-comp facts. No composite score — the delta is the
 * evidence ("+4% larger", "14 years older").
 */
export function compareToSubject(subject, comp) {
  const pct = (a, b) => (pos(a) && pos(b) ? Math.round(((b - a) / a) * 100) : null)
  return {
    sqftPct: pct(subject.sqft, comp.sqft),
    beds: num(subject.beds) !== null && num(comp.beds) !== null ? num(comp.beds) - num(subject.beds) : null,
    baths: num(subject.baths) !== null && num(comp.baths) !== null ? round(num(comp.baths) - num(subject.baths), 1) : null,
    years: pos(subject.yearBuilt) && pos(comp.yearBuilt) ? comp.yearBuilt - subject.yearBuilt : null,
    lotPct: pct(subject.lotSqft, comp.lotSqft),
    units: pos(subject.units) && pos(comp.units) ? comp.units - subject.units : null,
    days: comp.saleDate ? Math.max(0, Math.round((Date.now() - Date.parse(comp.saleDate)) / DAY)) : null,
  }
}

// Same rule as the engine's unitCountCredible: a comp record that names a
// single-unit asset only counts as a building when its floor area can hold
// the unit count it carries.
const SINGLE_UNIT_RE = /single|\bsfr\b|\bsfh\b|town\s*(house|home)|condo/i
function compIsMulti(comp) {
  if (/multi|apartment|duplex|triplex|quad|plex/i.test(clean(comp.propertyType))) return true
  const units = num(comp.units) ?? 1
  if (units < 2) return false
  if (!SINGLE_UNIT_RE.test(clean(comp.propertyType))) return true
  return (num(comp.sqft) ?? 0) / units >= 350
}

function assetMatches(subject, comp) {
  const multi = (t, u) => /multi|apartment|duplex|triplex|quad|plex/i.test(clean(t)) || (num(u) ?? 1) >= 2
  const sMulti = multi(subject.propertyType, subject.units)
  const cMulti = compIsMulti(comp)
  if (cMulti === false && (num(comp.units) ?? 1) >= 2 && sMulti) return false
  if (sMulti !== cMulti) return false
  if (!sMulti) return true
  const ratio = Math.max(1, num(comp.units) ?? 1) / Math.max(1, num(subject.units) ?? 1)
  return ratio >= 0.35 && ratio <= 2.75
}

const DIM_FEATURES = ['asset_type', 'units', 'sqft', 'beds', 'baths', 'year_built', 'lot_sqft', 'distance_miles', 'condition', 'zip', 'subdivision', 'zoning', 'garage', 'pool', 'stories']

/**
 * Compact engine verdict — enough to answer "why is / isn't this a comp" and
 * to replay the engine's valuation formula over an operator's set.
 *
 * The replay inputs (score, completeness, weight, adjustedPrice, saleSource)
 * keep the precision the engine itself carries (2 dp / 4 dp / $100), because
 * calculateValuation averages them — a rounded copy cannot reproduce it.
 */
function engineVerdict(scored, origin = 'live', extra = {}) {
  if (!scored) return null
  if (!scored.eligible) return { origin, eligible: false, reasons: arr(scored.reasons) }
  const dims = []
  const cats = []
  for (const [name, cat] of Object.entries(obj(scored.feature_match_breakdown ?? scored.match_breakdown))) {
    cats.push({ c: name, w: num(cat.weight), s: num(cat.score), n: num(cat.compared_features), m: num(cat.missing_features) })
    for (const f of arr(cat.features)) {
      if (DIM_FEATURES.includes(f.feature) && f.status !== 'missing') {
        dims.push({ f: f.feature, s: f.subject ?? null, c: f.comp, st: f.status })
      }
    }
  }
  return {
    origin,
    eligible: true,
    reasons: [],
    score: round(scored.comp_score, 2),
    confidence: round(scored.comp_confidence, 2),
    completeness: round(scored.data_completeness, 2),
    recency: num(scored.recency_score ?? extra.recency),
    weight: round(scored.weight, 4),
    adjustedPrice: pos(scored.adjusted_price),
    saleSource: clean(scored.comp?.sale_source ?? scored.sale_source) || null,
    adjustments: arr(scored.price_adjustments).map((a) => ({ basis: a.basis, weight: num(a.weight), value: num(a.indicated_value), amount: num(a.amount) })),
    dims,
    cats,
  }
}

/** Only the columns the engine selects — a wider row would not be the engine's input. */
function engineDetail(detail) {
  const out = {}
  for (const k of ENGINE_COMP_DETAIL_COLUMNS) if (detail && k in detail) out[k] = detail[k]
  return out
}

/**
 * The row the engine scores for an engine-pool comp, built exactly as
 * loadComparableProperties builds it: RPC row, overlaid with the engine's
 * detail columns, then the RPC's id / address / distance and the pool source.
 */
export function enginePoolInput(rpcRow, detail) {
  const r = obj(rpcRow)
  return {
    ...r,
    ...engineDetail(detail),
    id: r.comp_id ?? detail?.id ?? null,
    address: r.address ?? detail?.property_address_full ?? null,
    distance_miles: r.distance_miles ?? null,
    source: 'v_recent_sold_comps',
  }
}

/** The stored decision's own description of how it valued the subject. */
export function engineRunFrom(score) {
  if (!score) return null
  const calc = obj(score.calc)
  const outlier = obj(score.outl)
  const eng = obj(score.eng)
  const components = obj(calc.components)
  return {
    engine: clean(eng.name) || 'acquisition_decision_engine',
    version: clean(eng.version) || null,
    computedAt: score.computed_at ?? eng.computed_at ?? null,
    method: clean(calc.method) || null,
    formula: clean(calc.formula) || null,
    selectedCount: num(calc.selected_comp_count),
    totalWeight: num(calc.total_weight),
    dispersion: num(calc.dispersion_ratio),
    sourceTypes: arr(calc.source_types).map(clean).filter(Boolean),
    sourceValue: pos(calc.source_value),
    components: {
      depth: num(components.depth_score),
      compScore: num(components.average_comp_score),
      completeness: num(components.average_data_completeness),
      consistency: num(components.consistency_score),
      sourceDiversity: num(components.source_diversity_score),
    },
    pool: {
      status: clean(score.cds_status) || null,
      rawCandidates: num(score.cds_raw),
      eligibleCandidates: num(score.cds_elig),
      rejectionBreakdown: Object.fromEntries(Object.entries(obj(score.cds_rej)).map(([k, v]) => [k, num(v)])),
    },
    outlier: outlier.method ? {
      method: clean(outlier.method),
      median: num(outlier.median),
      mad: num(outlier.mad),
      allowedDeviation: num(outlier.allowed_deviation),
    } : null,
  }
}

function saleLabel(src) {
  const s = clean(src).toLowerCase()
  if (s.includes('mls')) return 'MLS sold'
  if (s.includes('public')) return 'Public record'
  if (s.includes('transaction')) return 'Recorded deed'
  return src || null
}

function shapePoolRow(row, detail, subjectView) {
  const d = { ...detail, ...row }
  const buyer = buyerFromPurchaseInfo(detail?.purchase_info)
  const comp = {
    key: `p:${clean(row.comp_id)}`,
    corpus: 'engine_pool',
    compId: clean(row.comp_id) || null,
    propertyId: clean(d.property_id) || null,
    address: clean(d.address || d.property_address_full) || null,
    city: clean(d.city || d.property_address_city) || null,
    zip: clean(d.zip || d.property_address_zip) || null,
    lat: num(d.latitude),
    lng: num(d.longitude),
    salePrice: pos(d.sale_price),
    saleDate: clean(d.sale_date) || null,
    distanceMiles: num(row.distance_miles),
    propertyType: clean(d.property_type) || null,
    units: pos(d.units_count),
    beds: num(d.beds ?? d.total_bedrooms),
    baths: num(d.baths ?? d.total_baths),
    sqft: pos(d.sqft ?? d.building_square_feet),
    lotSqft: pos(d.lot_square_feet),
    yearBuilt: pos(d.year_built),
    condition: clean(d.building_condition) || null,
    renovation: clean(detail?.renovation_level_classification) || null,
    ppsf: round(d.ppsf ?? d.computed_ppsf, 0),
    ppu: round(d.ppu, 0),
    source: saleLabel(detail?.sale_source ?? (pos(d.mls_sold_price) ? 'MLS Sold' : 'Public Record Sold')),
    // the record's own sale_source, only when the sold-comp detail row was read (never inferred)
    saleSourceRaw: clean(detail?.sale_source) || null,
    mls: pos(d.mls_sold_price) !== null,
    buyerKind: buyer.kind === 'company' ? 'company' : buyer.kind === 'individual' ? 'person' : null,
    buyerCompany: buyer.kind === 'company' ? displayableCompanyName(buyer.label) : null,
    buyerId: null,
    buyerAcquisitions: null,
    buyerActivity: null,
    buyerArchetype: null,
    sellerKind: null,
    armsLength: null,
    cash: null,
    docType: null,
    photo: /^https:\/\//.test(clean(d.streetview_image)) ? clean(d.streetview_image) : null,
    features: {
      subdivision: clean(d.subdivision_name) || null,
      zoning: clean(d.zoning) || null,
      quality: clean(d.building_quality) || null,
      garage: clean(d.garage) || null,
      pool: clean(d.pool) || null,
      stories: pos(d.stories),
      county: clean(d.property_address_county_name) || null,
    },
  }
  comp.assetMatch = assetMatches(subjectView, comp)
  return comp
}

function shapeCorpusRow(r, subjectView) {
  const buyerKind = clean(r.buyer_kind) || null
  const comp = {
    key: `t:${r.txn_id}`,
    corpus: 'transaction_corpus',
    compId: null,
    txnId: r.txn_id,
    propertyId: clean(r.property_id) || null,
    address: clean(r.address) || null,
    city: clean(r.city) || null,
    zip: clean(r.zip) || null,
    lat: num(r.lat),
    lng: num(r.lng),
    salePrice: pos(r.price),
    saleDate: clean(r.event_date) || null,
    distanceMiles: num(r.distance_miles),
    propertyType: clean(r.property_type) || null,
    units: pos(r.units),
    beds: num(r.beds),
    baths: num(r.baths),
    sqft: pos(r.sqft),
    lotSqft: pos(r.lot_sqft),
    yearBuilt: pos(r.year_built),
    condition: null,
    renovation: null,
    ppsf: round(r.ppsf, 0),
    ppu: round(r.ppu, 0),
    source: 'Recorded deed',
    mls: false,
    buyerKind: buyerKind === 'company' ? 'company' : buyerKind === 'person' ? 'person' : null,
    buyerCompany: displayableCompanyName(r.buyer_company),
    buyerId: clean(r.buyer_id) || null,
    buyerAcquisitions: num(r.buyer_acquisitions),
    buyerActivity: clean(r.buyer_activity) || null,
    buyerArchetype: clean(r.buyer_archetype) || null,
    sellerKind: clean(r.seller_kind) || null,
    armsLength: r.is_arms_length === true ? true : r.is_arms_length === false ? false : null,
    cash: r.is_cash_purchase === true ? true : r.is_cash_purchase === false ? false : null,
    docType: clean(r.doc_type) || null,
    nominal: r.nominal_price === true,
    distressDeed: r.distress_or_transfer_deed === true,
    photo: null,
    features: null,
  }
  comp.assetMatch = assetMatches(subjectView, comp)
  return comp
}

/** Engine-shaped row for scoreComparable. */
function engineRow(c, extra = {}) {
  return {
    id: c.compId || c.key,
    property_id: c.propertyId,
    property_address_full: c.address,
    property_address_zip: c.zip,
    latitude: c.lat,
    longitude: c.lng,
    sale_price: c.salePrice,
    sale_date: c.saleDate,
    property_type: c.propertyType,
    units_count: c.units,
    total_bedrooms: c.beds,
    total_baths: c.baths,
    building_square_feet: c.sqft,
    lot_square_feet: c.lotSqft,
    year_built: c.yearBuilt,
    building_condition: c.condition,
    distance_miles: c.distanceMiles,
    ...extra,
  }
}

/** Measured evidence sufficiency — counts, not a confidence label. */
export function evidenceSufficiency(comps) {
  const usable = comps.filter((c) => c.state !== 'excluded')
  const close = usable.filter((c) => (c.distanceMiles ?? 99) <= 1 && c.assetMatch)
  const recentClose = close.filter((c) => c.saleDate && Date.now() - Date.parse(c.saleDate) <= 365 * DAY)
  const level = recentClose.length >= 6 ? 'strong' : recentClose.length >= 3 ? 'moderate' : recentClose.length >= 1 ? 'limited' : 'thin'
  return { level, usable: usable.length, withinMile: close.length, withinMileLastYear: recentClose.length }
}

/** Server-side stats for a set — the UI recomputes the same for an operator set. */
export function setStats(comps) {
  const prices = comps.map((c) => c.salePrice).filter((v) => v > 0)
  const ppsf = comps.map((c) => c.ppsf).filter((v) => v > 0)
  const ppu = comps.map((c) => c.ppu).filter((v) => v > 0)
  const adj = comps.map((c) => c.engine?.adjustedPrice).filter((v) => v > 0)
  const dist = comps.map((c) => c.distanceMiles).filter((v) => v !== null)
  const age = comps.map((c) => (c.saleDate ? (Date.now() - Date.parse(c.saleDate)) / DAY : null)).filter((v) => v !== null)
  return {
    count: comps.length,
    medianPrice: median(prices),
    low: prices.length ? Math.min(...prices) : null,
    high: prices.length ? Math.max(...prices) : null,
    medianPpsf: round(median(ppsf), 0),
    medianPpu: round(median(ppu), 0),
    medianAdjusted: round(median(adj), -2),
    medianDistance: round(median(dist), 2),
    medianAgeDays: round(median(age), 0),
  }
}

export { canonicalPropertyIds }

/*
 * RECENT MARKET SALES (display only, 2026-10-04). The engine pool
 * (get_comp_candidates_for_subject -> v_recent_sold_comps) is a frozen import
 * whose newest sale is 2026-05-08; it stays the VALUATION source until an
 * owner-approved shadow comparison says otherwise. What the operator browses
 * as "recent sales near this property" reads the canonical sales projection
 * instead (public.mv_map_market_sales, refreshed daily) through the Buyer
 * Match sales adapter, with its price rule: price > 0 is a priced sale;
 * zero / NULL is transaction activity only (no price, no $/sf). Never scored,
 * never priced, never folded into the comp set.
 */
export const RECENT_SALES_LIMIT = 40
const RECENT_SALES_READ = 120

const latestDate = (dates) => dates.filter(Boolean).map(String).sort().pop() ?? null

/** Pure: one adapter sale -> the workspace's recent-sale row. */
export function shapeRecentSale(s) {
  return {
    key: `m:${clean(s.comp_id)}`,
    propertyId: clean(s.property_id) || null,
    address: clean(s.address) || null,
    city: clean(s.city) || null,
    state: clean(s.state) || null,
    zip: clean(s.zip) || null,
    lat: num(s.lat),
    lng: num(s.lng),
    soldOn: clean(s.sold_on) || null,
    price: s.is_priced ? pos(s.price) : null,
    priced: s.is_priced === true && pos(s.price) !== null,
    ppsf: s.is_priced ? pos(s.ppsf) : null,
    saleSource: s.sale_source === 'mls' ? 'mls' : 'public_record',
    docType: clean(s.doc_type) || null,
    armsLength: s.is_arms_length === true ? true : s.is_arms_length === false ? false : null,
    cash: s.is_cash_purchase === true ? true : s.is_cash_purchase === false ? false : null,
    buyerCompany: s.buyer || null,
    buyerClass: clean(s.buyer_class) || null,
    investor: s.is_investor === true,
    portfolioSize: num(s.portfolio_size),
    propertyType: clean(s.property_type) || null,
    beds: num(s.beds),
    baths: num(s.baths),
    sqft: pos(s.sqft),
    yearBuilt: pos(s.year_built),
    units: pos(s.units),
    distanceMiles: num(s.distance_miles),
  }
}

/** Pure: adapter result -> the workspace's recentSales block, newest first. */
export function recentSalesBlock(result, { radiusMiles, months, limit = RECENT_SALES_LIMIT } = {}) {
  if (!result) return { available: false, source: BUYER_MATCH_SALES_SOURCE, reason: 'no_subject_coordinates', rows: [] }
  if (result.error) return { available: false, source: BUYER_MATCH_SALES_SOURCE, reason: 'read_failed', rows: [] }
  const all = arr(result.sales).map(shapeRecentSale)
  all.sort((a, b) => String(b.soldOn ?? '').localeCompare(String(a.soldOn ?? '')) || (a.distanceMiles ?? 99) - (b.distanceMiles ?? 99))
  const rows = all.slice(0, limit)
  return {
    available: true,
    source: BUYER_MATCH_SALES_SOURCE,
    radiusMiles: num(result.meta?.radius_miles) ?? radiusMiles ?? null,
    months: months ?? null,
    latestSale: latestDate(all.map((r) => r.soldOn)),
    read: all.length,
    priced: rows.filter((r) => r.priced).length,
    activityOnly: rows.filter((r) => !r.priced).length,
    rows,
  }
}

/**
 * Pure: how fresh each corpus on this surface is — the newest sale each one
 * actually carried into this payload, so the UI can say "engine pool, as of".
 */
export function freshnessOf(comps, recent, engineRun) {
  const of = (corpus) => latestDate(arr(comps).filter((c) => c.corpus === corpus).map((c) => c.saleDate))
  return {
    valuationPool: { source: 'v_recent_sold_comps', latestSale: of('engine_pool'), engineRunAt: engineRun?.computedAt ?? null },
    transactions: { source: 'comp_private.mv_comp_market_evidence', latestSale: of('transaction_corpus') },
    recentSales: { source: BUYER_MATCH_SALES_SOURCE, latestSale: recent?.available ? recent.latestSale : null },
  }
}

export async function getCompsWorkspace({ propertyId, radius = null, months = null } = {}, deps = {}) {
  const client = deps.supabase || defaultSupabase
  const now = new Date(deps.now ?? Date.now())
  const pid = clean(propertyId)
  if (!pid) return null

  const raw = await loadSubjectProperty(pid, { supabase: client })
  if (!raw) return null
  const subject = normalizePropertyFeatures(raw, { source: 'properties', now })
  // No explicit window → open on the engine's own window for this asset
  // family, so the review universe is the universe the engine priced from.
  const engineWindow = engineSearchWindow(subject.asset_family)
  const radiusMiles = Math.min(10, Math.max(0.25, num(radius) ?? engineWindow.radiusMiles))
  const monthsBack = Math.min(60, Math.max(3, Math.round(num(months) ?? engineWindow.months)))
  const subjectView = {
    propertyId: pid,
    address: clean(raw.property_address_full) || null,
    city: clean(raw.property_address_city) || null,
    state: clean(raw.property_address_state) || null,
    zip: clean(raw.property_address_zip) || null,
    lat: num(subject.latitude ?? raw.latitude),
    lng: num(subject.longitude ?? raw.longitude),
    propertyType: clean(raw.property_type) || null,
    family: clean(subject.asset_family) || null,
    familyLabel: FAMILY_LABEL[clean(subject.asset_family)] || clean(raw.property_type) || null,
    units: pos(raw.units_count),
    beds: num(raw.total_bedrooms),
    baths: num(raw.total_baths),
    sqft: pos(raw.building_square_feet),
    lotSqft: pos(raw.lot_square_feet),
    yearBuilt: pos(raw.year_built),
    condition: clean(raw.building_condition) || null,
    estimatedValue: pos(raw.estimated_value),
    mlsStatus: clean(raw.mls_market_status) || null,
    mlsListPrice: pos(raw.mls_current_listing_price),
    // record facts (property record, not LeadCommand computations)
    county: clean(raw.property_address_county_name) || null,
    market: clean(raw.market) || null,
    subdivision: clean(raw.subdivision_name) || null,
    zoning: clean(raw.zoning) || null,
    quality: clean(raw.building_quality) || null,
    garage: clean(raw.garage) || null,
    pool: clean(raw.pool) || null,
    stories: pos(raw.stories),
    assessedValue: pos(raw.assd_total_value),
    recordStatus: clean(raw.market_status_label) || null,
    lastSale: pos(raw.sale_price) && clean(raw.sale_date) ? { date: clean(raw.sale_date), price: pos(raw.sale_price) } : null,
  }

  const hasGeo = subjectView.lat !== null && subjectView.lng !== null
  const [scoreRes, poolRes, corpusRes, cellRes, oppRes, salesRes] = await Promise.all([
    client.from('property_acquisition_scores')
      .select([
        'valuation_low, valuation_mid, valuation_high, valuation_confidence, recommended_cash_offer, minimum_acceptable_offer, decision_tier, computed_at',
        'sel:evidence->selected_comps, rej:evidence->rejected_comps',
        'calc:evidence->valuation_calculation_summary, outl:evidence->outlier_method, eng:evidence->engine',
        'cds_status:evidence->comp_data_status->status, cds_raw:evidence->comp_data_status->raw_candidate_count',
        'cds_elig:evidence->comp_data_status->eligible_candidate_count, cds_rej:evidence->comp_data_status->rejection_breakdown',
      ].join(', '))
      .eq('property_id', pid).order('computed_at', { ascending: false }).limit(1),
    client.rpc('get_comp_candidates_for_subject', { p_subject_property_id: pid, p_radius_miles: radiusMiles, p_months_back: monthsBack, p_limit: 100 }),
    hasGeo
      ? client.rpc('comps_market_evidence', { p_lat: subjectView.lat, p_lng: subjectView.lng, p_radius_miles: radiusMiles, p_months: monthsBack, p_family: corpusFamily(subject), p_limit: 250 })
      : Promise.resolve({ data: null }),
    subjectView.zip ? client.rpc('comps_market_cell', { p_zip: subjectView.zip, p_asset_family: cellFamily(subject), p_window_days: 365 }) : Promise.resolve({ data: null }),
    client.from('acquisition_opportunities').select('id, acquisition_stage, asking_price, metadata').eq('primary_property_id', pid).order('updated_at', { ascending: false }).limit(1),
    // display only — a failed read never fails the workspace
    hasGeo
      ? Promise.resolve()
        .then(() => (deps.loadSales || loadBuyerMatchSales)({ lat: subjectView.lat, lng: subjectView.lng, radius_miles: radiusMiles, months: monthsBack, priced: 'all', limit: RECENT_SALES_READ }, { db: client, now }))
        .catch((error) => ({ error }))
      : Promise.resolve(null),
  ])
  if (poolRes.error) throw poolRes.error

  const score = arr(scoreRes.data)[0] || null
  const engineRun = engineRunFrom(score)
  const computedAt = engineRun?.computedAt ? new Date(engineRun.computedAt) : null
  const systemStored = arr(score?.sel)
  const rejectedStored = new Map(arr(score?.rej).map((r) => [clean(r.comp_id || r.id), arr(r.reasons)]))
  const systemIds = new Set(systemStored.map((c) => clean(c.comp_id || c.id)).filter(Boolean))
  const storedById = new Map(systemStored.map((c) => [clean(c.comp_id || c.id), c]))
  const pool = arr(poolRes.data)
  const detailIds = [...new Set([...pool.map((r) => clean(r.comp_id)), ...systemIds])].filter(Boolean)
  const detailRes = detailIds.length ? await client.from('v_recent_sold_comps').select('*').in('id', detailIds) : { data: [] }
  const details = new Map(arr(detailRes.data).map((d) => [clean(d.id), d]))

  // Engine pool rows (live) + any stored system comp outside the current
  // window; each keeps the exact row the engine would score.
  const engineInputs = new Map()
  const poolComps = pool.map((r) => {
    const d = details.get(clean(r.comp_id))
    const c = shapePoolRow(r, d, subjectView)
    engineInputs.set(c.key, enginePoolInput(r, d))
    return c
  })
  const inPool = new Set(poolComps.map((c) => c.compId))
  for (const s of systemStored) {
    const id = clean(s.comp_id || s.id)
    if (!id || inPool.has(id)) continue
    const d = details.get(id) || {}
    const c = shapePoolRow({ comp_id: id, distance_miles: s.distance_miles, sale_price: s.sale_price, sale_date: s.sale_date, address: s.address, property_id: s.property_id, latitude: d.latitude, longitude: d.longitude }, d, subjectView)
    c.outsideSearch = true
    if (details.has(id)) engineInputs.set(c.key, enginePoolInput({ comp_id: id, address: s.address, distance_miles: s.distance_miles }, d))
    poolComps.push(c)
  }

  // Recorded transactions: fold duplicates of pool sales into the pool row.
  const corpus = obj(corpusRes.data)
  const corpusComps = []
  for (const r of arr(corpus.rows)) {
    const c = shapeCorpusRow(r, subjectView)
    const twin = poolComps.find((p) => p.propertyId && p.propertyId === c.propertyId && p.saleDate && c.saleDate && Math.abs(Date.parse(p.saleDate) - Date.parse(c.saleDate)) <= 31 * DAY)
    if (twin) {
      Object.assign(twin, {
        armsLength: c.armsLength, cash: c.cash, docType: c.docType, sellerKind: c.sellerKind,
        buyerKind: twin.buyerKind ?? c.buyerKind, buyerCompany: twin.buyerCompany ?? c.buyerCompany,
        buyerId: c.buyerId, buyerAcquisitions: c.buyerAcquisitions, buyerActivity: c.buyerActivity, buyerArchetype: c.buyerArchetype, txnId: c.txnId,
      })
      continue
    }
    corpusComps.push(c)
  }

  // Judge every candidate with the engine's own scoring, from the engine's own row.
  const all = [...poolComps, ...corpusComps]

  // Is each comp's property a CANONICAL property? Comps carry the sale corpus's
  // property_id and many of those parcels never entered `properties`; a property
  // surface (Deal Intelligence, Comps, Buyer Match) would 404 on them. One batched
  // existence read per workspace (never per row): true / false, or null when the
  // check itself could not run (unknown is never reported as "not tracked").
  const canonical = await canonicalPropertyIds(client, all.map((c) => c.propertyId))
  for (const c of all) c.canonicalProperty = canonicalFlag(canonical, c.propertyId)
  const inputFor = (c) => engineInputs.get(c.key) ?? engineRow(c, { source: 'transaction_corpus' })
  const packaged = detectPackageClusters(all.map(inputFor))
  for (const c of all) {
    const input = inputFor(c)
    const opts = { source: input.source, distance_miles: input.distance_miles ?? c.distanceMiles, packagedKeys: packaged.packagedKeys }
    const scored = scoreComparable(subject, input, { ...opts, now })
    // System comps show the numbers the engine actually priced with (stored);
    // candidates show what the engine's scoring says about them today.
    const stored = c.compId && systemIds.has(c.compId) ? storedById.get(c.compId) : null
    if (stored) {
      // Re-scored at the engine's own computed_at, the engine row reproduces
      // the stored verdict; that recovers the recency factor the stored row
      // does not carry. Used only when it reproduces the stored weight.
      const asPriced = computedAt && engineInputs.has(c.key) ? scoreComparable(subject, input, { ...opts, now: computedAt }) : null
      const reproduced = asPriced?.eligible && asPriced.weight === num(stored.weight) && asPriced.adjusted_price === pos(stored.adjusted_value ?? stored.adjusted_price)
      c.engine = engineVerdict({
        eligible: true,
        comp_score: stored.score ?? stored.comp_score,
        comp_confidence: stored.comp_confidence,
        data_completeness: stored.data_completeness,
        weight: stored.weight,
        adjusted_price: stored.adjusted_value ?? stored.adjusted_price,
        price_adjustments: stored.price_adjustments,
        match_breakdown: stored.match_breakdown ?? stored.feature_match_breakdown,
        sale_source: stored.source,
      }, 'stored', { recency: reproduced ? asPriced.recency_score : null })
      // Today's verdict on the same sale, so drift since the engine ran is visible.
      c.today = scored.eligible
        ? { eligible: true, reasons: [], weight: round(scored.weight, 4), adjustedPrice: pos(scored.adjusted_price), recency: num(scored.recency_score), score: round(scored.comp_score, 2), completeness: round(scored.data_completeness, 2) }
        : { eligible: false, reasons: arr(scored.reasons), weight: null, adjustedPrice: null, recency: null, score: null, completeness: null }
    } else {
      c.engine = engineVerdict(scored)
    }
    const dataReasons = [
      c.nominal ? 'nominal_price' : null,
      c.armsLength === false ? 'non_arms_length' : null,
      c.distressDeed ? 'distress_or_transfer_deed' : null,
    ].filter(Boolean)
    const storedReasons = c.compId ? rejectedStored.get(c.compId) : null
    if (c.compId && systemIds.has(c.compId)) c.state = 'system'
    else if (dataReasons.length || !c.engine?.eligible) c.state = 'excluded'
    else c.state = 'candidate'
    c.reasons = [...new Set([...dataReasons, ...arr(c.engine?.reasons), ...arr(storedReasons)])]
      .map((code) => ({ code, label: REASON_LABELS[code] || code.replace(/_/g, ' ') }))
    c.compare = compareToSubject(subjectView, c)
    delete c.nominal
    delete c.distressDeed
  }

  const order = { system: 0, candidate: 1, excluded: 2 }
  all.sort((a, b) => order[a.state] - order[b.state] || (b.engine?.weight ?? -1) - (a.engine?.weight ?? -1) || (a.distanceMiles ?? 99) - (b.distanceMiles ?? 99))

  const system = all.filter((c) => c.state === 'system')
  const cell = obj(cellRes.data)
  const opp = arr(oppRes.data)[0] || null
  const ns = obj(obj(opp?.metadata).negotiation_state)

  const recentSales = recentSalesBlock(salesRes, { radiusMiles, months: monthsBack })

  return {
    generatedAt: now.toISOString(),
    query: {
      radiusMiles,
      months: monthsBack,
      radiusOptions: RADIUS_OPTIONS,
      monthOptions: MONTH_OPTIONS,
      engineWindow: { radiusMiles: engineWindow.radiusMiles, months: engineWindow.months, clamped: engineWindow.clamped },
    },
    subject: { ...subjectView, dimensions: dimensionsFor(subject.asset_family) },
    counts: {
      system: system.length,
      candidates: all.filter((c) => c.state === 'candidate').length,
      excluded: all.filter((c) => c.state === 'excluded').length,
      enginePool: poolComps.length,
      transactions: corpusComps.length,
      transactionsInRadius: num(corpus.total_in_radius),
      transactionsSameFamily: num(corpus.total_same_family),
      transactionsReturned: num(corpus.returned),
    },
    systemStats: setStats(system),
    sufficiency: evidenceSufficiency(all),
    conclusion: score ? {
      valueLow: pos(score.valuation_low),
      valueMid: pos(score.valuation_mid),
      valueHigh: pos(score.valuation_high),
      valuationConfidence: num(score.valuation_confidence),
      recommendedOffer: pos(score.recommended_cash_offer),
      floor: pos(score.minimum_acceptable_offer),
      tier: clean(score.decision_tier) || null,
      computedAt: score.computed_at,
      ask: pos(ns.current_asking_price ?? ns.current_ask) ?? pos(opp?.asking_price),
      // weighted_adjusted_comp_value is comp evidence; subject_value_fallback
      // is the record estimate ×0.82 / ×1.15 when no comp qualified.
      method: engineRun?.method ?? null,
    } : null,
    engineRun,
    engineRules: engineRulesFor(subject.asset_family),
    market: cell && cell.txn_count ? {
      zip: subjectView.zip,
      family: cellFamily(subject),
      windowDays: num(cell.window_days),
      asOf: cell.as_of,
      sales: num(cell.txn_count),
      medianPrice: pos(cell.median_price),
      p25: pos(cell.p25_price),
      p75: pos(cell.p75_price),
      medianPpsf: round(cell.median_ppsf, 0),
      medianPpu: round(cell.median_ppu, 0),
      cashShare: num(cell.cash_share),
      armsLengthShare: num(cell.arms_length_share),
      corporateBuyerShare: num(cell.corporate_buyer_share_proxy),
      repeatBuyerShare: num(cell.repeat_buyer_share_proxy),
      recencyDaysMedian: num(cell.recency_days_median),
      admissible: cell.admissible === true,
    } : null,
    comps: all,
    recentSales,
    freshness: freshnessOf(all, recentSales, engineRun),
  }
}
