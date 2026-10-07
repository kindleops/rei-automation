// ─── ranking-v2/campaign-rank-v2.js ──────────────────────────────────────────
// CAMPAIGN RANKING v2.1 — owner rebuild 2026-10-07 (supersedes the v2.0 strict
// A>B>C bands). Flag CAMPAIGN_RANKING_V2 (default OFF); SHADOW only.
//
//   "First reach the right person. Then prioritize the person most likely to
//    need to sell. Then prioritize the property we can actually make money on."
//
// LAYERS (each 0–100, each with its own evidence; nothing hidden):
//   L0 eligibility   existing gates (queue_eligible / suppression / sender).
//                    Not scored: an ineligible row is reported `eligible:false`
//                    and sorts last; the gates themselves are unchanged.
//   L1 contact       contact-evidence.js contactConfidence(): line type,
//                    identity alignment, prospects.matching_flags tag, usage,
//                    shared-phone ambiguity. THE FIRST DIMENSION.
//   L2 pressure      seller_situation_v2 (A1): tier + sell365 + forced-sale +
//                    stacked evidence + other pressure — then made CONDITIONAL
//                    on contact:  L2_eff = L2 · L1/100
//                    (distress at a wrong/unreachable person is worth little).
//                    No current situation → legacy final_acquisition_score as a
//                    MARKED fallback, halved and capped at 50 (§12).
//   L3 deal          equity (known only — equity_known_v1; unknown = neutral 45,
//                    never 100%), valuation present.
//   L4 market        market_quality_v1 (buyer depth / liquidity / investor
//                    share) + response-rate CONTEXT (market-response.js:
//                    shrunk, decayed, min-n, capped ±4 points).
//
//   priority = 0.40·L1 + 0.30·L2·L1/100 + 0.15·L3 + 0.15·L4     (0–100)
//   (distress is at most 30% of priority and only as reachable as the contact)
//
// No band overrides contact confidence. §67 still holds by construction: a
// legacy Podio number is never read when current evidence exists, so a
// tired-landlord-only seller cannot outrank a tax-delinquent, vacant,
// high-equity, long-tenure, high-repair seller *because of an old score*.
// SQL twin: PROPOSED_20261007080000_campaign_ranking_v2.sql (pinned by tests).

import { SCORE_VERSION as SITUATION_SCORE_VERSION } from '@/lib/acquisition/seller-situation/index.js'
import { buildWhyTargeted } from '@/lib/domain/campaigns/ranking-v2/why-targeted.js'
import { contactConfidence, equityEvidence } from '@/lib/domain/campaigns/ranking-v2/contact-evidence.js'

export const CAMPAIGN_RANKING_VERSION = 'campaign_rank_v2.1'

export const LAYER_WEIGHTS = Object.freeze({ contact: 0.4, pressure: 0.3, deal: 0.15, market: 0.15 })
// Gate = L1/100 (no floor). Guarantee (tested): with equal deal and market
// layers, a contact that is CONTACT_DOMINANCE_DELTA points stronger always
// outranks any tier-A seller — the distress layer (max 0.3 × 100 × gate) can
// never close a 0.4 × 40 = 16-point contact gap, because the most a tier-A
// seller at contact c can gain over a tier-C seller at c+40 is
// 0.3·(100·c/100 − 7.5·(c+40)/100) = 0.2775·c − 0.9 ≤ 15.75 < 16 (c ≤ 60).
export const PRESSURE_GATE_FLOOR = 0
export const CONTACT_DOMINANCE_DELTA = 40
export const TIER_POINTS = Object.freeze({ A: 100, B: 65, C: 25 })

/** L2 sub-terms (weights sum to 1; unknown → prior, reported). */
export const PRESSURE_TERMS = Object.freeze({
  tier: Object.freeze({ weight: 0.3, prior: 25 }),
  sell365: Object.freeze({ weight: 0.25, prior: 20 }),
  forced_sale: Object.freeze({ weight: 0.2, prior: 20 }),
  stacked: Object.freeze({ weight: 0.1, prior: 0 }),
  other_pressure: Object.freeze({ weight: 0.15, prior: 20 }),
})
export const DEAL_TERMS = Object.freeze({ equity_unknown: 45, equity_low: 25, value_known: 70, value_unknown: 30, equity_weight: 0.75, value_weight: 0.25 })
export const MARKET_PRIOR = 50
export const LEGACY_FALLBACK_CAP = 50
const STACK_POINTS_PER_CODE = 15

/** Kept for the UI/screener: display-only tier labels (they no longer order rows). */
export const RANK_BANDS = Object.freeze({
  A: Object.freeze({ label: 'A · Acute pressure' }),
  B: Object.freeze({ label: 'B · Strong stacked' }),
  C: Object.freeze({ label: 'C · Soft' }),
  UNKNOWN: Object.freeze({ label: 'No current seller evidence' }),
})

function num(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
function clamp100(value) {
  const n = num(value)
  return n === null ? null : Math.max(0, Math.min(100, n))
}
const r2 = (n) => Math.round(n * 100) / 100

/** Is this a real (non-stub) seller_situation_v2 result with a decided tier? */
export function hasCurrentSituation(situation) {
  if (!situation || typeof situation !== 'object') return false
  if (situation.score_version !== SITUATION_SCORE_VERSION) return false
  const tier = situation.opportunity_tier
  if (tier !== 'A' && tier !== 'B' && tier !== 'C') return false
  const reasons = Array.isArray(situation.tier_reasons) ? situation.tier_reasons : []
  return !(reasons.length === 1 && reasons[0] === 'STUB')
}

/** Back-compat name: Layer 1 score (0–100). */
export function contactabilityScore(row = {}) {
  return contactConfidence(row).score
}

function eligible(row) {
  if (row.queue_eligible === false || row.queue_eligible === 'f') return false
  if (row.true_post_contact_suppression === true || row.true_post_contact_suppression === 't') return false
  return true
}

function pressureLayer(row, situation) {
  if (hasCurrentSituation(situation)) {
    const comp = situation.components || {}
    const other = [comp.landlord_fatigue, comp.tax_pain, comp.debt_pressure, comp.property_burden].map(clamp100).filter((v) => v !== null)
    const codes = new Set((situation.evidence || []).filter((e) => num(e?.points) > 0 && e.code).map((e) => String(e.code)))
    const raw = {
      tier: TIER_POINTS[situation.opportunity_tier],
      sell365: clamp100(situation.sell_probability?.d365),
      forced_sale: clamp100(comp.forced_sale_pressure),
      stacked: Math.min(100, codes.size * STACK_POINTS_PER_CODE),
      other_pressure: other.length ? Math.max(...other) : null,
    }
    let score = 0
    const terms = []
    for (const [key, def] of Object.entries(PRESSURE_TERMS)) {
      const usedPrior = raw[key] === null
      const x = usedPrior ? def.prior : raw[key]
      score += def.weight * x
      terms.push({ key, value: raw[key], used_prior: usedPrior, prior: def.prior, weight: def.weight, points: r2(def.weight * x) })
    }
    return { score: r2(score), source: 'seller_situation_v2', terms, stacked_evidence_count: codes.size }
  }
  const legacy = clamp100(row.final_acquisition_score ?? row.acquisition_score)
  if (legacy !== null) {
    return { score: r2(Math.min(LEGACY_FALLBACK_CAP, legacy / 2)), source: 'legacy_fallback', terms: [{ key: 'legacy_final_acquisition_score', value: legacy, used_prior: false, weight: 0.5, points: r2(Math.min(LEGACY_FALLBACK_CAP, legacy / 2)) }], stacked_evidence_count: 0 }
  }
  return { score: PRESSURE_TERMS.tier.prior, source: 'unknown', terms: [], stacked_evidence_count: 0 }
}

function dealLayer(row) {
  const eq = equityEvidence(row)
  let equityTerm
  if (eq.known) equityTerm = Math.max(0, Math.min(100, eq.percent))
  else if (eq.class === 'high') equityTerm = 70
  else if (eq.class === 'low') equityTerm = DEAL_TERMS.equity_low
  else equityTerm = DEAL_TERMS.equity_unknown
  const valueKnown = num(row.estimated_value) !== null && num(row.estimated_value) > 0
  const valueTerm = valueKnown ? DEAL_TERMS.value_known : DEAL_TERMS.value_unknown
  return { score: r2(DEAL_TERMS.equity_weight * equityTerm + DEAL_TERMS.value_weight * valueTerm), equity: eq, value_known: valueKnown }
}

function marketLayer(market, response) {
  const base = clamp100(market?.score)
  const pts = num(response?.points)
  const score = Math.max(0, Math.min(100, (base ?? MARKET_PRIOR) + (pts ?? 0)))
  return { score: r2(score), market_quality: base, used_prior: base === null, response_context_points: pts, response_context: response ? { n_eff: response.n_eff, shrunk: response.shrunk, global: response.global, reason: response.reason } : null }
}

/**
 * @param {object} row graph row (+ matching_flags, phone_owner_count when known)
 * @param {{situation?, market?, response?, includeWhy?}} ctx
 */
export function computeCampaignRankV2(row = {}, { situation = null, market = null, response = null, includeWhy = true } = {}) {
  const isEligible = eligible(row)
  const contact = contactConfidence(row)
  const pressure = pressureLayer(row, situation)
  const gate = PRESSURE_GATE_FLOOR + (1 - PRESSURE_GATE_FLOOR) * (contact.score / 100)
  const pressureEff = r2(pressure.score * gate)
  const deal = dealLayer(row)
  const mkt = marketLayer(market, response)
  const W = LAYER_WEIGHTS
  const priority = r2(W.contact * contact.score + W.pressure * pressureEff + W.deal * deal.score + W.market * mkt.score)
  const tier = hasCurrentSituation(situation) ? situation.opportunity_tier : 'UNKNOWN'
  const legacy = clamp100(row.final_acquisition_score ?? row.acquisition_score)
  return {
    ranking_version: CAMPAIGN_RANKING_VERSION,
    property_id: row.property_id ?? null,
    eligible: isEligible,
    rank_source: pressure.source === 'seller_situation_v2' ? 'v2' : pressure.source === 'legacy_fallback' ? 'legacy_fallback' : 'v2_no_situation',
    band: tier, // display only — no longer orders rows
    tier,
    tier_reasons: hasCurrentSituation(situation) ? situation.tier_reasons || [] : [],
    seller_situation: hasCurrentSituation(situation) ? situation.seller_situation : null,
    score: priority,
    priority_score: isEligible ? priority : null,
    contact_score: contact.score,
    layers: {
      contact: { score: contact.score, weight: W.contact, line: contact.line, identity: contact.identity, tag: contact.tag, identity_tier: contact.identity_tier, known_signals: contact.known_signals, evidence: contact.evidence },
      pressure: { score: pressure.score, gate: r2(gate), effective: pressureEff, weight: W.pressure, source: pressure.source, terms: pressure.terms },
      deal: { score: deal.score, weight: W.deal, equity: deal.equity, value_known: deal.value_known },
      market: { ...mkt, weight: W.market },
    },
    coverage: {
      contact_signals_known: contact.known_signals,
      situation: tier !== 'UNKNOWN',
      equity_known: deal.equity.known,
      market_known: !mkt.used_prior,
    },
    score_version: hasCurrentSituation(situation) ? situation.score_version : null,
    input_model_version: hasCurrentSituation(situation) ? situation.input_model_version ?? null : null,
    stacked_evidence_count: pressure.stacked_evidence_count,
    legacy_shadow: { final_acquisition_score: legacy },
    fallback_reason: pressure.source === 'legacy_fallback' ? (situation ? 'seller_situation_tier_unknown' : 'seller_situation_absent') : pressure.source === 'unknown' ? 'no_current_or_legacy_score' : null,
    why: includeWhy ? buildWhyTargeted({ row, situation: hasCurrentSituation(situation) ? situation : null, market, contact }) : undefined,
  }
}

function idKey(row) {
  return String(row?.property_id ?? row?.graph_id ?? '')
}

/** Total order: eligible first, priority desc, contact desc, property id asc. */
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
  const ca = num(ra?.contact_score) ?? -Infinity
  const cb = num(rb?.contact_score) ?? -Infinity
  if (ca !== cb) return cb - ca
  return idKey(a).localeCompare(idKey(b))
}

/** Distinct owners per phone inside a cohort (shared-phone ambiguity), set-based. */
export function annotatePhoneOwnerCounts(rows = []) {
  const owners = new Map()
  for (const r of rows) {
    const p = String(r.canonical_e164 ?? '').trim()
    const o = String(r.master_owner_id ?? '').trim()
    if (!p || !o) continue
    if (!owners.has(p)) owners.set(p, new Set())
    owners.get(p).add(o)
  }
  return rows.map((r) => {
    const p = String(r.canonical_e164 ?? '').trim()
    if (!p || r.phone_owner_count !== undefined) return r
    return { ...r, phone_owner_count: owners.get(p)?.size ?? null }
  })
}

export function rankCampaignRowsV2(rows = [], { situations = null, marketFor = null, responseFor = null, includeWhy = false } = {}) {
  const ranked = annotatePhoneOwnerCounts(rows || []).map((row) => {
    const situation = situations instanceof Map ? situations.get(String(row.property_id)) ?? null : null
    const market = typeof marketFor === 'function' ? marketFor(row) : null
    const response = typeof responseFor === 'function' ? responseFor(row) : null
    return { ...row, _rank_v2: computeCampaignRankV2(row, { situation, market, response, includeWhy }) }
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
    tier: rank.tier,
    priority_score: rank.priority_score,
    layers: {
      contact: rank.layers.contact.score,
      pressure: rank.layers.pressure.score,
      pressure_effective: rank.layers.pressure.effective,
      deal: rank.layers.deal.score,
      market: rank.layers.market.score,
      response_context_points: rank.layers.market.response_context_points,
    },
    equity: { known: rank.layers.deal.equity.known, class: rank.layers.deal.equity.class, rule: rank.layers.deal.equity.rule },
    score_version: rank.score_version,
    input_model_version: rank.input_model_version,
    fallback_reason: rank.fallback_reason ?? null,
    legacy_shadow: rank.legacy_shadow,
    why: Array.isArray(rank.why) ? rank.why.map((w) => w.label) : undefined,
  }
}
