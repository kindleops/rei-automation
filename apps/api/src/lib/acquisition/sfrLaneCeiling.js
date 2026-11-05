// ─── SFR LANE CEILING (8.5.21-b, owner decision 2026-10-16 (2)) ───────────────
// OFF BY DEFAULT (ACQUISITION_SFR_LANE_CEILING_V1). Nothing here changes a production offer until the
// owner turns the flag on.
//
// THE CONFLICT (traced, acquisitionDecisionEngine.js / offerEconomics.js):
//   valuation_mid      weighted SOLD comps, each adjusted by the repair DIFFERENTIAL
//                      (comp.estimated_repairs − subject.estimated_repairs, ±25 % cap; 257 / 258
//                      production rows carry property_estimated_repair_cost) ⇒ an AS-IS value at the
//                      subject's condition, not an after-repair value.
//   investor cluster   weighted nearby investor / corporate purchases (buyer_purchase_events_v2),
//                      adjusted the same way ⇒ also AS-IS.
//   V2 MAO (the authority read by offer readiness, plans, envelopes):
//                      effective_authorized_ceiling = min(0.70 × valuation_mid − repairs, behavior)
//                      ⇒ the 70 % ARV rule applied to an as-is value AND the full repairs again
//                      (double deduction), then the opening subtracts the assignment target margin
//                      from that ceiling (margin inside a rule that already keeps 30 %).
//   V3 offer:          conservative investor (as-is) exit − repairs − 13 % cost stack − margin
//                      (repairs deducted from an as-is investor price).
//   OWNER SFR LANE:    LLC investor cluster − 13 %, NO repairs.
//
// THE ONE AUTHORITATIVE SFR (single unit, cash / wholesale) CALCULATION:
//   basis  B   = min(authoritative investor cluster mid, as-is value)        — never above the
//                independent as-is value (the existing "behavior may only constrain" invariant); a
//                cluster > 1.10 × the as-is value is not credible as an as-is investor price ⇒ review
//   MAO        = floor(B × (1 − 0.13))                                         — repairs NOT deducted
//                (B is as-is); closing / transaction costs and the assignment margin live INSIDE the
//                13 % spread (no second margin deduction); if the spread is below the protected
//                margin, MAO = B − protected margin.
//   no authoritative cluster ⇒ MAO null (review; the ZIP prior is context only) — never a guess.
//   MLS ARV lane (separate, cross-check only, never blended): only with a SOURCED retail ARV:
//                0.70 × ARV − repairs. Repairs are deducted ONLY here.
import { OFFER_COSTS } from './modelConstants.js'

export const SFR_LANE_FLAG = 'ACQUISITION_SFR_LANE_CEILING_V1'
export const SFR_LANE_VERSION = 'sfr-lane-ceiling.v1'
export const SFR_LANE_RULES = Object.freeze({ investor_cluster_discount: 0.13, arv_factor: 0.70, current_engine_factor: 0.70, cluster_above_as_is_review: 1.10 })

const num = (v) => { if (v == null || v === '' || typeof v === 'boolean') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
const pos = (v) => { const n = num(v); return n != null && n > 0 ? n : null }
const r0 = (n) => (n == null ? null : Math.round(n))
const floor100 = (n) => (n == null ? null : Math.floor(n / 100) * 100)

export function sfrLaneEnabled(env = process.env) {
  return ['1', 'true', 'on', 'yes'].includes(String(env?.[SFR_LANE_FLAG] ?? '').trim().toLowerCase())
}

/** Residential, one unit (2-4 units are the MF2-4 same-unit lane; 5+ per door). */
export function isSfrSubject(subject = {}) {
  const fam = String(subject.asset_family || '').toLowerCase()
  const units = num(subject.units ?? subject.units_count)
  return (fam === 'residential' || fam === 'residential_single' || fam === 'single_family') && (units == null || units <= 1)
}

/**
 * The authoritative SFR lane ceiling.
 * @param {{ as_is_value:number, investor_cluster_mid:number|null, cluster_authoritative:boolean, protected_margin?:number, retail_arv?:{ value:number, source:string }|null, repairs?:number|null }} a
 */
export function sfrLaneCeiling({ as_is_value, investor_cluster_mid = null, cluster_authoritative = false, protected_margin = 15_000, retail_arv = null, repairs = null } = {}) {
  const V = pos(as_is_value)
  const C = pos(investor_cluster_mid)
  const R = num(repairs) ?? 0
  const arvLane = pos(retail_arv?.value)
    ? { available: true, arv: r0(retail_arv.value), source: retail_arv.source || 'unspecified', repairs: r0(R), mao: Math.max(0, floor100(retail_arv.value * SFR_LANE_RULES.arv_factor - R)), role: 'cross_check_only_never_blended' }
    : { available: false, reason: 'no_sourced_retail_arv' }
  if (!V) return { version: SFR_LANE_VERSION, lane: 'sfr_llc_investor_cluster', mao: null, reason: 'no_as_is_value', arv_lane: arvLane }
  if (!C || !cluster_authoritative) return { version: SFR_LANE_VERSION, lane: 'sfr_llc_investor_cluster', as_is_value: r0(V), investor_cluster_mid: r0(C), mao: null, reason: C ? 'investor_cluster_not_authoritative' : 'no_investor_cluster', repairs_applied: 0, arv_lane: arvLane }
  // a cluster well ABOVE the independent as-is value is not an as-is investor price (contaminated / mixed
  // sample: 931,600 vs 206,000 on a real row): review, never a clamp-to-as-is MAO
  if (C > V * SFR_LANE_RULES.cluster_above_as_is_review) return { version: SFR_LANE_VERSION, lane: 'sfr_llc_investor_cluster', as_is_value: r0(V), investor_cluster_mid: r0(C), mao: null, reason: 'investor_cluster_above_as_is_value_review', repairs_applied: 0, arv_lane: arvLane }
  const B = Math.min(C, V)
  let mao = floor100(B * (1 - SFR_LANE_RULES.investor_cluster_discount))
  const pm = num(protected_margin) ?? 0
  let protectedApplied = false
  if (B - mao < pm) { mao = Math.max(0, floor100(B - pm)); protectedApplied = true }
  const spread = B - mao
  return {
    version: SFR_LANE_VERSION,
    lane: 'sfr_llc_investor_cluster',
    as_is_value: r0(V),
    investor_cluster_mid: r0(C),
    basis: r0(B),
    basis_clamped_to_as_is: C > V,
    mao,
    reason: 'authoritative_investor_cluster_less_13pct',
    repairs_applied: 0,
    repairs_note: 'as-is basis: repairs are already reflected (repair-differential-adjusted sold comps and investor purchases)',
    spread_usd: r0(spread),
    closing_costs_inside_spread: r0(B * OFFER_COSTS.buyer_closing_pct),
    assignment_margin_at_mao: r0(spread),
    protected_margin: pm,
    protected_margin_applied: protectedApplied,
    arv_lane: arvLane,
  }
}

/**
 * Side-by-side trace of one engine row (read-only): what each formula does to as-is value, ARV, repairs,
 * closing costs, assignment margin and MAO. `row` = a property_acquisition_scores projection.
 */
export function traceSfrFormulas(row = {}, { retail_arv = null, cluster_authoritative = null } = {}) {
  const V = pos(row.valuation_mid)
  const R = num(row.estimated_repairs) ?? 0
  const oc = row.evidence?.offer_calculation || row.offer_calculation || {}
  const icm = row.evidence?.investor_ceiling_summary?.method || row.icm || null
  const C = icm === 'weighted_nearby_investor_purchase_quantiles' ? pos(row.investor_ceiling_mid) : null
  const auth = cluster_authoritative ?? (oc.buyer_ceiling_authoritative === true || oc.buyer_ceiling_authoritative === 'true' ? true : C != null ? null : false)
  const engineCeiling = V != null ? Math.max(0, V * SFR_LANE_RULES.current_engine_factor - R) : null
  const engineTargetMargin = num(oc.target_assignment_fee) ?? 15_000
  const lane = sfrLaneCeiling({ as_is_value: V, investor_cluster_mid: C, cluster_authoritative: auth === true || (auth == null && C != null), protected_margin: num(oc.protected_margin) ?? 15_000, retail_arv, repairs: R })
  return {
    as_is_value: r0(V),
    implied_arv_as_is_plus_repairs: V != null ? r0(V + R) : null, // derived for the trace only — not an MLS ARV
    repairs: r0(R),
    current_engine: {
      formula: '0.70 × as_is_value − repairs (then opening = ceiling × adj − target margin)',
      ceiling: r0(engineCeiling),
      stored_valuation_ceiling: num(oc.valuation_based_ceiling),
      stored_effective_ceiling: num(oc.effective_authorized_ceiling),
      repairs_deducted: r0(R),
      repairs_already_in_as_is_basis: true,
      double_deduction_usd: r0(R),
      arv_rule_on_as_is_usd: V != null ? r0(V * (1 - SFR_LANE_RULES.current_engine_factor)) : null,
      target_margin_deducted_again: engineTargetMargin,
      recommended_cash_offer: num(row.recommended_cash_offer),
    },
    owner_lane: lane,
    cluster_authoritative: auth == null ? 'unknown_row_predates_field' : auth,
    difference_mao_vs_current: lane.mao != null && engineCeiling != null ? r0(lane.mao - engineCeiling) : null,
  }
}
