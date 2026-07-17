// ─── acquisition-brain/next-best-action-registry.js ────────────────────────
// Canonical next-best-action (NBA) vocabulary and pure resolver.
// Production path will gradually consume this as the single decision authority.

import {
  ACQUISITION_LIFECYCLE_STAGES as S,
  canAdvanceLifecycleStage,
  getLifecycleStage,
  normalizeLifecycleStage,
  recommendStageFromFacts,
} from "./lifecycle-registry.js";

export const NBA_ACTION_TYPES = Object.freeze({
  SEND_TEMPLATE: "send_template",
  REQUEST_CLARIFICATION: "request_clarification",
  SCHEDULE_FOLLOWUP: "schedule_followup",
  RETRY_DELIVERY: "retry_delivery",
  UPDATE_FACTS_ONLY: "update_facts_only",
  ADVANCE_STAGE: "advance_stage",
  REMAIN_IN_STAGE: "remain_in_stage",
  CREATE_OFFER_REVIEW: "create_offer_review",
  INITIATE_CONTRACT_ACTION: "initiate_contract_action",
  INITIATE_DISPOSITION_ACTION: "initiate_disposition_action",
  SUPPRESS: "suppress",
  OPT_OUT: "opt_out",
  HUMAN_REVIEW: "human_review",
  TERMINAL_NO_ACTION: "terminal_no_action",
});

export const NBA_REASON_CODES = Object.freeze({
  OPT_OUT: "opt_out",
  WRONG_PERSON: "wrong_person",
  NOT_INTERESTED: "not_interested",
  HOSTILE_OR_LEGAL: "hostile_or_legal",
  OWNERSHIP_CONFIRMED_ONLY: "ownership_confirmed_only",
  PROPOSAL_REQUESTED: "proposal_requested_advance_to_asking_price",
  REQUEST_ASKING_PRICE: "request_asking_price",
  REQUEST_CONDITION: "request_condition",
  SKIP_ANSWERED_QUESTIONS: "skip_answered_questions",
  STAGE_REQUIREMENTS_UNMET: "stage_requirements_unmet",
  TRANSACTION_STAGE_REQUIRES_EVENT: "transaction_stage_requires_event",
  LOW_CONFIDENCE: "low_confidence",
  AUTHORITY_UNCERTAIN: "authority_uncertain",
  TEMPLATE_USE_CASE: "template_use_case_selected",
  HUMAN_REVIEW_REQUIRED: "human_review_required",
  REMAIN: "remain_in_stage",
});

/** Preferred template use cases by lifecycle stage (first eligible wins). */
export const STAGE_PRIMARY_USE_CASES = Object.freeze({
  [S.OWNERSHIP_CHECK]: "ownership_check",
  [S.INTEREST_PROPOSAL_CONFIRMATION]: "consider_selling",
  [S.ASKING_PRICE]: "seller_asking_price",
  [S.PROPERTY_CONDITION]: "price_high_condition_probe",
  [S.ACTUAL_PROPOSAL]: "offer_reveal_cash",
  [S.FORMAL_CONTRACT]: "contract_information_request",
  [S.DISPOSITION]: null,
  [S.UNDER_CONTRACT_WITH_BUYER]: null,
  [S.ESCROW]: null,
  [S.CLOSED]: null,
});

/**
 * Questions already answered — never re-ask when fact is present.
 */
export const ANSWERED_FACT_TO_USE_CASE = Object.freeze({
  ownership_confirmed: ["ownership_check", "who_is_this"],
  proposal_interest_confirmed: ["consider_selling"],
  seller_requests_proposal: ["consider_selling"],
  asking_price: ["seller_asking_price", "asking_price_follow_up"],
});

function clean(value) {
  return String(value ?? "").trim();
}

function buildNba({
  action_type,
  reason_code,
  stage_before = null,
  stage_after = null,
  required_template_use_case = null,
  missing_facts = [],
  facts_satisfied = [],
  confidence = 1,
  timing_policy = "default",
  human_review = false,
  idempotency_seed = "",
} = {}) {
  const stage_b = normalizeLifecycleStage(stage_before);
  const stage_a = normalizeLifecycleStage(stage_after) || stage_b;
  return Object.freeze({
    action_type,
    reason_code,
    lifecycle_stage_before: stage_b,
    lifecycle_stage_after: stage_a,
    required_template_use_case,
    missing_facts: Object.freeze([...(missing_facts || [])]),
    facts_satisfied: Object.freeze([...(facts_satisfied || [])]),
    confidence: Number(confidence) || 0,
    timing_policy,
    human_review_flag: Boolean(human_review),
    idempotency_key: `nba:${action_type}:${stage_b || "none"}:${stage_a || "none"}:${reason_code}:${clean(idempotency_seed)}`,
  });
}

/**
 * Resolve exactly one canonical next-best action from classification facts.
 * Pure — no I/O, no queue writes.
 *
 * @param {{
 *   facts?: object,
 *   current_stage?: string|null,
 *   classification?: object,
 *   confidence?: number,
 *   inbound_event_id?: string|null,
 *   human_review_required?: boolean,
 * }} input
 */
export function resolveNextBestAction(input = {}) {
  const facts = {
    ...(input.facts && typeof input.facts === "object" ? input.facts : {}),
  };
  const classification = input.classification || {};
  const primary =
    clean(classification.primary_intent || classification.detected_intent || "").toLowerCase();
  const confidence =
    Number(input.confidence ?? classification.confidence ?? facts.confidence ?? 1) || 0;
  const current = normalizeLifecycleStage(
    input.current_stage || classification.current_stage || null,
    S.OWNERSHIP_CHECK
  );
  const seed = clean(input.inbound_event_id || "");

  // ── Terminal compliance ────────────────────────────────────────────────
  if (facts.opt_out === true || primary === "opt_out") {
    return buildNba({
      action_type: NBA_ACTION_TYPES.OPT_OUT,
      reason_code: NBA_REASON_CODES.OPT_OUT,
      stage_before: current,
      stage_after: current,
      confidence: 1,
      timing_policy: "immediate_suppress",
      idempotency_seed: seed,
    });
  }

  if (
    facts.wrong_person === true ||
    facts.wrong_number === true ||
    primary === "wrong_number" ||
    primary === "wrong_person"
  ) {
    return buildNba({
      action_type: NBA_ACTION_TYPES.SUPPRESS,
      reason_code: NBA_REASON_CODES.WRONG_PERSON,
      stage_before: current,
      stage_after: current,
      confidence: 1,
      timing_policy: "immediate_suppress",
      idempotency_seed: seed,
    });
  }

  if (facts.not_interested === true || primary === "not_interested") {
    return buildNba({
      action_type: NBA_ACTION_TYPES.SUPPRESS,
      reason_code: NBA_REASON_CODES.NOT_INTERESTED,
      stage_before: current,
      stage_after: current,
      confidence: Math.max(confidence, 0.9),
      timing_policy: "immediate_suppress",
      idempotency_seed: seed,
    });
  }

  if (
    facts.hostile === true ||
    primary === "hostile_or_legal" ||
    classification.compliance_flag === "litigator"
  ) {
    return buildNba({
      action_type: NBA_ACTION_TYPES.HUMAN_REVIEW,
      reason_code: NBA_REASON_CODES.HOSTILE_OR_LEGAL,
      stage_before: current,
      stage_after: current,
      confidence,
      human_review: true,
      timing_policy: "human_review",
      idempotency_seed: seed,
    });
  }

  if (input.human_review_required === true || facts.human_review_required === true) {
    return buildNba({
      action_type: NBA_ACTION_TYPES.HUMAN_REVIEW,
      reason_code: NBA_REASON_CODES.HUMAN_REVIEW_REQUIRED,
      stage_before: current,
      stage_after: current,
      confidence,
      human_review: true,
      timing_policy: "human_review",
      idempotency_seed: seed,
    });
  }

  if (confidence > 0 && confidence < 0.75) {
    return buildNba({
      action_type: NBA_ACTION_TYPES.HUMAN_REVIEW,
      reason_code: NBA_REASON_CODES.LOW_CONFIDENCE,
      stage_before: current,
      stage_after: current,
      confidence,
      human_review: true,
      timing_policy: "human_review",
      idempotency_seed: seed,
    });
  }

  // Authority / probate complexity → review, do not auto-advance contracts
  if (
    facts.probate === true ||
    facts.estate === true ||
    facts.claimed_authority_unverified === true ||
    facts.entity_type === "trust" ||
    facts.entity_type === "llc"
  ) {
    if (STAGE_PRIMARY_USE_CASES[current] == null || normalizeLifecycleStage(current) === S.FORMAL_CONTRACT) {
      return buildNba({
        action_type: NBA_ACTION_TYPES.HUMAN_REVIEW,
        reason_code: NBA_REASON_CODES.AUTHORITY_UNCERTAIN,
        stage_before: current,
        stage_after: current,
        confidence,
        human_review: true,
        timing_policy: "human_review",
        idempotency_seed: seed,
      });
    }
  }

  // ── Derive stage target from facts ─────────────────────────────────────
  const recommendation = recommendStageFromFacts(facts);
  if (recommendation.terminal) {
    return buildNba({
      action_type:
        recommendation.terminal === "opt_out"
          ? NBA_ACTION_TYPES.OPT_OUT
          : NBA_ACTION_TYPES.SUPPRESS,
      reason_code: recommendation.terminal,
      stage_before: current,
      stage_after: current,
      confidence,
      timing_policy: "immediate_suppress",
      idempotency_seed: seed,
    });
  }

  let stage_after = recommendation.stage || current;
  const gate = canAdvanceLifecycleStage({
    from_stage: current,
    to_stage: stage_after,
    advance_source: "seller_text",
    facts,
  });

  if (!gate.ok && stage_after !== current) {
    // Stay put if skip/advance blocked
    stage_after = current;
  }

  // Transaction-gated stages: never fabricate progress from text
  const afterDef = getLifecycleStage(stage_after);
  if (afterDef && afterDef.seller_text_may_advance === false) {
    return buildNba({
      action_type: NBA_ACTION_TYPES.UPDATE_FACTS_ONLY,
      reason_code: NBA_REASON_CODES.TRANSACTION_STAGE_REQUIRES_EVENT,
      stage_before: current,
      stage_after: current,
      confidence,
      timing_policy: "none",
      idempotency_seed: seed,
    });
  }

  // ── Template selection: skip answered questions ────────────────────────
  let use_case = STAGE_PRIMARY_USE_CASES[stage_after] || null;

  // Strong proposal request while still on S1/S2 → S3 asking price, never re-ask interest
  if (
    facts.seller_requests_proposal === true ||
    facts.proposal_interest_confirmed === true ||
    primary === "asks_offer"
  ) {
    if (facts.ownership_confirmed === true || primary === "asks_offer") {
      stage_after = S.ASKING_PRICE;
      use_case = "seller_asking_price";
    }
  }

  if (facts.ownership_confirmed === true && !facts.seller_requests_proposal && !facts.proposal_interest_confirmed) {
    if (primary === "ownership_confirmed" || !primary) {
      stage_after = S.INTEREST_PROPOSAL_CONFIRMATION;
      use_case = "consider_selling";
    }
  }

  // Never re-select consider_selling if interest already confirmed
  if (
    use_case === "consider_selling" &&
    (facts.proposal_interest_confirmed === true || facts.seller_requests_proposal === true)
  ) {
    use_case = "seller_asking_price";
    stage_after = S.ASKING_PRICE;
  }

  // Never re-select ownership_check if ownership already confirmed
  if (use_case === "ownership_check" && facts.ownership_confirmed === true) {
    use_case = facts.seller_requests_proposal || facts.proposal_interest_confirmed
      ? "seller_asking_price"
      : "consider_selling";
    stage_after =
      use_case === "seller_asking_price"
        ? S.ASKING_PRICE
        : S.INTEREST_PROPOSAL_CONFIRMATION;
  }

  if (!use_case) {
    return buildNba({
      action_type: NBA_ACTION_TYPES.REMAIN_IN_STAGE,
      reason_code: NBA_REASON_CODES.REMAIN,
      stage_before: current,
      stage_after: current,
      confidence,
      timing_policy: "none",
      idempotency_seed: seed,
    });
  }

  const satisfied = [];
  if (facts.ownership_confirmed) satisfied.push("ownership_confirmed");
  if (facts.proposal_interest_confirmed) satisfied.push("proposal_interest_confirmed");
  if (facts.seller_requests_proposal) satisfied.push("seller_requests_proposal");
  if (facts.asking_price) satisfied.push("asking_price");

  const missing = [];
  if (stage_after === S.ASKING_PRICE && !facts.asking_price) missing.push("asking_price");
  if (stage_after === S.PROPERTY_CONDITION && !facts.condition_summary) {
    missing.push("condition_summary");
  }

  const advanced = stage_after !== current;

  return buildNba({
    action_type: NBA_ACTION_TYPES.SEND_TEMPLATE,
    reason_code:
      use_case === "seller_asking_price"
        ? NBA_REASON_CODES.REQUEST_ASKING_PRICE
        : use_case === "consider_selling"
          ? NBA_REASON_CODES.OWNERSHIP_CONFIRMED_ONLY
          : NBA_REASON_CODES.TEMPLATE_USE_CASE,
    stage_before: current,
    stage_after,
    required_template_use_case: use_case,
    missing_facts: missing,
    facts_satisfied: satisfied,
    confidence,
    timing_policy:
      use_case === "seller_asking_price" ? "asking_price_response" : "simple_confirmation",
    idempotency_seed: seed + (advanced ? ":advance" : ":reply"),
  });
}

export default {
  NBA_ACTION_TYPES,
  NBA_REASON_CODES,
  STAGE_PRIMARY_USE_CASES,
  resolveNextBestAction,
};
