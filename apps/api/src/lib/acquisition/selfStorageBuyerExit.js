/**
 * Acquisition Engine V3 — Item 5D §14: storage buyer-exit model.
 *
 * Classifies likely storage buyers, matches actual buyer transaction history
 * where available, and produces conservative/base/optimistic exits + expected
 * disposition period. Portfolio acquisitions may SIGNAL demand but contribute no
 * unallocated pricing (mission §8, §14). Pure & deterministic.
 */

import { num, clean, lower, round, roundMoney, clamp } from './modelConstants.js';
import { STORAGE_BUYER_ARCHETYPE as BA } from './selfStorageConstants.js';

/** Map a buyer's transaction history into a storage archetype. */
export function classifyStorageBuyer(buyer = {}) {
  const type = lower(buyer.buyer_type);
  const name = lower(buyer.normalized_buyer_name ?? buyer.buyer_name);
  const purchases = num(buyer.purchase_count) ?? num(buyer.transactions) ?? 0;
  const avgPrice = num(buyer.avg_purchase_price) ?? num(buyer.median_purchase_price);

  if (/reit|public storage|extra space|cubesmart|life storage|national storage/.test(name)) return BA.REIT;
  if (/institution|platform|fund/.test(type)) return BA.INSTITUTIONAL_PLATFORM;
  if (/private equity|\bpe\b/.test(type)) return BA.PRIVATE_EQUITY;
  if (/developer|construct/.test(type)) return BA.DEVELOPER_CONVERTER;
  if (/value.?add|reposition/.test(type)) return BA.VALUE_ADD_OPERATOR;
  if (/distress|opportun/.test(type)) return BA.DISTRESSED_BUYER;
  if (purchases >= 5 || (avgPrice !== null && avgPrice >= 5_000_000)) return BA.REGIONAL_OPERATOR;
  return BA.LOCAL_OWNER_OPERATOR;
}

/**
 * Build the storage buyer-exit picture.
 *
 * @param {object} args
 * @param {object} args.valuation      output of buildStorageValuation
 * @param {object} args.comparables    output of buildStorageComparables (demand_only used as signal)
 * @param {object[]} args.buyers       actual storage buyer records (may be empty)
 * @param {string} args.operationalStatus
 */
export function buildStorageBuyerExit({ valuation, comparables, buyers = [], operationalStatus = 'UNKNOWN' }) {
  const baseValue = num(valuation?.reconciliation?.reconciled_value_mid);
  const valueClassification = valuation?.reconciliation?.value_classification ?? 'NONE';

  const matched = (buyers ?? []).map((b) => ({
    archetype: classifyStorageBuyer(b),
    buyer: clean(b.normalized_buyer_name ?? b.buyer_name) || null,
    avg_price: num(b.avg_purchase_price) ?? num(b.median_purchase_price),
    purchases: num(b.purchase_count) ?? num(b.transactions) ?? 0,
    preferred_price_min: num(b.preferred_price_min),
    preferred_price_max: num(b.preferred_price_max),
  }));

  // Demand signal blends actual matched buyers + portfolio (demand-only) activity.
  const demandOnlyCount = comparables?.demand_only_count ?? 0;
  const matchedDepth = matched.length;
  let demandScore = 35;
  demandScore += Math.min(40, matchedDepth * 12);
  demandScore += Math.min(15, demandOnlyCount * 3);
  if (operationalStatus === 'DISTRESSED') demandScore -= 10;
  if (operationalStatus === 'STABILIZED') demandScore += 5;
  demandScore = Math.round(clamp(demandScore, 0, 100));

  const buyBoxFit = matched.filter((b) =>
    baseValue !== null && b.preferred_price_min !== null && b.preferred_price_max !== null &&
    baseValue >= b.preferred_price_min && baseValue <= b.preferred_price_max).length;

  // Exits are gated on a qualified value; otherwise scenario-only.
  const exitQualified = valueClassification === 'QUALIFIED' && baseValue !== null;
  const conservative = baseValue !== null ? roundMoney(baseValue * 0.92) : null;
  const base = baseValue;
  const optimistic = baseValue !== null ? roundMoney(baseValue * 1.08) : null;

  // Expected disposition period by status + demand.
  let dispositionDays = 180;
  if (operationalStatus === 'STABILIZED') dispositionDays = demandScore >= 60 ? 120 : 165;
  if (operationalStatus === 'VALUE_ADD') dispositionDays = 200;
  if (operationalStatus === 'LEASE_UP' || operationalStatus === 'DEVELOPMENT') dispositionDays = 270;
  if (operationalStatus === 'DISTRESSED') dispositionDays = 150;

  const archetypeSummary = {};
  for (const m of matched) archetypeSummary[m.archetype] = (archetypeSummary[m.archetype] ?? 0) + 1;

  return {
    matched_buyers: matched,
    matched_buyer_count: matchedDepth,
    buyer_archetypes: archetypeSummary,
    buy_box_fit_count: buyBoxFit,
    buyer_demand_score: demandScore,
    acquisition_velocity: matchedDepth ? round(matched.reduce((s, b) => s + b.purchases, 0) / matchedDepth, 1) : null,
    portfolio_demand_signal: demandOnlyCount,
    price_per_nrsf_range: priceRange(valuation, 'price_per_nrsf'),
    size_range: null,
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
    note: matchedDepth === 0 ? 'No storage buyer identities matched — exit is demand-context only.' : null,
  };
}

function priceRange(valuation, methodKey) {
  const m = valuation?.methods?.[methodKey];
  if (!m || !m.available) return null;
  return { low: m.low, mid: m.mid, high: m.high };
}
