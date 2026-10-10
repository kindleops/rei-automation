// ─── deal-economics-gate.js ──────────────────────────────────────────────────
// Is this seller's number a deal, a stretch, or a waste of time?
//
// Owner, 2026-10-10 (P0): "We have all the data on the property. We should
// know what's a deal and what isn't. A seller asking $3M on a $174K property
// should never be in Priority."
//
// ONE pure verdict, read by:
//   - the inbox bucket writer (resolve-inbox-state-from-classification.js):
//     a far-above-value ask is stored in the nurture (Follow-up) with the
//     "price_gap" sub-bucket, never Priority;
//   - the Priority / HOT gate (reply-actionability.js resolvePriorityGate);
//   - the SQL cleanup and the PROPOSED view gate (same bands, as literals,
//     guarded by tests/critical/inbox-deal-economics-gate.test.mjs).
//
// Value authority (feedback_valuation_lanes_20261007, project_decision_engine
// _authority_20260912): property_acquisition_scores is canonical. Its
// valuation_mid is "credible" when valuation_confidence >= 50 and it rests on
// >= 3 comps. A PAS row below that, or the properties AVM (estimated_value),
// is a LOW-confidence reference: the far-above band is widened, never removed.
// No reference at all -> "unknown": never a deal by default, never junk by
// default (unknown is unknown).
//
// Lanes (BINDING): SFR = investor as-is value (no repairs); the retail ARV is a
// separate lane, used here only as the 1.5x ARV ceiling; MF 2-4 same-unit
// value; MF 5+ per door (the PAS row is already per-lane); land / other wider.
//
// The ratio is ask / reference value (NOT ask / our offer): "far above value"
// is a statement about the seller's expectation, not about our margin.

export const DEAL_ECONOMICS_VERSION = "deal_economics_v1";

export const DEAL_ECONOMICS_VERDICTS = Object.freeze({
  CREDIBLE: "credible",                    // ask inside the lane's credible band
  STRETCH: "stretch",                      // above the band, below "far above": negotiable
  FAR_ABOVE: "price_far_above_value",      // absurd ask: nurture / Price gap, never Priority
  IMPLAUSIBLY_LOW: "ask_implausibly_low",  // a rent, a typo, "$1": evidence only, never promotes
  UNKNOWN: "unknown",                      // no ask, or no reference value
});

export const PRICE_GAP_REASON_CODE = "price_far_above_value";
export const PRICE_GAP_SUB_BUCKET = "price_gap";

/**
 * Per-lane bands, as multiples of the reference value.
 *   credible   ask <= credible x value
 *   far_above  ask >  far_above x value (credible reference)
 *              ask >  far_above_low_conf x value (AVM / thin PAS reference)
 *              ask >  ARV_CEILING x ARV (any lane, when an ARV exists)
 *   low        ask <  low x value
 */
export const DEAL_ECONOMICS_BANDS = Object.freeze({
  // far_above_low_conf = 2.5 is the classifier's own ESTIMATE_RATIO
  // (price-plausibility.js): an AVM-only reference never judges harsher than
  // the classifier already does.
  sfr: Object.freeze({ credible: 1.25, far_above: 2.0, far_above_low_conf: 2.5, low: 0.15 }),
  mf_2_4: Object.freeze({ credible: 1.3, far_above: 2.0, far_above_low_conf: 2.5, low: 0.15 }),
  mf_5_plus: Object.freeze({ credible: 1.35, far_above: 2.0, far_above_low_conf: 2.5, low: 0.1 }),
  land_other: Object.freeze({ credible: 1.5, far_above: 2.5, far_above_low_conf: 3.0, low: 0.1 }),
});
export const ARV_CEILING = 1.5;
export const CREDIBLE_PAS_MIN_CONFIDENCE = 50;
export const CREDIBLE_PAS_MIN_COMPS = 3;
/**
 * A PAS mid this far from the AVM (either way) is contaminated or mis-laned
 * (prod 10-10: a $332M valuation_mid on a ~$300K house). A low-confidence PAS
 * then yields to the AVM; a "credible" one is demoted to low confidence.
 */
export const PAS_AVM_CONFLICT_RATIO = 3;
/** The interim deal-amount floor (feedback_pipeline_is_projection_20261007). */
export const ASK_FLOOR = 10_000;

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function lower(value) {
  return String(value ?? "").trim().toLowerCase();
}

/** The asset lane from whatever the caller has: PAS evidence, properties row, units. */
export function resolveAssetLane({ property_type = null, asset_class = null, units = null } = {}) {
  const u = Number(units);
  const t = `${lower(asset_class)} ${lower(property_type)}`;
  if (/land|lot|acre/.test(t)) return "land_other";
  if (Number.isFinite(u) && u >= 5) return "mf_5_plus";
  if (/apartment|5\+|commercial/.test(t)) return "mf_5_plus";
  if (Number.isFinite(u) && u >= 2) return "mf_2_4";
  if (/multi/.test(t)) return "mf_2_4";
  if (/other|mixed|industrial|retail|office/.test(t)) return "land_other";
  return "sfr";
}

/**
 * The reference value and its confidence. PAS first (canonical), then the AVM.
 * @returns {{ value:number|null, arv:number|null, source:string|null, confidence:'credible'|'low'|null, conflict?:string }}
 */
export function resolveReferenceValue({ valuation = null, property = null } = {}) {
  const pasMid = num(valuation?.valuation_mid);
  const pasConf = Number(valuation?.valuation_confidence);
  const pasComps = Number(valuation?.comp_count);
  const avm = num(property?.estimated_value ?? valuation?.estimated_value);
  const arv = num(property?.arv_estimate ?? valuation?.arv_estimate);
  if (pasMid) {
    const credible = Number.isFinite(pasConf) && pasConf >= CREDIBLE_PAS_MIN_CONFIDENCE
      && Number.isFinite(pasComps) && pasComps >= CREDIBLE_PAS_MIN_COMPS;
    const conflict = avm ? Math.max(pasMid / avm, avm / pasMid) > PAS_AVM_CONFLICT_RATIO : false;
    if (conflict && !credible) return { value: avm, arv, source: "properties_avm", confidence: "low", conflict: "pas_avm_conflict" };
    return {
      value: pasMid,
      arv,
      source: "property_acquisition_scores",
      confidence: credible && !conflict ? "credible" : "low",
      ...(conflict ? { conflict: "pas_avm_conflict" } : {}),
    };
  }
  if (avm) return { value: avm, arv, source: "properties_avm", confidence: "low" };
  if (arv) return { value: null, arv, source: "properties_arv", confidence: "low" };
  return { value: null, arv: null, source: null, confidence: null };
}

/**
 * @param {object} args
 * @param {number} args.ask            the seller's stated price (or counter), dollars
 * @param {object} [args.valuation]    latest property_acquisition_scores row
 * @param {object} [args.property]     { estimated_value, arv_estimate, property_type, units_count }
 * @returns {{ verdict:string, lane:string, ask:number|null, reference:number|null, arv:number|null,
 *             ratio:number|null, arv_ratio:number|null, reference_source:string|null,
 *             reference_confidence:string|null, rule:string|null, version:string }}
 */
export function assessDealEconomics({ ask = null, valuation = null, property = null } = {}) {
  const amount = num(ask);
  const lane = resolveAssetLane({
    property_type: property?.property_type ?? valuation?.property_type ?? null,
    asset_class: property?.normalized_asset_class ?? property?.asset_class ?? null,
    units: property?.units_count ?? property?.units ?? null,
  });
  const ref = resolveReferenceValue({ valuation, property });
  const bands = DEAL_ECONOMICS_BANDS[lane];
  const ratio = amount && ref.value ? Math.round((amount / ref.value) * 100) / 100 : null;
  const arv_ratio = amount && ref.arv ? Math.round((amount / ref.arv) * 100) / 100 : null;
  const out = (verdict, rule) => ({
    verdict,
    lane,
    ask: amount,
    reference: ref.value,
    arv: ref.arv,
    ratio,
    arv_ratio,
    reference_source: ref.source,
    reference_confidence: ref.confidence,
    reference_conflict: ref.conflict || null,
    rule,
    version: DEAL_ECONOMICS_VERSION,
  });

  if (!amount) return out(DEAL_ECONOMICS_VERDICTS.UNKNOWN, "no_ask");
  if (amount < ASK_FLOOR) return out(DEAL_ECONOMICS_VERDICTS.IMPLAUSIBLY_LOW, "below_deal_floor");
  if (!ref.value && !ref.arv) return out(DEAL_ECONOMICS_VERDICTS.UNKNOWN, "no_reference_value");

  if (arv_ratio !== null && arv_ratio > ARV_CEILING) {
    return out(DEAL_ECONOMICS_VERDICTS.FAR_ABOVE, "above_1_5x_arv");
  }
  if (ratio === null) {
    // Only an ARV is known and the ask is under 1.5x of it: not provably absurd.
    return out(DEAL_ECONOMICS_VERDICTS.UNKNOWN, "arv_only_reference");
  }
  const farAbove = ref.confidence === "credible" ? bands.far_above : bands.far_above_low_conf;
  if (ratio > farAbove) {
    return out(DEAL_ECONOMICS_VERDICTS.FAR_ABOVE, ref.confidence === "credible" ? "above_far_band" : "above_far_band_low_confidence");
  }
  if (ratio < bands.low) return out(DEAL_ECONOMICS_VERDICTS.IMPLAUSIBLY_LOW, "below_low_band");
  if (ratio <= bands.credible) return out(DEAL_ECONOMICS_VERDICTS.CREDIBLE, "inside_credible_band");
  return out(DEAL_ECONOMICS_VERDICTS.STRETCH, "above_credible_band");
}

/** True when the verdict says "absurd ask" (the Price-gap lane). */
export function isPriceFarAboveValue(economics) {
  return lower(economics?.verdict) === DEAL_ECONOMICS_VERDICTS.FAR_ABOVE;
}

export default {
  DEAL_ECONOMICS_VERSION,
  DEAL_ECONOMICS_VERDICTS,
  DEAL_ECONOMICS_BANDS,
  ARV_CEILING,
  PRICE_GAP_REASON_CODE,
  PRICE_GAP_SUB_BUCKET,
  resolveAssetLane,
  resolveReferenceValue,
  assessDealEconomics,
  isPriceFarAboveValue,
};
