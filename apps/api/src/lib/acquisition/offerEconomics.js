/**
 * Acquisition Engine V3 — cash offer engine (mission Item 4 §10).
 *
 * Replaces the V2 `valuation × ARV-factor` ceiling. The offer is built DOWN from
 * the conservative buyer exit, subtracting the END-BUYER's repair/cost stack and
 * a DYNAMIC acquisition margin (never a fixed $15k). Every dollar is in the bridge.
 * Hard guarantee: recommended ≤ maximum ≤ conservative_buyer_exit.
 */

import {
  OFFER_COSTS,
  MARGIN_BASE_PCT,
  MARGIN_MIN_USD,
  MARGIN_MAX_PCT,
  ASSET_FAMILIES,
  clamp,
  round,
  roundMoney,
} from './modelConstants.js';

function dynamicMarginPct({ family, exit, buyerDemand, confidence, expectedDays }) {
  let pct = MARGIN_BASE_PCT[family] ?? MARGIN_BASE_PCT.UNKNOWN;
  if (buyerDemand < 40) pct += 0.03;
  else if (buyerDemand > 70) pct -= 0.02;
  if (confidence < 50) pct += 0.03;
  else if (confidence > 80) pct -= 0.01;
  if (exit > 1_000_000) pct -= 0.02;
  else if (exit < 150_000) pct += 0.02;
  if (expectedDays > 120) pct += 0.02;
  return clamp(pct, 0.04, MARGIN_MAX_PCT);
}

export function buildCashOffer({
  conservativeBuyerExit,
  repair,
  family = ASSET_FAMILIES.UNKNOWN,
  buyerDemand = 0,
  confidence = 0,
  expectedDays = 60,
} = {}) {
  const exit = roundMoney(conservativeBuyerExit);
  if (!exit || exit <= 0) {
    return { available: false, unavailable_reason: 'no_conservative_buyer_exit', bridge: [] };
  }

  const buyerRepairs = roundMoney(repair?.repair_mid ?? 0); // one-time rehab only
  const buyerClosing = roundMoney(exit * OFFER_COSTS.buyer_closing_pct);
  const buyerHolding = roundMoney(exit * OFFER_COSTS.buyer_holding_pct);
  const buyerDisposition = roundMoney(exit * OFFER_COSTS.buyer_disposition_pct);
  const contingency = roundMoney(exit * OFFER_COSTS.contingency_pct);
  const marginPct = dynamicMarginPct({ family, exit, buyerDemand, confidence, expectedDays });
  const marginUsd = roundMoney(Math.max(MARGIN_MIN_USD, exit * marginPct));

  const maximumSafe = Math.max(
    0,
    roundMoney(exit - buyerRepairs - buyerClosing - buyerHolding - buyerDisposition - contingency - marginUsd),
  );

  const maximum = maximumSafe;
  const recommended = roundMoney(maximumSafe * 0.97);
  const target = roundMoney(maximumSafe * 0.95);
  const opening = roundMoney(maximumSafe * 0.88);
  const walkaway = maximumSafe;

  const bridge = [
    { step: 'conservative_buyer_exit', amount: exit },
    { step: 'less_buyer_repairs', amount: -buyerRepairs },
    { step: 'less_buyer_closing_costs', amount: -buyerClosing, pct: OFFER_COSTS.buyer_closing_pct },
    { step: 'less_buyer_holding_costs', amount: -buyerHolding, pct: OFFER_COSTS.buyer_holding_pct },
    { step: 'less_disposition_costs', amount: -buyerDisposition, pct: OFFER_COSTS.buyer_disposition_pct },
    { step: 'less_contingency_reserve', amount: -contingency, pct: OFFER_COSTS.contingency_pct },
    { step: 'less_acquisition_margin', amount: -marginUsd, pct: round(marginPct, 4) },
    { step: 'maximum_safe_cash_offer', amount: maximumSafe },
  ];

  return {
    available: true,
    conservative_buyer_exit: exit,
    opening_cash_offer: opening,
    target_cash_offer: target,
    recommended_cash_offer: recommended,
    maximum_cash_offer: maximum,
    walkaway_cash_price: walkaway,
    projected_assignment_fee: marginUsd,
    projected_gross_margin: marginUsd,
    projected_net_margin: roundMoney(marginUsd - exit * 0.005),
    margin_on_exit: round(marginUsd / exit, 4),
    margin_on_cost: recommended > 0 ? round(marginUsd / recommended, 4) : null,
    margin_pct_used: round(marginPct, 4),
    cost_breakdown: {
      buyer_repairs: buyerRepairs,
      buyer_closing: buyerClosing,
      buyer_holding: buyerHolding,
      buyer_disposition: buyerDisposition,
      contingency,
      acquisition_margin: marginUsd,
    },
    bridge,
  };
}

/* -------------------------------------------------------------------------- */
/* MERGED V3 offer (v3.1 math) — owner approval required before any cutover.  */
/* -------------------------------------------------------------------------- */

/**
 * The investor universe prices the AS-IS off-market investor purchase, so the
 * value already embeds the end buyer's rehab, holding, closing and profit.
 * Nothing is subtracted from it again (the legacy bridge above subtracted the
 * full repair estimate AND 13% end-buyer costs from a p25 exit -> ~44% of the
 * investor price). Ceiling = value x (1 - calibration) x (1 - confidence
 * haircut); offer = ceiling - assignment fee (existing margin-policy bands).
 */
export const MERGED_OFFER_POLICY = Object.freeze({
  version: 'acq-v3m-offer-1 (from investor-offer-v3.1-proposed)',
  haircutByConfidence: Object.freeze([[70, 0], [50, 0.03], [0, 0.06]]),
  fallbackExtraHaircut: 0.03,
  // Measured median bias of the investor value vs recorded off-market investor
  // purchases (post-2026-05-08): SFR +8.9%, 2-4 units +15.3%, 5+ +11.5%.
  calibrationByLane: Object.freeze({ sfr: 0.08, mf24: 0.15, mf5: 0.12 }),
  feePct: 0.1,
  feePctSmallDeal: 0.12,
  feePctByLane: Object.freeze({ mf24: 0.11, mf5: 0.06 }),
  smallDealCeiling: 150_000,
  feeFloor: 15_000,
  feeCap: 40_000,
  feeCapByLane: Object.freeze({ mf24: 60_000, mf5: Infinity }),
  negotiationBandPct: 0.03,
  negotiationBandMin: 5_000,
  minOfferToValue: 0.35,
  maxOfferToValue: 0.9,
});

// Merged money rounds to $100 (identical to the v3.1 oracle it replaces).
const round100 = (v) => (v === null || !Number.isFinite(v) ? null : Math.round(v / 100) * 100);

/**
 * @param {object} p
 * @param {number|null} p.investorValue  as-is investor value (base)
 * @param {'sfr'|'mf24'|'mf5'} p.lane
 * @param {number} p.confidence   investor-universe confidence 0-100
 * @param {string} p.method       'investor_comps' | 'market_ratio_fallback'
 * @param {number|null} p.retailMid  MLS as-sold context (review flag only)
 * @param {number|null} p.units   REAL unit count (MF per-door only)
 * @param {object|null} p.repairEvidence  informational; never subtracted
 */
export function buildCashOfferMerged({
  investorValue,
  lane = 'sfr',
  confidence = 0,
  method = 'investor_comps',
  retailMid = null,
  units = null,
  repairEvidence = null,
  policy = MERGED_OFFER_POLICY,
} = {}) {
  const mid = Number.isFinite(Number(investorValue)) && Number(investorValue) > 0 ? Number(investorValue) : null;
  if (!mid) {
    return { available: false, offer_model: 'merged_v31', unavailable_reason: 'no_qualified_investor_value', bridge: [], reasons: ['no_qualified_investor_value'], policy_version: policy.version };
  }
  const conf = Number.isFinite(Number(confidence)) ? Number(confidence) : 0;
  let haircut = policy.haircutByConfidence.find(([min]) => conf >= min)[1];
  if (method !== 'investor_comps') haircut += policy.fallbackExtraHaircut;
  const calibration = policy.calibrationByLane[lane] ?? policy.calibrationByLane.sfr;
  const ceilingRaw = mid * (1 - calibration) * (1 - haircut);
  const reasons = [];
  if (Number(retailMid) > 0 && ceilingRaw > Number(retailMid)) reasons.push('investor_ceiling_above_retail_context_review');
  const pct = lane === 'sfr' ? (ceilingRaw < policy.smallDealCeiling ? policy.feePctSmallDeal : policy.feePct) : policy.feePctByLane[lane];
  const cap = lane === 'sfr' ? policy.feeCap : policy.feeCapByLane[lane];
  const feeRaw = clamp(ceilingRaw * pct, policy.feeFloor, cap);
  const offerRaw = Math.max(0, ceilingRaw - feeRaw);
  const band = Math.max(policy.negotiationBandMin, mid * policy.negotiationBandPct);
  const ceiling = round100(ceilingRaw);
  const fee = round100(feeRaw);
  const offer = round100(offerRaw);
  const minimum = round100(Math.max(0, offerRaw - band));
  const offerToValue = round(offerRaw / mid, 3);
  const withinBounds = offerRaw / mid >= policy.minOfferToValue && offerRaw / mid <= policy.maxOfferToValue;
  if (!withinBounds) reasons.push('offer_outside_sanity_bounds_review');
  const realUnits = Number.isInteger(Number(units)) && Number(units) >= 2 ? Number(units) : null;
  const out = {
    available: true,
    offer_model: 'merged_v31',
    policy_version: policy.version,
    lane,
    investor_value: round100(mid),
    // The end investor's as-is MAO: what a cash buyer pays (value less calibration/haircut).
    buyer_ceiling: ceiling,
    conservative_buyer_exit: ceiling,
    opening_cash_offer: minimum,
    target_cash_offer: offer,
    recommended_cash_offer: offer,
    // Our maximum while preserving the assignment fee target (not the buyer ceiling).
    maximum_cash_offer: offer,
    walkaway_cash_price: offer,
    minimum_acceptable_offer: minimum,
    projected_assignment_fee: fee,
    projected_gross_margin: fee,
    projected_net_margin: round100(fee - mid * 0.005),
    margin_on_exit: round(fee / ceilingRaw, 4),
    margin_on_cost: offerRaw > 0 ? round(fee / offerRaw, 4) : null,
    margin_pct_used: round(pct, 4),
    calibration_pct: round(calibration * 100, 1),
    confidence_haircut_pct: round(haircut * 100, 1),
    repairs_basis: 'embedded_in_as_is_investor_comps_not_subtracted_again',
    repairs_evidence: repairEvidence,
    sanity: { offer_to_value: offerToValue, within_bounds: withinBounds, min: policy.minOfferToValue, max: policy.maxOfferToValue },
    cost_breakdown: { buyer_repairs: 0, buyer_closing: 0, buyer_holding: 0, buyer_disposition: 0, contingency: 0, acquisition_margin: fee },
    bridge: [
      { step: 'as_is_investor_value', amount: round100(mid) },
      { step: 'less_calibration', amount: -round100(mid * calibration), pct: round(calibration, 4) },
      { step: 'less_confidence_haircut', amount: -round100(mid * (1 - calibration) * haircut), pct: round(haircut, 4) },
      { step: 'buyer_ceiling', amount: ceiling },
      { step: 'less_assignment_fee', amount: -fee, pct: round(pct, 4) },
      { step: 'recommended_cash_offer', amount: offer },
    ],
    reasons,
  };
  if (realUnits && lane !== 'sfr') {
    out.per_unit = { units: realUnits, offer: round100(offerRaw / realUnits), ceiling: round100(ceilingRaw / realUnits), value: round100(mid / realUnits) };
  }
  return out;
}
