// ─── resolve-intent-state-promotion.js ───────────────────────────────────────
// Turns a classified inbound intent into the durable state the ontology
// already says it should produce.
//
// THE GAP THIS CLOSES
//   inbound-intent-ontology.js declares, for every intent, the canonical
//   durable outcome -- for not_interested:
//       { operational_status: "paused", lead_temperature: "cold",
//         disposition: "not_interested", automation: "pause" }
//   Nothing read it. `state_hints` had ZERO consumers across lib/ and app/.
//   So the specification was complete and correct, and no code applied it:
//   44 sellers who said "Not selling" kept disposition = null, stayed in
//   Priority, and read as live leads to every downstream consumer. The send
//   gate had to rediscover the refusal from raw messages on every batch.
//
//   This produces the PATCH ONLY. The write goes through
//   patchUniversalLeadState, which stays the single state-transition
//   authority -- no second mutation path is introduced.
//
// DECLINE IS NOT OPT-OUT
//   A decline sets disposition=not_interested and pauses automation. It never
//   sets suppression, never blocks contact, and is reversible: a seller who
//   later asks "what would you offer?" is promoted back to active. Opt-out is
//   a different intent with a different, non-reversible outcome, and this
//   module will not emit suppression for any decline.

import { getIntentDefinition, normalizeToCanonicalIntent } from "@/lib/domain/classification/inbound-intent-ontology.js";
import { detectSaleDecline } from "@/lib/domain/classification/detect-sale-decline.js";

function clean(value) {
  return String(value ?? "").trim();
}

/** Intents whose durable outcome is "declined to sell", not suppression. */
export const DECLINE_INTENTS = Object.freeze(["not_interested", "listed_or_unavailable"]);

/**
 * Intents that mean re-engagement: these REOPEN a previously declined lead.
 * CANONICAL slugs -- normalizeToCanonicalIntent maps "asking_price" to
 * "gives_asking_price", so the raw label would never have matched.
 *
 * seller_initiated_after_stop is deliberately EXCLUDED: that is a compliance
 * situation, not an ordinary re-engagement, and it is not this module's to act
 * on.
 */
export const REOPENING_INTENTS = Object.freeze([
  "interested", "conditionally_interested", "re_engagement", "changed_mind",
  "requests_offer", "asks_price", "gives_asking_price", "price_negotiation",
  "timeline_negotiation", "requests_call", "asks_buyer_still_interested",
]);

/**
 * Suppression is owned by the compliance path, never by a stage transition.
 * patchUniversalLeadState already strips disposition='suppressed'; this is the
 * matching refusal at the source so a decline can never travel as one.
 */
const FORBIDDEN_DISPOSITIONS = new Set(["suppressed", "dnc", "opt_out", "do_not_contact"]);

/**
 * NOTE ON AN ONTOLOGY OVERLAP FOUND WHILE BUILDING THIS.
 *
 * The ontology's header states "Never conflate with opt_out", but its
 * state_hints give opt_out the SAME disposition as a decline
 * (disposition:"not_interested"); the two differ only by
 * automation:"stop" vs "pause". So `disposition` alone cannot tell a legal
 * opt-out from a commercial refusal -- automation, and the compliance
 * suppression fields this module never writes, are what separate them.
 *
 * Deliberately NOT "fixed" here by inventing a new disposition value: that
 * would be a new canonical state, which this pass was asked not to create.
 * Recorded so the next reader is not misled by the overlap.
 */

/**
 * @param {{ intent?: string|null, body?: string|null, currentDisposition?: string|null }} args
 * @returns {{ patch: object|null, reason: string, facts: object }}
 */
export function resolveIntentStatePromotion({ intent = null, body = null, currentDisposition = null } = {}) {
  // Only normalise a real label. normalizeToCanonicalIntent(null) returns
  // "unclear", which carries its own state_hints -- so an absent intent would
  // otherwise manufacture durable state out of nothing.
  const rawIntent = clean(intent);
  const canonical = rawIntent ? (normalizeToCanonicalIntent(rawIntent) || rawIntent) : null;
  const decline = detectSaleDecline(body);
  const current = clean(currentDisposition).toLowerCase();

  const facts = {
    canonical_intent: canonical,
    ownership_affirmed: decline.ownership_affirmed,
    declined_by_text: decline.declined,
    compound_message: decline.compound,
  };

  // A seller re-engaging outranks a stale decline. Only ordinary sale-interest
  // language reopens; it must never clear a compliance state, which this
  // module does not own and does not touch.
  if (REOPENING_INTENTS.includes(canonical) && current === "not_interested") {
    return {
      patch: { disposition: "none", operational_status: "active_communication", automation: "continue" },
      reason: "reopened_by_seller_interest",
      facts,
    };
  }

  const isDeclineIntent = DECLINE_INTENTS.includes(canonical);

  // The compound case. "Si, pero no esta de venta!" classifies as
  // ownership_confirmed because the affirmation comes first; the refusal after
  // it is the actual answer to the question that matters. The ownership fact is
  // preserved alongside, never discarded.
  if (!isDeclineIntent && decline.declined) {
    const declineDef = getIntentDefinition("not_interested");
    const hints = declineDef?.state_hints || {};
    return {
      patch: sanitize({
        disposition: hints.disposition || "not_interested",
        operational_status: hints.operational_status || "paused",
        lead_temperature: hints.lead_temperature || "cold",
        automation: hints.automation || "pause",
        ...(decline.ownership_affirmed ? { ownership_claim: "confirmed" } : {}),
      }),
      reason: decline.ownership_affirmed
        ? "compound_ownership_confirmed_with_sale_decline"
        : "decline_detected_in_text",
      facts,
    };
  }

  if (!canonical) return { patch: null, reason: "no_canonical_intent", facts };

  const definition = getIntentDefinition(canonical);
  const hints = definition?.state_hints;
  if (!hints) return { patch: null, reason: "no_state_hints_for_intent", facts };

  const patch = sanitize({
    ...(hints.disposition && hints.disposition !== "none" ? { disposition: hints.disposition } : {}),
    ...(hints.operational_status ? { operational_status: hints.operational_status } : {}),
    ...(hints.lead_temperature ? { lead_temperature: hints.lead_temperature } : {}),
    ...(hints.automation ? { automation: hints.automation } : {}),
    ...(hints.lifecycle_stage ? { lifecycle_stage: hints.lifecycle_stage } : {}),
    ...(decline.ownership_affirmed ? { ownership_claim: "confirmed" } : {}),
  });

  if (!Object.keys(patch).length) return { patch: null, reason: "ontology_hints_empty", facts };
  return { patch, reason: `ontology_state_hints:${canonical}`, facts };
}

/** A stage transition may never emit a compliance/suppression disposition. */
function sanitize(patch) {
  const out = { ...patch };
  if (FORBIDDEN_DISPOSITIONS.has(String(out.disposition ?? "").toLowerCase())) {
    delete out.disposition;
  }
  return out;
}

export default { resolveIntentStatePromotion, DECLINE_INTENTS, REOPENING_INTENTS };
