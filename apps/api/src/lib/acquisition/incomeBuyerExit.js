/**
 * Acquisition Engine V3 — Item 5B: residential-income buyer exit (mission §9).
 *
 * Buyer classes differ by asset family:
 *   2–4 units: local landlord, small multifamily operator, flipper,
 *              owner-occupant/house hacker, novation retail buyer.
 *   5+ units:  local operator, regional operator, syndicator, institutional
 *              multifamily buyer, distressed/value-add buyer.
 * Returns matched classes, observed buyer matches, depth, buy-box fit, and a
 * conservative/base/optimistic exit with a disposition period and confidence.
 */

import {
  ASSET_FAMILIES,
  num,
  lower,
  clean,
  clamp,
  round,
  roundMoney,
} from './modelConstants.js';
import { INSTITUTIONAL_BUYER_PATTERNS } from './valuationUniverses.js';

const SMALL_MULTI_CLASSES = ['LOCAL_LANDLORD', 'SMALL_MULTIFAMILY_OPERATOR', 'FLIPPER', 'OWNER_OCCUPANT_HOUSE_HACKER', 'NOVATION_RETAIL_BUYER'];
const MULTIFAMILY_CLASSES = ['LOCAL_OPERATOR', 'REGIONAL_OPERATOR', 'SYNDICATOR', 'INSTITUTIONAL_MULTIFAMILY', 'DISTRESSED_VALUE_ADD'];

/** Count observed buyers in the subject geography + unit band. */
function observeBuyers(subjectRow, buyerPurchases, family) {
  const subjZip = clean(subjectRow.property_address_zip ?? subjectRow.property_zip);
  const subjMarket = lower(subjectRow.market);
  const seen = new Set();
  let institutional = 0;
  for (const ev of buyerPurchases) {
    const zip = clean(ev.property_zip ?? ev.property_address_zip);
    const market = lower(ev.market);
    if (!((subjZip && zip === subjZip) || (subjMarket && market === subjMarket))) continue;
    const units = num(ev.units_count) ?? 1;
    const bandOk =
      family === ASSET_FAMILIES.SMALL_MULTI ? units >= 2 && units <= 4 : family === ASSET_FAMILIES.MULTIFAMILY ? units >= 5 : true;
    if (!bandOk) continue;
    const key = clean(ev.buyer_key ?? ev.buyer_name);
    if (key) seen.add(key);
    if (ev.is_corporate_buyer === true || INSTITUTIONAL_BUYER_PATTERNS.some((re) => re.test(lower(ev.buyer_name ?? '')))) institutional += 1;
  }
  return { matched_buyer_count: seen.size, institutional_buyer_count: institutional };
}

export function buildIncomeBuyerExit({ subjectRow = {}, contract, valuation, family, buyerPurchases = [] }) {
  const { matched_buyer_count, institutional_buyer_count } = observeBuyers(subjectRow, buyerPurchases, family);
  const classes = family === ASSET_FAMILIES.SMALL_MULTI ? SMALL_MULTI_CLASSES : MULTIFAMILY_CLASSES;

  // Base value off the family's dominant model.
  const dominant = valuation?.values?.[
    family === ASSET_FAMILIES.SMALL_MULTI ? 'direct_adjusted_comparable' : 'stabilized_noi_market_cap'
  ];
  const base = dominant?.available ? dominant.mid : null;

  // Demand from observed buyers (log-scaled) + institutional weighting.
  const demand = clamp((Math.log2(matched_buyer_count + 1) / Math.log2(33)) * 100 + institutional_buyer_count * 4, 0, 100);

  // Buy-box fit: occupancy + condition + income support raise fit.
  const occ = num(contract?.occupancy?.value);
  const incomeSupported = Boolean(valuation?.operating_statement?.income_supported);
  const buyBoxFit = clamp(
    50 + (occ !== null ? (occ > 1 ? occ : occ * 100) - 90 : 0) + (incomeSupported ? 15 : -10),
    0,
    100,
  );

  const conservative = base !== null ? roundMoney(base * 0.92) : null;
  const optimistic = base !== null ? roundMoney(base * 1.06) : null;
  const dispositionDays = Math.round(
    (family === ASSET_FAMILIES.MULTIFAMILY ? 90 : 55) + (100 - demand) * 1.1,
  );
  const confidence = clamp((dominant?.confidence ?? 0) * 0.55 + demand * 0.3 + buyBoxFit * 0.15, 0, 100);

  return {
    family,
    matched_buyer_classes: classes,
    observed_buyer_matches: matched_buyer_count,
    institutional_buyer_count,
    buyer_demand_score: Math.round(demand),
    depth: matched_buyer_count >= 8 ? 'DEEP' : matched_buyer_count >= 3 ? 'MODERATE' : 'THIN',
    buy_box_fit: Math.round(buyBoxFit),
    conservative_exit: conservative,
    base_exit: base !== null ? roundMoney(base) : null,
    optimistic_exit: optimistic,
    disposition_period_days: dispositionDays,
    confidence: Math.round(confidence),
    missing: buyerPurchases.length ? [] : ['buyer_purchase_events'],
  };
}
