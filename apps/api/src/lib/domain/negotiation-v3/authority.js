// ─── negotiation-v3/authority.js ────────────────────────────────────────────
// THE ONE interface through which Negotiation v3 receives value and ceiling.
// Negotiation never computes value (§51): it reads the authoritative offer
// engine's numbers and refuses money when they are missing, stale, not
// offer-authoritative or implausible (§42, §75).
//
// Today's source: the production Decision Engine row (property_acquisition_scores),
// judged by the SAME predicates Autopilot v2 and the Composer use:
//   evaluateOfferReadiness  (offerReadiness.js — epoch, age, AUTO_* tier, offer,
//                            ceiling, compact-backfill, offer-sanity)
//   resolveValuationSpendability (valuation-offer-authority.js — contamination
//                            defense: comp_count ≥ 5 or a V3 pass with an anchor)
// Later source: D's merged engine, which hands a pre-normalized authority object
// (CONTRACT_negotiation.md §3); normalizeAuthority() validates it the same way.

import { evaluateOfferReadiness, OFFER_READY_PROJECTION } from "@/lib/acquisition/offerReadiness.js";
import { resolveValuationSpendability } from "@/lib/domain/seller-flow/valuation-offer-authority.js";

export const AUTHORITY_SOURCES = Object.freeze({
  PRODUCTION_ENGINE: "acquisition_decision_engine",
  MERGED_ENGINE: "offer_engine_v3_merged",
});

export const AUTHORITY_REASONS = Object.freeze({
  NONE: "no_authority",
  NOT_OFFER_READY: "not_offer_ready",
  NOT_SPENDABLE: "not_spendable",
  OFFER_ABOVE_CEILING: "recommended_above_ceiling",
  CEILING_ABOVE_VALUE: "ceiling_above_valuation",
  IDENTITY_CONFLICT: "asset_identity_conflict",
  UNIT_CONFLICT: "unit_count_conflict",
  NOT_FLAGGED_OK: "authority_not_ok",
  MISSING_FIELD: "authority_missing_field",
});

/**
 * The offer-ready predicate's projection plus what spendability reads, so a
 * Composer / batch caller can evaluate isOfferReady() without the evidence blob.
 */
export const OFFER_READY_V3_PROJECTION =
  `${OFFER_READY_PROJECTION},comp_count,confidence,valuation_confidence,minimum_acceptable_offer,` +
  "v3_has_anchor:evidence->v3->qualification->anchors->>has_anchor";

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function clean(value) {
  return String(value ?? "").trim();
}
const pos = (v) => {
  const n = num(v);
  return n != null && n > 0 ? n : null;
};

/**
 * §76 OFFER READY — ONE predicate: offer-ready (offerReadiness.js) AND spendable
 * (valuation-offer-authority.js). Composer, Autopilot and Negotiation must agree.
 * Accepts a full row or an OFFER_READY_V3_PROJECTION row.
 */
/** A projected row (top-level `mao`, no evidence blob) re-shaped so offerReadiness reads its ceiling. */
function shapeProjected(score) {
  if (!score || score.evidence || score.mao == null) return score;
  return { ...score, evidence: { offer_calculation: { effective_authorized_ceiling: num(score.mao) } } };
}

export function isOfferReady(rawScore = null, { now = Date.now(), spendability = null } = {}) {
  const score = shapeProjected(rawScore);
  const readiness = evaluateOfferReadiness(score, { now });
  if (!readiness.ready) return { ready: false, reason: readiness.reason, readiness, spendability: null };
  const v3q =
    score?.evidence?.v3?.qualification ??
    (score?.v3_has_anchor != null ? { anchors: { has_anchor: score.v3_has_anchor === true || score.v3_has_anchor === "true" } } : null);
  const spend = spendability || resolveValuationSpendability({ valuation: score, v3_qualification: v3q });
  if (spend?.spendable !== true) {
    return { ready: false, reason: `not_spendable:${clean(spend?.reason) || "unknown"}`, readiness, spendability: spend };
  }
  return { ready: true, reason: "offer_ready", readiness, spendability: spend };
}

function normalizeComps(list = []) {
  return (Array.isArray(list) ? list : []).map((c) => ({
    id: clean(c?.comp_id ?? c?.id ?? c?.property_id) || null,
    sale_price: num(c?.sale_price),
    distance_miles: num(c?.distance_miles),
    sale_date: c?.sale_date || c?.sold_date || null,
    source: clean(c?.source ?? c?.sale_source).toLowerCase(),
    units: num(c?.units ?? c?.units_count),
  }));
}

const MF_TYPE_RE = /multi|duplex|triplex|fourplex|quadplex|apartment|2-4|5\+/i;

/** Lane from D when given; else derived from the subject (sfr | mf24 | mf5 | null). */
export function normalizeLane(lane = null, { asset_family = null, units = null, property_type = null } = {}) {
  const l = clean(lane).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (l === "sfr" || l === "singlefamily") return "sfr";
  if (["mf24", "mf2to4", "multi24", "smallmultifamily"].includes(l)) return "mf24";
  if (["mf5", "mf5plus", "multi5plus", "largemultifamily"].includes(l)) return "mf5";
  const u = num(units);
  const mf = clean(asset_family).toLowerCase() === "multifamily" || MF_TYPE_RE.test(clean(property_type));
  if (mf && u != null && Number.isInteger(u) && u >= 5) return "mf5";
  if (mf && u != null && Number.isInteger(u) && u >= 2) return "mf24";
  if (!mf && (u == null || u <= 1)) return clean(asset_family).toLowerCase() === "residential" ? "sfr" : null;
  return null;
}

/** Build the normalized authority from a production property_acquisition_scores row (prod v2: ungraded). */
export function authorityFromScoreRow(score = null, { spendability = null, now = Date.now() } = {}) {
  const base = {
    source: AUTHORITY_SOURCES.PRODUCTION_ENGINE,
    engine_version: clean(score?.evidence?.engine?.version ?? score?.engine_version) || null,
    score_version: score ? `ade_${clean(score?.evidence?.engine?.version ?? score?.engine_version) || "unknown"}` : null,
    snapshot_id: clean(score?.evidence?.immutable_snapshot_id ?? score?.id) || null,
    property_id: clean(score?.property_id) || null,
    computed_at: score?.computed_at || score?.created_at || null,
    decision_tier: clean(score?.decision_tier).toUpperCase() || null,
    ceiling: pos(score?.mao ?? score?.evidence?.offer_calculation?.effective_authorized_ceiling),
    recommended: pos(score?.recommended_cash_offer),
    valuation_mid: pos(score?.valuation_mid),
    estimated_repairs: num(score?.estimated_repairs),
    investor_price: null, // prod v2 carries no investor price cluster
    confidence_grade: null, // prod v2 is ungraded (D grades the merged engine)
    fallback_rung: null,
    units: num(score?.evidence?.subject?.normalized_features?.units ?? score?.units),
    asset_family: clean(score?.evidence?.subject?.asset_family ?? score?.asset_family).toLowerCase() || null,
    asset_type: clean(score?.evidence?.subject?.asset_type).toLowerCase() || null,
    asset_identity_conflict:
      score?.evidence?.subject?.asset_identity_conflict === true || score?.asset_identity_conflict === true || score?.asset_identity_conflict === "true",
    comps: normalizeComps(score?.evidence?.selected_comps ?? score?.comps),
    per_unit_band: null,
  };
  base.lane = normalizeLane(null, { asset_family: base.asset_family, units: base.units });
  if (!score) return finalize({ ...base, ok: false, fresh: false, reasons: [AUTHORITY_REASONS.NONE] });
  const verdict = isOfferReady(score, { now, spendability });
  const reasons = [];
  if (!verdict.ready) {
    reasons.push(verdict.readiness?.ready ? AUTHORITY_REASONS.NOT_SPENDABLE : AUTHORITY_REASONS.NOT_OFFER_READY, verdict.reason);
    if (verdict.readiness?.sanity?.reasons) reasons.push(...verdict.readiness.sanity.reasons.map((r) => `sanity:${r}`));
  }
  const fresh = !["score_predates_current_policy", "score_stale", "not_scored"].includes(verdict.readiness?.reason);
  return finalize({ ...base, ok: verdict.ready, fresh, reasons, offer_ready: verdict.reason });
}

/**
 * D's getAuthoritativeOffer() output (CONTRACT_offer_authority.md) → C's shape.
 * Never blank: the numbers are read from the top level, or from
 * negotiation_authority when the top level withholds them as non-authorized.
 * Fields consumed: lane, investor_price, ceiling, offer, per_unit
 * {units, value, ceiling, offer, band:{low,high}}, confidence_grade,
 * fallback_rung, authorized, fresh, reasons.
 */
export function authorityFromOfferAuthority(a = null) {
  if (!a || typeof a !== "object") return normalizeAuthority(null);
  const na = a.negotiation_authority && typeof a.negotiation_authority === "object" ? a.negotiation_authority : {};
  const pu = a.per_unit && typeof a.per_unit === "object" ? a.per_unit : null;
  const band = pu?.band || (pu?.band_low != null ? { low: pu.band_low, high: pu.band_high } : null);
  return normalizeAuthority({
    ...na,
    source: na.source || a.engine || null,
    engine_version: na.engine_version || a.engine_version || null,
    property_id: na.property_id || a.property_id || null,
    computed_at: na.computed_at || a.computed_at || null,
    decision_tier: a.execution_state || null,
    ok: a.authorized === true,
    fresh: a.fresh === true,
    reasons: Array.isArray(a.reasons) ? a.reasons : na.reasons || [],
    ceiling: a.ceiling ?? na.ceiling,
    recommended: a.offer ?? na.recommended,
    valuation_mid: a.value ?? na.valuation_mid,
    investor_price: a.investor_price ?? null,
    confidence_grade: a.confidence_grade ?? null,
    fallback_rung: a.fallback_rung ?? null,
    lane: a.lane ?? na.lane ?? null,
    units: pu?.units ?? na.units ?? null,
    per_unit_band: band ? { low: pos(band.low), high: pos(band.high) } : null,
  });
}

/**
 * Validate any authority object (production-derived or D's). `ok` (= authorized)
 * gates AUTONOMY only; `has_numbers` says whether a plan can be built.
 */
export function normalizeAuthority(input = null) {
  if (!input || typeof input !== "object") {
    return finalize({ source: null, ok: false, fresh: false, reasons: [AUTHORITY_REASONS.NONE], comps: [] });
  }
  const a = {
    ...input,
    ceiling: pos(input.ceiling),
    recommended: pos(input.recommended),
    valuation_mid: pos(input.valuation_mid),
    estimated_repairs: num(input.estimated_repairs),
    investor_price: pos(input.investor_price),
    confidence_grade: clean(input.confidence_grade).toUpperCase() || null,
    fallback_rung: num(input.fallback_rung),
    units: num(input.units),
    comps: normalizeComps(input.comps),
    reasons: Array.isArray(input.reasons) ? [...input.reasons] : [],
    asset_identity_conflict: input.asset_identity_conflict === true,
  };
  a.lane = normalizeLane(input.lane, { asset_family: input.asset_family, units: a.units });
  if (input.ok !== true) {
    a.ok = false;
    if (!a.reasons.length) a.reasons.push(AUTHORITY_REASONS.NOT_FLAGGED_OK);
  }
  if (input.fresh !== true) {
    a.ok = false;
    a.reasons.push("authority_not_fresh");
  }
  return finalize(a);
}

/** Cross-field consistency. Numbers need C and R with R ≤ C; authorization needs more. */
function finalize(a) {
  const reasons = [...(a.reasons || [])];
  let ok = a.ok === true;
  const has_numbers = a.ceiling != null && a.recommended != null && a.recommended <= a.ceiling;
  if (a.ceiling != null && a.recommended != null && a.recommended > a.ceiling) reasons.push(AUTHORITY_REASONS.OFFER_ABOVE_CEILING);
  if (!has_numbers) {
    ok = false;
    if (a.ceiling == null || a.recommended == null) reasons.push(AUTHORITY_REASONS.MISSING_FIELD);
  }
  if (ok && a.valuation_mid != null && a.ceiling > a.valuation_mid) {
    ok = false;
    reasons.push(AUTHORITY_REASONS.CEILING_ABOVE_VALUE);
  }
  if (a.asset_identity_conflict) {
    ok = false;
    if (!reasons.includes(AUTHORITY_REASONS.IDENTITY_CONFLICT)) reasons.push(AUTHORITY_REASONS.IDENTITY_CONFLICT);
  }
  return { ...a, ok, authorized: ok, has_numbers, reasons: [...new Set(reasons)] };
}

/**
 * Pick the authority for a plan, in this order (never mixed, §78):
 *   offer_authority (D's getAuthoritativeOffer output) → authority (pre-normalized) → ade_snapshot (prod row).
 */
export function resolvePlanAuthority({ offer_authority = null, authority = null, ade_snapshot = null, spendability = null, now = Date.now() } = {}) {
  if (offer_authority) return authorityFromOfferAuthority(offer_authority);
  if (authority) return normalizeAuthority(authority);
  return authorityFromScoreRow(ade_snapshot, { spendability, now });
}

export default resolvePlanAuthority;
