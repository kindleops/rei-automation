// ─── acquisition-brain/shadow-comparison.js ────────────────────────────────
// Normalized comparison vocabulary for legacy seller-flow vs Acquisition Brain.
// Pure, deterministic, no I/O.

import {
  ACQUISITION_LIFECYCLE_STAGES as S,
  isTransactionGatedStage,
  normalizeLifecycleStage,
} from "./lifecycle-registry.js";
import { NBA_ACTION_TYPES } from "./next-best-action-registry.js";

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

export const NORMALIZED_STAGES = Object.freeze({
  OWNERSHIP_CHECK: "ownership_check",
  INTEREST_PROPOSAL: "interest_proposal",
  ASKING_PRICE: "asking_price",
  PROPERTY_CONDITION: "property_condition",
  ACTUAL_PROPOSAL: "actual_proposal",
  FORMAL_CONTRACT: "formal_contract",
  DISPOSITION: "disposition",
  UNDER_CONTRACT_WITH_BUYER: "under_contract_with_buyer",
  ESCROW: "escrow",
  CLOSED: "closed",
  TERMINAL: "terminal",
  HUMAN_REVIEW: "human_review",
  UNKNOWN: "unknown",
});

export const NORMALIZED_ACTIONS = Object.freeze({
  SEND_TEMPLATE: "send_template",
  REQUEST_OWNERSHIP: "request_ownership",
  CONFIRM_INTEREST: "confirm_interest",
  REQUEST_ASKING_PRICE: "request_asking_price",
  REQUEST_CONDITION: "request_condition",
  PREPARE_PROPOSAL: "prepare_proposal",
  PRESENT_PROPOSAL: "present_proposal",
  CONTRACT_ACTION: "contract_action",
  UPDATE_FACTS_ONLY: "update_facts_only",
  SCHEDULE_FOLLOWUP: "schedule_followup",
  SUPPRESS: "suppress",
  OPT_OUT: "opt_out",
  HUMAN_REVIEW: "human_review",
  NO_ACTION: "no_action",
  AUTHORITATIVE_EVENT_REQUIRED: "authoritative_event_required",
  UNKNOWN: "unknown",
});

export const COMPARISON_CATEGORY = Object.freeze({
  EXACT_MATCH: "exact_match",
  COMPATIBLE_MATCH: "compatible_match",
  BRAIN_IMPROVEMENT: "brain_improvement",
  LEGACY_IMPROVEMENT: "legacy_improvement",
  BEHAVIORAL_DIVERGENCE: "behavioral_divergence",
  SAFETY_DIVERGENCE: "safety_divergence",
});

export const DIVERGENCE_REASON_CODES = Object.freeze({
  LEGACY_STAGE_ALIAS: "legacy_stage_alias",
  LEGACY_ACTION_ALIAS: "legacy_action_alias",
  LEGACY_MISSING_ACTION: "legacy_missing_action",
  BRAIN_MISSING_ACTION: "brain_missing_action",
  REDUNDANT_QUESTION_LEGACY: "redundant_question_legacy",
  REDUNDANT_QUESTION_BRAIN: "redundant_question_brain",
  STRONGER_FACT_USED_BY_BRAIN: "stronger_fact_used_by_brain",
  STRONGER_FACT_USED_BY_LEGACY: "stronger_fact_used_by_legacy",
  FACT_NOT_PERSISTED: "fact_not_persisted",
  FACT_NOT_EXTRACTED: "fact_not_extracted",
  STAGE_REQUIREMENT_DISAGREEMENT: "stage_requirement_disagreement",
  AUTHORITY_REQUIREMENT_DISAGREEMENT: "authority_requirement_disagreement",
  TEMPLATE_USE_CASE_DISAGREEMENT: "template_use_case_disagreement",
  TRANSACTION_EVENT_REQUIREMENT: "transaction_event_requirement",
  TERMINAL_STATE_DISAGREEMENT: "terminal_state_disagreement",
  HUMAN_REVIEW_DISAGREEMENT: "human_review_disagreement",
  UNKNOWN_LEGACY_MAPPING: "unknown_legacy_mapping",
  UNKNOWN_BRAIN_MAPPING: "unknown_brain_mapping",
});

const STAGE_ALIASES = Object.freeze({
  ownership_check: NORMALIZED_STAGES.OWNERSHIP_CHECK,
  ownership_confirmation: NORMALIZED_STAGES.OWNERSHIP_CHECK,
  s1: NORMALIZED_STAGES.OWNERSHIP_CHECK,
  consider_selling: NORMALIZED_STAGES.INTEREST_PROPOSAL,
  interest_proposal_confirmation: NORMALIZED_STAGES.INTEREST_PROPOSAL,
  interest_proposal: NORMALIZED_STAGES.INTEREST_PROPOSAL,
  selling_interest: NORMALIZED_STAGES.INTEREST_PROPOSAL,
  s2: NORMALIZED_STAGES.INTEREST_PROPOSAL,
  asking_price: NORMALIZED_STAGES.ASKING_PRICE,
  seller_asking_price: NORMALIZED_STAGES.ASKING_PRICE,
  seller_price_discovery: NORMALIZED_STAGES.ASKING_PRICE,
  s3: NORMALIZED_STAGES.ASKING_PRICE,
  property_condition: NORMALIZED_STAGES.PROPERTY_CONDITION,
  condition: NORMALIZED_STAGES.PROPERTY_CONDITION,
  condition_probe: NORMALIZED_STAGES.PROPERTY_CONDITION,
  price_high_condition_probe: NORMALIZED_STAGES.PROPERTY_CONDITION,
  s4: NORMALIZED_STAGES.PROPERTY_CONDITION,
  actual_proposal: NORMALIZED_STAGES.ACTUAL_PROPOSAL,
  offer_reveal: NORMALIZED_STAGES.ACTUAL_PROPOSAL,
  offer_reveal_cash: NORMALIZED_STAGES.ACTUAL_PROPOSAL,
  offer_negotiation: NORMALIZED_STAGES.ACTUAL_PROPOSAL,
  s5: NORMALIZED_STAGES.ACTUAL_PROPOSAL,
  formal_contract: NORMALIZED_STAGES.FORMAL_CONTRACT,
  close_handoff: NORMALIZED_STAGES.FORMAL_CONTRACT,
  s6: NORMALIZED_STAGES.FORMAL_CONTRACT,
  disposition: NORMALIZED_STAGES.DISPOSITION,
  s7: NORMALIZED_STAGES.DISPOSITION,
  under_contract: NORMALIZED_STAGES.UNDER_CONTRACT_WITH_BUYER,
  under_contract_with_buyer: NORMALIZED_STAGES.UNDER_CONTRACT_WITH_BUYER,
  s8: NORMALIZED_STAGES.UNDER_CONTRACT_WITH_BUYER,
  escrow: NORMALIZED_STAGES.ESCROW,
  prepared_to_close: NORMALIZED_STAGES.ESCROW,
  s9: NORMALIZED_STAGES.ESCROW,
  closed: NORMALIZED_STAGES.CLOSED,
  s10: NORMALIZED_STAGES.CLOSED,
  stop_or_opt_out: NORMALIZED_STAGES.TERMINAL,
  wrong_person: NORMALIZED_STAGES.TERMINAL,
  not_interested: NORMALIZED_STAGES.TERMINAL,
  terminal: NORMALIZED_STAGES.TERMINAL,
  human_review: NORMALIZED_STAGES.HUMAN_REVIEW,
  manual_review: NORMALIZED_STAGES.HUMAN_REVIEW,
});

const TEMPLATE_ALIASES = Object.freeze({
  ownership_check: "ownership_check",
  ownership_confirmation: "ownership_check",
  first_message: "ownership_check",
  consider_selling: "consider_selling",
  consider_selling_follow_up: "consider_selling",
  seller_asking_price: "seller_asking_price",
  asking_price: "seller_asking_price",
  asking_price_follow_up: "seller_asking_price",
  price_high_condition_probe: "condition_probe",
  ask_condition_clarifier: "condition_probe",
  condition_probe: "condition_probe",
  offer_reveal_cash: "offer_reveal_cash",
  counter_offer: "offer_reveal_cash",
  final_offer: "offer_reveal_cash",
  contract_information_request: "contract_information_request",
  close_handoff: "contract_information_request",
  stop_or_opt_out: "opt_out",
  wrong_person: "wrong_number",
  wrong_number: "wrong_number",
  not_interested: "not_interested",
});

/**
 * @returns {{ stage: string, alias_used: boolean, unknown: boolean }}
 */
export function normalizeComparisonStage(raw) {
  if (raw == null || raw === "") {
    return { stage: null, alias_used: false, unknown: false, missing: true };
  }
  const key = lower(raw).replace(/[\s-]+/g, "_");
  if (Object.values(NORMALIZED_STAGES).includes(key)) {
    return { stage: key, alias_used: false, unknown: false, missing: false };
  }
  if (STAGE_ALIASES[key]) {
    return {
      stage: STAGE_ALIASES[key],
      alias_used: true,
      unknown: false,
      missing: false,
    };
  }
  const lifecycle = normalizeLifecycleStage(raw);
  if (lifecycle) {
    const mapped = STAGE_ALIASES[lifecycle] || lifecycle;
    return {
      stage: mapped,
      alias_used: mapped !== key,
      unknown: false,
      missing: false,
    };
  }
  return { stage: NORMALIZED_STAGES.UNKNOWN, alias_used: false, unknown: true, missing: false };
}

/**
 * Map brain action_type + template to normalized action.
 */
export function normalizeBrainAction(brain = {}) {
  const type = clean(brain.action_type || brain.proposed_next_best_action);
  const use = lower(brain.required_template_use_case || brain.template_use_case || "");
  const reason = lower(brain.reason_code || brain.action_reason_code || "");

  if (type === NBA_ACTION_TYPES.OPT_OUT || type === "opt_out") {
    return { action: NORMALIZED_ACTIONS.OPT_OUT, unknown: false, missing: false };
  }
  if (type === NBA_ACTION_TYPES.SUPPRESS || type === "suppress") {
    return { action: NORMALIZED_ACTIONS.SUPPRESS, unknown: false, missing: false };
  }
  if (type === NBA_ACTION_TYPES.HUMAN_REVIEW || type === "human_review") {
    return { action: NORMALIZED_ACTIONS.HUMAN_REVIEW, unknown: false, missing: false };
  }
  if (type === NBA_ACTION_TYPES.SCHEDULE_FOLLOWUP) {
    return { action: NORMALIZED_ACTIONS.SCHEDULE_FOLLOWUP, unknown: false, missing: false };
  }
  if (
    type === NBA_ACTION_TYPES.UPDATE_FACTS_ONLY ||
    type === NBA_ACTION_TYPES.REMAIN_IN_STAGE ||
    type === NBA_ACTION_TYPES.TERMINAL_NO_ACTION
  ) {
    if (reason.includes("transaction") || reason.includes("authoritative")) {
      return {
        action: NORMALIZED_ACTIONS.AUTHORITATIVE_EVENT_REQUIRED,
        unknown: false,
        missing: false,
      };
    }
    return { action: NORMALIZED_ACTIONS.UPDATE_FACTS_ONLY, unknown: false, missing: false };
  }
  if (type === NBA_ACTION_TYPES.INITIATE_CONTRACT_ACTION) {
    return { action: NORMALIZED_ACTIONS.CONTRACT_ACTION, unknown: false, missing: false };
  }
  if (type === NBA_ACTION_TYPES.CREATE_OFFER_REVIEW) {
    return { action: NORMALIZED_ACTIONS.PREPARE_PROPOSAL, unknown: false, missing: false };
  }
  if (type === NBA_ACTION_TYPES.SEND_TEMPLATE || type === NBA_ACTION_TYPES.REQUEST_CLARIFICATION) {
    if (use.includes("ownership") || use === "who_is_this") {
      return { action: NORMALIZED_ACTIONS.REQUEST_OWNERSHIP, unknown: false, missing: false };
    }
    if (use.includes("consider_selling")) {
      return { action: NORMALIZED_ACTIONS.CONFIRM_INTEREST, unknown: false, missing: false };
    }
    if (use.includes("asking_price") || use === "seller_asking_price") {
      return { action: NORMALIZED_ACTIONS.REQUEST_ASKING_PRICE, unknown: false, missing: false };
    }
    if (use.includes("condition") || use.includes("repair")) {
      return { action: NORMALIZED_ACTIONS.REQUEST_CONDITION, unknown: false, missing: false };
    }
    if (use.includes("offer") || use.includes("proposal")) {
      return { action: NORMALIZED_ACTIONS.PRESENT_PROPOSAL, unknown: false, missing: false };
    }
    if (use.includes("contract")) {
      return { action: NORMALIZED_ACTIONS.CONTRACT_ACTION, unknown: false, missing: false };
    }
    return { action: NORMALIZED_ACTIONS.SEND_TEMPLATE, unknown: false, missing: false };
  }
  if (!type) {
    return { action: null, unknown: false, missing: true };
  }
  return { action: NORMALIZED_ACTIONS.UNKNOWN, unknown: true, missing: false };
}

/**
 * Map legacy effective_action / use_case to normalized action.
 * Missing labels are missing — not automatic divergences.
 */
export function normalizeLegacyAction(legacy = {}) {
  const raw_action = lower(
    legacy.effective_action || legacy.action || legacy.queue_action || legacy.next_action || ""
  );
  const use = lower(
    legacy.use_case ||
      legacy.selected_use_case ||
      legacy.required_template_use_case ||
      legacy.template_use_case ||
      legacy.route_hint ||
      ""
  );
  const stage = normalizeComparisonStage(
    legacy.stage_after || legacy.stage || legacy.route_hint || null
  );

  if (!raw_action && !use) {
    return {
      action: null,
      template_use_case: null,
      stage,
      missing_action: true,
      alias_used: false,
      unknown: false,
    };
  }

  let action = null;
  let alias_used = false;
  let unknown = false;

  if (
    raw_action.includes("opt") ||
    use.includes("opt_out") ||
    use === "stop" ||
    use === "stop_or_opt_out"
  ) {
    action = NORMALIZED_ACTIONS.OPT_OUT;
  } else if (
    raw_action.includes("suppress") ||
    raw_action.includes("cancel") ||
    use.includes("wrong") ||
    use === "not_interested"
  ) {
    action = NORMALIZED_ACTIONS.SUPPRESS;
  } else if (
    raw_action.includes("review") ||
    raw_action.includes("manual") ||
    use.includes("manual_review")
  ) {
    action = NORMALIZED_ACTIONS.HUMAN_REVIEW;
  } else if (raw_action.includes("follow")) {
    action = NORMALIZED_ACTIONS.SCHEDULE_FOLLOWUP;
  } else if (
    raw_action.includes("queue") ||
    raw_action.includes("send") ||
    raw_action.includes("reply") ||
    raw_action === "auto_queue"
  ) {
    alias_used = true;
    if (use.includes("ownership") || use === "who_is_this") {
      action = NORMALIZED_ACTIONS.REQUEST_OWNERSHIP;
    } else if (use.includes("consider_selling")) {
      action = NORMALIZED_ACTIONS.CONFIRM_INTEREST;
    } else if (use.includes("asking") || use === "seller_asking_price") {
      action = NORMALIZED_ACTIONS.REQUEST_ASKING_PRICE;
    } else if (use.includes("condition")) {
      action = NORMALIZED_ACTIONS.REQUEST_CONDITION;
    } else if (use.includes("offer") || use.includes("proposal")) {
      action = NORMALIZED_ACTIONS.PRESENT_PROPOSAL;
    } else if (use.includes("contract")) {
      action = NORMALIZED_ACTIONS.CONTRACT_ACTION;
    } else if (!use) {
      action = NORMALIZED_ACTIONS.SEND_TEMPLATE;
      // missing use case but send intent known
    } else {
      action = NORMALIZED_ACTIONS.SEND_TEMPLATE;
    }
  } else if (raw_action && !action) {
    unknown = true;
    action = NORMALIZED_ACTIONS.UNKNOWN;
  }

  const template_use_case = normalizeTemplateUseCase(use);

  return {
    action,
    template_use_case: template_use_case.use_case,
    template_unknown: template_use_case.unknown,
    stage,
    missing_action: !raw_action && !use,
    alias_used,
    unknown,
  };
}

export function normalizeTemplateUseCase(raw) {
  if (!raw) return { use_case: null, unknown: false, missing: true };
  const key = lower(raw).replace(/[\s-]+/g, "_");
  if (TEMPLATE_ALIASES[key]) {
    return {
      use_case: TEMPLATE_ALIASES[key],
      unknown: false,
      missing: false,
      alias_used: TEMPLATE_ALIASES[key] !== key,
    };
  }
  // pass-through known use cases
  if (
    [
      "ownership_check",
      "consider_selling",
      "seller_asking_price",
      "condition_probe",
      "offer_reveal_cash",
      "contract_information_request",
    ].includes(key)
  ) {
    return { use_case: key, unknown: false, missing: false, alias_used: false };
  }
  return { use_case: key, unknown: true, missing: false, alias_used: false };
}

function isSafetyAction(action) {
  return (
    action === NORMALIZED_ACTIONS.OPT_OUT ||
    action === NORMALIZED_ACTIONS.SUPPRESS
  );
}

function isRedundantOwnership(brain_action, facts) {
  return (
    brain_action === NORMALIZED_ACTIONS.REQUEST_OWNERSHIP &&
    facts?.ownership_confirmed === true
  );
}

function isRedundantInterest(brain_action, facts) {
  return (
    brain_action === NORMALIZED_ACTIONS.CONFIRM_INTEREST &&
    (facts?.proposal_interest_confirmed === true || facts?.seller_requests_proposal === true)
  );
}

/**
 * Full structured comparison.
 */
export function compareNormalizedDecisions({
  brain = null,
  legacy = null,
  facts = {},
} = {}) {
  const reasons = [];
  const leg = normalizeLegacyAction(legacy || {});
  const brain_action_n = normalizeBrainAction(brain || {});
  const brain_stage_n = normalizeComparisonStage(
    brain?.lifecycle_stage_after || brain?.proposed_lifecycle_stage_after || null
  );
  const brain_template = normalizeTemplateUseCase(
    brain?.required_template_use_case || brain?.template_use_case || null
  );

  const brain_norm = {
    stage: brain_stage_n.stage,
    action: brain_action_n.action,
    template_use_case: brain_template.use_case,
  };
  const legacy_norm = {
    stage: leg.stage?.stage ?? null,
    action: leg.action,
    template_use_case: leg.template_use_case,
  };

  // ── Safety: transaction stages ─────────────────────────────────────────
  if (
    brain_norm.stage &&
    isTransactionGatedStage(
      brain_norm.stage === NORMALIZED_STAGES.UNDER_CONTRACT_WITH_BUYER
        ? S.UNDER_CONTRACT_WITH_BUYER
        : brain_norm.stage === NORMALIZED_STAGES.DISPOSITION
          ? S.DISPOSITION
          : brain_norm.stage === NORMALIZED_STAGES.ESCROW
            ? S.ESCROW
            : brain_norm.stage === NORMALIZED_STAGES.CLOSED
              ? S.CLOSED
              : brain_norm.stage
    ) &&
    brain_norm.action !== NORMALIZED_ACTIONS.UPDATE_FACTS_ONLY &&
    brain_norm.action !== NORMALIZED_ACTIONS.AUTHORITATIVE_EVENT_REQUIRED &&
    brain_norm.action !== NORMALIZED_ACTIONS.NO_ACTION
  ) {
    reasons.push(DIVERGENCE_REASON_CODES.TRANSACTION_EVENT_REQUIREMENT);
    return finalize(
      COMPARISON_CATEGORY.SAFETY_DIVERGENCE,
      reasons,
      brain_norm,
      legacy_norm,
      true,
      {
        message: "Brain proposed transaction-gated stage without authoritative path",
        facts,
      }
    );
  }

  // ── Safety: terminal disagreement ──────────────────────────────────────
  const brain_safe = isSafetyAction(brain_norm.action);
  const legacy_safe = isSafetyAction(legacy_norm.action);
  const legacy_action_missing = leg.missing_action;

  if (brain_safe && legacy_safe && brain_norm.action !== legacy_norm.action) {
    // opt_out vs suppress both terminal-safe for wrong_number/opt paths
    if (
      (brain_norm.action === NORMALIZED_ACTIONS.OPT_OUT ||
        brain_norm.action === NORMALIZED_ACTIONS.SUPPRESS) &&
      (legacy_norm.action === NORMALIZED_ACTIONS.OPT_OUT ||
        legacy_norm.action === NORMALIZED_ACTIONS.SUPPRESS)
    ) {
      reasons.push(DIVERGENCE_REASON_CODES.LEGACY_ACTION_ALIAS);
      return finalize(
        COMPARISON_CATEGORY.COMPATIBLE_MATCH,
        reasons,
        brain_norm,
        legacy_norm,
        false
      );
    }
    reasons.push(DIVERGENCE_REASON_CODES.TERMINAL_STATE_DISAGREEMENT);
    return finalize(
      COMPARISON_CATEGORY.SAFETY_DIVERGENCE,
      reasons,
      brain_norm,
      legacy_norm,
      true,
      { message: "Terminal action mismatch", facts }
    );
  }

  if (brain_safe && !legacy_safe && !legacy_action_missing) {
    reasons.push(DIVERGENCE_REASON_CODES.TERMINAL_STATE_DISAGREEMENT);
    return finalize(
      COMPARISON_CATEGORY.SAFETY_DIVERGENCE,
      reasons,
      brain_norm,
      legacy_norm,
      true,
      {
        message: "Brain suppress/opt_out but legacy would not",
        facts,
      }
    );
  }

  if (!brain_safe && legacy_safe && !brain_action_n.missing) {
    reasons.push(DIVERGENCE_REASON_CODES.TERMINAL_STATE_DISAGREEMENT);
    return finalize(
      COMPARISON_CATEGORY.SAFETY_DIVERGENCE,
      reasons,
      brain_norm,
      legacy_norm,
      true,
      {
        message: "Legacy suppress/opt_out but Brain would not",
        facts,
      }
    );
  }

  // ── Unknown mappings ───────────────────────────────────────────────────
  if (leg.unknown) reasons.push(DIVERGENCE_REASON_CODES.UNKNOWN_LEGACY_MAPPING);
  if (brain_action_n.unknown) reasons.push(DIVERGENCE_REASON_CODES.UNKNOWN_BRAIN_MAPPING);
  if (brain_stage_n.unknown) reasons.push(DIVERGENCE_REASON_CODES.UNKNOWN_BRAIN_MAPPING);
  if (leg.stage?.unknown) reasons.push(DIVERGENCE_REASON_CODES.UNKNOWN_LEGACY_MAPPING);

  // ── Missing legacy action: not automatic divergence ────────────────────
  if (legacy_action_missing || !legacy_norm.action) {
    reasons.push(DIVERGENCE_REASON_CODES.LEGACY_MISSING_ACTION);
    // If brain is safe-ish send for early stage, treat as compatible when no legacy label
    if (
      brain_norm.action &&
      [
        NORMALIZED_ACTIONS.REQUEST_OWNERSHIP,
        NORMALIZED_ACTIONS.CONFIRM_INTEREST,
        NORMALIZED_ACTIONS.REQUEST_ASKING_PRICE,
        NORMALIZED_ACTIONS.SEND_TEMPLATE,
        NORMALIZED_ACTIONS.UPDATE_FACTS_ONLY,
        NORMALIZED_ACTIONS.SUPPRESS,
        NORMALIZED_ACTIONS.OPT_OUT,
        NORMALIZED_ACTIONS.HUMAN_REVIEW,
      ].includes(brain_norm.action)
    ) {
      return finalize(
        COMPARISON_CATEGORY.COMPATIBLE_MATCH,
        reasons,
        brain_norm,
        legacy_norm,
        false
      );
    }
  }

  // ── Alias notes ────────────────────────────────────────────────────────
  if (leg.alias_used || leg.stage?.alias_used) {
    reasons.push(DIVERGENCE_REASON_CODES.LEGACY_STAGE_ALIAS);
    reasons.push(DIVERGENCE_REASON_CODES.LEGACY_ACTION_ALIAS);
  }

  // ── Redundant questions ────────────────────────────────────────────────
  if (isRedundantOwnership(brain_norm.action, facts)) {
    reasons.push(DIVERGENCE_REASON_CODES.REDUNDANT_QUESTION_BRAIN);
  }
  if (isRedundantInterest(brain_norm.action, facts)) {
    reasons.push(DIVERGENCE_REASON_CODES.REDUNDANT_QUESTION_BRAIN);
  }
  if (isRedundantOwnership(legacy_norm.action, facts)) {
    reasons.push(DIVERGENCE_REASON_CODES.REDUNDANT_QUESTION_LEGACY);
  }
  if (isRedundantInterest(legacy_norm.action, facts)) {
    reasons.push(DIVERGENCE_REASON_CODES.REDUNDANT_QUESTION_LEGACY);
  }

  // ── Exact match ────────────────────────────────────────────────────────
  const stage_same =
    !legacy_norm.stage ||
    !brain_norm.stage ||
    legacy_norm.stage === brain_norm.stage ||
    legacy_norm.stage === NORMALIZED_STAGES.UNKNOWN ||
    brain_norm.stage === NORMALIZED_STAGES.UNKNOWN;

  const action_same =
    !legacy_norm.action ||
    !brain_norm.action ||
    legacy_norm.action === brain_norm.action;

  const template_same =
    !legacy_norm.template_use_case ||
    !brain_norm.template_use_case ||
    legacy_norm.template_use_case === brain_norm.template_use_case;

  if (
    brain_norm.stage &&
    legacy_norm.stage &&
    brain_norm.action &&
    legacy_norm.action &&
    brain_norm.stage === legacy_norm.stage &&
    brain_norm.action === legacy_norm.action &&
    template_same
  ) {
    return finalize(
      COMPARISON_CATEGORY.EXACT_MATCH,
      reasons.filter(
        (r) =>
          r === DIVERGENCE_REASON_CODES.LEGACY_STAGE_ALIAS ||
          r === DIVERGENCE_REASON_CODES.LEGACY_ACTION_ALIAS
      ),
      brain_norm,
      legacy_norm,
      false
    );
  }

  // ── Brain improvement: skips redundant / advances on stronger facts ────
  if (
    reasons.includes(DIVERGENCE_REASON_CODES.REDUNDANT_QUESTION_LEGACY) &&
    !reasons.includes(DIVERGENCE_REASON_CODES.REDUNDANT_QUESTION_BRAIN) &&
    brain_safe === legacy_safe
  ) {
    reasons.push(DIVERGENCE_REASON_CODES.STRONGER_FACT_USED_BY_BRAIN);
    return finalize(
      COMPARISON_CATEGORY.BRAIN_IMPROVEMENT,
      reasons,
      brain_norm,
      legacy_norm,
      false
    );
  }

  // Brain asks asking_price after proposal; legacy stuck on consider_selling
  if (
    brain_norm.action === NORMALIZED_ACTIONS.REQUEST_ASKING_PRICE &&
    legacy_norm.action === NORMALIZED_ACTIONS.CONFIRM_INTEREST &&
    (facts.seller_requests_proposal || facts.proposal_interest_confirmed)
  ) {
    reasons.push(DIVERGENCE_REASON_CODES.STRONGER_FACT_USED_BY_BRAIN);
    reasons.push(DIVERGENCE_REASON_CODES.REDUNDANT_QUESTION_LEGACY);
    return finalize(
      COMPARISON_CATEGORY.BRAIN_IMPROVEMENT,
      reasons,
      brain_norm,
      legacy_norm,
      false
    );
  }

  // ── Compatible: same business objective ────────────────────────────────
  if (action_same && stage_same && brain_safe === legacy_safe) {
    if (!template_same && brain_norm.template_use_case && legacy_norm.template_use_case) {
      reasons.push(DIVERGENCE_REASON_CODES.TEMPLATE_USE_CASE_DISAGREEMENT);
    }
    return finalize(
      COMPARISON_CATEGORY.COMPATIBLE_MATCH,
      reasons,
      brain_norm,
      legacy_norm,
      false
    );
  }

  // Both send-family with different labels
  const send_family = new Set([
    NORMALIZED_ACTIONS.SEND_TEMPLATE,
    NORMALIZED_ACTIONS.REQUEST_OWNERSHIP,
    NORMALIZED_ACTIONS.CONFIRM_INTEREST,
    NORMALIZED_ACTIONS.REQUEST_ASKING_PRICE,
    NORMALIZED_ACTIONS.REQUEST_CONDITION,
    NORMALIZED_ACTIONS.PRESENT_PROPOSAL,
  ]);
  if (
    send_family.has(brain_norm.action) &&
    send_family.has(legacy_norm.action) &&
    brain_safe === legacy_safe
  ) {
    if (brain_norm.action !== legacy_norm.action) {
      // could be improvement or behavioral
      const stage_order = [
        NORMALIZED_STAGES.OWNERSHIP_CHECK,
        NORMALIZED_STAGES.INTEREST_PROPOSAL,
        NORMALIZED_STAGES.ASKING_PRICE,
        NORMALIZED_STAGES.PROPERTY_CONDITION,
      ];
      const bi = stage_order.indexOf(brain_norm.stage);
      const li = stage_order.indexOf(legacy_norm.stage);
      if (bi > li && bi >= 0 && li >= 0) {
        reasons.push(DIVERGENCE_REASON_CODES.STRONGER_FACT_USED_BY_BRAIN);
        return finalize(
          COMPARISON_CATEGORY.BRAIN_IMPROVEMENT,
          reasons,
          brain_norm,
          legacy_norm,
          false
        );
      }
      if (li > bi && bi >= 0 && li >= 0) {
        reasons.push(DIVERGENCE_REASON_CODES.STRONGER_FACT_USED_BY_LEGACY);
        return finalize(
          COMPARISON_CATEGORY.LEGACY_IMPROVEMENT,
          reasons,
          brain_norm,
          legacy_norm,
          false
        );
      }
    }
    reasons.push(DIVERGENCE_REASON_CODES.LEGACY_ACTION_ALIAS);
    return finalize(
      COMPARISON_CATEGORY.COMPATIBLE_MATCH,
      reasons,
      brain_norm,
      legacy_norm,
      false
    );
  }

  // Human review disagreement
  if (
    (brain_norm.action === NORMALIZED_ACTIONS.HUMAN_REVIEW) !==
    (legacy_norm.action === NORMALIZED_ACTIONS.HUMAN_REVIEW)
  ) {
    reasons.push(DIVERGENCE_REASON_CODES.HUMAN_REVIEW_DISAGREEMENT);
  }

  if (!stage_same && brain_norm.stage && legacy_norm.stage) {
    reasons.push(DIVERGENCE_REASON_CODES.STAGE_REQUIREMENT_DISAGREEMENT);
  }
  if (!action_same && brain_norm.action && legacy_norm.action) {
    reasons.push(DIVERGENCE_REASON_CODES.STAGE_REQUIREMENT_DISAGREEMENT);
  }

  return finalize(
    COMPARISON_CATEGORY.BEHAVIORAL_DIVERGENCE,
    reasons,
    brain_norm,
    legacy_norm,
    false
  );
}

function finalize(category, reasons, brain_norm, legacy_norm, safety, evidence = null) {
  return {
    result: category,
    category,
    reason_codes: [...new Set(reasons.filter(Boolean))],
    divergence_reason: reasons.filter(Boolean).join(",") || null,
    safety_divergence: Boolean(safety),
    brain_normalized: brain_norm,
    legacy_normalized: legacy_norm,
    evidence: evidence || null,
  };
}

export default {
  NORMALIZED_STAGES,
  NORMALIZED_ACTIONS,
  COMPARISON_CATEGORY,
  DIVERGENCE_REASON_CODES,
  normalizeComparisonStage,
  normalizeBrainAction,
  normalizeLegacyAction,
  normalizeTemplateUseCase,
  compareNormalizedDecisions,
};
