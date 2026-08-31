// ─── valuation-offer-authority.js ───────────────────────────────────────────
// THE gate between "we computed a valuation" and "seller automation may spend
// that number".
//
// WHY THIS EXISTS (proven production defect, canaryprop_6bb8a464…, 2026-08-03):
// The ADE valued a null-featured subject off 2 raw-price comps, one carrying
// $19,032,220 of package/portfolio consideration, and produced
// recommended_cash_offer = $10,969,000. The engine CORRECTLY labelled it
// decision_tier=REVIEW_REQUIRED, confidence=31, valuation_confidence=36 — but
// nothing downstream read those fields. The number still landed on
// acquisition_opportunities.recommended_offer, and resolveAuthorizedOfferAmount
// treated it as spendable because its only guard was a ceiling
// (investor_ceiling_mid) derived from THE SAME contaminated valuation. A
// contaminated valuation validated its own ceiling.
//
// THE INVARIANT
//   A valuation may be persisted for analysis without being spendable.
//   Only an explicitly offer-authoritative valuation may authorize money.
//
// INDEPENDENCE. Spendability is decided from evidence that contamination cannot
// forge: the decision tier, the confidence scores, the comp COUNT, and whether a
// contamination-defense pass actually ran. Inflating a comp's price does not
// create more comps, raise valuation_confidence, or manufacture a defense pass —
// so a contaminated valuation cannot argue itself into being spendable.
//
// NOT A RENAME. REVIEW_REQUIRED keeps its meaning and is still persisted; this
// module only stops it from being *spent*.

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function upper(value) {
  return String(value ?? "").trim().toUpperCase();
}

// The engine's OWN tiers. Only the two that mean "automation may make a cash
// offer" are spendable. CREATIVE_TERMS deliberately is not: it describes a
// structured/creative path, not an authorized cash number. NURTURE and
// REVIEW_REQUIRED are explicitly below the automation bar.
export const OFFER_AUTHORITATIVE_TIERS = Object.freeze(["AUTO_HARD_OFFER", "AUTO_RANGE_OFFER"]);

// removeOutliers() disables MAD below this many scored comps, returning
// `insufficient_count_for_mad` and passing every comp through unfiltered. Below
// this threshold the valuation has had NO statistical contamination defense, so
// it is spendable only when a trusted qualification pass (V3) ran instead.
export const MAD_MIN_COMP_COUNT = 5;

/**
 * Does a V3 qualification pass actually constitute a contamination defense?
 *
 * MEASURED, NOT ASSUMED (shadow replay of canaryprop_6bb8a464…, 2026-08-30):
 * V3's price-plausibility gates are ANCHOR-DEPENDENT. `price_vs_anchor_high`
 * (the 4x rule that rejects the $19,032,220 comp) only runs when
 * deriveAnchors() found a subject anchor — estimated_value, listing_price, or
 * assessed_total_value. The production subject had all three null, so
 * has_anchor was false, the gate was skipped, and V3 ACCEPTED the contaminated
 * comp exactly as V2 did. The sqft gate (`implausible_ppsf_high`) was likewise
 * inert on a null-sqft subject, package detection needs >=4 parcels, and the
 * SFR lane ceiling is $30M — above the bad comp.
 *
 * Replay evidence:
 *   null-featured subject  -> accepted [19032220, 349900], anomaly_flags []
 *   estimated_value 350000 -> rejected 19032220 QUARANTINE price_vs_anchor_high
 *   assessed_total 320000  -> rejected 19032220 QUARANTINE price_vs_anchor_high
 *
 * So "V3 ran" is NOT the same as "V3 defended". Treating the mere presence of a
 * qualification object as a defense would reintroduce the exact bypass this
 * module exists to close, just one flag deeper.
 */
export function resolveV3ContaminationDefense(v3_qualification = null) {
  if (!v3_qualification) return { defended: false, detail: "v3_absent" };
  if (v3_qualification?.anchors?.has_anchor !== true) {
    return { defended: false, detail: "v3_price_gates_inert_without_subject_anchor" };
  }
  return { defended: true, detail: "v3_qualification" };
}

export const NON_SPENDABLE_REASONS = Object.freeze({
  NO_VALUATION: "valuation_absent",
  NO_RECOMMENDATION: "valuation_has_no_recommendation",
  TIER_NOT_AUTHORITATIVE: "valuation_tier_not_offer_authoritative",
  UNDEFENDED_LOW_N: "valuation_low_comp_count_without_contamination_defense",
});

/**
 * Decide whether a persisted valuation may authorize a monetary seller offer.
 *
 * @param {object} valuation  ADE snapshot (property_acquisition_scores row shape)
 * @param {object} v3_qualification  qualifyComps() output, if the V3 pass ran
 * @returns {{spendable:boolean, reason:string, decision_tier:string|null,
 *            comp_count:number|null, confidence:number|null,
 *            valuation_confidence:number|null, contamination_defense:string}}
 */
export function resolveValuationSpendability({ valuation = null, v3_qualification = null } = {}) {
  const v3 = resolveV3ContaminationDefense(v3_qualification);
  if (!valuation) {
    return {
      spendable: false,
      reason: NON_SPENDABLE_REASONS.NO_VALUATION,
      decision_tier: null,
      comp_count: null,
      confidence: null,
      valuation_confidence: null,
      contamination_defense: "none",
      contamination_defense_detail: "v3_absent",
    };
  }

  const decision_tier = upper(valuation.decision_tier) || null;
  const comp_count = num(valuation.comp_count);
  const confidence = num(valuation.confidence);
  const valuation_confidence = num(valuation.valuation_confidence);
  const recommended = num(valuation.recommended_cash_offer);

  // Which contamination defense actually ran for this valuation?
  const contamination_defense = v3.defended
    ? "v3_qualification"
    : comp_count !== null && comp_count >= MAD_MIN_COMP_COUNT
      ? "mad_outlier"
      : "none";

  const base = {
    decision_tier,
    comp_count,
    confidence,
    valuation_confidence,
    contamination_defense,
    contamination_defense_detail: v3.detail,
  };

  if (!recommended || recommended <= 0) {
    return { spendable: false, reason: NON_SPENDABLE_REASONS.NO_RECOMMENDATION, ...base };
  }

  // (1) The engine's own tier must say this is automatable as a cash offer.
  if (!OFFER_AUTHORITATIVE_TIERS.includes(decision_tier)) {
    return { spendable: false, reason: NON_SPENDABLE_REASONS.TIER_NOT_AUTHORITATIVE, ...base };
  }

  // (2) "Too few observations for MAD" must never be read as "all observations
  // are trustworthy". Below the MAD threshold the valuation is spendable only
  // if the V3 qualification layer removed contaminated considerations instead.
  if (contamination_defense === "none") {
    return { spendable: false, reason: NON_SPENDABLE_REASONS.UNDEFENDED_LOW_N, ...base };
  }

  return { spendable: true, reason: "valuation_offer_authoritative", ...base };
}

/**
 * Deterministic, NON-MONETARY next action for a valuation that cannot be spent.
 * Low confidence must not become a permanent manual-operator dependency: the
 * conversation keeps running autonomously on a discovery route, and the offer is
 * retried once better evidence exists.
 */
export function resolveNonSpendableNextAction(spendability = {}) {
  switch (spendability.reason) {
    case NON_SPENDABLE_REASONS.UNDEFENDED_LOW_N:
      // Not enough trustworthy comparable evidence — gather property facts that
      // improve the next valuation rather than guessing a price now.
      return { use_case: "condition_probe", route: "continue_discovery" };
    case NON_SPENDABLE_REASONS.TIER_NOT_AUTHORITATIVE:
      return { use_case: "condition_probe", route: "continue_discovery" };
    case NON_SPENDABLE_REASONS.NO_RECOMMENDATION:
    case NON_SPENDABLE_REASONS.NO_VALUATION:
      return { use_case: "ask_condition_clarifier", route: "retry_valuation_when_evidence_improves" };
    default:
      return { use_case: "condition_probe", route: "continue_discovery" };
  }
}

export default resolveValuationSpendability;
