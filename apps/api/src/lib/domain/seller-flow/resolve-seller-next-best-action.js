// ─── resolve-seller-next-best-action.js ─────────────────────────────────────
// ONE canonical acquisition objective per seller turn, derived from canonical
// conversation state. Business decision only — this module selects NO wording,
// NO template body, and performs no I/O.
//
// Vocabulary reuses the existing acquisition-brain NBA action types where an
// equivalent already exists; the acquisition OBJECTIVE names below are the new
// canonical layer (the registry's action types describe transport shape —
// send_template / suppress / human_review — not which acquisition question is
// outstanding).
//
// Pure: no DB, no network, no Date.now unless `now` is supplied.

import { NBA_ACTION_TYPES } from "@/lib/domain/acquisition-brain/next-best-action-registry.js";
import {
  FACT_RESOLUTION,
  IDENTITY_STATES,
  INTEREST_STATES,
} from "@/lib/domain/seller-flow/resolve-seller-conversation-state.js";

export const NEXT_BEST_ACTION_VERSION = "seller_next_best_action_v1";

/** Canonical acquisition objectives. Exactly one is selected per turn. */
export const ACQUISITION_OBJECTIVES = Object.freeze({
  SUPPRESS: "suppress",
  NO_REPLY: "no_reply",
  HUMAN_REVIEW: "human_review",
  VERIFY_OWNERSHIP: "verify_ownership",
  CLARIFY_IDENTITY: "clarify_identity",
  DISCOVER_INTEREST: "discover_seller_interest",
  DISCOVER_ASKING_PRICE: "discover_asking_price",
  CLARIFY_ASKING_PRICE: "clarify_asking_price",
  DISCOVER_CONDITION: "discover_condition",
  DISCOVER_TIMELINE: "discover_timeline",
  DISCOVER_MOTIVATION: "discover_motivation",
  DISCOVER_OCCUPANCY: "discover_occupancy",
  CLARIFY_AUTHORITY: "clarify_authority",
  CLARIFY_REQUIRED_SIGNER: "clarify_required_signer",
  HANDLE_AGENT_INVOLVEMENT: "handle_agent_involvement",
  HANDLE_TRUST_CONCERN: "handle_trust_concern",
  HANDLE_PRICE_OBJECTION: "handle_price_objection",
  PREPARE_OFFER: "prepare_offer",
  NEGOTIATE: "negotiate",
  CONTRACT_NEXT_STEP: "contract_next_step",
  FOLLOW_UP_LATER: "follow_up_later",
});

/**
 * EXPLICIT deterministic discovery priority.
 *
 * Rationale for the ordering (highest acquisition value first):
 *   1. asking_price     — sets the entire negotiation frame; without it no
 *                         offer can be positioned at all.
 *   2. property_condition — the single largest input to the repair estimate and
 *                         therefore to the authorized offer band.
 *   3. occupancy        — changes both valuation and closing mechanics.
 *   4. timeline         — determines urgency, follow-up cadence and sequencing.
 *   5. motivation       — refines strategy but never blocks an offer.
 *
 * A fact is only a candidate when its resolution is MISSING. KNOWN and
 * NOT_APPLICABLE facts are structurally unable to be selected, which is what
 * makes duplicate questions impossible rather than merely unlikely.
 */
export const DISCOVERY_PRIORITY = Object.freeze([
  { fact: "asking_price", objective: ACQUISITION_OBJECTIVES.DISCOVER_ASKING_PRICE },
  { fact: "property_condition", objective: ACQUISITION_OBJECTIVES.DISCOVER_CONDITION },
  { fact: "occupancy", objective: ACQUISITION_OBJECTIVES.DISCOVER_OCCUPANCY },
  { fact: "timeline", objective: ACQUISITION_OBJECTIVES.DISCOVER_TIMELINE },
  { fact: "motivation", objective: ACQUISITION_OBJECTIVES.DISCOVER_MOTIVATION },
]);

/** Facts with no canonical extractor are never selected as an objective. */
const UNSUPPORTED_DISCOVERY_REASONS = new Set(["no_canonical_extractor"]);

function build({
  objective,
  reason_code,
  action_type,
  requested_fact = null,
  state,
  human_review = false,
  suppression = false,
  no_reply = false,
  blocked_objective = null,
}) {
  return Object.freeze({
    version: NEXT_BEST_ACTION_VERSION,
    objective,
    reason_code,
    // Transport-shape vocabulary from the existing acquisition-brain registry.
    action_type,
    requested_fact,
    blocked_objective,
    suppression_required: Boolean(suppression),
    no_reply: Boolean(no_reply),
    human_review_required: Boolean(human_review),
    offer_allowed: state.safety.offer_permission === true && !suppression && !human_review,
    contract_progression_allowed:
      state.safety.contract_progression_permission === true && !suppression && !human_review,
    known_facts: state.known_facts,
    missing_facts: state.missing_facts,
    conflicting_facts: state.conflicting_facts,
    authority_block_reason: state.authority.block_reason || null,
  });
}

/**
 * Resolve exactly one canonical acquisition objective for a seller turn.
 *
 * Invariant order (each earlier rule strictly dominates every later one):
 *   A. suppression        — opt-out / wrong number / non-owner / former owner
 *   B. identity           — unknown or conflicting identity cannot act as owner
 *   C. human review       — fail-closed conditions
 *   D. authority          — unresolved signer authority blocks binding progress
 *   E. explicit deferral  — a requested follow-up time is honoured
 *   F. objections         — agent / trust / price objections route to policy
 *   G. interest, then the highest-priority MISSING acquisition fact
 *   H. offer / negotiate / contract
 *
 * The acquisition ladder is ownership → interest → price → condition →
 * occupancy → timeline → motivation, matching the canonical S1–S4 milestones.
 */
export function resolveSellerNextBestAction(conversationState = null) {
  const state = conversationState;
  if (!state || typeof state !== "object" || !state.safety) {
    return build({
      objective: ACQUISITION_OBJECTIVES.HUMAN_REVIEW,
      reason_code: "missing_conversation_state",
      action_type: NBA_ACTION_TYPES.HUMAN_REVIEW,
      human_review: true,
      state: {
        safety: {},
        known_facts: [],
        missing_facts: [],
        conflicting_facts: [],
        authority: {},
      },
    });
  }

  // ── A. Suppression always wins ──────────────────────────────────────────
  if (state.safety.suppression_required) {
    return build({
      objective: ACQUISITION_OBJECTIVES.SUPPRESS,
      reason_code: `suppression_${state.identity.state}`,
      action_type:
        state.intent === "opt_out" ? NBA_ACTION_TYPES.OPT_OUT : NBA_ACTION_TYPES.SUPPRESS,
      state,
      suppression: true,
      no_reply: true,
    });
  }

  // ── B. Identity before acquisition ──────────────────────────────────────
  if (state.identity.state === IDENTITY_STATES.CONFLICTING) {
    return build({
      objective: ACQUISITION_OBJECTIVES.CLARIFY_IDENTITY,
      reason_code: "contradictory_ownership_evidence",
      action_type: NBA_ACTION_TYPES.HUMAN_REVIEW,
      state,
      human_review: true,
    });
  }
  if (state.identity.state === IDENTITY_STATES.REPRESENTATIVE) {
    return build({
      objective: ACQUISITION_OBJECTIVES.CLARIFY_AUTHORITY,
      reason_code: "representative_respondent",
      action_type: NBA_ACTION_TYPES.HUMAN_REVIEW,
      state,
      human_review: true,
    });
  }

  // ── B2. An outstanding offer that the seller rejected ───────────────────
  // Resolved ahead of generic review because the objection is evidence-backed
  // and an outstanding offer is canonical state: the system must never behave
  // as though no offer exists. Review/authority flags are still carried
  // through, so this can select the objective without authorising a send.
  if (state.negotiation.offer_rejected && state.negotiation.offer_already_made) {
    const blocked = state.safety.human_review_required || state.authority.offer_progression_allowed === false;
    return build({
      objective: ACQUISITION_OBJECTIVES.HANDLE_PRICE_OBJECTION,
      reason_code: "prior_offer_rejected",
      action_type: blocked ? NBA_ACTION_TYPES.HUMAN_REVIEW : NBA_ACTION_TYPES.SEND_TEMPLATE,
      state,
      human_review: blocked,
      blocked_objective: blocked ? ACQUISITION_OBJECTIVES.NEGOTIATE : null,
    });
  }

  // ── B3. Explicit deferral / disinterest ─────────────────────────────────
  // Resolved ahead of generic review for the same reason as B2: the seller
  // stated a timing preference, and an immediate qualification objective must
  // never override it. The review flag is carried through, so a low-confidence
  // turn still cannot auto-send — it only stops the objective being wrong.
  if (
    state.interest === INTEREST_STATES.FOLLOW_UP_LATER ||
    state.interest === INTEREST_STATES.NOT_INTERESTED
  ) {
    return build({
      objective: ACQUISITION_OBJECTIVES.FOLLOW_UP_LATER,
      reason_code:
        state.interest === INTEREST_STATES.NOT_INTERESTED
          ? "not_interested_nurture"
          : "seller_requested_later_contact",
      action_type: NBA_ACTION_TYPES.SCHEDULE_FOLLOWUP,
      state,
      human_review: state.safety.human_review_required,
    });
  }

  // ── C. Fail-closed review ───────────────────────────────────────────────
  if (state.safety.human_review_required) {
    return build({
      objective: ACQUISITION_OBJECTIVES.HUMAN_REVIEW,
      reason_code: state.authority.block_reason || "human_review_required",
      action_type: NBA_ACTION_TYPES.HUMAN_REVIEW,
      state,
      human_review: true,
    });
  }

  if (!state.identity.owner_confirmed) {
    return build({
      objective: ACQUISITION_OBJECTIVES.VERIFY_OWNERSHIP,
      reason_code: "ownership_unresolved",
      action_type: NBA_ACTION_TYPES.SEND_TEMPLATE,
      requested_fact: "ownership",
      state,
    });
  }

  // Interest is the S2 milestone and sits ABOVE every acquisition fact: a
  // confirmed owner whose selling interest is still unknown must be asked
  // whether they would consider selling before being asked for a price.
  if (state.interest === INTEREST_STATES.UNCLEAR) {
    return build({
      objective: ACQUISITION_OBJECTIVES.DISCOVER_INTEREST,
      reason_code: "interest_unresolved",
      action_type: NBA_ACTION_TYPES.SEND_TEMPLATE,
      requested_fact: "interest",
      state,
    });
  }

  // ── D. Authority before binding progression ─────────────────────────────
  // Only blocks BINDING progress. Ordinary discovery may continue below when
  // acquisition facts are still outstanding.
  const authorityUnresolved = state.authority.offer_progression_allowed === false;

  // ── F. Objections that change routing ───────────────────────────────────
  if (state.agent_involved) {
    return build({
      objective: ACQUISITION_OBJECTIVES.HANDLE_AGENT_INVOLVEMENT,
      reason_code: `listing_status_${state.listing_status}`,
      action_type: NBA_ACTION_TYPES.HUMAN_REVIEW,
      state,
      human_review: true,
    });
  }
  if (state.trust_concern) {
    return build({
      objective: ACQUISITION_OBJECTIVES.HANDLE_TRUST_CONCERN,
      reason_code: "trust_concern_raised",
      action_type: NBA_ACTION_TYPES.SEND_TEMPLATE,
      state,
    });
  }
  // ── G. Highest-priority MISSING acquisition fact ────────────────────────
  // A KNOWN fact can never be selected: duplicate questions are structurally
  // impossible, not merely discouraged.
  const ambiguousPrice =
    state.acquisition.asking_price?.resolution === FACT_RESOLUTION.MISSING &&
    state.acquisition.asking_price?.clarification_required === true;
  if (ambiguousPrice) {
    return build({
      objective: ACQUISITION_OBJECTIVES.CLARIFY_ASKING_PRICE,
      reason_code: state.acquisition.asking_price.reason || "ambiguous_monetary_statement",
      action_type: NBA_ACTION_TYPES.REQUEST_CLARIFICATION,
      requested_fact: "asking_price",
      state,
    });
  }

  for (const entry of DISCOVERY_PRIORITY) {
    const resolved = state.acquisition[entry.fact];
    if (!resolved || resolved.resolution !== FACT_RESOLUTION.MISSING) continue;
    if (UNSUPPORTED_DISCOVERY_REASONS.has(resolved.reason)) continue;
    // "Just make me an offer" — never re-ask the price the seller declined to
    // name; move to the next-highest unresolved underwriting fact instead.
    if (entry.fact === "asking_price" && state.seller_requests_offer) continue;
    return build({
      objective: entry.objective,
      reason_code: `missing_${entry.fact}`,
      action_type: NBA_ACTION_TYPES.SEND_TEMPLATE,
      requested_fact: entry.fact,
      state,
    });
  }

  // ── H. Binding progression — authority gates every path below ───────────
  if (authorityUnresolved) {
    return build({
      objective:
        state.authority.additional_signers_claimed?.length > 0
          ? ACQUISITION_OBJECTIVES.CLARIFY_REQUIRED_SIGNER
          : ACQUISITION_OBJECTIVES.CLARIFY_AUTHORITY,
      reason_code: state.authority.block_reason || "authority_unresolved",
      action_type: NBA_ACTION_TYPES.HUMAN_REVIEW,
      state,
      human_review: true,
      blocked_objective: ACQUISITION_OBJECTIVES.PREPARE_OFFER,
    });
  }

  if (state.negotiation.offer_accepted) {
    return build({
      objective: ACQUISITION_OBJECTIVES.CONTRACT_NEXT_STEP,
      reason_code: "terms_accepted",
      action_type: NBA_ACTION_TYPES.INITIATE_CONTRACT_ACTION,
      state,
    });
  }
  if (state.negotiation.offer_already_made) {
    return build({
      objective: ACQUISITION_OBJECTIVES.NEGOTIATE,
      reason_code: "offer_outstanding",
      action_type: NBA_ACTION_TYPES.SEND_TEMPLATE,
      state,
    });
  }
  if (state.safety.offer_permission) {
    return build({
      objective: ACQUISITION_OBJECTIVES.PREPARE_OFFER,
      reason_code: "all_offer_prerequisites_satisfied",
      action_type: NBA_ACTION_TYPES.CREATE_OFFER_REVIEW,
      state,
    });
  }

  // Every acquisition fact is known but offer permission is still withheld
  // (typically: no underwriting authority yet). Fail closed to review.
  return build({
    objective: ACQUISITION_OBJECTIVES.HUMAN_REVIEW,
    reason_code: "offer_prerequisites_incomplete",
    action_type: NBA_ACTION_TYPES.HUMAN_REVIEW,
    state,
    human_review: true,
    blocked_objective: ACQUISITION_OBJECTIVES.PREPARE_OFFER,
  });
}

export default resolveSellerNextBestAction;
