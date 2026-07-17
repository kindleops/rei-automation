// ─── acquisition-brain/lifecycle-registry.js ───────────────────────────────
// Canonical Stage 1–10 Acquisition Brain lifecycle.
// Single production authority for stage identity, entry requirements,
// allowed transitions, follow-up policy, and advance-source rules.
// Stages 7–10 require authoritative transaction events — never seller text alone.

function freezeDeep(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) freezeDeep(value[key]);
  return Object.freeze(value);
}

/** @typedef {'seller_text'|'operator'|'system'|'authoritative_event'} AdvanceSource */

export const ACQUISITION_BRAIN_VERSION = "acquisition_brain_lifecycle_v1";

export const ACQUISITION_LIFECYCLE_STAGES = Object.freeze({
  OWNERSHIP_CHECK: "ownership_check",
  INTEREST_PROPOSAL_CONFIRMATION: "interest_proposal_confirmation",
  ASKING_PRICE: "asking_price",
  PROPERTY_CONDITION: "property_condition",
  ACTUAL_PROPOSAL: "actual_proposal",
  FORMAL_CONTRACT: "formal_contract",
  DISPOSITION: "disposition",
  UNDER_CONTRACT_WITH_BUYER: "under_contract_with_buyer",
  ESCROW: "escrow",
  CLOSED: "closed",
});

export const STAGE_NUMBERS = Object.freeze({
  [ACQUISITION_LIFECYCLE_STAGES.OWNERSHIP_CHECK]: 1,
  [ACQUISITION_LIFECYCLE_STAGES.INTEREST_PROPOSAL_CONFIRMATION]: 2,
  [ACQUISITION_LIFECYCLE_STAGES.ASKING_PRICE]: 3,
  [ACQUISITION_LIFECYCLE_STAGES.PROPERTY_CONDITION]: 4,
  [ACQUISITION_LIFECYCLE_STAGES.ACTUAL_PROPOSAL]: 5,
  [ACQUISITION_LIFECYCLE_STAGES.FORMAL_CONTRACT]: 6,
  [ACQUISITION_LIFECYCLE_STAGES.DISPOSITION]: 7,
  [ACQUISITION_LIFECYCLE_STAGES.UNDER_CONTRACT_WITH_BUYER]: 8,
  [ACQUISITION_LIFECYCLE_STAGES.ESCROW]: 9,
  [ACQUISITION_LIFECYCLE_STAGES.CLOSED]: 10,
});

/** Map legacy seller-flow / acquisition labels → canonical 1–10 IDs. */
export const LIFECYCLE_STAGE_ALIASES = Object.freeze({
  ownership_check: ACQUISITION_LIFECYCLE_STAGES.OWNERSHIP_CHECK,
  ownership_confirmation: ACQUISITION_LIFECYCLE_STAGES.OWNERSHIP_CHECK,
  s1: ACQUISITION_LIFECYCLE_STAGES.OWNERSHIP_CHECK,
  consider_selling: ACQUISITION_LIFECYCLE_STAGES.INTEREST_PROPOSAL_CONFIRMATION,
  interest_proposal_confirmation: ACQUISITION_LIFECYCLE_STAGES.INTEREST_PROPOSAL_CONFIRMATION,
  selling_interest: ACQUISITION_LIFECYCLE_STAGES.INTEREST_PROPOSAL_CONFIRMATION,
  offer_interest_confirmation: ACQUISITION_LIFECYCLE_STAGES.INTEREST_PROPOSAL_CONFIRMATION,
  s2: ACQUISITION_LIFECYCLE_STAGES.INTEREST_PROPOSAL_CONFIRMATION,
  asking_price: ACQUISITION_LIFECYCLE_STAGES.ASKING_PRICE,
  seller_asking_price: ACQUISITION_LIFECYCLE_STAGES.ASKING_PRICE,
  seller_price_discovery: ACQUISITION_LIFECYCLE_STAGES.ASKING_PRICE,
  s3: ACQUISITION_LIFECYCLE_STAGES.ASKING_PRICE,
  property_condition: ACQUISITION_LIFECYCLE_STAGES.PROPERTY_CONDITION,
  condition: ACQUISITION_LIFECYCLE_STAGES.PROPERTY_CONDITION,
  condition_probe: ACQUISITION_LIFECYCLE_STAGES.PROPERTY_CONDITION,
  price_high_condition_probe: ACQUISITION_LIFECYCLE_STAGES.PROPERTY_CONDITION,
  s4: ACQUISITION_LIFECYCLE_STAGES.PROPERTY_CONDITION,
  actual_proposal: ACQUISITION_LIFECYCLE_STAGES.ACTUAL_PROPOSAL,
  offer_negotiation: ACQUISITION_LIFECYCLE_STAGES.ACTUAL_PROPOSAL,
  offer_reveal: ACQUISITION_LIFECYCLE_STAGES.ACTUAL_PROPOSAL,
  offer_reveal_cash: ACQUISITION_LIFECYCLE_STAGES.ACTUAL_PROPOSAL,
  s5: ACQUISITION_LIFECYCLE_STAGES.ACTUAL_PROPOSAL,
  formal_contract: ACQUISITION_LIFECYCLE_STAGES.FORMAL_CONTRACT,
  close_handoff: ACQUISITION_LIFECYCLE_STAGES.FORMAL_CONTRACT,
  s6: ACQUISITION_LIFECYCLE_STAGES.FORMAL_CONTRACT,
  disposition: ACQUISITION_LIFECYCLE_STAGES.DISPOSITION,
  s7: ACQUISITION_LIFECYCLE_STAGES.DISPOSITION,
  under_contract_with_buyer: ACQUISITION_LIFECYCLE_STAGES.UNDER_CONTRACT_WITH_BUYER,
  under_contract: ACQUISITION_LIFECYCLE_STAGES.UNDER_CONTRACT_WITH_BUYER,
  s8: ACQUISITION_LIFECYCLE_STAGES.UNDER_CONTRACT_WITH_BUYER,
  escrow: ACQUISITION_LIFECYCLE_STAGES.ESCROW,
  prepared_to_close: ACQUISITION_LIFECYCLE_STAGES.ESCROW,
  s9: ACQUISITION_LIFECYCLE_STAGES.ESCROW,
  closed: ACQUISITION_LIFECYCLE_STAGES.CLOSED,
  s10: ACQUISITION_LIFECYCLE_STAGES.CLOSED,
});

const S = ACQUISITION_LIFECYCLE_STAGES;

/**
 * Authoritative transaction events that may advance Stages 7–10.
 * Seller SMS alone is never sufficient.
 */
export const AUTHORITATIVE_TRANSACTION_EVENTS = Object.freeze({
  DISPOSITION_PACKAGE_CREATED: "disposition_package_created",
  BUYER_SELECTED: "buyer_selected",
  ASSIGNMENT_OR_PURCHASE_CONTRACT_EXECUTED: "assignment_or_purchase_contract_executed",
  TITLE_ESCROW_OPENED: "title_escrow_opened",
  EARNEST_MONEY_CONFIRMED: "earnest_money_confirmed",
  CLOSING_CONFIRMED: "closing_confirmed",
  FUNDS_DISBURSEMENT_CONFIRMED: "funds_disbursement_confirmed",
});

function stageDef(partial) {
  return freezeDeep({
    stage_id: partial.stage_id,
    stage_number: STAGE_NUMBERS[partial.stage_id],
    display_name: partial.display_name,
    entry_requirements: partial.entry_requirements || [],
    supported_facts: partial.supported_facts || [],
    required_facts: partial.required_facts || [],
    optional_facts: partial.optional_facts || [],
    completion_conditions: partial.completion_conditions || [],
    allowed_next_stages: partial.allowed_next_stages || [],
    forbidden_transitions: partial.forbidden_transitions || [],
    next_best_actions: partial.next_best_actions || [],
    reply_use_cases: partial.reply_use_cases || [],
    follow_up_policy: freezeDeep({
      enabled: Boolean(partial.follow_up_policy?.enabled),
      no_reply_delay_days: partial.follow_up_policy?.no_reply_delay_days ?? null,
      max_automated_followups: partial.follow_up_policy?.max_automated_followups ?? 0,
      requires_delivery_confirmation:
        partial.follow_up_policy?.requires_delivery_confirmation !== false,
      use_case: partial.follow_up_policy?.use_case || null,
    }),
    timeout_policy: freezeDeep({
      silence_days: partial.timeout_policy?.silence_days ?? null,
      on_timeout: partial.timeout_policy?.on_timeout || "schedule_followup",
    }),
    human_review_conditions: partial.human_review_conditions || [],
    terminal_outcomes: partial.terminal_outcomes || [],
    /** @type {AdvanceSource[]} */
    advance_sources: partial.advance_sources || ["seller_text", "operator", "system"],
    authoritative_events_required: partial.authoritative_events_required || [],
    seller_text_may_advance: partial.seller_text_may_advance !== false,
  });
}

export const LIFECYCLE_REGISTRY = freezeDeep({
  [S.OWNERSHIP_CHECK]: stageDef({
    stage_id: S.OWNERSHIP_CHECK,
    display_name: "Ownership Check",
    entry_requirements: ["canonical_thread", "contactable_phone"],
    supported_facts: [
      "ownership_confirmed",
      "ownership_denied",
      "wrong_person",
      "family_member",
      "tenant",
      "agent",
      "language",
    ],
    required_facts: [],
    optional_facts: ["property_address_ack"],
    completion_conditions: ["ownership_confirmed === true"],
    allowed_next_stages: [
      S.INTEREST_PROPOSAL_CONFIRMATION,
      S.ASKING_PRICE, // skip when inbound also confirms proposal interest / asks for proposal
    ],
    forbidden_transitions: [
      S.ACTUAL_PROPOSAL,
      S.FORMAL_CONTRACT,
      S.DISPOSITION,
      S.UNDER_CONTRACT_WITH_BUYER,
      S.ESCROW,
      S.CLOSED,
    ],
    next_best_actions: ["send_template", "schedule_followup", "suppress", "human_review"],
    reply_use_cases: ["ownership_check", "who_is_this", "how_got_number"],
    follow_up_policy: {
      enabled: true,
      no_reply_delay_days: 3,
      max_automated_followups: 2,
      requires_delivery_confirmation: true,
      use_case: "ownership_check_follow_up",
    },
    timeout_policy: { silence_days: 3, on_timeout: "schedule_followup" },
    human_review_conditions: ["ownership_conflict", "fraud_indicator"],
    terminal_outcomes: ["wrong_person", "opt_out", "not_interested"],
    advance_sources: ["seller_text", "operator", "system"],
    seller_text_may_advance: true,
  }),

  [S.INTEREST_PROPOSAL_CONFIRMATION]: stageDef({
    stage_id: S.INTEREST_PROPOSAL_CONFIRMATION,
    display_name: "Interest / Proposal Confirmation",
    entry_requirements: ["ownership_confirmed"],
    supported_facts: [
      "proposal_interest_confirmed",
      "seller_requests_proposal",
      "conditional_interest",
      "not_interested",
      "timeline",
      "motivation",
    ],
    required_facts: ["ownership_confirmed"],
    optional_facts: ["timeline", "motivation"],
    completion_conditions: [
      "proposal_interest_confirmed === true || seller_requests_proposal === true",
    ],
    allowed_next_stages: [S.ASKING_PRICE],
    forbidden_transitions: [
      S.OWNERSHIP_CHECK,
      S.FORMAL_CONTRACT,
      S.DISPOSITION,
      S.UNDER_CONTRACT_WITH_BUYER,
      S.ESCROW,
      S.CLOSED,
    ],
    next_best_actions: ["send_template", "schedule_followup", "suppress", "human_review"],
    reply_use_cases: ["consider_selling", "consider_selling_follow_up"],
    follow_up_policy: {
      enabled: true,
      no_reply_delay_days: 3,
      max_automated_followups: 2,
      requires_delivery_confirmation: true,
      use_case: "consider_selling_follow_up",
    },
    timeout_policy: { silence_days: 3, on_timeout: "schedule_followup" },
    human_review_conditions: ["hostile_or_legal", "repeated_objection"],
    terminal_outcomes: ["not_interested", "opt_out"],
    seller_text_may_advance: true,
  }),

  [S.ASKING_PRICE]: stageDef({
    stage_id: S.ASKING_PRICE,
    display_name: "Asking Price",
    entry_requirements: [
      "ownership_confirmed",
      "proposal_interest_confirmed || seller_requests_proposal",
    ],
    supported_facts: [
      "asking_price",
      "acceptable_range",
      "mortgage_debt",
      "price_flexibility",
      "competing_proposals",
    ],
    required_facts: ["ownership_confirmed"],
    optional_facts: ["asking_price", "mortgage_debt"],
    completion_conditions: ["asking_price.value > 0"],
    allowed_next_stages: [S.PROPERTY_CONDITION, S.ACTUAL_PROPOSAL],
    forbidden_transitions: [
      S.OWNERSHIP_CHECK,
      S.DISPOSITION,
      S.UNDER_CONTRACT_WITH_BUYER,
      S.ESCROW,
      S.CLOSED,
    ],
    next_best_actions: [
      "send_template",
      "request_clarification",
      "schedule_followup",
      "human_review",
    ],
    reply_use_cases: ["seller_asking_price", "asking_price_follow_up"],
    follow_up_policy: {
      enabled: true,
      no_reply_delay_days: 4,
      max_automated_followups: 2,
      requires_delivery_confirmation: true,
      use_case: "asking_price_follow_up",
    },
    timeout_policy: { silence_days: 4, on_timeout: "schedule_followup" },
    human_review_conditions: ["price_unparseable", "extreme_anchor"],
    terminal_outcomes: ["not_interested", "opt_out"],
    seller_text_may_advance: true,
  }),

  [S.PROPERTY_CONDITION]: stageDef({
    stage_id: S.PROPERTY_CONDITION,
    display_name: "Property Condition",
    entry_requirements: ["ownership_confirmed"],
    supported_facts: [
      "occupancy",
      "condition_summary",
      "roof",
      "foundation",
      "hvac",
      "plumbing",
      "electrical",
      "repairs",
      "damage",
      "tenant_status",
    ],
    required_facts: ["ownership_confirmed"],
    optional_facts: ["roof", "foundation", "hvac", "repairs", "occupancy"],
    completion_conditions: ["condition_summary present || any major repair disclosed"],
    allowed_next_stages: [S.ACTUAL_PROPOSAL],
    forbidden_transitions: [
      S.OWNERSHIP_CHECK,
      S.DISPOSITION,
      S.UNDER_CONTRACT_WITH_BUYER,
      S.ESCROW,
      S.CLOSED,
    ],
    next_best_actions: ["send_template", "schedule_followup", "human_review"],
    reply_use_cases: [
      "price_high_condition_probe",
      "ask_condition_clarifier",
      "condition_probe",
    ],
    follow_up_policy: {
      enabled: true,
      no_reply_delay_days: 4,
      max_automated_followups: 2,
      requires_delivery_confirmation: true,
      use_case: "condition_follow_up",
    },
    timeout_policy: { silence_days: 4, on_timeout: "schedule_followup" },
    human_review_conditions: ["severe_damage_claim", "safety_issue"],
    terminal_outcomes: ["not_interested", "opt_out"],
    seller_text_may_advance: true,
  }),

  [S.ACTUAL_PROPOSAL]: stageDef({
    stage_id: S.ACTUAL_PROPOSAL,
    display_name: "Actual Proposal",
    entry_requirements: ["ownership_confirmed", "asking_price || underwriting_ready"],
    supported_facts: [
      "proposal_sent",
      "proposal_accepted",
      "proposal_rejected",
      "counter_offer",
      "price_flexibility",
    ],
    required_facts: ["ownership_confirmed"],
    optional_facts: ["asking_price", "condition_summary"],
    completion_conditions: ["proposal_accepted === true || counter_terms_agreed"],
    allowed_next_stages: [S.FORMAL_CONTRACT],
    forbidden_transitions: [
      S.OWNERSHIP_CHECK,
      S.DISPOSITION,
      S.UNDER_CONTRACT_WITH_BUYER,
      S.ESCROW,
      S.CLOSED,
    ],
    next_best_actions: [
      "create_offer_review",
      "send_template",
      "human_review",
      "schedule_followup",
    ],
    reply_use_cases: ["offer_reveal_cash", "counter_offer", "final_offer"],
    follow_up_policy: {
      enabled: true,
      no_reply_delay_days: 2,
      max_automated_followups: 2,
      requires_delivery_confirmation: true,
      use_case: "proposal_review_follow_up",
    },
    timeout_policy: { silence_days: 2, on_timeout: "schedule_followup" },
    human_review_conditions: ["negotiation_deadlock", "legal_threat"],
    terminal_outcomes: ["not_interested", "opt_out", "deal_dead"],
    seller_text_may_advance: true,
  }),

  [S.FORMAL_CONTRACT]: stageDef({
    stage_id: S.FORMAL_CONTRACT,
    display_name: "Formal Contract",
    entry_requirements: ["proposal_accepted || operator_contract_start"],
    supported_facts: [
      "signer_authority",
      "can_execute_alone",
      "additional_signers",
      "entity_type",
      "contract_sent",
      "contract_executed",
    ],
    required_facts: ["ownership_confirmed"],
    optional_facts: ["signer_authority", "entity_type"],
    completion_conditions: ["contract_executed === true"],
    allowed_next_stages: [S.DISPOSITION],
    forbidden_transitions: [S.OWNERSHIP_CHECK, S.INTEREST_PROPOSAL_CONFIRMATION],
    next_best_actions: [
      "initiate_contract_action",
      "send_template",
      "human_review",
      "schedule_followup",
    ],
    reply_use_cases: ["contract_information_request", "close_handoff"],
    follow_up_policy: {
      enabled: true,
      no_reply_delay_days: 2,
      max_automated_followups: 2,
      requires_delivery_confirmation: true,
      use_case: "contract_follow_up",
    },
    timeout_policy: { silence_days: 2, on_timeout: "human_review" },
    human_review_conditions: [
      "probate_uncertainty",
      "trust_llc_signer_uncertainty",
      "disputed_authority",
      "contract_modification_request",
    ],
    terminal_outcomes: ["opt_out", "deal_dead"],
    advance_sources: ["seller_text", "operator", "system", "authoritative_event"],
    seller_text_may_advance: true,
  }),

  [S.DISPOSITION]: stageDef({
    stage_id: S.DISPOSITION,
    display_name: "Disposition",
    entry_requirements: ["contract_executed"],
    supported_facts: ["disposition_package", "buyer_pipeline", "assignment_path"],
    required_facts: ["contract_executed"],
    optional_facts: [],
    completion_conditions: ["disposition_package_created"],
    allowed_next_stages: [S.UNDER_CONTRACT_WITH_BUYER],
    forbidden_transitions: [
      S.OWNERSHIP_CHECK,
      S.INTEREST_PROPOSAL_CONFIRMATION,
      S.ASKING_PRICE,
      S.PROPERTY_CONDITION,
    ],
    next_best_actions: ["initiate_disposition_action", "human_review", "update_facts_only"],
    reply_use_cases: [],
    follow_up_policy: {
      enabled: false,
      no_reply_delay_days: null,
      max_automated_followups: 0,
      requires_delivery_confirmation: true,
    },
    timeout_policy: { silence_days: null, on_timeout: "human_review" },
    human_review_conditions: ["unsupported_transaction_stage_claim"],
    terminal_outcomes: ["deal_dead"],
    advance_sources: ["operator", "system", "authoritative_event"],
    authoritative_events_required: [
      AUTHORITATIVE_TRANSACTION_EVENTS.DISPOSITION_PACKAGE_CREATED,
    ],
    seller_text_may_advance: false,
  }),

  [S.UNDER_CONTRACT_WITH_BUYER]: stageDef({
    stage_id: S.UNDER_CONTRACT_WITH_BUYER,
    display_name: "Under Contract With Buyer",
    entry_requirements: ["buyer_selected", "assignment_or_purchase_contract_executed"],
    supported_facts: ["buyer_id", "assignment_contract", "purchase_contract"],
    required_facts: ["buyer_selected"],
    optional_facts: [],
    completion_conditions: ["assignment_or_purchase_contract_executed"],
    allowed_next_stages: [S.ESCROW],
    forbidden_transitions: [
      S.OWNERSHIP_CHECK,
      S.INTEREST_PROPOSAL_CONFIRMATION,
      S.ASKING_PRICE,
      S.PROPERTY_CONDITION,
      S.ACTUAL_PROPOSAL,
    ],
    next_best_actions: ["update_facts_only", "human_review"],
    reply_use_cases: [],
    follow_up_policy: {
      enabled: false,
      no_reply_delay_days: null,
      max_automated_followups: 0,
      requires_delivery_confirmation: true,
    },
    timeout_policy: { silence_days: null, on_timeout: "human_review" },
    human_review_conditions: ["unsupported_transaction_stage_claim"],
    terminal_outcomes: ["deal_dead"],
    advance_sources: ["operator", "system", "authoritative_event"],
    authoritative_events_required: [
      AUTHORITATIVE_TRANSACTION_EVENTS.BUYER_SELECTED,
      AUTHORITATIVE_TRANSACTION_EVENTS.ASSIGNMENT_OR_PURCHASE_CONTRACT_EXECUTED,
    ],
    seller_text_may_advance: false,
  }),

  [S.ESCROW]: stageDef({
    stage_id: S.ESCROW,
    display_name: "Escrow",
    entry_requirements: ["title_escrow_opened"],
    supported_facts: ["escrow_open", "earnest_money", "closing_date"],
    required_facts: ["title_escrow_opened"],
    optional_facts: ["earnest_money", "closing_date"],
    completion_conditions: ["closing_confirmed"],
    allowed_next_stages: [S.CLOSED],
    forbidden_transitions: [
      S.OWNERSHIP_CHECK,
      S.INTEREST_PROPOSAL_CONFIRMATION,
      S.ASKING_PRICE,
      S.PROPERTY_CONDITION,
      S.ACTUAL_PROPOSAL,
      S.FORMAL_CONTRACT,
    ],
    next_best_actions: ["update_facts_only", "human_review"],
    reply_use_cases: [],
    follow_up_policy: {
      enabled: false,
      no_reply_delay_days: null,
      max_automated_followups: 0,
      requires_delivery_confirmation: true,
    },
    timeout_policy: { silence_days: null, on_timeout: "human_review" },
    human_review_conditions: ["unsupported_transaction_stage_claim", "title_issue"],
    terminal_outcomes: ["deal_dead"],
    advance_sources: ["operator", "system", "authoritative_event"],
    authoritative_events_required: [
      AUTHORITATIVE_TRANSACTION_EVENTS.TITLE_ESCROW_OPENED,
      AUTHORITATIVE_TRANSACTION_EVENTS.EARNEST_MONEY_CONFIRMED,
    ],
    seller_text_may_advance: false,
  }),

  [S.CLOSED]: stageDef({
    stage_id: S.CLOSED,
    display_name: "Closed",
    entry_requirements: ["closing_confirmed", "funds_disbursement_confirmed"],
    supported_facts: ["closed_at", "funds_disbursed"],
    required_facts: ["closing_confirmed"],
    optional_facts: ["funds_disbursement_confirmed"],
    completion_conditions: ["closing_confirmed === true"],
    allowed_next_stages: [],
    forbidden_transitions: Object.values(S).filter((id) => id !== S.CLOSED),
    next_best_actions: ["terminal_no_action"],
    reply_use_cases: [],
    follow_up_policy: {
      enabled: false,
      no_reply_delay_days: null,
      max_automated_followups: 0,
      requires_delivery_confirmation: true,
    },
    timeout_policy: { silence_days: null, on_timeout: "terminal_no_action" },
    human_review_conditions: [],
    terminal_outcomes: ["closed"],
    advance_sources: ["operator", "system", "authoritative_event"],
    authoritative_events_required: [
      AUTHORITATIVE_TRANSACTION_EVENTS.CLOSING_CONFIRMED,
      AUTHORITATIVE_TRANSACTION_EVENTS.FUNDS_DISBURSEMENT_CONFIRMED,
    ],
    seller_text_may_advance: false,
  }),
});

export const ORDERED_LIFECYCLE_STAGES = Object.freeze(
  Object.values(ACQUISITION_LIFECYCLE_STAGES)
);

export function normalizeLifecycleStage(value, fallback = null) {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (!raw) return fallback;
  if (LIFECYCLE_REGISTRY[raw]) return raw;
  if (LIFECYCLE_STAGE_ALIASES[raw]) return LIFECYCLE_STAGE_ALIASES[raw];
  return fallback;
}

export function getLifecycleStage(stage_id) {
  const id = normalizeLifecycleStage(stage_id);
  return id ? LIFECYCLE_REGISTRY[id] || null : null;
}

export function isTransactionGatedStage(stage_id) {
  const stage = getLifecycleStage(stage_id);
  if (!stage) return false;
  return stage.seller_text_may_advance === false;
}

/**
 * Pure transition gate. Does not mutate state.
 * @returns {{ ok: boolean, reason: string, from: string|null, to: string|null }}
 */
export function canAdvanceLifecycleStage({
  from_stage = null,
  to_stage = null,
  advance_source = "seller_text",
  authoritative_events = [],
  facts = {},
} = {}) {
  const from = normalizeLifecycleStage(from_stage);
  const to = normalizeLifecycleStage(to_stage);
  if (!to) {
    return { ok: false, reason: "missing_target_stage", from, to: null };
  }
  if (from === to) {
    return { ok: true, reason: "already_at_stage", from, to };
  }

  const target = getLifecycleStage(to);
  if (!target) {
    return { ok: false, reason: "unknown_target_stage", from, to };
  }

  if (from) {
    const current = getLifecycleStage(from);
    if (!current) {
      return { ok: false, reason: "unknown_source_stage", from, to };
    }
    if (current.forbidden_transitions.includes(to)) {
      return { ok: false, reason: "forbidden_transition", from, to };
    }
    if (!current.allowed_next_stages.includes(to) && STAGE_NUMBERS[to] > STAGE_NUMBERS[from]) {
      // Allow skip only when explicitly listed on source (e.g. S1→S3).
      return { ok: false, reason: "transition_not_allowed", from, to };
    }
  }

  if (!target.advance_sources.includes(advance_source)) {
    return { ok: false, reason: "advance_source_not_permitted", from, to };
  }

  if (target.seller_text_may_advance === false && advance_source === "seller_text") {
    return {
      ok: false,
      reason: "seller_text_cannot_advance_transaction_stage",
      from,
      to,
    };
  }

  if (target.authoritative_events_required?.length) {
    const have = new Set(
      (Array.isArray(authoritative_events) ? authoritative_events : []).map(String)
    );
    const missing = target.authoritative_events_required.filter((e) => !have.has(e));
    // For transaction stages, require at least one listed event when advancing
    // via authoritative_event source; operators may bypass with explicit source.
    if (advance_source === "authoritative_event" && missing.length === target.authoritative_events_required.length) {
      return {
        ok: false,
        reason: "missing_authoritative_events",
        from,
        to,
        missing,
      };
    }
    if (advance_source === "seller_text" && missing.length) {
      return {
        ok: false,
        reason: "missing_authoritative_events",
        from,
        to,
        missing,
      };
    }
  }

  // Soft fact check for early stages only (informational — callers enforce hard gates).
  void facts;

  return { ok: true, reason: "transition_allowed", from, to };
}

/**
 * Given facts from multi-label classification, recommend the furthest
 * justified stage among Stages 1–3 (seller-text path). Never returns 7–10.
 */
export function recommendStageFromFacts(facts = {}) {
  const f = facts && typeof facts === "object" ? facts : {};
  if (f.opt_out === true) return { stage: null, terminal: "opt_out" };
  if (f.wrong_person === true || f.wrong_number === true) {
    return { stage: null, terminal: "wrong_person" };
  }
  if (f.not_interested === true) {
    return { stage: null, terminal: "not_interested" };
  }

  const ownership = f.ownership_confirmed === true;
  const interest =
    f.proposal_interest_confirmed === true || f.seller_requests_proposal === true;
  const hasPrice =
    (f.asking_price && Number(f.asking_price.value || f.asking_price) > 0) ||
    f.asking_price_provided === true;

  if (ownership && interest && hasPrice) {
    return { stage: S.PROPERTY_CONDITION, terminal: null, reason: "price_captured" };
  }
  if (ownership && interest) {
    return { stage: S.ASKING_PRICE, terminal: null, reason: "interest_and_ownership" };
  }
  if (ownership) {
    return {
      stage: S.INTEREST_PROPOSAL_CONFIRMATION,
      terminal: null,
      reason: "ownership_only",
    };
  }
  return { stage: S.OWNERSHIP_CHECK, terminal: null, reason: "default_stage_1" };
}

export default {
  ACQUISITION_BRAIN_VERSION,
  ACQUISITION_LIFECYCLE_STAGES,
  STAGE_NUMBERS,
  LIFECYCLE_REGISTRY,
  ORDERED_LIFECYCLE_STAGES,
  AUTHORITATIVE_TRANSACTION_EVENTS,
  normalizeLifecycleStage,
  getLifecycleStage,
  isTransactionGatedStage,
  canAdvanceLifecycleStage,
  recommendStageFromFacts,
};
