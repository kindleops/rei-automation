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

/** Build the normalized authority from a production property_acquisition_scores row. */
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
    units: num(score?.evidence?.subject?.normalized_features?.units ?? score?.units),
    asset_family: clean(score?.evidence?.subject?.asset_family ?? score?.asset_family).toLowerCase() || null,
    asset_type: clean(score?.evidence?.subject?.asset_type).toLowerCase() || null,
    asset_identity_conflict:
      score?.evidence?.subject?.asset_identity_conflict === true || score?.asset_identity_conflict === true || score?.asset_identity_conflict === "true",
    comps: normalizeComps(score?.evidence?.selected_comps ?? score?.comps),
    target_assignment_fee: num(score?.evidence?.engine?.target_assignment_fee),
  };
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

/** Validate any authority object (production-derived or D's merged engine). Fail closed. */
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
    units: num(input.units),
    comps: normalizeComps(input.comps),
    reasons: Array.isArray(input.reasons) ? [...input.reasons] : [],
    asset_identity_conflict: input.asset_identity_conflict === true,
  };
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

/** Cross-field consistency every authority must pass before it may price. */
function finalize(a) {
  const reasons = [...(a.reasons || [])];
  let ok = a.ok === true;
  if (ok) {
    if (a.ceiling == null || a.recommended == null || a.valuation_mid == null) {
      ok = false;
      reasons.push(AUTHORITY_REASONS.MISSING_FIELD);
    } else {
      if (a.recommended > a.ceiling) {
        ok = false;
        reasons.push(AUTHORITY_REASONS.OFFER_ABOVE_CEILING);
      }
      if (a.ceiling > a.valuation_mid) {
        ok = false;
        reasons.push(AUTHORITY_REASONS.CEILING_ABOVE_VALUE);
      }
    }
  }
  if (a.asset_identity_conflict) {
    ok = false;
    if (!reasons.includes(AUTHORITY_REASONS.IDENTITY_CONFLICT)) reasons.push(AUTHORITY_REASONS.IDENTITY_CONFLICT);
  }
  return { ...a, ok, reasons: [...new Set(reasons)] };
}

/**
 * Pick the authority for a plan: an explicit `authority` (D's engine, behind
 * D's flag) wins; otherwise the production row. Never both mixed (§78).
 */
export function resolvePlanAuthority({ authority = null, ade_snapshot = null, spendability = null, now = Date.now() } = {}) {
  if (authority) return normalizeAuthority(authority);
  return authorityFromScoreRow(ade_snapshot, { spendability, now });
}

export default resolvePlanAuthority;
