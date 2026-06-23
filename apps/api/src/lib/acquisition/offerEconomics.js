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
