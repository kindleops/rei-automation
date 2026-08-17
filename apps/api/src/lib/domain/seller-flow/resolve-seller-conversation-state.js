// ─── resolve-seller-conversation-state.js ───────────────────────────────────
// Canonical deterministic conversation state for one seller inbound turn.
//
// This is a PROJECTION, not a new state store. Every field is derived from
// state the production path already computes or persists:
//   • normalized classification contract (normalize-classification-contract.js)
//   • extracted seller facts            (extract-seller-facts.js)
//   • durable deal facts                (acquisition_opportunities.metadata.seller_facts
//                                        via loadSellerDealState)
//   • negotiation state / ADE snapshot  (negotiation-state.js, persisted metadata)
//   • authority state                   (seller-authority-state.js — the SAME
//                                        predicate the stage resolver gates on)
//
// It re-scans nothing. The raw transcript is never re-parsed: durable memory is
// whatever `known_facts` carries, exactly as production persists it.
//
// Pure: no DB, no network, no template generation, no send, and no Date.now
// unless an explicit `now` is supplied.

import { resolveSellerAuthorityState } from "@/lib/domain/seller-flow/seller-authority-state.js";
import { mergeSellerFacts, normalizeAskingPriceFact } from "@/lib/domain/seller-flow/resolve-seller-stage-transition.js";

export const CONVERSATION_STATE_VERSION = "seller_conversation_state_v1";

/** Resolution of a single acquisition fact. */
export const FACT_RESOLUTION = Object.freeze({
  KNOWN: "known",
  MISSING: "missing",
  CONFLICTING: "conflicting",
  NOT_APPLICABLE: "not_applicable",
});

/** Canonical identity classes (mirrors resolve-inbound-relationship.js). */
export const IDENTITY_STATES = Object.freeze({
  OWNER_CONFIRMED: "owner_confirmed",
  OWNER_UNRESOLVED: "owner_unresolved",
  NON_OWNER: "non_owner",
  FORMER_OWNER: "former_owner",
  RENTER: "renter",
  WRONG_NUMBER: "wrong_number",
  REPRESENTATIVE: "representative",
  CONFLICTING: "conflicting",
});

/** Canonical interest states. */
export const INTEREST_STATES = Object.freeze({
  INTERESTED: "interested",
  CONDITIONAL: "conditional_interest",
  REQUESTS_OFFER: "seller_requests_offer",
  NOT_INTERESTED: "not_interested",
  FOLLOW_UP_LATER: "follow_up_later",
  UNCLEAR: "unclear",
});

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function fact(resolution, value = null, extra = {}) {
  return { resolution, value, ...extra };
}

const known = (value, extra = {}) => fact(FACT_RESOLUTION.KNOWN, value, extra);
const missing = (extra = {}) => fact(FACT_RESOLUTION.MISSING, null, extra);
const conflicting = (value, extra = {}) => fact(FACT_RESOLUTION.CONFLICTING, value, extra);

const NON_OWNER_CLAIMS = new Set(["not_owner", "never_been_owner", "actual_wrong_number"]);
/** Mirrors POSITIVE_OWNERSHIP in resolve-seller-stage-transition.js. */
const POSITIVE_OWNERSHIP_FACT_STATUSES = new Set([
  "confirmed", "inferred", "likely", "yes", "owner", "authorized_representative", "co_owner", "executor",
]);
const REPRESENTATIVE_CLAIMS = new Set([
  "agent",
  "property_manager",
  "llc_representative",
  "executor_heir",
]);

// ── Identity ────────────────────────────────────────────────────────────────

function resolveIdentity({ contract, facts, intent, engaged = false }) {
  const relationship = contract?.relationship || null;
  const claim = lower(relationship?.relationship_claim);
  const ownershipSignal = lower(contract?.ownership_signal);
  const factClaim = lower(facts.ownership_claim);
  const factStatus = lower(facts.ownership_status);

  // Contradictory evidence never resolves to a verified owner.
  if (facts.ownership_conflict === true) {
    return { state: IDENTITY_STATES.CONFLICTING, owner_confirmed: false, review_required: true };
  }
  // A stale persisted "confirmed" plus a fresh denial is still a conflict.
  if (factClaim === "denied" && (factStatus === "confirmed" || ownershipSignal === "confirmed")) {
    return { state: IDENTITY_STATES.CONFLICTING, owner_confirmed: false, review_required: true };
  }
  // Cross-turn: durable not_owner/denial + current positive ownership claim.
  // Do NOT silently keep NON_OWNER (erasing the new evidence) and do NOT
  // auto-trust the positive claim — fail closed to conflict/review.
  // Wrong-number contact suppression is separate and is never auto-cleared.
  const durableNegativeOwnership =
    factStatus === "not_owner" || factClaim === "denied";
  const currentPositiveOwnership =
    ownershipSignal === "confirmed" ||
    ownershipSignal === "inferred" ||
    factClaim === "confirmed";
  if (durableNegativeOwnership && currentPositiveOwnership) {
    return { state: IDENTITY_STATES.CONFLICTING, owner_confirmed: false, review_required: true };
  }

  if (intent === "wrong_number" || claim === "actual_wrong_number" || contract?.wrong_number_signal) {
    return { state: IDENTITY_STATES.WRONG_NUMBER, owner_confirmed: false, review_required: false };
  }
  if (claim === "former_owner" || intent === "former_owner_respondent") {
    return { state: IDENTITY_STATES.FORMER_OWNER, owner_confirmed: false, review_required: false };
  }
  if (claim === "tenant" || factStatus === "tenant") {
    return { state: IDENTITY_STATES.RENTER, owner_confirmed: false, review_required: false };
  }
  if (NON_OWNER_CLAIMS.has(claim) || intent === "property_specific_non_owner" || factStatus === "not_owner") {
    return { state: IDENTITY_STATES.NON_OWNER, owner_confirmed: false, review_required: false };
  }
  if (REPRESENTATIVE_CLAIMS.has(claim)) {
    return { state: IDENTITY_STATES.REPRESENTATIVE, owner_confirmed: false, review_required: true };
  }
  // "inferred" is the secondary-signal ownership projection (e.g. "yeah that's
  // mine but I'm not interested") — still ownership evidence, never erased
  // merely because another disposition became primary.
  if (
    ownershipSignal === "confirmed" ||
    ownershipSignal === "inferred" ||
    factClaim === "confirmed" ||
    factStatus === "confirmed"
  ) {
    return {
      state: IDENTITY_STATES.OWNER_CONFIRMED,
      owner_confirmed: true,
      review_required: false,
      basis: ownershipSignal === "inferred" ? "secondary_signal" : "explicit_claim",
    };
  }
  // Canonical existing policy, mirrored from resolveSellerStageTransition:
  // engaged acquisition facts (a price, an offer request, stated interest)
  // imply ownership unless ownership was explicitly denied above. Without this
  // the layer would re-ask ownership the lifecycle already treats as resolved.
  if (engaged || POSITIVE_OWNERSHIP_FACT_STATUSES.has(factStatus)) {
    return {
      state: IDENTITY_STATES.OWNER_CONFIRMED,
      owner_confirmed: true,
      review_required: false,
      basis: engaged ? "inferred_from_engagement" : "persisted_inference",
    };
  }
  return { state: IDENTITY_STATES.OWNER_UNRESOLVED, owner_confirmed: false, review_required: false };
}

// ── Interest ────────────────────────────────────────────────────────────────

function resolveInterest({ contract, facts, intent }) {
  const signal = lower(contract?.interest_signal);
  if (intent === "not_interested" || signal === "not_interested") {
    return INTEREST_STATES.NOT_INTERESTED;
  }
  if (facts.wants_offer === true || intent === "asks_offer") return INTEREST_STATES.REQUESTS_OFFER;
  if (intent === "need_time" || signal === "conditional") return INTEREST_STATES.FOLLOW_UP_LATER;
  // An explicitly deferred timeline is a request to be contacted later, not an
  // invitation to qualify now. Only applies while the seller has given no
  // canonical price and has not asked for an offer (both handled above).
  if (
    lower(facts.timeline) === "long_term" &&
    ["latent_interest", "need_time", "unclear"].includes(intent) &&
    !(facts.asking_price?.value > 0)
  ) {
    return INTEREST_STATES.FOLLOW_UP_LATER;
  }
  if (intent === "latent_interest") return INTEREST_STATES.CONDITIONAL;
  const interestFact = lower(facts.interest || facts.seller_intent);
  if (interestFact === "conditional" || interestFact === "depends_on_price") {
    return INTEREST_STATES.CONDITIONAL;
  }
  if (signal === "interested" || interestFact === "interested" || interestFact === "yes" || interestFact === "future") {
    return INTEREST_STATES.INTERESTED;
  }
  if (facts.asking_price?.value > 0) return INTEREST_STATES.INTERESTED;
  return INTEREST_STATES.UNCLEAR;
}

// ── Acquisition facts (known / missing / conflicting / not_applicable) ──────

function resolveAcquisitionFacts(facts, { identity }) {
  const out = {};

  // Asking price — the canonical monetary resolver is the only authority. A
  // refused (ambiguous) amount is never promoted, only recorded as evidence.
  const price = normalizeAskingPriceFact(facts.asking_price);
  if (price?.value > 0 && facts.asking_price_needs_clarification === true) {
    out.asking_price = conflicting(price, { reason: "ambiguous_monetary_statement" });
  } else if (price?.value > 0) {
    out.asking_price = known(price, { confidence: price.confidence ?? null });
  } else if (facts.asking_price_needs_clarification === true) {
    out.asking_price = missing({
      reason: "ambiguous_monetary_statement",
      clarification_required: true,
      raw_mention: facts.asking_price_mention_raw || null,
    });
  } else if (facts.wants_offer === true) {
    out.asking_price = missing({ reason: "seller_deferred_to_buyer_offer" });
  } else {
    out.asking_price = missing();
  }

  // Property condition
  const conditionValue =
    clean(facts.condition_summary) ||
    clean(facts.repairs_summary) ||
    clean(facts.condition_level) ||
    (facts.repairs_needed === false ? "no_repairs_disclosed" : "") ||
    (facts.condition_disclosed === true ? "disclosed" : "");
  out.property_condition = conditionValue ? known(conditionValue) : missing();

  // Timeline / motivation
  out.timeline = clean(facts.timeline) ? known(clean(facts.timeline)) : missing();
  out.motivation = clean(facts.reason_for_selling)
    ? known(clean(facts.reason_for_selling))
    : missing();

  // Occupancy
  const occupancy = lower(facts.occupancy_status);
  out.occupancy = occupancy && occupancy !== "unknown" ? known(occupancy) : missing();

  // Mortgage / payoff — no canonical extractor exists yet; report the gap
  // honestly rather than pretending the system remembers it.
  out.mortgage_payoff =
    facts.mortgage_balance != null
      ? known(facts.mortgage_balance)
      : missing({ reason: "no_canonical_extractor" });

  // Repair context
  out.repair_context = clean(facts.repairs_summary)
    ? known(clean(facts.repairs_summary))
    : facts.repairs_needed === false
      ? known("no_repairs_disclosed")
      : missing();

  // Closing timing — derived from timeline; not separately captured today.
  out.closing_timing = clean(facts.closing_timing)
    ? known(clean(facts.closing_timing))
    : missing({ reason: "no_canonical_extractor" });

  // Acquisition facts are meaningless for a non-owner counterparty.
  const acquisitionIrrelevant = [
    IDENTITY_STATES.WRONG_NUMBER,
    IDENTITY_STATES.FORMER_OWNER,
    IDENTITY_STATES.RENTER,
    IDENTITY_STATES.NON_OWNER,
  ].includes(identity.state);
  if (acquisitionIrrelevant) {
    for (const key of Object.keys(out)) {
      if (out[key].resolution === FACT_RESOLUTION.MISSING) {
        out[key] = fact(FACT_RESOLUTION.NOT_APPLICABLE, null, { reason: identity.state });
      }
    }
  }

  return out;
}

// ── Negotiation ─────────────────────────────────────────────────────────────

function resolveNegotiation(negotiation_state, facts) {
  const n = negotiation_state && typeof negotiation_state === "object" ? negotiation_state : {};
  const offersMade = Array.isArray(n.offers_made) ? n.offers_made.length : Number(n.offers_made) || 0;
  return {
    asking_price_known: normalizeAskingPriceFact(facts.asking_price)?.value > 0,
    offer_already_made: offersMade > 0 || n.latest_offer != null,
    last_offer: n.latest_offer ?? null,
    seller_counter: Array.isArray(n.seller_counters) ? (n.seller_counters.at(-1)?.amount ?? null) : null,
    offer_rejected: facts.price_objection === true || n.offer_rejected === true,
    offer_accepted: n.terms_accepted === true,
    negotiation_round: Number(n.negotiation_turn || 0),
    authorized_offer_ceiling: n.authorized_offer_ceiling ?? null,
    recommended_offer: n.recommended_offer ?? null,
  };
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * Resolve canonical conversation state for one seller inbound turn.
 *
 * @param {object} args
 * @param {object} args.contract        normalized classification contract
 * @param {object} [args.known_facts]   durable persisted seller facts
 * @param {object} [args.new_facts]     this turn's projected extractor facts
 * @param {object} [args.negotiation_state]
 * @param {object} [args.contract_state]
 * @param {object} [args.ade_snapshot]
 * @param {object} [args.underwriting]
 * @param {string} [args.message]       raw inbound text (authority detectors)
 * @param {string} [args.stage_before]
 * @param {string} [args.now]           injectable ISO timestamp
 */
export function resolveSellerConversationState({
  contract = null,
  known_facts = null,
  new_facts = null,
  negotiation_state = null,
  contract_state = null,
  ade_snapshot = null,
  underwriting = null,
  message = "",
  stage_before = null,
  now = null,
} = {}) {
  const facts = mergeSellerFacts(known_facts || {}, new_facts || {}, { now });
  const intent = lower(contract?.normalized_intent) || "unclear";

  // Interest resolves first: engaged acquisition facts feed the canonical
  // ownership inference below (same rule the stage resolver applies).
  const interest = resolveInterest({ contract, facts, intent });
  const engaged =
    facts.asking_price?.value > 0 ||
    facts.wants_offer === true ||
    [INTEREST_STATES.INTERESTED, INTEREST_STATES.CONDITIONAL, INTEREST_STATES.REQUESTS_OFFER].includes(interest);
  const identity = resolveIdentity({ contract, facts, intent, engaged });
  const acquisition = resolveAcquisitionFacts(facts, { identity });

  // The SAME authority predicate the stage resolver gates on.
  const authority = resolveSellerAuthorityState({
    message,
    known_facts: facts,
    new_facts,
    contract_state,
  });

  const negotiation = resolveNegotiation(negotiation_state, facts);

  // ── Safety ───────────────────────────────────────────────────────────────
  const suppression_required = Boolean(
    contract?.opt_out_signal ||
      contract?.wrong_number_signal ||
      identity.state === IDENTITY_STATES.WRONG_NUMBER ||
      identity.state === IDENTITY_STATES.FORMER_OWNER ||
      identity.state === IDENTITY_STATES.NON_OWNER ||
      identity.state === IDENTITY_STATES.RENTER
  );

  const human_review_required = Boolean(
    contract?.ambiguity_review_required ||
      identity.review_required ||
      facts.ownership_conflict === true ||
      authority.human_review_required ||
      intent === "hostile_or_legal"
  );

  // Offer permission is NEVER granted by the seller asking for an offer. It
  // requires: an authorized counterparty, resolved authority, a canonical
  // (non-ambiguous) price position, condition knowledge, and underwriting
  // authority. Anything short of that is fail-closed.
  const underwriting_ready = Boolean(
    ade_snapshot ||
      underwriting?.recommended_cash_offer != null ||
      negotiation.recommended_offer != null
  );
  const price_position_resolved =
    acquisition.asking_price.resolution === FACT_RESOLUTION.KNOWN ||
    (facts.wants_offer === true && underwriting_ready);

  const offer_permission = Boolean(
    !suppression_required &&
      identity.owner_confirmed &&
      authority.offer_progression_allowed &&
      price_position_resolved &&
      acquisition.property_condition.resolution === FACT_RESOLUTION.KNOWN &&
      underwriting_ready &&
      !human_review_required
  );

  const contract_progression_permission = Boolean(
    offer_permission && authority.contract_progression_allowed && negotiation.offer_accepted
  );

  const missing_facts = Object.entries(acquisition)
    .filter(([, v]) => v.resolution === FACT_RESOLUTION.MISSING)
    .map(([k]) => k);
  const known_fact_keys = Object.entries(acquisition)
    .filter(([, v]) => v.resolution === FACT_RESOLUTION.KNOWN)
    .map(([k]) => k);
  const conflicting_facts = Object.entries(acquisition)
    .filter(([, v]) => v.resolution === FACT_RESOLUTION.CONFLICTING)
    .map(([k]) => k);

  return {
    version: CONVERSATION_STATE_VERSION,
    stage_before: stage_before || null,
    intent,
    identity,
    interest,
    // Seller asking for an offer is preserved as its own signal and is
    // deliberately independent of `offer_permission`.
    seller_requests_offer: interest === INTEREST_STATES.REQUESTS_OFFER || facts.wants_offer === true,
    acquisition,
    known_facts: known_fact_keys,
    missing_facts,
    conflicting_facts,
    authority,
    negotiation,
    listing_status: clean(facts.listing_status) || null,
    agent_involved: ["listed_with_agent", "agent_involved"].includes(lower(facts.listing_status)),
    trust_concern: facts.trust_concern === true,
    safety: {
      suppression_required,
      no_reply_required: suppression_required,
      human_review_required,
      // True only when classification AMBIGUITY is the sole review driver —
      // no suppression, no identity review, no ownership conflict, no
      // authority review, no hostile/legal. This is precisely the case the
      // coverage-net safe-fallback clarifier exists to answer; every other
      // review reason stays a hard withhold (see resolveV2ReplyWithhold).
      ambiguity_only_review: Boolean(
        contract?.ambiguity_review_required &&
          !suppression_required &&
          !identity.review_required &&
          facts.ownership_conflict !== true &&
          !authority.human_review_required &&
          intent !== "hostile_or_legal" &&
          // Listed-with-agent review comes from the NBA, not this safety
          // object — exclude it here so the ambiguity carve can never pierce
          // the agent-involvement withhold.
          !["listed_with_agent", "agent_involved"].includes(
            lower(facts.listing_status)
          )
      ),
      offer_permission,
      contract_progression_permission,
    },
    // Provenance so callers never have to guess which facts were durable.
    facts_snapshot: facts,
  };
}

export default resolveSellerConversationState;
