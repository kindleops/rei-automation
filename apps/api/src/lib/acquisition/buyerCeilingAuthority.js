// ─── buyerCeilingAuthority.js ───────────────────────────────────────────────
// THE MONETARY CEILING INVARIANT
//
//   Buyer/investor behavior evidence may CONSTRAIN the seller-offer ceiling.
//   It may NEVER EXPAND it beyond what the property valuation independently
//   supports. A market observation is a corroborating signal or an additional
//   limit — never permission to pay more than the property is worth.
//
//     effective_authorized_ceiling <= valuation_based_ceiling   (cash path)
//
// WHY THIS EXISTS (proven production defect, canaryprop_6bb8a464…, 2026-08-31):
// The valuation leg was healthy — 100 candidates, 99 eligible, 12 selected, MAD
// outlier defense ran, valuation $406,500/$468,200/$521,500, and the
// contaminated $19,032,220 package comp was CORRECTLY excluded. The offer was
// still $5,479,900, because offerCalculation() blended in a second, entirely
// separate evidence leg:
//
//   valuation_based_ceiling = 468,200 * 0.70 - 31,800 = 295,940
//   behavior_based_ceiling  = 21,284,800   <- the SAME $19,032,220 package row,
//                                             re-entering via
//                                             buyer_purchase_events_v2
//   investor.confidence     = 44
//
// and the old branch logic was INVERTED:
//
//   if (behaviorCeiling && investor.confidence >= 45)
//     effectiveCeiling = Math.min(valuationCeiling, behaviorCeiling);  // safe
//   else if (behaviorCeiling)
//     effectiveCeiling = valuationCeiling * 0.75 + behaviorCeiling * 0.25; // EXPANDS
//
// i.e. STRONG buyer evidence was constrained by min(), while WEAK buyer
// evidence was allowed to inflate the ceiling. At confidence 44 — one point
// under the threshold — the blend produced 5,543,155, an 18.7x expansion over
// the valuation ceiling, and the recommendation followed it.
//
// The buyer-ceiling leg had NO contamination defense of any kind: no minimum
// sample size (n=2 was enough to compute quantiles), no outlier rejection, no
// package/portfolio detection, no duplicate-transaction defense. Locality and
// recency were used as WEIGHTS, never as filters.
//
// THRESHOLD PROVENANCE. MAD_MIN_OBSERVATIONS is the engine's own long-standing
// statistical policy (removeOutliers has always disabled MAD below it and
// reported `insufficient_count_for_mad`). It is reused here deliberately rather
// than inventing a new number to make one canary pass.

import { MAD_MIN_OBSERVATIONS, num, roundMoney } from './modelConstants.js';

export const BUYER_CEILING_REASONS = Object.freeze({
  NO_BEHAVIOR_CEILING: 'no_buyer_behavior_ceiling',
  DERIVED_FROM_VALUATION: 'derived_from_valuation_not_behavior',
  INSUFFICIENT_SAMPLE: 'insufficient_sample_for_outlier_defense',
  UNDEFENDED_AFTER_REJECTION: 'surviving_sample_below_outlier_defense_minimum',
  DUPLICATE_DOMINATED: 'sample_dominated_by_duplicate_transactions',
  PACKAGE_CONSIDERATION: 'package_or_portfolio_consideration_present',
});

function median(values = []) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The SAME median-absolute-deviation policy removeOutliers() applies to
 * valuation comps, applied to the buyer-purchase sample. Below
 * MAD_MIN_OBSERVATIONS the defense cannot run — which is reported honestly as
 * `insufficient_count_for_mad`, never as "every observation is trustworthy".
 */
export function applyBuyerSampleOutlierDefense(purchases = []) {
  const rows = Array.isArray(purchases) ? purchases : [];
  if (rows.length < MAD_MIN_OBSERVATIONS) {
    return { selected: rows, rejected: [], method: 'insufficient_count_for_mad', ran: false };
  }
  const values = rows.map((p) => num(p?.adjusted_price)).filter((v) => Number.isFinite(v));
  const center = median(values);
  const mad = median(values.map((v) => Math.abs(v - center)));
  const allowedDeviation = Math.max((mad || 0) * 3.5, (center || 0) * 0.28);
  const selected = [];
  const rejected = [];
  for (const p of rows) {
    const price = num(p?.adjusted_price);
    if (!Number.isFinite(price) || Math.abs(price - center) > allowedDeviation) {
      rejected.push({ ...p, reasons: ['adjusted_price_outlier'] });
    } else {
      selected.push(p);
    }
  }
  return {
    selected,
    rejected,
    method: 'median_absolute_deviation',
    ran: true,
    median: roundMoney(center),
    mad: roundMoney(mad),
    allowed_deviation: roundMoney(allowedDeviation),
  };
}

/**
 * Detect one consideration broadcast across several parcels, and exact
 * duplicate transaction rows. Both make a quantile meaningless.
 */
function detectSampleContamination(purchases = []) {
  const reasons = [];
  const prices = purchases.map((p) => num(p?.purchase_price)).filter(Number.isFinite);
  if (prices.length >= 2) {
    const counts = new Map();
    for (const price of prices) counts.set(price, (counts.get(price) ?? 0) + 1);
    const maxRepeat = Math.max(...counts.values());
    // One identical consideration across multiple parcels is the package
    // signature; it is also how a duplicate row presents.
    if (maxRepeat >= 2 && maxRepeat / prices.length >= 0.5) {
      reasons.push(BUYER_CEILING_REASONS.DUPLICATE_DOMINATED);
    }
  }
  if (purchases.some((p) => p?.is_package === true || p?.package_sale_probability >= 0.5)) {
    reasons.push(BUYER_CEILING_REASONS.PACKAGE_CONSIDERATION);
  }
  return reasons;
}

/**
 * Is the buyer-behavior ceiling trustworthy enough to CONSTRAIN the monetary
 * ceiling? Non-authoritative behavior is simply ignored — it never blocks an
 * otherwise-strong valuation from acting, and it never expands authority.
 *
 * @returns {{authoritative:boolean, reasons:string[], sample_size:number,
 *            defended_sample_size:number, outlier_defense:object}}
 */
export function resolveBuyerCeilingAuthority(investor = null) {
  const reasons = [];
  const purchases = Array.isArray(investor?.purchases) ? investor.purchases : [];
  const behaviorCeiling = num(investor?.mid);

  if (!behaviorCeiling || behaviorCeiling <= 0) reasons.push(BUYER_CEILING_REASONS.NO_BEHAVIOR_CEILING);

  // A ceiling derived by discounting the valuation is not independent evidence;
  // treating it as authoritative would let the valuation corroborate itself.
  if (investor?.summary?.method === 'valuation_discount_fallback') {
    reasons.push(BUYER_CEILING_REASONS.DERIVED_FROM_VALUATION);
  }

  const outlier_defense = applyBuyerSampleOutlierDefense(purchases);
  if (purchases.length < MAD_MIN_OBSERVATIONS) {
    reasons.push(BUYER_CEILING_REASONS.INSUFFICIENT_SAMPLE);
  } else if (outlier_defense.selected.length < MAD_MIN_OBSERVATIONS) {
    reasons.push(BUYER_CEILING_REASONS.UNDEFENDED_AFTER_REJECTION);
  }

  for (const reason of detectSampleContamination(purchases)) {
    if (!reasons.includes(reason)) reasons.push(reason);
  }

  return {
    authoritative: reasons.length === 0,
    reasons,
    sample_size: purchases.length,
    defended_sample_size: outlier_defense.selected.length,
    outlier_defense: {
      method: outlier_defense.method,
      ran: outlier_defense.ran,
      rejected_count: outlier_defense.rejected.length,
      median: outlier_defense.median ?? null,
      mad: outlier_defense.mad ?? null,
      allowed_deviation: outlier_defense.allowed_deviation ?? null,
    },
    minimum_observations: MAD_MIN_OBSERVATIONS,
  };
}

/**
 * THE INVARIANT, in one place.
 *
 * Authoritative buyer behavior may pull the ceiling DOWN (min). Non-authoritative
 * behavior is ignored. The final clamp is unconditional defense in depth: no
 * branch, present or future, may return a ceiling above the independently
 * supported valuation ceiling.
 *
 * The legacy 75/25 blend is retained ONLY through the clamp, so its downward
 * effect on a weak-but-low buyer ceiling is preserved exactly while its upward
 * expansion is removed. This is deliberately the smallest change that closes the
 * hole without loosening anything that was previously conservative.
 */
export function resolveEffectiveAuthorizedCeiling({
  valuation_based_ceiling = null,
  behavior_based_ceiling = null,
  buyer_ceiling_authority = null,
} = {}) {
  const valuationCeiling = num(valuation_based_ceiling);
  const behaviorCeiling = num(behavior_based_ceiling);

  if (!Number.isFinite(valuationCeiling) || valuationCeiling <= 0) {
    return { effective_authorized_ceiling: 0, basis: 'no_valuation_ceiling', clamped: false };
  }

  let effective;
  let basis;
  if (buyer_ceiling_authority?.authoritative && Number.isFinite(behaviorCeiling) && behaviorCeiling > 0) {
    effective = Math.min(valuationCeiling, behaviorCeiling);
    basis = 'authoritative_buyer_behavior_constrains_valuation_ceiling';
  } else if (Number.isFinite(behaviorCeiling) && behaviorCeiling > 0) {
    // Preserve the legacy blend's DOWNWARD effect only.
    effective = Math.min(valuationCeiling, valuationCeiling * 0.75 + behaviorCeiling * 0.25);
    basis = 'non_authoritative_buyer_behavior_may_only_reduce';
  } else {
    effective = valuationCeiling;
    basis = 'valuation_ceiling_only';
  }

  const beforeClamp = effective;
  effective = Math.min(effective, valuationCeiling);

  return {
    effective_authorized_ceiling: roundMoney(effective),
    basis,
    clamped: beforeClamp > valuationCeiling,
    valuation_based_ceiling: roundMoney(valuationCeiling),
    behavior_based_ceiling: Number.isFinite(behaviorCeiling) ? roundMoney(behaviorCeiling) : null,
  };
}
