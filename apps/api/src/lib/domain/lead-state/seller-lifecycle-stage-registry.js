// ─── seller-lifecycle-stage-registry.js ──────────────────────────────────────
// Data-driven rule registry for the canonical ten-stage seller lifecycle.
// ONE registry, not ten controllers: each entry DESCRIBES the deterministic
// behavior implemented by resolve-seller-stage-transition.js (entry
// predicates), the follow-up policy layer, and the Workflow Studio surface —
// and powers validateLifecycleTransition(), the single transition validator
// consulted by the canonical write service.
//
// Hard invariants encoded here (activation spec):
//   • Stages 1–6 are conversation/acquisition driven.
//   • Stages 7–10 advance ONLY on authoritative operational events
//     (contract/disposition/escrow/closing state). A text classifier alone —
//     or any automated writer without authority evidence — must never move a
//     thread into S7+.
//   • Manual operator moves are always allowed and always audited.
//   • Automated moves are monotonic (never regress a stage).

import {
  LIFECYCLE_STAGE_CODES,
  LIFECYCLE_STAGE_ORDER,
  STATE_SOURCE_CODES,
  normalizeLifecycleStage,
} from "@/lib/domain/lead-state/universal-lead-state-registry.js";

export const STAGE_REGISTRY_VERSION = "seller_lifecycle_stage_registry_v1";

const C = LIFECYCLE_STAGE_CODES;

/**
 * Types of authoritative evidence an automated writer may cite to advance a
 * thread into an operational stage (S7–S10). The evidence object travels in
 * patch meta (`authority_evidence: { type, source }`) and is recorded on the
 * audit event.
 */
export const AUTHORITY_EVIDENCE_TYPES = Object.freeze([
  "persisted_deal_state", // resolver consumed contract/disposition/closing state
  "contract_executed", // contract engine / DocuSign webhook
  "buyer_contract_event", // buyers webhook / dispo domain
  "escrow_title_event", // title webhook / closing domain
  "closing_verified", // closings webhook / closing domain
]);

/**
 * Per-stage rule entries. `entry_condition` names the resolver predicate that
 * gates the milestone (resolve-seller-stage-transition.js#firstUnresolvedIdx);
 * `automated_entry` declares what an automated writer needs to move a thread
 * INTO the stage. Workflow metadata drives the Studio display.
 */
export const SELLER_LIFECYCLE_STAGE_REGISTRY = Object.freeze({
  [C.OWNERSHIP_CONFIRMATION]: {
    number: 1,
    entry_condition: "always_first_milestone",
    valid_intents: ["ownership_confirmed", "wrong_number", "wrong_person", "not_interested", "info_request", "who_is_this", "opt_out", "unclear", "non_owner_referral", "property_specific_non_owner", "former_owner_respondent", "tenant_respondent", "property_manager_respondent", "agent_representative_respondent", "co_owner_respondent", "executor_heir_respondent", "entity_representative_respondent", "hostile_or_legal"],
    valid_facts: ["ownership_claim", "authority_claims", "language_claim"],
    allowed_previous: [],
    automated_entry: { allowed: true, requires_authority_evidence: false },
    required_fields: [],
    response_policy: "ownership_check",
    follow_up_policy: "conversation_stage",
    human_review_conditions: ["ambiguous_intent", "contradictory_ownership", "authority_claim"],
    suppression_conditions: ["opt_out", "wrong_number", "wrong_person", "hostile_or_legal"],
    terminal: false,
    workflow: { label: "Ownership Check", short: "S1" },
  },
  [C.OFFER_INTEREST]: {
    number: 2,
    entry_condition: "ownership_resolved",
    valid_intents: ["seller_interested", "latent_interest", "asks_offer", "asking_price_provided", "not_interested", "need_time", "callback_requested", "hostile_or_legal", "opt_out", "unclear"],
    valid_facts: ["interest", "wants_offer", "asking_price", "listing_status", "reason_for_selling"],
    allowed_previous: [C.OWNERSHIP_CONFIRMATION],
    automated_entry: { allowed: true, requires_authority_evidence: false },
    required_fields: ["ownership_status"],
    response_policy: "consider_selling",
    follow_up_policy: "conversation_stage",
    human_review_conditions: ["ambiguous_intent", "hostile_or_legal", "trust_concern"],
    suppression_conditions: ["opt_out", "hostile_or_legal"],
    terminal: false,
    workflow: { label: "Interest / Offer Confirmation", short: "S2" },
  },
  [C.ASKING_PRICE]: {
    number: 3,
    entry_condition: "interest_resolved",
    valid_intents: ["asking_price_provided", "asks_offer", "seller_interested", "need_time", "not_interested", "unclear"],
    valid_facts: ["asking_price", "wants_offer"],
    allowed_previous: [C.OWNERSHIP_CONFIRMATION, C.OFFER_INTEREST],
    automated_entry: { allowed: true, requires_authority_evidence: false },
    required_fields: ["ownership_status", "interest"],
    response_policy: "seller_asking_price",
    follow_up_policy: "conversation_stage",
    human_review_conditions: ["asking_price_needs_clarification"],
    suppression_conditions: ["opt_out", "hostile_or_legal"],
    terminal: false,
    workflow: { label: "Asking Price", short: "S3" },
  },
  [C.PROPERTY_CONDITION]: {
    number: 4,
    entry_condition: "price_resolved",
    valid_intents: ["condition_disclosed", "tenant_occupied", "asking_price_provided", "unclear"],
    valid_facts: ["condition_level", "repairs_summary", "repairs_needed", "occupancy_status", "timeline"],
    allowed_previous: [C.OWNERSHIP_CONFIRMATION, C.OFFER_INTEREST, C.ASKING_PRICE],
    automated_entry: { allowed: true, requires_authority_evidence: false },
    required_fields: ["asking_price_or_wants_offer"],
    response_policy: "condition_probe",
    follow_up_policy: "conversation_stage",
    human_review_conditions: ["condition_refused", "no_repairs_claim_with_repair_evidence"],
    suppression_conditions: ["opt_out", "hostile_or_legal"],
    terminal: false,
    workflow: { label: "Condition", short: "S4" },
  },
  [C.OFFER]: {
    number: 5,
    entry_condition: "condition_resolved",
    valid_intents: ["seller_counter", "asks_offer", "seller_accepts", "seller_rejects", "unclear"],
    valid_facts: ["counter_offer", "negotiation_state"],
    allowed_previous: [C.ASKING_PRICE, C.PROPERTY_CONDITION],
    // Offer amounts come only from ADE/valuation authority (ceiling-clamped);
    // stage entry itself is conversation-driven once facts are resolved.
    automated_entry: { allowed: true, requires_authority_evidence: false },
    required_fields: ["underwriting_authority"],
    response_policy: "offer_reveal_cash",
    follow_up_policy: "negotiation",
    human_review_conditions: ["authority_clamp_triggered", "high_risk_objection"],
    suppression_conditions: ["opt_out", "hostile_or_legal"],
    terminal: false,
    workflow: { label: "Actual Offer", short: "S5" },
  },
  [C.FORMAL_CONTRACT]: {
    number: 6,
    entry_condition: "negotiation_terms_accepted",
    valid_intents: ["asks_contract", "seller_accepts", "unclear"],
    valid_facts: ["contract_state", "authority_claims"],
    allowed_previous: [C.OFFER],
    automated_entry: { allowed: true, requires_authority_evidence: false },
    required_fields: ["accepted_terms"],
    response_policy: "asks_contract",
    follow_up_policy: "signature",
    human_review_conditions: ["authority_claim_unverified", "additional_signers_claimed"],
    suppression_conditions: ["opt_out", "hostile_or_legal"],
    terminal: false,
    workflow: { label: "Formal Contract", short: "S6" },
  },
  [C.UNDER_CONTRACT]: {
    number: 7,
    entry_condition: "contract_executed",
    valid_intents: [],
    valid_facts: ["contract_state"],
    allowed_previous: [C.FORMAL_CONTRACT],
    automated_entry: { allowed: true, requires_authority_evidence: true },
    required_fields: ["executed_contract"],
    response_policy: "close_handoff",
    follow_up_policy: "none",
    human_review_conditions: [],
    suppression_conditions: [],
    terminal: false,
    workflow: { label: "Under Contract", short: "S7" },
  },
  [C.DISPOSITION]: {
    number: 8,
    entry_condition: "disposition_started",
    valid_intents: [],
    valid_facts: ["disposition_state"],
    allowed_previous: [C.UNDER_CONTRACT],
    automated_entry: { allowed: true, requires_authority_evidence: true },
    required_fields: ["disposition_readiness"],
    response_policy: null,
    follow_up_policy: "none",
    human_review_conditions: [],
    suppression_conditions: [],
    terminal: false,
    workflow: { label: "Disposition", short: "S8" },
  },
  [C.PREPARED_TO_CLOSE]: {
    number: 9,
    entry_condition: "closing_ready",
    valid_intents: [],
    valid_facts: ["closing_readiness", "title_issues"],
    allowed_previous: [C.DISPOSITION],
    automated_entry: { allowed: true, requires_authority_evidence: true },
    required_fields: ["escrow_or_title_event"],
    response_policy: null,
    follow_up_policy: "none",
    human_review_conditions: ["title_issue", "probate", "lien", "authority_gap"],
    suppression_conditions: [],
    terminal: false,
    workflow: { label: "Prepared to Close", short: "S9" },
  },
  [C.CLOSED]: {
    number: 10,
    entry_condition: "closing_verified",
    valid_intents: [],
    valid_facts: ["closing_evidence"],
    allowed_previous: LIFECYCLE_STAGE_ORDER.filter((code) => code !== C.CLOSED),
    automated_entry: { allowed: true, requires_authority_evidence: true },
    required_fields: ["verified_closing_event"],
    response_policy: null,
    follow_up_policy: "none",
    human_review_conditions: [],
    suppression_conditions: [],
    terminal: true,
    workflow: { label: "Closed", short: "S10" },
  },
});

const STAGE_INDEX = new Map(LIFECYCLE_STAGE_ORDER.map((code, index) => [code, index]));

export function stageRegistryEntry(code) {
  return SELLER_LIFECYCLE_STAGE_REGISTRY[normalizeLifecycleStage(code)] || null;
}

/** First operational stage index (S7): automated entry requires evidence. */
const FIRST_OPERATIONAL_IDX = STAGE_INDEX.get(C.UNDER_CONTRACT);

function hasValidAuthorityEvidence(evidence) {
  if (!evidence || typeof evidence !== "object") return false;
  return AUTHORITY_EVIDENCE_TYPES.includes(String(evidence.type || "").trim());
}

/**
 * The single lifecycle transition validator (activation spec Mission 5).
 * Every stage mutation through the canonical write service passes here.
 *
 * @returns {{ allowed: boolean, reason: string, registry_version: string }}
 */
export function validateLifecycleTransition({
  from = null,
  to = null,
  change_source = STATE_SOURCE_CODES.MANUAL,
  authority_evidence = null,
} = {}) {
  const registry_version = STAGE_REGISTRY_VERSION;
  const fromCode = from ? normalizeLifecycleStage(from) : null;
  const toCode = normalizeLifecycleStage(to);
  const source = String(change_source || STATE_SOURCE_CODES.MANUAL).toLowerCase();

  // Manual operator moves are always allowed (explicit + audited elsewhere).
  if (source === STATE_SOURCE_CODES.MANUAL) {
    return { allowed: true, reason: "manual_override", registry_version };
  }

  if (fromCode && fromCode === toCode) {
    return { allowed: true, reason: "no_stage_change", registry_version };
  }

  const fromIdx = fromCode ? STAGE_INDEX.get(fromCode) ?? 0 : -1;
  const toIdx = STAGE_INDEX.get(toCode) ?? 0;

  // Automated writers never regress a stage (existing monotonic guard).
  if (fromCode && toIdx < fromIdx) {
    return { allowed: false, reason: "monotonic_stage_guard_blocked_regression", registry_version };
  }

  // Operational stages (S7–S10) require authoritative evidence: a classifier
  // result or automation rule alone can never advance into them.
  if (toIdx >= FIRST_OPERATIONAL_IDX) {
    if (!hasValidAuthorityEvidence(authority_evidence)) {
      return {
        allowed: false,
        reason: "operational_stage_requires_authoritative_event",
        registry_version,
      };
    }
  }

  return { allowed: true, reason: "registry_transition_allowed", registry_version };
}

export default SELLER_LIFECYCLE_STAGE_REGISTRY;
