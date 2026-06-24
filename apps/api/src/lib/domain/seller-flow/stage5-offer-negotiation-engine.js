// ─── stage5-offer-negotiation-engine.js ────────────────────────────────────
// Stage 5 — Offer / Negotiation Engine (DETERMINISTIC, NO AI).
//
// Consumes Stage 3 economics + Stage 4 condition/justification and drives the
// seller toward one of: accepted offer, narrowed negotiation range, creative
// finance structure, contract execution, or nurture/follow-up.
//
// It handles offer reveal, counter-offer normalization + evaluation, negotiation
// posture / flexibility, creative-finance candidacy (seller finance / subject-to
// / novation), and contract readiness — all heuristic + table driven.
//
// Same posture as Stages 2–4:
//   • no AI for classification, negotiation, routing, offer generation, or seller
//     decision-making
//   • pure module — no DB/queue writes, no side effects, not wired into inbound
//   • additive only — Stage 1–4 behavior untouched
//   • offers/negotiation are NEVER auto-sent (all routes are REVIEW tier)
//
// Upstream (Stage 1/2) owns compliance + wrong-number suppression; this engine
// assumes those overrides already ran.

import { SELLER_FLOW_STAGES } from "@/lib/domain/seller-flow/canonical-seller-flow.js";
import { SELLER_FLOW_SAFETY_TIERS } from "@/lib/domain/seller-flow/seller-flow-safety-policy.js";
import { CONVERSATION_STAGES } from "@/lib/domain/communications-engine/state-machine.js";
import {
  ACQUISITION_LIFECYCLE_EVENTS as EV,
  buildLifecycleEvent,
} from "@/lib/domain/seller-flow/acquisition-lifecycle-events.js";
import { extractAskingPrice } from "@/lib/domain/seller-flow/stage2-offer-interest-engine.js";

const T = SELLER_FLOW_SAFETY_TIERS;
const S = SELLER_FLOW_STAGES;

// ══════════════════════════════════════════════════════════════════════════
// OUTCOMES + BANDS
// ══════════════════════════════════════════════════════════════════════════

export const STAGE5_OUTCOMES = Object.freeze({
  OFFER_REVEALED: "offer_revealed",
  SELLER_ACCEPTS_OFFER: "seller_accepts_offer",
  SELLER_REJECTS_OFFER: "seller_rejects_offer",
  SELLER_COUNTER_OFFER: "seller_counter_offer",
  COUNTER_WITHIN_RANGE: "counter_within_range",
  COUNTER_ABOVE_RANGE: "counter_above_range",
  SELLER_REQUESTS_BEST_AND_FINAL: "seller_requests_best_and_final",
  SELLER_NEEDS_TIME: "seller_needs_time",
  SELLER_NEEDS_SIGNOFF: "seller_needs_signoff",
  SELLER_REQUESTS_PROOF: "seller_requests_proof",
  SELLER_REQUESTS_CONTRACT: "seller_requests_contract",
  CREATIVE_FINANCE_CANDIDATE: "creative_finance_candidate",
  SELLER_FINANCE_CANDIDATE: "seller_finance_candidate",
  SUBJECT_TO_CANDIDATE: "subject_to_candidate",
  NOVATION_CANDIDATE: "novation_candidate",
  NARROW_GAP_NEGOTIATION: "narrow_gap_negotiation",
  WIDE_GAP_NEGOTIATION: "wide_gap_negotiation",
  DEAL_NURTURE: "deal_nurture",
  READY_FOR_CONTRACT: "ready_for_contract",
  HUMAN_REVIEW_REQUIRED: "human_review_required",
});

export const NEGOTIATION_BANDS = Object.freeze({
  AUTO_ACCEPT: "auto_accept",
  CLOSE_RANGE: "close_range",
  NEGOTIABLE: "negotiable",
  WIDE_GAP: "wide_gap",
  VERY_WIDE_GAP: "very_wide_gap",
  UNKNOWN: "unknown",
});

const NEGOTIABLE_FACTOR = 1.15;
const WIDE_GAP_FACTOR = 1.40;

// ══════════════════════════════════════════════════════════════════════════
// UTILITIES
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
function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function round2(value) {
  return value === null || value === undefined ? null : Math.round(value * 100) / 100;
}
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

const TIME_UNIT_WORDS = [
  "day", "days", "week", "weeks", "month", "months", "year", "years",
  "día", "dias", "días", "semana", "semanas", "mes", "meses", "año", "años",
];

// ══════════════════════════════════════════════════════════════════════════
// COUNTER-OFFER EXTRACTION
// ══════════════════════════════════════════════════════════════════════════

/**
 * Normalize a seller counter offer. Handles "175k", "$180,000", "200 mil"
 * (via the Stage 2 extractor) and bare negotiation numbers ("160", "meet me at
 * 150") which are interpreted as thousands relative to a reference price.
 *
 * @returns {{ counter_offer: string|null, normalized_amount: number|null, confidence: number }}
 */
export function extractCounterOffer(message, reference = null) {
  const text = lower(message);
  if (!text) return { counter_offer: null, normalized_amount: null, confidence: 0 };

  const direct = extractAskingPrice(text);
  if (direct) {
    return { counter_offer: direct.raw, normalized_amount: direct.value, confidence: 0.9 };
  }

  const ref = numberOrNull(reference);
  const re = /(?:^|[^\d.$])(\d{2,3})(?![\d.])/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const value = parseInt(m[1], 10);
    const after = text.slice(m.index + m[0].length);
    const trailing = /^\s*([a-zà-ÿ]+)/i.exec(after);
    const word = trailing ? trailing[1].toLowerCase() : "";
    if (TIME_UNIT_WORDS.includes(word)) continue;
    // Negotiation numbers are written in thousands ("160" = $160k). Only infer
    // when we have a reference price in the same order of magnitude.
    if (value >= 30 && value < 1000 && ref !== null && ref >= 1000) {
      return { counter_offer: m[1], normalized_amount: value * 1000, confidence: 0.7 };
    }
  }
  return { counter_offer: null, normalized_amount: null, confidence: 0 };
}

// ══════════════════════════════════════════════════════════════════════════
// BAND EVALUATION
// ══════════════════════════════════════════════════════════════════════════

function bandFor(amount, recommended_cash_offer, max_allowable_offer) {
  const a = numberOrNull(amount);
  const rco = numberOrNull(recommended_cash_offer);
  if (a === null || rco === null) return NEGOTIATION_BANDS.UNKNOWN;
  const mao = numberOrNull(max_allowable_offer) ?? rco;
  if (a <= rco) return NEGOTIATION_BANDS.AUTO_ACCEPT;
  if (a <= mao) return NEGOTIATION_BANDS.CLOSE_RANGE;
  if (a <= mao * NEGOTIABLE_FACTOR) return NEGOTIATION_BANDS.NEGOTIABLE;
  if (a <= mao * WIDE_GAP_FACTOR) return NEGOTIATION_BANDS.WIDE_GAP;
  return NEGOTIATION_BANDS.VERY_WIDE_GAP;
}

// ══════════════════════════════════════════════════════════════════════════
// PHRASE TABLES
// ══════════════════════════════════════════════════════════════════════════

const CONTRACT_PHRASES = ["send the contract", "send contract", "send the agreement", "send paperwork", "send the paperwork", "send docs", "send the docs", "where do i sign", "where to sign", "ready to sign", "let's do the paperwork", "lets do the paperwork", "draw up", "send over the contract", "send me the contract", "purchase agreement", "mándame el contrato", "dónde firmo", "donde firmo"];
const PROOF_PHRASES = ["proof of funds", "show me proof", "verify funds", "bank statement", "pof", "are you funded", "prove you have", "show me the money", "proof you can", "prueba de fondos", "comprobante de fondos"];
const BEST_FINAL_PHRASES = ["best and final", "what's your best", "whats your best", "best you can do", "highest you can", "highest you'll go", "top dollar", "absolute best", "mejor oferta", "lo máximo"];
const SIGNOFF_PHRASES = ["talk to my wife", "talk to my husband", "ask my wife", "ask my husband", "my spouse", "my partner", "talk to my family", "co-owner", "my brother", "my sister", "run it by", "hablar con mi esposa", "hablar con mi esposo", "con mi familia"];
const NEEDS_TIME_PHRASES = ["need time", "need some time", "think about it", "thinking about it", "get back to you", "circle back", "next week", "next month", "later", "not right now", "sleep on it", "necesito tiempo", "déjame pensarlo", "más adelante"];
const ACCEPT_PHRASES = ["i accept", "accepted", "we accept", "i'll take it", "ill take it", "i will take it", "take the offer", "accept your offer", "accept the offer", "sounds good", "that works", "let's do it", "lets do it", "let's do this", "deal", "agreed", "i agree", "ok let's move forward", "let's move forward", "works for me", "acepto", "trato hecho", "de acuerdo", "me parece bien"];
const REJECT_PHRASES = ["no deal", "not gonna happen", "not going to happen", "forget it", "i reject", "rejected", "no thanks", "no thank you", "way too low", "too low", "that's insulting", "thats insulting", "insulting", "not interested anymore", "absolutely not", "hard pass", "no acepto", "muy bajo", "es un insulto"];
const COUNTER_VERBS = ["i'd take", "id take", "i would take", "i'll do", "ill do", "i can do", "can you do", "could you do", "meet me at", "meet me in the middle", "i need at least", "i need", "i want", "how about", "what about", "i'll come down to", "lo dejo en", "mi precio es", "déjalo en", "dejalo en"];

const SUBJECT_TO_PHRASES = ["take over payments", "take over my payments", "subject to", "subject-to", "catch up payments", "catch up my payments", "existing mortgage", "assume my mortgage", "assume the mortgage", "behind on payments", "behind on my mortgage", "back payments", "tomar los pagos", "asumir la hipoteca"];
const SELLER_FINANCE_PHRASES = ["owner financing", "owner finance", "seller financing", "seller finance", "owner carry", "carry the note", "carry the loan", "carry back", "monthly payments", "monthly income", "payments over time", "installments", "financiamiento del dueño", "pagos mensuales", "a plazos"];
const NOVATION_PHRASES = ["list it", "list on the market", "retail price", "retail value", "fix it up and sell", "fix and list", "higher price if you fix", "sell it on the market", "agent price", "novation"];
const CREATIVE_GENERIC_PHRASES = ["creative terms", "creative financing", "open to terms", "do terms", "other options", "different structure", "flexible terms", "terms deal"];

const FIRM_PHRASES = ["firm", "that's firm", "thats firm", "price is firm", "non negotiable", "non-negotiable", "not negotiable", "take it or leave it", "not a penny less", "not a dollar less", "won't budge", "wont budge", "no negotiating", "precio firme", "no negociable"];
const FLEX_PHRASES = ["i can come down", "come down a little", "come down a bit", "could come down", "might come down", "i'm flexible", "im flexible", "flexible on price", "make it make sense", "make it worth", "work with you", "work with me", "depends", "maybe", "puedo bajar", "soy flexible", "podemos negociar"];

// ══════════════════════════════════════════════════════════════════════════
// SIGNAL DETECTION
// ══════════════════════════════════════════════════════════════════════════

function buildFlags(text) {
  return {
    contract: includesAny(text, CONTRACT_PHRASES),
    proof: includesAny(text, PROOF_PHRASES),
    best_final: includesAny(text, BEST_FINAL_PHRASES),
    signoff: includesAny(text, SIGNOFF_PHRASES),
    needs_time: includesAny(text, NEEDS_TIME_PHRASES),
    accept: includesAny(text, ACCEPT_PHRASES),
    reject: includesAny(text, REJECT_PHRASES),
    counter_verb: includesAny(text, COUNTER_VERBS),
    subject_to: includesAny(text, SUBJECT_TO_PHRASES),
    seller_finance: includesAny(text, SELLER_FINANCE_PHRASES),
    novation: includesAny(text, NOVATION_PHRASES),
    creative_generic: includesAny(text, CREATIVE_GENERIC_PHRASES),
    firm: includesAny(text, FIRM_PHRASES),
    flex: includesAny(text, FLEX_PHRASES),
  };
}

// ══════════════════════════════════════════════════════════════════════════
// NEGOTIATION PROFILE + FLEXIBILITY
// ══════════════════════════════════════════════════════════════════════════

function computeFlexibility(flags, input) {
  const base = numberOrNull(input.seller_flexibility_score) ?? 50;
  let delta = 0;
  if (flags.flex) delta += 18;
  if (flags.best_final) delta += 10;
  if (flags.firm) delta -= 30;
  const flexibility_score = clamp(Math.round(base + delta), 0, 100);
  const flexibility_trend = delta > 0 ? "rising" : delta < 0 ? "falling" : "stable";
  const negotiation_posture = flags.firm || flexibility_score <= 30
    ? "anchored"
    : flexibility_score >= 65
      ? "flexible"
      : "neutral";
  return { flexibility_score, flexibility_trend, negotiation_posture };
}

function creativeOpenness(flags, input) {
  if (flags.subject_to || flags.seller_finance || flags.novation) return 85;
  if (flags.creative_generic) return 70;
  const provided = numberOrNull(input.creative_finance_openness);
  if (provided !== null) return provided;
  return 40;
}

function buildNegotiationProfile(flags, input, flexibility) {
  return {
    flexibility_score: flexibility.flexibility_score,
    anchor_strength: numberOrNull(input.anchor_strength) ?? (flags.firm ? 80 : 50),
    trust_score: numberOrNull(input.trust_score),
    urgency_score: numberOrNull(input.urgency_score),
    motivation_score: numberOrNull(input.motivation_score),
    creative_finance_openness: creativeOpenness(flags, input),
    negotiation_posture: flexibility.negotiation_posture,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// OFFER JUSTIFICATION PACKET
// ══════════════════════════════════════════════════════════════════════════

function buildJustificationPacket(input) {
  const seller_asking_price = numberOrNull(input.seller_asking_price);
  const recommended_cash_offer = numberOrNull(input.recommended_cash_offer);
  const repair_estimate = numberOrNull(input.repair_estimate);
  const lowest_relevant_comp =
    numberOrNull(input.lowest_relevant_comp) ?? numberOrNull(input.underwriting?.lowest_relevant_comp);
  const occupancy_status = clean(input.occupancy_status) || "unknown";

  let offer_gap_amount = numberOrNull(input.offer_gap_amount);
  let offer_gap_pct = numberOrNull(input.offer_gap_pct);
  if (offer_gap_amount === null && seller_asking_price !== null && recommended_cash_offer !== null) {
    offer_gap_amount = seller_asking_price - recommended_cash_offer;
  }
  if (offer_gap_pct === null && offer_gap_amount !== null && seller_asking_price) {
    offer_gap_pct = round2((offer_gap_amount / seller_asking_price) * 100);
  }

  const bases = [];
  if (repair_estimate !== null) bases.push("repair_estimate");
  if (lowest_relevant_comp !== null) bases.push("comp");
  if (occupancy_status === "occupied_tenant") bases.push("occupancy");
  const justification_basis = bases.length > 1 ? "mixed" : bases[0] || null;

  return {
    seller_asking_price,
    recommended_cash_offer,
    repair_estimate,
    lowest_relevant_comp,
    occupancy_status,
    offer_gap_amount,
    offer_gap_pct,
    justification_basis,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════════════════

function readyForContractRoute() {
  return { stage_code: "S6", next_stage: S.CLOSE_HANDOFF, brain_stage: CONVERSATION_STAGES.VERBAL_ACCEPTANCE_LOCK, status: "ready_for_contract", template_use_case: "asks_contract", inbox_bucket: "priority", acquisition_action: "generate_contract", route: "ready_for_contract", follow_up_policy: null };
}
function offerRevealRoute() {
  return { stage_code: "S5", next_stage: S.OFFER_REVEAL_CASH, brain_stage: CONVERSATION_STAGES.OFFER_POSITIONING, status: "offer_revealed", template_use_case: "offer_reveal_cash", inbox_bucket: "priority", acquisition_action: "reveal_offer", route: "offer_reveal", follow_up_policy: null };
}
function narrowRoute(action = "narrow_price_gap") {
  return { stage_code: "S5", next_stage: S.NARROW_RANGE, brain_stage: CONVERSATION_STAGES.NEGOTIATION, status: "narrowing_gap", template_use_case: "narrow_range", inbox_bucket: "priority", acquisition_action: action, route: "narrow_gap_negotiation", follow_up_policy: null };
}
function wideRoute(action = "justify_or_pivot") {
  return { stage_code: "S5", next_stage: S.JUSTIFY_PRICE, brain_stage: CONVERSATION_STAGES.NEGOTIATION, status: "wide_gap_negotiation", template_use_case: "justify_price", inbox_bucket: "priority", acquisition_action: action, route: "wide_gap_negotiation", follow_up_policy: null };
}
function creativeRoute(kind) {
  const map = {
    subject_to: { next_stage: S.OFFER_REVEAL_SUBJECT_TO, template_use_case: "offer_reveal_subject_to", action: "propose_subject_to" },
    seller_finance: { next_stage: S.CREATIVE_PROBE, template_use_case: "creative_probe", action: "propose_seller_finance" },
    novation: { next_stage: S.OFFER_REVEAL_NOVATION, template_use_case: "offer_reveal_novation", action: "propose_novation" },
    generic: { next_stage: S.CREATIVE_PROBE, template_use_case: "creative_probe", action: "propose_creative_terms" },
  };
  const cfg = map[kind] || map.generic;
  return { stage_code: "S5C", next_stage: cfg.next_stage, brain_stage: CONVERSATION_STAGES.OFFER_POSITIONING, status: "creative_finance_probe", template_use_case: cfg.template_use_case, inbox_bucket: "needs_review", acquisition_action: cfg.action, route: "creative_finance", follow_up_policy: null };
}
function proofRoute() {
  return { stage_code: "S5", next_stage: S.OFFER_REVEAL_CASH, brain_stage: CONVERSATION_STAGES.OFFER_POSITIONING, status: "proof_requested", template_use_case: "proof_of_funds", inbox_bucket: "priority", acquisition_action: "send_proof_of_funds", route: "proof", follow_up_policy: null };
}
function bestFinalRoute() {
  return { stage_code: "S5", next_stage: S.NARROW_RANGE, brain_stage: CONVERSATION_STAGES.NEGOTIATION, status: "best_and_final", template_use_case: "narrow_range", inbox_bucket: "priority", acquisition_action: "present_best_and_final", route: "best_and_final", follow_up_policy: null };
}
function followUpRoute(kind = "timing") {
  return { stage_code: "S5F", next_stage: S.ASK_TIMELINE, brain_stage: CONVERSATION_STAGES.NEGOTIATION, status: kind === "signoff" ? "awaiting_signoff" : "awaiting_timing", template_use_case: kind === "signoff" ? "family_discussion" : "not_ready", inbox_bucket: "follow_up", acquisition_action: kind === "signoff" ? "schedule_signoff" : "schedule_timing_follow_up", route: kind === "signoff" ? "signoff" : "needs_time", follow_up_policy: { schedule: true, step: kind === "signoff" ? "signoff" : "timing", default_delay_days: kind === "signoff" ? 5 : 14 } };
}
function nurtureRoute() {
  return { stage_code: "S3F", next_stage: S.ASKING_PRICE_FOLLOW_UP, brain_stage: CONVERSATION_STAGES.SELLER_PRICE_DISCOVERY, status: "nurture", template_use_case: "asking_price_follow_up", inbox_bucket: "follow_up", acquisition_action: "enter_nurture_drip", route: "nurture", follow_up_policy: { schedule: true, step: "nurture", default_delay_days: 60 } };
}
function humanReviewRoute() {
  return { stage_code: "S5", next_stage: S.NARROW_RANGE, brain_stage: CONVERSATION_STAGES.NEGOTIATION, status: "needs_review", template_use_case: null, inbox_bucket: "needs_review", acquisition_action: "human_review", route: "human_review", follow_up_policy: null };
}

// ══════════════════════════════════════════════════════════════════════════
// MAIN ENGINE
// ══════════════════════════════════════════════════════════════════════════

export function classifyStage5Negotiation(input = {}) {
  const {
    message = "",
    context = {},
  } = input;

  const text = lower(message);
  const entities = context?.entities || {};
  const source_message_id = context?.source_message_id ?? null;
  const now = context?.now ?? null;
  const creative_allowed = Boolean(context?.creative_allowed);
  const should_reveal_offer = Boolean(input.should_reveal_offer ?? context?.should_reveal_offer);

  // ── Economics snapshot ───────────────────────────────────────────────────
  const recommended_cash_offer = numberOrNull(input.recommended_cash_offer);
  const max_allowable_offer = numberOrNull(input.max_allowable_offer);
  const seller_asking_price = numberOrNull(input.seller_asking_price);
  const underwriting_ready = recommended_cash_offer !== null;
  const reference = recommended_cash_offer ?? seller_asking_price ?? max_allowable_offer;

  // ── Signals ──────────────────────────────────────────────────────────────
  const flags = buildFlags(text);
  const counter = extractCounterOffer(text, reference);
  const has_counter = counter.normalized_amount !== null && (flags.counter_verb || !flags.accept);

  // ── Counter metrics ──────────────────────────────────────────────────────
  let counter_gap_amount = null;
  let counter_gap_pct = null;
  let counter_offer_ratio = null;
  if (counter.normalized_amount !== null && recommended_cash_offer !== null) {
    counter_gap_amount = counter.normalized_amount - recommended_cash_offer;
    counter_gap_pct = round2((counter_gap_amount / counter.normalized_amount) * 100);
    counter_offer_ratio = round2(recommended_cash_offer / counter.normalized_amount);
  }

  // ── Resolved negotiation band ────────────────────────────────────────────
  const subject_amount = has_counter ? counter.normalized_amount : seller_asking_price;
  let negotiation_band = bandFor(subject_amount, recommended_cash_offer, max_allowable_offer);
  if (negotiation_band === NEGOTIATION_BANDS.UNKNOWN) {
    const provided = clean(input.negotiation_band);
    if (Object.values(NEGOTIATION_BANDS).includes(provided)) negotiation_band = provided;
  }

  // ── Flexibility / profile / packet (always produced) ─────────────────────
  const flexibility = computeFlexibility(flags, input);
  const negotiation_profile = buildNegotiationProfile(flags, input, flexibility);
  const offer_justification_packet = buildJustificationPacket(input);

  // ── Outcome + route resolution ───────────────────────────────────────────
  const resolved = resolveOutcomeAndRoute({
    flags, has_counter, counter, negotiation_band, recommended_cash_offer,
    max_allowable_offer, creative_allowed, should_reveal_offer, underwriting_ready,
  });
  const { outcome, route, events: eventTypes } = resolved;

  // ── Build canonical events ───────────────────────────────────────────────
  const evCommon = { entities, stage_code: route.stage_code, status: route.status, source_message_id, occurred_at: now };
  const events = eventTypes.map((type) =>
    buildLifecycleEvent(type, {
      ...evCommon,
      data: {
        outcome,
        negotiation_band,
        counter_offer: counter.normalized_amount,
        counter_gap_amount,
        counter_gap_pct,
        negotiation_posture: flexibility.negotiation_posture,
      },
    })
  );

  return {
    engine: "stage5_offer_negotiation",
    outcome,
    negotiation_band,

    // Canonical stage routing
    stage_code: route.stage_code,
    next_stage: route.next_stage,
    brain_stage: route.brain_stage,
    status: route.status,
    route: route.route,

    // Inbox + templating + follow-up
    inbox_bucket: route.inbox_bucket,
    template_use_case: route.template_use_case,
    follow_up_policy: route.follow_up_policy ?? null,
    acquisition_action: route.acquisition_action,

    // Counter offer
    counter_offer: counter.normalized_amount,
    counter_offer_raw: counter.counter_offer,
    counter_offer_confidence: counter.confidence,
    counter_gap_amount,
    counter_gap_pct,
    counter_offer_ratio,

    // Reusable artifacts
    flexibility_score: flexibility.flexibility_score,
    flexibility_trend: flexibility.flexibility_trend,
    negotiation_posture: flexibility.negotiation_posture,
    negotiation_profile,
    offer_justification_packet,

    // Economics
    underwriting_ready,
    should_reveal_offer,

    // Safety flags — negotiation/offers never auto-send
    safety_tier: T.REVIEW,
    auto_send_eligible: false,
    should_queue_reply: Boolean(route.template_use_case),
    should_mark_human_review: true,

    // Canonical lifecycle events
    events,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// OUTCOME + ROUTE LADDER
// ══════════════════════════════════════════════════════════════════════════

function resolveOutcomeAndRoute(ctx) {
  const {
    flags, has_counter, counter, negotiation_band, recommended_cash_offer,
    max_allowable_offer, creative_allowed, should_reveal_offer, underwriting_ready,
  } = ctx;
  const O = STAGE5_OUTCOMES;
  const B = NEGOTIATION_BANDS;

  // 1. Contract request → Stage 6.
  if (flags.contract) {
    return { outcome: O.SELLER_REQUESTS_CONTRACT, route: readyForContractRoute(), events: [EV.READY_FOR_CONTRACT] };
  }
  // 2. Proof of funds.
  if (flags.proof) {
    return { outcome: O.SELLER_REQUESTS_PROOF, route: proofRoute(), events: [EV.SELLER_REQUESTED_PROOF] };
  }
  // 3. Best and final.
  if (flags.best_final) {
    return { outcome: O.SELLER_REQUESTS_BEST_AND_FINAL, route: bestFinalRoute(), events: [EV.SELLER_REQUESTED_BEST_AND_FINAL, EV.NEGOTIATION_NARROWED] };
  }
  // 4. Signoff needed.
  if (flags.signoff) {
    return { outcome: O.SELLER_NEEDS_SIGNOFF, route: followUpRoute("signoff"), events: [] };
  }
  // 5. Needs time.
  if (flags.needs_time) {
    return { outcome: O.SELLER_NEEDS_TIME, route: followUpRoute("timing"), events: [] };
  }
  // 6. Acceptance (no counter amount).
  if (flags.accept && !has_counter) {
    return { outcome: O.SELLER_ACCEPTS_OFFER, route: readyForContractRoute(), events: [EV.SELLER_ACCEPTED_OFFER, EV.READY_FOR_CONTRACT] };
  }
  // 7. Counter offer.
  if (has_counter) {
    if (!underwriting_ready) {
      return { outcome: O.SELLER_COUNTER_OFFER, route: humanReviewRoute(), events: [EV.SELLER_COUNTER_OFFERED] };
    }
    const mao = max_allowable_offer ?? recommended_cash_offer;
    const within = counter.normalized_amount <= mao;
    if (within) {
      const route = counter.normalized_amount <= recommended_cash_offer ? readyForContractRoute() : narrowRoute("accept_counter_and_narrow");
      const events = [EV.SELLER_COUNTER_OFFERED, EV.COUNTER_OFFER_ACCEPTABLE];
      if (counter.normalized_amount <= recommended_cash_offer) events.push(EV.READY_FOR_CONTRACT);
      else events.push(EV.NEGOTIATION_NARROWED);
      return { outcome: O.COUNTER_WITHIN_RANGE, route, events };
    }
    // Above range.
    const cband = bandFor(counter.normalized_amount, recommended_cash_offer, max_allowable_offer);
    const route =
      cband === B.VERY_WIDE_GAP
        ? (creative_allowed ? creativeRoute("generic") : nurtureRoute())
        : cband === B.WIDE_GAP && creative_allowed
          ? creativeRoute("generic")
          : wideRoute("counter_too_high_justify");
    return { outcome: O.COUNTER_ABOVE_RANGE, route, events: [EV.SELLER_COUNTER_OFFERED, EV.COUNTER_OFFER_TOO_HIGH] };
  }
  // 8. Creative-finance candidacy (most specific first).
  if (flags.subject_to) {
    return { outcome: O.SUBJECT_TO_CANDIDATE, route: creativeRoute("subject_to"), events: [EV.SUBJECT_TO_CANDIDATE, EV.CREATIVE_FINANCE_CANDIDATE] };
  }
  if (flags.novation) {
    return { outcome: O.NOVATION_CANDIDATE, route: creativeRoute("novation"), events: [EV.NOVATION_CANDIDATE, EV.CREATIVE_FINANCE_CANDIDATE] };
  }
  if (flags.seller_finance) {
    return { outcome: O.SELLER_FINANCE_CANDIDATE, route: creativeRoute("seller_finance"), events: [EV.SELLER_FINANCE_CANDIDATE, EV.CREATIVE_FINANCE_CANDIDATE] };
  }
  if (flags.creative_generic) {
    return { outcome: O.CREATIVE_FINANCE_CANDIDATE, route: creativeRoute("generic"), events: [EV.CREATIVE_FINANCE_CANDIDATE] };
  }
  // 9. Explicit rejection.
  if (flags.reject) {
    const route = negotiation_band === B.VERY_WIDE_GAP ? nurtureRoute() : narrowRoute("re_anchor_after_rejection");
    return { outcome: O.SELLER_REJECTS_OFFER, route, events: [EV.SELLER_REJECTED_OFFER] };
  }
  // 10. Firm posture → band-driven pivot.
  if (flags.firm) {
    if (negotiation_band === B.VERY_WIDE_GAP) {
      return creative_allowed
        ? { outcome: O.CREATIVE_FINANCE_CANDIDATE, route: creativeRoute("generic"), events: [EV.CREATIVE_FINANCE_CANDIDATE] }
        : { outcome: O.DEAL_NURTURE, route: nurtureRoute(), events: [EV.DEAL_NURTURE_TRIGGERED] };
    }
    if (negotiation_band === B.WIDE_GAP) {
      return creative_allowed
        ? { outcome: O.CREATIVE_FINANCE_CANDIDATE, route: creativeRoute("generic"), events: [EV.CREATIVE_FINANCE_CANDIDATE] }
        : { outcome: O.WIDE_GAP_NEGOTIATION, route: wideRoute("firm_hold_justify"), events: [EV.NEGOTIATION_OPENED] };
    }
    return { outcome: O.NARROW_GAP_NEGOTIATION, route: narrowRoute("firm_hold_justify"), events: [EV.NEGOTIATION_NARROWED] };
  }
  // 11. Flexibility signal → narrow.
  if (flags.flex) {
    return { outcome: O.NARROW_GAP_NEGOTIATION, route: narrowRoute("narrow_on_flexibility"), events: [EV.NEGOTIATION_NARROWED] };
  }
  // 12. System offer reveal (Stage 4 asked us to reveal, no seller response yet).
  if (should_reveal_offer) {
    return { outcome: O.OFFER_REVEALED, route: offerRevealRoute(), events: [EV.OFFER_REVEALED, EV.NEGOTIATION_OPENED] };
  }
  // 13. Band-driven default.
  switch (negotiation_band) {
    case B.AUTO_ACCEPT:
      return { outcome: O.READY_FOR_CONTRACT, route: readyForContractRoute(), events: [EV.READY_FOR_CONTRACT] };
    case B.CLOSE_RANGE:
      return { outcome: O.NARROW_GAP_NEGOTIATION, route: narrowRoute("narrow_close_range"), events: [EV.NEGOTIATION_NARROWED] };
    case B.NEGOTIABLE:
      return { outcome: O.NARROW_GAP_NEGOTIATION, route: narrowRoute("continue_negotiation"), events: [EV.NEGOTIATION_OPENED] };
    case B.WIDE_GAP:
      return creative_allowed
        ? { outcome: O.CREATIVE_FINANCE_CANDIDATE, route: creativeRoute("generic"), events: [EV.CREATIVE_FINANCE_CANDIDATE] }
        : { outcome: O.WIDE_GAP_NEGOTIATION, route: wideRoute("wide_gap_justify"), events: [EV.NEGOTIATION_OPENED] };
    case B.VERY_WIDE_GAP:
      return creative_allowed
        ? { outcome: O.CREATIVE_FINANCE_CANDIDATE, route: creativeRoute("generic"), events: [EV.CREATIVE_FINANCE_CANDIDATE] }
        : { outcome: O.DEAL_NURTURE, route: nurtureRoute(), events: [EV.DEAL_NURTURE_TRIGGERED] };
    default:
      return { outcome: O.HUMAN_REVIEW_REQUIRED, route: humanReviewRoute(), events: [] };
  }
}

export default classifyStage5Negotiation;
