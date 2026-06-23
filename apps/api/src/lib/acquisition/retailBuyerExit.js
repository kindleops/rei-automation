/**
 * Acquisition Engine V3 — Item 5E §19: retail buyer-exit model.
 *
 * Classifies likely retail buyers, matches actual buyer transaction history where
 * available, and produces conservative/base/optimistic exits + expected
 * disposition period. Portfolio acquisitions may SIGNAL demand but contribute no
 * unallocated pricing (mission §12, §19). Pure & deterministic.
 */

import { num, clean, lower, round, roundMoney, clamp } from './modelConstants.js';
import { RETAIL_BUYER_ARCHETYPE as BA, RETAIL_SUBTYPE as ST } from './retailConstants.js';

/** Map a buyer's transaction history into a retail archetype. */
export function classifyRetailBuyer(buyer = {}) {
  const type = lower(buyer.buyer_type);
  const name = lower(buyer.normalized_buyer_name ?? buyer.buyer_name);
  const purchases = num(buyer.purchase_count) ?? num(buyer.transactions) ?? 0;
  const avgPrice = num(buyer.avg_purchase_price) ?? num(buyer.median_purchase_price);

  if (/reit|realty income|national retail|spirit realty|kimco|regency|federal realty|brixmor|simon/.test(name)) return BA.REIT;
  if (/net.?lease|1031|exchange/.test(type)) return BA.NET_LEASE_INVESTOR;
  if (/private equity|\bpe\b|fund/.test(type)) return BA.PRIVATE_EQUITY_RETAIL_FUND;
  if (/redevelop|developer/.test(type)) return BA.REDEVELOPMENT_BUYER;
  if (/distress|opportun/.test(type)) return BA.DISTRESSED_BUYER;
  if (/owner.?occup|user/.test(type)) return BA.OWNER_OCCUPANT;
  if (/ground lease/.test(type)) return BA.GROUND_LEASE_INVESTOR;
  if (purchases >= 5 || (avgPrice !== null && avgPrice >= 10_000_000)) return BA.REGIONAL_SHOPPING_CENTER_OPERATOR;
  return BA.LOCAL_RETAIL_INVESTOR;
}

/**
 * Build the retail buyer-exit picture.
 *
 * @param {object} args
 * @param {object} args.valuation       output of buildRetailValuation
 * @param {object} args.comparables     output of buildRetailComparables (demand_only used as signal)
 * @param {object[]} args.buyers        actual retail buyer records (may be empty)
 * @param {string} args.subtype
 * @param {string} args.operationalStatus
 */
export function buildRetailBuyerExit({ valuation, comparables, buyers = [], subtype = ST.AMBIGUOUS_RETAIL, operationalStatus = 'UNKNOWN' }) {
  const baseValue = num(valuation?.reconciliation?.reconciled_value_mid);
  const valueClassification = valuation?.reconciliation?.value_classification ?? 'NONE';

  const matched = (buyers ?? []).map((b) => ({
    archetype: classifyRetailBuyer(b),
    buyer: clean(b.normalized_buyer_name ?? b.buyer_name) || null,
    avg_price: num(b.avg_purchase_price) ?? num(b.median_purchase_price),
    purchases: num(b.purchase_count) ?? num(b.transactions) ?? 0,
    preferred_price_min: num(b.preferred_price_min),
    preferred_price_max: num(b.preferred_price_max),
    preferred_subtypes: Array.isArray(b.preferred_subtypes) ? b.preferred_subtypes : null,
  }));

  const demandOnlyCount = comparables?.demand_only_count ?? 0;
  const matchedDepth = matched.length;
  let demandScore = 35;
  demandScore += Math.min(40, matchedDepth * 12);
  demandScore += Math.min(15, demandOnlyCount * 3);
  if (operationalStatus === 'VACANT') demandScore -= 12;
  if (operationalStatus === 'DARK') demandScore -= 8;
  if (operationalStatus === 'STABILIZED') demandScore += 5;
  if (subtype === ST.SINGLE_TENANT_NET_LEASE) demandScore += 5; // deep net-lease/1031 demand
  demandScore = Math.round(clamp(demandScore, 0, 100));

  const buyBoxFit = matched.filter((b) =>
    baseValue !== null && b.preferred_price_min !== null && b.preferred_price_max !== null &&
    baseValue >= b.preferred_price_min && baseValue <= b.preferred_price_max).length;

  const subtypeFit = matched.filter((b) => b.preferred_subtypes && b.preferred_subtypes.includes(subtype)).length;

  const exitQualified = valueClassification === 'QUALIFIED' && baseValue !== null;
  const conservative = baseValue !== null ? roundMoney(baseValue * 0.92) : null;
  const base = baseValue;
  const optimistic = baseValue !== null ? roundMoney(baseValue * 1.08) : null;

  let dispositionDays = 180;
  if (operationalStatus === 'STABILIZED') dispositionDays = demandScore >= 60 ? 120 : 165;
  if (operationalStatus === 'VALUE_ADD') dispositionDays = 210;
  if (operationalStatus === 'LEASE_UP') dispositionDays = 240;
  if (operationalStatus === 'VACANT' || operationalStatus === 'DARK') dispositionDays = 270;
  if (operationalStatus === 'REDEVELOPMENT') dispositionDays = 300;
  if (subtype === ST.SINGLE_TENANT_NET_LEASE) dispositionDays = Math.min(dispositionDays, 110);

  const archetypeSummary = {};
  for (const m of matched) archetypeSummary[m.archetype] = (archetypeSummary[m.archetype] ?? 0) + 1;

  return {
    matched_buyers: matched,
    matched_buyer_count: matchedDepth,
    buyer_archetypes: archetypeSummary,
    buy_box_fit_count: buyBoxFit,
    subtype_fit_count: subtypeFit,
    buyer_demand_score: demandScore,
    acquisition_velocity: matchedDepth ? round(matched.reduce((s, b) => s + b.purchases, 0) / matchedDepth, 1) : null,
    portfolio_demand_signal: demandOnlyCount,
    conservative_buyer_exit: exitQualified ? conservative : null,
    base_buyer_exit: exitQualified ? base : null,
    optimistic_buyer_exit: exitQualified ? optimistic : null,
    scenario_conservative_exit: exitQualified ? null : conservative,
    scenario_base_exit: exitQualified ? null : base,
    scenario_optimistic_exit: exitQualified ? null : optimistic,
    expected_disposition_days: dispositionDays,
    buyer_exit_confidence: exitQualified ? clamp(30 + matchedDepth * 10, 0, 80) : clamp(10 + matchedDepth * 5, 0, 40),
    exit_classification: exitQualified ? 'QUALIFIED' : 'PROVISIONAL_SCENARIO',
    // Explicit invariant: portfolio/package supplies demand only, never price.
    portfolio_pricing_excluded: true,
    note: matchedDepth === 0 ? 'No retail buyer identities matched — exit is demand-context only.' : null,
  };
}
