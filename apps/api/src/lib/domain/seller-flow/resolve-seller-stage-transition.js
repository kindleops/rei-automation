// ─── resolve-seller-stage-transition.js ─────────────────────────────────────
// Canonical deterministic stage-transition resolver for the S1–S10 seller
// lifecycle. The classifier/LLM layer supplies intents, extracted facts,
// sentiment and confidence; ONLY this resolver decides lifecycle state.
//
// Invariants:
//   • Stage is the next unresolved lifecycle milestone.
//   • Stage advancement is monotonic — stage_after is never below stage_before.
//   • A single message may advance multiple stages when it resolves multiple
//     milestones (e.g. price + condition in one reply).
//   • Status, disposition, temperature and contactability move independently
//     of lifecycle stage and never regress it.
//   • Exactly one next_action is returned for every resolution.
//
// This module is pure (no I/O) so every transition is unit-testable.

import {
  LIFECYCLE_STAGE_CODES,
  LIFECYCLE_STAGE_ORDER,
  LEAD_TEMPERATURE_CODES,
  OPERATIONAL_STATUS_CODES,
  DISPOSITION_CODES,
  CONTACTABILITY_CODES,
  normalizeLifecycleStage,
  normalizeLeadTemperature,
} from "@/lib/domain/lead-state/universal-lead-state-registry.js";
import { ACQUISITION_LIFECYCLE_EVENTS } from "@/lib/domain/seller-flow/acquisition-lifecycle-events.js";
import { resolveSellerAuthorityState } from "@/lib/domain/seller-flow/seller-authority-state.js";
import {
  STAGE3_OFFER_BANDS,
  resolveStage3Route,
  resolveCreativeAllowed,
} from "@/lib/domain/seller-flow/stage3-asking-price-engine.js";
import { hasRevealedOffer } from "@/lib/domain/seller-flow/negotiation-state.js";

export const TRANSITION_RESOLVER_VERSION = "seller_stage_transition_v2_authority_gated";

/**
 * Stage index of the first offer-bearing lifecycle stage (S5 `offer`). The
 * authority gate and listing/agent gate cap advancement below this index
 * whenever canonical policy withholds automated offer progression.
 */
const OFFER_STAGE_IDX = 4;

/** Template use cases that reveal or finalize an offer. */
const OFFER_TEMPLATE_USE_CASES = new Set([
  "offer_reveal_cash",
  "initial_offer",
  "conditional_offer",
  "counter_offer",
  "final_offer",
]);

/**
 * Canonical listing/agent statuses that divert off direct-owner automated
 * offer progression (mirrors Stage 2 LISTED_WITH_AGENT / AGENT_OR_REALTOR
 * policy: listed_backup + review, not GENERATE_OFFER).
 */
const LISTING_BLOCKS_AUTOMATED_OFFER = new Set([
  "listed_with_agent",
  "agent_involved",
]);

/**
 * Whether durable listing/agent facts require the listed-backup / review path
 * instead of automated direct-owner offer progression.
 * Reuses Stage 2 outcomes: listed_with_agent, agent_or_realtor_involved.
 */
export function listingBlocksAutomatedOffer(facts = {}) {
  return LISTING_BLOCKS_AUTOMATED_OFFER.has(lower(facts?.listing_status));
}

/** Canonical next-action vocabulary (spec §9 — exactly one per state change). */
export const NEXT_ACTIONS = Object.freeze({
  SEND_MESSAGE_NOW: "send_message_now",
  WAIT_FOR_SELLER: "wait_for_seller",
  SCHEDULE_FOLLOW_UP: "schedule_follow_up",
  EXECUTE_ADE: "execute_ade",
  GENERATE_OFFER: "generate_offer",
  NEGOTIATE: "negotiate",
  GENERATE_CONTRACT: "generate_contract",
  AWAIT_SIGNATURE: "await_signature",
  START_DISPOSITION: "start_disposition",
  RESOLVE_CLOSING_BLOCKER: "resolve_closing_blocker",
  CLOSE: "close",
  HUMAN_REVIEW: "human_review",
  NO_ACTION_CONTACT_BLOCKED: "no_action_contact_blocked",
});

export const ADE_ACTIONS = Object.freeze({
  NONE: "none",
  RUN_PRELIMINARY: "run_preliminary",
  RUN_FULL: "run_full",
  RERUN_MATERIAL_FACTS: "rerun_material_facts",
});

const STAGE_INDEX = new Map(LIFECYCLE_STAGE_ORDER.map((code, i) => [code, i]));
const TEMP_RANK = { unscored: 0, cold: 1, warm: 2, hot: 3 };

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function stageIdx(code) {
  return STAGE_INDEX.get(normalizeLifecycleStage(code)) ?? 0;
}

function stageAt(idx) {
  return LIFECYCLE_STAGE_ORDER[Math.min(Math.max(idx, 0), LIFECYCLE_STAGE_ORDER.length - 1)];
}

function stageShort(code) {
  return `S${stageIdx(code) + 1}`;
}

function addDaysIso(now, days) {
  const d = new Date(now || Date.now());
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

// ─── Fact model ──────────────────────────────────────────────────────────────

/**
 * Seller-LEVEL intents whose very form answers "are you the seller?".
 * A bare occupancy/condition disclosure is deliberately absent: a tenant or
 * neighbour can state those about a property they do not own.
 */
/**
 * `latent_interest` is DELIBERATELY ABSENT. Its phrase list matches the bare
 * substrings "interested" and "let it go", which the live classifier resolves
 * to latent_interest for third-party commentary ("I heard they're
 * interested."), buyer-directed questions ("Are you still interested?") and a
 * plain idiom ("You should just let it go."). None of those is a seller
 * POSITION, so none may resolve ownership.
 *
 * The intent itself is untouched and still drives interest/routing — only the
 * ownership-inference predicate is narrowed, which is the smaller change.
 * Genuine conditional-sale phrasing is still covered: "Maybe, what would you
 * offer?" classifies as asks_offer, which IS seller-level.
 */
export const SELLER_LEVEL_ENGAGEMENT_INTENTS = new Set([
  "seller_interested",
  "asks_offer",
  "not_interested",
  "asking_price_provided",
  "counter_offer",
]);

/**
 * Provenance-bearing ownership value. Acquisition-workflow resolution ONLY --
 * never title or legal verification.
 */
export const OWNERSHIP_INFERRED_FROM_ENGAGEMENT = "inferred_from_seller_engagement";

const POSITIVE_OWNERSHIP = new Set(["confirmed", "inferred", OWNERSHIP_INFERRED_FROM_ENGAGEMENT, "likely", "yes", "owner", "authorized_representative", "co_owner", "executor"]);
const NEGATIVE_OWNERSHIP = new Set(["not_owner", "wrong_number", "wrong_person", "former_owner", "tenant", "denied"]);
const POSITIVE_INTEREST = new Set(["interested", "conditional", "depends_on_price", "make_offer", "asks_offer", "yes", "future"]);

export function normalizeAskingPriceFact(input, { sourceMessageId = null, confidence = null, now = null } = {}) {
  if (input == null) return null;
  if (typeof input === "number" || typeof input === "string") {
    const value = numberOrNull(input);
    if (!value || value <= 0) return null;
    return {
      value,
      currency: "USD",
      price_type: "exact",
      confidence: confidence ?? null,
      source_message_id: sourceMessageId || null,
      extracted_text: null,
      captured_at: now || new Date().toISOString(),
    };
  }
  const value = numberOrNull(input.value ?? input.amount);
  if (!value || value <= 0) return null;
  return {
    value,
    currency: clean(input.currency) || "USD",
    price_type: lower(input.price_type) || "exact",
    confidence: input.confidence ?? confidence ?? null,
    source_message_id: input.source_message_id || sourceMessageId || null,
    extracted_text: clean(input.extracted_text || input.raw) || null,
    // Whether the MAGNITUDE was inferred from a contextual anchor ("400"
    // against a $200,000 reference) rather than stated ("$400,000"). It must
    // survive into the persisted fact, or a later reader cannot tell a
    // conventional shorthand reading from a number the seller actually wrote.
    scaled_from_reference: input.scaled_from_reference === true,
    captured_at: input.captured_at || now || new Date().toISOString(),
  };
}

/** Merge persisted facts with newly extracted facts (new wins, price keeps provenance). */
export function mergeSellerFacts(known = {}, extracted = {}, meta = {}) {
  const merged = { ...(known || {}) };
  const facts = extracted || {};

  for (const [key, value] of Object.entries(facts)) {
    if (value === null || value === undefined || value === "") continue;
    if (key === "asking_price") continue; // handled below with provenance
    merged[key] = value;
  }

  const newPrice = normalizeAskingPriceFact(facts.asking_price, meta);
  if (newPrice) merged.asking_price = newPrice;
  else if (known?.asking_price) merged.asking_price = normalizeAskingPriceFact(known.asking_price, meta) || known.asking_price;

  return merged;
}

export function hasMinimumConditionFacts(facts = {}) {
  const occupancy = lower(facts.occupancy_status || facts.occupancy);
  const conditionKnown = Boolean(
    clean(facts.condition_level) ||
      clean(facts.rehab_level) ||
      clean(facts.condition_summary) ||
      clean(facts.repairs_summary) ||
      facts.repairs_needed === false ||
      facts.condition_disclosed === true
  );
  return Boolean(occupancy && occupancy !== "unknown" && conditionKnown);
}

/**
 * Durable facts that could only have come from a SELLER-LEVEL turn.
 *
 * A persisted asking price or offer request did not appear from nowhere: the
 * seller named their number or asked us to make an offer, and that exchange
 * resolves ownership for acquisition purposes exactly as it would today.
 *
 * This matters for continuity. Resolving ownership only from the CURRENT
 * turn's intent froze every thread whose seller-level turn happened earlier
 * and was never stamped — a deal sitting at S3 with a persisted $250,000 ask
 * could not advance on a condition reply, because "condition_disclosed" is not
 * itself seller-level.
 *
 * Deliberately excludes occupancy, condition, rent and unit facts: those are
 * statements ABOUT a property that a tenant or neighbour could equally make.
 */
function hasDurableSellerLevelEvidence(facts = {}) {
  if (facts.asking_price?.value > 0) return true;
  if (facts.wants_offer === true || facts.make_me_an_offer === true) return true;
  if (POSITIVE_INTEREST.has(lower(facts.interest || facts.seller_intent))) return true;
  return false;
}

function ownershipResolved(facts = {}) {
  if (POSITIVE_OWNERSHIP.has(lower(facts.ownership_status))) return true;
  // An explicit negative always wins and is never overridden by history.
  if (NEGATIVE_OWNERSHIP.has(lower(facts.ownership_status))) return false;
  if (lower(facts.ownership_claim) === "denied") return false;
  return hasDurableSellerLevelEvidence(facts);
}

function interestResolved(facts = {}) {
  if (POSITIVE_INTEREST.has(lower(facts.interest || facts.seller_intent))) return true;
  // A price or an offer request implies interest.
  if (facts.asking_price?.value > 0) return true;
  if (facts.wants_offer === true || facts.make_me_an_offer === true) return true;
  return false;
}

function priceResolved(facts = {}, ade = null) {
  // The canonical monetary resolver refused this amount as ambiguous. A
  // refused amount is evidence, never a canonical asking price — S3/S4/S5
  // readiness must not be satisfiable by it.
  if (facts.asking_price_needs_clarification === true && !(facts.asking_price?.value > 0)) {
    return false;
  }
  if (facts.asking_price?.value > 0) return true;
  // "Make me an offer": S3 resolves without a number only when ADE has
  // sufficient facts to price the deal.
  if ((facts.wants_offer === true || facts.make_me_an_offer === true) && ade?.sufficient_facts === true) {
    return true;
  }
  return false;
}

function conditionResolved(facts = {}, ade = null) {
  if (hasMinimumConditionFacts(facts)) return true;
  if (ade?.underwriting_ready === true) return true;
  return false;
}

/**
 * Milestone resolution table — milestone i (0-based stage index) is resolved
 * when the fact predicate holds. Stage = first unresolved milestone.
 */
function firstUnresolvedIdx(facts = {}, {
  ade = null,
  negotiation = null,
  contract = null,
  disposition = null,
  closing = null,
} = {}) {
  // checks[i] is TRUE when milestone i is COMPLETE (the deal has exited that
  // stage). stage = first index whose check is FALSE. Canonical order:
  //   S6 formal_contract → S7 disposition → S8 under-contract-with-buyer →
  //   S9 escrow → S10 closed.
  // S7→S8 requires an authoritative buyer-contract event (buyer_selected):
  // "disposition started" alone keeps the deal in Dispo. S8→S9 requires an
  // escrow/title event; S9→S10 requires a verified closing. None of these can
  // be satisfied by seller text — they read only external state objects.
  // AUTHORITATIVE TRANSACTION STATE RESOLVES OWNERSHIP AND INTEREST.
  //
  // You cannot hold an EXECUTED purchase contract with someone who is not the
  // owner, and you cannot have accepted terms with someone who is not
  // interested. These are external state objects — a signed contract, a
  // selected buyer, an escrow event — not seller text, so this is
  // authoritative ownership data rather than chat inference.
  //
  // Without this, narrowing the chat-based inference silently froze late-stage
  // deals: a fixture at S7 with contract.executed and buyer_selected, but no
  // explicitly recorded ownership_status, resolved to unresolvedIdx 0 and
  // could no longer advance to S8/S9/S10. That is absurd on its face and was a
  // genuine regression, not a stale expectation.
  const transactionAuthority =
    negotiation?.terms_accepted === true ||
    contract?.executed === true ||
    contract?.signed === true ||
    disposition?.buyer_selected === true ||
    closing?.ready === true ||
    closing?.closed === true;

  const checks = [
    () => ownershipResolved(facts) || transactionAuthority,              // S1
    () => interestResolved(facts) || transactionAuthority,               // S2
    () => priceResolved(facts, ade),                                     // S3
    () => conditionResolved(facts, ade),                                 // S4
    () => negotiation?.terms_accepted === true,                          // S5
    () => contract?.executed === true || contract?.signed === true,      // S6 → S7 (Dispo) on contract/disposition readiness
    () => disposition?.buyer_selected === true,                          // S7 Dispo → S8 on authoritative buyer contract
    () => closing?.ready === true,                                       // S8 Under Contract w/ Buyer → S9 on escrow/title event
    () => closing?.closed === true,                                      // S9 Escrow → S10 on verified closing
    () => closing?.closed === true,                                      // S10 Closed (terminal)
  ];
  for (let i = 0; i < checks.length; i += 1) {
    if (!checks[i]()) return i;
  }
  return checks.length - 1; // everything resolved → closed
}


const PRICE_STAGE_IDX = 2;      // asking_price
const CONDITION_STAGE_IDX = 3;  // property_condition

/**
 * THE ACQUISITION DECISION GATE.
 *
 * firstUnresolvedIdx answers "what factual milestone is still missing?". That
 * is useful and stays exactly as it is. It does NOT answer "what should we do
 * next", and promoting it to workflow state is the defect this closes: the
 * instant a price resolved, condition became the first unresolved milestone,
 * so the seller moved to property_condition and was asked about vacancy - even
 * when the economics said the deal was nowhere close.
 *
 * Production example: "Half mil and its yours" on a property we would pay
 * $160,000 for. priceResolved=true, conditionResolved=false, so the seller
 * advanced S3 -> S4 as S3_TO_S4_PRICE_PROVIDED and received a condition probe.
 * No amount of condition information bridges $340,000.
 *
 * Once price resolves, the CANONICAL STAGE-3 ENGINE decides the active stage.
 * No pricing thresholds are introduced here - the bands (MAO x 1.15 / x 1.40)
 * remain the engine's and this only reads its verdict.
 *
 * Returns null when the engine cannot speak (no ask, no underwriting), leaving
 * milestone completeness to stand exactly as before.
 */
function economicStageGate(facts = {}, ade = null, unresolvedIdx = 0, signals = {}) {
  // ECONOMICS GOVERN THE WHOLE POST-PRICE LIFECYCLE, not one instant of it.
  //
  // This used to read `if (unresolvedIdx !== CONDITION_STAGE_IDX) return null`,
  // so the economic route held authority ONLY while condition was the next
  // missing milestone. The moment a seller answered the condition question,
  // the gate fell silent and milestone completeness walked them to the offer
  // stage on its own - regardless of the band:
  //
  //   250k ask (negotiable)     + condition -> offer
  //   300k ask (wide_gap)       + condition -> offer
  //   500k ask (very_wide_gap)  + condition -> offer
  //
  // James, having disclosed a condition, would have been routed to an OFFER on
  // a property he wants $340,000 more for than we can pay. Condition is an
  // INPUT to the acquisition decision; it is not a ticket to the offer stage.
  //
  // The gate now runs for every post-price milestone up to and including the
  // offer milestone. It deliberately stops at acceptance: once
  // negotiation.terms_accepted is true, checks[4] passes, unresolvedIdx is the
  // contract milestone or beyond, and SELLER ACCEPTANCE outranks economics -
  // arithmetic must never be able to pull a deal back out of S6.
  if (unresolvedIdx > OFFER_STAGE_IDX) return null;

  const ask = normalizeAskingPriceFact(facts?.asking_price)?.value;
  const recommended = numberOrNull(ade?.recommended_cash_offer ?? ade?.recommended_offer);
  if (!(ask > 0) || !(recommended > 0)) return null;

  const underwriting = {
    recommended_cash_offer: recommended,
    max_allowable_offer:
      numberOrNull(ade?.max_allowable_offer) || numberOrNull(ade?.investor_ceiling_mid) || null,
  };

  // Creative eligibility changes which route the band yields, so it must be
  // decided BEFORE the route is resolved - and by the same policy the
  // recommender uses, which is why it lives in the engine.
  const creative_allowed = resolveCreativeAllowed({
    facts,
    classification: signals?.classification || {},
    underwriting,
    // The ask is the one the gate actually evaluated, so the policy and the
    // route can never be judging different numbers.
    negotiation_state: { ...(signals?.negotiation_state || {}), current_asking_price: ask },
  });

  // Whether our offer has ever been presented decides the MESSAGE for an ask
  // inside the buy box: a first reveal, or a reply to a real counter. Same
  // canonical predicate the monetary parser uses for `is_counter`.
  const offer_revealed = hasRevealedOffer(signals?.negotiation_state);

  const decision = resolveStage3Route({ ask, underwriting, creative_allowed, offer_revealed });
  if (!decision) return null;

  // The route CARRIES its lifecycle stage. Reading it is a lookup, not a
  // second opinion - which is the whole point of the collapse.
  let stage_idx = STAGE_INDEX.get(decision.route.lifecycle_stage_code);
  if (!Number.isInteger(stage_idx)) return null;

  // ONCE WE HAVE ACTUALLY PRESENTED AN OFFER, THE DEAL IS IN NEGOTIATION.
  //
  // Economics govern the ROUTE and the template from here on, but they may not
  // walk the lifecycle back below the offer stage: a seller who countered our
  // real offer is not returned to a condition probe or to price discovery just
  // because their counter landed in a wider band. The offer was a transaction
  // event, not a milestone guess.
  //
  // James is the opposite case and is exactly why this is a floor rather than a
  // blanket monotonicity rule: nothing was ever presented to him, so an
  // out-of-band ask correctly pulls him back to nurture.
  //
  // Same canonical predicate that decides first-reveal vs counter, so the two
  // cannot disagree about whether an offer exists.
  if (offer_revealed && stage_idx < OFFER_STAGE_IDX) {
    stage_idx = OFFER_STAGE_IDX;
  }

  return {
    stage_idx,
    band: decision.band,
    economics: decision.economics,
    route: decision.route,
    creative_allowed,
    offer_revealed,
    economic_fit: economicFitForBand(decision.band),
  };
}

/**
 * A LABEL on the band, never a second stage decision.
 *
 * economic_fit exists only to feed temperature. It deliberately does not
 * influence the stage, which the route already owns.
 */
function economicFitForBand(band) {
  if (band === STAGE3_OFFER_BANDS.VERY_WIDE_GAP) return "out_of_band";
  if (band === STAGE3_OFFER_BANDS.WIDE_GAP) return "stretch";
  if (band === STAGE3_OFFER_BANDS.AUTO_ACCEPT) return "actionable";
  return "in_band";
}

/**
 * LEAD TEMPERATURE = ACQUISITION PRIORITY / ACTIONABILITY.
 *
 * Not engagement, not questionnaire progress, not "a price exists", not "they
 * asked what we would pay". One question: how actionable is this seller as an
 * acquisition opportunity right now?
 *
 * Replaces derivation from the stage index (afterIdx >= 4 -> HOT, >= 2 ->
 * WARM), under which a seller became WARM merely for naming a number and HOT
 * merely for asking what we would pay. "Sure, $2 million" on a $150,000 house
 * was WARM.
 *
 * No pricing thresholds live here; economic_fit comes from the canonical
 * Stage-3 bands.
 */
/**
 * Inbound intents in which the SELLER has asked to transact. These raise
 * priority only - never stage, never acceptance.
 */
const CONTRACT_INTENT_KEYS = new Set([
  "contract_requested",
  "contract_path",
  "asks_contract",
  "accepts_offer",
  "terms_accepted",
]);

function resolveAcquisitionTemperature({
  facts = {},
  economic_fit = null,
  negotiation = null,
  intentKey = "unclear",
} = {}) {
  // Transaction readiness outranks everything.
  if (negotiation?.terms_accepted === true) return LEAD_TEMPERATURE_CODES.HOT;

  // Economic reality outranks responsiveness. A seller can be delighted to talk
  // and still be nowhere near a deal.
  if (economic_fit === "out_of_band") return LEAD_TEMPERATURE_CODES.COLD;

  // Executable now: the ask is at or inside our cash number.
  if (economic_fit === "actionable") return LEAD_TEMPERATURE_CODES.HOT;

  // A SELLER ASKING FOR THE CONTRACT IS THE MOST ACTIONABLE STATE SHORT OF
  // SIGNED, whatever the economics say.
  //
  // "Ok send over the contract and we will sign it" scored COLD. Under the old
  // rule it was HOT only as a side effect of stage-index promotion, and when
  // that promotion was correctly removed this signal went with it - leaving the
  // single highest-intent message a seller can send at the bottom of the
  // operator's queue. That is a regression, not a consequence of the ruling.
  //
  // Temperature is acquisition PRIORITY. It is not stage and it is not
  // acceptance: this raises neither. terms_accepted still comes only from the
  // acceptance resolver, and the stage still comes only from the route, so
  // nothing here can fabricate a contract.
  if (CONTRACT_INTENT_KEYS.has(intentKey) || facts.contract_requested === true) {
    return LEAD_TEMPERATURE_CODES.HOT;
  }

  // A live acquisition conversation with plausible economics, or economics not
  // yet known. asks_offer supports interest and therefore WARM - it cannot
  // independently create HOT.
  if (interestResolved(facts) || intentKey === "asks_offer") {
    return LEAD_TEMPERATURE_CODES.WARM;
  }

  // Ownership unconfirmed, or confirmed with no interest established.
  return LEAD_TEMPERATURE_CODES.COLD;
}

// ─── Blocking / terminal intents ─────────────────────────────────────────────

const BLOCKING_INTENTS = Object.freeze({
  opt_out: {
    contactability: CONTACTABILITY_CODES.OPTED_OUT,
    operational_status: OPERATIONAL_STATUS_CODES.PAUSED,
    next_action: NEXT_ACTIONS.NO_ACTION_CONTACT_BLOCKED,
    cancel_followups: true,
    reasoning_code: "HOLD_OPT_OUT_SUPPRESS",
    workflow_event: "AUTOMATION_BLOCKED",
  },
  wrong_number: {
    contactability: CONTACTABILITY_CODES.INVALID_NUMBER,
    disposition: DISPOSITION_CODES.WRONG_NUMBER,
    operational_status: OPERATIONAL_STATUS_CODES.PAUSED,
    next_action: NEXT_ACTIONS.NO_ACTION_CONTACT_BLOCKED,
    cancel_followups: true,
    evaluate_alternate_contact: true,
    reasoning_code: "HOLD_WRONG_NUMBER_BLOCK_PHONE",
    workflow_event: "AUTOMATION_BLOCKED",
  },
  wrong_person: {
    contactability: CONTACTABILITY_CODES.DO_NOT_TEXT,
    disposition: DISPOSITION_CODES.WRONG_PERSON,
    operational_status: OPERATIONAL_STATUS_CODES.PAUSED,
    next_action: NEXT_ACTIONS.NO_ACTION_CONTACT_BLOCKED,
    cancel_followups: true,
    evaluate_alternate_contact: true,
    reasoning_code: "HOLD_WRONG_PERSON_BLOCK_CONTACT",
    workflow_event: "AUTOMATION_BLOCKED",
  },
  hostile_or_legal: {
    contactability: CONTACTABILITY_CODES.DO_NOT_TEXT,
    operational_status: OPERATIONAL_STATUS_CODES.NEEDS_REVIEW,
    next_action: NEXT_ACTIONS.HUMAN_REVIEW,
    cancel_followups: true,
    review_required: true,
    review_reason: "hostile_or_legal",
    reasoning_code: "HOLD_HOSTILE_LEGAL_REVIEW",
    workflow_event: "AUTOMATION_NEEDS_REVIEW",
  },
  // Canonical intents from canonical-intent-aliases.js's deriveCanonicalIntent
  // (via resolve-inbound-relationship.js's PROPERTY_SCOPED_CLAIMS "not_owner" /
  // "never_been_owner" claims). Distinct from wrong_number: the phone/person
  // may still be valid for a different property, so this halts and routes to
  // review rather than fully blocking the contact.
  property_specific_non_owner: {
    // PROPERTY-scoped claim: resolve-inbound-relationship.js classifies this
    // as suppression_scope "property" with should_suppress_contact false.
    // Writing DO_NOT_TEXT here blocked the PHONE for every property — the
    // exact wrong-scope suppression this hold exists to avoid. The hold and
    // review stay; contactability is not touched.
    contactability: null,
    disposition: DISPOSITION_CODES.UNQUALIFIED,
    operational_status: OPERATIONAL_STATUS_CODES.NEEDS_REVIEW,
    next_action: NEXT_ACTIONS.HUMAN_REVIEW,
    cancel_followups: true,
    review_required: true,
    review_reason: "property_specific_non_owner",
    reasoning_code: "HOLD_NOT_OWNER_PROPERTY_SCOPED_REVIEW",
    workflow_event: "AUTOMATION_NEEDS_REVIEW",
  },
  // Canonical intent for a "former_owner" relationship claim (sold the
  // property, no longer owns it). Distinct disposition from a bare not-owner
  // claim for accurate telemetry/dashboard reporting.
  former_owner_respondent: {
    // Same scope rule as property_specific_non_owner: sold is terminal for
    // the seller×property pairing, never for the phone/person ("I sold 123
    // Main, but I own 456 Oak" must stay reachable).
    contactability: null,
    disposition: DISPOSITION_CODES.SOLD,
    operational_status: OPERATIONAL_STATUS_CODES.NEEDS_REVIEW,
    next_action: NEXT_ACTIONS.HUMAN_REVIEW,
    cancel_followups: true,
    review_required: true,
    review_reason: "former_owner_property_sold",
    reasoning_code: "HOLD_FORMER_OWNER_PROPERTY_SOLD_REVIEW",
    workflow_event: "AUTOMATION_NEEDS_REVIEW",
  },
  // Live classifier label for a sold/transferred report ("already sold").
  // Identical treatment to former_owner_respondent — callers may pass either
  // the raw label or the canonical respondent class.
  sold_property: {
    contactability: null,
    disposition: DISPOSITION_CODES.SOLD,
    operational_status: OPERATIONAL_STATUS_CODES.NEEDS_REVIEW,
    next_action: NEXT_ACTIONS.HUMAN_REVIEW,
    cancel_followups: true,
    review_required: true,
    review_reason: "former_owner_property_sold",
    reasoning_code: "HOLD_FORMER_OWNER_PROPERTY_SOLD_REVIEW",
    workflow_event: "AUTOMATION_NEEDS_REVIEW",
  },
});

// ─── Review-hold intents (§5 zero silent dead-ends) ─────────────────────────
// These are real classified intents that are neither BLOCKING nor ambiguous,
// so before this registry existed they fell through to the DEFAULT return:
// ACTIVE_COMMUNICATION, the stage's normal script/template, and the pending
// follow-up cancelled with nothing replacing it. "I'm in bankruptcy" was being
// answered with the asking-price script. Each tier now resolves to an explicit,
// deterministic review hold with a tier-specific reason that the coverage net
// maps to an OWNED workflow (legal_compliance_hold / identity_clarification),
// never to the generic ambiguous-context clarifier.
const REVIEW_HOLD_TIERS = Object.freeze({
  legal_authority: Object.freeze({
    intents: Object.freeze([
      "title_issue",
      "lien_tax_issue",
      "bankruptcy_disclosed",
      "trust_ownership",
      "llc_corporation",
    ]),
    review_reason: "legal_authority_disclosure",
    // Legal / authority disclosures block automated outreach until a human
    // has looked; the reply-pending follow-up is cancelled, not replaced.
    cancel_followups: true,
  }),
  respondent_identity: Object.freeze({
    intents: Object.freeze([
      "tenant_respondent",
      "property_manager_respondent",
      "family_member_respondent",
      "agent_representative_respondent",
      "executor_heir_respondent",
      "entity_representative_respondent",
      "co_owner_respondent",
      "non_owner_referral",
    ]),
    review_reason: "respondent_identity_review",
    // Identity clarification may still proceed; keep the follow-up.
    cancel_followups: false,
  }),
  property_correction: Object.freeze({
    intents: Object.freeze(["property_correction"]),
    review_reason: "property_correction",
    cancel_followups: false,
  }),
});

const REVIEW_HOLD_INTENTS = Object.freeze(
  Object.fromEntries(
    Object.entries(REVIEW_HOLD_TIERS).flatMap(([tier, def]) =>
      def.intents.map((intent) => [intent, { tier, ...def }])
    )
  )
);

/** Exported for the coverage proof: every review-hold intent + its tier. */
export function listReviewHoldIntents() {
  return Object.entries(REVIEW_HOLD_INTENTS).map(([intent, def]) => ({
    intent,
    tier: def.tier,
    review_reason: def.review_reason,
    cancel_followups: def.cancel_followups,
  }));
}

/** Nurture windows (days) by disengaging intent. */
const NURTURE_DAYS = Object.freeze({
  not_interested: 30,
  listed_or_unavailable: 45,
  need_time: 30,
  tenant_occupied: 21,
});

// ─── Stage → outstanding-question policy (positive path) ────────────────────

export const STAGE_PROMPTS = Object.freeze({
  [LIFECYCLE_STAGE_CODES.OWNERSHIP_CONFIRMATION]: {
    template_use_case: "ownership_check",
    next_action: NEXT_ACTIONS.SEND_MESSAGE_NOW,
    workflow_event: null,
  },
  [LIFECYCLE_STAGE_CODES.OFFER_INTEREST]: {
    template_use_case: "consider_selling",
    next_action: NEXT_ACTIONS.SEND_MESSAGE_NOW,
    workflow_event: null,
  },
  [LIFECYCLE_STAGE_CODES.ASKING_PRICE]: {
    template_use_case: "seller_asking_price",
    next_action: NEXT_ACTIONS.SEND_MESSAGE_NOW,
    workflow_event: null,
  },
  [LIFECYCLE_STAGE_CODES.PROPERTY_CONDITION]: {
    template_use_case: "condition_probe",
    next_action: NEXT_ACTIONS.SEND_MESSAGE_NOW,
    workflow_event: null,
  },
  [LIFECYCLE_STAGE_CODES.OFFER]: {
    template_use_case: "offer_reveal_cash",
    next_action: NEXT_ACTIONS.GENERATE_OFFER,
    workflow_event: "OFFER_NEGOTIATION_OPENED",
  },
  [LIFECYCLE_STAGE_CODES.FORMAL_CONTRACT]: {
    template_use_case: "asks_contract",
    next_action: NEXT_ACTIONS.GENERATE_CONTRACT,
    workflow_event: "READY_FOR_CONTRACT",
  },
  // S7 Dispo (code `disposition`): hand off to disposition.
  [LIFECYCLE_STAGE_CODES.DISPOSITION]: {
    template_use_case: "close_handoff",
    next_action: NEXT_ACTIONS.START_DISPOSITION,
    workflow_event: "READY_FOR_DISPOSITION",
  },
  // S8 Under Contract With Buyer (code `under_contract`): drive toward closing.
  [LIFECYCLE_STAGE_CODES.UNDER_CONTRACT]: {
    template_use_case: null,
    next_action: NEXT_ACTIONS.RESOLVE_CLOSING_BLOCKER,
    workflow_event: null,
  },
  // S9 Escrow (code `prepared_to_close`).
  [LIFECYCLE_STAGE_CODES.PREPARED_TO_CLOSE]: {
    template_use_case: null,
    next_action: NEXT_ACTIONS.RESOLVE_CLOSING_BLOCKER,
    workflow_event: null,
  },
  [LIFECYCLE_STAGE_CODES.CLOSED]: {
    template_use_case: null,
    next_action: NEXT_ACTIONS.CLOSE,
    workflow_event: null,
  },
});

function bumpTemperature(current, floor) {
  const cur = normalizeLeadTemperature(current, LEAD_TEMPERATURE_CODES.UNSCORED);
  return TEMP_RANK[floor] > TEMP_RANK[cur] ? floor : cur;
}

function advancementEvents(fromIdx, toIdx, facts, intent) {
  const events = [];
  const E = ACQUISITION_LIFECYCLE_EVENTS;
  if (intent === "ownership_confirmed" || (toIdx >= 1 && fromIdx < 1)) events.push(E.OWNER_CONFIRMED);
  if (toIdx >= 2 && fromIdx < 2) events.push(E.OFFER_INTEREST_CONFIRMED);
  if (facts.asking_price?.value > 0 && toIdx >= 3 && fromIdx < 4) events.push(E.SELLER_ASKING_PRICE_CAPTURED);
  if (toIdx >= 4 && fromIdx < 4) events.push(E.READY_FOR_OFFER_REVEAL);
  if (intent === "condition_disclosed" || facts.condition_disclosed === true) events.push(E.CONDITION_FACT_CAPTURED);
  if (toIdx >= 5 && fromIdx < 5) events.push(E.SELLER_ACCEPTED_OFFER, E.READY_FOR_CONTRACT);
  if (toIdx >= 6 && fromIdx < 6) events.push(E.CONTRACT_SIGNED, E.READY_FOR_DISPOSITION);
  return [...new Set(events)];
}

// ─── Resolver ────────────────────────────────────────────────────────────────

/**
 * Deterministically resolve the lifecycle transition for one inbound event
 * (or recovery evaluation). Pure function — persistence happens in callers.
 */
export function resolveSellerStageTransition({
  stage_before = null,
  known_facts = {},
  new_facts = {},
  intent = "unclear",
  classification_confidence = null,
  // Full classifier output. Only creative-finance signals are read from it,
  // and only through the engine's canonical policy - never interpreted here.
  classification = null,
  current_temperature = null,
  current_disposition = null,
  contactability = CONTACTABILITY_CODES.CONTACTABLE,
  automation_mode = "disabled",
  ade_result = null,
  negotiation_state = null,
  contract_state = null,
  disposition_state = null,
  closing_readiness = null,
  closing_evidence = null,
  engine_decision = null,
  source_message_id = null,
  temperature_signal = null,
  // Canonical authority predicate (seller-authority-state.js). Supplied by the
  // orchestrator so the SAME instance gates stage progression and next-best
  // action; recomputed from facts alone when a caller omits it.
  authority_state = null,
  now = new Date().toISOString(),
} = {}) {
  const beforeCode = normalizeLifecycleStage(stage_before);
  const beforeIdx = stageIdx(beforeCode);
  const intentKey = lower(intent) || "unclear";

  const facts = mergeSellerFacts(known_facts, new_facts, {
    sourceMessageId: source_message_id,
    confidence: classification_confidence,
    now,
  });

  const base = {
    resolver_version: TRANSITION_RESOLVER_VERSION,
    stage_before: beforeCode,
    stage_before_number: beforeIdx + 1,
    facts_patch: facts,
    automation_mode,
    resolved_at: now,
    // Explainability: deterministic component scores + reason codes from the
    // temperature signal model travel with every resolution (audit + Studio).
    temperature_signal: temperature_signal || null,
  };

  // ── 1. Blocking intents: state changes without lifecycle movement ────────
  const blocking = BLOCKING_INTENTS[intentKey];
  if (blocking) {
    return {
      ...base,
      stage_after: beforeCode,
      stage_after_number: beforeIdx + 1,
      advanced: false,
      stages_advanced: 0,
      operational_status: blocking.operational_status,
      lead_temperature: normalizeLeadTemperature(current_temperature, LEAD_TEMPERATURE_CODES.UNSCORED),
      disposition: blocking.disposition || current_disposition || null,
      // Property-scoped holds carry no contactability write at all — a null
      // patch (not {contactability_status: null}) so nothing downstream can
      // clear or set phone-level state from a property-level claim.
      contactability_patch: blocking.contactability
        ? { contactability_status: blocking.contactability }
        : null,
      ownership_patch:
        intentKey === "wrong_number" ||
        intentKey === "wrong_person" ||
        intentKey === "property_specific_non_owner" ||
        intentKey === "former_owner_respondent" ||
        intentKey === "sold_property"
          ? { ownership_status: "not_owner" }
          : null,
      next_action: blocking.next_action,
      next_action_due_at: null,
      required_template_use_case: null,
      ade_action: ADE_ACTIONS.NONE,
      review_required: Boolean(blocking.review_required),
      review_reason: blocking.review_reason || null,
      reasoning_code: blocking.reasoning_code,
      workflow_event_types: [blocking.workflow_event].filter(Boolean),
      follow_up: { create: false, cancel: Boolean(blocking.cancel_followups), replace: false, days: null, due_at: null },
      evaluate_alternate_contact: Boolean(blocking.evaluate_alternate_contact),
    };
  }

  // ── 1b. Review-hold intents: deterministic hold, never the stage script ──
  // Same shape as the blocking hold. Stage never moves, no template is
  // selected, nothing is written to contactability or ownership (the
  // relationship resolver owns identity; a respondent class is not evidence
  // about the owner), and the tier-specific review_reason routes the coverage
  // net to an owned workflow.
  const reviewHold = REVIEW_HOLD_INTENTS[intentKey];
  if (reviewHold) {
    return {
      ...base,
      stage_after: beforeCode,
      stage_after_number: beforeIdx + 1,
      advanced: false,
      stages_advanced: 0,
      operational_status: OPERATIONAL_STATUS_CODES.NEEDS_REVIEW,
      lead_temperature: normalizeLeadTemperature(current_temperature, LEAD_TEMPERATURE_CODES.UNSCORED),
      disposition: current_disposition || null,
      contactability_patch: null,
      ownership_patch: null,
      next_action: NEXT_ACTIONS.HUMAN_REVIEW,
      next_action_due_at: null,
      required_template_use_case: null,
      ade_action: ADE_ACTIONS.NONE,
      review_required: true,
      review_reason: reviewHold.review_reason,
      review_hold_tier: reviewHold.tier,
      reasoning_code: `${stageShort(beforeCode)}_HOLD_${intentKey.toUpperCase()}_REVIEW`,
      workflow_event_types: ["AUTOMATION_NEEDS_REVIEW"],
      follow_up: { create: false, cancel: Boolean(reviewHold.cancel_followups), replace: false, days: null, due_at: null },
      evaluate_alternate_contact: false,
    };
  }

  // ── 2. Disengaging intents: nurture without stage regression ─────────────
  // A tenant-occupancy disclosure that ARRIVES WITH a price (or an existing
  // captured price) is engagement — occupancy is an underwriting fact, not a
  // brush-off. Only a bare "tenants live there" reply nurtures.
  const tenantDisclosureWithPrice =
    intentKey === "tenant_occupied" &&
    (Boolean(normalizeAskingPriceFact(new_facts?.asking_price)?.value) || facts.asking_price?.value > 0);
  if (NURTURE_DAYS[intentKey] != null && !tenantDisclosureWithPrice) {
    // "Not for sale" is a SELLER-LEVEL response: the person is declining to
    // sell their property, which answers "are you the seller?" just as a price
    // or an offer request does. Asking "do you own it?" after "not interested"
    // reads as though we were not listening.
    //
    // This branch returns before the shared engagement block below, so the
    // resolution is applied here too — same provenance value, same
    // acquisition-workflow-only meaning, and still overridden by any explicit
    // negative ownership fact (which routes to contact resolution instead).
    if (
      intentKey === "not_interested" &&
      !NEGATIVE_OWNERSHIP.has(lower(facts.ownership_status)) &&
      lower(facts.ownership_claim) !== "denied" &&
      !POSITIVE_OWNERSHIP.has(lower(facts.ownership_status))
    ) {
      facts.ownership_status = OWNERSHIP_INFERRED_FROM_ENGAGEMENT;
      facts.ownership_resolution_basis = "seller_level_engagement";
      facts.ownership_resolution_intent = intentKey;
    }
    const unresolved = firstUnresolvedIdx(facts, {
      ade: ade_result, negotiation: negotiation_state, contract: contract_state,
      disposition: disposition_state, closing: mergeClosing(closing_readiness, closing_evidence),
    });
    const afterIdx = Math.max(beforeIdx, Math.min(unresolved, 1));
    const days = NURTURE_DAYS[intentKey];
    const dueAt = addDaysIso(now, days);
    return {
      ...base,
      stage_after: stageAt(afterIdx),
      stage_after_number: afterIdx + 1,
      advanced: afterIdx > beforeIdx,
      stages_advanced: afterIdx - beforeIdx,
      operational_status: OPERATIONAL_STATUS_CODES.SCHEDULED,
      lead_temperature: intentKey === "not_interested"
        ? LEAD_TEMPERATURE_CODES.COLD
        : normalizeLeadTemperature(current_temperature, LEAD_TEMPERATURE_CODES.COLD),
      disposition: intentKey === "not_interested" ? DISPOSITION_CODES.NOT_INTERESTED : current_disposition || null,
      contactability_patch: null,
      ownership_patch: facts.ownership_status ? { ownership_status: facts.ownership_status } : null,
      next_action: NEXT_ACTIONS.SCHEDULE_FOLLOW_UP,
      next_action_due_at: dueAt,
      required_template_use_case: intentKey === "not_interested" ? "consider_selling_follow_up" : "not_ready",
      ade_action: ADE_ACTIONS.NONE,
      review_required: false,
      review_reason: null,
      reasoning_code: `${stageShort(beforeCode)}_${intentKey.toUpperCase()}_NURTURE_${days}D`,
      workflow_event_types: [
        intentKey === "not_interested"
          ? ACQUISITION_LIFECYCLE_EVENTS.SELLER_NOT_INTERESTED
          : ACQUISITION_LIFECYCLE_EVENTS.DEAL_NURTURE_TRIGGERED,
      ],
      follow_up: { create: true, cancel: false, replace: true, days, due_at: dueAt },
      evaluate_alternate_contact: false,
    };
  }

  // ── 3. Positive / neutral path: fact implications + milestone scan ───────

  // Ownership confirmation never silently overwrites a durable denial — that
  // is a conflict/review state, not automatic re-qualification. Current-turn
  // negative ownership facts must also never be stamped "confirmed" merely
  // because the classifier labeled the intent ownership_confirmed.
  if (intentKey === "ownership_confirmed") {
    const priorDenied =
      NEGATIVE_OWNERSHIP.has(lower(known_facts?.ownership_status)) ||
      lower(known_facts?.ownership_claim) === "denied";
    const newDenied =
      NEGATIVE_OWNERSHIP.has(lower(new_facts?.ownership_status)) ||
      lower(new_facts?.ownership_claim) === "denied";
    if (newDenied) {
      // Seller's current words win for this turn; do not stamp confirmed.
    } else if (priorDenied) {
      facts.ownership_conflict = true;
    } else {
      facts.ownership_status = "confirmed";
    }
  }

  // Ownership-conflict guard: same-message contradictions OR cross-turn
  // durable denial + current positive claim. Blocking/opt-out paths above
  // still win; everything else holds the stage for a human and queues nothing.
  if (new_facts?.ownership_conflict === true || facts.ownership_conflict === true) {
    return {
      ...base,
      facts_patch: { ...facts, ownership_conflict: true },
      stage_after: beforeCode,
      stage_after_number: beforeIdx + 1,
      advanced: false,
      stages_advanced: 0,
      operational_status: OPERATIONAL_STATUS_CODES.NEEDS_REVIEW,
      lead_temperature: normalizeLeadTemperature(current_temperature, LEAD_TEMPERATURE_CODES.UNSCORED),
      disposition: current_disposition || null,
      contactability_patch: null,
      ownership_patch: null,
      next_action: NEXT_ACTIONS.HUMAN_REVIEW,
      next_action_due_at: null,
      required_template_use_case: null,
      ade_action: ADE_ACTIONS.NONE,
      review_required: true,
      review_reason: "contradictory_ownership_evidence",
      reasoning_code: `${stageShort(beforeCode)}_HOLD_OWNERSHIP_CONFLICT`,
      workflow_event_types: [],
      follow_up: { create: false, cancel: true, replace: false, days: null, due_at: null },
      evaluate_alternate_contact: false,
    };
  }
  if (intentKey === "seller_interested" || intentKey === "latent_interest") {
    facts.interest = facts.interest || "interested";
  }
  if (intentKey === "asks_offer") facts.wants_offer = true;
  if (intentKey === "condition_disclosed") facts.condition_disclosed = true;
  if (intentKey === "tenant_occupied") {
    facts.occupancy_status = facts.occupancy_status || "tenant_occupied";
  }

  // ── OWNERSHIP RESOLVED BY SELLER-LEVEL ENGAGEMENT ────────────────────────
  //
  // A SELLER-LEVEL response operationally resolves the ownership milestone.
  // Someone who names their price, asks us to make an offer, says they are
  // interested, counters, or declines to sell is answering AS THE SELLER. We
  // do not then turn around and ask "do you own the property?" — that reads as
  // though we were not listening.
  //
  // Scope matters. Only these SELLER-LEVEL intents qualify:
  //
  //   seller_interested · asks_offer · not_interested
  //   asking_price_provided · counter_offer
  //
  // Deliberately NOT included: a bare occupancy or condition disclosure
  // ("it's rented for 1400", "it needs a roof"). Those are statements ABOUT a
  // property that a tenant, neighbour or relative could equally make; they
  // carry no claim about the speaker's own relationship to it.
  //
  // PROVENANCE IS EXPLICIT. The value is `inferred_from_seller_engagement`,
  // never plain "confirmed", so a later reader can always tell how ownership
  // came to be resolved. This is an ACQUISITION-WORKFLOW resolution and is NOT
  // title or legal verification: nothing here sets title_verified or
  // legal_owner_verified, and a contract path must still establish those
  // independently.
  //
  // EXPLICIT CONTRADICTION ALWAYS WINS. A negative ownership fact ("I don't
  // own it", "wrong person", "my brother owns it") overrides the inference and
  // routes to V2-1 contact resolution — which is an exit from this contact
  // path, not a stage regression.
  const negativeOwnership = NEGATIVE_OWNERSHIP.has(lower(facts.ownership_status)) ||
    lower(facts.ownership_claim) === "denied";
  // Gate on an explicit POSITIVE status rather than ownershipResolved():
  // ownershipResolved() now also returns true from durable seller-level facts,
  // so reusing it here would satisfy the milestone while never writing the
  // provenance value.
  if (!negativeOwnership && SELLER_LEVEL_ENGAGEMENT_INTENTS.has(intentKey) && !POSITIVE_OWNERSHIP.has(lower(facts.ownership_status))) {
    facts.ownership_status = OWNERSHIP_INFERRED_FROM_ENGAGEMENT;
    facts.ownership_resolution_basis = "seller_level_engagement";
    facts.ownership_resolution_intent = intentKey;
  }

  const closing = mergeClosing(closing_readiness, closing_evidence);
  const unresolvedIdx = firstUnresolvedIdx(facts, {
    ade: ade_result,
    negotiation: negotiation_state,
    contract: contract_state,
    disposition: disposition_state,
    closing,
  });
  // ── Authority gate (shared canonical predicate) ──────────────────────────
  // Ownership + interest + price + condition are NOT sufficient to enter an
  // offer-bearing stage. When the canonical authority predicate withholds
  // offer progression (unresolved spouse/co-owner signoff, trust/LLC/estate
  // authority, probate/heirship), the lifecycle is capped BELOW the offer
  // stage before anything is persisted — so the stored stage, the next
  // action, the template and the outbound decision all agree.
  const authority = authority_state || resolveSellerAuthorityState({
    message: "",
    known_facts: facts,
    new_facts,
    contract_state,
  });

  // ── ACQUISITION DECISION GATE ───────────────────────────────────────────
  // Milestone completeness (unresolvedIdx) says what fact is missing. The
  // canonical Stage-3 engine says what we should DO about it. Only the second
  // one is workflow state.
  const economic_gate = economicStageGate(facts, ade_result, unresolvedIdx, {
    classification,
    negotiation_state,
  });
  // The economic route is AUTHORITATIVE when it speaks. Max-ing it against the
  // prior stage would have kept a deal wherever milestone depth had already
  // carried it: an out-of-band James sitting at property_condition would stay
  // there instead of returning to nurture, because max(3, 2) = 3. Monotonicity
  // is the right default for milestone completeness, but it is not a reason to
  // keep treating a dead deal as live.
  //
  // Milestone completeness is untouched and still answers "what is missing?" -
  // it simply no longer decides "what do we do next" once a price exists.
  let afterIdx = economic_gate
    ? economic_gate.stage_idx
    : Math.max(beforeIdx, unresolvedIdx);
  let authority_gate = null;
  if (!authority.offer_progression_allowed && afterIdx >= OFFER_STAGE_IDX) {
    // Monotonicity still holds: a deal already at S5+ never regresses, but its
    // action/template are overridden below.
    const gatedIdx = Math.max(beforeIdx, Math.min(afterIdx, OFFER_STAGE_IDX - 1));
    authority_gate = {
      applied: true,
      block_reason: authority.block_reason,
      ownership_structure: authority.ownership_structure,
      signer_gap: authority.signer_gap,
      probate_detected: authority.probate_detected,
      heirship_detected: authority.heirship_detected,
      capped_from_stage: stageAt(afterIdx),
      capped_to_stage: stageAt(gatedIdx),
      stage_capped: gatedIdx < afterIdx,
    };
    afterIdx = gatedIdx;
  }

  // ── Listing / agent gate (canonical Stage 2 listed-backup policy) ────────
  // When listing_status is listed_with_agent or agent_involved, Stage 2 routes
  // to listed_backup + review — never automated GENERATE_OFFER. Cap below the
  // offer stage and force review so persisted lifecycle cannot disagree with
  // V2 response_strategy.offer_allowed=false / handle_agent_involvement.
  let listing_gate = null;
  const listingBlocksOffer = listingBlocksAutomatedOffer(facts);
  if (listingBlocksOffer && afterIdx >= OFFER_STAGE_IDX) {
    const gatedIdx = Math.max(beforeIdx, Math.min(afterIdx, OFFER_STAGE_IDX - 1));
    listing_gate = {
      applied: true,
      listing_status: lower(facts.listing_status),
      policy: "listed_backup_review",
      capped_from_stage: stageAt(afterIdx),
      capped_to_stage: stageAt(gatedIdx),
      stage_capped: gatedIdx < afterIdx,
    };
    afterIdx = gatedIdx;
  }
  const afterCode = stageAt(afterIdx);

  // TEMPERATURE = ACQUISITION PRIORITY, not engagement depth. Previously this
  // read `afterIdx >= 4 -> HOT, afterIdx >= 2 -> WARM`, so a seller became WARM
  // merely for naming a number and HOT merely for asking what we would pay.
  // See resolveAcquisitionTemperature.
  //
  // Assigned, not bumped: an economically dead deal must be able to fall to
  // COLD. bumpTemperature is monotonic, so it could never express "this seller
  // is responsive but the deal is not workable", which is precisely the James
  // case.
  let temperature = resolveAcquisitionTemperature({
    facts,
    economic_fit: economic_gate?.economic_fit ?? null,
    negotiation: negotiation_state,
    intentKey,
  });
  // The explainable signal model may raise, but never above an out-of-band
  // economic verdict: responsiveness does not override economic reality.
  if (temperature_signal?.temperature_floor && economic_gate?.economic_fit !== "out_of_band") {
    temperature = bumpTemperature(temperature, temperature_signal.temperature_floor);
  }

  const prompt = STAGE_PROMPTS[afterCode] || STAGE_PROMPTS[LIFECYCLE_STAGE_CODES.OWNERSHIP_CONFIRMATION];

  // ADE action. This is the "economics are required now" signal, NOT a
  // "run the engine now" instruction: the persistence layer routes it through
  // ensurePropertyAcquisitionDecision, which reuses a current decision and only
  // runs the engine when one is absent or its inputs moved.
  //
  // It used to fire only on the turn a price arrived, and at S5 only when no
  // snapshot existed at all. So a deal that reached S3 with a price captured
  // several turns earlier carried NO economics, and a stale S5 snapshot of any
  // age counted as current. Economics are required from S3 onward, every turn,
  // and the freshness check decides what that costs.
  let adeAction = ADE_ACTIONS.NONE;
  const priceJustCaptured = Boolean(normalizeAskingPriceFact(new_facts?.asking_price)?.value);
  const materialFactArrived = priceJustCaptured || intentKey === "condition_disclosed" || intentKey === "tenant_occupied";
  const economicsRequired = afterIdx >= 2;
  if (economicsRequired) {
    // RUN_FULL stays an S5 concept. A price or condition landing earlier is
    // still preliminary underwriting, however material it is.
    if (materialFactArrived && ade_result) adeAction = ADE_ACTIONS.RERUN_MATERIAL_FACTS;
    else if (afterIdx >= 4) adeAction = ADE_ACTIONS.RUN_FULL;
    else adeAction = ADE_ACTIONS.RUN_PRELIMINARY;
  }

  // Next action from the unresolved milestone; engine decisions refine S5/S6.
  let nextAction = prompt.next_action;
  let templateUseCase = prompt.template_use_case;
  // "Make me an offer": never re-ask the price the seller declined to give —
  // ask the highest-value missing underwriting question and let ADE decide.
  if (afterCode === LIFECYCLE_STAGE_CODES.ASKING_PRICE && facts.wants_offer === true) {
    templateUseCase = "condition_probe";
    if (!ade_result) adeAction = ADE_ACTIONS.RUN_PRELIMINARY;
  }
  if (afterIdx === 4) {
    const engineAction = lower(engine_decision?.acquisition_action);
    if (engineAction === "generate_contract") nextAction = NEXT_ACTIONS.GENERATE_CONTRACT;
    else if (negotiation_state?.offers_made > 0 || engineAction.includes("negotiat") || engineAction.includes("justify") || engineAction.includes("narrow")) {
      nextAction = NEXT_ACTIONS.NEGOTIATE;
      templateUseCase = engine_decision?.template_use_case || templateUseCase;
    } else if (!ade_result) {
      nextAction = NEXT_ACTIONS.EXECUTE_ADE;
    }
  }
  if (afterIdx === 5 && contract_state?.sent === true && !contract_state?.signed) {
    nextAction = NEXT_ACTIONS.AWAIT_SIGNATURE;
    templateUseCase = "signature_reminder";
  }

  // Authority gate, part 2: strip any offer/contract-bearing action or
  // template. This also covers a deal already sitting at S5+ (where the stage
  // cannot regress) — the ACTION is still withheld. Fails closed to review
  // with no template, so nothing can be queued while authority is unresolved.
  const OFFER_BEARING_ACTIONS = new Set([
    NEXT_ACTIONS.GENERATE_OFFER,
    NEXT_ACTIONS.GENERATE_CONTRACT,
    NEXT_ACTIONS.NEGOTIATE,
    NEXT_ACTIONS.AWAIT_SIGNATURE,
  ]);
  if (
    !authority.offer_progression_allowed &&
    (OFFER_BEARING_ACTIONS.has(nextAction) || OFFER_TEMPLATE_USE_CASES.has(templateUseCase))
  ) {
    nextAction = NEXT_ACTIONS.HUMAN_REVIEW;
    templateUseCase = null;
    authority_gate = {
      ...(authority_gate || { applied: true, block_reason: authority.block_reason }),
      action_withheld: true,
    };
  }

  // Listing/agent gate, part 2: same fail-closed action strip as authority.
  // Stage 2 listed_backup uses template "already_listed" under review — never
  // an offer-bearing template or GENERATE_OFFER next action.
  if (
    listingBlocksOffer &&
    (OFFER_BEARING_ACTIONS.has(nextAction) || OFFER_TEMPLATE_USE_CASES.has(templateUseCase))
  ) {
    nextAction = NEXT_ACTIONS.HUMAN_REVIEW;
    templateUseCase = "already_listed";
    listing_gate = {
      ...(listing_gate || {
        applied: true,
        listing_status: lower(facts.listing_status),
        policy: "listed_backup_review",
      }),
      action_withheld: true,
    };
  } else if (listingBlocksOffer && !OFFER_BEARING_ACTIONS.has(nextAction)) {
    // Even when not at offer stage, listed/agent requires review/reroute so
    // persisted next_action cannot keep a direct-owner acquisition path.
    nextAction = NEXT_ACTIONS.HUMAN_REVIEW;
    if (!templateUseCase || OFFER_TEMPLATE_USE_CASES.has(templateUseCase)) {
      templateUseCase = "already_listed";
    }
    listing_gate = {
      ...(listing_gate || {
        applied: true,
        listing_status: lower(facts.listing_status),
        policy: "listed_backup_review",
      }),
      action_withheld: true,
    };
  }

  // Low-confidence or unclear input never advances silently — review instead.
  const confidence = typeof classification_confidence === "number" ? classification_confidence : null;
  const ambiguous = intentKey === "unclear" || intentKey === "reaction_only" || intentKey === "acknowledgement";
  const lowConfidence = confidence !== null && confidence < 0.7 && afterIdx > beforeIdx;
  // External lifecycle evidence (contract/disposition/closing state, accepted
  // terms) makes an otherwise ambiguous evaluation deterministic — recovery
  // and event-driven re-evaluations run with intent "unclear" by design.
  const externalEvidence = Boolean(
    contract_state || disposition_state || closing_readiness || closing_evidence ||
      negotiation_state?.terms_accepted === true
  );
  if (ambiguous && afterIdx === beforeIdx && !materialFactArrived && !externalEvidence) {
    return {
      ...base,
      stage_after: beforeCode,
      stage_after_number: beforeIdx + 1,
      advanced: false,
      stages_advanced: 0,
      operational_status: OPERATIONAL_STATUS_CODES.NEEDS_REVIEW,
      lead_temperature: temperature,
      disposition: current_disposition || null,
      contactability_patch: null,
      ownership_patch: null,
      next_action: NEXT_ACTIONS.HUMAN_REVIEW,
      next_action_due_at: null,
      required_template_use_case: null,
      ade_action: ADE_ACTIONS.NONE,
      review_required: true,
      review_reason: "ambiguous_intent",
      reasoning_code: `${stageShort(beforeCode)}_AMBIGUOUS_HOLD_REVIEW`,
      workflow_event_types: [],
      follow_up: { create: false, cancel: false, replace: false, days: null, due_at: null },
      evaluate_alternate_contact: false,
      listing_gate,
    };
  }

  const authorityReview = Boolean(authority_gate?.applied);
  const listingReview = Boolean(listing_gate?.applied);
  const reviewRequired = lowConfidence || authorityReview || listingReview;
  const reasoning = authority_gate?.applied
    ? `${stageShort(beforeCode)}_HOLD_AUTHORITY_${String(authority.block_reason || "unresolved").toUpperCase()}`
    : listing_gate?.applied
      ? `${stageShort(beforeCode)}_HOLD_LISTING_${String(facts.listing_status || "agent").toUpperCase()}`
    : afterIdx > beforeIdx
      ? `${stageShort(beforeCode)}_TO_${stageShort(afterCode)}_${intentKey.toUpperCase()}`
      : `${stageShort(beforeCode)}_HOLD_${intentKey.toUpperCase()}`;

  // Listed/agent policy uses Stage 2 already_listed under review. Authority /
  // low-confidence review strips templates. Offer templates never survive.
  let finalTemplate = templateUseCase;
  if (reviewRequired) {
    finalTemplate = listingReview ? "already_listed" : null;
  }

  return {
    ...base,
    authority_state: authority,
    authority_gate,
    listing_gate,
    // The economic verdict that chose this stage, so persistence, the strategy
    // router and any audit can read WHY without recomputing pricing.
    economic_gate: economic_gate
      ? {
        applied: true,
        offer_band: economic_gate.band,
        economic_fit: economic_gate.economic_fit,
        seller_asking_price: economic_gate.economics.seller_asking_price,
        recommended_cash_offer: economic_gate.economics.recommended_cash_offer,
        offer_gap_amount: economic_gate.economics.offer_gap_amount,
        ask_to_offer_ratio: economic_gate.economics.ask_to_offer_ratio,
        milestone_unresolved_idx: unresolvedIdx,
        route_id: economic_gate.route.route_id,
        route: economic_gate.route,
        creative_allowed: economic_gate.creative_allowed,
        offer_revealed: economic_gate.offer_revealed,
        template_use_case: economic_gate.route.template_use_case,
        acquisition_action: economic_gate.route.acquisition_action,
        workflow_stage_idx: economic_gate.stage_idx,
        diverged: economic_gate.stage_idx !== unresolvedIdx,
      }
      : { applied: false },
    stage_after: afterCode,
    stage_after_number: afterIdx + 1,
    advanced: afterIdx > beforeIdx,
    stages_advanced: afterIdx - beforeIdx,
    // Any final human-review transition must surface as NEEDS_REVIEW so inbox
    // consumers keying off operational_status agree with next_action.
    // Blocking/suppression paths return earlier with stronger statuses.
    operational_status: reviewRequired
      ? OPERATIONAL_STATUS_CODES.NEEDS_REVIEW
      : OPERATIONAL_STATUS_CODES.ACTIVE_COMMUNICATION,
    lead_temperature: temperature,
    disposition: interestResolved(facts) ? DISPOSITION_CODES.INTERESTED : current_disposition || null,
    contactability_patch: null,
    ownership_patch: facts.ownership_status ? { ownership_status: facts.ownership_status } : null,
    next_action: reviewRequired ? NEXT_ACTIONS.HUMAN_REVIEW : nextAction,
    next_action_due_at: now,
    required_template_use_case: finalTemplate,
    ade_action: adeAction,
    review_required: reviewRequired,
    review_reason: authorityReview
      ? authority.block_reason || "authority_unresolved"
      : listingReview
        ? `listing_${lower(facts.listing_status) || "agent_involved"}`
      : reviewRequired
        ? "low_confidence_advancement"
        : null,
    reasoning_code: reasoning,
    workflow_event_types: advancementEvents(beforeIdx, afterIdx, facts, intentKey),
    follow_up: {
      create: false,
      cancel: true, // a reply always cancels stale reply-pending follow-ups
      replace: afterIdx > beforeIdx,
      days: null,
      due_at: null,
    },
    evaluate_alternate_contact: false,
  };
}

function mergeClosing(readiness, evidence) {
  if (!readiness && !evidence) return null;
  return {
    ready: readiness?.ready === true,
    closed: evidence?.closed === true || Boolean(evidence?.closed_at),
  };
}

export default resolveSellerStageTransition;
