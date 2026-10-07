// ─── offer-sanity.js ────────────────────────────────────────────────────────
// ONE implementation of the offer plausibility guard (2026-10-06,
// "627 Ontario St SE"). Pure, dependency-free; imported by the Decision Engine
// tier gate, the valuation spendability rule, and the offer-ready predicate.
//
// The engine quoted $11.8K cash / $4.9K floor / $27.3K MAO on a $230K value
// (AVM $746K). Three individually "valid" inputs compounded: a Multi-Family
// record with units_count=1 (price_per_unit halved every 2-unit comp), a
// $138K sqft-rate repair estimate (60% of the deflated value), and
// valuation_mid*0.72 - repairs. No existing gate caught the product.
//
// This guard NEVER changes a price. It only withholds MONETARY AUTHORITY
// (AUTO_* tiers / spendability / offer-ready) and routes to human review.

export const OFFER_SANITY_BOUNDS = Object.freeze({
  min_offer_to_value: 0.35,
  max_offer_to_value: 0.9,
  max_mao_to_value: 0.9,
  max_repair_to_value: 0.45,
  // valuation_mid vs the record's AVM: outside [1/2, 2] the comps and the AVM
  // describe different buildings.
  max_avm_divergence: 2,
});

export const OFFER_SANITY_REASONS = Object.freeze({
  NO_VALUATION: "valuation_mid_missing",
  OFFER_LOW: "offer_below_min_fraction_of_value",
  OFFER_HIGH: "offer_above_max_fraction_of_value",
  MAO_HIGH: "mao_above_max_fraction_of_value",
  REPAIRS_HIGH: "repairs_above_max_fraction_of_value",
  AVM_DIVERGENT: "avm_diverges_from_comp_value",
  IDENTITY_CONFLICT: "asset_identity_conflict",
});

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
const ratio = (a, b) => (a != null && b != null && b > 0 ? Math.round((a / b) * 1000) / 1000 : null);
const truthy = (v) => v === true || v === "true";

/** A multifamily label carrying units_count <= 1 (engine-normalized subject). */
export function hasAssetIdentityConflict(subject = {}) {
  return Boolean(
    subject?.asset_family === "multifamily" &&
      num(subject?.units) !== null &&
      num(subject?.units) <= 1,
  );
}

/**
 * Pure plausibility check over the engine's own numbers. Inputs that are absent
 * skip their check, EXCEPT valuation_mid with a positive offer (cannot verify ⇒
 * fail closed). Returns every failing reason, not just the first.
 */
export function evaluateOfferSanity({
  valuation_mid = null,
  recommended_cash_offer = null,
  mao = null,
  estimated_repairs = null,
  avm = null,
  asset_identity_conflict = false,
} = {}, bounds = OFFER_SANITY_BOUNDS) {
  const S = OFFER_SANITY_REASONS;
  const value = num(valuation_mid);
  const offer = num(recommended_cash_offer);
  const ceiling = num(mao);
  const repairs = num(estimated_repairs);
  const avmValue = num(avm);
  const reasons = [];
  const ratios = {
    offer_to_value: ratio(offer, value),
    mao_to_value: ratio(ceiling, value),
    repair_to_value: ratio(repairs, value),
    avm_to_value: ratio(avmValue, value),
  };
  if (truthy(asset_identity_conflict)) reasons.push(S.IDENTITY_CONFLICT);
  if (value == null || value <= 0) {
    if (offer != null && offer > 0) reasons.push(S.NO_VALUATION);
    return { sane: reasons.length === 0, reasons, ratios, bounds };
  }
  if (ratios.offer_to_value != null && offer > 0) {
    if (ratios.offer_to_value < bounds.min_offer_to_value) reasons.push(S.OFFER_LOW);
    if (ratios.offer_to_value > bounds.max_offer_to_value) reasons.push(S.OFFER_HIGH);
  }
  if (ratios.mao_to_value != null && ratios.mao_to_value > bounds.max_mao_to_value) reasons.push(S.MAO_HIGH);
  if (ratios.repair_to_value != null && ratios.repair_to_value > bounds.max_repair_to_value) reasons.push(S.REPAIRS_HIGH);
  if (avmValue != null && avmValue > 0) {
    const divergence = Math.max(avmValue / value, value / avmValue);
    if (divergence > bounds.max_avm_divergence) reasons.push(S.AVM_DIVERGENT);
  }
  return { sane: reasons.length === 0, reasons, ratios, bounds };
}

/**
 * Sanity inputs from a property_acquisition_scores row — full, or projected
 * with top-level aliases (avm, asset_identity_conflict, mao), which win.
 */
export function offerSanityInputs(score = null) {
  const ev = score?.evidence || {};
  const mao = num(score?.mao ?? ev.offer_calculation?.effective_authorized_ceiling);
  return {
    valuation_mid: num(score?.valuation_mid),
    recommended_cash_offer: num(score?.recommended_cash_offer),
    mao: mao != null && mao > 0 ? mao : null,
    estimated_repairs: num(score?.estimated_repairs ?? ev.repair_estimate?.amount),
    avm: num(
      score?.avm ??
        ev.decision_inputs?.inputs?.property?.estimated_value ??
        ev.subject?.normalized_features?.estimated_value,
    ),
    asset_identity_conflict: truthy(score?.asset_identity_conflict ?? ev.subject?.asset_identity_conflict),
  };
}

/** Convenience: evaluate a persisted score row. */
export function evaluateScoreOfferSanity(score = null, bounds = OFFER_SANITY_BOUNDS) {
  return evaluateOfferSanity(offerSanityInputs(score), bounds);
}
