// ─── MAO + OPENING OFFER PLAN (8.5.20-b, owner directive Phase 6) ────────────
// planOffer() — pure, INTERNAL ONLY. The MAO is a CEILING, never the opening, and an
// AI MAO is a recommendation, never permission: money reaches a seller only through a
// granted negotiation envelope (8.5.19 decidePosition), and this plan only PROPOSES one.
//
// REUSE, NOT A SECOND VALUATION ENGINE. Every value number is read from the Decision
// Engine's own row and gates:
//   as-is value            property_acquisition_scores.valuation_mid (+ low / high)
//   investor value         property_acquisition_scores.investor_ceiling_mid
//   MAO                    evaluateOfferReadiness ∧ resolveValuationSpendability
//                          (= evidence.offer_calculation.effective_authorized_ceiling)
//   target (engine offer)  recommended_cash_offer (assignment-margin policy applied)
//   margins                evidence.offer_calculation.assignment_margin_policy
//                          (resolveTargetAssignmentMargin) — target / protected margin
//   cost stack (reference) OFFER_COSTS (modelConstants) on the engine's as-is value —
//                          explanatory decomposition of the engine's discount, never a price
//   repairs                the engine's estimated_repairs (lane note: owner lanes say SFR
//                          investor value carries NO repairs; repairs belong to the MLS ARV lane)
//   retail ARV             properties.arv_estimate — a SEPARATE cross-check lane only
//   as-is anchor           computeAsIsAnchor (Seller Autopilot v2) — reported, not overriding
//
// OPENING RANGE (strategy-based, never one universal lowball %): a discount from the
// engine's target built from listed factors — evidence strength, market support, seller
// flexibility (fact ledger only), and where the seller's ask sits — each with its reason.
// INVARIANTS (tests/critical/property-research-offer-plan.test.mjs):
//   • opening.recommended < MAO, always (strictly);  • opening ≤ envelope max when given;
//   • no MAO ⇒ no opening (available:false — never a fabricated number);
//   • protected attributes are stripped before anything is read.
import { stripProtectedAttributes, resolveEconomicsLane, sellerFlexibilitySignals, buyerDemandLevel } from '../opportunity-economics/classify-opportunity.js'
import { OFFER_COSTS } from '../../acquisition/modelConstants.js'
import { evaluateOfferReadiness } from '../../acquisition/offerReadiness.js'
import { resolveValuationSpendability } from '../seller-flow/valuation-offer-authority.js'
import { roundAnchorDown, computeAsIsAnchor } from '../seller-flow/seller-autopilot-v2.js'
import { assessDealEconomics, DEAL_ECONOMICS_VERDICTS } from '../inbox/deal-economics-gate.js'
import { field } from './provenance.js'
import { indicativeInvestorBand } from '../zip-intelligence/zip-prior.js'

export const OFFER_PLAN_VERSION = 'offer-plan.v1'

/** Strategy knobs (reviewed constants; a change is a versioned PR). */
export const OPENING_STRATEGY = Object.freeze({
  base_discount: 0.04,
  evidence_moderate: 0.02, // valuation_confidence 60-74 or 5-7 comps
  evidence_weak: 0.04, // < 60 or < 5 comps (the engine still authorised money)
  demand_strong: -0.01,
  demand_weak: 0.02,
  demand_unknown: 0.01,
  flexibility_per_signal: 0.01,
  flexibility_max: 0.04,
  ask_inside_authority: -0.01, // seller between our target and MAO: do not lowball a close seller
  min_discount: 0.02,
  max_discount: 0.15,
  range_width: 0.05, // low end of the range = recommended − 5 % of target
  /** Temporary, configurable fair-offer guardrail (owner 10-07): opening ≥ investor price × 0.75. */
  opening_floor_fraction_of_investor_value: 0.75,
  /** SFR owner lane reference (owner 10-07): investor cluster × (1 − 13 %). Reported only. */
  sfr_lane_discount: 0.13,
  far_above_mao: 0.3,
})

const num = (v) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const pos = (v) => { const n = num(v); return n != null && n > 0 ? n : null }
const r0 = (n) => (n == null ? null : Math.round(n))
const r4 = (n) => (n == null ? null : Math.round(n * 10000) / 10000)
const iso = (v) => { const t = Date.parse(String(v ?? '')); return Number.isFinite(t) ? new Date(t).toISOString() : null }

/** Largest rounded amount STRICTLY below `cap` (anchor rounding first, then $500 / $100 steps). */
export function strictlyBelow(amount, cap) {
  const c = num(cap)
  let a = num(amount)
  if (a == null || c == null || c <= 0) return null
  if (a >= c) a = c - 1
  for (const r of [roundAnchorDown(a), Math.floor(a / 500) * 500, Math.floor(a / 100) * 100, Math.floor(a)]) {
    if (r != null && r > 0 && r < c) return r
  }
  return null
}

function evidenceStrength(valuation) {
  const conf = num(valuation?.valuation_confidence)
  const comps = num(valuation?.comp_count)
  if (conf != null && conf >= 75 && comps != null && comps >= 8) return 'strong'
  if (conf != null && conf >= 60 && comps != null && comps >= 5) return 'moderate'
  return 'weak'
}

/**
 * @param {object} a
 * @param {object|null} a.valuation   property_acquisition_scores row (the engine's)
 * @param {object} [a.property]       properties subset (lane, arv_estimate)
 * @param {{ amount:number }|null} [a.ask]  the seller's current stated price
 * @param {Array<{amount:number}>} [a.ask_history]
 * @param {object} [a.facts]          conversation-ai factSummary (flexibility signals)
 * @param {object|null} [a.market]    { investor_count, unclassified_count, priced_sales } (market support)
 * @param {{ max_price:number }|null} [a.envelope]  a granted envelope for this scope, if any
 * @param {object|null} [a.zip_prior]  8.5.21-b: zip-prior.resolveZipPrior() for the subject (labelled market prior)
 * @param {number|string} [a.now]
 */
export function planOffer(input = {}) {
  const { value: a, stripped } = stripProtectedAttributes(input || {})
  const nowMs = typeof a.now === 'number' ? a.now : Date.parse(a.now || '') || Date.now()
  const v = a.valuation || null
  const vAt = iso(v?.computed_at)
  const lane = resolveEconomicsLane(a.property || {}, v)
  const readiness = evaluateOfferReadiness(v, { now: nowMs })
  const spend = resolveValuationSpendability({ valuation: v })
  const oc = v?.evidence?.offer_calculation || {}
  const policy = oc.assignment_margin_policy || {}
  const E = (src, conf, kind = 'derived') => ({ source: src, as_of: vAt, confidence: conf, kind })

  const asIs = pos(v?.valuation_mid)
  const investorValue = pos(v?.investor_ceiling_mid)
  const repairs = num(v?.estimated_repairs) ?? num(oc.estimated_repairs)
  const exitRef = asIs
  const costStack = exitRef ? {
    transaction: r0(exitRef * (OFFER_COSTS.buyer_closing_pct + OFFER_COSTS.buyer_disposition_pct)),
    carrying: r0(exitRef * OFFER_COSTS.buyer_holding_pct),
    risk: r0(exitRef * OFFER_COSTS.contingency_pct),
  } : null
  const arv = pos(a.property?.arv_estimate)

  const values = {
    as_is_value: field(asIs, E('public.property_acquisition_scores.valuation_mid', 0.75)),
    as_is_range: field(pos(v?.valuation_low) && pos(v?.valuation_high) ? [pos(v.valuation_low), pos(v.valuation_high)] : null, E('public.property_acquisition_scores.valuation_low/high', 0.6)),
    investor_value: field(investorValue, E('public.property_acquisition_scores.investor_ceiling_mid', 0.6)),
    retail_arv_cross_check: field(arv && ['sfr', 'mf_2_4'].includes(lane.lane) ? { arv, net_of_engine_repairs: repairs != null ? r0(arv - repairs) : null, lane: 'mls_arv_separate_lane_cross_check_only' } : null, { source: 'public.properties.arv_estimate', as_of: null, confidence: 0.35, kind: 'derived' }),
    condition_adjustment: field(repairs, E('public.property_acquisition_scores.estimated_repairs', 0.5)),
    development_costs: field(null, { source: 'none:no_construction_cost_source', as_of: null, confidence: 0, kind: 'derived' }),
  }
  const costs = {
    transaction_costs: field(costStack?.transaction ?? null, E(`engine:OFFER_COSTS(buyer_closing_pct+buyer_disposition_pct)×valuation_mid`, 0.5)),
    carrying_costs: field(costStack?.carrying ?? null, E('engine:OFFER_COSTS.buyer_holding_pct×valuation_mid', 0.5)),
    risk_reserve: field(costStack?.risk ?? null, E('engine:OFFER_COSTS.contingency_pct×valuation_mid', 0.5)),
    investor_margin_target: field(num(policy.target_margin) ?? num(oc.target_assignment_fee), E('engine:assignmentMarginPolicy.target_margin', 0.7)),
    investor_margin_protected: field(num(policy.protected_margin) ?? num(oc.protected_margin), E('engine:assignmentMarginPolicy.protected_margin', 0.7)),
  }

  const notes = []
  // OWNER QUESTION (unresolved, 8.5.21): the engine's SFR rows subtract repairs (0.7 × value − repairs)
  // while the binding SFR lane says "LLC investor cluster −13 %, no repairs". Flagged, never changed here.
  if (lane.lane === 'sfr' && repairs > 0) notes.push('lane_note:engine_applies_repairs_on_sfr_owner_lane_says_investor_value_carries_no_repairs', 'owner_question:sfr_repairs_in_engine_formula_unresolved')
  if (lane.lane === 'land') notes.push('lane_note:land_needs_land_comps_and_entitlement_no_construction_cost_source')

  // 8.5.21-b: the labelled ZIP × type × condition × value prior (county / metro / state fallback).
  // Context only: it never sets the MAO, the target or the opening.
  const zp = a.zip_prior || null
  const valueRef = asIs ? { value: asIs, source: 'public.property_acquisition_scores.valuation_mid', as_of: vAt } : pos(a.property?.estimated_value) ? { value: pos(a.property.estimated_value), source: 'public.properties.estimated_value (recorded AVM)', as_of: null } : null
  const market_prior = zp?.available
    ? { available: true, level: zp.level, label: zp.label, precision: zp.precision, investor_discount_band: zp.investor_discount_band, sample_size: zp.sample_size ?? null, confidence: zp.confidence ?? null, as_of: zp.last_update ?? null, source: zp.source || 'public.zip_acquisition_economics', cell: zp.cell || null, liquidity: zp.liquidity ?? null, indicative: indicativeInvestorBand(zp, valueRef), role: 'context_not_an_offer' }
    : { available: false, reason: zp?.reason || 'zip_prior_not_loaded' }

  const base = {
    version: OFFER_PLAN_VERSION,
    visibility: 'internal_only',
    seller_facing: false,
    property_id: v?.property_id ? String(v.property_id) : null,
    lane: lane.lane,
    computed_at: new Date(nowMs).toISOString(),
    engine: { snapshot_id: v?.evidence?.immutable_snapshot_id ?? v?.id ?? null, computed_at: vAt, decision_tier: v?.decision_tier ?? null, offer_ready: readiness.ready, offer_ready_reason: readiness.reason, spendable: spend.spendable, spendability_reason: spend.reason },
    values,
    costs,
    market_prior,
    notes,
    ignored: { protected_attributes_stripped: stripped },
  }

  const mao = readiness.ready && spend.spendable ? readiness.mao : null
  const target = readiness.ready && spend.spendable ? readiness.offer : null
  if (!mao || !target) {
    // engine evidence is thin: the prior is the operator's context (labelled), never a price
    if (market_prior.available) notes.push(`market_prior_available:${market_prior.label}:${market_prior.precision}:operator_context_only`)
    return { ...base, available: false, reason: !v ? 'no_engine_valuation' : !readiness.ready ? `not_offer_ready:${readiness.reason}` : `not_spendable:${spend.reason}`, mao: null, opening: null, counter_room: null, escalation: null, recommendation: 'operator_must_price_or_rerun_engine' }
  }

  // ── strategy factors (each listed with its reason) ──
  const factors = [{ factor: 'base', effect: OPENING_STRATEGY.base_discount, reason: 'open below the engine target ("open below range")' }]
  const strength = evidenceStrength(v)
  if (strength === 'moderate') factors.push({ factor: 'evidence_moderate', effect: OPENING_STRATEGY.evidence_moderate, reason: `valuation_confidence ${num(v.valuation_confidence)} / ${num(v.comp_count)} comps` })
  if (strength === 'weak') factors.push({ factor: 'evidence_weak', effect: OPENING_STRATEGY.evidence_weak, reason: `valuation_confidence ${num(v.valuation_confidence)} / ${num(v.comp_count)} comps: keep counter room` })
  const demand = buyerDemandLevel({ valuation: v, market: a.market || null })
  if (demand.level === 'strong') factors.push({ factor: 'market_support_strong', effect: OPENING_STRATEGY.demand_strong, reason: demand.evidence.join(';') })
  else if (demand.level === 'weak') factors.push({ factor: 'market_support_weak', effect: OPENING_STRATEGY.demand_weak, reason: demand.evidence.join(';') })
  else if (demand.level === 'unknown') factors.push({ factor: 'market_support_unknown', effect: OPENING_STRATEGY.demand_unknown, reason: 'buyer demand unknown (never treated as weak or strong)' })
  const flex = sellerFlexibilitySignals(a.facts || {}, a.ask_history || [])
  if (flex.score) factors.push({ factor: 'seller_flexibility', effect: Math.min(OPENING_STRATEGY.flexibility_max, flex.score * OPENING_STRATEGY.flexibility_per_signal), reason: flex.signals.join(';') })
  // an ask the deal-economics gate calls implausibly low (a rent, a typo, a parse error) is never
  // agreed to and never shapes the opening: it must be confirmed with the seller first
  const rawAsk = pos(a.ask?.amount)
  const askVerdict = rawAsk ? assessDealEconomics({ ask: rawAsk, valuation: v, property: { ...(a.property || {}), units_count: lane.units } }) : null
  const askImplausible = askVerdict?.verdict === DEAL_ECONOMICS_VERDICTS.IMPLAUSIBLY_LOW
  const ask = askImplausible ? null : rawAsk
  if (askImplausible) notes.push(`ask_ignored:${askVerdict.rule}:confirm_asking_price`)
  if (ask && ask > target && ask <= mao) factors.push({ factor: 'ask_inside_authority', effect: OPENING_STRATEGY.ask_inside_authority, reason: 'seller already between our target and the ceiling' })
  const raw = factors.reduce((s, f) => s + f.effect, 0)
  const discount = Math.min(OPENING_STRATEGY.max_discount, Math.max(OPENING_STRATEGY.min_discount, raw))

  const envMax = pos(a.envelope?.max_price)
  const cap = envMax ? Math.min(envMax, mao) : mao
  let high = strictlyBelow(target * (1 - discount), mao)
  if (envMax && high > envMax) high = strictlyBelow(envMax, envMax + 1) // ≤ envelope max (envelope max itself may equal MAO: strictly-below-MAO holds via the first cap)
  if (high != null && high >= mao) high = strictlyBelow(high, mao)
  let low = high != null ? roundAnchorDown(Math.max(1, high - target * OPENING_STRATEGY.range_width)) : null
  const investorRef = investorValue ?? asIs
  const floor = investorRef ? r0(investorRef * OPENING_STRATEGY.opening_floor_fraction_of_investor_value) : null
  const floorConflict = floor != null && floor >= mao
  if (floor != null && !floorConflict && high != null) {
    // the guardrail is rounded UP to $100 and applied only while it stays strictly under the ceiling
    const f = Math.ceil(floor / 100) * 100
    if (f < mao && high < f) high = f
    if (f < mao && envMax && high > envMax) high = strictlyBelow(envMax, envMax + 1)
    if (low != null && low < f) low = Math.min(f, high)
  }
  if (floorConflict) notes.push('fair_offer_floor_at_or_above_engine_mao:operator_review')

  let recommendation = askImplausible ? 'confirm_asking_price_before_any_offer' : 'propose_envelope'
  if (ask && ask <= high) { recommendation = 'seller_ask_at_or_below_opening:agree_at_seller_price'; high = Math.min(high, Math.floor(ask)); low = Math.min(low, high) }
  else if (ask && ask > mao * (1 + OPENING_STRATEGY.far_above_mao)) recommendation = 'price_gap_nurture_before_offering'

  // as-is anchor (Autopilot v2) — reference only
  const anchor = lane.lane === 'sfr' ? computeAsIsAnchor({ comps: v?.evidence?.selected_comps || [], mao, now: nowMs }) : null
  // SFR owner-lane reference (investor cluster × (1 − 13 %)) vs the engine's ceiling
  const sfrRef = lane.lane === 'sfr' && investorValue ? r0(investorValue * (1 - OPENING_STRATEGY.sfr_lane_discount)) : null
  const laneCheck = sfrRef ? { owner_lane_reference: sfrRef, engine_mao: mao, engine_vs_reference_pct: r4(mao / sfrRef - 1), conformance: Math.abs(mao / sfrRef - 1) <= 0.1 ? 'aligned_within_10pct' : mao < sfrRef ? 'engine_mao_below_owner_lane_reference' : 'engine_mao_above_owner_lane_reference' } : null

  if (high == null || !(high < mao) || (envMax && high > envMax)) {
    return { ...base, available: false, reason: 'no_opening_strictly_below_ceiling', mao: null, opening: null, counter_room: null, escalation: null, recommendation: 'operator_must_price' }
  }
  const roomUsd = mao - high
  return {
    ...base,
    available: true,
    reason: 'engine_offer_ready',
    recommendation,
    mao: { amount: r0(mao), role: 'ceiling_not_opening', source: 'engine:evidence.offer_calculation.effective_authorized_ceiling', basis: oc.ceiling_basis || null, as_of: vAt, permission: 'recommendation_only_requires_granted_envelope' },
    target: { amount: r0(target), source: 'public.property_acquisition_scores.recommended_cash_offer' },
    opening: {
      recommended: high,
      range: [low, high],
      discount_from_target: r4(discount),
      raw_factor_sum: r4(raw),
      factors,
      fair_offer_floor: floor,
      fair_offer_floor_conflict: floorConflict,
      as_is_anchor_reference: anchor?.ok ? { amount: anchor.amount, rule: anchor.rule } : anchor ? { unavailable: anchor.reason } : null,
    },
    counter_room: { usd: r0(roomUsd), pct_of_ceiling: r4(roomUsd / mao), envelope_cap: envMax ? r0(cap) : null },
    escalation: {
      hard_ceiling: r0(mao),
      review_above: r0(target),
      conditions: [
        'seller_counter_above_ceiling',
        'seller_terms_outside_envelope (closing window, earnest money, repairs, contingencies, creative structure)',
        'engine_underwriting_changed_since_grant',
        'valuation_older_than_offer_ready_window',
        'new_sold_evidence_moves_value_more_than_5pct',
        'seller_accepts (contract is an operator act)',
      ],
    },
    lane_check: laneCheck,
    market_prior_check: market_prior.available && market_prior.indicative?.price_band ? { engine_mao: r0(mao), indicative_investor_band: market_prior.indicative.price_band, position: mao < market_prior.indicative.price_band[0] ? 'engine_mao_below_market_band' : mao > market_prior.indicative.price_band[1] ? 'engine_mao_above_market_band' : 'engine_mao_inside_market_band', level: market_prior.level } : null,
    seller: { ask: rawAsk ? r0(rawAsk) : null, ask_used: Boolean(ask), ask_verdict: askVerdict?.verdict ?? null, ask_vs_ceiling_pct: rawAsk ? r4(rawAsk / mao - 1) : null, flexibility: flex },
    market_support: { level: demand.level, evidence: demand.evidence },
    reconciliation: asIs ? { as_is_value: r0(asIs), engine_ceiling: r0(mao), implied_discount_usd: r0(asIs - mao), engine_repairs: repairs, reference_cost_stack_usd: costStack ? costStack.transaction + costStack.carrying + costStack.risk : null, margin_target_usd: num(policy.target_margin) ?? null } : null,
  }
}

/** The fields of a plan a PROPOSED envelope may carry (operator-only). */
export function envelopeTermsFromPlan(plan) {
  if (!plan?.available) return null
  return { opening_price: plan.opening.recommended, opening_range: plan.opening.range, ceiling: plan.mao.amount, review_above: plan.escalation.review_above, escalation_conditions: plan.escalation.conditions, counter_room_usd: plan.counter_room.usd, strategy_factors: plan.opening.factors.map((f) => f.factor) }
}
