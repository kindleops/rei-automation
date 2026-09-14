/**
 * assertion-contract.js
 *
 * THE FOUR LAYERS, AND WHY COLLAPSING THEM IS THE WHOLE RISK.
 *
 *   A  EVIDENCE    what the seller actually wrote. Immutable.
 *                  "I'd probably take 185 if you close in two weeks."
 *   B  ASSERTION   a structured statement extracted from that evidence.
 *                  { seller_price_expectation, 185000, basis: explicit }
 *   C  CANONICAL   operational state, accepted only through reconciliation.
 *                  current seller price expectation = $185,000
 *   D  AUTHORITY   whether Reivesti may act. EMAIL-4 leaves this at NONE.
 *
 * Each boundary is a place where a mistake changes character. Evidence that is
 * wrong is a transcription bug. An assertion that is wrong is a misreading. A
 * canonical state that is wrong is a deal negotiated against a false belief. An
 * authority that is wrong is an offer nobody authorised.
 *
 * The layers exist so that a misreading cannot become a false belief without
 * passing a policy that is allowed to say no.
 *
 * ── WHAT THIS MODULE IS ────────────────────────────────────────────────────
 *
 * The shape of layer B, and nothing else. It is pure, has no I/O, and knows
 * nothing about channels, models or storage. Everything downstream -- the
 * extractor, the ledger, the reconciler, EMAIL-5 -- agrees on this shape or
 * does not interoperate.
 *
 * ── WHY BASIS IS A FIRST-CLASS FIELD RATHER THAN A CONFIDENCE NUMBER ───────
 *
 * A confidence of 0.9 says how sure the extractor is. It does not say what KIND
 * of thing it is sure about, and those are different questions:
 *
 *   explicit          the seller said it.        "The property is vacant."
 *   strongly_implied  the seller described
 *                     circumstances that make
 *                     it very likely.            "Nobody's lived there since
 *                                                 Mom passed."
 *   inferred          we interpreted.            "I'm sick of those tenants."
 *                                                 -> landlord fatigue
 *
 * A confident inference and a confident quotation are not interchangeable, and
 * the difference matters most in exactly the place it is easiest to lose: an
 * operator reading a deal summary must never see an inference rendered as
 * something the seller said. Reconciliation is correspondingly stricter as
 * basis moves away from explicit.
 */

import { asObject } from "@/lib/hostile-input.js";
import {
  INBOUND_INTENT_ONTOLOGY,
  normalizeToCanonicalIntent,
  ONTOLOGY_VERSION,
} from "@/lib/domain/classification/inbound-intent-ontology.js";

export const ASSERTION_CONTRACT_VERSION = "seller_assertion_v1";

/** Layer D. EMAIL-4 never produces anything else. EMAIL-5 owns action. */
export const ACTION_AUTHORITY = Object.freeze({
  NONE: "none",
});

export const ASSERTION_BASIS = Object.freeze({
  EXPLICIT: "explicit",
  STRONGLY_IMPLIED: "strongly_implied",
  INFERRED: "inferred",
});

/** Ordered strongest-first. Used by reconciliation; never reorder casually. */
export const BASIS_STRENGTH = Object.freeze([
  ASSERTION_BASIS.EXPLICIT,
  ASSERTION_BASIS.STRONGLY_IMPLIED,
  ASSERTION_BASIS.INFERRED,
]);

export function basisRank(basis) {
  const index = BASIS_STRENGTH.indexOf(String(basis ?? "").trim());
  // An unrecognised basis ranks below everything known rather than above it.
  return index === -1 ? BASIS_STRENGTH.length : index;
}

/**
 * FACT FAMILIES. Not a flat list, because conflict semantics differ by family
 * and §16 forbids a generic "latest row wins".
 *
 *   temporal      the seller can change their mind; the newest explicit
 *                 statement is the current one. (price, timing)
 *   mutable_state the world can change underneath the seller. (occupancy)
 *   preference    an instruction about us, not a fact about the property.
 *   claim         a statement about authority that we record and never treat
 *                 as verified. (ownership, executor)
 *   historical    an event that happened; it does not stop being true, and it
 *                 must never be overwritten as though it were current state.
 *   interpretive  our reading of them, not their statement. (motivation)
 */
export const FACT_FAMILY = Object.freeze({
  TEMPORAL: "temporal",
  MUTABLE_STATE: "mutable_state",
  PREFERENCE: "preference",
  CLAIM: "claim",
  HISTORICAL: "historical",
  INTERPRETIVE: "interpretive",
});

/**
 * The assertion types EMAIL-4 can produce, each bound to its family.
 *
 * A type absent from here cannot be asserted at all -- the extractor's output
 * is validated against this map, so a model that invents
 * `seller_definitely_wants_to_sell` produces a rejected assertion rather than a
 * new kind of canonical fact.
 */
export const ASSERTION_TYPE = Object.freeze({
  // ── economics (temporal: a seller may revise a number) ──────────────────
  seller_price_expectation: FACT_FAMILY.TEMPORAL,
  seller_counter_price: FACT_FAMILY.TEMPORAL,
  seller_minimum_price: FACT_FAMILY.TEMPORAL,
  seller_desired_net_proceeds: FACT_FAMILY.TEMPORAL,
  mortgage_balance_claim: FACT_FAMILY.CLAIM,
  lien_amount_claim: FACT_FAMILY.CLAIM,
  tax_amount_claim: FACT_FAMILY.CLAIM,
  payoff_amount_claim: FACT_FAMILY.CLAIM,
  // A number someone ELSE offered. Deliberately its own type: it is not our
  // seller's price expectation, and treating it as one would let a seller move
  // our floor by reporting a rumour.
  competing_offer_claim: FACT_FAMILY.CLAIM,

  // ── timing ──────────────────────────────────────────────────────────────
  desired_closing_date: FACT_FAMILY.TEMPORAL,
  close_before_date: FACT_FAMILY.TEMPORAL,
  close_after_date: FACT_FAMILY.TEMPORAL,
  closing_window: FACT_FAMILY.TEMPORAL,
  callback_requested_at: FACT_FAMILY.TEMPORAL,
  follow_up_requested_at: FACT_FAMILY.TEMPORAL,
  urgency: FACT_FAMILY.INTERPRETIVE,

  // ── property state (the world can change) ───────────────────────────────
  occupancy_status: FACT_FAMILY.MUTABLE_STATE,
  tenant_status: FACT_FAMILY.MUTABLE_STATE,
  property_condition: FACT_FAMILY.MUTABLE_STATE,
  repair_needed: FACT_FAMILY.MUTABLE_STATE,
  damage_reported: FACT_FAMILY.MUTABLE_STATE,
  access_constraint: FACT_FAMILY.MUTABLE_STATE,
  showing_availability: FACT_FAMILY.TEMPORAL,

  // ── authority: CLAIMS, always. Never verification. ──────────────────────
  ownership_claim: FACT_FAMILY.CLAIM,
  co_ownership_claim: FACT_FAMILY.CLAIM,
  heir_claim: FACT_FAMILY.CLAIM,
  executor_claim: FACT_FAMILY.CLAIM,
  administrator_claim: FACT_FAMILY.CLAIM,
  trustee_claim: FACT_FAMILY.CLAIM,
  family_representative_claim: FACT_FAMILY.CLAIM,
  agent_claim: FACT_FAMILY.CLAIM,
  other_decision_maker_claim: FACT_FAMILY.CLAIM,
  ownership_denial: FACT_FAMILY.CLAIM,

  // ── circumstance. An EVENT is historical; a READING of it is interpretive.
  probate_context: FACT_FAMILY.HISTORICAL,
  inheritance_context: FACT_FAMILY.HISTORICAL,
  divorce_or_separation_context: FACT_FAMILY.HISTORICAL,
  relocation_context: FACT_FAMILY.HISTORICAL,
  financial_pressure_context: FACT_FAMILY.HISTORICAL,
  seller_motivation: FACT_FAMILY.INTERPRETIVE,

  // ── communication preferences ───────────────────────────────────────────
  channel_preference: FACT_FAMILY.PREFERENCE,
  channel_restriction: FACT_FAMILY.PREFERENCE,
  preferred_contact_time: FACT_FAMILY.PREFERENCE,

  // ── objections ──────────────────────────────────────────────────────────
  objection: FACT_FAMILY.INTERPRETIVE,

  // ── listing / disposal status ───────────────────────────────────────────
  already_sold_claim: FACT_FAMILY.CLAIM,
  listed_with_agent_claim: FACT_FAMILY.CLAIM,
});

export const ASSERTION_TYPE_LIST = Object.freeze(Object.keys(ASSERTION_TYPE));

export function familyOf(assertion_type) {
  return ASSERTION_TYPE[String(assertion_type ?? "").trim()] || null;
}

export function isKnownAssertionType(value) {
  return Object.prototype.hasOwnProperty.call(ASSERTION_TYPE, String(value ?? "").trim());
}

/**
 * Types whose value is money, and which therefore must carry a currency and an
 * amount that survived the deterministic money validator. The model proposes a
 * reading; it never gets to declare a number legitimate.
 */
export const MONETARY_ASSERTION_TYPES = Object.freeze(new Set([
  "seller_price_expectation", "seller_counter_price", "seller_minimum_price",
  "seller_desired_net_proceeds", "mortgage_balance_claim", "lien_amount_claim",
  "tax_amount_claim", "payoff_amount_claim", "competing_offer_claim",
]));

/**
 * Types that are CLAIMS ABOUT AUTHORITY. Recording one never rewrites a
 * verified record, and nothing downstream may read one as proof.
 *
 * "My sister and I own it" is a claim. Title says what it says.
 */
export const AUTHORITY_CLAIM_TYPES = Object.freeze(new Set([
  "ownership_claim", "co_ownership_claim", "heir_claim", "executor_claim",
  "administrator_claim", "trustee_claim", "family_representative_claim",
  "agent_claim", "other_decision_maker_claim", "ownership_denial",
]));

/**
 * ── SELLER INTENT: BORROWED, NOT INVENTED ──────────────────────────────────
 *
 * inbound-intent-ontology.js is the canonical vocabulary for what an inbound
 * seller message can mean, is load-time enforced against the live classifier's
 * exported label list, and carries per-intent reply policy, state hints and
 * compliance semantics that EMAIL-4 has no business restating.
 *
 * So EMAIL-4 defines NO intent enum. This map records how the concepts this
 * phase must handle land on that vocabulary, and a test asserts every target
 * still exists -- so if a slug is renamed there, this fails rather than
 * silently folding to "unclear".
 */
export const EMAIL4_INTENT_COVERAGE = Object.freeze({
  interested: "interested",
  wants_offer: "requests_offer",
  asks_price: "asks_price",
  provides_asking_price: "gives_asking_price",
  counteroffer: "price_negotiation",
  accepts_terms: "contract_request",
  rejects_offer: "price_negotiation",
  not_interested: "not_interested",
  maybe_later: "follow_up_later",
  already_sold: "sold_property",
  property_listed: "already_listed",
  wrong_owner: "not_owner",
  wrong_property: "property_correction",
  agent_or_representative: "agent_represents_owner",
  inherited_or_probate: "probate_estate",
  occupancy_issue: "occupancy_disclosure",
  tenant_issue: "tenant_issue",
  condition_issue: "condition_disclosure",
  title_issue: "title_issue",
  mortgage_or_lien_issue: "lien_tax_issue",
  closing_timeline_question: "timeline_negotiation",
  closing_timeline_requirement: "timeline_negotiation",
  requests_call: "requests_call",
  requests_email: "requests_email",
  requests_contract: "contract_request",
  asks_question: "info_request",
  unsubscribe: "opt_out",
  hostile: "hostile",
  legal_sensitive: "bankruptcy",
  ambiguous: "unclear",
});

/**
 * Concepts §7 names that the canonical ontology does NOT currently carry.
 *
 * Named here rather than quietly dropped, and rather than invented as EMAIL-4
 * slugs. The ontology owns its own vocabulary and already supports naming a
 * meaning before a detector exists for it; adding these belongs to whoever owns
 * that registry, not to this phase.
 *
 * Until then an inbound message expressing one of these folds to its nearest
 * canonical intent and, where it matters operationally, still produces a
 * structured ASSERTION -- which is the layer that actually carries the fact.
 */
export const EMAIL4_INTENT_GAPS = Object.freeze({
  wholesaler_or_intermediary:
    "No canonical slug. Folds to agent_involved, which loses that the sender is reselling rather than representing the owner.",
  requests_sms:
    "requests_call and requests_email exist; the SMS counterpart does not. The channel_preference ASSERTION carries it meanwhile.",
  requests_credentials:
    "No canonical slug for a seller asking for proof-of-funds or licensing. Folds to info_request.",
  provides_document:
    "No canonical slug. EMAIL-3 records the attachment; no intent names the act of sending one.",
});

/** Every intent slug this phase depends on still existing. */
export function verifyIntentCoverage() {
  const missing = [];
  for (const [concept, slug] of Object.entries(EMAIL4_INTENT_COVERAGE)) {
    if (!Object.prototype.hasOwnProperty.call(INBOUND_INTENT_ONTOLOGY, slug)) {
      missing.push(`${concept} -> ${slug}`);
    }
  }
  return { ok: missing.length === 0, missing, ontology_version: ONTOLOGY_VERSION };
}

/**
 * Build one assertion, or refuse.
 *
 * REFUSAL IS A RESULT, not an exception. This runs over model output, and model
 * output is untrusted: an unknown type, an absurd number or a missing evidence
 * span must produce something the caller can record and count, not a throw that
 * loses the whole extraction because one field was wrong.
 *
 * @returns {{ok:true, assertion:object}|{ok:false, reason:string, detail?:string}}
 */
export function buildAssertion(raw_input) {
  const input = asObject(raw_input);
  const assertion_type = String(input.type ?? input.assertion_type ?? "").trim();

  if (!isKnownAssertionType(assertion_type)) {
    return { ok: false, reason: "unknown_assertion_type", detail: assertion_type || "(empty)" };
  }

  const basis = String(input.basis ?? "").trim();
  if (!BASIS_STRENGTH.includes(basis)) {
    // No default. A missing basis is the extractor failing to say whether the
    // seller stated this or we inferred it, and guessing "explicit" would turn
    // an inference into a quotation.
    return { ok: false, reason: "invalid_basis", detail: basis || "(empty)" };
  }

  const evidence = String(input.evidence ?? "").trim();
  if (!evidence) {
    // Every assertion must be traceable to the exact words that produced it.
    // One with no evidence cannot be reviewed, disputed, or explained to an
    // operator who asks "where does it say that?".
    return { ok: false, reason: "missing_evidence" };
  }

  // `Number(null)` and `Number("")` are both 0, so a MISSING confidence would
  // otherwise read as "zero confidence" -- and `undefined` would be refused
  // while `null` sailed through, which is the same missing value behaving two
  // ways. A field that was never set is malformed, not unconfident.
  const raw_confidence = input.confidence;
  if (typeof raw_confidence !== "number") {
    return { ok: false, reason: "invalid_confidence", detail: `${typeof raw_confidence}` };
  }
  if (!Number.isFinite(raw_confidence) || raw_confidence < 0 || raw_confidence > 1) {
    return { ok: false, reason: "invalid_confidence", detail: String(raw_confidence) };
  }
  const confidence = raw_confidence;

  const family = familyOf(assertion_type);

  return {
    ok: true,
    assertion: {
      type: assertion_type,
      family,
      basis,
      confidence,
      value: input.value ?? null,
      raw_value: input.raw_value ?? null,
      evidence,
      // Conditions travel WITH the assertion. "185 if you close before the
      // 20th" is one fact, and flattening it to "185" is how a condition the
      // seller made material disappears before anyone negotiates.
      conditions: Array.isArray(input.conditions) ? input.conditions : [],
      is_authority_claim: AUTHORITY_CLAIM_TYPES.has(assertion_type),
      is_monetary: MONETARY_ASSERTION_TYPES.has(assertion_type),
      contract_version: ASSERTION_CONTRACT_VERSION,
    },
  };
}

/** Fold any classifier label onto the canonical vocabulary. Never invents one. */
export function canonicalIntent(label) {
  return normalizeToCanonicalIntent(label);
}

export default buildAssertion;
