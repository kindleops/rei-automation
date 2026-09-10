// ─── safe-fallback.js ────────────────────────────────────────────────────
// Universal, STAGE-AWARE safe fallback for messages that cannot be confidently
// classified (audit §9).
//
// A single generic "Could you clarify?" is explicitly insufficient. The
// fallback must, per stage AND per uncertainty type:
//   - acknowledge the seller naturally
//   - ask ONE precise clarifying question
//   - never make an offer or legal commitment
//   - never falsely assume ownership
//   - never PRESUPPOSE an event that may not have happened
//   - preserve the current lifecycle stage
//   - leave the next inbound message to be reclassified WITH context
//
// These are PREPARED replies (suggested_text). Whether they actually dispatch is
// still governed by the existing auto-reply gates in apply-inbound-automation-
// decision.js / handle-textgrid-inbound.js, this module never sends.
//
// ── 2026-09-10 INCIDENT: TOPIC LABEL READ AS LIFECYCLE POSITION ─────────────
// classify.js detectStageHint() returns a legacy TOPIC label -- "Ownership",
// "Offer", "Q/A", "Contract", "Follow-Up" -- and returns "Offer" for ANY message
// containing "offer", "price", "number" or "how much". That label was reaching
// resolveStageBucket(), which matched the substring "offer" and returned the S5
// LIFECYCLE bucket, whose copy assumes an offer was already presented.
//
// A seller answering the very first text with the single word "Offer" was told
// "are you still open to the offer, or should I hold off?" -- a break-up line
// about an offer that never existed. 16 sellers received it. One replied
// "Never had an offer worth my time, please remove me from your list".
//
// Two defenses now, because either alone would have prevented that send:
//   1. LATE buckets (offer, negotiation_close) are reachable ONLY by an exact
//      match against a real lifecycle stage identifier. Loose substring matching
//      can now only ever land on an EARLY bucket. A topic label cannot promote a
//      conversation to the offer stage.
//   2. No string presupposes a prior event unless its bucket is exact-matched
//      late-stage, where the event is known to have happened.

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

// Uncertainty types drive WHICH question we ask.
export const UNCERTAINTY_TYPES = Object.freeze([
  "identity",
  "intent",
  "price",
  "condition",
  "offer",
  "contract",
  "language",
]);

// High-level stage buckets used for tailoring tone/content.
const STAGE_BUCKETS = Object.freeze({
  S1: "ownership",
  S2: "consider_selling",
  S3: "asking_price",
  S4: "condition",
  S5: "offer",
  S6: "negotiation_close",
});

// Buckets whose copy is allowed to reference something that already happened
// (a number we sent, terms under discussion). Reaching one of these REQUIRES an
// exact lifecycle-stage match below.
const LATE_BUCKETS = new Set([STAGE_BUCKETS.S5, STAGE_BUCKETS.S6]);

// EXACT lifecycle identifiers only. Keys are lowercased. These are the canonical
// SELLER_FLOW_STAGES values and the CONVERSATION_STAGES display labels. A value
// absent from this table is NOT trusted to be a lifecycle position.
const EXACT_STAGE_BUCKETS = Object.freeze({
  // ── SELLER_FLOW_STAGES ──
  ownership_check: STAGE_BUCKETS.S1,
  ownership_check_follow_up: STAGE_BUCKETS.S1,
  wrong_person: STAGE_BUCKETS.S1,
  who_is_this: STAGE_BUCKETS.S1,
  how_got_number: STAGE_BUCKETS.S1,
  reengagement: STAGE_BUCKETS.S1,
  not_interested: STAGE_BUCKETS.S1,
  stop_or_opt_out: STAGE_BUCKETS.S1,
  terminal: STAGE_BUCKETS.S1,
  consider_selling: STAGE_BUCKETS.S2,
  consider_selling_follow_up: STAGE_BUCKETS.S2,
  asking_price: STAGE_BUCKETS.S3,
  asking_price_follow_up: STAGE_BUCKETS.S3,
  justify_price: STAGE_BUCKETS.S3,
  narrow_range: STAGE_BUCKETS.S3,
  price_works_confirm_basics: STAGE_BUCKETS.S4,
  price_works_confirm_basics_follow_up: STAGE_BUCKETS.S4,
  price_high_condition_probe: STAGE_BUCKETS.S4,
  price_high_condition_probe_follow_up: STAGE_BUCKETS.S4,
  ask_timeline: STAGE_BUCKETS.S4,
  ask_condition_clarifier: STAGE_BUCKETS.S4,
  mf_confirm_units: STAGE_BUCKETS.S4,
  mf_confirm_units_follow_up: STAGE_BUCKETS.S4,
  mf_occupancy: STAGE_BUCKETS.S4,
  mf_occupancy_follow_up: STAGE_BUCKETS.S4,
  mf_rents: STAGE_BUCKETS.S4,
  mf_rents_follow_up: STAGE_BUCKETS.S4,
  mf_expenses: STAGE_BUCKETS.S4,
  mf_expenses_follow_up: STAGE_BUCKETS.S4,
  mf_underwriting_ack: STAGE_BUCKETS.S4,
  creative_probe: STAGE_BUCKETS.S5,
  creative_followup: STAGE_BUCKETS.S5,
  creative_follow_up: STAGE_BUCKETS.S5,
  offer_reveal_cash: STAGE_BUCKETS.S5,
  offer_reveal_cash_follow_up: STAGE_BUCKETS.S5,
  offer_reveal_lease_option: STAGE_BUCKETS.S5,
  offer_reveal_subject_to: STAGE_BUCKETS.S5,
  offer_reveal_novation: STAGE_BUCKETS.S5,
  mf_offer_reveal: STAGE_BUCKETS.S5,
  close_handoff: STAGE_BUCKETS.S6,
  // ── CONVERSATION_STAGES display labels ──
  "ownership confirmation": STAGE_BUCKETS.S1,
  "offer interest confirmation": STAGE_BUCKETS.S2,
  "seller price discovery": STAGE_BUCKETS.S3,
  "condition / timeline discovery": STAGE_BUCKETS.S4,
  "offer positioning": STAGE_BUCKETS.S5,
  negotiation: STAGE_BUCKETS.S6,
  "verbal acceptance / lock": STAGE_BUCKETS.S6,
  "contract out": STAGE_BUCKETS.S6,
  "signed / closing": STAGE_BUCKETS.S6,
  "closed / dead outcome": STAGE_BUCKETS.S1,
});

// Legacy TOPIC labels emitted by classify.js detectStageHint(). These describe
// what a message is ABOUT, not where the conversation IS. "Offer" here means
// "this message mentions an offer or a price", which is exactly what a seller
// asking us for a number produces. They must never promote to a late bucket.
const TOPIC_LABEL_BUCKETS = Object.freeze({
  ownership: STAGE_BUCKETS.S1,
  offer: STAGE_BUCKETS.S2,
  "q/a": STAGE_BUCKETS.S2,
  qa: STAGE_BUCKETS.S2,
  contract: STAGE_BUCKETS.S2,
  "follow-up": STAGE_BUCKETS.S1,
  follow_up: STAGE_BUCKETS.S1,
});

/**
 * Resolve a stage string to a bucket.
 *
 * Order: exact lifecycle match, then legacy topic label, then a CONSERVATIVE
 * substring pass that can only ever return an EARLY bucket. Anything unknown
 * lands on ownership, the safest possible assumption.
 */
function resolveStageBucket(stage = null) {
  const s = lower(stage);
  if (!s) return STAGE_BUCKETS.S1;

  const exact = EXACT_STAGE_BUCKETS[s];
  if (exact) return exact;

  const topic = TOPIC_LABEL_BUCKETS[s];
  if (topic) return topic;

  // Conservative pass. Deliberately cannot return a LATE bucket: an unrecognised
  // string is not evidence that an offer was made or that terms are on the table.
  if (s.includes("ownership") || s.includes("owner")) return STAGE_BUCKETS.S1;
  if (s.includes("consider") || s.includes("offer_interest") || s.includes("offer interest")) {
    return STAGE_BUCKETS.S2;
  }
  if (s.includes("condition") || s.includes("timeline") || s.includes("occupancy") || s.includes("rents")) {
    return STAGE_BUCKETS.S4;
  }
  if (s.includes("price") || s.includes("asking")) return STAGE_BUCKETS.S3;
  return STAGE_BUCKETS.S1;
}

// (uncertainty x stage_bucket) → one precise, safe clarifier.
//
// COPY RULES: ends in a question; no street address; no "respectful of your
// time" throat-clearing; no long dashes (see no-em-dash-sms.test.mjs); and no
// reference to an offer, a number we sent, or terms under discussion unless the
// bucket is a LATE bucket, which is now exact-match only.
const FALLBACK_MATRIX = Object.freeze({
  identity: {
    ownership: "Just so I reach the right person, are you the owner of the property, or should I be speaking with someone else?",
    consider_selling: "Quick check before we go further, is this property something you own, or are you helping someone who does?",
    asking_price: "Before I talk numbers, can you confirm you're the owner, or able to sell it?",
    condition: "So I have the right contact, are you the owner, or the person managing the property?",
    offer: "Want to make sure I'm working with the right person, are you the owner or authorized to make a decision?",
    negotiation_close: "Before we move toward paperwork, can you confirm you're the owner or have authority to sign?",
  },
  intent: {
    ownership: "Thanks for getting back to me. Are you open to a quick conversation about the property, or would you rather I not reach out?",
    consider_selling: "Appreciate the reply. Would you consider selling it, or is it not something you'd part with?",
    asking_price: "Got it. Do you have a ballpark number in mind for it?",
    condition: "Thanks. Would you want me to work up a number on it, or are you just gathering info?",
    offer: "Thanks for getting back to me. What are your thoughts on the number I sent over?",
    negotiation_close: "Just making sure I follow you, do you want to keep moving forward, or is something still off?",
  },
  price: {
    ownership: "Before we talk price, are you the owner I should be working with?",
    consider_selling: "Sounds like there may be a number in mind, what would you want for the property?",
    asking_price: "Thanks, just to make sure I read that right, is that the number you'd want for the property?",
    condition: "Want to confirm I have the right figure, what number are you hoping to get?",
    offer: "Appreciate that, is that a counter, or the price you'd need to make it work?",
    negotiation_close: "Got it, is that your firm number, or is there some room to find middle ground?",
  },
  condition: {
    ownership: "First things first, are you the owner of the property we'd be discussing?",
    consider_selling: "Good to know. Would you consider selling it as is?",
    asking_price: "Helpful. Before I respond on price, what condition is the property in right now?",
    condition: "Thanks for that, is the property occupied or vacant right now, and does it need any major work?",
    offer: "To tighten up the number, can you tell me roughly what kind of shape the property is in?",
    negotiation_close: "Almost there, any major repairs or access issues I should know about before we proceed?",
  },
  offer: {
    ownership: "Before I put anything together, can you confirm you're the owner?",
    consider_selling: "Would it help if I put a number together for you to look at?",
    asking_price: "Understood. Should I put together a written offer based on that?",
    condition: "Thanks. With that in mind, would you like me to send over a number?",
    offer: "Want to make sure I understand, are you accepting, countering, or wanting me to revisit the number?",
    negotiation_close: "Just to confirm where we are, are we good to move toward paperwork, or is there something to adjust first?",
  },
  contract: {
    ownership: "Before any documents, can you confirm you're the owner or authorized signer?",
    consider_selling: "Glad you're open to it. Want me to walk you through how the process works?",
    asking_price: "Sure. Are we aligned on price so I can prep the agreement?",
    condition: "Before paperwork, is there anything about the property we still need to sort out?",
    offer: "Want to get this right, is your question about the terms or the paperwork itself?",
    negotiation_close: "Happy to help with next steps, do you have a question about the agreement, or are you ready to move forward?",
  },
  language: {
    ownership: "¿Prefiere que le escriba en español? / Would you prefer I write in Spanish? Happy to continue either way.",
    consider_selling: "¿Le escribo en español? Quiero asegurarme de que nos entendamos bien.",
    asking_price: "¿Prefiere continuar en español? Con gusto le ayudo con los números.",
    condition: "¿Español o inglés? Quiero asegurarme de entender bien los detalles de la propiedad.",
    offer: "¿Prefiere que sigamos en español?",
    negotiation_close: "¿Continuamos en español para los siguientes pasos?",
  },
});

const GENERIC_SAFE_FALLBACK =
  "Thanks for the reply, just want to make sure I help the right way. What would you want to see happen with the property?";

/**
 * Build a stage- and uncertainty-aware safe fallback plan.
 *
 * @returns {{
 *   uncertainty_type: string,
 *   stage_bucket: string,
 *   suggested_text: string,
 *   presupposes_prior_offer: boolean,
 *   preserves_stage: true,
 *   makes_offer: false,
 *   assumes_ownership: false,
 *   reclassify_next_with_context: true,
 * }}
 */
export function buildSafeFallback({ stage = null, uncertainty_type = "intent" } = {}) {
  const bucket = resolveStageBucket(stage);
  const type = UNCERTAINTY_TYPES.includes(lower(uncertainty_type))
    ? lower(uncertainty_type)
    : "intent";

  const byType = FALLBACK_MATRIX[type] || FALLBACK_MATRIX.intent;
  const suggested_text = byType[bucket] || byType.ownership || GENERIC_SAFE_FALLBACK;

  return {
    uncertainty_type: type,
    stage_bucket: bucket,
    suggested_text,
    // True only when the copy may reference something already sent or agreed.
    // Callers can assert on this; reaching it requires an exact lifecycle match.
    presupposes_prior_offer: LATE_BUCKETS.has(bucket),
    preserves_stage: true,
    makes_offer: false,
    assumes_ownership: false,
    reclassify_next_with_context: true,
  };
}

// Map a decision reason / intent onto the most appropriate uncertainty type so
// the right fallback question is chosen automatically.
export function uncertaintyTypeForReason(reason = null, intent = null) {
  const r = lower(reason);
  const i = lower(intent);
  if (r.includes("identity") || r.includes("missing_context") || i === "who_is_this") return "identity";
  if (r.includes("property") || r.includes("conflicting")) return "identity";
  if (r.includes("language")) return "language";
  if (i === "asking_price_provided" || r.includes("price")) return "price";
  if (i === "condition_disclosed" || r.includes("condition")) return "condition";
  if (i === "asks_offer" || r.includes("offer")) return "offer";
  if (r.includes("contract")) return "contract";
  return "intent";
}

export { resolveStageBucket, STAGE_BUCKETS, LATE_BUCKETS };

export default {
  UNCERTAINTY_TYPES,
  buildSafeFallback,
  uncertaintyTypeForReason,
  resolveStageBucket,
};
