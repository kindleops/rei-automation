// ─── valuation-authority.js ─────────────────────────────────────────────────
// Canonical valuation authority resolver (spine §6, gap G5).
//
// ONE resolver normalizes the LIVE valuation engine (ADE V2,
// lib/acquisition/acquisitionDecisionEngine.js) into the canonical contract
// every consumer uses. The send ceiling comes ONLY from this contract (backed
// by the persisted `metadata.ade_snapshot`) — never from another engine's
// number (the comp-intelligence pipeline's ARV×0.75 `max_allowable_offer` is
// a different engine on a different confidence scale with no ledger, and is
// explicitly NOT an authority source here).
//
// Canonical output (spine §6):
//   valuation_method             enum (VALUATION_METHODS below)
//   estimated_value_low/mid/high
//   target_acquisition_price     maximum_acquisition_price
//   initial_offer                offer_confidence (0–1, SINGLE scale)
//   supporting_comps[]           buyer_demand    liquidity
//   calculation_version          reason_codes[]
//
// Scale law: `offer_confidence` is 0–1 EVERYWHERE at this interface.
// Engine-native scales (ADE valuation_confidence is 0–100) are converted at
// this boundary via `normalizeOfferConfidence`, which is also the shared
// helper negotiation policy/state use so the low-confidence gate compares
// like with like. Buyer demand / liquidity remain engine-native 0–100
// SCORES (they are not confidences and are documented as such).
//
// Authority mapping (kept deliberately IDENTICAL to the live negotiation
// state ingestion in seller-flow/negotiation-state.js §1 so the two views of
// authority can never disagree):
//   target_acquisition_price  = ade.recommended_cash_offer
//   maximum_acquisition_price = ade.investor_ceiling_mid ?? ade.investor_ceiling_high
//   initial_offer             = ade.minimum_acceptable_offer ?? recommended
//
// Fail-closed law: absent or incomplete ADE authority, or offer_confidence
// below policy, resolves `insufficient_data` with review reason codes and
// NULL monetary authority — numbers are never fabricated and never borrowed
// from a different engine. Callers route `insufficient_data` to human review
// (reason code `valuation_authority_absent` when no snapshot exists at all).
//
// ── Extension points (interface only — no disabled engine is wired here) ──
//   • V3 anomaly defense (lib/acquisition/v3DecisionPipeline.js, flag OFF):
//     when enabled it surfaces through the SAME ade_snapshot fields
//     (recommended/minimum/valuation_*), so this resolver needs no change —
//     its version travels via `ade_snapshot.evidence.engine.version` into
//     `calculation_version`.
//   • Buyer-intelligence (lib/intel/*): plugs in as future inputs to
//     `buyer_demand` / `liquidity` and as additional `reason_codes`; the
//     output contract above is the interface it must fill — consumers never
//     read that engine directly.
//   • income_noi_cap_rate: reserved method for the income-approach engine
//     (rent roll + expense facts). Until an engine produces NOI-based
//     authority through an ade_snapshot-compatible payload, unit-count
//     routing below never emits it.
//
// Pure module — no I/O, no AI.

export const VALUATION_AUTHORITY_VERSION = "valuation_authority_1.0.0";

export const VALUATION_METHODS = Object.freeze({
  SFR_COMP_PPSF_ARV: "sfr_comp_ppsf_arv",
  SMALL_MULTI_PPU_PPSF: "small_multi_ppu_ppsf",
  MULTIFAMILY_PRICE_PER_UNIT: "multifamily_price_per_unit",
  INCOME_NOI_CAP_RATE: "income_noi_cap_rate",
  INSUFFICIENT_DATA: "insufficient_data",
});

/** Aligned with negotiation-policy MIN_CONFIDENCE_FOR_OFFER (0–1 scale). */
export const MIN_OFFER_CONFIDENCE = 0.45;

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round2(value) {
  return value === null || value === undefined ? null : Math.round(value * 100) / 100;
}

function lower(value) {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * Canonical confidence normalizer: ONE 0–1 scale at every authority boundary.
 *
 * Defensive on input scale: values in (1, 100] are treated as percentages
 * (the ADE V2 native scale) and divided by 100; values already in [0, 1] pass
 * through; anything outside [0, 100] clamps. `null`/non-numeric stays null —
 * an unknown confidence must stay unknown, never default to a passing value.
 */
export function normalizeOfferConfidence(value) {
  const n = num(value);
  if (n === null) return null;
  if (n <= 0) return 0;
  const scaled = n > 1 ? n / 100 : n;
  return round2(Math.min(1, scaled));
}

/**
 * ADE-native confidence normalizer for values read DIRECTLY off an
 * ade_snapshot, which is always the engine's native 0–100 scale. Always
 * divides by 100 — so a native value of 1 means 1% (0.01), never full
 * confidence. Use normalizeOfferConfidence only for mixed-provenance values
 * (persisted state that may already be 0–1).
 */
export function normalizeAdeNativeConfidence(value) {
  const n = num(value);
  if (n === null) return null;
  if (n <= 0) return 0;
  return round2(Math.min(1, n / 100));
}

/** Best-available unit count across property row, seller facts and ADE subject. */
export function resolveUnitsCount({ property = null, facts = null, ade_snapshot = null } = {}) {
  const candidates = [
    property?.units_count,
    property?.unit_count,
    property?.units,
    facts?.units_count,
    facts?.unit_count,
    ade_snapshot?.evidence?.subject?.normalized_features?.units,
  ];
  for (const candidate of candidates) {
    const n = num(candidate);
    if (n !== null && n >= 1) return Math.round(n);
  }
  return null;
}

const MULTIFAMILY_TYPE_HINTS = ["multifamily", "multi family", "multi-family", "apartment", "multi_5_plus"];
const SMALL_MULTI_TYPE_HINTS = ["duplex", "triplex", "fourplex", "quadplex", "multi_2_4", "2-4"];

/**
 * Deterministic method routing by unit count (dominant) then property-type
 * hint. Unknown/1-unit resolves the SFR comp/PPSF/ARV method — the live ADE
 * default. Asset-class STRING parsing authority remains
 * negotiation-policy.normalizeAssetClass / the canonical communication class
 * (spine §7); unit counts dominate every string here exactly as there.
 */
export function resolveValuationMethod({ units_count = null, property_type = null } = {}) {
  const units = num(units_count);
  if (units !== null) {
    if (units >= 5) return VALUATION_METHODS.MULTIFAMILY_PRICE_PER_UNIT;
    if (units >= 2) return VALUATION_METHODS.SMALL_MULTI_PPU_PPSF;
    return VALUATION_METHODS.SFR_COMP_PPSF_ARV;
  }
  const type = lower(property_type).replace(/[\s-]+/g, " ");
  if (MULTIFAMILY_TYPE_HINTS.some((hint) => type.includes(hint))) {
    return VALUATION_METHODS.MULTIFAMILY_PRICE_PER_UNIT;
  }
  if (SMALL_MULTI_TYPE_HINTS.some((hint) => type.includes(hint))) {
    return VALUATION_METHODS.SMALL_MULTI_PPU_PPSF;
  }
  return VALUATION_METHODS.SFR_COMP_PPSF_ARV;
}

function composeCalculationVersion(ade_snapshot) {
  const engineVersion =
    ade_snapshot?.evidence?.engine?.version ||
    ade_snapshot?.engine_version ||
    (ade_snapshot ? "2.0.0" : null);
  return `${engineVersion ? `ade_${engineVersion}` : "ade_none"}/${VALUATION_AUTHORITY_VERSION}`;
}

function baseResult({ method, ade_snapshot, units_count, reason_codes }) {
  return {
    version: VALUATION_AUTHORITY_VERSION,
    valuation_method: method,
    estimated_value_low: null,
    estimated_value_mid: null,
    estimated_value_high: null,
    target_acquisition_price: null,
    maximum_acquisition_price: null,
    initial_offer: null,
    offer_confidence: null,
    supporting_comps: [],
    supporting_comp_count: null,
    buyer_demand: null,
    liquidity: null,
    units_count: units_count ?? null,
    estimated_value_per_unit: null,
    maximum_acquisition_price_per_unit: null,
    calculation_version: composeCalculationVersion(ade_snapshot),
    reason_codes: [...reason_codes],
  };
}

/**
 * Resolve the canonical valuation authority for one property/thread.
 *
 * @param {object} args
 * @param {object} [args.property]      property row ({units_count, property_type, …})
 * @param {object} [args.ade_snapshot]  persisted ADE V2 score row (metadata.ade_snapshot)
 * @param {object} [args.facts]         merged seller facts (unit_count fills property gaps)
 * @param {number} [args.min_offer_confidence]  0–1 policy floor (default MIN_OFFER_CONFIDENCE)
 */
export function resolveValuationAuthority({
  property = null,
  ade_snapshot = null,
  facts = null,
  min_offer_confidence = MIN_OFFER_CONFIDENCE,
} = {}) {
  const units_count = resolveUnitsCount({ property, facts, ade_snapshot });
  const property_type =
    property?.property_type_scope ||
    property?.property_type ||
    ade_snapshot?.evidence?.subject?.asset_type ||
    null;

  // ── Fail closed: no engine output at all ─────────────────────────────────
  if (!ade_snapshot || typeof ade_snapshot !== "object") {
    return baseResult({
      method: VALUATION_METHODS.INSUFFICIENT_DATA,
      ade_snapshot: null,
      units_count,
      reason_codes: ["valuation_authority_absent"],
    });
  }

  const estimated_value_low = num(ade_snapshot.valuation_low);
  const estimated_value_mid = num(ade_snapshot.valuation_mid);
  const estimated_value_high = num(ade_snapshot.valuation_high);
  const target_acquisition_price = num(ade_snapshot.recommended_cash_offer);
  const maximum_acquisition_price =
    num(ade_snapshot.investor_ceiling_mid) ?? num(ade_snapshot.investor_ceiling_high);
  const initial_offer = num(ade_snapshot.minimum_acceptable_offer) ?? target_acquisition_price;
  const offer_confidence = normalizeAdeNativeConfidence(ade_snapshot.valuation_confidence);
  const supporting_comp_count = num(ade_snapshot.comp_count);
  const supporting_comps = Array.isArray(ade_snapshot.evidence?.selected_comps)
    ? ade_snapshot.evidence.selected_comps
    : [];

  const reason_codes = [];

  // ── Fail closed: engine ran but produced no usable monetary authority ────
  if (target_acquisition_price === null || maximum_acquisition_price === null) {
    const incomplete = baseResult({
      method: VALUATION_METHODS.INSUFFICIENT_DATA,
      ade_snapshot,
      units_count,
      reason_codes: ["ade_authority_incomplete"],
    });
    // Real engine estimates are reported when present (they are evidence, not
    // fabrication) — monetary AUTHORITY stays null.
    incomplete.estimated_value_low = estimated_value_low;
    incomplete.estimated_value_mid = estimated_value_mid;
    incomplete.estimated_value_high = estimated_value_high;
    incomplete.offer_confidence = offer_confidence;
    incomplete.supporting_comp_count = supporting_comp_count;
    incomplete.supporting_comps = supporting_comps;
    return incomplete;
  }

  // ── Fail closed: confidence below policy ⇒ review, never an offer ────────
  const floor = num(min_offer_confidence) ?? MIN_OFFER_CONFIDENCE;
  if (offer_confidence === null || offer_confidence < floor) {
    const lowConfidence = baseResult({
      method: VALUATION_METHODS.INSUFFICIENT_DATA,
      ade_snapshot,
      units_count,
      reason_codes: [
        offer_confidence === null ? "valuation_confidence_unknown" : "valuation_confidence_below_policy",
      ],
    });
    lowConfidence.estimated_value_low = estimated_value_low;
    lowConfidence.estimated_value_mid = estimated_value_mid;
    lowConfidence.estimated_value_high = estimated_value_high;
    lowConfidence.offer_confidence = offer_confidence;
    lowConfidence.supporting_comp_count = supporting_comp_count;
    lowConfidence.supporting_comps = supporting_comps;
    return lowConfidence;
  }

  if (supporting_comp_count !== null && supporting_comp_count < 3) {
    reason_codes.push("comp_support_thin");
  }

  const method = resolveValuationMethod({ units_count, property_type });
  const perUnitEligible = units_count !== null && units_count >= 2;

  return {
    version: VALUATION_AUTHORITY_VERSION,
    valuation_method: method,
    estimated_value_low,
    estimated_value_mid,
    estimated_value_high,
    target_acquisition_price,
    maximum_acquisition_price,
    initial_offer,
    offer_confidence,
    supporting_comps,
    supporting_comp_count,
    buyer_demand: num(ade_snapshot.buyer_demand_score),
    liquidity: num(ade_snapshot.liquidity_score),
    units_count,
    estimated_value_per_unit:
      perUnitEligible && estimated_value_mid !== null
        ? round2(estimated_value_mid / units_count)
        : null,
    maximum_acquisition_price_per_unit:
      perUnitEligible ? round2(maximum_acquisition_price / units_count) : null,
    calculation_version: composeCalculationVersion(ade_snapshot),
    reason_codes,
  };
}

export default {
  VALUATION_AUTHORITY_VERSION,
  VALUATION_METHODS,
  MIN_OFFER_CONFIDENCE,
  normalizeOfferConfidence,
  resolveUnitsCount,
  resolveValuationMethod,
  resolveValuationAuthority,
};
