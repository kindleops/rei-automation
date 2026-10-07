// ─── ranking-v2/campaign-rank-v2.js ──────────────────────────────────────────
// Acquisition OS §11 / §12 / §14 / §67 — CAMPAIGN RANKING v2.
//
// ONE ranking function, used everywhere a campaign orders sellers (graph build
// window, recipient dedupe primary, campaign_targets.priority_score → feeder).
// The SQL twin is in PROPOSED_20261007_campaign_ranking_v2.sql
// (campaign_rank_v2_priority(...)) and must stay formula-identical; the tests
// pin both to the same fixtures.
//
// ORDER = (BAND, then SCORE within band), encoded into ONE 0–100 number so a
// plain `ORDER BY priority_score DESC` (the feeder) keeps the order:
//
//   band  source                         priority_score
//   A     seller_situation_v2 tier A      75 + 0.2499·score
//   B     seller_situation_v2 tier B      50 + 0.2499·score
//   C     seller_situation_v2 tier C      25 + 0.2499·score
//   FB    no v2 tier → LEGACY FALLBACK     0 + 0.2499·final_acquisition_score   (marked fallback)
//   —     neither                         null (last; total order by contact, id)
//
// So a tired-landlord-only seller (tier C) can never outrank a tax-delinquent,
// vacant, high-equity, long-tenure, high-repair seller (tier A) because of an
// old Podio number (§67), and a legacy score can never override current
// evidence: legacy only orders rows that have NO current evidence (§12).
//
// SCORE (within band, 0–100) = Σ wᵢ·xᵢ over these terms; an unknown term uses
// its documented NEUTRAL PRIOR (reported as `used_prior`), never 0:
//
//   term                 source                                        w     prior
//   sell365              situation.sell_probability.d365                0.22  20
//   forced_sale          situation.components.forced_sale_pressure      0.20  20
//   stacked              # distinct positive evidence codes × 15 (≤100)  0.12   0
//   equity               situation.components.equity_unlock             0.12  40
//   other_pressure       max(landlord_fatigue, tax_pain, debt_pressure,
//                            property_burden)                           0.06  20
//   aos                  property_acquisition_scores.aos_score / 10      0.06  50
//   market               market_quality_v1 (liquidity + buyer depth)    0.14  50
//   contact              contactability (identity, line type, usage)    0.08  50
//
// Legacy Podio-era values (final_acquisition_score / acquisition_score) are
// read ONLY in the FB band and echoed under `legacy_shadow`.

import { SCORE_VERSION as SITUATION_SCORE_VERSION } from '@/lib/acquisition/seller-situation/index.js'
import { buildWhyTargeted } from '@/lib/domain/campaigns/ranking-v2/why-targeted.js'

export const CAMPAIGN_RANKING_VERSION = 'campaign_rank_v2.0'

export const RANK_BANDS = Object.freeze({
  A: Object.freeze({ floor: 75, label: 'A · Acute pressure' }),
  B: Object.freeze({ floor: 50, label: 'B · Strong stacked' }),
  C: Object.freeze({ floor: 25, label: 'C · Soft' }),
  FALLBACK: Object.freeze({ floor: 0, label: 'Legacy fallback (no current evidence)' }),
  UNRANKED: Object.freeze({ floor: null, label: 'Unranked' }),
})

export const RANK_TERMS = Object.freeze({
  sell365: Object.freeze({ weight: 0.22, prior: 20 }),
  forced_sale: Object.freeze({ weight: 0.2, prior: 20 }),
  stacked: Object.freeze({ weight: 0.12, prior: 0 }),
  equity: Object.freeze({ weight: 0.12, prior: 40 }),
  other_pressure: Object.freeze({ weight: 0.06, prior: 20 }),
  aos: Object.freeze({ weight: 0.06, prior: 50 }),
  market: Object.freeze({ weight: 0.14, prior: 50 }),
  contact: Object.freeze({ weight: 0.08, prior: 50 }),
})

const STACK_POINTS_PER_CODE = 15
// 24.99, not 25: bands never touch (C max 49.99 < B min 50), so a tie can never
// let a lower band's score decide against a higher band.
const BAND_WIDTH = 24.99

function num(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function clamp100(value) {
  const n = num(value)
  if (n === null) return null
  return Math.max(0, Math.min(100, n))
}

function round2(n) {
  return Math.round(n * 100) / 100
}

/** Is this a real (non-stub) seller_situation_v2 result with a decided tier? */
export function hasCurrentSituation(situation) {
  if (!situation || typeof situation !== 'object') return false
  if (situation.score_version !== SITUATION_SCORE_VERSION) return false
  const tier = situation.opportunity_tier
  if (tier !== 'A' && tier !== 'B' && tier !== 'C') return false
  const reasons = Array.isArray(situation.tier_reasons) ? situation.tier_reasons : []
  return !(reasons.length === 1 && reasons[0] === 'STUB')
}

const IDENTITY_POINTS = { verified: 40, probable: 28, entity_company_linked: 22, unknown: 10, mismatch: 0 }
const USAGE_POINTS = { 'very heavy usage': 30, 'heavy usage': 30, 'moderate usage': 24, 'light usage': 16, 'minimal usage': 8 }

/**
 * Contactability 0–100 from the graph's phone/identity columns. null when no
 * contact evidence at all. (best_phone_score is 100% NULL in the graph today,
 * so it is deliberately not an input.)
 */
export function contactabilityScore(row = {}) {
  const identity = String(row.identity_alignment ?? '').trim().toLowerCase()
  const lineType = String(row.phone_type ?? '').trim().toUpperCase()
  const usage = String(row.usage_2_months ?? '').trim().toLowerCase()
  const parts = []
  if (identity in IDENTITY_POINTS) parts.push(IDENTITY_POINTS[identity])
  if (lineType === 'W' || lineType === 'L') parts.push(lineType === 'W' ? 30 : 12)
  if (usage in USAGE_POINTS) parts.push(USAGE_POINTS[usage])
  if (!parts.length) return null
  // Missing sub-signals take half their max so a row is not punished for an
  // unrecorded usage band (documented, not hidden).
  const identityPts = identity in IDENTITY_POINTS ? IDENTITY_POINTS[identity] : 20
  const linePts = lineType === 'W' ? 30 : lineType === 'L' ? 12 : 15
  const usagePts = usage in USAGE_POINTS ? USAGE_POINTS[usage] : 15
  return identityPts + linePts + usagePts
}

function legacyScore(row = {}) {
  return clamp100(row.final_acquisition_score ?? row.acquisition_score)
}

function positiveEvidenceCodes(situation) {
  const codes = new Set()
  for (const e of Array.isArray(situation?.evidence) ? situation.evidence : []) {
    if ((num(e?.points) ?? 0) > 0 && e?.code) codes.add(String(e.code))
  }
  return codes
}

/**
 * @param {object} row       campaign_target_graph row (or target snapshot)
 * @param {{situation?:object|null, market?:object|null, includeWhy?:boolean}} ctx
 */
export function computeCampaignRankV2(row = {}, { situation = null, market = null, includeWhy = true } = {}) {
  const contact = contactabilityScore(row)
  const legacy = legacyScore(row)
  const base = {
    ranking_version: CAMPAIGN_RANKING_VERSION,
    property_id: row.property_id ?? null,
    legacy_shadow: { final_acquisition_score: legacy },
  }

  if (!hasCurrentSituation(situation)) {
    if (legacy !== null) {
      return {
        ...base,
        rank_source: 'legacy_fallback',
        band: 'FALLBACK',
        tier: situation?.opportunity_tier ?? 'UNKNOWN',
        score: legacy,
        priority_score: round2(RANK_BANDS.FALLBACK.floor + (BAND_WIDTH * legacy) / 100),
        contact_score: contact,
        terms: [],
        coverage: { terms_known: 0, terms_total: Object.keys(RANK_TERMS).length, ratio: 0 },
        score_version: null,
        input_model_version: null,
        why: includeWhy ? buildWhyTargeted({ row, situation: null, market }) : undefined,
        fallback_reason: situation ? 'seller_situation_tier_unknown' : 'seller_situation_absent',
      }
    }
    return {
      ...base,
      rank_source: 'unranked',
      band: 'UNRANKED',
      tier: situation?.opportunity_tier ?? 'UNKNOWN',
      score: null,
      priority_score: null,
      contact_score: contact,
      terms: [],
      coverage: { terms_known: 0, terms_total: Object.keys(RANK_TERMS).length, ratio: 0 },
      score_version: null,
      input_model_version: null,
      why: includeWhy ? buildWhyTargeted({ row, situation: null, market }) : undefined,
      fallback_reason: 'no_current_or_legacy_score',
    }
  }

  const comp = situation.components || {}
  const otherPressure = [comp.landlord_fatigue, comp.tax_pain, comp.debt_pressure, comp.property_burden]
    .map(clamp100).filter((v) => v !== null)
  const stackedCount = positiveEvidenceCodes(situation).size
  const aos = num(row.aos_score)
  const raw = {
    sell365: clamp100(situation.sell_probability?.d365),
    forced_sale: clamp100(comp.forced_sale_pressure),
    stacked: Math.min(100, stackedCount * STACK_POINTS_PER_CODE),
    equity: clamp100(comp.equity_unlock),
    other_pressure: otherPressure.length ? Math.max(...otherPressure) : null,
    aos: aos === null ? null : clamp100(aos > 100 ? aos / 10 : aos),
    market: clamp100(market?.score),
    contact,
  }
  let score = 0
  let known = 0
  const terms = []
  for (const [key, def] of Object.entries(RANK_TERMS)) {
    const value = raw[key]
    const usedPrior = value === null
    const x = usedPrior ? def.prior : value
    if (!usedPrior) known += 1
    const points = def.weight * x
    score += points
    terms.push({ key, weight: def.weight, value, used_prior: usedPrior, prior: def.prior, points: round2(points) })
  }
  score = round2(score)
  const tier = situation.opportunity_tier
  const band = RANK_BANDS[tier]
  return {
    ...base,
    rank_source: 'v2',
    band: tier,
    tier,
    tier_reasons: Array.isArray(situation.tier_reasons) ? situation.tier_reasons : [],
    seller_situation: situation.seller_situation ?? null,
    score,
    priority_score: round2(band.floor + (BAND_WIDTH * score) / 100),
    contact_score: contact,
    terms,
    coverage: { terms_known: known, terms_total: terms.length, ratio: round2(known / terms.length) },
    score_version: situation.score_version,
    input_model_version: situation.input_model_version ?? null,
    stacked_evidence_count: stackedCount,
    why: includeWhy ? buildWhyTargeted({ row, situation, market }) : undefined,
  }
}

function idKey(row) {
  return String(row?.property_id ?? row?.graph_id ?? '')
}

/**
 * Total order (lower = earlier): priority desc, score desc, contact desc,
 * property id asc. Rows are `{ ...row, _rank_v2 }` or rank objects.
 */
export function compareCampaignRankV2(a, b) {
  const ra = a?._rank_v2 ?? a
  const rb = b?._rank_v2 ?? b
  const pa = num(ra?.priority_score)
  const pb = num(rb?.priority_score)
  if (pa !== pb) {
    if (pa === null) return 1
    if (pb === null) return -1
    return pb - pa
  }
  const sa = num(ra?.score) ?? -Infinity
  const sb = num(rb?.score) ?? -Infinity
  if (sa !== sb) return sb - sa
  const ca = num(ra?.contact_score) ?? -Infinity
  const cb = num(rb?.contact_score) ?? -Infinity
  if (ca !== cb) return cb - ca
  return idKey(a).localeCompare(idKey(b))
}

/**
 * Rank a cohort in-process. `situations` / `markets` are Maps keyed by
 * property_id (situations) and resolved per row by `marketFor(row)`.
 * Returns a NEW sorted array of `{ ...row, _rank_v2 }`; input untouched.
 */
export function rankCampaignRowsV2(rows = [], { situations = null, marketFor = null, includeWhy = false } = {}) {
  const ranked = (rows || []).map((row) => {
    const situation = situations instanceof Map ? situations.get(String(row.property_id)) ?? null : null
    const market = typeof marketFor === 'function' ? marketFor(row) : null
    return { ...row, _rank_v2: computeCampaignRankV2(row, { situation, market, includeWhy }) }
  })
  ranked.sort(compareCampaignRankV2)
  return ranked
}

/** Compact, persisted form (campaign_targets.metadata.ranking). */
export function rankingMetadata(rank) {
  if (!rank) return null
  return {
    ranking_version: rank.ranking_version,
    rank_source: rank.rank_source,
    band: rank.band,
    tier: rank.tier,
    score: rank.score,
    priority_score: rank.priority_score,
    score_version: rank.score_version,
    input_model_version: rank.input_model_version,
    coverage: rank.coverage,
    fallback_reason: rank.fallback_reason ?? null,
    legacy_shadow: rank.legacy_shadow,
    why: Array.isArray(rank.why) ? rank.why.map((w) => w.label) : undefined,
  }
}
