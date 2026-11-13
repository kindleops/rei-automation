// ─── LANE VALUATION — pure (8.5.21-b; consumed by the shortlist effort) ───────
// Property facts + comps (+ buyer purchases) IN → a lane-labelled valuation, MAO and opening OUT.
// No I/O, no clock read (now is an input), no write: it runs the EXISTING engine's pure calculation
// (calculateAcquisitionDecision) and the existing offer plan (planOffer), with the SFR lane ceiling
// selectable per call (default: the production formula, i.e. the flag's default — off).
//
//   laneValuation({ property, comps, buyer_purchases, now, sfr_lane: false|true, ask?, zip_prior? })
//   → {
//       lane: 'sfr' | 'mf_2_4' | 'mf_5_plus' | 'land' | 'commercial_other' | 'unknown',
//       formula: 'repair_adjusted_exit_ceiling_less_assignment_target' | 'sfr_llc_investor_cluster_less_13pct',
//       valuation: { as_is_value, low, high, confidence, comp_count, basis: 'sold_comps_repair_differential_adjusted' },
//       investor_cluster: { mid, authoritative, method },
//       mao: number|null (a CEILING, never the opening), mao_source,
//       opening: { recommended, range } | null (strictly below the MAO) , opening_reason,
//       decision_tier, offer_ready, offer_ready_reason,
//       sfr_trace: traceSfrFormulas(...) for SFR (both formulas side by side),
//       owner_question: string|null, notes: string[]
//     }
// Ceiling rules are the engine's; with sfr_lane:true the SFR MAO is
// floor(0.87 × min(authoritative investor cluster, as-is)) with no repairs (sfrLaneCeiling.js).
import { calculateAcquisitionDecision, scoreRowFromDecision } from './acquisitionDecisionEngine.js'
import { evaluateOfferReadiness } from './offerReadiness.js'
import { isSfrSubject, traceSfrFormulas } from './sfrLaneCeiling.js'
import { planOffer } from '../domain/property-research/offer-plan.js'

export const LANE_VALUATION_VERSION = 'lane-valuation.v1'

const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }

/**
 * @param {{ property: object, comps?: object[], buyer_purchases?: object[], now: Date|string|number, sfr_lane?: boolean,
 *           v3?: boolean, ask?: { amount:number }|null, zip_prior?: object|null, target_assignment_fee?: number }} a
 */
export function laneValuation({ property, comps = [], buyer_purchases = [], now, sfr_lane = false, v3 = false, ask = null, zip_prior = null, target_assignment_fee = undefined } = {}) {
  if (!property?.property_id) throw Object.assign(new Error('property.property_id required'), { code: 'PROPERTY_REQUIRED' })
  const at = now instanceof Date ? now : new Date(now)
  if (!Number.isFinite(at.getTime())) throw Object.assign(new Error('now required'), { code: 'NOW_REQUIRED' })
  const decision = calculateAcquisitionDecision({ subject: property, comps, buyerPurchases: buyer_purchases, now: at, v3Enabled: v3 === true, sfrLaneCeilingV1: sfr_lane === true, ...(target_assignment_fee != null ? { targetAssignmentFee: target_assignment_fee } : {}) })
  const row = scoreRowFromDecision(String(property.property_id), decision, at)
  const oc = decision.evidence?.offer_calculation || {}
  const readiness = evaluateOfferReadiness(row, { now: at.getTime() })
  // the opening: the existing offer plan on the row (strictly below the ceiling, never a fabricated number)
  const plan = planOffer({ valuation: { ...row, evidence: { ...(row.evidence || {}), immutable_snapshot_id: row.evidence?.immutable_snapshot_id ?? 'lane-valuation-unpersisted' } }, property, ask, zip_prior, now: at.getTime() })
  const sfr = isSfrSubject(decision.evidence?.subject?.normalized_features || { asset_family: decision.evidence?.subject?.asset_family, units: property.units_count })
  const trace = sfr ? traceSfrFormulas({ valuation_mid: decision.valuation?.mid, estimated_repairs: oc.estimated_repairs, investor_ceiling_mid: oc.behavior_based_ceiling, icm: decision.evidence?.investor_ceiling_summary?.method, evidence: { offer_calculation: oc } }, { cluster_authoritative: oc.buyer_ceiling_authoritative === true }) : null
  const mao = num(oc.effective_authorized_ceiling) > 0 ? num(oc.effective_authorized_ceiling) : null
  return {
    version: LANE_VALUATION_VERSION,
    lane: plan.lane,
    formula: oc.method || null,
    valuation: { as_is_value: num(decision.valuation?.mid), low: num(decision.valuation?.low), high: num(decision.valuation?.high), confidence: num(decision.valuation?.confidence), comp_count: (decision.selected_comps || []).length, basis: 'sold_comps_repair_differential_adjusted' },
    investor_cluster: { mid: num(oc.behavior_based_ceiling), authoritative: oc.buyer_ceiling_authoritative === true, method: decision.evidence?.investor_ceiling_summary?.method || null },
    mao,
    mao_source: mao != null ? `engine:${oc.method}` : null,
    mao_role: 'ceiling_not_opening',
    authority: 'analysis_only_not_persisted_not_spendable',
    opening: plan.available ? { recommended: plan.opening.recommended, range: plan.opening.range } : null,
    opening_reason: plan.available ? 'offer_plan_strictly_below_ceiling' : plan.reason,
    decision_tier: row.decision_tier ?? null,
    offer_ready: readiness.ready,
    offer_ready_reason: readiness.reason,
    sfr_trace: trace,
    owner_question: sfr && !sfr_lane && num(oc.estimated_repairs) > 0 ? 'sfr_engine_subtracts_repairs_owner_lane_says_no_repairs (pass sfr_lane:true for the proposed lane)' : null,
    notes: plan.notes || [],
  }
}
