/**
 * DEAL SCENARIO MODEL — browser port of the acquisition engine's cash-offer
 * arithmetic, so the scenario lab can answer instantly while a slider moves.
 *
 * Mirrors apps/api/src/lib/domain/deal-intelligence/deal-scenario-model.js,
 * which imports the engine's own ceiling authority and assignment-margin
 * policy. The two are pinned to the same production vectors (the API test and
 * deal-scenario-model.test.ts); if the engine policy changes, those vectors
 * break before this file can drift silently.
 *
 * Only the branch the engine actually runs is ported:
 * `market_adjustments_applied_by_caller: true` and `confidence: null`.
 * The result is a SCENARIO. It is never written anywhere.
 */
import type { ScenarioInputs, ScenarioResult } from './deal-decision-api'

const MARGIN_BASE_PCT: Record<string, number> = {
  RESIDENTIAL_SINGLE: 0.10,
  SMALL_MULTI: 0.11,
  MULTIFAMILY: 0.06,
  COMMERCIAL: 0.07,
  LAND: 0.15,
  SPECIAL: 0.10,
  UNKNOWN: 0.10,
}
const MARGIN_MAX_PCT = 0.30
const MARGIN_MIN_PCT = 0.04

/** Engine policy rounding: nearest $1. */
const roundDollar = (v: number) => Math.round(v)
/** Engine offer rounding: nearest $100. */
const round100 = (v: number) => Math.round(v / 100) * 100
const round = (v: number, places: number) => { const f = 10 ** places; return Math.round(v * f) / f }

function familyKey(assetFamily: string, unitCount: number | null): string {
  const f = String(assetFamily ?? '').trim().toUpperCase()
  if (f === 'RESIDENTIAL' || f === 'RESIDENTIAL_SINGLE' || f === 'SFR') return 'RESIDENTIAL_SINGLE'
  if (f === 'SMALL_MULTI') return 'SMALL_MULTI'
  if (f === 'MULTIFAMILY' && unitCount !== null && unitCount >= 2 && unitCount <= 4) return 'SMALL_MULTI'
  if (f === 'MULTIFAMILY') return 'MULTIFAMILY'
  if (f === 'COMMERCIAL') return 'COMMERCIAL'
  if (f === 'LAND') return 'LAND'
  if (f === 'SPECIAL') return 'SPECIAL'
  return 'UNKNOWN'
}

function effectiveCeiling(valuationCeiling: number, behavior: number | null, authoritative: boolean) {
  if (!Number.isFinite(valuationCeiling) || valuationCeiling <= 0) return { value: 0, basis: 'no_valuation_ceiling' }
  let effective: number
  let basis: string
  if (authoritative && behavior !== null && behavior > 0) {
    effective = Math.min(valuationCeiling, behavior)
    basis = 'authoritative_buyer_behavior_constrains_valuation_ceiling'
  } else if (behavior !== null && behavior > 0) {
    effective = Math.min(valuationCeiling, valuationCeiling * 0.75 + behavior * 0.25)
    basis = 'non_authoritative_buyer_behavior_may_only_reduce'
  } else {
    effective = valuationCeiling
    basis = 'valuation_ceiling_only'
  }
  return { value: roundDollar(Math.min(effective, valuationCeiling)), basis }
}

function marginPolicy(ceiling: number, family: string, floor: number) {
  if (!Number.isFinite(ceiling) || ceiling <= 0) return { target: floor, protectedMargin: floor, pct: 0 }
  let pct = MARGIN_BASE_PCT[family] ?? MARGIN_BASE_PCT.UNKNOWN
  if (ceiling > 1_000_000) pct -= 0.02
  else if (ceiling < 150_000) pct += 0.02
  pct = Math.min(MARGIN_MAX_PCT, Math.max(MARGIN_MIN_PCT, pct))
  return { target: Math.max(floor, roundDollar(ceiling * pct)), protectedMargin: floor, pct: round(pct, 4) }
}

export function computeScenarioOffer(i: ScenarioInputs): ScenarioResult {
  const valuationCeiling = Math.max(0, i.valuation_mid * i.max_arv_factor - i.repairs)
  const ceil = effectiveCeiling(valuationCeiling, i.behavior_ceiling, i.buyer_ceiling_authoritative)
  const eff = ceil.value
  const floor = Math.max(0, i.minimum_margin_floor)
  const policy = marginPolicy(eff, familyKey(i.asset_family, i.unit_count), floor)
  const haircut = ((100 - i.valuation_confidence) / 100) * 0.06
  const motivation = (i.motivation_score / 100) * 0.035
  const demand = ((i.buyer_demand_score + i.liquidity_score) / 200) * 0.015
  const marketAdjusted = eff * (1 - haircut - motivation + demand) - policy.target
  const protectedCap = eff - policy.protectedMargin
  const recommended = Math.max(0, round100(Math.min(marketAdjusted, protectedCap)))
  const band = Math.max(5000, i.valuation_mid * 0.03)
  return {
    valuation_ceiling: round100(valuationCeiling),
    effective_ceiling: round100(eff),
    ceiling_basis: ceil.basis,
    target_margin: policy.target,
    protected_margin: policy.protectedMargin,
    margin_pct: policy.pct,
    recommended_offer: recommended,
    minimum_offer: Math.max(0, round100(recommended - band)),
    expected_fee: Math.max(0, round100(eff - recommended)),
    protected_margin_enforced: marketAdjusted > protectedCap,
    terms: {
      confidence_haircut_pct: Math.round(haircut * 10000) / 100,
      motivation_discount_pct: Math.round(motivation * 10000) / 100,
      demand_premium_pct: Math.round(demand * 10000) / 100,
    },
  }
}
