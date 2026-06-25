// ─── canonical-intent-aliases.js ─────────────────────────────────────────
// SINGLE canonical inbound-intent vocabulary for Stages 1–6.
//
// Background (Stages 1–6 audit): three divergent intent vocabularies existed
// across the codebase:
//   1. classify.js INTENT_PRIORITY (LIVE)      → wrong_number, asking_price_provided,
//                                                 condition_disclosed, tenant_occupied
//   2. deterministic-stage-map.js / safety     → wrong_person, asking_price_value,
//      -policy.js (DIAGNOSTIC + stage engines)    condition_signal, tenant_or_occupancy
//   3. automation/intentMap.js (DEAD/ISOLATED) → wrong_number + needs_review dead-end
//
// Because (1) and (2) used different names, the deterministic safety policy
// silently MISSED the live classifier intents and fell through to REVIEW.
//
// This module is the one place that reconciles them. Everything that maps an
// intent onto routing / suppression / safety should normalize through
// `normalizeCanonicalIntent` first so the vocabulary can never drift again.

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

// Canonical intent names — aligned to the LIVE classify.js INTENT_PRIORITY set,
// which is the production source of truth.
export const CANONICAL_INTENTS = Object.freeze([
  "opt_out",
  "wrong_number",
  "who_is_this",
  "hostile_or_legal",
  "not_interested",
  "need_time",
  "seller_interested",
  "asking_price_provided",
  "asks_offer",
  "callback_requested",
  "property_correction",
  "ownership_confirmed",
  "latent_interest",
  "tenant_occupied",
  "condition_disclosed",
  "info_request",
  "reaction_only",
  "acknowledgement",
  "unclear",
  "non_owner_referral",
  "property_specific_non_owner",
  "tenant_respondent",
  "former_owner_respondent",
  "property_manager_respondent",
  "agent_representative_respondent",
  "co_owner_respondent",
  "executor_heir_respondent",
  "entity_representative_respondent",
]);

const CANONICAL_INTENT_SET = new Set(CANONICAL_INTENTS);

// Alias map: every legacy / divergent / human-readable label → canonical name.
// wrong_person is intentionally folded onto wrong_number for SUPPRESSION
// behavior (both must suppress the phone number and never advance lifecycle),
// while the distinct identity nuance is preserved separately via
// resolveContactIdentityClass() in contact-identity.js.
const INTENT_ALIASES = Object.freeze({
  // ── wrong number / wrong person unification ──────────────────────────────
  wrong_person: "wrong_number",
  "wrong person": "wrong_number",
  "wrong number": "wrong_number",
  wrong_num: "wrong_number",
  non_owner_referral: "non_owner_referral",
  property_specific_non_owner: "property_specific_non_owner",
  never_been_owner: "property_specific_non_owner",
  not_the_owner: "property_specific_non_owner",
  no_longer_owner: "former_owner_respondent",
  former_owner: "former_owner_respondent",

  // ── opt-out / DNC ─────────────────────────────────────────────────────────
  stop: "opt_out",
  unsubscribe: "opt_out",
  dnc: "opt_out",
  do_not_contact: "opt_out",
  opted_out: "opt_out",
  stop_texting: "opt_out",

  // ── asking-price vocabulary drift (safety-policy vs classifier) ──────────
  asking_price_value: "asking_price_provided",
  asking_price: "asking_price_provided",
  price_given: "asking_price_provided",
  seller_asking_price: "asking_price_provided",

  // ── condition vocabulary drift ───────────────────────────────────────────
  condition_signal: "condition_disclosed",
  condition_mentioned: "condition_disclosed",

  // ── tenant / occupancy vocabulary drift ──────────────────────────────────
  tenant_or_occupancy: "tenant_occupied",
  occupancy: "tenant_occupied",
  occupant: "tenant_occupied",
  renter: "tenant_occupied",
  renter_occupant: "tenant_occupied",

  // ── seller interest synonyms ──────────────────────────────────────────────
  interested: "seller_interested",
  open_to_offer: "seller_interested",
  open_to_selling: "seller_interested",
  property_interest: "seller_interested",

  // ── ownership synonyms ────────────────────────────────────────────────────
  "ownership confirmed": "ownership_confirmed",
  "ownership confirmation": "ownership_confirmed",
  owner_confirmed: "ownership_confirmed",

  // ── timing / callback ─────────────────────────────────────────────────────
  not_ready: "need_time",
  text_me_later: "need_time",
  needs_call: "callback_requested",
  needs_email: "callback_requested",
  wants_call: "callback_requested",

  // ── identity / info ───────────────────────────────────────────────────────
  who_is_this_: "who_is_this",
  how_got_number: "info_request",
  info_source: "info_request",

  // ── hostility / legal ─────────────────────────────────────────────────────
  hostile: "hostile_or_legal",
  legal: "hostile_or_legal",
  attorney: "hostile_or_legal",
  harassment: "hostile_or_legal",

  // ── listed / unavailable folds onto not_interested for routing ───────────
  listed_or_unavailable: "not_interested",
  already_sold: "wrong_number",
  under_contract: "not_interested",
  listed_with_agent: "not_interested",

  // ── ack / reaction ────────────────────────────────────────────────────────
  ack: "acknowledgement",
  reaction: "reaction_only",
  emoji_only: "reaction_only",
});

/**
 * Normalize ANY raw intent label (legacy, divergent, or human-readable) into the
 * single canonical vocabulary. Unknown labels collapse to "unclear" so the
 * downstream coverage net always has a defined process for them.
 */
export function normalizeCanonicalIntent(raw = null) {
  const value = lower(raw);
  if (!value) return "unclear";
  if (CANONICAL_INTENT_SET.has(value)) return value;
  if (INTENT_ALIASES[value]) return INTENT_ALIASES[value];

  // snake-case fold of free text (e.g. "Wrong Person!" → "wrong_person")
  const folded = value.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (CANONICAL_INTENT_SET.has(folded)) return folded;
  if (INTENT_ALIASES[folded]) return INTENT_ALIASES[folded];

  return "unclear";
}

// Intents that MUST suppress further outreach to the phone number and never
// advance the lifecycle, regardless of stage. wrong_person ≡ wrong_number here.
export const SUPPRESSION_INTENTS = Object.freeze(new Set(["opt_out", "wrong_number"]));

export function isSuppressionIntent(raw = null) {
  return SUPPRESSION_INTENTS.has(normalizeCanonicalIntent(raw));
}

// Intents that require a defined human/compliance workflow (never a bare reply).
export const COMPLIANCE_HOLD_INTENTS = Object.freeze(new Set(["hostile_or_legal"]));

export function isComplianceHoldIntent(raw = null) {
  return COMPLIANCE_HOLD_INTENTS.has(normalizeCanonicalIntent(raw));
}

export function isCanonicalIntent(value = null) {
  return CANONICAL_INTENT_SET.has(lower(value));
}

export default {
  CANONICAL_INTENTS,
  SUPPRESSION_INTENTS,
  COMPLIANCE_HOLD_INTENTS,
  normalizeCanonicalIntent,
  isSuppressionIntent,
  isComplianceHoldIntent,
  isCanonicalIntent,
};
