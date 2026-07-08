import {
  LIFECYCLE_STAGE_CODES,
  OPERATIONAL_STATUS_CODES,
  STATE_SOURCE_CODES,
} from "@/lib/domain/lead-state/universal-lead-state-registry.js";
import { normalizeStageLabel } from "@/lib/domain/seller-flow/shadow-stage-transition.js";

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

export function mapSellerFlowStageToUniversal(stage = null) {
  return mapUniversalStage(stage);
}

function mapUniversalStage(stage = null) {
  const normalized = normalizeStageLabel(stage) || lower(stage);
  const map = {
    ownership_check: LIFECYCLE_STAGE_CODES.OWNERSHIP_CONFIRMATION,
    ownership_confirmation: LIFECYCLE_STAGE_CODES.OWNERSHIP_CONFIRMATION,
    consider_selling: LIFECYCLE_STAGE_CODES.OFFER_INTEREST,
    offer_interest: LIFECYCLE_STAGE_CODES.OFFER_INTEREST,
    asking_price: LIFECYCLE_STAGE_CODES.ASKING_PRICE,
    seller_asking_price: LIFECYCLE_STAGE_CODES.ASKING_PRICE,
    condition_justification: LIFECYCLE_STAGE_CODES.PROPERTY_CONDITION,
    offer_negotiation: LIFECYCLE_STAGE_CODES.OFFER,
    seller_contract: LIFECYCLE_STAGE_CODES.FORMAL_CONTRACT,
  };
  return map[normalized] || normalized || LIFECYCLE_STAGE_CODES.OWNERSHIP_CONFIRMATION;
}

function deriveOperationalStatus({
  ownership_probe = null,
  automation_decision = null,
  execution = null,
  follow_up = null,
} = {}) {
  if (ownership_probe?.operational_status) return ownership_probe.operational_status;
  if (execution?.queued) return OPERATIONAL_STATUS_CODES.SCHEDULED;
  if (follow_up?.followup_created) return OPERATIONAL_STATUS_CODES.SCHEDULED;
  if (automation_decision?.should_mark_human_review) return OPERATIONAL_STATUS_CODES.NEEDS_REVIEW;
  if (automation_decision?.should_queue_reply) return OPERATIONAL_STATUS_CODES.ACTIVE_COMMUNICATION;
  return OPERATIONAL_STATUS_CODES.ACTIVE_COMMUNICATION;
}

function deriveContactability(automation_decision = null, contract = null) {
  if (automation_decision?.should_suppress_contact) {
    const reason = lower(automation_decision.suppression_reason);
    if (reason === "opt_out") return "opted_out";
    if (reason === "wrong_number") return "wrong_number";
    return "do_not_text";
  }
  if (contract?.opt_out_signal) return "opted_out";
  if (contract?.wrong_number_signal) return "wrong_number";
  return "contactable";
}

function deriveExecutionMode(auto_reply_mode = "disabled", execution_allowed = false) {
  if (!execution_allowed) {
    if (auto_reply_mode === "dry_run") return "shadow";
    return auto_reply_mode === "disabled" ? "disabled" : "review_only";
  }
  if (auto_reply_mode === "live_limited") return "full_autopilot";
  if (auto_reply_mode === "internal_only") return "live_limited";
  if (auto_reply_mode === "dry_run") return "shadow";
  return "review_only";
}

/**
 * Build the standardized seller-flow decision object every stage engine path
 * must converge on before persistence and execution.
 */
export function buildSellerFlowDecision({
  contract = null,
  intelligence = null,
  automation_decision = null,
  execution = null,
  follow_up = null,
  stage_before = null,
  auto_reply_mode = "disabled",
  execution_allowed = false,
  selected_participant_id = null,
  selected_sender_number = null,
  transition = null,
} = {}) {
  const snapshot = intelligence?.intelligence_snapshot || {};
  const ownership_probe = contract?.ownership_probe_transition || null;
  const stage_after =
    ownership_probe?.conversation_stage ||
    snapshot.granular_stage ||
    snapshot.universal_stage ||
    automation_decision?.route_hint ||
    stage_before;

  const template_key =
    clean(execution?.selected_template?.use_case) ||
    clean(snapshot.selected_template?.use_case) ||
    clean(automation_decision?.route_hint) ||
    null;

  const immediate_action = execution?.queued
    ? "queue_auto_reply"
    : automation_decision?.next_action || snapshot.reply_recommendation?.next_action || "hold";

  const follow_up_action = follow_up?.followup_created
    ? "schedule_follow_up"
    : follow_up?.reason || snapshot.follow_up_recommendation?.reason || null;

  const execution_mode = deriveExecutionMode(auto_reply_mode, execution_allowed);
  const block_reason =
    snapshot.execution_blocked_reason ||
    (execution_mode !== "full_autopilot" ? execution_mode : null) ||
    null;

  // The deterministic transition resolver is the lifecycle authority when
  // present: stage, temperature, disposition, contactability and next action
  // all come from it. Legacy derivations remain the fallback contract.
  return {
    decision_version: "seller_flow_decision_v1",
    stage_before: transition?.stage_before || mapUniversalStage(stage_before),
    stage_after: transition?.stage_after || mapUniversalStage(stage_after),
    operational_status:
      transition?.operational_status ||
      deriveOperationalStatus({
        ownership_probe,
        automation_decision,
        execution,
        follow_up,
      }),
    temperature:
      transition?.lead_temperature ||
      ownership_probe?.lead_temperature ||
      contract?.raw_classification?.lead_temperature ||
      contract?.raw_classification?.seller_state?.lead_temperature ||
      null,
    disposition:
      transition?.disposition ||
      ownership_probe?.disposition ||
      (contract?.interest_signal === "not_interested" ? "not_interested" : null),
    contactability:
      transition?.contactability_patch?.contactability_status ||
      deriveContactability(automation_decision, contract),
    ownership_state:
      transition?.ownership_patch?.ownership_status || contract?.ownership_signal || "unknown",
    extracted_facts: transition?.facts_patch || contract?.extracted_facts || {},
    immediate_next_action: immediate_action,
    next_action: transition?.next_action || null,
    next_action_due_at: transition?.next_action_due_at || null,
    reasoning_code: transition?.reasoning_code || null,
    ade_action: transition?.ade_action || null,
    review_required: Boolean(transition?.review_required),
    stages_advanced: transition?.stages_advanced ?? null,
    transition,
    follow_up_action,
    template_key,
    selected_participant: selected_participant_id || contract?.participant_id || null,
    selected_sender_number: selected_sender_number || null,
    execution_mode,
    block_reason,
    review_reason: contract?.review_reason || automation_decision?.human_review_reason || null,
    workflow_events: buildWorkflowEvents({
      contract,
      automation_decision,
      ownership_probe,
      stage_before,
      stage_after,
      transition,
    }),
    notification_events: buildNotificationEvents({ contract, automation_decision, execution }),
    rendered_message: execution?.rendered_message_text || null,
    queue_row_id: execution?.queue_row_id || null,
    follow_up_at:
      ownership_probe?.follow_up_at ||
      follow_up?.scheduled_for ||
      (transition?.follow_up?.create ? transition.follow_up.due_at : null) ||
      null,
    persisted_at: new Date().toISOString(),
    intelligence_snapshot: snapshot,
    automation_decision,
    change_source: STATE_SOURCE_CODES.AUTOPILOT,
  };
}

function buildWorkflowEvents({
  contract = null,
  automation_decision = null,
  ownership_probe = null,
  stage_before = null,
  stage_after = null,
  transition = null,
} = {}) {
  const events = [];
  const intent = contract?.normalized_intent;

  for (const type of transition?.workflow_event_types || []) {
    events.push({
      type,
      stage_before: transition.stage_before,
      stage_after: transition.stage_after,
      reasoning_code: transition.reasoning_code,
      next_action: transition.next_action,
      ade_action: transition.ade_action,
    });
  }

  if (intent === "ownership_confirmed" || contract?.ownership_signal === "confirmed") {
    events.push({ type: "OWNER_CONFIRMED", stage_before, stage_after });
  }
  if (ownership_probe) {
    events.push({
      type: "SELLER_NOT_INTERESTED",
      stage_before,
      stage_after,
      ownership_inferred: true,
    });
  }
  if (intent === "seller_interested" || intent === "latent_interest") {
    events.push({ type: "OFFER_INTEREST_CONFIRMED", stage_before, stage_after });
  }
  if (intent === "asking_price_provided") {
    events.push({ type: "SELLER_ASKING_PRICE_CAPTURED", stage_before, stage_after });
  }
  if (intent === "condition_disclosed") {
    events.push({ type: "CONDITION_FACT_CAPTURED", stage_before, stage_after });
  }
  if (contract?.extracted_facts?.referral) {
    events.push({ type: "REFERRAL_DETECTED", referral: contract.extracted_facts.referral });
  }
  if (automation_decision?.should_suppress_contact) {
    events.push({
      type: "AUTOMATION_BLOCKED",
      reason: automation_decision.suppression_reason || automation_decision.audit_reason,
    });
  }
  if (automation_decision?.should_mark_human_review) {
    events.push({
      type: "AUTOMATION_NEEDS_REVIEW",
      reason: automation_decision.human_review_reason || automation_decision.audit_reason,
    });
  }
  const seen = new Set();
  return events.filter((event) => {
    if (seen.has(event.type)) return false;
    seen.add(event.type);
    return true;
  });
}

function buildNotificationEvents({ contract = null, automation_decision = null, execution = null } = {}) {
  const events = [];
  const intent = contract?.normalized_intent;

  if (intent) events.push({ type: "seller_reply", intent });
  if (contract?.ownership_signal === "confirmed") events.push({ type: "ownership_confirmed" });
  if (contract?.ownership_signal === "inferred") events.push({ type: "ownership_inferred" });
  if (contract?.interest_signal === "interested") events.push({ type: "seller_interested" });
  if (contract?.interest_signal === "not_interested") events.push({ type: "seller_not_interested" });
  if (intent === "asking_price_provided") events.push({ type: "asking_price_received" });
  if (intent === "condition_disclosed") events.push({ type: "condition_received" });
  if (contract?.extracted_facts?.referral) events.push({ type: "referral_detected" });
  if (automation_decision?.should_suppress_contact) events.push({ type: "automation_blocked" });
  if (automation_decision?.should_mark_human_review) events.push({ type: "automation_needs_review" });
  if (execution?.queued) events.push({ type: "automatic_reply_sent" });
  if (execution?.queue_result?.ok === false) events.push({ type: "automatic_reply_failed" });
  return events;
}

export function decisionToUniversalLeadStatePatch(decision = {}) {
  const patch = {};
  if (decision.stage_after) patch.lifecycle_stage = decision.stage_after;
  if (decision.operational_status) patch.operational_status = decision.operational_status;
  if (decision.temperature) patch.lead_temperature = decision.temperature;
  if (decision.disposition) patch.disposition = decision.disposition;
  if (decision.contactability) patch.contactability_status = decision.contactability;
  if (decision.follow_up_at) patch.follow_up_at = decision.follow_up_at;
  if (decision.next_action) patch.next_action = decision.next_action;
  if (decision.next_action_due_at) patch.next_action_at = decision.next_action_due_at;
  return patch;
}

export default buildSellerFlowDecision;