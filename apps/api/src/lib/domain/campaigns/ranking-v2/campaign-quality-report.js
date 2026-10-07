// ─── ranking-v2/campaign-quality-report.js ───────────────────────────────────
// Acquisition OS §19 / §70 — CAMPAIGN PREVIEW / QUALITY REPORT, before launch.
// No auto-launch, no writes. Every share is reported as count / denominator;
// the UI may render a percentage only from those two numbers (no fake %).
//
//   segments      acute · tax/lien · vacancy/repair · stacked landlord · other soft · unknown score
//   tiers         A / B / C / UNKNOWN (seller_situation_v2 opportunity_tier)
//   ranking       rows ranked by v2 vs legacy fallback vs unranked
//   coverage      per-metric known/total for the inputs ranking uses
//   markets       market + ZIP distribution with market-quality label
//   situations    seller_situation distribution (known only; unknown separate)
//   language      KNOWN languages vs UNKNOWN (unknown is never shown as English)
//   contactability line type, identity alignment, usage known
//   prior touch   property ever touched (graph never_contacted / last_outbound_at)
//   review-only   expected review holds (identity not verified/probable)
//   buyer liquidity market-quality label split (strong / moderate / thin / unknown)

import { measureMetricCoverage } from '@/lib/domain/campaigns/ranking-v2/screener-metrics.js'
import { HARD_FAMILIES } from '@/lib/acquisition/seller-situation/index.js'
import { contactConfidenceBucket, equityEvidence } from '@/lib/domain/campaigns/ranking-v2/contact-evidence.js'

export const QUALITY_REPORT_VERSION = 'campaign_quality_report_v1'

// HARD evidence only (A1 HARD_FAMILIES + heavy repair). Soft codes such as a
// high tax RATE, a dated interior or a pre-1960 build do NOT make a seller a
// "tax/lien" or "vacancy/repair" seller.
const HARD = HARD_FAMILIES || {}
const TAX_LIEN_CODES = new Set([...(HARD.TAX || []), ...(HARD.FORECLOSURE || []), ...(HARD.LEGAL_LIEN || []), 'TAX_DELINQUENT_MULTI_YEAR', 'AUCTION_WITHIN_90D', 'FORECLOSURE_DEBT_ENFORCEMENT'])
const VACANCY_REPAIR_CODES = new Set([...(HARD.VACANCY || []), ...(HARD.CONDITION || []), 'REPAIR_TIER_HEAVY_FORMULA', 'VACANT_RENTAL', 'VACANT_UPKEEP'])

function inc(map, key, by = 1) {
  map[key] = (map[key] || 0) + by
}

function codesOf(situation) {
  return (Array.isArray(situation?.evidence) ? situation.evidence : [])
    .filter((e) => Number(e?.points) > 0)
    .map((e) => String(e.code || ''))
}

/** One segment per row (first match wins, documented order). */
export function cohortSegment(situation) {
  const tier = situation?.opportunity_tier
  if (tier !== 'A' && tier !== 'B' && tier !== 'C') return 'unknown_score'
  if (tier === 'A') return 'acute'
  const codes = codesOf(situation)
  if (codes.some((c) => TAX_LIEN_CODES.has(c))) return 'tax_lien'
  if (codes.some((c) => VACANCY_REPAIR_CODES.has(c))) return 'vacancy_repair'
  if (tier === 'B') return 'stacked_landlord'
  return 'other_soft'
}

const SEGMENT_LABELS = Object.freeze({
  acute: 'Acute pressure (tier A)',
  tax_lien: 'Tax / lien',
  vacancy_repair: 'Vacancy / repair',
  stacked_landlord: 'Stacked landlord (tier B)',
  other_soft: 'Other soft (tier C)',
  unknown_score: 'Unknown score',
})

function sortedEntries(obj, limit = 50) {
  return Object.entries(obj).map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count).slice(0, limit)
}

/**
 * @param {object[]} rows      graph rows (SCREENER_GRAPH_COLUMNS) for the cohort
 * @param {{situation,market,rank}[]} contexts aligned with rows
 */
export function summarizeCampaignQuality(rows = [], contexts = [], { now = Date.now(), examples = 12 } = {}) {
  const n = rows.length
  const segments = Object.fromEntries(Object.keys(SEGMENT_LABELS).map((k) => [k, 0]))
  const tiers = { A: 0, B: 0, C: 0, UNKNOWN: 0 }
  const ranking = { v2: 0, legacy_fallback: 0, unranked: 0 }
  const markets = {}
  const zips = {}
  const situations = {}
  let situationUnknown = 0
  const languages = {}
  let languageUnknown = 0
  const lineType = { mobile: 0, landline: 0, unknown: 0 }
  const identity = {}
  let touched = 0
  let touchUnknown = 0
  let reviewExpected = 0
  const liquidity = { strong: 0, moderate: 0, thin: 0, unknown: 0 }
  const equity = { high: 0, low: 0, unknown: 0, known_percent: 0 }
  const contactConf = { high: 0, medium: 0, low: 0, unknown: 0 }
  const tags = {}
  for (let i = 0; i < n; i += 1) {
    const row = rows[i]
    const ctx = contexts[i] || {}
    inc(segments, cohortSegment(ctx.situation))
    const tier = ctx.situation?.opportunity_tier
    inc(tiers, tier === 'A' || tier === 'B' || tier === 'C' ? tier : 'UNKNOWN')
    inc(ranking, ctx.rank?.rank_source || 'unranked')
    inc(markets, row.market || '(no market)')
    inc(zips, String(row.property_zip ?? '').slice(0, 5) || '(no zip)')
    if (tier === 'A' || tier === 'B' || tier === 'C') inc(situations, ctx.situation.seller_situation || 'NO_CLEAR_SITUATION')
    else situationUnknown += 1
    const lang = String(row.language ?? row.resolved_language ?? '').trim().toLowerCase()
    if (lang && lang !== 'auto' && lang !== 'unknown') inc(languages, lang)
    else languageUnknown += 1
    const lt = String(row.phone_type ?? '').toUpperCase()
    lineType[lt === 'W' ? 'mobile' : lt === 'L' ? 'landline' : 'unknown'] += 1
    const ia = String(row.identity_alignment ?? '').trim().toLowerCase() || 'unknown'
    inc(identity, ia)
    if (!(ia === 'verified' || ia === 'probable')) reviewExpected += 1
    const nc = row.never_contacted
    if (nc === true || nc === 't') { /* never touched */ } else if (nc === false || nc === 'f' || row.last_outbound_at) touched += 1
    else touchUnknown += 1
    inc(liquidity, ctx.market?.label && liquidity[ctx.market.label] !== undefined ? ctx.market.label : 'unknown')
    const eq = equityEvidence(row)
    equity[eq.class] += 1
    if (eq.known) equity.known_percent += 1
    inc(contactConf, contactConfidenceBucket(ctx.rank?.contact_score))
    inc(tags, ctx.rank?.layers?.contact?.tag || 'missing')
  }
  const coverage = measureMetricCoverage(rows, contexts, [
    'forced_sale_pressure', 'sell365', 'equity_unlock', 'landlord_fatigue', 'tax_pain', 'opportunity_tier',
    'market_quality', 'buyer_depth', 'contact_confidence', 'equity_percent', 'equity_class', 'matching_tag', 'ownership_years', 'phone_type',
  ], now)
  const ranked = contexts.map((c, i) => ({ row: rows[i], ctx: c }))
    .filter((x) => x.ctx?.rank?.priority_score !== null && x.ctx?.rank?.priority_score !== undefined)
    .sort((a, b) => (b.ctx.rank.priority_score ?? 0) - (a.ctx.rank.priority_score ?? 0))
  const pick = (list) => list.slice(0, examples).map(({ row, ctx }) => ({
    property_id: row.property_id,
    market: row.market ?? null,
    zip: String(row.property_zip ?? '').slice(0, 5) || null,
    tier: ctx.situation?.opportunity_tier ?? 'UNKNOWN',
    band: ctx.rank?.band ?? null,
    score: ctx.rank?.priority_score ?? null,
    layers: ctx.rank?.layers ? { contact: ctx.rank.layers.contact.score, pressure: ctx.rank.layers.pressure.effective, deal: ctx.rank.layers.deal.score, market: ctx.rank.layers.market.score } : null,
    why: (ctx.rank?.why || []).map((w) => w.label),
  }))
  return {
    version: QUALITY_REPORT_VERSION,
    denominator: n,
    segments: Object.entries(segments).map(([key, count]) => ({ key, label: SEGMENT_LABELS[key], count })),
    tiers,
    ranking,
    coverage,
    markets: sortedEntries(markets, 25),
    zips: sortedEntries(zips, 25),
    situations: { known: sortedEntries(situations, 10), unknown: situationUnknown },
    language: { known: sortedEntries(languages, 20), unknown: languageUnknown },
    contactability: { line_type: lineType, identity: sortedEntries(identity, 10) },
    prior_property_touch: { touched, never: n - touched - touchUnknown, unknown: touchUnknown },
    expected_review_only: { count: reviewExpected, rule: "identity_alignment not in ('verified','probable')" },
    buyer_liquidity: liquidity,
    // equity_known_v1: unknown is never shown as 100%
    equity: { ...equity, rule: 'known only when loan>0 & value>0, or vendor Free And Clear; vendor High/Low Equity flag = class without %' },
    contact_confidence: contactConf,
    matching_tags: sortedEntries(tags, 10),
    examples: { top_ranked: pick(ranked), soft_only: pick(ranked.filter((x) => x.ctx.situation?.opportunity_tier === 'C').reverse()) },
  }
}
