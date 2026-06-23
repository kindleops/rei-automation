/**
 * Acquisition Engine V3 — Item 5F §19: office & medical-office buyer-exit model.
 *
 * Classifies likely office buyers (general office vs medical office archetypes),
 * matches actual buyer transaction history where available, and produces
 * conservative/base/optimistic exits + expected disposition period. Portfolio
 * acquisitions may SIGNAL demand but contribute no unallocated pricing (mission
 * §12, §19). Pure & deterministic.
 */

import { num, clean, lower, round, roundMoney, clamp } from './modelConstants.js';
import { OFFICE_BUYER_ARCHETYPE as BA, MEDICAL_BUYER_ARCHETYPE as MBA, OFFICE_SUBTYPE as ST } from './officeConstants.js';

/** Map a buyer's transaction history into an office archetype (general or medical). */
export function classifyOfficeBuyer(buyer = {}, { isMedical = false } = {}) {
  const type = lower(buyer.buyer_type);
  const name = lower(buyer.normalized_buyer_name ?? buyer.buyer_name);
  const purchases = num(buyer.purchase_count) ?? num(buyer.transactions) ?? 0;
  const avgPrice = num(buyer.avg_purchase_price) ?? num(buyer.median_purchase_price);

  if (isMedical) {
    if (/healthcare reit|medical properties|healthpeak|welltower|ventas|physicians realty|docs?\b|global medical/.test(name)) return MBA.HEALTHCARE_REIT;
    if (/health system|hospital/.test(type) || /health system|hospital/.test(name)) return MBA.HEALTH_SYSTEM;
    if (/private equity|\bpe\b|fund/.test(type)) return MBA.PRIVATE_EQUITY_HEALTHCARE_RE;
    if (/medical office|mob operator|healthcare operator/.test(type)) return MBA.MEDICAL_OFFICE_OPERATOR;
    if (/physician|medical group/.test(type)) return MBA.PHYSICIAN_GROUP;
    if (/owner.?occup|user/.test(type)) return MBA.OWNER_USER_MEDICAL_BUYER;
    if (/redevelop|developer/.test(type)) return MBA.REDEVELOPMENT_BUYER;
    return MBA.REGIONAL_INVESTOR;
  }

  if (/reit|boston properties|vornado|sl green|hudson pacific|cousins|highwoods|kilroy|brandywine/.test(name)) return BA.OFFICE_REIT;
  if (/private equity|\bpe\b|fund/.test(type)) return BA.PRIVATE_EQUITY_OFFICE_FUND;
  if (/redevelop|developer/.test(type)) return BA.REDEVELOPMENT_BUYER;
  if (/distress|opportun/.test(type)) return BA.DISTRESSED_BUYER;
  if (/owner.?occup|user/.test(type)) return BA.OWNER_USER;
  if (/government|institution/.test(type)) return BA.GOVERNMENT_INSTITUTIONAL_USER;
  if (/condo/.test(type)) return BA.OFFICE_CONDO_BUYER;
  if (purchases >= 5 || (avgPrice !== null && avgPrice >= 15_000_000)) return BA.REGIONAL_OFFICE_OPERATOR;
  return BA.LOCAL_OFFICE_INVESTOR;
}

/**
 * Build the office buyer-exit picture.
 *
 * @param {object} args
 * @param {object} args.valuation       output of buildOfficeValuation
 * @param {object} args.comparables     output of buildOfficeComparables (demand_only used as signal)
 * @param {object[]} args.buyers        actual office buyer records (may be empty)
 * @param {string} args.subtype
 * @param {string} args.operationalStatus
 * @param {boolean} args.isMedical
 */
export function buildOfficeBuyerExit({ valuation, comparables, buyers = [], subtype = ST.AMBIGUOUS_OFFICE, operationalStatus = 'UNKNOWN', isMedical = false }) {
  const baseValue = num(valuation?.reconciliation?.reconciled_value_mid);
  const valueClassification = valuation?.reconciliation?.value_classification ?? 'NONE';

  const matched = (buyers ?? []).map((b) => ({
    archetype: classifyOfficeBuyer(b, { isMedical }),
    buyer: clean(b.normalized_buyer_name ?? b.buyer_name) || null,
    avg_price: num(b.avg_purchase_price) ?? num(b.median_purchase_price),
    purchases: num(b.purchase_count) ?? num(b.transactions) ?? 0,
    preferred_price_min: num(b.preferred_price_min),
    preferred_price_max: num(b.preferred_price_max),
    preferred_subtypes: Array.isArray(b.preferred_subtypes) ? b.preferred_subtypes : null,
  }));

  const demandOnlyCount = comparables?.demand_only_count ?? 0;
  const matchedDepth = matched.length;
  let demandScore = isMedical ? 40 : 32; // medical demand is structurally deeper
  demandScore += Math.min(40, matchedDepth * 12);
  demandScore += Math.min(15, demandOnlyCount * 3);
  if (operationalStatus === 'VACANT') demandScore -= 14;
  if (operationalStatus === 'VALUE_ADD') demandScore -= 4;
  if (operationalStatus === 'STABILIZED') demandScore += 5;
  if (isMedical && (subtype === ST.HOSPITAL_AFFILIATED_MOB || subtype === ST.MEDICAL_OFFICE_BUILDING)) demandScore += 5;
  demandScore = Math.round(clamp(demandScore, 0, 100));

  const buyBoxFit = matched.filter((b) =>
    baseValue !== null && b.preferred_price_min !== null && b.preferred_price_max !== null &&
    baseValue >= b.preferred_price_min && baseValue <= b.preferred_price_max).length;

  const subtypeFit = matched.filter((b) => b.preferred_subtypes && b.preferred_subtypes.includes(subtype)).length;

  const exitQualified = valueClassification === 'QUALIFIED' && baseValue !== null;
  const conservative = baseValue !== null ? roundMoney(baseValue * 0.91) : null;
  const base = baseValue;
  const optimistic = baseValue !== null ? roundMoney(baseValue * 1.08) : null;

  let dispositionDays = isMedical ? 165 : 200;
  if (operationalStatus === 'STABILIZED') dispositionDays = demandScore >= 60 ? (isMedical ? 120 : 150) : (isMedical ? 165 : 195);
  if (operationalStatus === 'VALUE_ADD') dispositionDays = isMedical ? 210 : 240;
  if (operationalStatus === 'LEASE_UP') dispositionDays = 270;
  if (operationalStatus === 'VACANT') dispositionDays = 330;
  if (operationalStatus === 'REDEVELOPMENT') dispositionDays = 360;

  const archetypeSummary = {};
  for (const m of matched) archetypeSummary[m.archetype] = (archetypeSummary[m.archetype] ?? 0) + 1;

  return {
    is_medical: isMedical,
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
    note: matchedDepth === 0 ? 'No office buyer identities matched — exit is demand-context only.' : null,
  };
}
