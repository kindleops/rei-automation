// ─── ranking-v2/screener-metrics.js ──────────────────────────────────────────
// Acquisition OS §13 / §17 / §69 — the metric registry the Seller Screener
// (and Composer stacked targeting) filters on. One definition per metric:
// where the value comes from, how to read it from a row + context, its type,
// and the production COVERAGE it needs before it is exposed (§17: a metric is
// offered only once its coverage is understood; below threshold it is refused
// by name with its measured coverage, never silently dropped).
//
// Sources:
//   graph      campaign_target_graph column (pushed down to SQL when it sits in
//              the top-level AND of the expression)
//   situation  seller_situation_v2 result (A1 raw-facts model), in-process
//   market     market_quality_v1 for the row's ZIP + asset lane
//   derived    computed from graph columns (documented formula)
//   rank       campaign_rank_v2 (this module family)
//
// Protected classes are not metrics (race, national origin, language as a
// proxy, sex, religion, disability, familial status, age, marital status).

import { contactabilityScore } from '@/lib/domain/campaigns/ranking-v2/campaign-rank-v2.js'

function num(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function bool(value) {
  if (value === true || value === 't' || value === 'true') return true
  if (value === false || value === 'f' || value === 'false') return false
  return null
}

function text(value) {
  const s = String(value ?? '').trim()
  return s || null
}

function comp(key) {
  return (row, ctx) => (ctx?.situation && ctx.situation.opportunity_tier !== 'UNKNOWN' ? num(ctx.situation.components?.[key]) : null)
}

function sell(key) {
  return (row, ctx) => (ctx?.situation && ctx.situation.opportunity_tier !== 'UNKNOWN' ? num(ctx.situation.sell_probability?.[key]) : null)
}

const DAY_MS = 86_400_000

/** Default coverage threshold for exposing a metric (share of rows with a value). */
export const DEFAULT_COVERAGE_THRESHOLD = 0.6

export const SCREENER_METRICS = Object.freeze({
  // ── geography / asset (graph) ──
  state: { label: 'State', source: 'graph', column: 'state', type: 'text', get: (r) => text(r.state), threshold: 0.5 },
  market: { label: 'Market', source: 'graph', column: 'market', type: 'text', get: (r) => text(r.market), threshold: 0.5 },
  zip: { label: 'ZIP', source: 'graph', column: 'property_zip', type: 'text', get: (r) => text(r.property_zip)?.slice(0, 5) ?? null, threshold: 0.5 },
  county: { label: 'County', source: 'graph', column: 'property_county_name', type: 'text', get: (r) => text(r.property_county_name), threshold: 0.5 },
  property_type: { label: 'Property type', source: 'graph', column: 'property_type', type: 'text', get: (r) => text(r.property_type), threshold: 0.5 },
  units_count: { label: 'Units', source: 'graph', column: 'units_count', type: 'number', get: (r) => num(r.units_count), threshold: 0.3 },
  // ── raw facts (graph) ──
  equity_percent: { label: 'Equity %', source: 'graph', column: 'equity_percent', type: 'number', get: (r) => num(r.equity_percent) },
  ownership_years: { label: 'Years owned', source: 'graph', column: 'ownership_years', type: 'number', get: (r) => num(r.ownership_years) },
  year_built: { label: 'Year built', source: 'graph', column: 'year_built', type: 'number', get: (r) => num(r.year_built) },
  estimated_value: { label: 'Estimated value', source: 'graph', column: 'estimated_value', type: 'number', get: (r) => num(r.estimated_value) },
  tax_delinquent: { label: 'Tax delinquent', source: 'graph', column: 'tax_delinquent', type: 'boolean', get: (r) => bool(r.tax_delinquent) },
  active_lien: { label: 'Active lien', source: 'graph', column: 'active_lien', type: 'boolean', get: (r) => bool(r.active_lien) },
  out_of_state_owner: { label: 'Out-of-state owner', source: 'graph', column: 'out_of_state_owner', type: 'boolean', get: (r) => bool(r.out_of_state_owner) },
  corporate_owner: { label: 'Corporate owner', source: 'graph', column: 'is_corporate_owner', type: 'boolean', get: (r) => bool(r.is_corporate_owner) },
  // ── contactability / touch (graph + derived) ──
  sms_eligible: { label: 'SMS eligible', source: 'graph', column: 'sms_eligible', type: 'boolean', get: (r) => bool(r.sms_eligible) },
  queue_eligible: { label: 'Queue eligible', source: 'graph', column: 'queue_eligible', type: 'boolean', get: (r) => bool(r.queue_eligible) },
  phone_type: { label: 'Line type', source: 'graph', column: 'phone_type', type: 'text', get: (r) => text(r.phone_type), threshold: 0.5 },
  mobile_reachable: {
    label: 'Mobile reachable',
    source: 'derived',
    type: 'boolean',
    formula: "phone_type = 'W' AND sms_eligible",
    get: (r) => {
      const t = text(r.phone_type)
      const s = bool(r.sms_eligible)
      if (t === null || s === null) return null
      return t === 'W' && s
    },
    threshold: 0.5,
  },
  days_since_outbound: {
    label: 'Days since last outbound (never = ∞)',
    source: 'derived',
    type: 'number',
    formula: 'now − last_outbound_at; never contacted = Infinity',
    get: (r, ctx) => {
      if (bool(r.never_contacted) === true && !r.last_outbound_at) return Infinity
      const t = r.last_outbound_at ? Date.parse(r.last_outbound_at) : NaN
      if (!Number.isFinite(t)) return bool(r.never_contacted) === true ? Infinity : null
      return Math.floor(((ctx?.now ?? Date.now()) - t) / DAY_MS)
    },
    threshold: 0.5,
  },
  contactability: { label: 'Contactability', source: 'derived', type: 'number', formula: 'identity + line type + usage (campaign_rank_v2.contactabilityScore)', get: (r) => contactabilityScore(r) },
  // ── seller situation (A1) ──
  forced_sale_pressure: { label: 'Forced-sale pressure', source: 'situation', type: 'number', get: comp('forced_sale_pressure') },
  landlord_fatigue: { label: 'Landlord fatigue', source: 'situation', type: 'number', get: comp('landlord_fatigue') },
  equity_unlock: { label: 'Equity unlock', source: 'situation', type: 'number', get: comp('equity_unlock') },
  property_burden: { label: 'Property burden', source: 'situation', type: 'number', get: comp('property_burden') },
  tax_pain: { label: 'Tax pain', source: 'situation', type: 'number', get: comp('tax_pain') },
  debt_pressure: { label: 'Debt pressure', source: 'situation', type: 'number', get: comp('debt_pressure') },
  sell90: { label: 'Sell chance 90d', source: 'situation', type: 'number', get: sell('d90') },
  sell180: { label: 'Sell chance 180d', source: 'situation', type: 'number', get: sell('d180') },
  sell365: { label: 'Sell chance 365d', source: 'situation', type: 'number', get: sell('d365') },
  opportunity_tier: { label: 'Opportunity tier', source: 'situation', type: 'text', get: (r, ctx) => ctx?.situation?.opportunity_tier ?? null, threshold: 0 },
  seller_situation: { label: 'Seller situation', source: 'situation', type: 'text', get: (r, ctx) => (ctx?.situation && ctx.situation.opportunity_tier !== 'UNKNOWN' ? ctx.situation.seller_situation : null) },
  situation_confidence: { label: 'Situation confidence', source: 'situation', type: 'number', get: (r, ctx) => num(ctx?.situation?.confidence) },
  // ── market (MI / Buyer Match) ──
  market_quality: { label: 'Market quality', source: 'market', type: 'number', get: (r, ctx) => num(ctx?.market?.score), threshold: 0.4 },
  buyer_depth: { label: 'Buyer depth', source: 'market', type: 'number', get: (r, ctx) => num(ctx?.market?.terms?.buyer_depth), threshold: 0.4 },
  liquidity: { label: 'Market liquidity', source: 'market', type: 'number', get: (r, ctx) => num(ctx?.market?.terms?.liquidity), threshold: 0.4 },
  investor_activity: { label: 'Investor activity', source: 'market', type: 'number', get: (r, ctx) => num(ctx?.market?.terms?.investor_activity), threshold: 0.4 },
  // ── rank ──
  rank_score: { label: 'Rank v2 score (within tier)', source: 'rank', type: 'number', get: (r, ctx) => (ctx?.rank?.rank_source === 'v2' ? num(ctx.rank.score) : null) },
})

export function metricDefinition(key) {
  return SCREENER_METRICS[String(key ?? '').trim()] || null
}

export function metricThreshold(key) {
  const def = metricDefinition(key)
  if (!def) return null
  return typeof def.threshold === 'number' ? def.threshold : DEFAULT_COVERAGE_THRESHOLD
}

/**
 * Coverage over a sample: share of rows whose metric value is known (not
 * null). `contexts[i]` is `{situation, market, rank}` for `rows[i]`.
 */
export function measureMetricCoverage(rows = [], contexts = [], keys = Object.keys(SCREENER_METRICS), now = Date.now()) {
  const out = {}
  const total = rows.length
  for (const key of keys) {
    const def = metricDefinition(key)
    if (!def) continue
    let known = 0
    for (let i = 0; i < total; i += 1) {
      const v = def.get(rows[i], { ...(contexts[i] || {}), now })
      if (v !== null && v !== undefined) known += 1
    }
    const ratio = total ? Math.round((known / total) * 1000) / 1000 : 0
    const threshold = metricThreshold(key)
    out[key] = { key, label: def.label, source: def.source, known, total, ratio, threshold, exposed: total > 0 && ratio >= threshold }
  }
  return out
}

/** Catalog for the UI: every metric with its source, formula and coverage verdict. */
export function screenerMetricCatalog(coverage = null) {
  return Object.entries(SCREENER_METRICS).map(([key, def]) => {
    const cov = coverage?.[key] || null
    return {
      key,
      label: def.label,
      source: def.source,
      type: def.type,
      column: def.column ?? null,
      formula: def.formula ?? null,
      threshold: metricThreshold(key),
      coverage: cov ? { ratio: cov.ratio, known: cov.known, total: cov.total } : null,
      exposed: cov ? cov.exposed : false,
      reason: cov ? (cov.exposed ? null : 'coverage_below_threshold') : 'coverage_not_measured',
    }
  })
}
