/**
 * Acquisition Engine V3 — Item 5B: residential-income analysis orchestrator.
 *
 * Runs ONLY for income families (SMALL_MULTI, MULTIFAMILY). Produces an additive
 * `residential_income` analysis block (normalized contract, lane-appropriate
 * valuation, repair/stabilization split, buyer exit and strategies) without
 * altering the existing generic valuation/reconciliation/confidence flow — so
 * SFR behavior and the V2-disabled path stay byte-identical.
 */

import { ASSET_FAMILIES } from './modelConstants.js';
import { buildResidentialIncomeSubject, missingInputs, INCOME_FAMILIES } from './residentialIncomeContract.js';
import { buildSmallMultiValuation } from './smallMultiValuation.js';
import { buildMultifamilyValuation } from './multifamilyValuation.js';
import { buildIncomeRepairStabilization } from './incomeRepairStabilization.js';
import { buildIncomeBuyerExit } from './incomeBuyerExit.js';
import { buildIncomeStrategies } from './incomeStrategies.js';

export function isIncomeFamily(family) {
  return INCOME_FAMILIES.includes(family);
}

export function buildResidentialIncomeAnalysis({
  subjectRow = {},
  qualification = {},
  universes = {},
  repair = {},
  family,
  lane,
  income = {},
  buyerPurchases = [],
  finalConfidence = 0,
}) {
  if (!isIncomeFamily(family)) return null;

  const contract = buildResidentialIncomeSubject(subjectRow, income);
  const accepted = qualification?.accepted ?? [];
  // Cross-unit / adjacent-band fallback evidence: REVIEW-classed permitted
  // fallback-lane comps. Explicit, confidence-reduced, never autonomous.
  const fallbackComps = (qualification?.rejected ?? []).filter(
    (r) => r.status === 'REVIEW' && (r.reasons ?? []).includes('fallback_lane') && r.raw,
  );

  const valuation =
    family === ASSET_FAMILIES.SMALL_MULTI
      ? buildSmallMultiValuation({ contract, accepted, fallbackComps, universes, lane })
      : buildMultifamilyValuation({ contract, accepted, fallbackComps, universes, lane });

  const repairStab = buildIncomeRepairStabilization(repair, contract);
  const buyerExit = buildIncomeBuyerExit({ subjectRow, contract, valuation, family, buyerPurchases });
  const strategies = buildIncomeStrategies({
    family,
    contract,
    valuation,
    buyerExit,
    repairStab,
    demand: buyerExit.buyer_demand_score,
    confidence: finalConfidence,
  });

  return {
    family,
    lane,
    contract,
    contract_completeness: contract.completeness,
    missing_inputs: missingInputs(contract),
    valuation,
    repair_stabilization: repairStab,
    buyer_exit: buyerExit,
    strategies,
    // Surface the dominant model so downstream can verify ARV is never dominant
    // for 5+ and that the lane-appropriate model leads.
    dominant_model: valuation.dominant_model,
    income_supported: Boolean(valuation.operating_statement?.income_supported),
  };
}
