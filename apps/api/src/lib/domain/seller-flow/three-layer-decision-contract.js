/**
 * Three-layer inbound decision contract.
 *
 * Layer A — semantic interpretation (meaning, identity, scope)
 * Layer B — recommended business decision (stage engine authority)
 * Layer C — effective execution result (production controls)
 */

import { normalizeStageLabel } from "@/lib/domain/seller-flow/shadow-stage-transition.js";

export const LAYER_A_FIELDS = Object.freeze([
  "canonical_intent",
  "identity_class",
  "relationship_outcome",
  "suppression_scope",
  "extracted_facts",
  "universal_stage_before_message",
  "event_meaning",
]);

export const LAYER_B_FIELDS = Object.freeze([
  "proposed_next_stage",
  "recommended_action",
  "recommended_use_case",
  "recommended_template",
  "recommended_follow_up_policy",
  "recommended_human_review",
  "recommended_safety_disposition",
  "recommendation_reason",
]);

export const LAYER_C_FIELDS = Object.freeze([
  "execution_allowed",
  "effective_action",
  "execution_blocked_reason",
  "queue_row_created",
  "follow_up_scheduled",
  "provider_call_made",
  "suppression_mutation_applied",
  "audit_only",
  "shadow_only",
]);

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function normalizeFollowUpPolicy(value) {
  const key = lower(value);
  if (!key) return null;
  if (key.includes("review_required_no_schedule") || key === "follow_up_policy_not_approved") {
    return "review_required_no_schedule";
  }
  if (key.includes("active_workflow")) return "active_workflow";
  if (key.includes("referral_source")) return "referral_source_no_nurture";
  if (key.includes("permanent_suppression") || key.includes("suppressed")) return "suppressed";
  if (key.includes("no_followup")) return "no_followup";
  return key;
}

function normalizeField(field, value) {
  if (value === null || value === undefined || value === "") return null;
  switch (field) {
    case "canonical_intent":
    case "identity_class":
    case "relationship_outcome":
    case "suppression_scope":
    case "event_meaning":
    case "recommended_action":
    case "recommended_use_case":
    case "recommended_template":
    case "recommendation_reason":
    case "effective_action":
    case "execution_blocked_reason":
      return lower(value) || null;
    case "universal_stage_before_message":
    case "proposed_next_stage":
      return normalizeStageLabel(value);
    case "recommended_follow_up_policy":
      return normalizeFollowUpPolicy(value);
    case "recommended_safety_disposition":
      return lower(value) || null;
    case "extracted_facts":
      return value;
    case "recommended_human_review":
    case "execution_allowed":
    case "queue_row_created":
    case "follow_up_scheduled":
    case "provider_call_made":
    case "suppression_mutation_applied":
    case "audit_only":
    case "shadow_only":
      return Boolean(value);
    default:
      return value;
  }
}

function fieldsEquivalent(field, left, right) {
  const a = normalizeField(field, left);
  const b = normalizeField(field, right);
  if (field === "extracted_facts") {
    return JSON.stringify(a || {}) === JSON.stringify(b || {});
  }
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a === b;
}

function compareLayer(fields, left = {}, right = {}) {
  const agreement = {};
  const disagreement_fields = [];
  for (const field of fields) {
    const agrees = fieldsEquivalent(field, left[field], right[field]);
    agreement[field] = agrees;
    if (!agrees) disagreement_fields.push(field);
  }
  return {
    agreement,
    disagreement_fields,
    full_agreement: disagreement_fields.length === 0,
  };
}

export function mapSemanticLayer({
  relationship = null,
  classification = null,
  canonical_intent = null,
  context = null,
  route = null,
  extracted_facts = null,
} = {}) {
  const stage_before =
    normalizeStageLabel(
      context?.summary?.conversation_stage || route?.stage || "ownership_confirmation"
    ) || "ownership_confirmation";

  return {
    canonical_intent: lower(canonical_intent || relationship?.canonical_intent || classification?.primary_intent) || "unclear",
    identity_class: lower(relationship?.identity_class) || "unknown",
    relationship_outcome: lower(relationship?.relationship_outcome) || null,
    suppression_scope: lower(relationship?.suppression_scope) || "none",
    extracted_facts: extracted_facts || {},
    universal_stage_before_message: stage_before,
    event_meaning: lower(canonical_intent || relationship?.canonical_intent || classification?.primary_intent) || "unclear",
  };
}

export function mapRecommendationLayer({
  recommendation = null,
  follow_up_recommendation = null,
} = {}) {
  const rec = recommendation || {};
  return {
    proposed_next_stage: rec.proposed_next_stage || null,
    recommended_action: rec.recommended_action || null,
    recommended_use_case: rec.recommended_use_case || null,
    recommended_template: rec.recommended_template || rec.recommended_use_case || null,
    recommended_follow_up_policy:
      rec.recommended_follow_up_policy ||
      follow_up_recommendation?.follow_up_policy ||
      follow_up_recommendation?.reason ||
      null,
    recommended_human_review: Boolean(rec.recommended_human_review),
    recommended_safety_disposition: rec.recommended_safety_disposition || "review",
    recommendation_reason: rec.recommendation_reason || null,
  };
}

export function mapEffectiveExecutionLayer({
  execution_allowed = false,
  execution_blocked_reason = null,
  recommendation = null,
  relationship = null,
} = {}) {
  const blocked = !execution_allowed || relationship?.automatic_send_allowed === false;
  const effective_action = blocked
    ? "shadow_only"
    : lower(recommendation?.recommended_action) || "shadow_only";

  return {
    execution_allowed: Boolean(execution_allowed),
    effective_action,
    execution_blocked_reason: blocked ? clean(execution_blocked_reason) || "execution_gated" : null,
    queue_row_created: false,
    follow_up_scheduled: false,
    provider_call_made: false,
    suppression_mutation_applied: Boolean(
      relationship?.should_suppress_contact && execution_allowed
    ),
    audit_only: blocked,
    shadow_only: blocked,
  };
}

function classifyLayerComparison({
  semantic = null,
  recommendation = null,
  execution = null,
  orchestrator = {},
  stage_engine = {},
} = {}) {
  const semantic_full = semantic?.full_agreement === true;
  const recommendation_full = recommendation?.full_agreement === true;
  const execution_full = execution?.full_agreement === true;

  let comparison_class = "full_agreement";
  const recommendation_material_fields = (recommendation?.disagreement_fields || []).filter(
    (field) => field !== "recommendation_reason"
  );
  const recommendation_materially_disagrees = recommendation_material_fields.length > 0;

  if (!semantic_full && semantic?.disagreement_fields?.length) {
    comparison_class = "material_semantic_disagreement";
  } else if (!recommendation_full && recommendation_materially_disagrees) {
    const review_both =
      orchestrator?.recommendation?.recommended_human_review === true &&
      stage_engine?.recommendation?.recommended_human_review === true;
    if (
      recommendation.disagreement_fields.every((f) =>
        ["recommended_human_review", "recommended_template"].includes(f)
      ) &&
      review_both
    ) {
      comparison_class = "intentionally_review_required";
    } else {
      comparison_class = "material_recommendation_disagreement";
    }
  } else if (!execution_full && execution?.disagreement_fields?.length) {
    const only_block_diff = execution.disagreement_fields.every((f) =>
      ["effective_action", "execution_blocked_reason", "shadow_only", "audit_only"].includes(f)
    );
    comparison_class = only_block_diff
      ? "expected_execution_block_difference"
      : "material_execution_disagreement";
  }

  const insufficient_context =
    [...(semantic?.disagreement_fields || []), ...(recommendation?.disagreement_fields || [])].some(
      (field) => {
        const left = semantic?.left?.[field] ?? recommendation?.left?.[field];
        const right = semantic?.right?.[field] ?? recommendation?.right?.[field];
        return (left === null || right === null) && left !== right;
      }
    );

  if (insufficient_context && comparison_class === "full_agreement") {
    comparison_class = "insufficient_context";
  }

  return {
    comparison_class,
    semantic_full_agreement: semantic_full,
    recommendation_full_agreement: recommendation_full,
    effective_execution_full_agreement: execution_full,
    insufficient_context,
  };
}

export function compareThreeLayerDecisions({
  orchestrator = {},
  stage_engine = {},
} = {}) {
  const semantic = compareLayer(
    LAYER_A_FIELDS,
    orchestrator.semantic || {},
    stage_engine.semantic || {}
  );
  semantic.left = orchestrator.semantic;
  semantic.right = stage_engine.semantic;

  const recommendation = compareLayer(
    LAYER_B_FIELDS,
    orchestrator.recommendation || {},
    stage_engine.recommendation || {}
  );
  recommendation.left = orchestrator.recommendation;
  recommendation.right = stage_engine.recommendation;

  const execution = compareLayer(
    LAYER_C_FIELDS,
    orchestrator.execution || {},
    stage_engine.execution || {}
  );
  execution.left = orchestrator.execution;
  execution.right = stage_engine.execution;

  const classification = classifyLayerComparison({
    semantic,
    recommendation,
    execution,
    orchestrator,
    stage_engine,
  });

  const recommendation_material_fields = (recommendation.disagreement_fields || []).filter(
    (field) => field !== "recommendation_reason"
  );

  return {
    layers: {
      semantic: {
        fields: LAYER_A_FIELDS,
        orchestrator: orchestrator.semantic || {},
        stage_engine: stage_engine.semantic || {},
        agreement: semantic.agreement,
        disagreement_fields: semantic.disagreement_fields,
        full_agreement: semantic.full_agreement,
      },
      recommendation: {
        fields: LAYER_B_FIELDS,
        orchestrator: orchestrator.recommendation || {},
        stage_engine: stage_engine.recommendation || {},
        agreement: recommendation.agreement,
        disagreement_fields: recommendation.disagreement_fields,
        full_agreement: recommendation.full_agreement,
      },
      execution: {
        fields: LAYER_C_FIELDS,
        orchestrator: orchestrator.execution || {},
        stage_engine: stage_engine.execution || {},
        agreement: execution.agreement,
        disagreement_fields: execution.disagreement_fields,
        full_agreement: execution.full_agreement,
      },
    },
    ...classification,
    material_semantic_disagreement_fields: semantic.disagreement_fields,
    material_recommendation_disagreement_fields: recommendation_material_fields,
    material_execution_disagreement_fields: execution.disagreement_fields,
  };
}

export default compareThreeLayerDecisions;