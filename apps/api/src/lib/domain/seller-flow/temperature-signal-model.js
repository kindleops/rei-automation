// ─── temperature-signal-model.js ─────────────────────────────────────────────
// Deterministic, explainable seller-signal scoring (activation spec Mission 4).
// This does NOT replace classify.js and does NOT invent a new temperature
// scale — it produces component scores + reason codes and a floor expressed in
// the existing canonical temperature registry (unscored/cold/warm/hot).
//
// Rules:
//   • Explicit message meaning dominates. "Not interested" stays cold no
//     matter how fast or long the reply was.
//   • Secondary signals (latency, reply count, length, depth) only ever
//     nudge WITHIN the band the explicit signals allow — they never override
//     explicit language and never create HOT on their own.
//   • Output is component-by-component so every temperature is explainable.

import { LEAD_TEMPERATURE_CODES } from "@/lib/domain/lead-state/universal-lead-state-registry.js";

export const TEMPERATURE_MODEL_VERSION = "temperature_signal_model_v1";

function clamp01(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

function lower(value) {
  return String(value ?? "").trim().toLowerCase();
}

const NEGATIVE_INTENTS = new Set([
  "not_interested",
  "opt_out",
  "wrong_number",
  "wrong_person",
  "hostile_or_legal",
]);

const HOT_INTENTS = new Set(["asks_offer", "asking_price_provided", "seller_accepts"]);
const WARM_INTENTS = new Set(["seller_interested", "latent_interest", "condition_disclosed", "ownership_confirmed"]);

/**
 * Compute deterministic signal components for one inbound turn.
 *
 * @param {object} args
 * @param {string} args.intent - canonical intent (classify.js, normalized).
 * @param {object} [args.facts] - merged resolver facts (asking_price, wants_offer,
 *   interest, occupancy_status, condition_disclosed, timeline, authority_claims,
 *   listing_status …).
 * @param {object} [args.objections] - extraction objections fact value.
 * @param {object} [args.secondary] - { reply_latency_seconds, seller_reply_count,
 *   message_word_count, question_count, conversation_depth }.
 */
export function computeTemperatureSignal({
  intent = "unclear",
  facts = {},
  objections = null,
  secondary = {},
} = {}) {
  const intentKey = lower(intent);
  const reason_codes = [];

  // ── Primary components (explicit meaning) ─────────────────────────────────
  let intent_score = 0.3;
  if (NEGATIVE_INTENTS.has(intentKey)) {
    intent_score = 0;
    reason_codes.push(`INTENT_NEGATIVE_${intentKey.toUpperCase()}`);
  } else if (HOT_INTENTS.has(intentKey)) {
    intent_score = 1;
    reason_codes.push(`INTENT_HOT_${intentKey.toUpperCase()}`);
  } else if (WARM_INTENTS.has(intentKey)) {
    intent_score = 0.7;
    reason_codes.push(`INTENT_WARM_${intentKey.toUpperCase()}`);
  }

  let pricing_score = 0;
  if (facts?.asking_price?.value > 0) {
    pricing_score = 1;
    reason_codes.push("PRICE_PROVIDED");
  } else if (facts?.wants_offer === true) {
    pricing_score = 0.8;
    reason_codes.push("OFFER_REQUESTED");
  }

  let urgency_score = 0;
  const timeline = lower(facts?.timeline);
  if (timeline === "immediate") {
    urgency_score = 1;
    reason_codes.push("TIMELINE_IMMEDIATE");
  } else if (timeline === "soon") {
    urgency_score = 0.7;
    reason_codes.push("TIMELINE_SOON");
  } else if (timeline === "long_term" || timeline === "flexible") {
    urgency_score = 0.2;
    reason_codes.push("TIMELINE_DEFERRED");
  }

  let condition_score = 0;
  if (facts?.condition_disclosed === true || facts?.repairs_summary || facts?.repairs_needed === false) {
    condition_score = 0.6;
    reason_codes.push("CONDITION_DISCLOSED");
  }

  let authority_readiness_score = 0.5;
  if (facts?.authority_claims?.additional_signers_claimed?.length) {
    authority_readiness_score = 0.3;
    reason_codes.push("ADDITIONAL_SIGNERS_CLAIMED");
  } else if (facts?.authority_claims?.requires_authority_review) {
    authority_readiness_score = 0.3;
    reason_codes.push("AUTHORITY_REVIEW_REQUIRED");
  }

  let friction_score = 0;
  const objection_list = Array.isArray(objections?.objections) ? objections.objections : [];
  if (objection_list.includes("price_too_low")) {
    friction_score += 0.4;
    reason_codes.push("OBJECTION_PRICE");
  }
  if (objection_list.includes("trust_concern")) {
    friction_score += 0.3;
    reason_codes.push("OBJECTION_TRUST");
  }
  if (objection_list.includes("not_ready")) {
    friction_score += 0.3;
    reason_codes.push("OBJECTION_NOT_READY");
  }
  if (lower(facts?.listing_status) === "listed_with_agent") {
    friction_score += 0.4;
    reason_codes.push("LISTED_WITH_AGENT");
  }
  friction_score = clamp01(friction_score);

  // ── Secondary components (never override explicit language) ───────────────
  let engagement_score = 0;
  const replies = Number(secondary?.seller_reply_count) || 0;
  const depth = Number(secondary?.conversation_depth) || 0;
  const questions = Number(secondary?.question_count) || 0;
  const latency = Number(secondary?.reply_latency_seconds);
  if (replies >= 3 || depth >= 6) {
    engagement_score += 0.5;
    reason_codes.push("REPEATED_ENGAGEMENT");
  } else if (replies >= 1) {
    engagement_score += 0.25;
  }
  if (Number.isFinite(latency) && latency > 0 && latency < 15 * 60) {
    engagement_score += 0.25;
    reason_codes.push("FAST_REPLY");
  }
  if (questions >= 1) {
    engagement_score += 0.25;
    reason_codes.push("SELLER_ASKING_QUESTIONS");
  }
  engagement_score = clamp01(engagement_score);

  const components = {
    intent_score,
    urgency_score,
    engagement_score,
    pricing_score,
    condition_score,
    authority_readiness_score,
    friction_score,
  };

  // ── Floor resolution (explicit meaning dominates) ──────────────────────────
  let temperature_floor = LEAD_TEMPERATURE_CODES.UNSCORED;
  if (NEGATIVE_INTENTS.has(intentKey)) {
    // Explicit negative language caps at cold regardless of every secondary
    // signal — a ten-second "not interested" is still not interested.
    temperature_floor = LEAD_TEMPERATURE_CODES.COLD;
    reason_codes.push("EXPLICIT_NEGATIVE_CAPS_COLD");
  } else if (pricing_score >= 0.8 || (intent_score >= 1 && urgency_score >= 0.7)) {
    temperature_floor = LEAD_TEMPERATURE_CODES.HOT;
    reason_codes.push("FLOOR_HOT_EXPLICIT_PRICE_OR_URGENT_INTENT");
  } else if (intent_score >= 0.7 || (pricing_score > 0 && engagement_score > 0)) {
    temperature_floor = LEAD_TEMPERATURE_CODES.WARM;
    reason_codes.push("FLOOR_WARM_EXPLICIT_INTEREST");
  } else if (engagement_score >= 0.5 && intent_score >= 0.3) {
    // Secondary-only signals can lift an unscored lead to cold (a real human
    // is replying) but never to warm/hot on their own.
    temperature_floor = LEAD_TEMPERATURE_CODES.COLD;
    reason_codes.push("FLOOR_COLD_ENGAGEMENT_ONLY");
  }

  return {
    model_version: TEMPERATURE_MODEL_VERSION,
    components,
    temperature_floor,
    reason_codes: [...new Set(reason_codes)],
  };
}

export default computeTemperatureSignal;
