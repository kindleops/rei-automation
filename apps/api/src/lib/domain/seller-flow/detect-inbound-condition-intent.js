/**
 * Deterministic condition / motivation disclosure detection for inbound SMS.
 * Used when classifier returns unclear but message contains Stage 4 signals.
 */

const CONDITION_SIGNALS = Object.freeze([
  { intent: "condition_disclosed", phrases: ["needs a new roof", "roof needs", "bad roof", "roof leak", "roof damage"] },
  { intent: "condition_disclosed", phrases: ["hvac", "furnace", "ac unit", "air conditioning", "heating system"] },
  { intent: "condition_disclosed", phrases: ["foundation", "structural", "settling", "cracked slab"] },
  { intent: "condition_disclosed", phrases: ["fire damage", "water damage", "flood damage", "mold", "smoke damage"] },
  { intent: "condition_disclosed", phrases: ["deferred maintenance", "needs work", "needs a lot of work", "fixer upper", "fixer-upper"] },
  { intent: "tenant_respondent", phrases: ["tenant occupied", "tenants living", "occupied by tenant", "rented out"] },
  { intent: "condition_disclosed", phrases: ["vacant", "sitting empty", "boarded up", "unoccupied"] },
  { intent: "condition_disclosed", phrases: ["full rehab", "gut rehab", "complete renovation", "tear down"] },
  { intent: "condition_disclosed", phrases: ["cosmetic", "paint and carpet", "minor updates", "light repairs"] },
  { intent: "condition_disclosed", phrases: ["plumbing work", "plumbing issues", "new plumbing", "electrical issues"] },
]);

const MOTIVATION_SIGNALS = Object.freeze([
  { intent: "latent_interest", phrases: ["6 months", "in a few months", "timeline", "maybe in", "when the price"] },
  { intent: "latent_interest", phrases: ["inherited", "inheritance", "probate", "estate sale", "passed away"] },
  { intent: "latent_interest", phrases: ["relocat", "moving out", "moving away", "job transfer"] },
  { intent: "latent_interest", phrases: ["financial distress", "behind on payments", "foreclosure", "need cash"] },
]);

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

function normalizeUniversalStageForIntent(intent) {
  switch (intent) {
    case "condition_disclosed":
      return "condition_justification";
    case "latent_interest":
      return "offer_interest";
    case "tenant_respondent":
      return "ownership_confirmation";
    default:
      return null;
  }
}

/**
 * Detect condition or motivation intent from message text when classifier is weak.
 */
export function detectInboundConditionOrMotivationIntent({
  message = "",
  classifier_intent = null,
  conversation_stage = null,
} = {}) {
  const text = clean(message);
  const classifier = lower(classifier_intent);
  const stage = lower(conversation_stage);

  if (
    classifier &&
    !["unclear", "ownership_confirmed", "wrong_number", "opt_out"].includes(classifier)
  ) {
    return null;
  }

  for (const signal of CONDITION_SIGNALS) {
    if (includesAny(text, signal.phrases)) {
      return {
        canonical_intent: signal.intent,
        detection_source: "condition_signal",
        universal_stage: normalizeUniversalStageForIntent(signal.intent),
        granular_stage: signal.intent === "condition_disclosed" ? "condition_disclosed" : null,
        human_review_required: stage.includes("condition") ? false : true,
        advance_stage: false,
      };
    }
  }

  for (const signal of MOTIVATION_SIGNALS) {
    if (includesAny(text, signal.phrases)) {
      return {
        canonical_intent: signal.intent,
        detection_source: "motivation_signal",
        universal_stage: normalizeUniversalStageForIntent(signal.intent),
        granular_stage: "consider_selling",
        human_review_required: true,
        advance_stage: false,
      };
    }
  }

  return null;
}

export default detectInboundConditionOrMotivationIntent;