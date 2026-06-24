// ─── stage4-condition-justification-engine.js ──────────────────────────────
// Stage 4 — Condition / Price Justification Engine (DETERMINISTIC, NO AI).
//
// Stage 3 decided the seller's ask is above our acceptable range. Stage 4 closes
// the gap: it extracts condition / repair / occupancy facts and seller price
// flexibility from the reply, scores how complete our condition picture is, and
// routes toward one of:
//   1. better underwriting data (condition probe / photo / walkthrough)
//   2. a justified offer reveal           (S5 offer_reveal / justify_price)
//   3. a narrowed price gap               (S5 narrow_range)
//   4. creative finance                   (S4C creative_probe)
//   5. follow-up / nurture                (S3F nurture drip)
//   6. human review                       (ambiguous)
//
// Same posture as the Stage 2 / Stage 3 engines:
//   • heuristic + table driven, no AI
//   • pure module — no DB writes, not wired into the inbound path
//   • additive only — Stage 2 and Stage 3 behavior is untouched
//   • price/offer routes never auto-send (REVIEW); safe info-gathering may auto-send
//
// Upstream (Stage 1/2) owns compliance + wrong-number suppression; like Stage 3,
// this sub-stage engine assumes those overrides already ran.

import { SELLER_FLOW_STAGES } from "@/lib/domain/seller-flow/canonical-seller-flow.js";
import { SELLER_FLOW_SAFETY_TIERS } from "@/lib/domain/seller-flow/seller-flow-safety-policy.js";
import { CONVERSATION_STAGES } from "@/lib/domain/communications-engine/state-machine.js";
import {
  ACQUISITION_LIFECYCLE_EVENTS as EV,
  buildLifecycleEvent,
} from "@/lib/domain/seller-flow/acquisition-lifecycle-events.js";

const T = SELLER_FLOW_SAFETY_TIERS;
const S = SELLER_FLOW_STAGES;

// ══════════════════════════════════════════════════════════════════════════
// OUTCOMES
// ══════════════════════════════════════════════════════════════════════════

export const STAGE4_OUTCOMES = Object.freeze({
  CONDITION_DISCLOSED: "condition_disclosed",
  REPAIR_ISSUE_DISCLOSED: "repair_issue_disclosed",
  LIGHT_REPAIRS: "light_repairs",
  MAJOR_REPAIRS: "major_repairs",
  TENANT_OCCUPIED: "tenant_occupied",
  VACANT_OR_BOARDED: "vacant_or_boarded",
  REFUSES_CONDITION_INFO: "refuses_condition_info",
  ASKS_HOW_OFFER_CALCULATED: "asks_how_offer_calculated",
  CHALLENGES_REPAIR_ESTIMATE: "challenges_repair_estimate",
  CHALLENGES_COMP: "challenges_comp",
  ASKS_FOR_BEST_OFFER: "asks_for_best_offer",
  PRICE_FLEXIBILITY_DETECTED: "price_flexibility_detected",
  PRICE_FIRM: "price_firm",
  CREATIVE_TERMS_POSSIBLE: "creative_terms_possible",
  READY_FOR_OFFER: "ready_for_offer",
  NEEDS_PHOTOS_OR_WALKTHROUGH: "needs_photos_or_walkthrough",
  UNCLEAR: "unclear",
});

export const REPAIR_SEVERITY = Object.freeze({
  NONE: "none",
  LIGHT: "light",
  MODERATE: "moderate",
  MAJOR: "major",
});

export const OCCUPANCY_STATUS = Object.freeze({
  VACANT: "vacant",
  OCCUPIED_TENANT: "occupied_tenant",
  OCCUPIED_OWNER: "occupied_owner",
  SQUATTER: "squatter",
  UNKNOWN: "unknown",
});

// ══════════════════════════════════════════════════════════════════════════
// TEXT UTILITIES
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
  return value === null ? null : Math.round(value * 100) / 100;
}

// ══════════════════════════════════════════════════════════════════════════
// FACT TABLES (English + common Spanish)
// ══════════════════════════════════════════════════════════════════════════

const REPAIR_FACTS = [
  { key: "foundation", tier: "major", phrases: ["foundation", "foundations", "structural", "slab", "cimientos", "fundación", "fundacion"] },
  { key: "fire", tier: "major", phrases: ["fire damage", "fire", "burned", "burnt", "quemado", "incendio"] },
  { key: "water_damage", tier: "major", phrases: ["water damage", "flood", "flooded", "flooding", "water leak", "inundación", "inundacion", "daño de agua"] },
  { key: "mold", tier: "major", phrases: ["mold", "mould", "moho"] },
  { key: "code_violation", tier: "major", phrases: ["code violation", "code violations", "condemned", "red tagged", "red-tagged", "violación de código"] },
  { key: "hoarder", tier: "major", phrases: ["hoarder", "trashout", "trash out", "full of junk", "gutted", "gut job", "down to studs", "down to the studs", "acumulador"] },
  { key: "needs_everything", tier: "major", phrases: ["needs everything", "needs a lot of work", "needs lots of work", "needs tons of work", "total rehab", "full rehab", "complete rehab", "necesita de todo", "necesita mucho trabajo"] },
  { key: "roof", tier: "moderate", phrases: ["roof", "roofing", "new roof", "techo", "tejado"] },
  { key: "plumbing", tier: "moderate", phrases: ["plumbing", "repipe", "re-pipe", "pipes", "plomería", "plomeria", "tubería", "tuberia"] },
  { key: "electrical", tier: "moderate", phrases: ["electrical", "wiring", "rewire", "panel", "eléctrico", "electrico", "cableado"] },
  { key: "hvac", tier: "moderate", phrases: ["hvac", "a/c", "ac unit", "air conditioning", "air condition", "furnace", "heater", "heating", "aire acondicionado", "calefacción"] },
  { key: "windows", tier: "moderate", phrases: ["windows", "window"] },
  { key: "water_heater", tier: "moderate", phrases: ["water heater"] },
  { key: "cosmetic", tier: "light", phrases: ["paint", "painting", "carpet", "flooring", "cosmetic", "clean up", "cleanup", "clean out", "minor work", "little work", "only needs", "just needs paint", "some paint", "pintura", "alfombra"] },
];

const CONDITION_GENERIC = [
  "needs work", "needs some work", "needs repairs", "needs tlc", "fixer",
  "fixer upper", "handyman special", "as-is", "as is", "rough shape",
  "bad shape", "poor condition", "needs updating", "outdated", "needs rehab",
  "necesita reparaciones", "en mal estado", "para arreglar",
];

const OCCUPANCY_VACANT = ["vacant", "empty", "boarded", "boarded up", "abandoned", "nobody lives", "no one lives", "sitting empty", "vacía", "vacia", "desocupada", "desocupado", "abandonada"];
const OCCUPANCY_TENANT = ["tenant", "tenants", "renter", "renters", "rented", "renting", "occupied by", "leased", "tenant is living", "inquilino", "inquilinos", "rentada", "rentado", "arrendada", "arrendado"];
const OCCUPANCY_SQUATTER = ["squatter", "squatters", "okupa"];
const OCCUPANCY_OWNER = ["i live there", "i live here", "owner occupied", "we live there", "my primary residence", "vivo ahí", "vivo alli"];

// ── Flexibility / question signals ──────────────────────────────────────────
const PRICE_FIRM = ["firm", "that's firm", "thats firm", "price is firm", "not a penny less", "not a dollar less", "won't budge", "wont budge", "no negotiating", "non negotiable", "non-negotiable", "take it or leave it", "that's my price", "thats my price", "not negotiable", "precio firme", "es firme", "no bajo"];
const PRICE_FLEX = ["come down", "i can come down", "come down a little", "come down a bit", "some wiggle room", "wiggle room", "i'm flexible", "im flexible", "open to negotiation", "negotiable", "we can negotiate", "i could go lower", "might take less", "work with you", "work with me on price", "puedo bajar", "podemos negociar", "soy flexible"];
const ASKS_BEST = ["what's your best", "whats your best", "best offer", "best you can do", "best and final", "highest you'll go", "highest you can", "top dollar", "mejor oferta", "cuánto es lo máximo"];
const ASKS_HOW_CALC = ["how did you come up with", "how did you get that number", "how do you calculate", "how'd you get that", "where did that number come from", "why so low", "why is it so low", "explain your offer", "explain the offer", "justify that", "how is that fair", "cómo sacaste ese número", "por qué tan bajo"];
const CHALLENGE_REPAIR = ["repair estimate is wrong", "repairs aren't that bad", "repairs arent that bad", "doesn't need that much work", "doesnt need that much", "your repair number", "overestimating repairs", "repairs are overstated", "it doesn't need that much", "reparaciones no son tan"];
const CHALLENGE_COMP = ["your comp", "comps are wrong", "comps are higher", "comparable sold", "houses sold for more", "sold for more", "that comp", "comps in my area", "comparables", "comparativos", "se vendió por más"];
const NEEDS_LOOK = ["send someone", "come look", "come take a look", "come see it", "walk through", "walkthrough", "walk-through", "see it in person", "look at it", "send an inspector", "i can send photos", "i'll send photos", "ill send photos", "send pictures", "send pics", "send some photos", "send you photos", "send you pictures", "mando fotos", "puedo enviar fotos", "vengan a ver"];
const REFUSES = ["not telling you", "why do you need to know", "none of your business", "i'm not answering", "im not answering", "won't say", "wont say", "not gonna tell you", "that's private", "no te voy a decir", "no es asunto tuyo"];
const CREATIVE = ["owner financing", "owner finance", "seller financing", "seller finance", "owner carry", "carry the note", "monthly payments", "rent to own", "lease option", "subject to", "take over payments", "financiamiento", "a plazos", "pagos mensuales", "open to terms", "do terms"];
const READY_OFFER = ["send me your offer", "send the offer", "send your offer", "send me an offer", "ready for your offer", "ready for the offer", "give me your offer", "go ahead and send", "i'm ready", "im ready", "make your offer", "let's see the offer", "lets see the offer", "what's the offer", "whats the offer", "mándame la oferta", "estoy listo"];
const PHOTO_WORDS = ["photo", "photos", "pic", "pics", "picture", "pictures", "fotos"];

// ══════════════════════════════════════════════════════════════════════════
// EXTRACTION
// ══════════════════════════════════════════════════════════════════════════

function detectRepairFacts(text) {
  const found = [];
  for (const fact of REPAIR_FACTS) {
    if (includesAny(text, fact.phrases)) found.push({ key: fact.key, tier: fact.tier });
  }
  return found;
}

function severityFromFacts(repair_facts, condition_generic) {
  const tiers = new Set(repair_facts.map((f) => f.tier));
  if (tiers.has("major")) return REPAIR_SEVERITY.MAJOR;
  if (tiers.has("moderate")) return REPAIR_SEVERITY.MODERATE;
  if (tiers.has("light")) return REPAIR_SEVERITY.LIGHT;
  if (condition_generic) return REPAIR_SEVERITY.MODERATE;
  return REPAIR_SEVERITY.NONE;
}

function detectOccupancy(text) {
  if (includesAny(text, OCCUPANCY_SQUATTER)) return OCCUPANCY_STATUS.SQUATTER;
  if (includesAny(text, OCCUPANCY_TENANT)) return OCCUPANCY_STATUS.OCCUPIED_TENANT;
  if (includesAny(text, OCCUPANCY_VACANT)) return OCCUPANCY_STATUS.VACANT;
  if (includesAny(text, OCCUPANCY_OWNER)) return OCCUPANCY_STATUS.OCCUPIED_OWNER;
  return OCCUPANCY_STATUS.UNKNOWN;
}

function buildFlags(text) {
  return {
    refuses: includesAny(text, REFUSES),
    challenge_repair: includesAny(text, CHALLENGE_REPAIR),
    challenge_comp: includesAny(text, CHALLENGE_COMP),
    asks_how_calc: includesAny(text, ASKS_HOW_CALC),
    asks_best: includesAny(text, ASKS_BEST),
    needs_look: includesAny(text, NEEDS_LOOK),
    creative: includesAny(text, CREATIVE),
    price_firm: includesAny(text, PRICE_FIRM),
    price_flex: includesAny(text, PRICE_FLEX),
    ready_offer: includesAny(text, READY_OFFER),
  };
}

// ══════════════════════════════════════════════════════════════════════════
// PRIMARY OUTCOME LADDER (deterministic priority)
// ══════════════════════════════════════════════════════════════════════════

function determineOutcome({ flags, severity, repair_facts, condition_generic, occupancy_status }) {
  if (flags.refuses) return STAGE4_OUTCOMES.REFUSES_CONDITION_INFO;
  if (flags.challenge_repair) return STAGE4_OUTCOMES.CHALLENGES_REPAIR_ESTIMATE;
  if (flags.challenge_comp) return STAGE4_OUTCOMES.CHALLENGES_COMP;
  if (flags.asks_how_calc) return STAGE4_OUTCOMES.ASKS_HOW_OFFER_CALCULATED;
  if (flags.asks_best) return STAGE4_OUTCOMES.ASKS_FOR_BEST_OFFER;
  if (flags.needs_look) return STAGE4_OUTCOMES.NEEDS_PHOTOS_OR_WALKTHROUGH;
  if (flags.creative) return STAGE4_OUTCOMES.CREATIVE_TERMS_POSSIBLE;
  if (flags.price_firm) return STAGE4_OUTCOMES.PRICE_FIRM;
  if (flags.price_flex) return STAGE4_OUTCOMES.PRICE_FLEXIBILITY_DETECTED;
  if (flags.ready_offer) return STAGE4_OUTCOMES.READY_FOR_OFFER;

  const has_major = repair_facts.some((f) => f.tier === "major");
  const has_moderate = repair_facts.some((f) => f.tier === "moderate");
  const has_light = repair_facts.some((f) => f.tier === "light");
  if (has_major) return STAGE4_OUTCOMES.MAJOR_REPAIRS;
  if (has_moderate) return STAGE4_OUTCOMES.REPAIR_ISSUE_DISCLOSED;
  if (has_light) return STAGE4_OUTCOMES.LIGHT_REPAIRS;

  if (occupancy_status === OCCUPANCY_STATUS.OCCUPIED_TENANT || occupancy_status === OCCUPANCY_STATUS.SQUATTER) {
    return STAGE4_OUTCOMES.TENANT_OCCUPIED;
  }
  if (occupancy_status === OCCUPANCY_STATUS.VACANT) return STAGE4_OUTCOMES.VACANT_OR_BOARDED;

  if (condition_generic) return STAGE4_OUTCOMES.CONDITION_DISCLOSED;

  return STAGE4_OUTCOMES.UNCLEAR;
}

// ══════════════════════════════════════════════════════════════════════════
// METRICS
// ══════════════════════════════════════════════════════════════════════════

function computeFlexibilityScore(outcome, wide_gap) {
  if (outcome === STAGE4_OUTCOMES.PRICE_FIRM) return wide_gap ? 10 : 15;
  if (outcome === STAGE4_OUTCOMES.PRICE_FLEXIBILITY_DETECTED) return 70;
  if (outcome === STAGE4_OUTCOMES.ASKS_FOR_BEST_OFFER) return 55;
  if (outcome === STAGE4_OUTCOMES.CREATIVE_TERMS_POSSIBLE) return 60;
  if (outcome === STAGE4_OUTCOMES.READY_FOR_OFFER) return 60;
  if ([STAGE4_OUTCOMES.CHALLENGES_REPAIR_ESTIMATE, STAGE4_OUTCOMES.CHALLENGES_COMP, STAGE4_OUTCOMES.ASKS_HOW_OFFER_CALCULATED].includes(outcome)) {
    return 45;
  }
  return 50;
}

function computeJustificationBasis(outcome, { has_repair_estimate, has_comp, severity, occupancy_status }) {
  if (outcome === STAGE4_OUTCOMES.CHALLENGES_REPAIR_ESTIMATE) return "repair_estimate";
  if (outcome === STAGE4_OUTCOMES.CHALLENGES_COMP) return "comp";

  // "How did you calculate?" → explain from whatever underwriting we have.
  if (outcome === STAGE4_OUTCOMES.ASKS_HOW_OFFER_CALCULATED) {
    const avail = [];
    if (has_repair_estimate) avail.push("repair_estimate");
    if (has_comp) avail.push("comp");
    return avail.length > 1 ? "mixed" : avail[0] || null;
  }

  const bases = [];
  if (severity !== REPAIR_SEVERITY.NONE && has_repair_estimate) bases.push("repair_estimate");
  if (has_comp) bases.push("comp");
  if (occupancy_status === OCCUPANCY_STATUS.OCCUPIED_TENANT) bases.push("occupancy");

  if (bases.length > 1) return "mixed";
  if (bases.length === 1) return bases[0];
  return has_repair_estimate ? "repair_estimate" : null;
}

// ══════════════════════════════════════════════════════════════════════════
// ROUTING
// ══════════════════════════════════════════════════════════════════════════

function offerRevealRoute() {
  return {
    stage_code: "S5", next_stage: S.OFFER_REVEAL_CASH, brain_stage: CONVERSATION_STAGES.OFFER_POSITIONING,
    status: "offer_reveal", template_use_case: "offer_reveal_cash", inbox_bucket: "priority",
    acquisition_action: "reveal_offer", route: "offer_reveal", safety_tier: T.REVIEW,
    primary_event: EV.READY_FOR_OFFER_REVEAL, should_reveal_offer: true, follow_up_policy: null,
  };
}
function justifyRoute(action = "justify_offer", reveal = false) {
  return {
    stage_code: "S4", next_stage: S.JUSTIFY_PRICE, brain_stage: CONVERSATION_STAGES.NEGOTIATION,
    status: "justifying_offer", template_use_case: "justify_price", inbox_bucket: "priority",
    acquisition_action: action, route: "justify_price", safety_tier: T.REVIEW,
    primary_event: EV.PRICE_JUSTIFICATION_REQUESTED, should_reveal_offer: reveal, follow_up_policy: null,
  };
}
function narrowRoute() {
  return {
    stage_code: "S5", next_stage: S.NARROW_RANGE, brain_stage: CONVERSATION_STAGES.NEGOTIATION,
    status: "narrowing_gap", template_use_case: "narrow_range", inbox_bucket: "priority",
    acquisition_action: "narrow_price_gap", route: "narrow_range", safety_tier: T.REVIEW,
    primary_event: EV.PRICE_GAP_NARROWING_OPENED, should_reveal_offer: false, follow_up_policy: null,
  };
}
function conditionProbeRoute({ template_use_case = "price_high_condition_probe", bucket = "needs_review" } = {}) {
  return {
    stage_code: "S4", next_stage: S.PRICE_HIGH_CONDITION_PROBE, brain_stage: CONVERSATION_STAGES.CONDITION_TIMELINE_DISCOVERY,
    status: "gathering_condition", template_use_case, inbox_bucket: bucket,
    acquisition_action: "gather_condition_data", route: "condition_probe", safety_tier: T.AUTO_SEND,
    primary_event: EV.CONDITION_INFO_REQUESTED, should_reveal_offer: false, follow_up_policy: null,
  };
}
function tenantRoute() {
  return {
    stage_code: "S4", next_stage: S.ASK_CONDITION_CLARIFIER, brain_stage: CONVERSATION_STAGES.CONDITION_TIMELINE_DISCOVERY,
    status: "tenant_assessment", template_use_case: "has_tenants", inbox_bucket: "needs_review",
    acquisition_action: "assess_tenant_occupancy", route: "tenant", safety_tier: T.AUTO_SEND,
    primary_event: EV.CONDITION_INFO_REQUESTED, should_reveal_offer: false, follow_up_policy: null,
  };
}
function creativeRoute() {
  return {
    stage_code: "S4C", next_stage: S.CREATIVE_PROBE, brain_stage: CONVERSATION_STAGES.OFFER_POSITIONING,
    status: "creative_finance_probe", template_use_case: "creative_probe", inbox_bucket: "needs_review",
    acquisition_action: "propose_creative_finance", route: "creative_finance", safety_tier: T.REVIEW,
    primary_event: EV.CREATIVE_TERMS_PROPOSED, should_reveal_offer: false, follow_up_policy: null,
  };
}
function nurtureRoute() {
  return {
    stage_code: "S3F", next_stage: S.ASKING_PRICE_FOLLOW_UP, brain_stage: CONVERSATION_STAGES.SELLER_PRICE_DISCOVERY,
    status: "nurture", template_use_case: "asking_price_follow_up", inbox_bucket: "follow_up",
    acquisition_action: "enter_nurture_drip", route: "nurture", safety_tier: T.REVIEW,
    primary_event: EV.DEAL_NURTURE_TRIGGERED, should_reveal_offer: false,
    follow_up_policy: { schedule: true, step: "nurture", default_delay_days: 60 },
  };
}
function humanReviewRoute() {
  return {
    stage_code: "S4", next_stage: S.ASK_CONDITION_CLARIFIER, brain_stage: CONVERSATION_STAGES.CONDITION_TIMELINE_DISCOVERY,
    status: "needs_review", template_use_case: null, inbox_bucket: "needs_review",
    acquisition_action: "human_review", route: "human_review", safety_tier: T.REVIEW,
    primary_event: EV.CONDITION_HUMAN_REVIEW_REQUIRED, should_reveal_offer: false, follow_up_policy: null,
  };
}

function routeOutcome(outcome, ctx, text) {
  const { underwriting_ready, completeness, wide_gap, creative_allowed } = ctx;
  const data_sufficient = underwriting_ready && completeness >= 0.5;

  switch (outcome) {
    case STAGE4_OUTCOMES.REFUSES_CONDITION_INFO:
      return underwriting_ready ? justifyRoute("justify_with_available_data", true) : humanReviewRoute();

    case STAGE4_OUTCOMES.CHALLENGES_REPAIR_ESTIMATE:
      return justifyRoute("justify_with_repair_estimate", underwriting_ready);
    case STAGE4_OUTCOMES.CHALLENGES_COMP:
      return justifyRoute("justify_with_comp", underwriting_ready);
    case STAGE4_OUTCOMES.ASKS_HOW_OFFER_CALCULATED:
      return justifyRoute("explain_offer_basis", underwriting_ready);

    case STAGE4_OUTCOMES.ASKS_FOR_BEST_OFFER:
    case STAGE4_OUTCOMES.PRICE_FLEXIBILITY_DETECTED:
      return narrowRoute();

    case STAGE4_OUTCOMES.NEEDS_PHOTOS_OR_WALKTHROUGH: {
      const template_use_case = includesAny(text, PHOTO_WORDS) ? "photo_request" : "walkthrough_or_condition";
      return conditionProbeRoute({ template_use_case, bucket: "priority" });
    }

    case STAGE4_OUTCOMES.CREATIVE_TERMS_POSSIBLE:
      return creativeRoute();

    case STAGE4_OUTCOMES.PRICE_FIRM:
      if (wide_gap) return creative_allowed ? creativeRoute() : nurtureRoute();
      return justifyRoute("hold_and_justify_offer", underwriting_ready);

    case STAGE4_OUTCOMES.READY_FOR_OFFER:
      return underwriting_ready ? offerRevealRoute() : conditionProbeRoute({ bucket: "priority" });

    case STAGE4_OUTCOMES.MAJOR_REPAIRS:
      return underwriting_ready
        ? justifyRoute("justify_repairs_then_reveal", true)
        : conditionProbeRoute({ bucket: "priority" });

    case STAGE4_OUTCOMES.LIGHT_REPAIRS:
    case STAGE4_OUTCOMES.REPAIR_ISSUE_DISCLOSED:
    case STAGE4_OUTCOMES.CONDITION_DISCLOSED:
    case STAGE4_OUTCOMES.VACANT_OR_BOARDED:
      return data_sufficient ? offerRevealRoute() : conditionProbeRoute({ bucket: "priority" });

    case STAGE4_OUTCOMES.TENANT_OCCUPIED:
      return tenantRoute();

    case STAGE4_OUTCOMES.UNCLEAR:
    default:
      return humanReviewRoute();
  }
}

// ══════════════════════════════════════════════════════════════════════════
// MAIN ENGINE
// ══════════════════════════════════════════════════════════════════════════

/**
 * Classify a Stage 4 condition / price-justification reply.
 *
 * @param {object} params
 * @param {string} [params.message] - Raw inbound text.
 * @param {number} [params.seller_asking_price] - Carried from Stage 2/3.
 * @param {object} [params.stage3_evaluation] - Stage 3 decision (reads offer_band for gap width).
 * @param {object} [params.underwriting] - { repair_estimate, lowest_relevant_comp, arv,
 *        occupancy, condition_score, recommended_cash_offer, max_allowable_offer | maximum_allowable_offer }
 * @param {object} [params.context]
 * @param {boolean} [params.context.creative_allowed]
 * @param {object}  [params.context.prior_known] - { repairs, occupancy, access } booleans (data from earlier turns)
 * @param {object}  [params.context.entities]
 * @param {string|number} [params.context.source_message_id]
 * @param {string|Date}   [params.context.now]
 * @returns {object} decision
 */
export function classifyStage4Condition({
  message = "",
  seller_asking_price = null,
  stage3_evaluation = null,
  underwriting = {},
  context = {},
} = {}) {
  const text = lower(message);
  const entities = context?.entities || {};
  const source_message_id = context?.source_message_id ?? null;
  const now = context?.now ?? null;
  const creative_allowed = Boolean(context?.creative_allowed);
  const prior = context?.prior_known || {};

  // ── Underwriting snapshot ────────────────────────────────────────────────
  const recommended_cash_offer = numberOrNull(underwriting.recommended_cash_offer);
  const max_allowable_offer =
    numberOrNull(underwriting.max_allowable_offer) ??
    numberOrNull(underwriting.maximum_allowable_offer);
  const repair_estimate = numberOrNull(underwriting.repair_estimate);
  const lowest_relevant_comp = numberOrNull(underwriting.lowest_relevant_comp);
  const arv = numberOrNull(underwriting.arv);
  const condition_score = numberOrNull(underwriting.condition_score);
  const underwriting_ready = recommended_cash_offer !== null;
  const has_repair_estimate = repair_estimate !== null;
  const has_comp = lowest_relevant_comp !== null;

  // ── Extraction ───────────────────────────────────────────────────────────
  const repair_facts = detectRepairFacts(text);
  const condition_generic = includesAny(text, CONDITION_GENERIC);
  const repair_severity = severityFromFacts(repair_facts, condition_generic);
  const occupancy_status = detectOccupancy(text);
  const flags = buildFlags(text);

  const outcome = determineOutcome({
    flags, severity: repair_severity, repair_facts, condition_generic, occupancy_status,
  });

  // ── Wide-gap signal (Stage 3 band, else compute from ask vs MAO) ──────────
  const ask = numberOrNull(seller_asking_price);
  const band = clean(stage3_evaluation?.offer_band);
  const wide_gap =
    band === "wide_gap" ||
    band === "very_wide_gap" ||
    (ask !== null && max_allowable_offer !== null && ask > max_allowable_offer * 1.15);

  // ── Completeness / confidence ────────────────────────────────────────────
  const repairs_known = repair_severity !== REPAIR_SEVERITY.NONE || condition_score !== null || Boolean(prior.repairs);
  const occupancy_known = occupancy_status !== OCCUPANCY_STATUS.UNKNOWN || underwriting.occupancy != null || Boolean(prior.occupancy);
  const access_known = flags.needs_look || condition_score !== null || Boolean(prior.access);

  const known_dims = [repairs_known, occupancy_known, access_known].filter(Boolean).length;
  const condition_data_completeness = round2(known_dims / 3);

  let condition_confidence = 0.2;
  if (repairs_known) condition_confidence += 0.25;
  if (occupancy_known) condition_confidence += 0.2;
  if (access_known) condition_confidence += 0.15;
  if (condition_score !== null) condition_confidence += 0.1;
  condition_confidence = round2(Math.min(0.95, condition_confidence));

  const seller_flexibility_score = computeFlexibilityScore(outcome, wide_gap);
  const offer_justification_basis = computeJustificationBasis(outcome, {
    has_repair_estimate, has_comp, severity: repair_severity, occupancy_status,
  });

  // ── Route ────────────────────────────────────────────────────────────────
  const route = routeOutcome(
    outcome,
    { underwriting_ready, completeness: condition_data_completeness, wide_gap, creative_allowed },
    text
  );

  // ── Canonical events ─────────────────────────────────────────────────────
  const events = [];
  const evCommon = { entities, stage_code: route.stage_code, status: route.status, source_message_id, occurred_at: now };

  const has_condition_signal = repair_facts.length > 0 || condition_generic || repair_severity !== REPAIR_SEVERITY.NONE;
  if (has_condition_signal) {
    events.push(buildLifecycleEvent(EV.CONDITION_FACT_CAPTURED, {
      ...evCommon,
      data: { repair_facts, repair_severity, condition_generic },
    }));
  }
  if (repair_facts.length > 0) {
    events.push(buildLifecycleEvent(EV.REPAIR_ISSUE_CAPTURED, {
      ...evCommon,
      data: { repair_facts, repair_severity },
    }));
  }
  if (occupancy_status !== OCCUPANCY_STATUS.UNKNOWN) {
    events.push(buildLifecycleEvent(EV.OCCUPANCY_STATUS_CAPTURED, {
      ...evCommon,
      data: { occupancy_status },
    }));
  }
  if (route.primary_event) {
    events.push(buildLifecycleEvent(route.primary_event, {
      ...evCommon,
      data: {
        outcome,
        offer_justification_basis,
        seller_flexibility_score,
        should_reveal_offer: route.should_reveal_offer,
        wide_gap,
      },
    }));
  }

  return {
    engine: "stage4_condition_justification",
    outcome,

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

    // Extracted facts
    repair_facts,
    repair_severity,
    occupancy_status,
    condition_generic,

    // Computed metrics (requirement #7)
    condition_confidence,
    condition_data_completeness,
    offer_justification_basis,
    seller_flexibility_score,
    should_reveal_offer: route.should_reveal_offer,

    // Underwriting snapshot used
    underwriting_ready,
    wide_gap,
    underwriting: {
      recommended_cash_offer, max_allowable_offer, repair_estimate,
      lowest_relevant_comp, arv, condition_score,
    },

    // Safety flags (advisory)
    safety_tier: route.safety_tier,
    auto_send_eligible: route.safety_tier === T.AUTO_SEND,
    should_queue_reply: Boolean(route.template_use_case),
    should_mark_human_review: route.safety_tier !== T.AUTO_SEND,

    // Canonical lifecycle events
    events,
  };
}

export default classifyStage4Condition;
