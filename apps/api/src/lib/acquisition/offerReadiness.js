// ─── offerReadiness.js ──────────────────────────────────────────────────────
// ONE predicate for "may automation quote money for this property?", shared
// by Seller Autopilot v2 (the price branches) and the Campaign Composer's
// "Offer Ready" preflight, so the number an operator sees before launch is
// the number Autopilot will actually act on.
//
// A property is OFFER-READY when its property_acquisition_scores row (the
// production Decision Engine — never valuation v2):
//   • exists,
//   • was computed on/after the current offer-policy epoch (2026-09-12: older
//     rows do not replay under today's policy) AND within max_age_days,
//   • carries an offer-authoritative tier (AUTO_HARD_OFFER / AUTO_RANGE_OFFER),
//   • has a positive recommended offer and a positive authorized ceiling
//     (evidence.offer_calculation.effective_authorized_ceiling),
//   • is NOT a compact backfill row (those carry monetary_authority:false),
//   • passes the OFFER SANITY GUARD (offer-sanity.js): offer and
//     MAO are a believable fraction of the engine's as-is value, repairs are
//     not most of the value, the AVM does not disagree with the comps by >2x,
//     and the subject carries no asset-identity conflict. Fail-closed: no
//     valuation_mid ⇒ not offer-ready.
// Missing / stale / non-authoritative ⇒ Autopilot may converse but must NOT
// quote money. Pure; no I/O.

import { evaluateScoreOfferSanity } from "./offer-sanity.js";

export const OFFER_POLICY_EPOCH = "2026-09-12T00:00:00.000Z";
export const OFFER_READY_MAX_AGE_DAYS = 30;
export const OFFER_AUTHORITATIVE_TIERS = Object.freeze(["AUTO_HARD_OFFER", "AUTO_RANGE_OFFER"]);

export const OFFER_READY_REASONS = Object.freeze({
  READY: "offer_ready",
  NOT_SCORED: "not_scored",
  PREDATES_POLICY: "score_predates_current_policy",
  STALE: "score_stale",
  TIER: "tier_not_offer_authoritative",
  NO_OFFER: "no_recommended_offer",
  NO_CEILING: "no_authorized_ceiling",
  BACKFILL_ROW: "backfill_row_not_monetary_authority",
  SANITY: "offer_sanity_review",
});

// Offer sanity guard: ONE implementation, shared with the Decision Engine tier
// gate and the valuation spendability rule. See offer-sanity.js.
export { OFFER_SANITY_BOUNDS, OFFER_SANITY_REASONS, evaluateOfferSanity, offerSanityInputs } from "./offer-sanity.js";

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The authoritative max (MAO): the engine's effective authorized ceiling. Never investor_ceiling_mid. */
export function authoritativeMaxOffer(score = null) {
  const v = num(score?.evidence?.offer_calculation?.effective_authorized_ceiling);
  return v != null && v > 0 ? v : null;
}

/**
 * PostgREST projection carrying everything evaluateOfferReadiness reads, for
 * callers that must not pull the ~1-2 MB evidence document.
 */
export const OFFER_READY_PROJECTION =
  "property_id,computed_at,decision_tier,recommended_cash_offer,valuation_mid,estimated_repairs," +
  "engine_version:evidence->engine->>version,evidence_mode:evidence->backfill->>evidence_mode," +
  "mao:evidence->offer_calculation->>effective_authorized_ceiling," +
  "avm:evidence->decision_inputs->inputs->property->>estimated_value," +
  "asset_identity_conflict:evidence->subject->>asset_identity_conflict";

export function evaluateOfferReadiness(score = null, { now = Date.now(), maxAgeDays = OFFER_READY_MAX_AGE_DAYS } = {}) {
  const R = OFFER_READY_REASONS;
  if (!score) return { ready: false, reason: R.NOT_SCORED };
  // A compact backfill row ranks and targets; it never prices (scoringBackfill.js).
  if (score?.evidence?.backfill?.monetary_authority === false || score?.evidence_mode === "compact") {
    return { ready: false, reason: R.BACKFILL_ROW };
  }
  const nowMs = typeof now === "number" ? now : Date.parse(now);
  const computedRaw = score.computed_at ?? score.created_at ?? null;
  const computed = computedRaw instanceof Date ? computedRaw.getTime() : Date.parse(computedRaw || "");
  if (!Number.isFinite(computed) || computed < Date.parse(OFFER_POLICY_EPOCH)) return { ready: false, reason: R.PREDATES_POLICY };
  if (nowMs - computed > maxAgeDays * 86_400_000) return { ready: false, reason: R.STALE };
  const tier = String(score.decision_tier || "").trim().toUpperCase();
  if (!OFFER_AUTHORITATIVE_TIERS.includes(tier)) return { ready: false, reason: R.TIER, tier };
  const offer = num(score.recommended_cash_offer);
  if (offer == null || offer <= 0) return { ready: false, reason: R.NO_OFFER, tier };
  const mao = authoritativeMaxOffer(score);
  if (mao == null) return { ready: false, reason: R.NO_CEILING, tier };
  const sanity = evaluateScoreOfferSanity(score);
  if (!sanity.sane) return { ready: false, reason: R.SANITY, tier, offer, mao, sanity };
  return { ready: true, reason: R.READY, tier, offer, mao, computed_at: new Date(computed).toISOString() };
}

/**
 * Preflight summary for a set of sendable property ids:
 * "2,348 sendable · 2,311 offer-ready · 37 review-only".
 */
export function summarizeOfferReadiness(propertyIds = [], scoresById = new Map(), opts = {}) {
  const ids = [...new Set((propertyIds || []).map((v) => String(v ?? "").trim()).filter(Boolean))];
  const by_reason = {};
  let offer_ready = 0;
  for (const id of ids) {
    const verdict = evaluateOfferReadiness(scoresById.get(id) || null, opts);
    if (verdict.ready) offer_ready += 1;
    by_reason[verdict.reason] = (by_reason[verdict.reason] || 0) + 1;
  }
  return {
    sendable: ids.length,
    offer_ready,
    review_only: ids.length - offer_ready,
    by_reason,
    predicate: {
      epoch: OFFER_POLICY_EPOCH,
      max_age_days: opts.maxAgeDays ?? OFFER_READY_MAX_AGE_DAYS,
      tiers: OFFER_AUTHORITATIVE_TIERS,
    },
    label: `${ids.length.toLocaleString("en-US")} sendable · ${offer_ready.toLocaleString("en-US")} offer-ready · ${(ids.length - offer_ready).toLocaleString("en-US")} review-only`,
  };
}

export default evaluateOfferReadiness;
