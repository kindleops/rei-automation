/**
 * Acquisition Engine V3 — novation engine (mission Item 4 §11).
 *
 * Selected only through verifiable RETAIL economics. Compares novation seller net
 * vs cash seller net and the company net. Uses its own light prep allowance so
 * repairs are not double-counted against the cash/buyer-exit rehab. Spelled
 * NOVATION (not "innovation").
 */

import {
  VALUE_CLASSIFICATION as VC,
  NOVATION as N,
  num,
  clamp,
  round,
  roundMoney,
} from './modelConstants.js';

export function buildNovation({ retailUniverse, subjectRow, cashSellerNet, buyerDemand = 50 }) {
  const disqualifiers = [];
  const retailOk =
    retailUniverse &&
    retailUniverse.available &&
    retailUniverse.value_classification === VC.QUALIFIED &&
    (retailUniverse.mid ?? 0) > 0;

  if (!retailOk) disqualifiers.push('insufficient_retail_evidence');
  if (retailOk && (retailUniverse.effective_sample_size ?? 0) < N.min_retail_effective_sample) {
    disqualifiers.push('insufficient_retail_depth');
  }
  if (retailOk && (retailUniverse.confidence ?? 0) < N.min_retail_confidence) {
    disqualifiers.push('low_retail_confidence');
  }

  const sale = retailOk ? retailUniverse.mid : null;
  const expectedDays = Math.round(30 + (100 - clamp(buyerDemand, 0, 100)) * 1.1);
  if (sale && expectedDays > N.max_days_to_sale) disqualifiers.push('insufficient_retail_liquidity');

  if (!sale || disqualifiers.length) {
    return {
      available: false,
      novation_viability_score: 0,
      novation_recommended: false,
      novation_confidence: retailOk ? Math.round((retailUniverse.confidence ?? 0) * 0.5) : 0,
      novation_disqualifiers: disqualifiers.length ? disqualifiers : ['no_retail_basis'],
    };
  }

  const list = roundMoney(sale * 1.03);
  const agent = roundMoney(sale * N.agent_commission_pct);
  const sellerClosing = roundMoney(sale * N.seller_closing_pct);
  const prep = roundMoney(sale * N.prep_allowance_pct);
  const holding = roundMoney(sale * N.holding_reserve_pct);
  const companyFee = roundMoney(sale * N.company_fee_pct);
  const expectedSellerNet = roundMoney(sale - agent - sellerClosing - prep - holding - companyFee);
  const minAcceptableSale = roundMoney(sale * 0.92);

  const cashNet = num(cashSellerNet);
  const sellerNetAdvantage = cashNet ? round((expectedSellerNet - cashNet) / cashNet, 4) : null;
  const beatsCash = sellerNetAdvantage !== null && sellerNetAdvantage >= N.min_seller_net_advantage_pct;

  const liquidityScore = clamp(100 - (expectedDays - 30) * 0.6, 0, 100);
  const viability = clamp(
    (retailUniverse.confidence ?? 0) * 0.4 +
      liquidityScore * 0.3 +
      (beatsCash ? 30 : sellerNetAdvantage > 0 ? 12 : 0),
    0,
    100,
  );

  const probBy = (d) => clamp((liquidityScore / 100) * (d / expectedDays) * 100, 0, 95);

  return {
    available: true,
    recommended_list_price: list,
    expected_sale_price: roundMoney(sale),
    minimum_acceptable_sale: minAcceptableSale,
    expected_days_to_sale: expectedDays,
    cost_breakdown: { agent, seller_closing: sellerClosing, prep_allowance: prep, holding, company_fee: companyFee },
    expected_seller_net: expectedSellerNet,
    novation_company_net: companyFee,
    cash_seller_net: cashNet ?? null,
    seller_net_advantage_vs_cash: sellerNetAdvantage,
    price_reduction_schedule: [
      { day: 0, price: list },
      { day: 30, price: roundMoney(list * 0.98) },
      { day: 60, price: roundMoney(list * 0.95) },
      { day: 90, price: roundMoney(list * 0.92) },
    ],
    probability_of_sale: { d30: round(probBy(30), 1), d60: round(probBy(60), 1), d90: round(probBy(90), 1), d180: round(probBy(180), 1) },
    novation_viability_score: Math.round(viability),
    novation_recommended: beatsCash && viability >= 55,
    novation_confidence: Math.round(clamp((retailUniverse.confidence ?? 0) * 0.7 + liquidityScore * 0.3, 0, 100)),
    novation_reasoning: [
      beatsCash ? `seller nets ${round(sellerNetAdvantage * 100, 1)}% more than cash` : 'novation does not materially beat cash for the seller',
      `expected ${expectedDays} days to sale`,
    ],
    novation_disqualifiers: [],
  };
}
