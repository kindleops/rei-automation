// ─── OPPORTUNITY ECONOMICS (8.5.19, owner directive 2026-10-15 Phase 9) ──────
// Is this seller conversation worth working, and how hard?
//
//   HOT          the seller's number is at or under our authoritative MAO, the
//                valuation is credible AND current, buyer demand is evidenced and
//                execution is not high-complexity. Every condition is positive
//                evidence — HOT is never a default.
//   NEGOTIATE    a deal is plausible: the ask is near our authority, or under
//                value without an authoritative MAO yet.
//   NURTURE      a real price gap (ask above our authority / the lane's value
//                bands). Kept warm, never Priority (feedback_valuation_lanes,
//                deal-economics-gate).
//   PASS         economically impossible on the evidence (e.g. a raw lot asking
//                more than finished homes sell for, under single-family zoning;
//                an ask above 1.5x a credible retail ARV).
//   INVESTIGATE  the evidence is insufficient or conflicted. The DEFAULT when we
//                cannot tell — never HOT.
//
// REUSE, NOT A SECOND VALUATION. Every number comes from an existing engine:
//   lane                classifyAssetLane (acquisition/assetClassification.js)
//   value + band        resolveReferenceValue / assessDealEconomics (inbox/deal-economics-gate.js —
//                       the binding lanes: SFR investor value, MLS ARV separate, MF 2-4 same-unit,
//                       MF 5+ per door; the PAS row is already per-lane)
//   MAO                 evaluateOfferReadiness + resolveValuationSpendability (the only spendable
//                       ceiling: evidence.offer_calculation.effective_authorized_ceiling)
//   costs + margin      OFFER_COSTS (modelConstants) and resolveTargetAssignmentMargin
//   price plausibility  assessDealAmount (opportunity/stage-advance-guard.js)
//
// WHAT IS DELIBERATELY NOT AN INPUT
//   responsiveness  (fast replies ≠ opportunity) — recorded as ignored
//   assertiveness   (a firm tone is not penalised) — no tone input exists
//   protected classes (fair housing) — stripped before anything is read
//
// Pure and deterministic: same input → same output. The service (economics-service.js)
// does the read-only loading.
import { classifyAssetLane } from '../../acquisition/assetClassification.js'
import { ASSET_LANES, LANE_FAMILY, OFFER_COSTS } from '../../acquisition/modelConstants.js'
import { evaluateOfferReadiness, OFFER_READY_REASONS } from '../../acquisition/offerReadiness.js'
import { resolveTargetAssignmentMargin } from '../../acquisition/assignmentMarginPolicy.js'
import { resolveValuationSpendability } from '../seller-flow/valuation-offer-authority.js'
import { assessDealEconomics, resolveReferenceValue, DEAL_ECONOMICS_VERDICTS as V } from '../inbox/deal-economics-gate.js'
import { assessDealAmount } from '../opportunity/stage-advance-guard.js'

export const ECONOMICS_VERSION = 'opportunity-economics.v1'
export const ECONOMICS_CLASSES = Object.freeze(['HOT', 'NEGOTIATE', 'NURTURE', 'PASS', 'INVESTIGATE'])

export const ECONOMICS_RULES = Object.freeze({
  /** A raw lot is a fraction of a finished home; above this share of the finished value it needs land analysis. */
  land_residual_share: 0.35,
  /** Over the authoritative MAO by at most this fraction → negotiable. */
  negotiate_gap: 0.15,
  /** … and up to this fraction when the seller shows flexibility. */
  negotiate_gap_flexible: 0.30,
  /** Buyer-demand score bands (0-100, engine scale). */
  demand_strong: 60,
  demand_moderate: 40,
  /** Market evidence: this many investor purchases near the subject counts as demand. */
  market_investor_min: 3,
  complexity_high: 4,
  complexity_medium: 2,
})

/** Fair housing: never read, never priced. Matched on key names anywhere in the seller / context input. */
export const PROTECTED_ATTRIBUTE_KEYS = Object.freeze([
  'age', 'birth_date', 'date_of_birth', 'dob', 'marital_status', 'married', 'spouse', 'race', 'ethnicity', 'color',
  'religion', 'national_origin', 'nationality', 'citizenship', 'sex', 'gender', 'sexual_orientation', 'familial_status',
  'children', 'pregnant', 'disability', 'handicap', 'veteran_status', 'military_status', 'source_of_income', 'language_of_origin',
])
const PROTECTED_RE = new RegExp(`^(${PROTECTED_ATTRIBUTE_KEYS.join('|')})$`, 'i')

const num = (v) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const pos = (v) => { const n = num(v); return n != null && n > 0 ? n : null }
const lower = (v) => String(v ?? '').trim().toLowerCase()
const round = (n) => (n == null ? null : Math.round(n))
const pct = (n) => (n == null ? null : Math.round(n * 1000) / 1000)

/** Deep copy without protected-attribute keys; returns { value, stripped: [paths] }. */
export function stripProtectedAttributes(input) {
  const stripped = []
  const walk = (v, path) => {
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}[${i}]`))
    if (v && typeof v === 'object') {
      const o = {}
      for (const [k, x] of Object.entries(v)) {
        if (PROTECTED_RE.test(k)) { stripped.push(path ? `${path}.${k}` : k); continue }
        o[k] = walk(x, path ? `${path}.${k}` : k)
      }
      return o
    }
    return v
  }
  return { value: walk(input, ''), stripped }
}

/** Canonical economics lane from the acquisition classifier (+ the deal-economics gate's lane for the bands). */
export function resolveEconomicsLane(property = {}, valuation = null) {
  const subject = valuation?.evidence?.subject || {}
  const row = {
    ...property,
    asset_type: property.asset_type ?? subject.asset_type ?? null,
    units_count: property.units_count ?? property.units ?? subject?.normalized_features?.units ?? null,
  }
  const c = classifyAssetLane(row)
  const family = LANE_FAMILY[c.lane] || 'UNKNOWN'
  let lane = 'unknown'
  if (String(c.lane).startsWith('LAND_')) lane = 'land'
  else if (family === 'RESIDENTIAL_SINGLE') lane = 'sfr'
  else if (family === 'SMALL_MULTI') lane = 'mf_2_4'
  else if (family === 'MULTIFAMILY') lane = 'mf_5_plus'
  else if (c.lane !== ASSET_LANES.UNKNOWN) lane = 'commercial_other'
  const units = num(row.units_count)
  return { lane, asset_lane: c.lane, family, units, confidence: c.confidence, conflicts: c.conflicting_signals || [], identity_conflict: subject?.asset_identity_conflict === true }
}

// ── seller-side signals (from the conversation-ai fact ledger summary) ─────────
const URGENT_RE = /\b(asap|soon|quick(ly)?|fast|urgent|this (week|month)|30 days|right away|immediately|need to (sell|move))\b/i
const FLEX_PRICE_TYPES = new Set(['range', 'negotiable', 'obo', 'or_best_offer', 'approximate', 'about'])

/**
 * Seller flexibility from the FACT LEDGER only (never from reply speed or tone).
 * @param {object} facts factSummary(ledger) shape: key → { value, origin, source_message_id }
 * @param {Array<{amount:number}>} askHistory seller-stated asks, chronological
 */
export function sellerFlexibilitySignals(facts = {}, askHistory = []) {
  const signals = []
  const v = (k) => facts?.[k]?.value
  if (v('motivation')) signals.push('motivation_stated')
  const timeline = JSON.stringify(v('timeline') ?? '')
  if (URGENT_RE.test(timeline)) signals.push('urgent_timeline')
  const cond = v('condition')
  if (cond && (cond.repairs || /repair|fix|roof|foundation|needs work|tlc|damage|old/i.test(JSON.stringify(cond)))) signals.push('repairs_disclosed')
  const pt = lower(v('asking_price')?.price_type)
  if (FLEX_PRICE_TYPES.has(pt) || v('asking_price')?.range) signals.push('price_stated_as_range_or_negotiable')
  const amounts = askHistory.map((h) => pos(h?.amount)).filter(Boolean)
  if (amounts.length >= 2 && amounts[amounts.length - 1] < Math.max(...amounts.slice(0, -1))) signals.push('ask_lowered_in_conversation')
  if (v('offer_request')) signals.push('asked_for_our_offer')
  return { score: signals.length, signals }
}

/** Execution complexity + transaction friction → expected operator involvement. */
export function executionComplexity({ facts = {}, lane = 'unknown', complexity = {} } = {}) {
  const factors = []
  const v = (k) => facts?.[k]?.value
  if (/tenant|occupied|renter|lease/i.test(JSON.stringify(v('occupancy') ?? ''))) factors.push('tenant_occupied')
  if (/list|agent|realtor|mls|on the market/i.test(JSON.stringify(v('listing_status') ?? ''))) factors.push('listed_with_agent')
  if (/executor|heir|estate|probate/i.test(JSON.stringify(v('identity_role') ?? '')) || complexity.probate) factors.push('probate_or_heirs')
  if (num(complexity.owners_count) > 1) factors.push('multiple_owners')
  if (complexity.multi_property) factors.push('multiple_properties')
  if (complexity.liens || complexity.foreclosure) factors.push('liens_or_foreclosure')
  if (complexity.title_issue) factors.push('title_issue')
  if (lane === 'mf_5_plus' || lane === 'commercial_other') factors.push('income_asset_underwriting')
  if (lane === 'land') factors.push('land_entitlement_analysis')
  if (lane === 'mf_2_4') factors.push('small_multifamily_rent_verification')
  const weight = { probate_or_heirs: 2, liens_or_foreclosure: 2, title_issue: 2, land_entitlement_analysis: 2, income_asset_underwriting: 2 }
  const score = factors.reduce((s, f) => s + (weight[f] || 1), 0)
  const level = score >= ECONOMICS_RULES.complexity_high ? 'high' : score >= ECONOMICS_RULES.complexity_medium ? 'medium' : 'low'
  const operator_involvement = lane === 'land' ? 'high' : level === 'low' && (lane === 'sfr') ? 'low' : level === 'high' ? 'high' : 'medium'
  return { score, level, factors, operator_involvement }
}

/**
 * Buyer demand from the engine score (0-100) and area investor activity (deal_market_demand).
 * UNKNOWN IS UNKNOWN (feedback_ranking_hierarchy): the engine's no-purchases fallback
 * (investor_ceiling_summary.method = valuation_discount_fallback, the fixed 15/15 scores) and an
 * area sample whose buyers are unclassified carry no demand information — never "weak".
 */
export function buyerDemandLevel({ valuation = null, market = null } = {}) {
  const rawScore = num(valuation?.buyer_demand_score)
  const liquidity = num(valuation?.liquidity_score)
  const summary = valuation?.evidence?.investor_ceiling_summary || null
  const engineFallback = summary?.method === 'valuation_discount_fallback' || (rawScore === 15 && liquidity === 15 && !Array.isArray(summary?.sample_purchases))
  const score = engineFallback ? null : rawScore
  const investorCount = num(market?.investor_count)
  const unclassified = num(market?.unclassified_count)
  const evidence = []
  let level = 'unknown'
  if (engineFallback) evidence.push('engine_demand_fallback_no_buyer_purchases')
  if (score != null) {
    level = score >= ECONOMICS_RULES.demand_strong ? 'strong' : score >= ECONOMICS_RULES.demand_moderate ? 'moderate' : 'weak'
    evidence.push(`engine_buyer_demand_score:${score}`)
  }
  if (investorCount != null) {
    evidence.push(`area_investor_purchases:${investorCount}${unclassified ? `(+${unclassified}_unclassified)` : ''}`)
    if (investorCount >= ECONOMICS_RULES.market_investor_min && (level === 'unknown' || level === 'weak')) level = 'moderate'
    else if (investorCount === 0 && level === 'unknown' && unclassified === 0 && num(market?.priced_sales) >= 8) level = 'weak'
  }
  if (liquidity != null && !engineFallback) evidence.push(`engine_liquidity_score:${liquidity}`)
  return { level, score, liquidity: engineFallback ? null : liquidity, investor_count: investorCount, evidence }
}

const LAND_DENSITY_RE = /\b(r-?[2-9]|rm|r-?m|mf|multi|pud|planned|c-?\d|commercial|mixed|mu-?\d?|townhome|duplex|high density|medium density)\b/i
const LAND_SINGLE_RE = /\b(r-?1|rs-?\d*|sf-?\d*|r1|single[- ]family|rural residential|ag|a-?1|agricultur)\b/i

function landAssessment({ ask, property, market }) {
  const finished = pos(market?.completed_home_median)
  const zoning = String(property?.zoning ?? '').trim()
  const acres = num(property?.lot_acreage) ?? (num(property?.lot_square_feet) != null ? num(property.lot_square_feet) / 43_560 : null)
  const evidence = { finished_home_median: finished, finished_home_source: market?.completed_home_source || null, zoning: zoning || null, lot_acres: acres != null ? Math.round(acres * 100) / 100 : null, is_development_land: property?.is_development_land ?? null }
  const devPotential = property?.is_development_land === true || (zoning && LAND_DENSITY_RE.test(zoning)) || (acres != null && acres >= 2)
  const singleOnly = zoning && LAND_SINGLE_RE.test(zoning) && !devPotential
  if (!finished) return { cls: 'INVESTIGATE', reasons: ['land_no_finished_home_reference'], evidence, missing: ['finished_home_value_near_lot'] }
  const ratio = ask / finished
  evidence.ask_to_finished_home = pct(ratio)
  if (ratio >= 1) {
    if (!zoning && property?.is_development_land == null) return { cls: 'INVESTIGATE', reasons: ['land_ask_at_or_above_finished_home_value', 'zoning_unknown'], evidence, missing: ['zoning'] }
    if (devPotential) return { cls: 'INVESTIGATE', reasons: ['land_ask_at_or_above_finished_home_value', 'development_potential_needs_land_analysis'], evidence, missing: ['entitled_density_and_land_comps'] }
    if (singleOnly) return { cls: 'PASS', reasons: ['land_ask_at_or_above_finished_home_value', 'zoning_single_family_no_development_upside'], evidence, missing: [] }
    return { cls: 'INVESTIGATE', reasons: ['land_ask_at_or_above_finished_home_value', 'zoning_unclassified'], evidence, missing: ['zoning_interpretation'] }
  }
  if (ratio > ECONOMICS_RULES.land_residual_share) {
    return { cls: singleOnly ? 'NURTURE' : 'INVESTIGATE', reasons: ['land_ask_above_typical_lot_share_of_finished_value', ...(singleOnly ? ['zoning_single_family'] : ['zoning_or_density_unverified'])], evidence, missing: singleOnly ? [] : ['zoning'] }
  }
  return { cls: 'INVESTIGATE', reasons: ['land_ask_plausible_needs_land_comps'], evidence, missing: ['land_comps'] }
}

/**
 * @param {object} input
 * @param {{ amount:number, price_type?:string, source_message_id?:string, origin?:string }|null} input.ask
 *        the seller's CURRENT stated price (latest-wins from the fact ledger)
 * @param {Array<{amount:number}>} [input.ask_history] seller-stated asks, chronological
 * @param {object} [input.property]   properties row subset (type, units, zoning, land flags, AVM, ARV)
 * @param {object|null} [input.valuation] property_acquisition_scores row (the engine's per-lane output)
 * @param {{status:string, reason?:string}|null} [input.freshness] decisionAuthority.evaluateDecisionFreshness verdict
 * @param {object|null} [input.market] { completed_home_median, investor_count, priced_sales } (deal_market_demand)
 * @param {object} [input.facts]      conversation-ai factSummary(ledger)
 * @param {object} [input.complexity] { owners_count, probate, multi_property, liens, foreclosure, title_issue }
 * @param {object} [input.responsiveness] accepted and IGNORED (recorded as such)
 * @param {string|number} [input.now]
 */
export function classifyOpportunityEconomics(input = {}) {
  const { value: clean, stripped } = stripProtectedAttributes(input || {})
  const { property = {}, valuation = null, freshness = null, market = null, facts = {}, complexity = {}, ask_history = [] } = clean
  const now = clean.now ?? Date.now()
  const reasons = []
  const missing = []
  const conflicts = []
  const laneInfo = resolveEconomicsLane(property || {}, valuation)
  const lane = laneInfo.lane
  const flex = sellerFlexibilitySignals(facts, ask_history)
  const cx = executionComplexity({ facts, lane, complexity })
  const demand = buyerDemandLevel({ valuation, market })

  // ask (seller-stated, current). Per-door statements are converted with the canonical unit count.
  let ask = pos(clean.ask?.amount)
  const priceType = lower(clean.ask?.price_type)
  if (ask && /per_(unit|door)/.test(priceType)) {
    if (laneInfo.units && laneInfo.units > 1) ask = ask * laneInfo.units
    else { missing.push('unit_count_for_per_door_price'); ask = null }
  }
  const askPlausible = ask ? assessDealAmount(ask, { estimated_value: null, arv: null }) : { plausible: false, rule: 'zero_or_missing' }

  const ref = resolveReferenceValue({ valuation, property })
  const readiness = evaluateOfferReadiness(valuation, { now })
  const spend = resolveValuationSpendability({ valuation })
  const mao = readiness.ready && spend.spendable ? readiness.mao : null
  const fresh = freshness ? lower(freshness.status) === 'current' : ![OFFER_READY_REASONS.STALE, OFFER_READY_REASONS.PREDATES_POLICY, OFFER_READY_REASONS.NOT_SCORED].includes(readiness.reason) && valuation != null
  const credible = ref.confidence === 'credible' && ref.source === 'property_acquisition_scores'
  const econ = ask ? assessDealEconomics({ ask, valuation, property: { ...property, units_count: laneInfo.units } }) : null

  const costs = ask ? round(ask * OFFER_COSTS.buyer_closing_pct) : null
  const buyerExit = pos(valuation?.investor_ceiling_mid)
  const assignment_margin = ask && buyerExit ? round(buyerExit - ask - costs) : null
  const marginPolicy = mao ? resolveTargetAssignmentMargin({
    effective_authorized_ceiling: mao,
    asset_family: laneInfo.family,
    unit_count: laneInfo.units,
    buyer_demand_score: num(valuation?.buyer_demand_score),
    liquidity_score: num(valuation?.liquidity_score),
    confidence: num(valuation?.confidence),
    valuation_confidence: num(valuation?.valuation_confidence),
  }) : null
  const gapToMao = ask && mao ? (ask - mao) / mao : null
  const gapToValue = ask && ref.value ? (ask - ref.value) / ref.value : null

  const metrics = {
    lane, asset_lane: laneInfo.asset_lane, units: laneInfo.units,
    ask: round(ask), ask_source_message_id: clean.ask?.source_message_id || null, ask_origin: clean.ask?.origin || null,
    realistic_value: { mid: round(ref.value), low: round(pos(valuation?.valuation_low)), high: round(pos(valuation?.valuation_high)), retail_arv_lane: round(ref.arv), source: ref.source, confidence: ref.confidence, valuation_confidence: num(valuation?.valuation_confidence), comp_count: num(valuation?.comp_count), conflict: ref.conflict || null },
    decision: { tier: valuation?.decision_tier || null, freshness: freshness?.status || (valuation ? (fresh ? 'age_ok' : 'stale') : 'not_run'), offer_ready: readiness.ready, offer_ready_reason: readiness.reason, spendable: spend.spendable, spendability_reason: spend.reason },
    mao: round(mao),
    recommended_offer: mao ? round(readiness.offer) : null,
    price_gap: { vs_mao_abs: ask && mao ? round(ask - mao) : null, vs_mao_pct: pct(gapToMao), vs_value_abs: ask && ref.value ? round(ask - ref.value) : null, vs_value_pct: pct(gapToValue), verdict: econ?.verdict || null, rule: econ?.rule || null },
    acquisition_costs: { closing_at_ask: costs, basis: `OFFER_COSTS.buyer_closing_pct=${OFFER_COSTS.buyer_closing_pct}` },
    assignment_margin: { at_ask: assignment_margin, buyer_exit: round(buyerExit), minimum_required: marginPolicy ? round(marginPolicy.minimum_margin) : null, expected_assignment_fee: round(pos(valuation?.expected_assignment_fee)) },
    buyer_demand: demand,
    seller_flexibility: flex,
    execution: cx,
  }

  const finish = (cls, extra = {}) => {
    if (!ECONOMICS_CLASSES.includes(cls)) throw new Error(`bad economics class ${cls}`)
    const level = missing.length || conflicts.length || !credible || !fresh ? (cls === 'INVESTIGATE' || !credible ? 'high' : 'medium') : demand.level === 'unknown' ? 'medium' : 'low'
    return {
      version: ECONOMICS_VERSION,
      class: cls,
      reasons: [...new Set(reasons)],
      metrics,
      evidence: {
        valuation_snapshot_id: valuation?.evidence?.immutable_snapshot_id ?? valuation?.id ?? null,
        computed_at: valuation?.computed_at ?? null,
        engines: ['assetClassification.classifyAssetLane', 'deal-economics-gate.assessDealEconomics', 'offerReadiness.evaluateOfferReadiness', 'valuation-offer-authority.resolveValuationSpendability', 'assignmentMarginPolicy.resolveTargetAssignmentMargin'],
        ...extra.evidence,
      },
      uncertainty: {
        level,
        missing: [...new Set(missing)],
        conflicts: [...new Set(conflicts)],
        value_range: metrics.realistic_value.low && metrics.realistic_value.high ? [metrics.realistic_value.low, metrics.realistic_value.high] : null,
      },
      ignored: { responsiveness: clean.responsiveness != null, assertiveness_not_an_input: true, protected_attributes_stripped: stripped },
    }
  }

  // 1 — the seller's number
  if (!ask) { missing.push('asking_price'); reasons.push('no_seller_stated_price'); return finish('INVESTIGATE') }
  if (!askPlausible.plausible) { reasons.push(`ask_not_a_property_price:${askPlausible.rule}`); missing.push('plausible_asking_price'); return finish('INVESTIGATE') }

  // 2 — asset identity
  if (laneInfo.identity_conflict) conflicts.push('asset_identity_conflict')
  if (laneInfo.conflicts.length) conflicts.push(...laneInfo.conflicts.map((c) => `lane:${c}`))
  if (lane === 'land') {
    const land = landAssessment({ ask, property, market })
    reasons.push(...land.reasons)
    missing.push(...land.missing)
    return finish(land.cls, { evidence: { land: land.evidence } })
  }
  if (lane === 'unknown' || laneInfo.identity_conflict) { reasons.push('asset_lane_unknown_or_conflicted'); missing.push('asset_classification'); return finish('INVESTIGATE') }

  // 3 — value evidence
  if (ref.conflict) conflicts.push(ref.conflict)
  if (!valuation) { missing.push('decision_engine_run'); reasons.push('decision_engine_not_run') }
  else if (!fresh) { missing.push('current_decision_engine_run'); reasons.push(`decision_not_current:${freshness?.reason || readiness.reason}`) }
  if (valuation && !credible) { missing.push('credible_valuation'); reasons.push('valuation_low_confidence') }

  if (econ?.verdict === V.IMPLAUSIBLY_LOW) { reasons.push('ask_implausibly_low_vs_value'); missing.push('confirm_asking_price'); return finish('INVESTIGATE') }
  if (econ?.verdict === V.FAR_ABOVE) {
    if (econ.rule === 'above_1_5x_arv' && credible && fresh) { reasons.push('ask_above_1_5x_retail_arv'); return finish('PASS') }
    reasons.push(`price_gap:${econ.rule}`)
    return finish('NURTURE')
  }
  if (!valuation || !fresh || !credible) { reasons.push('insufficient_evidence_for_a_deal_call'); return finish('INVESTIGATE') }

  // 4 — evidence is credible and current
  if (mao) {
    if (ask <= mao) {
      reasons.push('ask_at_or_below_authoritative_mao')
      if (demand.level === 'unknown') { reasons.push('buyer_demand_unknown'); missing.push('buyer_demand'); return finish('NEGOTIATE') }
      if (demand.level === 'weak') { reasons.push('buyer_demand_weak'); return finish('NEGOTIATE') }
      if (cx.level === 'high') { reasons.push('execution_complexity_high'); return finish('NEGOTIATE') }
      if (conflicts.length) { reasons.push('evidence_conflicts_present'); return finish('NEGOTIATE') }
      reasons.push(`buyer_demand_${demand.level}`, `execution_complexity_${cx.level}`)
      return finish('HOT')
    }
    if (gapToMao <= ECONOMICS_RULES.negotiate_gap) { reasons.push('ask_within_15pct_of_mao'); return finish('NEGOTIATE') }
    if (gapToMao <= ECONOMICS_RULES.negotiate_gap_flexible && flex.score > 0) { reasons.push('ask_within_30pct_of_mao_with_seller_flexibility'); return finish('NEGOTIATE') }
    reasons.push('price_gap_above_authority')
    return finish('NURTURE')
  }
  // credible + current value but no spendable MAO: never HOT
  reasons.push(`no_authoritative_mao:${spend.spendable ? readiness.reason : spend.reason}`)
  missing.push('authoritative_mao')
  if (gapToValue <= 0) { reasons.push('ask_at_or_below_realistic_value'); return finish('NEGOTIATE') }
  if (econ?.verdict === V.CREDIBLE && flex.score > 0) { reasons.push('ask_inside_credible_band_with_seller_flexibility'); return finish('NEGOTIATE') }
  reasons.push('ask_above_realistic_value')
  return finish('NURTURE')
}

export default classifyOpportunityEconomics
