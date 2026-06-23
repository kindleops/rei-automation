/**
 * Acquisition Engine V3 — buyer exit model (mission Item 4 §9).
 *
 * Ranks realistic disposition channels and their prices/probabilities using the
 * reconciled investor/retail/institutional evidence and observed buyer behavior
 * (buyer_purchase_events). The conservative buyer exit feeds the cash-offer engine.
 */

import {
  VALUATION_UNIVERSES as U,
  ASSET_FAMILIES,
  num,
  lower,
  clean,
  clamp,
  round,
} from './modelConstants.js';
import { INSTITUTIONAL_BUYER_PATTERNS } from './valuationUniverses.js';

function matchBuyers(subjectRow, buyerPurchases, family) {
  const subjZip = clean(subjectRow.property_address_zip ?? subjectRow.property_zip);
  const subjMarket = lower(subjectRow.market);
  const subjUnits = num(subjectRow.units_count) ?? 1;
  const seen = new Set();
  let institutional = 0;
  for (const ev of buyerPurchases) {
    const zip = clean(ev.property_zip ?? ev.property_address_zip);
    const market = lower(ev.market);
    const geoOk = (subjZip && zip === subjZip) || (subjMarket && market === subjMarket);
    if (!geoOk) continue;
    const units = num(ev.units_count) ?? 1;
    // family compatibility by unit band
    const sameBand =
      family === ASSET_FAMILIES.RESIDENTIAL_SINGLE ? units <= 1
        : family === ASSET_FAMILIES.SMALL_MULTI ? units >= 2 && units <= 4
        : family === ASSET_FAMILIES.MULTIFAMILY ? units >= 5
        : true;
    if (!sameBand) continue;
    const key = clean(ev.buyer_key ?? ev.buyer_name);
    if (key) seen.add(key);
    const name = lower(ev.buyer_name ?? '');
    if (ev.is_corporate_buyer === true || INSTITUTIONAL_BUYER_PATTERNS.some((re) => re.test(name))) {
      if (INSTITUTIONAL_BUYER_PATTERNS.some((re) => re.test(name))) institutional += 1;
    }
  }
  return { matched_buyer_count: seen.size, institutional_buyer_count: institutional };
}

export function buildBuyerExit({ subjectRow, reconciliation, universes, family, buyerPurchases = [] }) {
  const { matched_buyer_count, institutional_buyer_count } = matchBuyers(subjectRow, buyerPurchases, family);
  const demand = clamp(
    (Math.log2(matched_buyer_count + 1) / Math.log2(33)) * 100 + institutional_buyer_count * 5,
    0,
    100,
  );

  const investorBase = reconciliation.base_investor_exit;
  const investorConservative = reconciliation.conservative_investor_exit;
  const investorOptimistic = reconciliation.optimistic_investor_exit;
  const retail = universes[U.RETAIL_MLS_VALUE];
  const institutional = universes[U.INSTITUTIONAL_VALUE];
  const income = universes[U.INCOME_VALUE];

  const channels = [];
  if (investorConservative) {
    channels.push({ channel: 'LOCAL_WHOLESALE_BUYER', price: investorConservative, base_probability: 0.5 });
    channels.push({ channel: 'FLIPPER', price: investorBase, base_probability: 0.3 });
  }
  if (income?.available || investorBase) {
    channels.push({
      channel: family === ASSET_FAMILIES.SMALL_MULTI ? 'SMALL_MULTI_INVESTOR' : family === ASSET_FAMILIES.MULTIFAMILY ? 'MULTIFAMILY_OPERATOR' : 'BUY_AND_HOLD_LANDLORD',
      price: income?.mid ?? investorBase,
      base_probability: 0.35,
    });
  }
  if (institutional?.available && family === ASSET_FAMILIES.RESIDENTIAL_SINGLE) {
    channels.push({ channel: 'INSTITUTIONAL_SFR', price: institutional.mid, base_probability: 0.2 + institutional_buyer_count * 0.05 });
  }
  if (retail?.available) {
    channels.push({ channel: 'RETAIL_END_BUYER_NOVATION', price: retail.mid, base_probability: 0.3 });
  }

  // Normalize probabilities, weighted by demand for investor channels.
  const adj = channels.map((c) => ({
    ...c,
    weight: c.base_probability * (c.channel.includes('RETAIL') ? 1 : 0.6 + (demand / 100) * 0.8),
  }));
  const total = adj.reduce((s, c) => s + c.weight, 0) || 1;
  const ranked = adj
    .map((c) => ({ channel: c.channel, price: c.price, probability: round(c.weight / total, 3) }))
    .sort((a, b) => b.probability - a.probability);

  const expectedDays = Math.round(45 + (100 - demand) * 1.2);
  const exitConfidence = clamp(
    (reconciliation.investor_exit_confidence ?? 0) * 0.6 + demand * 0.4,
    0,
    100,
  );

  return {
    conservative_buyer_exit: investorConservative,
    base_buyer_exit: investorBase,
    optimistic_buyer_exit: investorOptimistic,
    exit_classification: reconciliation.investor_exit_classification,
    most_likely_exit_channel: ranked[0]?.channel ?? null,
    exit_channels: ranked,
    matched_buyer_count,
    institutional_buyer_count,
    buyer_demand_score: Math.round(demand),
    expected_days_to_disposition: expectedDays,
    exit_confidence: Math.round(exitConfidence),
    assumptions: [
      'exit channel probabilities are heuristic, demand-weighted',
      buyerPurchases.length ? 'matched buyers from buyer_purchase_events' : 'no buyer events available — demand from priors only',
    ],
    missing: buyerPurchases.length ? [] : ['buyer_purchase_events'],
  };
}
