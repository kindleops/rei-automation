/**
 * Approved latent-interest recommendation policy matrix.
 * Semantic intent remains latent_interest; use case/action vary by signal shape.
 */

export const LATENT_INTEREST_POLICIES = Object.freeze({
  clear_interest_safe: Object.freeze({
    policy_key: "clear_interest_safe",
    recommended_use_case: "consider_selling",
    recommended_action: "ask_offer_interest",
    recommended_human_review: false,
    recommendation_reason: "latent_interest_clear_safe_context",
  }),
  ambiguous_interest: Object.freeze({
    policy_key: "ambiguous_interest",
    recommended_use_case: "consider_selling",
    recommended_action: "clarify_interest",
    recommended_human_review: true,
    recommendation_reason: "latent_interest_ambiguous_price_dependency",
  }),
  timeline_only: Object.freeze({
    policy_key: "timeline_only",
    recommended_use_case: "motivation_timeline_clarifier",
    recommended_action: "clarify_timeline",
    recommended_human_review: true,
    recommendation_reason: "latent_interest_timeline_signal",
  }),
  motivation_without_price: Object.freeze({
    policy_key: "motivation_without_price",
    recommended_use_case: "motivation_timeline_clarifier",
    recommended_action: "clarify_motivation",
    recommended_human_review: true,
    recommendation_reason: "latent_interest_motivation_without_price",
  }),
  low_confidence: Object.freeze({
    policy_key: "low_confidence",
    recommended_use_case: "consider_selling",
    recommended_action: "human_review",
    recommended_human_review: true,
    recommendation_reason: "latent_interest_low_confidence",
  }),
});

const TIMELINE_PHRASES = [
  "6 months",
  "in a few months",
  "timeline",
  "maybe in",
  "when the price",
  "next year",
  "later this year",
];

const AMBIGUOUS_PHRASES = [
  "depends on the price",
  "maybe",
  "possibly",
  "might",
  "not sure",
];

const MOTIVATION_PHRASES = [
  "inherited",
  "inheritance",
  "probate",
  "estate sale",
  "passed away",
  "relocat",
  "moving out",
  "moving away",
  "job transfer",
  "foreclosure",
  "behind on payments",
];

const CLEAR_INTEREST_PHRASES = [
  "would consider selling",
  "open to selling",
  "interested in selling",
  "yes i would sell",
];

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function includesAny(text, phrases = []) {
  const normalized = lower(text);
  return phrases.some((phrase) => normalized.includes(lower(phrase)));
}

export function resolveLatentInterestPolicy({
  message = "",
  confidence = null,
} = {}) {
  if (typeof confidence === "number" && confidence < 0.65) {
    return LATENT_INTEREST_POLICIES.low_confidence;
  }
  if (includesAny(message, TIMELINE_PHRASES)) {
    return LATENT_INTEREST_POLICIES.timeline_only;
  }
  if (includesAny(message, MOTIVATION_PHRASES)) {
    return LATENT_INTEREST_POLICIES.motivation_without_price;
  }
  if (includesAny(message, AMBIGUOUS_PHRASES)) {
    return LATENT_INTEREST_POLICIES.ambiguous_interest;
  }
  if (includesAny(message, CLEAR_INTEREST_PHRASES)) {
    return LATENT_INTEREST_POLICIES.clear_interest_safe;
  }
  return LATENT_INTEREST_POLICIES.ambiguous_interest;
}

export default resolveLatentInterestPolicy;