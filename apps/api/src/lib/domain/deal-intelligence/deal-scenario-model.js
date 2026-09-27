/**
 * DEAL SCENARIO MODEL — the acquisition engine's cash-offer arithmetic, replayed.
 *
 * This is NOT a second pricing model. It re-runs the exact steps of
 * `offerCalculation()` in acquisitionDecisionEngine.js — same ceiling
 * authority, same assignment-margin policy (imported, not copied), same
 * haircut / motivation / demand terms, same $100 rounding — from the inputs
 * the engine itself recorded in `evidence.offer_calculation`.
 *
 * Two uses:
 *   1. REPLAY: run the recorded inputs and compare with the stored offer. A
 *      mismatch means the stored row was produced by different arithmetic
 *      (older engine, V3 surfacing) and the scenario lab must say so instead of
 *      pretending its numbers are the engine's.
 *   2. SCENARIO: change value / repairs / margin floor / valuation confidence
 *      and see what the SAME policy would recommend. Nothing is persisted;
 *      the system baseline is never overwritten.
 *
 * The dashboard carries a TypeScript port (deal-scenario-model.ts) pinned to
 * the same test vectors (tests/critical/deal-decision-model.test.mjs).
 */
import { resolveTargetAssignmentMargin } from '@/lib/acquisition/assignmentMarginPolicy.js'
import { resolveEffectiveAuthorizedCeiling } from '@/lib/acquisition/buyerCeilingAuthority.js'

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
/** The engine's local roundMoney: nearest $100. */
const round100 = (v) => (num(v) === null ? null : Math.round(Number(v) / 100) * 100)

/** Pull the replayable inputs out of a `property_acquisition_scores` row. */
export function scenarioInputsFromScore(score) {
  const ev = score?.evidence && typeof score.evidence === 'object' ? score.evidence : {}
  const oc = ev.offer_calculation && typeof ev.offer_calculation === 'object' ? ev.offer_calculation : null
  if (!oc || oc.method !== 'repair_adjusted_exit_ceiling_less_assignment_target') return null
  const policy = oc.assignment_margin_policy || {}
  const pin = policy.inputs || {}
  const valuationMid = num(score.valuation_mid)
  const valuationConfidence = num(pin.valuation_confidence) ?? num(score.valuation_confidence)
  if (!valuationMid || valuationMid <= 0) return null
  return {
    valuation_mid: valuationMid,
    valuation_confidence: valuationConfidence ?? 0,
    repairs: num(oc.estimated_repairs) ?? num(score.estimated_repairs) ?? 0,
    max_arv_factor: num(oc.max_arv_factor) ?? 0.7,
    behavior_ceiling: num(oc.behavior_based_ceiling),
    buyer_ceiling_authoritative: oc.buyer_ceiling_authoritative === true,
    asset_family: pin.asset_family ?? 'UNKNOWN',
    unit_count: num(score?.evidence?.subject?.units) ?? null,
    buyer_demand_score: num(pin.buyer_demand_score) ?? num(score.buyer_demand_score) ?? 0,
    liquidity_score: num(pin.liquidity_score) ?? num(score.liquidity_score) ?? 0,
    minimum_margin_floor: num(pin.minimum_margin_floor) ?? num(policy.minimum_margin) ?? 15000,
    motivation_score: num(oc.motivation?.score) ?? 0,
  }
}

/** One pass of the engine's offer arithmetic. Pure. */
export function computeScenarioOffer(inputs) {
  const i = inputs
  const valuationCeiling = Math.max(0, i.valuation_mid * i.max_arv_factor - i.repairs)
  const ceiling = resolveEffectiveAuthorizedCeiling({
    valuation_based_ceiling: valuationCeiling,
    behavior_based_ceiling: i.behavior_ceiling,
    buyer_ceiling_authority: { authoritative: i.buyer_ceiling_authoritative },
  })
  const effective = ceiling.effective_authorized_ceiling
  const policy = resolveTargetAssignmentMargin({
    effective_authorized_ceiling: effective,
    asset_family: i.asset_family,
    unit_count: i.unit_count,
    buyer_demand_score: i.buyer_demand_score,
    liquidity_score: i.liquidity_score,
    confidence: null,
    valuation_confidence: i.valuation_confidence,
    buyer_ceiling_authoritative: i.buyer_ceiling_authoritative,
    minimum_margin_floor: i.minimum_margin_floor,
    market_adjustments_applied_by_caller: true,
  })
  const confidenceHaircut = ((100 - i.valuation_confidence) / 100) * 0.06
  const motivationDiscount = (i.motivation_score / 100) * 0.035
  const demandPremium = ((i.buyer_demand_score + i.liquidity_score) / 200) * 0.015
  const marketAdjusted = effective * (1 - confidenceHaircut - motivationDiscount + demandPremium) - policy.target_margin
  const protectedCap = effective - policy.protected_margin
  const recommended = Math.max(0, round100(Math.min(marketAdjusted, protectedCap)))
  const band = Math.max(5000, i.valuation_mid * 0.03)
  return {
    valuation_ceiling: round100(valuationCeiling),
    effective_ceiling: round100(effective),
    ceiling_basis: ceiling.basis,
    target_margin: policy.target_margin,
    protected_margin: policy.protected_margin,
    margin_pct: policy.margin_pct,
    recommended_offer: recommended,
    minimum_offer: Math.max(0, round100(recommended - band)),
    expected_fee: Math.max(0, round100(effective - recommended)),
    protected_margin_enforced: marketAdjusted > protectedCap,
    terms: {
      confidence_haircut_pct: Math.round(confidenceHaircut * 10000) / 100,
      motivation_discount_pct: Math.round(motivationDiscount * 10000) / 100,
      demand_premium_pct: Math.round(demandPremium * 10000) / 100,
    },
  }
}

/** Does replaying the recorded inputs reproduce the stored offer? */
export function replayStoredOffer(score) {
  const inputs = scenarioInputsFromScore(score)
  if (!inputs) return { replayable: false, reason: 'offer_calculation_missing', inputs: null, result: null }
  const result = computeScenarioOffer(inputs)
  const stored = num(score.recommended_cash_offer)
  const storedFloor = num(score.minimum_acceptable_offer)
  const delta = stored === null ? null : result.recommended_offer - stored
  // ±$100 = one rounding step on an input the engine recorded to 2dp.
  const matches = delta !== null && Math.abs(delta) <= 100
    && (storedFloor === null || Math.abs(result.minimum_offer - storedFloor) <= 100)
  return {
    replayable: matches,
    reason: matches ? null : stored === null ? 'stored_offer_missing' : 'replay_differs_from_stored',
    delta,
    inputs,
    result,
  }
}

/**
 * Sensitivity: how the recommended offer moves when ONE input moves, all
 * else at the recorded baseline. Deterministic, so the UI can state it.
 */
export function offerSensitivity(inputs) {
  if (!inputs) return []
  const base = computeScenarioOffer(inputs).recommended_offer
  const probe = (key, label, patch) => {
    const next = computeScenarioOffer({ ...inputs, ...patch }).recommended_offer
    return { key, label, offer: next, delta: next - base }
  }
  const v = inputs.valuation_mid
  const r = inputs.repairs
  return [
    probe('value_down_5', 'Value −5%', { valuation_mid: v * 0.95 }),
    probe('value_up_5', 'Value +5%', { valuation_mid: v * 1.05 }),
    probe('repairs_up_10k', 'Repairs +$10K', { repairs: r + 10000 }),
    probe('repairs_down_10k', 'Repairs −$10K', { repairs: Math.max(0, r - 10000) }),
    probe('confidence_down_10', 'Valuation confidence −10', { valuation_confidence: Math.max(0, inputs.valuation_confidence - 10) }),
    probe('margin_floor_up_5k', 'Margin floor +$5K', { minimum_margin_floor: inputs.minimum_margin_floor + 5000 }),
  ]
}
