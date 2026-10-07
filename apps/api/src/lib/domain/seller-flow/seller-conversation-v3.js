// ─── seller-conversation-v3.js ───────────────────────────────────────────────
// SELLER CONVERSATION MACHINE v3 (owner brief 2026-10-06 late): "zero manual
// review for S1/S2; every reply has a path".
//
// PURE module (no I/O, no AI). Nothing here runs unless BOTH flags are on:
// SELLER_CONVERSATION_V3 (this layer) and SELLER_AUTOPILOT_V2 (the overlay,
// the template-preference directive and the quote log it builds on). With the
// flag off the orchestrator never calls in here.
//
// It builds on what exists and duplicates none of it:
//   • the classifier verdict (classify.js, rounds 1–8) and the v2 overlay /
//     v2 intent reading (seller-autopilot-v2.js) name the intent;
//   • the one money path (monetary-understanding.js, v3 number rules) names
//     the asking price; extractSellerFacts names condition / occupancy;
//     extractUpdateYears names the update years;
//   • the authoritative Decision Engine snapshot, guarded by offer-sanity,
//     names the value; the v2 offer authority + as-is anchor name the number.
//
// What it adds:
//   1. THE CHECKLIST — ownership, interest, asking price, condition (+ update
//      years), occupancy — collected across turns; ask ONLY for what is
//      missing, never re-ask what was answered.
//   2. A NEXT ACTION FOR EVERY INTENT — an auto-reply or an automatic terminal
//      action (suppress / archive / nurture / wrong number / referral capture
//      / re-ask once then archive). No S1/S2 intent ends in human review.
//      Review is reserved for a legal threat or a money guard at S4+.
//   3. PRICE vs VALUE (SFR) — far above → "let me know when you're seriously
//      considering an offer" nurture (no condition ask); near → condition (+
//      occupancy); below → condition + occupancy → the offer path.
//   4. MULTIFAMILY — a price-per-door anchor range from real MF comps.
//   5. WHO / WHY / HOW'D-YOU-GET-MY-NUMBER — the local-investor answer, then
//      the same question again; a second ask gets a different answer, a third
//      is archived. Never the identical text twice (repeat guard).

import { extractSellerFacts } from "@/lib/domain/seller-flow/extract-seller-facts.js";
import { extractUpdateYears } from "@/lib/domain/seller-flow/monetary-understanding.js";
import { evaluateScoreOfferSanity } from "@/lib/acquisition/offer-sanity.js";
import { OFFER_POLICY_EPOCH, OFFER_READY_MAX_AGE_DAYS } from "@/lib/acquisition/offerReadiness.js";
import {
  V2_STAGES,
  V2_INTENTS,
  V2_USE_CASES,
  resolveV2Stage,
  resolveV2Intent,
  computeAsIsAnchor,
  roundAnchorDown,
  isSellerAutopilotV2Enabled,
} from "@/lib/domain/seller-flow/seller-autopilot-v2.js";
import {
  isSellerConversationV3Enabled,
  SELLER_CONVERSATION_V3_FLAG,
} from "@/lib/domain/seller-flow/seller-conversation-v3-flag.js";

export { isSellerConversationV3Enabled, SELLER_CONVERSATION_V3_FLAG };

export const SELLER_CONVERSATION_V3_VERSION = "seller_conversation_machine_v3_2026_10_06";

/** v3 runs only on top of the v2 layer (overlay + template-preference directive + quote log). */
export function isSellerConversationV3Active(env = process.env) {
  return isSellerConversationV3Enabled(env) && isSellerAutopilotV2Enabled(env);
}

function clean(value) {
  return String(value ?? "").trim();
}
function lower(value) {
  return clean(value).toLowerCase();
}
function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ══════════════════════════════════════════════════════════════════════════
// CONFIG (owner to tune)
// ══════════════════════════════════════════════════════════════════════════

export const V3_CONFIG = Object.freeze({
  // "Far above" = more than 1.5× value OR more than value + $100K.
  far_above_ratio: 1.5,
  far_above_delta: 100_000,
  // "Below value" = more than 10% under value; between that and far-above is "near".
  below_value_fraction: 0.9,
  // Unclear replies: re-ask the current question this many times, then archive (S1/S2) / nurture (S3+).
  reask_limit: 1,
  // Who/why: the 1st ask gets the who-is-this answer, the 2nd a different one, the next is archived.
  who_answer_limit: 2,
  mf: Object.freeze({
    radius_miles: 3.0, // wider than SFR (owner: "a wider radius is OK")
    max_age_months: 18,
    min_comps: 3,
    min_door_price: 10_000,
    outlier_fraction_of_median: 0.5,
    outlier_multiple_of_median: 2.0,
    round_step: 5_000,
    prefer_off_market: true,
  }),
});

// ══════════════════════════════════════════════════════════════════════════
// USE CASES (sms_templates.use_case)
// ══════════════════════════════════════════════════════════════════════════

export const V3_USE_CASES = Object.freeze({
  // existing (active + safe EN/ES in prod)
  OWNERSHIP: "ownership_check",
  INTEREST: "consider_selling",
  INTEREST_FOLLOW_UP: "consider_selling_follow_up",
  ASK_PRICE: "seller_asking_price",
  ASK_PRICE_FOLLOW_UP: "asking_price_follow_up",
  CONDITION_CLARIFIER: "ask_condition_clarifier",
  CONDITION_NEAR_VALUE: "price_high_condition_probe",
  REPAIR_CLARIFICATION: "repair_clarification",
  WHO: "who_is_this",
  INFO_SOURCE: "info_source_explanation",
  ALREADY_LISTED: "already_listed",
  TEXT_ONLY: "text_only_redirect",
  MF_CONFIRM_UNITS: "mf_confirm_units",
  MF_OCCUPANCY: "mf_occupancy",
  // v2 / round 6–8 drafts (PROPOSED, inactive)
  NO_PRICE_CONDITION: V2_USE_CASES.NO_PRICE_CONDITION,
  PRICE_ACCEPT: V2_USE_CASES.PRICE_ACCEPT,
  OWNERSHIP_CLARIFIER: V2_USE_CASES.OWNERSHIP_CLARIFIER,
  WHO_S1: V2_USE_CASES.WHO_S1,
  WHO_S3: V2_USE_CASES.WHO_S3,
  WHO_S4: V2_USE_CASES.WHO_S4,
  ANCHOR_COMPS: V2_USE_CASES.ANCHOR_COMPS,
  ANCHOR_ABOVE_MAX: V2_USE_CASES.ANCHOR_ABOVE_MAX,
  CAPITAL_GAINS: V2_USE_CASES.CAPITAL_GAINS,
  REALITY_CHECK: "price_reality_check",
  FRUSTRATION_APOLOGY: "seller_frustration_apology",
  // NEW in v3 (PROPOSED, inactive — PROPOSED_20261007030000)
  FAR_ABOVE_NURTURE: "v3_price_far_above_nurture",
  BELOW_VALUE_BASICS: "v3_below_value_condition_occupancy",
  OCCUPANCY: "v3_occupancy_check",
  REFERRAL_BEST_CONTACT: "v3_referral_best_contact",
  REASK_OWNERSHIP: "v3_reask_ownership",
  REASK_INTEREST: "v3_reask_interest",
  WHO_VARIANT: "v3_who_is_this_variant",
  NUMBERS_PENDING: "v3_numbers_pending",
  MF_PER_DOOR_ANCHOR: "v3_mf_per_door_anchor",
  UPDATE_YEARS: "v3_update_year_follow_up",
});
const U = V3_USE_CASES;

/** Use cases whose answer binds the next reply to a question (build-conversation-context aliases). */
export const V3_CONTEXT_ALIASES = Object.freeze({
  [U.FAR_ABOVE_NURTURE]: "asking_price",
  [U.BELOW_VALUE_BASICS]: "condition_check",
  [U.OCCUPANCY]: "occupancy_check",
  [U.REFERRAL_BEST_CONTACT]: "ownership_check",
  [U.REASK_OWNERSHIP]: "ownership_check",
  [U.REASK_INTEREST]: "proposal_interest",
  [U.WHO_VARIANT]: "proposal_interest",
  [U.NUMBERS_PENDING]: "condition_check",
  [U.MF_PER_DOOR_ANCHOR]: "asking_price",
  [U.UPDATE_YEARS]: "condition_check",
  [U.INFO_SOURCE]: "proposal_interest",
  [U.ASK_PRICE_FOLLOW_UP]: "asking_price",
  [U.REPAIR_CLARIFICATION]: "condition_check",
  [U.INTEREST_FOLLOW_UP]: "proposal_interest",
});

const REASK_USE_CASES = new Set([U.REASK_OWNERSHIP, U.REASK_INTEREST, U.ASK_PRICE_FOLLOW_UP, U.REPAIR_CLARIFICATION, U.INTEREST_FOLLOW_UP, U.OWNERSHIP_CLARIFIER]);
const WHO_USE_CASES = new Set([U.WHO, U.WHO_S1, U.WHO_S3, U.WHO_S4, U.INFO_SOURCE, U.WHO_VARIANT, "how_got_number"]);
const FAR_ABOVE_USE_CASES = new Set([U.FAR_ABOVE_NURTURE, U.REALITY_CHECK]);

// ══════════════════════════════════════════════════════════════════════════
// TERMINAL ACTIONS + INBOX
// ══════════════════════════════════════════════════════════════════════════

export const V3_TERMINAL = Object.freeze({
  SUPPRESS: "suppress_opt_out",
  WRONG_NUMBER: "wrong_number_disposition",
  ARCHIVE: "archive_no_reply",
  ARCHIVE_PROPERTY: "archive_property_pairing",
  NURTURE: "nurture_30_day",
  REFERRAL_CAPTURE: "referral_capture",
  WAIT: "no_reply_wait",
});

/**
 * Where a terminal leaves the thread (resolve-inbox-state-from-classification
 * reads classification.seller_conversation_v3.inbox_bucket). Never New
 * Replies / Priority, never an alert (fd3ef4ae bucket rules: hostile/troll and
 * closed-for-property are Dead; not-interested / need-time are Follow-up).
 */
const TERMINAL_BUCKET = Object.freeze({
  [V3_TERMINAL.SUPPRESS]: null, // compliance decides (Suppressed)
  [V3_TERMINAL.WRONG_NUMBER]: null, // existing wrong-number archive
  [V3_TERMINAL.ARCHIVE]: "dead",
  [V3_TERMINAL.ARCHIVE_PROPERTY]: "dead",
  [V3_TERMINAL.NURTURE]: "follow_up",
  [V3_TERMINAL.REFERRAL_CAPTURE]: null, // execute-referral-automation owns it
  [V3_TERMINAL.WAIT]: "cold",
});

// ══════════════════════════════════════════════════════════════════════════
// STAGE
// ══════════════════════════════════════════════════════════════════════════

export const V3_STAGES = Object.freeze({ ...V2_STAGES });

const V3_CONTEXT_STAGE = Object.freeze({
  ownership_check: V3_STAGES.S1,
  proposal_interest: V3_STAGES.S2,
  proposal_request: V3_STAGES.S2,
  asking_price: V3_STAGES.S3,
  condition_check: V3_STAGES.S4,
  occupancy_check: V3_STAGES.S4_BASICS,
});

/** Stage = the question we asked (v2 resolver), with the v3 use cases bound too. */
export function resolveV3Stage({ conversation_context = null, stage_before = null } = {}) {
  const v2 = resolveV2Stage({ conversation_context, stage_before });
  const alias = V3_CONTEXT_ALIASES[clean(conversation_context?.last_outbound_template_use_case)];
  if (alias && v2.source !== "question_context") {
    return { stage: V3_CONTEXT_STAGE[alias] || v2.stage, source: "v3_use_case", context_status: v2.context_status };
  }
  return v2;
}

const STAGE_ORDER = [V3_STAGES.S1, V3_STAGES.S2, V3_STAGES.S3, V3_STAGES.S4, V3_STAGES.S4_BASICS, V3_STAGES.BEYOND];
function stageAtLeast(stage, floor) {
  const a = STAGE_ORDER.indexOf(stage);
  const b = STAGE_ORDER.indexOf(floor);
  return a >= 0 && b >= 0 && a >= b;
}
const isEarlyStage = (stage) => stage === V3_STAGES.S1 || stage === V3_STAGES.S2 || stage === V3_STAGES.UNKNOWN;

// ══════════════════════════════════════════════════════════════════════════
// THE CHECKLIST
// ══════════════════════════════════════════════════════════════════════════

export const CHECKLIST_FIELDS = Object.freeze(["ownership", "interest", "asking_price", "condition", "occupancy"]);

const OWNERSHIP_YES = new Set(["confirmed", "owner", "owner_confirmed", "yes", "verified", "entity_owner", "trust_owner", "estate"]);
const OWNERSHIP_TURN_INTENTS = new Set(["ownership_confirmed", "llc_corporation", "trust_ownership"]);
const INTEREST_TURN_INTENTS = new Set(["seller_interested", "latent_interest", "asks_offer", "asking_price_provided", "asking_price_absent", "contract_requested"]);
const CONDITION_TURN_INTENTS = new Set(["condition_disclosed"]);
const OCCUPANCY_TURN_INTENTS = new Set(["tenant_occupied"]);

function knownAsk(known_facts = {}) {
  const raw = known_facts?.asking_price;
  const v = num(raw && typeof raw === "object" ? raw.value ?? raw.amount : raw);
  return v != null && v > 0 ? v : null;
}

/**
 * The checklist after THIS turn: what the thread already knew (persisted
 * known_facts + how far the conversation got) merged with what this message
 * said. Each field: { collected, value, source }.
 */
export function deriveChecklist({
  known_facts = {},
  stage = V3_STAGES.UNKNOWN,
  classification = null,
  v2_intent = null,
  message = "",
  asking_price_this_turn = null,
  prior_template_use_case = null,
  now = Date.now(),
} = {}) {
  const intent = lower(classification?.primary_intent);
  const facts = extractSellerFacts({ message, priceSignal: { asking_price: null }, now: new Date(typeof now === "number" ? now : Date.parse(now)).toISOString() }).facts || {};
  const update_years = extractUpdateYears(message, { now });
  const prior_uc = lower(prior_template_use_case);
  const kf = known_facts || {};

  const ownership_known = OWNERSHIP_YES.has(lower(kf.ownership_status)) || kf.ownership_confirmed === true;
  const ownership_turn =
    OWNERSHIP_TURN_INTENTS.has(intent) ||
    (stage === V3_STAGES.S1 && (v2_intent === V2_INTENTS.AFFIRMATIVE || v2_intent === V2_INTENTS.INTEREST)) ||
    lower(facts.ownership?.value?.status || facts.ownership?.value?.ownership_status) === "owner";
  // Every later question was asked only after ownership (and interest) were answered.
  // A seller volunteering the house's condition / occupancy / price is speaking
  // as the owner side ("Central air and heat" to "do you own …?").
  const volunteers_property_facts =
    CONDITION_TURN_INTENTS.has(intent) || OCCUPANCY_TURN_INTENTS.has(intent) || num(asking_price_this_turn) != null;
  const ownership =
    ownership_known || ownership_turn || volunteers_property_facts || stageAtLeast(stage, V3_STAGES.S2) || INTEREST_TURN_INTENTS.has(intent);

  const interest_known = ["interested", "conditional", "yes"].includes(lower(kf.interest)) || kf.seller_interested === true;
  const interest_turn =
    INTEREST_TURN_INTENTS.has(intent) ||
    (stage === V3_STAGES.S2 && [V2_INTENTS.AFFIRMATIVE, V2_INTENTS.INTEREST, V2_INTENTS.CONDITIONAL_INTEREST].includes(v2_intent)) ||
    [V2_INTENTS.OFFER_REQUEST, V2_INTENTS.NO_PRICE, V2_INTENTS.PRICE_GIVEN, V2_INTENTS.CONDITIONAL_INTEREST].includes(v2_intent) ||
    Boolean(facts.seller_interest || facts.offer_interest);
  const interest = interest_known || interest_turn || stageAtLeast(stage, V3_STAGES.S3);

  const ask_now = num(asking_price_this_turn);
  const ask_known = knownAsk(kf);
  const price_declined =
    ["asking_price_absent", "asks_offer"].includes(intent) ||
    [V2_INTENTS.NO_PRICE, V2_INTENTS.OFFER_REQUEST].includes(v2_intent) ||
    kf.asking_price_declined === true ||
    // We already moved past the price question without one ("I can run my numbers").
    [lower(U.NO_PRICE_CONDITION), lower(U.CONDITION_CLARIFIER)].includes(prior_uc) && ask_known == null;
  const ask = ask_now ?? ask_known;

  const condition_known =
    kf.condition_disclosed === true || Boolean(clean(kf.condition_level)) || Boolean(kf.repairs_needed != null && kf.repairs_needed !== "");
  const condition_turn =
    CONDITION_TURN_INTENTS.has(intent) ||
    v2_intent === V2_INTENTS.CONDITION_ANSWER ||
    Boolean(facts.condition || facts.repairs) ||
    update_years.length > 0;
  const condition = condition_known || condition_turn;

  const occupancy_value =
    clean(facts.occupancy?.value?.occupancy_status) ||
    clean(kf.occupancy_status) ||
    (OCCUPANCY_TURN_INTENTS.has(intent) ? "tenant_occupied" : "");
  const occupancy = Boolean(occupancy_value) && !["unknown", "null"].includes(lower(occupancy_value));

  return {
    ownership: { collected: ownership, source: ownership_known ? "known_facts" : ownership_turn ? "this_turn" : ownership ? "implied_by_stage" : null },
    interest: { collected: interest, source: interest_known ? "known_facts" : interest_turn ? "this_turn" : interest ? "implied_by_stage" : null },
    asking_price: {
      collected: ask != null || price_declined,
      value: ask,
      declined: ask == null && price_declined,
      source: ask_now != null ? "this_turn" : ask_known != null ? "known_facts" : price_declined ? "seller_declined_to_price" : null,
    },
    condition: {
      collected: condition,
      level: clean(facts.condition?.value?.condition_level) || clean(kf.condition_level) || null,
      repairs: facts.repairs?.value || null,
      update_years,
      source: condition_known ? "known_facts" : condition_turn ? "this_turn" : null,
    },
    occupancy: { collected: occupancy, value: occupancy ? occupancy_value : null, source: occupancy ? (facts.occupancy ? "this_turn" : "known_facts") : null },
  };
}

export function missingChecklist(checklist = {}) {
  return CHECKLIST_FIELDS.filter((k) => !checklist?.[k]?.collected);
}

/** The ONE question for the first missing field (SFR). */
const QUESTION_FOR = Object.freeze({
  // Mid-thread the ownership question is the placeholder-free re-ask; the
  // first-touch ownership_check rows carry {{property_address}} / agent name.
  ownership: [U.REASK_OWNERSHIP, U.OWNERSHIP],
  interest: [U.INTEREST, U.INTEREST_FOLLOW_UP],
  asking_price: [U.ASK_PRICE, U.ASK_PRICE_FOLLOW_UP],
  condition: [U.CONDITION_CLARIFIER],
  // price_works_confirm_basics is not used: its prod rows (active, NOT safe)
  // mix occupancy and condition questions.
  occupancy: [U.OCCUPANCY],
});

/** Persistable facts patch (known_facts) for what this turn collected. */
export function checklistFactsPatch(checklist = {}) {
  const patch = {};
  if (checklist.ownership?.source === "this_turn") patch.ownership_status = "confirmed";
  if (checklist.interest?.source === "this_turn") patch.interest = "interested";
  if (checklist.asking_price?.declined && checklist.asking_price.source === "seller_declined_to_price") patch.asking_price_declined = true;
  if (checklist.condition?.source === "this_turn") {
    patch.condition_disclosed = true;
    if (checklist.condition.level) patch.condition_level = checklist.condition.level;
    if (checklist.condition.update_years?.length) {
      patch.update_years = Object.fromEntries(checklist.condition.update_years.map((f) => [f.component, f.year]));
    }
  }
  if (checklist.occupancy?.source === "this_turn" && checklist.occupancy.value) patch.occupancy_status = checklist.occupancy.value;
  return patch;
}

// ══════════════════════════════════════════════════════════════════════════
// VALUE AUTHORITY (authoritative Decision Engine, guarded by offer-sanity)
// ══════════════════════════════════════════════════════════════════════════

/**
 * The value the price branches compare against: valuation_mid from the
 * authoritative property_acquisition_scores snapshot. Trusted only when the
 * snapshot is current-policy, fresh, not a compact backfill row, and passes the
 * offer-sanity guard. Otherwise untrusted → the machine still asks condition,
 * with no number talk.
 */
export function resolveV3ValueAuthority({ ade_snapshot = null, now = Date.now() } = {}) {
  if (!ade_snapshot) return { trusted: false, reason: "no_engine_snapshot", value: null };
  const value = num(ade_snapshot.valuation_mid);
  if (value == null || value <= 0) return { trusted: false, reason: "valuation_mid_missing", value: null };
  if (ade_snapshot?.evidence?.backfill?.monetary_authority === false || ade_snapshot?.evidence_mode === "compact") {
    return { trusted: false, reason: "compact_backfill_row", value };
  }
  const nowMs = typeof now === "number" ? now : Date.parse(now);
  const computed = Date.parse(ade_snapshot.computed_at || ade_snapshot.created_at || "");
  if (!Number.isFinite(computed) || computed < Date.parse(OFFER_POLICY_EPOCH)) return { trusted: false, reason: "predates_offer_policy", value };
  if (nowMs - computed > OFFER_READY_MAX_AGE_DAYS * 86_400_000) return { trusted: false, reason: "stale_snapshot", value };
  const sanity = evaluateScoreOfferSanity(ade_snapshot);
  if (!sanity.sane) return { trusted: false, reason: `offer_sanity:${sanity.reasons.join("|")}`, value, sanity };
  return {
    trusted: true,
    reason: "engine_value_sane",
    value,
    snapshot_id: ade_snapshot?.evidence?.immutable_snapshot_id ?? ade_snapshot?.id ?? null,
    computed_at: new Date(computed).toISOString(),
    engine_version: ade_snapshot?.evidence?.engine?.version ?? null,
  };
}

export const PRICE_BRANCHES = Object.freeze({
  FAR_ABOVE: "far_above_value",
  NEAR: "near_value",
  BELOW: "below_value",
  NO_VALUE: "no_trusted_value",
});

/** SFR price vs value. */
export function classifyPriceAgainstValue(ask, value, config = V3_CONFIG) {
  const a = num(ask);
  const v = num(value);
  if (a == null || v == null || v <= 0) return { branch: PRICE_BRANCHES.NO_VALUE, ratio: null };
  const ratio = Math.round((a / v) * 100) / 100;
  if (a > v * config.far_above_ratio || a > v + config.far_above_delta) return { branch: PRICE_BRANCHES.FAR_ABOVE, ratio };
  if (a < v * config.below_value_fraction) return { branch: PRICE_BRANCHES.BELOW, ratio };
  return { branch: PRICE_BRANCHES.NEAR, ratio };
}

// ══════════════════════════════════════════════════════════════════════════
// MULTIFAMILY — price per door
// ══════════════════════════════════════════════════════════════════════════

const MF_TYPE_RE = /multi|duplex|triplex|fourplex|quadplex|apartment|2-4|5\+/i;

export function resolveUnitCount({ property_metadata = {}, ade_snapshot = null } = {}) {
  const units = num(
    property_metadata?.unit_count ?? property_metadata?.units_count ?? ade_snapshot?.evidence?.subject?.normalized_features?.units,
  );
  const type = clean(property_metadata?.property_type);
  const family = lower(ade_snapshot?.evidence?.subject?.asset_family || ade_snapshot?.evidence?.subject?.asset_type);
  const multifamily = (units != null && units > 1) || MF_TYPE_RE.test(type) || family === "multifamily";
  return { multifamily, units: units != null && units > 1 ? units : null };
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * "Similar buildings nearby are trading between $X–$Y a door." From real MF
 * sales (v_recent_sold_comps, units >= 2): price / units, within the MF radius
 * and age, outliers dropped (< 0.5× or > 2× the median door price), off-market
 * (public record) sales preferred. X–Y = P25–P75, floored to $5K. Capped at the
 * authoritative MAO per door when one exists; never quoted without the guard.
 */
export function computePerDoorAnchor({ comps = [], units = null, mao = null, now = Date.now(), rules = V3_CONFIG.mf } = {}) {
  const nowMs = typeof now === "number" ? now : Date.parse(now);
  const excluded = [];
  const eligible = [];
  for (const c of Array.isArray(comps) ? comps : []) {
    const price = num(c?.sale_price);
    const u = num(c?.units_count ?? c?.units);
    const dist = num(c?.distance_miles);
    const t = Date.parse(c?.sale_date || "");
    const id = clean(c?.id || c?.comp_id || c?.property_id) || null;
    const reasons = [];
    if (u == null || u < 2) reasons.push("not_multifamily");
    if (price == null || (u && price / u < rules.min_door_price)) reasons.push("invalid_sale_price");
    if (dist == null) reasons.push("unknown_distance");
    else if (dist > rules.radius_miles) reasons.push("outside_mf_radius");
    if (!Number.isFinite(t)) reasons.push("unknown_sale_date");
    else if ((nowMs - t) / (86_400_000 * 30.44) > rules.max_age_months) reasons.push("sale_too_old");
    if (reasons.length) excluded.push({ id, reasons });
    else eligible.push({ id, door: price / u, units: u, distance_miles: dist, sale_date: c.sale_date, source: lower(c?.sale_source) });
  }
  let pool = eligible;
  let source_rule = "all_sales";
  if (rules.prefer_off_market) {
    const off = eligible.filter((c) => !c.source.includes("mls"));
    if (off.length >= rules.min_comps) {
      pool = off;
      source_rule = "off_market_public_record";
    }
  }
  if (pool.length < rules.min_comps) return { ok: false, reason: "v3_hold_mf_insufficient_door_comps", eligible_count: pool.length, excluded };
  const median = quantile([...pool.map((c) => c.door)].sort((a, b) => a - b), 0.5);
  const kept = pool.filter((c) => c.door >= median * rules.outlier_fraction_of_median && c.door <= median * rules.outlier_multiple_of_median);
  if (kept.length < rules.min_comps) return { ok: false, reason: "v3_hold_mf_insufficient_non_outlier_comps", eligible_count: kept.length, excluded };
  const doors = kept.map((c) => c.door).sort((a, b) => a - b);
  const floor = (v) => Math.floor(v / rules.round_step) * rules.round_step;
  let low = floor(quantile(doors, 0.25));
  let high = floor(quantile(doors, 0.75));
  const u = num(units);
  const cap = num(mao) != null && u ? floor(num(mao) / u) : null;
  let capped = false;
  if (cap != null && high > cap) {
    high = cap;
    capped = true;
    if (low > high) low = high;
  }
  if (!(low > 0) || !(high > 0)) return { ok: false, reason: "v3_hold_mf_anchor_not_positive", excluded };
  if (low === high) low = Math.max(rules.round_step, high - rules.round_step);
  return {
    ok: true,
    per_door_low: low,
    per_door_high: high,
    median_door: Math.round(median),
    capped_at_mao_per_door: capped,
    mao_per_door: cap,
    units: u,
    comp_ids: kept.map((c) => c.id),
    comp_doors: kept.map((c) => Math.round(c.door)),
    source_rule,
    eligible_count: kept.length,
    excluded,
    rules,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// TEXT GUARDS (rules only)
// ══════════════════════════════════════════════════════════════════════════

/** A real legal threat keeps the human lane; insults alone are archived. */
const LEGAL_THREAT_RE =
  /\b(?:attorney|lawyer|lawsuit|sue|suing|legal\s+action|cease\s+and\s+desist|harass(?:ing|ment)?|report(?:ing)?\s+(?:you|this)|fcc|ftc|tcpa|attorney\s+general|police)\b|\babogad[oa]\b|\bdemand(?:a|ar)\b/i;
const PHONE_IN_TEXT_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;
/** "Call 555-0199 and talk to Charles", "my dad's number is …": a referral with a number. */
const REFERRAL_LANGUAGE_RE =
  /\b(?:call|text|talk\s+to|reach|contact|number\s+is|his|her|their|son|daughter|husband|wife|dad|father|mom|mother|brother|sister|owner|manager)\b|\b(?:llame|hable\s+con|su\s+n[uú]mero|mi\s+(?:esposo|esposa|hijo|hija|pap[aá]|mam[aá]))\b/i;
/** "This is his son", "this number is for her daughter": someone else is answering. */
const THIRD_PARTY_SPEAKER_RE =
  /\bthis\s+is\s+(?:his|her|their|the\s+owner'?s)\s+(?:son|daughter|wife|husband|brother|sister|grandson|granddaughter|caretaker|manager)\b|\b(?:this\s+is\s+)?(?:the\s+)?number\s+(?:is\s+)?for\s+(?:his|her|their)\s+(?:son|daughter|wife|husband|family)\b|\bsoy\s+(?:su|el|la)\s+(?:hijo|hija|esposo|esposa)\b/i;
/** "No, I'm not" / "Not me" to "are you the owner?" — the bare-No family. */
const NOT_OWNER_SHORT_RE = /^\s*(?:no+|nope|nah)?[\s,.!]*(?:i'?m|i\s+am)\s+not(?:\s+the\s+owner)?[\s.!]*$|^\s*not\s+me[\s.!]*$|^\s*no+\s*,?\s*not\s+me[\s.!]*$/i;
/** A sign-off is not a question to answer ("Have a great day", "Take care"). */
const SIGN_OFF_RE =
  /^\s*(?:have\s+a\s+(?:great|good|nice|blessed)\s+(?:day|night|evening|weekend|one)|take\s+care|bye|good\s*bye|god\s+bless|you\s+too|same\s+to\s+you|que\s+(?:tenga|le\s+vaya)\s+bien|buen\s+d[ií]a|bendiciones)[\s.!🙂😊🙏]*$/iu;

export function isLegalThreat(message = "") {
  return LEGAL_THREAT_RE.test(String(message || ""));
}

// ══════════════════════════════════════════════════════════════════════════
// REPEAT GUARD
// ══════════════════════════════════════════════════════════════════════════

function recentUseCases(conversation_context = null, recent_outbound = []) {
  const list = (Array.isArray(recent_outbound) ? recent_outbound : [])
    .map((r) => lower(r?.use_case ?? r?.template_use_case))
    .filter(Boolean);
  const last = lower(conversation_context?.last_outbound_template_use_case);
  if (last && list[0] !== last) list.unshift(last);
  return list;
}

/**
 * Never the identical text twice in a row: drop any preferred use case that
 * was our LAST outbound, and carry the recent template ids / bodies so the
 * selector can skip them. An empty preference means "nothing new to say".
 */
export function applyRepeatGuard(preference = [], { conversation_context = null, recent_outbound = [] } = {}) {
  const used = recentUseCases(conversation_context, recent_outbound);
  const last = used[0] || null;
  const filtered = preference.filter((uc) => lower(uc) !== last);
  return {
    preference: filtered,
    dropped: preference.filter((uc) => lower(uc) === last),
    avoid_template_ids: (Array.isArray(recent_outbound) ? recent_outbound : []).map((r) => clean(r?.template_id)).filter(Boolean),
    avoid_bodies: [clean(conversation_context?.last_outbound_body), ...(recent_outbound || []).map((r) => clean(r?.body))].filter(Boolean),
  };
}

// ══════════════════════════════════════════════════════════════════════════
// THE PLANNER
// ══════════════════════════════════════════════════════════════════════════

export const V3_ACTIONS = Object.freeze({
  REPLY: "reply",
  TERMINAL: "terminal",
  DEFER: "defer", // an existing automatic lane owns it (compliance, nurture, v2 money, S5+ engine)
  REVIEW: "review", // legal threat, or a money guard at S4+
});

/** Classifier intents an existing automatic lane already answers correctly. */
const EXISTING_LANE = Object.freeze({
  opt_out: V3_TERMINAL.SUPPRESS,
  wrong_number: V3_TERMINAL.WRONG_NUMBER,
  wrong_person: V3_TERMINAL.WRONG_NUMBER,
  not_interested: V3_TERMINAL.NURTURE,
  need_time: V3_TERMINAL.NURTURE,
});

const NON_OWNER_INTENTS = new Set(["non_owner_referral", "property_specific_non_owner", "non_owner", "executor_heir_respondent"]);
const CLOSED_PROPERTY_INTENTS = new Set(["sold_property", "property_sold", "former_owner_respondent", "tenant_respondent"]);

function base(plan_input) {
  return { version: SELLER_CONVERSATION_V3_VERSION, ...plan_input };
}
function reply(b, preference, reason, extra = {}) {
  return { ...b, action: V3_ACTIONS.REPLY, template_use_case: preference[0], template_preference: preference, reasoning_code: reason, review: false, alert: false, ...extra };
}
function terminal(b, action, reason, extra = {}) {
  return { ...b, action: V3_ACTIONS.TERMINAL, terminal_action: action, inbox_bucket: TERMINAL_BUCKET[action] ?? null, reasoning_code: reason, review: false, alert: false, ...extra };
}
function defer(b, lane, reason, extra = {}) {
  return { ...b, action: V3_ACTIONS.DEFER, lane, reasoning_code: reason, review: false, ...extra };
}
function review(b, reason, extra = {}) {
  return { ...b, action: V3_ACTIONS.REVIEW, review_reason: reason, reasoning_code: reason, review: true, ...extra };
}

/** After the repeat guard: reply with what is left, or close the thread for the stage. */
function guardedReply(b, preference, reason, ctx, extra = {}) {
  const guard = applyRepeatGuard(preference, ctx);
  if (!guard.preference.length) {
    return isEarlyStage(b.stage)
      ? terminal(b, V3_TERMINAL.ARCHIVE, `${reason}:repeat_guard_exhausted`, { repeat_guard: guard })
      : terminal(b, V3_TERMINAL.NURTURE, `${reason}:repeat_guard_exhausted`, { repeat_guard: guard });
  }
  return reply(b, guard.preference, reason, { repeat_guard: guard, ...extra });
}

const REASK_FOR_STAGE = Object.freeze({
  [V3_STAGES.S1]: [U.REASK_OWNERSHIP],
  [V3_STAGES.S2]: [U.REASK_INTEREST, U.INTEREST_FOLLOW_UP],
  // asking_price_follow_up ("Just so I understood the number right…") only
  // answers a number (executor NUMBER_PRESUMING_USE_CASES); without one the
  // re-ask is the plain price question, then "I can run the numbers".
  [V3_STAGES.S3]: [U.ASK_PRICE_FOLLOW_UP, U.ASK_PRICE, U.NO_PRICE_CONDITION],
  [V3_STAGES.S4]: [U.REPAIR_CLARIFICATION, U.CONDITION_CLARIFIER],
  [V3_STAGES.S4_BASICS]: [U.OCCUPANCY],
  [V3_STAGES.UNKNOWN]: [U.REASK_OWNERSHIP],
});

const WHO_FIRST_FOR_STAGE = Object.freeze({
  // Owner wording: "I'm a local investor simply reaching out about the
  // property — are you open to a proposal?" = who_is_this (active + safe EN/ES).
  [V3_STAGES.S1]: [U.WHO, U.WHO_S1],
  [V3_STAGES.S2]: [U.WHO],
  [V3_STAGES.S3]: [U.WHO_S3, U.WHO],
  [V3_STAGES.S4]: [U.WHO_S4, U.WHO],
  [V3_STAGES.S4_BASICS]: [U.WHO],
  [V3_STAGES.UNKNOWN]: [U.WHO],
  [V3_STAGES.BEYOND]: [U.WHO],
});

/**
 * Plan one seller turn. Inputs are already-computed facts from the live path;
 * the planner adds no I/O.
 *
 * @param {object} p
 * @param {object} p.classification       classifier verdict (after the v2 overlay)
 * @param {string} p.message
 * @param {object} p.conversation_context conversation_context_v1
 * @param {string} p.stage_before         persisted lifecycle stage
 * @param {object} p.known_facts          deal_state.known_facts
 * @param {number|null} p.asking_price_this_turn committed (one money path)
 * @param {object|null} p.v2_plan          planSellerAutopilotV2() for the same turn
 * @param {object|null} p.offer_authority  resolveV2OfferAuthority()
 * @param {object|null} p.value_authority  resolveV3ValueAuthority()
 * @param {object} p.property_metadata    { property_type, unit_count }
 * @param {object|null} p.ade_snapshot
 * @param {Array} p.mf_door_comps          MF sales for the per-door anchor (loader)
 * @param {Array} p.recent_outbound        [{ use_case, template_id, body }], newest first
 */
export function planSellerConversationV3({
  classification = null,
  message = "",
  conversation_context = null,
  stage_before = null,
  known_facts = {},
  asking_price_this_turn = null,
  v2_plan = null,
  offer_authority = null,
  value_authority = null,
  property_metadata = {},
  ade_snapshot = null,
  mf_door_comps = [],
  recent_outbound = [],
  config = V3_CONFIG,
  now = Date.now(),
} = {}) {
  const stage_info = resolveV3Stage({ conversation_context, stage_before });
  const stage = stage_info.stage;
  const thread_language = conversation_context?.last_outbound_language || null;
  const prior_uc = clean(conversation_context?.last_outbound_template_use_case) || null;
  const v2 =
    classification?.seller_autopilot_v2?.v2_intent
      ? { intent: classification.seller_autopilot_v2.v2_intent, source: classification.seller_autopilot_v2.rule_id }
      : resolveV2Intent({ classification, message, stage, thread_language, prior_template_use_case: prior_uc });
  // Identity answers to the one-time clarifier are read fresh (the overlay leaves them).
  const fresh = resolveV2Intent({ classification, message, stage, thread_language, prior_template_use_case: prior_uc });
  const v2_intent = [V2_INTENTS.IDENTITY_STATEMENT, V2_INTENTS.BARE_NO_AFTER_CLARIFIER].includes(fresh.intent) ? fresh.intent : v2.intent;
  const intent = lower(classification?.primary_intent) || "unclear";
  const rule_ids = Array.isArray(classification?.matched_rule_ids) ? classification.matched_rule_ids.map(lower) : [];

  const checklist = deriveChecklist({
    known_facts,
    stage,
    classification,
    v2_intent,
    message,
    asking_price_this_turn,
    prior_template_use_case: prior_uc,
    now,
  });
  const missing = missingChecklist(checklist);
  const used = recentUseCases(conversation_context, recent_outbound);
  const ctx = { conversation_context, recent_outbound, used_use_cases: used };
  const b = base({
    stage,
    stage_source: stage_info.source,
    classifier_intent: intent,
    v2_intent,
    checklist,
    missing,
    facts_patch: checklistFactsPatch(checklist),
    known_update_years: known_facts?.update_years || {},
    price_branch: null,
    monetary: null,
  });

  // ── 1. compliance + existing automatic lanes ────────────────────────────
  if (clean(classification?.compliance_flag) === "stop_texting" || intent === "opt_out") {
    return defer(b, V3_TERMINAL.SUPPRESS, "v3_opt_out_suppressed_silently", { terminal_action: V3_TERMINAL.SUPPRESS });
  }
  if (intent === "hostile_or_legal" || v2_intent === V2_INTENTS.HOSTILE_LEGAL) {
    if (isLegalThreat(message)) return review(b, "v3_review_legal_threat");
    return terminal(b, V3_TERMINAL.ARCHIVE, "v3_hostile_archived_no_reply");
  }
  if (intent === "hostile_or_troll") return terminal(b, V3_TERMINAL.ARCHIVE, "v3_troll_archived_no_reply");
  if (v2_intent === V2_INTENTS.CAPITAL_GAINS) {
    return guardedReply(b, [U.CAPITAL_GAINS], "v3_capital_gains_creative_probe", ctx);
  }
  if (intent === "not_interested" && isCompoundOpportunity(classification)) {
    // "Not selling this one, but I'm selling two parcels…": no review (owner
    // rule); 30-day nurture with the opportunity stamped for the follow-up.
    return terminal(b, V3_TERMINAL.NURTURE, "v3_decline_with_new_property_opportunity_nurture", {
      new_property_opportunity: { address_signals: classification?.address_signals || [], intents: classification?.matched_intents || [] },
    });
  }
  if (EXISTING_LANE[intent]) {
    return defer(b, EXISTING_LANE[intent], `v3_existing_lane_${intent}`, { terminal_action: EXISTING_LANE[intent] });
  }

  // ── 2. relationship intents → automatic dispositions ────────────────────
  if (CLOSED_PROPERTY_INTENTS.has(intent) || v2_intent === V2_INTENTS.SOLD_FORMER_OWNER) {
    return terminal(b, V3_TERMINAL.ARCHIVE_PROPERTY, "v3_sold_or_not_owner_archived");
  }
  if (v2_intent === V2_INTENTS.IDENTITY_STATEMENT) {
    const kind = fresh.identity_kind;
    if (kind === "entity_owner") return guardedReply(b, [U.INTEREST], "v3_entity_owner_continue_interest", ctx);
    if (kind === "occupant") return terminal(b, V3_TERMINAL.ARCHIVE_PROPERTY, "v3_occupant_not_owner_archived");
    return guardedReply(b, [U.REFERRAL_BEST_CONTACT], `v3_identity_${kind}_ask_best_contact`, ctx);
  }
  if (v2_intent === V2_INTENTS.BARE_NO_AFTER_CLARIFIER) return terminal(b, V3_TERMINAL.ARCHIVE, "v3_second_no_after_clarifier_archived");
  if (v2_intent === V2_INTENTS.BARE_NO_OWNERSHIP) {
    if (used.includes(lower(U.OWNERSHIP_CLARIFIER))) return terminal(b, V3_TERMINAL.ARCHIVE, "v3_bare_no_clarifier_already_sent");
    return guardedReply(b, [U.OWNERSHIP_CLARIFIER], "v3_bare_no_ownership_clarifier_once", ctx);
  }
  if (isEarlyStage(stage) && intent === "unclear" && NOT_OWNER_SHORT_RE.test(message)) {
    if (used.includes(lower(U.OWNERSHIP_CLARIFIER))) return terminal(b, V3_TERMINAL.ARCHIVE, "v3_not_owner_after_clarifier_archived");
    return guardedReply(b, [U.OWNERSHIP_CLARIFIER], "v3_not_owner_short_clarifier_once", ctx);
  }
  if (intent === "unclear" && PHONE_IN_TEXT_RE.test(message) && REFERRAL_LANGUAGE_RE.test(message)) {
    return terminal(b, V3_TERMINAL.REFERRAL_CAPTURE, "v3_referral_number_captured");
  }
  if (intent === "unclear" && THIRD_PARTY_SPEAKER_RE.test(message)) {
    if (used.includes(lower(U.REFERRAL_BEST_CONTACT))) return terminal(b, V3_TERMINAL.ARCHIVE_PROPERTY, "v3_referral_asked_once_archived");
    return guardedReply(b, [U.REFERRAL_BEST_CONTACT], "v3_third_party_speaker_ask_best_contact", ctx);
  }
  if (NON_OWNER_INTENTS.has(intent) || v2_intent === V2_INTENTS.REFERRAL || v2_intent === V2_INTENTS.NON_OWNER) {
    if (PHONE_IN_TEXT_RE.test(message)) return terminal(b, V3_TERMINAL.REFERRAL_CAPTURE, "v3_referral_number_captured");
    if (used.includes(lower(U.REFERRAL_BEST_CONTACT))) return terminal(b, V3_TERMINAL.ARCHIVE_PROPERTY, "v3_referral_asked_once_archived");
    return guardedReply(b, [U.REFERRAL_BEST_CONTACT], "v3_referral_ask_best_contact", ctx);
  }
  if (v2_intent === V2_INTENTS.TRUST_EXECUTOR || ["trust_ownership", "llc_corporation"].includes(intent)) {
    // The owner side speaking for an entity / trust / estate: keep the checklist moving.
    return nextChecklistQuestion(b, checklist, missing, ctx, "v3_entity_or_trust_owner");
  }
  if (["title_issue", "lien_tax_issue", "bankruptcy_disclosed"].includes(intent) || v2_intent === V2_INTENTS.ENTITY_LEGAL) {
    // A disclosure, not a threat: note it (facts) and keep collecting.
    return nextChecklistQuestion(b, checklist, missing, ctx, `v3_disclosure_${intent}_continue`);
  }
  if (["already_listed", "going_to_market"].includes(intent) || v2_intent === V2_INTENTS.LISTED) {
    if (used.includes(lower(U.ALREADY_LISTED))) return terminal(b, V3_TERMINAL.NURTURE, "v3_listed_nurture");
    return guardedReply(b, [U.ALREADY_LISTED], "v3_listed_ack_then_nurture", ctx, { then: V3_TERMINAL.NURTURE });
  }
  if (["callback_requested", "voicemail_call_request", "needs_call", "requests_email"].includes(intent) || v2_intent === V2_INTENTS.CALLBACK) {
    if (used.includes(lower(U.TEXT_ONLY))) return nextChecklistQuestion(b, checklist, missing, ctx, "v3_callback_again_continue_checklist");
    return guardedReply(b, [U.TEXT_ONLY], "v3_callback_text_only_redirect", ctx);
  }
  if (intent === "property_correction") return terminal(b, V3_TERMINAL.ARCHIVE_PROPERTY, "v3_property_correction_archived");
  if (intent === "contract_requested" || stage === V3_STAGES.BEYOND) {
    if (WHO_USE_CASES.has(lower(intent)) || v2_intent === V2_INTENTS.WHO_WHY) return whoLoop(b, used, ctx);
    return defer(b, "negotiation_engine", "v3_s5_plus_negotiation_engine");
  }

  // ── 3. who / why / how'd you get my number ──────────────────────────────
  if (v2_intent === V2_INTENTS.WHO_WHY || ["who_is_this", "info_request", "how_got_number"].includes(intent)) {
    return whoLoop(b, used, ctx);
  }

  // ── 4. frustration / implausible / unreadable ───────────────────────────
  if (rule_ids.includes("seller_frustration_after_misread")) {
    return guardedReply(b, [U.FRUSTRATION_APOLOGY], "v3_frustration_apology_then_nurture", ctx, { then: V3_TERMINAL.NURTURE });
  }
  if (intent === "asking_price_implausible") {
    if (used.some((u) => FAR_ABOVE_USE_CASES.has(u))) return terminal(b, V3_TERMINAL.ARCHIVE, "v3_second_implausible_ask_archived");
    return guardedReply(b, [U.FAR_ABOVE_NURTURE], "v3_implausible_ask_serious_offer_nurture", ctx, {
      price_branch: PRICE_BRANCHES.FAR_ABOVE,
      then: V3_TERMINAL.NURTURE,
    });
  }
  if (intent === "unclear" && (!clean(message) || SIGN_OFF_RE.test(message))) {
    return terminal(b, V3_TERMINAL.WAIT, "v3_sign_off_or_empty_no_reply");
  }
  if (["acknowledgement", "reaction_only"].includes(intent) && v2_intent !== V2_INTENTS.AFFIRMATIVE && v2_intent !== V2_INTENTS.CONDITION_ANSWER) {
    return terminal(b, V3_TERMINAL.WAIT, "v3_acknowledgement_no_reply");
  }
  if (intent === "language_switch" || v2_intent === V2_INTENTS.LANGUAGE_SWITCH) {
    // Same question, in the language asked for (the reply language is resolved upstream).
    const q = isEarlyStage(stage) ? (missing[0] ? QUESTION_FOR[missing[0]] : [U.INTEREST]) : REASK_FOR_STAGE[stage] || [U.INTEREST];
    return reply(b, q, "v3_language_switch_same_question");
  }

  const understood =
    !["unclear", "ok", ""].includes(intent) ||
    [V2_INTENTS.AFFIRMATIVE, V2_INTENTS.INTEREST, V2_INTENTS.CONDITIONAL_INTEREST, V2_INTENTS.PRICE_GIVEN, V2_INTENTS.NO_PRICE, V2_INTENTS.OFFER_REQUEST, V2_INTENTS.CONDITION_ANSWER].includes(v2_intent);
  const answered_this_turn = CHECKLIST_FIELDS.some((k) => checklist[k]?.source === "this_turn");
  if (!understood && !answered_this_turn) {
    const reasked = used[0] && REASK_USE_CASES.has(used[0]);
    if (reasked) {
      return isEarlyStage(stage)
        ? terminal(b, V3_TERMINAL.ARCHIVE, "v3_unclear_after_reask_archived")
        : terminal(b, V3_TERMINAL.NURTURE, "v3_unclear_after_reask_nurture");
    }
    const reask = (REASK_FOR_STAGE[stage] || REASK_FOR_STAGE[V3_STAGES.UNKNOWN]).filter(
      (uc) => uc !== U.ASK_PRICE_FOLLOW_UP || /\d/.test(String(message || "")),
    );
    return guardedReply(b, reask, "v3_unclear_reask_once", ctx);
  }

  // ── 5. price vs value, then the checklist ───────────────────────────────
  return priceAndChecklist(b, {
    checklist,
    missing,
    ctx,
    v2_plan,
    offer_authority,
    value_authority,
    property_metadata,
    ade_snapshot,
    mf_door_comps,
    config,
    now,
  });
}

const COMPOUND_POSITIVE = new Set(["seller_interested", "latent_interest", "asks_offer", "asking_price_provided"]);
/** Mirrors the executor's compound-opportunity signal (a decline + a positive second clause or another address). */
function isCompoundOpportunity(classification = {}) {
  const intents = [...(classification?.matched_intents || []), ...(classification?.secondary_intents || [])];
  const positive = intents.some((i) => COMPOUND_POSITIVE.has(i));
  const addresses = Array.isArray(classification?.address_signals) ? classification.address_signals : [];
  return positive || addresses.some((a) => a?.confidence === "high") || (positive && addresses.length > 0);
}

function whoLoop(b, used, ctx) {
  const answered = used.filter((u) => WHO_USE_CASES.has(u)).length;
  if (answered >= V3_CONFIG.who_answer_limit) return terminal(b, V3_TERMINAL.ARCHIVE, "v3_who_asked_again_archived");
  const preference = answered === 0
    ? WHO_FIRST_FOR_STAGE[b.stage] || [U.WHO]
    : [U.INFO_SOURCE, U.WHO_VARIANT];
  return guardedReply(b, preference, answered === 0 ? "v3_who_local_investor_then_resume" : "v3_who_second_answer_different_text", ctx, {
    resume_stage: b.stage,
  });
}

function nextChecklistQuestion(b, checklist, missing, ctx, reason) {
  const next = missing[0];
  if (!next) return defer(b, "negotiation_engine", `${reason}:checklist_complete`);
  return guardedReply(b, QUESTION_FOR[next], `${reason}:ask_${next}`, ctx, { asking_for: next });
}

function priceAndChecklist(b, { checklist, missing, ctx, v2_plan, offer_authority, value_authority, property_metadata, ade_snapshot, mf_door_comps, config, now }) {
  const ask = checklist.asking_price.value;
  const { multifamily, units } = resolveUnitCount({ property_metadata, ade_snapshot });
  const asked_this_turn = checklist.asking_price.source === "this_turn";

  // Ownership / interest / price: plain checklist questions.
  if (!checklist.ownership.collected) return nextChecklistQuestion(b, checklist, missing, ctx, "v3_checklist");
  if (!checklist.interest.collected) return nextChecklistQuestion(b, checklist, missing, ctx, "v3_checklist");
  if (!checklist.asking_price.collected) return nextChecklistQuestion(b, checklist, missing, ctx, "v3_checklist");

  // ── MULTIFAMILY: per-door ───────────────────────────────────────────────
  if (multifamily) {
    const mb = { ...b, asset: "multifamily", units };
    if (!units) return guardedReply(mb, [U.MF_CONFIRM_UNITS], "v3_mf_confirm_units", ctx);
    if (!checklist.condition.collected) return guardedReply(mb, [U.CONDITION_CLARIFIER], "v3_mf_ask_condition", ctx, { asking_for: "condition" });
    if (!checklist.occupancy.collected) return guardedReply(mb, [U.MF_OCCUPANCY, U.OCCUPANCY], "v3_mf_ask_occupancy", ctx, { asking_for: "occupancy" });
    const mao = offer_authority?.mao ?? null;
    const anchor = computePerDoorAnchor({ comps: mf_door_comps, units, mao, now, rules: config.mf });
    if (!anchor.ok) return review(mb, anchor.reason, { mf_anchor: anchor, stage_gate: "s4_plus" });
    if (mao == null) return review(mb, "v3_hold_mf_no_authoritative_mao", { mf_anchor: anchor, stage_gate: "s4_plus" });
    return guardedReply(mb, [U.MF_PER_DOOR_ANCHOR], "v3_mf_per_door_anchor", ctx, {
      monetary: {
        kind: "negotiation_anchor_per_door",
        per_door_low: anchor.per_door_low,
        per_door_high: anchor.per_door_high,
        units,
        total_high: anchor.per_door_high * units,
        ceiling: mao,
        comp_ids: anchor.comp_ids,
        rule: anchor.source_rule,
      },
      mf_anchor: anchor,
      render_overrides: { per_door_low: anchor.per_door_low, per_door_high: anchor.per_door_high },
    });
  }

  // ── SFR: price vs value ─────────────────────────────────────────────────
  const value = value_authority?.trusted ? value_authority.value : null;
  const verdict = ask != null ? classifyPriceAgainstValue(ask, value, config) : { branch: null, ratio: null };
  const sb = { ...b, asset: "single_family", price_branch: verdict.branch, price_ratio: verdict.ratio, value_authority: value_authority || null };

  if (verdict.branch === PRICE_BRANCHES.FAR_ABOVE) {
    // Never entertain it: no condition ask, a polite "when you're serious" → nurture.
    if (!asked_this_turn && ctx.conversation_context && FAR_ABOVE_USE_CASES.has(lower(ctx.conversation_context.last_outbound_template_use_case))) {
      return terminal(sb, V3_TERMINAL.NURTURE, "v3_far_above_already_answered_nurture");
    }
    return guardedReply(sb, [U.FAR_ABOVE_NURTURE], "v3_far_above_value_serious_offer_nurture", ctx, { then: V3_TERMINAL.NURTURE });
  }

  const need_condition = !checklist.condition.collected;
  const need_occupancy = !checklist.occupancy.collected;
  // A generic condition answer ("good shape", "it's updated") gets ONE
  // update-year follow-up (kitchen / baths / roof); never twice, never when the
  // years were already given or the house plainly needs heavy work.
  const ask_update_years =
    !need_condition &&
    checklist.condition.source === "this_turn" &&
    !checklist.condition.update_years?.length &&
    !Object.keys(b.known_update_years || {}).length &&
    !ctx.used_use_cases?.includes(lower(U.UPDATE_YEARS)) &&
    !/poor|distress|heavy|major|gut/i.test(checklist.condition.level || "") &&
    !checklist.condition.repairs;
  if (ask_update_years && verdict.branch !== PRICE_BRANCHES.FAR_ABOVE) {
    return guardedReply(sb, [U.UPDATE_YEARS], "v3_condition_update_year_follow_up", ctx, { asking_for: "update_years" });
  }
  if (verdict.branch === PRICE_BRANCHES.BELOW) {
    if (need_condition && need_occupancy) return guardedReply(sb, [U.BELOW_VALUE_BASICS, U.CONDITION_CLARIFIER], "v3_below_value_condition_and_occupancy", ctx, { asking_for: "condition+occupancy" });
    if (need_condition) return guardedReply(sb, [U.CONDITION_CLARIFIER], "v3_below_value_condition", ctx, { asking_for: "condition" });
    if (need_occupancy) return guardedReply(sb, [U.OCCUPANCY], "v3_below_value_occupancy", ctx, { asking_for: "occupancy" });
    return offerPath(sb, { v2_plan, offer_authority, ctx, now });
  }
  if (verdict.branch === PRICE_BRANCHES.NEAR) {
    if (need_condition) return guardedReply(sb, [U.CONDITION_NEAR_VALUE, U.CONDITION_CLARIFIER], "v3_near_value_condition", ctx, { asking_for: "condition" });
    if (need_occupancy) return guardedReply(sb, [U.OCCUPANCY], "v3_near_value_occupancy", ctx, { asking_for: "occupancy" });
    return offerPath(sb, { v2_plan, offer_authority, ctx, now });
  }

  // No price (declined) or no trusted value: condition, no number talk.
  if (need_condition) {
    const pref = checklist.asking_price.declined
      ? [U.NO_PRICE_CONDITION, U.CONDITION_CLARIFIER]
      : [U.CONDITION_NEAR_VALUE, U.CONDITION_CLARIFIER];
    return guardedReply(sb, pref, checklist.asking_price.declined ? "v3_no_price_condition" : "v3_no_trusted_value_condition", ctx, { asking_for: "condition" });
  }
  if (need_occupancy) return guardedReply(sb, [U.OCCUPANCY], "v3_checklist_occupancy", ctx, { asking_for: "occupancy" });
  return offerPath(sb, { v2_plan, offer_authority, ctx, now });
}

/**
 * Checklist complete (SFR): the v2 money step (as-is anchor / above-max /
 * confirm basics, MAO-capped, quote-logged) when the authoritative offer is
 * ready; otherwise "running the numbers" (no number) and the thread waits for
 * the engine. A guard failure at this point (S4+) is the only money review.
 */
function offerPath(b, { v2_plan, offer_authority, ctx, now }) {
  if (v2_plan?.action === "reply" && v2_plan.monetary) {
    return guardedReply(b, v2_plan.template_preference, `v3_offer_path:${v2_plan.reasoning_code}`, ctx, {
      monetary: v2_plan.monetary,
      authority: v2_plan.authority || null,
      v2_plan,
    });
  }
  if (offer_authority?.ok) {
    const anchor = computeAsIsAnchor({ comps: offer_authority.comps, mao: offer_authority.mao, now });
    const offer_version = {
      snapshot_id: offer_authority.snapshot_id,
      computed_at: offer_authority.computed_at,
      engine_version: offer_authority.engine_version,
      decision_tier: offer_authority.decision_tier,
      recommended_offer: offer_authority.offer,
    };
    if (!anchor.ok) return review(b, anchor.reason, { anchor, stage_gate: "s4_plus" });
    const above_max = anchor.capped_at_mao;
    const amount = above_max ? roundAnchorDown(Math.min(offer_authority.offer, offer_authority.mao)) : anchor.amount;
    if (amount == null || amount <= 0 || amount > offer_authority.mao) return review(b, "v3_hold_offer_above_guard", { stage_gate: "s4_plus" });
    return guardedReply(b, [above_max ? U.ANCHOR_ABOVE_MAX : U.ANCHOR_COMPS], above_max ? "v3_offer_path_above_max" : "v3_offer_path_as_is_anchor", ctx, {
      monetary: {
        kind: "negotiation_anchor",
        amount,
        ceiling: offer_authority.mao,
        rule: above_max ? "above_max" : anchor.rule,
        capped_at_mao: above_max,
        raw_comp_value: anchor.raw_comp_value,
        comp_ids: anchor.comp_ids,
        comp_prices: anchor.comp_prices,
        median: anchor.median,
        offer_version,
      },
      authority: { offer: offer_authority.offer, mao: offer_authority.mao, snapshot_id: offer_authority.snapshot_id },
    });
  }
  if (lower(ctx.conversation_context?.last_outbound_template_use_case) === lower(U.NUMBERS_PENDING)) {
    return terminal(b, V3_TERMINAL.WAIT, "v3_numbers_pending_already_sent_wait_for_engine");
  }
  return guardedReply(b, [U.NUMBERS_PENDING], "v3_checklist_complete_numbers_pending", ctx, {
    hold_note: offer_authority?.reason || "no_offer_authority",
  });
}

// ══════════════════════════════════════════════════════════════════════════
// EXECUTION (translate a plan into the executor's existing vocabulary)
// ══════════════════════════════════════════════════════════════════════════

/**
 * Plan → { classification, strategyDirective, dealAuthorityPatch }.
 *   reply    → an exact-preference immediate-send directive (the v2 shape);
 *              the classifier review verdict is lifted for THIS answer only.
 *   terminal → no reply, no human review, no alert; the inbox bucket rides on
 *              classification.seller_conversation_v3.inbox_bucket.
 *   defer    → nothing changes (the existing lane / v2 / engine decides).
 *   review   → a review directive with the reason (legal threat / money guard).
 * Every executor gate (suppression, language enablement, render, quote log,
 * auto_reply_mode) still runs after this.
 */
export function applySellerConversationV3(classification = null, plan = null) {
  if (!plan || !classification || typeof classification !== "object") {
    return { classification, strategyDirective: null, dealAuthorityPatch: null, applied: false };
  }
  const stamp = {
    version: plan.version,
    action: plan.action,
    stage: plan.stage,
    reasoning_code: plan.reasoning_code,
    terminal_action: plan.terminal_action || plan.then || null,
    inbox_bucket: plan.action === V3_ACTIONS.TERMINAL ? plan.inbox_bucket : plan.then ? TERMINAL_BUCKET[plan.then] ?? null : null,
    missing: plan.missing,
    price_branch: plan.price_branch,
    facts_patch: plan.facts_patch,
  };
  if (plan.action === V3_ACTIONS.DEFER) {
    return { classification: { ...classification, seller_conversation_v3: stamp }, strategyDirective: null, dealAuthorityPatch: null, applied: false };
  }
  if (plan.action === V3_ACTIONS.REVIEW) {
    return {
      classification: { ...classification, seller_conversation_v3: stamp },
      strategyDirective: {
        strategy: "seller_conversation_v3",
        reason_code: plan.reasoning_code,
        review_required: true,
        review_reason: plan.review_reason,
        v2_plan: plan,
      },
      dealAuthorityPatch: null,
      applied: true,
    };
  }
  if (plan.action === V3_ACTIONS.TERMINAL) {
    return {
      classification: {
        ...classification,
        automation_decision: {
          ...(classification.automation_decision || {}),
          auto_reply_allowed: false,
          human_review_required: false,
          queue_action: "none",
          // Owner 2026-10-06: suppression is a contact-permission state
          // (opt-out / do-not-text / wrong number), never an emotion. An
          // archived insult stays contactable by future campaigns.
          suppression_action: "none",
          decided_by: "seller_conversation_v3_rules",
          v3_terminal_action: plan.terminal_action,
        },
        needs_review: false,
        seller_conversation_v3: stamp,
      },
      strategyDirective: null,
      dealAuthorityPatch: null,
      applied: true,
    };
  }
  const monetary = plan.monetary || null;
  const single_amount = monetary && num(monetary.amount) != null;
  return {
    classification: {
      ...classification,
      automation_decision: {
        ...(classification.automation_decision || {}),
        auto_reply_allowed: true,
        human_review_required: false,
        decided_by: "seller_conversation_v3_rules",
      },
      needs_review: false,
      seller_conversation_v3: stamp,
    },
    strategyDirective: {
      strategy: "seller_conversation_v3",
      reason_code: plan.reasoning_code,
      template_use_case: plan.template_use_case,
      allowed_template_use_cases: plan.template_preference,
      template_preference: plan.template_preference,
      review_required: false,
      next_action: "send_message_now",
      monetary_amount: single_amount ? monetary.amount : null,
      avoid_template_ids: plan.repeat_guard?.avoid_template_ids || [],
      render_overrides: plan.render_overrides || null,
      v2_plan: plan,
    },
    dealAuthorityPatch: single_amount
      ? { authorized_offer_amount: monetary.amount, authorized_offer_ceiling: monetary.ceiling, v2_anchor_evidence: monetary }
      : null,
    applied: true,
  };
}

/**
 * Executor hook (applyInboundAutomationDecision): when the v3 plan for this
 * turn is a TERMINAL (archive / nurture / wait / referral capture), the turn
 * neither replies nor goes to a person — whatever the intent profile alone
 * would have said. Suppression (opt-out / wrong number) is never touched:
 * compliance decisions pass through unchanged. Flag-gated; a no-op otherwise.
 */
export function applySellerConversationV3TerminalDecision(decision = null, classification = null, env = process.env) {
  const stamp = classification?.seller_conversation_v3;
  if (!decision || !stamp || stamp.action !== V3_ACTIONS.TERMINAL) return decision;
  if (!isSellerConversationV3Active(env)) return decision;
  if (decision.should_suppress_contact) return decision;
  return {
    ...decision,
    should_queue_reply: false,
    should_mark_human_review: false,
    reply_mode: "none",
    human_review_reason: null,
    next_action: `v3_${stamp.terminal_action || "terminal"}`,
    audit_reason: stamp.reasoning_code || decision.audit_reason,
    seller_conversation_v3: stamp,
  };
}

/** Coarse outcome class for coverage reporting. */
export function summarizeV3Outcome(plan = null) {
  if (!plan) return "none";
  if (plan.action === V3_ACTIONS.REPLY) return "auto_reply";
  if (plan.action === V3_ACTIONS.TERMINAL) return "auto_terminal";
  if (plan.action === V3_ACTIONS.REVIEW) return "review";
  return `defer:${plan.lane}`;
}

export default planSellerConversationV3;
