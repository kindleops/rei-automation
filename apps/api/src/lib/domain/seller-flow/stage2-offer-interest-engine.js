// ─── stage2-offer-interest-engine.js ───────────────────────────────────────
// Stage 2 — Offer Interest Engine (DETERMINISTIC, NO AI).
//
// After ownership is confirmed (S1 → OWNER_CONFIRMED → S2 awaiting_offer_interest)
// this engine classifies the seller's reply into one of the Stage 2 offer-interest
// outcomes and routes it to the correct:
//   - next canonical stage  (SELLER_FLOW_STAGES / S-code)
//   - inbox bucket          (priority | new_replies | needs_review | follow_up | dead | suppressed)
//   - template use_case      (existing acquisition catalog)
//   - follow-up policy       (schedule / step / delay)
//   - acquisition action     (run underwriting, reveal offer, generate contract, …)
//   - canonical lifecycle events
//
// Design rules (mirrors the existing seller-flow protections — nothing is weakened):
//   1. Compliance / opt-out is ABSOLUTE and overrides every other action.
//   2. Wrong-number / contact-graph behavior from Stage 1 is preserved: a wrong
//      contact point is suppressed WITHOUT regressing or invalidating the
//      prospect / master owner / property, and without a Stage 2 progression event.
//   3. Stages are jump-capable (S2 → S3 / S5 / S6) but never regress.
//   4. Everything is heuristic + table driven. No AI is used for production
//      classification or routing.
//
// This module performs NO database writes. It returns a decision describing what
// SHOULD happen; the caller (apply-inbound-automation-decision / the canonical
// event service) enforces auto-reply safety and persistence.

import { SELLER_FLOW_STAGES } from "@/lib/domain/seller-flow/canonical-seller-flow.js";
import { SELLER_FLOW_SAFETY_TIERS } from "@/lib/domain/seller-flow/seller-flow-safety-policy.js";
import { CONVERSATION_STAGES } from "@/lib/domain/communications-engine/state-machine.js";
import {
  ACQUISITION_LIFECYCLE_EVENTS as EV,
  buildLifecycleEvent,
} from "@/lib/domain/seller-flow/acquisition-lifecycle-events.js";

// ══════════════════════════════════════════════════════════════════════════
// STAGE 2 OUTCOMES
// ══════════════════════════════════════════════════════════════════════════

export const STAGE2_OUTCOMES = Object.freeze({
  OFFER_INTEREST_CONFIRMED: "offer_interest_confirmed",
  CONDITIONAL_INTEREST: "conditional_interest",
  SELLER_REQUESTS_OFFER: "seller_requests_offer",
  SELLER_PROVIDES_ASKING_PRICE: "seller_provides_asking_price",
  NOT_INTERESTED: "not_interested",
  FOLLOW_UP_LATER: "follow_up_later",
  LISTED_WITH_AGENT: "listed_with_agent",
  AGENT_OR_REALTOR_INVOLVED: "agent_or_realtor_involved",
  NEEDS_MORE_CONTEXT: "needs_more_context",
  TRUST_OR_LEGITIMACY_QUESTION: "trust_or_legitimacy_question",
  FAMILY_OR_PARTNER_SIGNOFF_NEEDED: "family_or_partner_signoff_needed",
  HOSTILE_OR_COMPLIANCE: "hostile_or_compliance",
  UNCLEAR: "unclear",
  // Preserved Stage 1 override (contact-point specific, not a Stage 2 outcome
  // proper — never invalidates the owner/property graph):
  WRONG_CONTACT: "wrong_contact",
});

// ══════════════════════════════════════════════════════════════════════════
// SMALL TEXT UTILITIES
// ══════════════════════════════════════════════════════════════════════════

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function includesAny(text, phrases = []) {
  return phrases.some((p) => {
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(
      `(?:^|[^a-zA-Z0-9\\u00C0-\\u017F])${escaped}(?:$|[^a-zA-Z0-9\\u00C0-\\u017F])`,
      "i"
    );
    return regex.test(text);
  });
}

function wordCount(text) {
  return clean(text).split(/\s+/).filter(Boolean).length;
}

// ══════════════════════════════════════════════════════════════════════════
// ASKING PRICE EXTRACTION (multilingual, deterministic)
// ══════════════════════════════════════════════════════════════════════════
//
// Handles English ("185k", "$185,000", "2 million") and Spanish ("200 mil" =
// 200,000 — NOT 200 million). We deliberately do NOT reuse classify.js'
// extractPrice() here because that helper treats a "mil" suffix as millions
// (English bias). Keeping a focused normalizer avoids changing/weakening the
// shared classifier while staying correct for multilingual asking prices.

const PRICE_MULTIPLIERS = [
  // Order matters: million-family variants must be tried before the Spanish
  // "mil" (= thousand). `m` is matched as a standalone token via \b so it does
  // not steal the leading "m" of "mil".
  { tokens: ["millones", "millón", "millon", "million", "millions", "mill", "mm"], factor: 1e6 },
  { tokens: ["m"], factor: 1e6, standalone: true },
  { tokens: ["k", "grand", "thousand", "mil"], factor: 1e3 },
  { tokens: ["hundred", "cien"], factor: 1e2 },
];

const TIME_UNIT_TOKENS = [
  "day", "days", "week", "weeks", "month", "months", "year", "years",
  "día", "dias", "días", "semana", "semanas", "mes", "meses", "año", "anos", "años",
];

/**
 * Extract a normalized USD asking price from free text.
 * Returns { value, raw } or null. Guards against time expressions ("30 days")
 * and implausibly small bare numbers so it never mistakes a non-price reply.
 */
export function extractAskingPrice(message) {
  const text = lower(message);
  if (!text) return null;

  const numRe = /\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?/g;
  let match;
  while ((match = numRe.exec(text)) !== null) {
    const integer = match[1].replace(/,/g, "");
    const decimal = match[2] ? `.${match[2]}` : "";
    let value = parseFloat(integer + decimal);
    if (!Number.isFinite(value)) continue;

    const tail = text.slice(match.index + match[0].length);
    const trailing = /^\s*([a-zà-ÿ]+)/i.exec(tail);
    const trailing_word = trailing ? trailing[1].toLowerCase() : "";

    // Skip time expressions ("check back in 30 days").
    if (TIME_UNIT_TOKENS.includes(trailing_word)) continue;

    let factor = 1;
    let matched_token = null;
    for (const entry of PRICE_MULTIPLIERS) {
      const hit = entry.tokens.find((tok) => {
        if (entry.standalone) return trailing_word === tok;
        return trailing_word === tok;
      });
      if (hit) {
        factor = entry.factor;
        matched_token = hit;
        break;
      }
    }

    value *= factor;

    const has_currency = /\$/.test(match[0]);
    // A bare number with no multiplier and no currency must be large enough to
    // be a real asking price (avoids "I have 2 houses" / "unit 4").
    if (!matched_token && !has_currency && value < 1000) continue;

    return { value: Math.round(value), raw: clean(match[0]) + (matched_token ? ` ${matched_token}` : "") };
  }

  return null;
}

// ══════════════════════════════════════════════════════════════════════════
// PHRASE TABLES (English + common Spanish)
// ══════════════════════════════════════════════════════════════════════════

const OPT_OUT_PHRASES = [
  "stop", "stop texting", "stop messaging", "stop contacting", "unsubscribe",
  "opt out", "opt-out", "remove me", "take me off", "do not text", "do not contact",
  "don't text me", "dont text me", "leave me alone",
  // Spanish
  "no me escribas", "no me contactes", "quítame de tu lista", "quitame de tu lista",
];

const WRONG_NUMBER_PHRASES = [
  "wrong number", "wrong person", "not the owner", "not my property",
  "i don't own", "i dont own", "no longer own", "never owned",
  "you have the wrong", "this isn't me", "this is not me",
  // Spanish
  "número equivocado", "numero equivocado", "no soy el dueño", "no soy el propietario",
];

const HOSTILE_PHRASES = [
  "sue", "lawyer", "attorney", "harassment", "harassing", "report you",
  "fuck", "fuck off", "lawsuit", "fcc", "do not ever",
];

const ASKS_OFFER_PHRASES = [
  "what would you offer", "what will you offer", "what's your offer",
  "what is your offer", "whats your offer", "send me an offer", "send an offer",
  "send me offer", "make an offer", "make me an offer", "give me an offer",
  "what can you pay", "what will you pay", "how much can you pay",
  "how much will you give", "what's your number", "give me a number",
  "what are you offering", "send me a number",
  // Spanish
  "cuánto ofrecen", "cuanto ofrecen", "cuánto pagan", "cuanto pagan",
  "mándame una oferta", "mandame una oferta", "hazme una oferta",
  "cuánto me das", "cuanto me das",
];

const LISTED_PHRASES = [
  "listed", "i have it listed", "it's listed", "its listed", "on the market",
  "under contract", "pending sale", "sale pending", "mls", "zillow", "redfin",
  // Spanish
  "ya está listada", "en el mercado", "está en venta con",
];

const AGENT_PHRASES = [
  "realtor", "real estate agent", "my agent", "have an agent", "with an agent",
  "working with an agent", "my broker", "have a broker", "with a broker",
  // Spanish
  "tengo agente", "con un agente", "mi agente",
];

const FAMILY_SIGNOFF_PHRASES = [
  "my wife", "talk to my wife", "ask my wife", "my husband", "talk to my husband",
  "ask my husband", "my spouse", "my partner", "talk to my partner",
  "talk to my family", "ask my family", "co-owner", "my brother", "my sister",
  "my kids", "my children", "run it by", "the mrs",
  // Spanish
  "mi esposa", "mi esposo", "hablar con mi esposa", "hablar con mi esposo",
  "consultar con mi familia", "con mi familia",
];

const TRUST_PHRASES = [
  "legit", "are you legit", "is this legit", "scam", "is this a scam",
  "who are you", "who is this", "whos this", "who's this", "is this real",
  "how did you get my number", "where did you get my number", "are you real",
  "what company", "prove", "proof",
  // Spanish
  "quién eres", "quien eres", "es legítimo", "es legitimo", "es una estafa",
  "cómo conseguiste mi número", "como conseguiste mi numero",
];

const NOT_INTERESTED_PHRASES = [
  "not interested", "no interest", "no thanks", "no thank you", "not selling",
  "not for sale", "won't sell", "wont sell", "not going to sell",
  "don't want to sell", "dont want to sell", "keeping it", "i'll pass", "hard pass",
  // Spanish
  "no me interesa", "no quiero vender", "no está en venta", "no esta en venta",
  "no gracias",
];

const FOLLOW_UP_PHRASES = [
  "later", "maybe later", "check back", "circle back", "reach back out",
  "next week", "next month", "next year", "in a few months", "down the road",
  "not right now", "not at this time", "not ready", "give me some time",
  "in the spring", "in the fall", "in the summer", "after the holidays",
  // Spanish
  "más adelante", "mas adelante", "luego", "después", "despues",
  "el próximo año", "el proximo año", "año que viene", "todavía no", "todavia no",
];

const CONDITIONAL_PHRASES = [
  "depends", "it depends", "depends on price", "depends on the price",
  "depends on your offer", "depends on the offer", "depends on how much",
  "if the price is right", "if the offer is right", "if it's worth it",
  "possibly", "perhaps", "might be", "maybe",
  // Spanish
  "depende", "depende del precio", "depende de la oferta", "tal vez", "quizás",
  "quizas", "puede ser", "posiblemente",
];

const AFFIRMATIVE_INTEREST_PHRASES = [
  "yes", "yeah", "yep", "yup", "sure", "absolutely", "of course", "definitely",
  "i'm interested", "im interested", "interested", "i would sell", "i'd sell",
  "willing to sell", "open to selling", "open to an offer", "i'm open", "im open",
  "let's talk", "lets talk", "i could sell", "ready to sell",
  // Spanish
  "sí", "si", "claro", "por supuesto", "me interesa", "interesado", "interesada",
  "estoy interesado", "estoy interesada", "dispuesto a vender", "abierto a",
];

// ══════════════════════════════════════════════════════════════════════════
// OUTCOME DETECTION (deterministic priority ladder)
// ══════════════════════════════════════════════════════════════════════════

function detectOptOut(text, classification) {
  return (
    lower(classification?.compliance_flag) === "stop_texting" ||
    lower(classification?.primary_intent) === "opt_out" ||
    includesAny(text, OPT_OUT_PHRASES)
  );
}

function detectWrongNumber(text, classification) {
  return (
    lower(classification?.primary_intent) === "wrong_number" ||
    lower(classification?.objection) === "wrong_number" ||
    includesAny(text, WRONG_NUMBER_PHRASES)
  );
}

function detectHostile(text, classification) {
  return (
    lower(classification?.primary_intent) === "hostile_or_legal" ||
    includesAny(text, HOSTILE_PHRASES)
  );
}

function detectAsksOffer(text, classification) {
  return (
    lower(classification?.objection) === "send_offer_first" ||
    lower(classification?.primary_intent) === "asks_offer" ||
    includesAny(text, ASKS_OFFER_PHRASES)
  );
}

/**
 * The deterministic outcome ladder. Order encodes priority and guarantees we
 * never regress: stronger / more actionable signals win.
 */
function detectStage2Outcome(text, classification) {
  // 1. Compliance is absolute.
  if (detectOptOut(text, classification)) return STAGE2_OUTCOMES.HOSTILE_OR_COMPLIANCE;

  // 2. Wrong contact point (preserved Stage 1 behavior — never invalidates graph).
  if (detectWrongNumber(text, classification)) return STAGE2_OUTCOMES.WRONG_CONTACT;

  // 3. Hostile / legal.
  if (detectHostile(text, classification)) return STAGE2_OUTCOMES.HOSTILE_OR_COMPLIANCE;

  // 4. Explicit asking price (most actionable interest signal — jump capable).
  if (extractAskingPrice(text)) return STAGE2_OUTCOMES.SELLER_PROVIDES_ASKING_PRICE;

  // 5. Seller requests our offer.
  if (detectAsksOffer(text, classification)) return STAGE2_OUTCOMES.SELLER_REQUESTS_OFFER;

  // 6. Listed / agent involved (listed wins over generic agent mention).
  if (includesAny(text, LISTED_PHRASES)) return STAGE2_OUTCOMES.LISTED_WITH_AGENT;
  if (includesAny(text, AGENT_PHRASES)) return STAGE2_OUTCOMES.AGENT_OR_REALTOR_INVOLVED;

  // 7. Family / partner signoff needed.
  if (
    lower(classification?.objection) === "need_family_ok" ||
    includesAny(text, FAMILY_SIGNOFF_PHRASES)
  ) {
    return STAGE2_OUTCOMES.FAMILY_OR_PARTNER_SIGNOFF_NEEDED;
  }

  // 8. Trust / legitimacy question.
  if (
    lower(classification?.objection) === "who_is_this" ||
    ["who_is_this", "info_request"].includes(lower(classification?.primary_intent)) ||
    includesAny(text, TRUST_PHRASES)
  ) {
    return STAGE2_OUTCOMES.TRUST_OR_LEGITIMACY_QUESTION;
  }

  // 9. Explicit disinterest.
  if (
    lower(classification?.primary_intent) === "not_interested" ||
    lower(classification?.objection) === "not_interested" ||
    includesAny(text, NOT_INTERESTED_PHRASES) ||
    (includesAny(text, ["no", "nope", "nah"]) && wordCount(text) <= 2)
  ) {
    return STAGE2_OUTCOMES.NOT_INTERESTED;
  }

  // 10. Follow up later (checked before conditional so "maybe next year" → later).
  if (
    lower(classification?.objection) === "need_time" ||
    lower(classification?.primary_intent) === "need_time" ||
    includesAny(text, FOLLOW_UP_PHRASES)
  ) {
    return STAGE2_OUTCOMES.FOLLOW_UP_LATER;
  }

  // 11. Conditional interest (depends / if price / maybe) — beats plain "yes".
  if (includesAny(text, CONDITIONAL_PHRASES)) return STAGE2_OUTCOMES.CONDITIONAL_INTEREST;

  // 12. Plain affirmative / explicit interest.
  if (includesAny(text, AFFIRMATIVE_INTEREST_PHRASES)) {
    return STAGE2_OUTCOMES.OFFER_INTEREST_CONFIRMED;
  }

  // 13. There is content but no usable signal.
  if (wordCount(text) > 0) return STAGE2_OUTCOMES.NEEDS_MORE_CONTEXT;

  return STAGE2_OUTCOMES.UNCLEAR;
}

// ══════════════════════════════════════════════════════════════════════════
// ACQUISITION DECISION (asking price → offer band → route)
// ══════════════════════════════════════════════════════════════════════════

const NEAR_BAND_FACTOR = 1.12; // ask within +12% of MAO is "near" / negotiable.

function runAcquisitionDecision(seller_asking_price, underwriting = {}) {
  const recommended_cash_offer = numberOrNull(underwriting.recommended_cash_offer);
  const maximum_allowable_offer =
    numberOrNull(underwriting.maximum_allowable_offer) ?? recommended_cash_offer;
  const contract_ceiling =
    numberOrNull(underwriting.contract_ceiling) ?? maximum_allowable_offer;
  const repair_estimate = numberOrNull(underwriting.repair_estimate);
  const lowest_relevant_comp = numberOrNull(underwriting.lowest_relevant_comp);

  const has_underwriting = recommended_cash_offer !== null;

  let offer_gap_amount = null;
  let offer_gap_pct_of_ask = null;
  let offer_to_ask_ratio = null;
  let ask_to_offer_ratio = null;

  if (has_underwriting && seller_asking_price > 0) {
    offer_gap_amount = seller_asking_price - recommended_cash_offer;
    offer_gap_pct_of_ask = (offer_gap_amount / seller_asking_price) * 100;
    offer_to_ask_ratio = recommended_cash_offer / seller_asking_price;
    ask_to_offer_ratio = recommended_cash_offer > 0 ? seller_asking_price / recommended_cash_offer : null;
  }

  let negotiation_band = "unknown";
  if (has_underwriting) {
    if (contract_ceiling !== null && seller_asking_price <= contract_ceiling) {
      negotiation_band = "inside_range";
    } else if (maximum_allowable_offer !== null && seller_asking_price <= maximum_allowable_offer * NEAR_BAND_FACTOR) {
      negotiation_band = "near";
    } else {
      negotiation_band = "far";
    }
  }

  const recommended_strategy =
    negotiation_band === "inside_range"
      ? "accept_and_contract"
      : negotiation_band === "near"
        ? "justify_and_negotiate"
        : negotiation_band === "far"
          ? "gather_condition_then_reveal"
          : "capture_price_human_review";

  return {
    has_underwriting,
    seller_asking_price,
    recommended_cash_offer,
    maximum_allowable_offer,
    contract_ceiling,
    repair_estimate,
    lowest_relevant_comp,
    offer_gap_amount,
    offer_gap_pct_of_ask,
    offer_to_ask_ratio,
    ask_to_offer_ratio,
    negotiation_band,
    recommended_strategy,
  };
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ══════════════════════════════════════════════════════════════════════════
// STATIC ROUTING TABLE
// ══════════════════════════════════════════════════════════════════════════

const T = SELLER_FLOW_SAFETY_TIERS;
const S = SELLER_FLOW_STAGES;

// Routing for the outcomes whose target does not depend on runtime context.
const STATIC_ROUTES = Object.freeze({
  [STAGE2_OUTCOMES.OFFER_INTEREST_CONFIRMED]: {
    stage_code: "S3",
    next_stage: S.ASKING_PRICE,
    brain_stage: CONVERSATION_STAGES.SELLER_PRICE_DISCOVERY,
    status: "awaiting_asking_price",
    template_use_case: "seller_asking_price",
    inbox_bucket: "priority",
    safety_tier: T.AUTO_SEND,
    acquisition_action: "advance_to_price_discovery",
    follow_up_policy: null,
    event_type: EV.OFFER_INTEREST_CONFIRMED,
  },
  [STAGE2_OUTCOMES.CONDITIONAL_INTEREST]: {
    stage_code: "S3",
    next_stage: S.ASKING_PRICE,
    brain_stage: CONVERSATION_STAGES.SELLER_PRICE_DISCOVERY,
    status: "awaiting_asking_price",
    template_use_case: "seller_asking_price",
    inbox_bucket: "priority",
    safety_tier: T.AUTO_SEND,
    acquisition_action: "advance_to_price_discovery",
    follow_up_policy: null,
    event_type: EV.CONDITIONAL_INTEREST_DETECTED,
  },
  [STAGE2_OUTCOMES.NOT_INTERESTED]: {
    stage_code: "S2",
    next_stage: S.NOT_INTERESTED,
    brain_stage: CONVERSATION_STAGES.OFFER_INTEREST_CONFIRMATION,
    status: "not_interested",
    template_use_case: "not_interested",
    inbox_bucket: "needs_review",
    safety_tier: T.REVIEW,
    acquisition_action: "apply_disinterest_policy",
    follow_up_policy: null,
    event_type: EV.SELLER_NOT_INTERESTED,
  },
  [STAGE2_OUTCOMES.FOLLOW_UP_LATER]: {
    stage_code: "S2F",
    next_stage: S.CONSIDER_SELLING_FOLLOW_UP,
    brain_stage: CONVERSATION_STAGES.OFFER_INTEREST_CONFIRMATION,
    status: "follow_up_scheduled",
    template_use_case: "consider_selling_follow_up",
    inbox_bucket: "follow_up",
    safety_tier: T.REVIEW,
    acquisition_action: "schedule_stage2_follow_up",
    follow_up_policy: { schedule: true, step: "S2F", default_delay_days: 30 },
    event_type: EV.SELLER_FOLLOW_UP_REQUESTED,
  },
  [STAGE2_OUTCOMES.LISTED_WITH_AGENT]: {
    stage_code: "S2",
    next_stage: S.CONSIDER_SELLING,
    brain_stage: CONVERSATION_STAGES.OFFER_INTEREST_CONFIRMATION,
    status: "listed_backup",
    template_use_case: "already_listed",
    inbox_bucket: "needs_review",
    safety_tier: T.REVIEW,
    acquisition_action: "enter_listed_backup_sequence",
    follow_up_policy: { schedule: true, step: "listed_backup", default_delay_days: 45 },
    event_type: EV.SELLER_LISTED_WITH_AGENT,
  },
  [STAGE2_OUTCOMES.AGENT_OR_REALTOR_INVOLVED]: {
    stage_code: "S2",
    next_stage: S.CONSIDER_SELLING,
    brain_stage: CONVERSATION_STAGES.OFFER_INTEREST_CONFIRMATION,
    status: "listed_backup",
    template_use_case: "already_listed",
    inbox_bucket: "needs_review",
    safety_tier: T.REVIEW,
    acquisition_action: "enter_listed_backup_sequence",
    follow_up_policy: { schedule: true, step: "listed_backup", default_delay_days: 45 },
    event_type: EV.SELLER_LISTED_WITH_AGENT,
  },
  [STAGE2_OUTCOMES.FAMILY_OR_PARTNER_SIGNOFF_NEEDED]: {
    stage_code: "S2",
    next_stage: S.CONSIDER_SELLING_FOLLOW_UP,
    brain_stage: CONVERSATION_STAGES.OFFER_INTEREST_CONFIRMATION,
    status: "awaiting_signoff",
    template_use_case: "family_discussion",
    inbox_bucket: "follow_up",
    safety_tier: T.REVIEW,
    acquisition_action: "schedule_signoff_follow_up",
    follow_up_policy: { schedule: true, step: "signoff", default_delay_days: 5 },
    event_type: EV.SELLER_NEEDS_SIGNOFF,
  },
  [STAGE2_OUTCOMES.TRUST_OR_LEGITIMACY_QUESTION]: {
    stage_code: "S2",
    next_stage: S.WHO_IS_THIS,
    brain_stage: CONVERSATION_STAGES.OFFER_INTEREST_CONFIRMATION,
    status: "awaiting_offer_interest",
    template_use_case: "who_is_this",
    template_use_case_candidates: ["seller_asks_legit", "who_is_this", "proof_of_funds"],
    inbox_bucket: "needs_review",
    safety_tier: T.REVIEW,
    acquisition_action: "answer_trust_question",
    follow_up_policy: null,
    event_type: EV.SELLER_TRUST_QUESTION,
  },
  [STAGE2_OUTCOMES.NEEDS_MORE_CONTEXT]: {
    stage_code: "S2",
    next_stage: S.CONSIDER_SELLING,
    brain_stage: CONVERSATION_STAGES.OFFER_INTEREST_CONFIRMATION,
    status: "awaiting_offer_interest",
    template_use_case: "consider_selling",
    inbox_bucket: "needs_review",
    safety_tier: T.REVIEW,
    acquisition_action: "human_review",
    follow_up_policy: null,
    event_type: null,
  },
  [STAGE2_OUTCOMES.UNCLEAR]: {
    stage_code: "S2",
    next_stage: S.CONSIDER_SELLING,
    brain_stage: CONVERSATION_STAGES.OFFER_INTEREST_CONFIRMATION,
    status: "awaiting_offer_interest",
    template_use_case: "consider_selling",
    inbox_bucket: "needs_review",
    safety_tier: T.REVIEW,
    acquisition_action: "human_review",
    follow_up_policy: null,
    event_type: null,
  },
});

// ══════════════════════════════════════════════════════════════════════════
// DYNAMIC ROUTES
// ══════════════════════════════════════════════════════════════════════════

function routeSellerRequestsOffer(context) {
  const underwriting_ready = Boolean(context?.underwriting_ready);
  if (underwriting_ready) {
    return {
      stage_code: "S5",
      next_stage: S.OFFER_REVEAL_CASH,
      brain_stage: CONVERSATION_STAGES.OFFER_POSITIONING,
      status: "offer_reveal_ready",
      template_use_case: "offer_reveal_cash",
      inbox_bucket: "priority",
      safety_tier: T.REVIEW,
      acquisition_action: "reveal_cash_offer",
      follow_up_policy: null,
      event_type: EV.SELLER_REQUESTED_OFFER,
    };
  }
  // Underwriting not ready → collect price / condition first (S3 → S4).
  return {
    stage_code: "S3",
    next_stage: S.ASKING_PRICE,
    brain_stage: CONVERSATION_STAGES.SELLER_PRICE_DISCOVERY,
    status: "awaiting_asking_price",
    template_use_case: "seller_asking_price",
    template_use_case_candidates: ["seller_asking_price", "price_high_condition_probe"],
    inbox_bucket: "priority",
    safety_tier: T.AUTO_SEND,
    acquisition_action: "collect_price_and_condition",
    follow_up_policy: null,
    event_type: EV.SELLER_REQUESTED_OFFER,
  };
}

function routeAskingPrice(decision) {
  // No underwriting available → capture + human review (never auto-contract blind).
  if (!decision.has_underwriting) {
    return {
      stage_code: "S4",
      next_stage: S.PRICE_HIGH_CONDITION_PROBE,
      brain_stage: CONVERSATION_STAGES.CONDITION_TIMELINE_DISCOVERY,
      status: "price_captured_review",
      template_use_case: "price_high_condition_probe",
      inbox_bucket: "priority",
      safety_tier: T.REVIEW,
      acquisition_action: "run_underwriting",
    };
  }

  switch (decision.negotiation_band) {
    case "inside_range":
      // Ask is at/below our contract ceiling → move to Seller Contract (S6).
      return {
        stage_code: "S6",
        next_stage: S.CLOSE_HANDOFF,
        brain_stage: CONVERSATION_STAGES.VERBAL_ACCEPTANCE_LOCK,
        status: "asks_contract",
        template_use_case: "asks_contract",
        inbox_bucket: "priority",
        safety_tier: T.REVIEW,
        acquisition_action: "verify_signers_and_generate_contract",
      };
    case "near":
      // Reasonably close → justify offer / negotiate (S4/S5).
      return {
        stage_code: "S4",
        next_stage: S.PRICE_HIGH_CONDITION_PROBE,
        brain_stage: CONVERSATION_STAGES.CONDITION_TIMELINE_DISCOVERY,
        status: "justify_and_negotiate",
        template_use_case: "price_high_condition_probe",
        inbox_bucket: "priority",
        safety_tier: T.REVIEW,
        acquisition_action: "justify_offer_and_negotiate",
      };
    case "far":
    default:
      // Materially above range → gather condition/occupancy, then reveal.
      return {
        stage_code: "S4",
        next_stage: S.PRICE_HIGH_CONDITION_PROBE,
        brain_stage: CONVERSATION_STAGES.CONDITION_TIMELINE_DISCOVERY,
        status: "gather_condition",
        template_use_case: "price_high_condition_probe",
        inbox_bucket: "needs_review",
        safety_tier: T.REVIEW,
        acquisition_action: "gather_condition_then_reveal",
      };
  }
}

// ══════════════════════════════════════════════════════════════════════════
// MAIN ENGINE
// ══════════════════════════════════════════════════════════════════════════

/**
 * Classify a Stage 2 seller reply and produce a deterministic routing decision.
 *
 * @param {object} params
 * @param {string} params.message - Raw inbound text.
 * @param {object} [params.classification] - Output of classify() (used for the
 *        preserved compliance / wrong-number / objection signals; never required).
 * @param {object} [params.context]
 * @param {boolean} [params.context.underwriting_ready] - Offer is ready to reveal.
 * @param {object}  [params.context.underwriting] - { recommended_cash_offer, maximum_allowable_offer, contract_ceiling, repair_estimate, lowest_relevant_comp }
 * @param {string}  [params.context.disinterest_policy] - "nurture" (default) | "dead".
 * @param {object}  [params.context.entities] - { property_id, master_owner_id, prospect_id, contact_point_id }
 * @param {string|number} [params.context.source_message_id]
 * @param {string|Date}   [params.context.now] - Injectable timestamp.
 * @returns {object} decision
 */
export function classifyStage2OfferInterest({
  message = "",
  classification = {},
  context = {},
} = {}) {
  const text = lower(message);
  const language = clean(classification?.language) || null;
  const entities = context?.entities || {};
  const source_message_id = context?.source_message_id ?? null;
  const now = context?.now ?? null;

  const outcome = detectStage2Outcome(text, classification);

  // ── Compliance / opt-out: ABSOLUTE override ──────────────────────────────
  if (outcome === STAGE2_OUTCOMES.HOSTILE_OR_COMPLIANCE) {
    const is_opt_out = detectOptOut(text, classification);
    return buildDecision({
      outcome,
      language,
      route: {
        stage_code: "S2",
        next_stage: S.STOP_OR_OPT_OUT,
        brain_stage: CONVERSATION_STAGES.CLOSED_DEAD_OUTCOME,
        status: is_opt_out ? "opted_out" : "compliance_hold",
        template_use_case: null,
        inbox_bucket: "suppressed",
        safety_tier: T.SUPPRESS,
        acquisition_action: "suppress_contact",
      },
      overrides: {
        should_queue_reply: false,
        should_suppress_contact: true,
        should_mark_human_review: !is_opt_out,
        reply_mode: "none",
        suppression_reason: is_opt_out ? "opt_out" : "hostile_or_legal",
      },
      events: [],
    });
  }

  // ── Wrong contact point: preserve Stage 1 contact-graph behavior ─────────
  if (outcome === STAGE2_OUTCOMES.WRONG_CONTACT) {
    return buildDecision({
      outcome,
      language,
      route: {
        // No stage progression and no graph invalidation — only this contact
        // point is suppressed; master owner / prospect / property stay as-is.
        stage_code: "S2",
        next_stage: null,
        brain_stage: null,
        status: "awaiting_offer_interest",
        template_use_case: null,
        inbox_bucket: "suppressed",
        safety_tier: T.SUPPRESS,
        acquisition_action: "suppress_contact_point",
      },
      overrides: {
        should_queue_reply: false,
        should_suppress_contact: true,
        should_mark_human_review: false,
        reply_mode: "none",
        suppression_reason: "wrong_number",
        defer_to_stage1: true,
        contact_point_only: true,
      },
      events: [],
    });
  }

  // ── Seller provides asking price (jump-capable; runs acquisition engine) ──
  if (outcome === STAGE2_OUTCOMES.SELLER_PROVIDES_ASKING_PRICE) {
    const price = extractAskingPrice(text);
    const decision = runAcquisitionDecision(price?.value ?? 0, context?.underwriting || {});
    const route = routeAskingPrice(decision);
    route.event_type = EV.SELLER_ASKING_PRICE_CAPTURED;

    const priceEvent = buildLifecycleEvent(EV.SELLER_ASKING_PRICE_CAPTURED, {
      entities,
      stage_code: route.stage_code,
      status: route.status,
      source_message_id,
      occurred_at: now,
      data: {
        seller_asking_price: price?.value ?? null,
        raw_price_text: price?.raw ?? null,
        confidence: typeof classification?.confidence === "number" ? classification.confidence : null,
        ...decision,
      },
    });

    return buildDecision({
      outcome,
      language,
      route,
      acquisition: decision,
      seller_asking_price: price?.value ?? null,
      events: [priceEvent],
    });
  }

  // ── Seller requests our offer (route by underwriting readiness) ──────────
  if (outcome === STAGE2_OUTCOMES.SELLER_REQUESTS_OFFER) {
    const route = routeSellerRequestsOffer(context);
    const event = buildLifecycleEvent(route.event_type, {
      entities,
      stage_code: route.stage_code,
      status: route.status,
      source_message_id,
      occurred_at: now,
      data: { underwriting_ready: Boolean(context?.underwriting_ready) },
    });
    return buildDecision({ outcome, language, route, events: [event] });
  }

  // ── Not interested (policy: nurture | dead) ──────────────────────────────
  if (outcome === STAGE2_OUTCOMES.NOT_INTERESTED) {
    const policy = lower(context?.disinterest_policy) === "dead" ? "dead" : "nurture";
    const base = STATIC_ROUTES[outcome];
    const route =
      policy === "dead"
        ? {
            ...base,
            stage_code: "S10",
            next_stage: S.TERMINAL,
            brain_stage: CONVERSATION_STAGES.CLOSED_DEAD_OUTCOME,
            status: "dead",
            inbox_bucket: "dead",
            safety_tier: T.SUPPRESS,
            acquisition_action: "mark_dead",
            follow_up_policy: null,
          }
        : {
            ...base,
            status: "nurture",
            inbox_bucket: "follow_up",
            acquisition_action: "enter_nurture_drip",
            follow_up_policy: { schedule: true, step: "nurture", default_delay_days: 60 },
          };

    const event = buildLifecycleEvent(EV.SELLER_NOT_INTERESTED, {
      entities,
      stage_code: route.stage_code,
      status: route.status,
      source_message_id,
      occurred_at: now,
      data: { disinterest_policy: policy },
    });
    return buildDecision({ outcome, language, route, events: [event] });
  }

  // ── Static-routed outcomes ───────────────────────────────────────────────
  const route = { ...STATIC_ROUTES[outcome] };
  const events = [];
  if (route.event_type) {
    events.push(
      buildLifecycleEvent(route.event_type, {
        entities,
        stage_code: route.stage_code,
        status: route.status,
        source_message_id,
        occurred_at: now,
        data: {},
      })
    );
  }
  return buildDecision({ outcome, language, route, events });
}

// ══════════════════════════════════════════════════════════════════════════
// DECISION SHAPE
// ══════════════════════════════════════════════════════════════════════════

function buildDecision({
  outcome,
  language = null,
  route = {},
  overrides = {},
  acquisition = null,
  seller_asking_price = null,
  events = [],
}) {
  const safety_tier = route.safety_tier || T.REVIEW;
  const auto_send_eligible = safety_tier === T.AUTO_SEND;

  const should_queue_reply =
    overrides.should_queue_reply !== undefined
      ? overrides.should_queue_reply
      : Boolean(route.template_use_case) && safety_tier !== T.SUPPRESS;

  const should_mark_human_review =
    overrides.should_mark_human_review !== undefined
      ? overrides.should_mark_human_review
      : safety_tier === T.REVIEW;

  const reply_mode =
    overrides.reply_mode !== undefined
      ? overrides.reply_mode
      : safety_tier === T.AUTO_SEND
        ? "auto"
        : safety_tier === T.SUPPRESS
          ? "none"
          : "manual_review";

  return {
    engine: "stage2_offer_interest",
    outcome,
    language: language || null,

    // Canonical stage routing
    stage_code: route.stage_code || "S2",
    next_stage: route.next_stage ?? null,
    brain_stage: route.brain_stage ?? null,
    status: route.status ?? null,

    // Inbox + templating + follow-up
    inbox_bucket: route.inbox_bucket || "needs_review",
    template_use_case: route.template_use_case ?? null,
    template_use_case_candidates: route.template_use_case_candidates || null,
    follow_up_policy: route.follow_up_policy ?? null,

    // Acquisition action + (optional) underwriting math
    acquisition_action: route.acquisition_action || "human_review",
    acquisition: acquisition || null,
    seller_asking_price,

    // Safety / decision flags (advisory — downstream still enforces auto-reply policy)
    safety_tier,
    auto_send_eligible,
    should_queue_reply: Boolean(should_queue_reply),
    should_suppress_contact: Boolean(overrides.should_suppress_contact),
    should_mark_human_review: Boolean(should_mark_human_review),
    reply_mode,
    suppression_reason: overrides.suppression_reason ?? null,
    defer_to_stage1: Boolean(overrides.defer_to_stage1),
    contact_point_only: Boolean(overrides.contact_point_only),

    // Canonical lifecycle events emitted by this transition
    events,
  };
}

export default classifyStage2OfferInterest;
