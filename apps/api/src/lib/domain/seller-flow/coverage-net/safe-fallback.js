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
//   - preserve the current lifecycle stage
//   - leave the next inbound message to be reclassified WITH context
//
// These are PREPARED replies (suggested_text). Whether they actually dispatch is
// still governed by the existing auto-reply gates in apply-inbound-automation-
// decision.js / handle-textgrid-inbound.js — this module never sends.

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

// High-level stage buckets used for tailoring tone/content. We accept the
// granular SELLER_FLOW_STAGES, the CONVERSATION_STAGES labels, and the legacy
// Ownership/Offer/QA/Contract labels, then collapse to a bucket.
const STAGE_BUCKETS = Object.freeze({
  S1: "ownership",
  S2: "consider_selling",
  S3: "asking_price",
  S4: "condition",
  S5: "offer",
  S6: "negotiation_close",
});

function resolveStageBucket(stage = null) {
  const s = lower(stage);
  if (!s) return STAGE_BUCKETS.S1;
  if (s.includes("ownership")) return STAGE_BUCKETS.S1;
  if (s.includes("consider") || s.includes("offer interest")) return STAGE_BUCKETS.S2;
  if (s.includes("price") || s.includes("asking")) return STAGE_BUCKETS.S3;
  if (s.includes("condition") || s.includes("timeline") || s.includes("confirm_basics")) {
    return STAGE_BUCKETS.S4;
  }
  if (s.includes("offer") || s.includes("reveal") || s.includes("positioning")) {
    return STAGE_BUCKETS.S5;
  }
  if (
    s.includes("negotiation") ||
    s.includes("close") ||
    s.includes("contract") ||
    s.includes("acceptance") ||
    s.includes("handoff")
  ) {
    return STAGE_BUCKETS.S6;
  }
  return STAGE_BUCKETS.S1;
}

// (uncertainty x stage_bucket) → one precise, safe clarifier. The {first_name}
// placeholder is optional and rendered downstream; falls back gracefully.
const FALLBACK_MATRIX = Object.freeze({
  identity: {
    ownership: "Just so I reach the right person — are you the owner of the property, or should I be speaking with someone else?",
    consider_selling: "Quick check before we go further — is this property something you own, or are you helping someone who does?",
    asking_price: "Before I talk numbers, can you confirm you're the owner (or authorized to discuss a sale)?",
    condition: "So I have the right contact — are you the owner, or the person managing the property?",
    offer: "Want to make sure I'm presenting this to the right person — are you the owner or authorized to make a decision?",
    negotiation_close: "Before we move toward paperwork, can you confirm you're the owner or have authority to sign?",
  },
  intent: {
    ownership: "Thanks for getting back to me. Are you open to a quick conversation about the property, or would you rather I not reach out?",
    consider_selling: "Appreciate the reply — would you be open to an offer on the property, or is it not something you'd consider right now?",
    asking_price: "Got it — are you looking to sell, and if so, do you have a number in mind?",
    condition: "Thanks — to make sure I help the right way, are you still considering an offer, or just answering questions?",
    offer: "Want to be respectful of your time — are you still open to the offer, or should I hold off?",
    negotiation_close: "Just making sure we're aligned — are you wanting to move forward, or still thinking it over?",
  },
  price: {
    asking_price: "Thanks — just to make sure I read that right, is that the number you'd want for the property?",
    condition: "Want to confirm I have the right figure — what number are you hoping to get?",
    offer: "Appreciate that — is that a counter to my offer, or the price you'd need to make it work?",
    negotiation_close: "Got it — is that your firm number, or is there some room to find middle ground?",
    ownership: "Before we talk price, are you the owner I should be working with?",
    consider_selling: "Sounds like there may be a number in mind — what would you want to see for the property?",
  },
  condition: {
    condition: "Thanks for that — is the property currently occupied or vacant, and does it need any major work?",
    offer: "To finalize the number, can you tell me roughly what kind of shape the property is in?",
    asking_price: "Helpful — before I respond on price, what condition is the property in right now?",
    negotiation_close: "Almost there — any major repairs or access issues I should know about before we proceed?",
    ownership: "First things first — are you the owner of the property we'd be discussing?",
    consider_selling: "Good to know — is the property something you'd consider selling as-is?",
  },
  offer: {
    offer: "Want to make sure I understand — are you accepting the offer, countering, or wanting me to revisit the number?",
    negotiation_close: "Just to confirm where we are — are we good to move toward paperwork, or is there something to adjust first?",
    asking_price: "Understood — should I put together a written offer based on that?",
    condition: "Thanks — with that in mind, would you like me to send over a number?",
    ownership: "Before I send anything over, can you confirm you're the owner?",
    consider_selling: "Would it help if I put an offer together for you to look at?",
  },
  contract: {
    negotiation_close: "Happy to help with next steps — do you have a question about the agreement, or are you ready to move forward?",
    offer: "Want to get this right — is your question about the offer terms or the paperwork itself?",
    condition: "Before paperwork, is there anything about the property we still need to sort out?",
    asking_price: "Sure — are we aligned on price so I can prep the agreement?",
    ownership: "Before any documents, can you confirm you're the owner or authorized signer?",
    consider_selling: "Glad you're open to it — want me to walk you through how the process works?",
  },
  language: {
    ownership: "¿Prefiere que le escriba en español? / Would you prefer I write in Spanish? Happy to continue either way.",
    consider_selling: "¿Le escribo en español? Quiero asegurarme de que nos entendamos bien.",
    asking_price: "¿Prefiere continuar en español? Con gusto le ayudo con los números.",
    condition: "¿Español o inglés? Quiero asegurarme de entender bien los detalles de la propiedad.",
    offer: "¿Prefiere que continúe en español para la oferta?",
    negotiation_close: "¿Continuamos en español para los siguientes pasos?",
  },
});

const GENERIC_SAFE_FALLBACK =
  "Thanks for the reply — just want to make sure I help the right way. Could you tell me a little more about what you're looking for?";

/**
 * Build a stage- and uncertainty-aware safe fallback plan.
 *
 * @returns {{
 *   uncertainty_type: string,
 *   stage_bucket: string,
 *   suggested_text: string,
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

export default {
  UNCERTAINTY_TYPES,
  buildSafeFallback,
  uncertaintyTypeForReason,
};
