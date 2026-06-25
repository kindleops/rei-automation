import {
  applyInboundAutomationDecision,
  selectSafeAutoReplyTemplate,
} from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";
import { resolveContactIdentityClass } from "@/lib/domain/inbox/contact-identity.js";
import { resolveFollowUpPlan } from "@/lib/domain/seller-flow/seller-followup-scheduler.js";
import { extractSellerReferral } from "@/lib/domain/seller-flow/extract-seller-referral.js";
import {
  isGlobalSuppressionRelationship,
  resolveInboundRelationship,
} from "@/lib/domain/seller-flow/resolve-inbound-relationship.js";
import { runShadowStageEngine } from "@/lib/domain/seller-flow/shadow-stage-engine-runner.js";
import { enforceRelationshipTemplatePolicy } from "@/lib/domain/seller-flow/relationship-template-policy.js";
import { resolveStageDomainRecommendation } from "@/lib/domain/seller-flow/stage-domain-recommendation.js";
import {
  mapEffectiveExecutionLayer,
  mapRecommendationLayer,
  mapSemanticLayer,
} from "@/lib/domain/seller-flow/three-layer-decision-contract.js";
import { automationDecisionToLegacyPlan } from "@/lib/domain/seller-flow/inbound-decision-adapters.js";
import { detectInboundConditionOrMotivationIntent } from "@/lib/domain/seller-flow/detect-inbound-condition-intent.js";
import { SELLER_FLOW_STAGES } from "@/lib/domain/seller-flow/canonical-seller-flow.js";
import { info } from "@/lib/logging/logger.js";

const INTELLIGENCE_DECISION_VERSION = "inbound_intelligence_v4_three_layer";
const REQUIRED_SCHEMA_TABLES = Object.freeze([
  "inbound_intelligence_audit",
  "seller_contact_referrals",
  "property_participant_graph",
]);

function clean(value) {
  return String(value ?? "").trim();
}

function deriveUniversalStage(decision = {}, route = null, context = null, relationship = null) {
  if (relationship?.universal_stage) return relationship.universal_stage;
  const route_stage = clean(route?.stage) || clean(context?.summary?.conversation_stage);
  if (decision?.canonical_intent === "ownership_confirmed") return "offer_interest";
  if (decision?.canonical_intent === "condition_disclosed") return "condition_justification";
  if (route_stage) {
    const lower_stage = route_stage.toLowerCase();
    if (lower_stage.includes("condition")) return "condition_justification";
    if (lower_stage.includes("consider")) return "offer_interest";
    if (lower_stage.includes("asking")) return "asking_price";
    return route_stage;
  }
  if (decision?.route_hint) return decision.route_hint;
  return SELLER_FLOW_STAGES.OWNERSHIP_CHECK;
}

function deriveGranularStage(decision = {}, template = null, route = null, relationship = null) {
  if (relationship?.ownership_confirmed) return "consider_selling";
  if (relationship?.referral_detected || decision?.canonical_intent === "non_owner_referral") {
    return "referral_review";
  }
  if (decision?.canonical_intent === "condition_disclosed") return "condition_disclosed";
  if (relationship?.relationship_claim === "spouse_co_owner") return "authorized_spouse";
  if (relationship?.relationship_claim === "executor_heir") return "executor_or_heir";
  if (relationship?.relationship_claim === "llc_representative") return "entity_representative";
  if (relationship?.relationship_claim === "agent") return "agent_representative";
  if (relationship?.relationship_claim === "property_manager") return "property_manager";
  if (relationship?.relationship_claim === "former_owner") return "former_owner";
  if (relationship?.relationship_claim === "tenant") return "tenant_or_occupancy";
  return (
    clean(template?.stage_code) ||
    clean(template?.use_case) ||
    clean(decision?.stage_hint) ||
    clean(route?.use_case) ||
    clean(decision?.route_hint) ||
    null
  );
}

function deriveExecutionBlockedReason({
  auto_reply_mode = "disabled",
  execution_allowed = false,
  decision = null,
  relationship = null,
} = {}) {
  if (execution_allowed && relationship?.automatic_send_allowed !== false) return null;
  if (!execution_allowed) {
    if (auto_reply_mode === "disabled") return "auto_reply_mode_disabled";
    return "execution_gated";
  }
  if (decision?.should_suppress_contact) return decision.suppression_reason || "suppressed";
  if (decision?.should_mark_human_review) return decision.human_review_reason || "human_review_required";
  if (relationship?.human_review_required) return "referral_review_required";
  return "execution_gated";
}

function applyRelationshipOverride(canonical_decision = {}, relationship = null) {
  if (
    !relationship?.relationship_claim &&
    !relationship?.referral_detected &&
    !relationship?.ownership_confirmed &&
    !relationship?.should_suppress_contact
  ) {
    return canonical_decision;
  }

  const overridden = {
    ...canonical_decision,
    canonical_intent: relationship.canonical_intent,
    contact_identity: relationship.identity_class,
    relationship_outcome: relationship.relationship_outcome,
    suppression_scope: relationship.suppression_scope,
    suppression_property_id: relationship.suppression_property_id,
    invalidate_phone_globally: relationship.invalidate_phone_globally,
    invalidate_person_globally: relationship.invalidate_person_globally,
    automatic_send_allowed: relationship.automatic_send_allowed,
    human_review_required: relationship.human_review_required,
    should_mark_human_review: relationship.human_review_required,
    human_review_reason: relationship.human_review_required
      ? relationship.referral_detected
        ? "referral_review_required"
        : relationship.relationship_claim === "spouse_co_owner"
          ? "co_owner_authority_review_required"
          : "property_relationship_review_required"
      : null,
  };

  if (relationship.ownership_confirmed) {
    overridden.should_suppress_contact = false;
    overridden.suppression_reason = null;
    overridden.reply_mode = "recommended";
    overridden.safety_status = relationship.safety_status || "allowed";
    overridden.next_action = "ask_offer_interest";
    overridden.route_hint = "consider_selling";
    overridden.should_mark_human_review = false;
    overridden.human_review_required = false;
  } else if (relationship.is_property_scoped || relationship.referral_detected) {
    overridden.should_suppress_contact = false;
    overridden.suppression_reason = null;
    overridden.reply_mode = "manual_review";
    overridden.safety_status = relationship.safety_status || "review";
    overridden.next_action = "mark_human_review";
    overridden.audit_reason = relationship.referral_detected
      ? "non_owner_referral_property_scoped"
      : "property_specific_non_owner";
  } else if (relationship.is_global_suppression || relationship.should_suppress_contact) {
    overridden.should_suppress_contact = true;
    overridden.suppression_reason =
      relationship.canonical_intent === "hostile_or_legal"
        ? "hostile_or_legal_intent"
        : relationship.canonical_intent === "opt_out"
          ? "opt_out_intent_no_marketing"
          : "wrong_number";
    overridden.safety_status = relationship.safety_status || "suppressed";
    overridden.next_action = "suppress_contact";
    overridden.should_mark_human_review = false;
    overridden.human_review_required = false;
  }

  return overridden;
}

function applyConditionIntentOverride(canonical_decision = {}, condition_signal = null) {
  if (!condition_signal) return canonical_decision;
  return {
    ...canonical_decision,
    canonical_intent: condition_signal.canonical_intent,
    route_hint: condition_signal.granular_stage,
    should_mark_human_review: condition_signal.human_review_required,
    human_review_required: condition_signal.human_review_required,
    next_action: condition_signal.advance_stage ? "queue_auto_reply" : "mark_human_review",
    safety_status: "review",
  };
}

/**
 * Phase A — always-run inbound intelligence.
 * Independent of autopilot mode, emergency stop, and queue controls.
 */
export async function runInboundIntelligencePhase({
  message,
  threadKey,
  propertyId,
  prospectId,
  ownerId,
  phoneId,
  classification,
  conversationBrain = null,
  latestThreadContext = null,
  context = null,
  route = null,
  inboundFrom = "",
  inboundTo = "",
  inboundEventId = null,
  legacy_plan = null,
  auto_reply_mode = "disabled",
  execution_allowed = false,
  supabaseClient = null,
} = {}) {
  const relationship = resolveInboundRelationship({
    message,
    classification,
    source_event_id: inboundEventId,
    source_thread_key: threadKey || inboundFrom,
    source_contact_phone: inboundFrom || threadKey,
    property_id: propertyId,
    master_owner_id: ownerId,
    prospect_id: prospectId,
  });

  const raw_canonical_decision = applyInboundAutomationDecision({
    message,
    threadKey,
    propertyId,
    prospectId,
    ownerId,
    phoneId,
    classification,
    conversationBrain,
    latestThreadContext,
  });

  let canonical_decision = applyRelationshipOverride(raw_canonical_decision, relationship);

  const condition_signal = detectInboundConditionOrMotivationIntent({
    message,
    classifier_intent: canonical_decision.canonical_intent,
    conversation_stage:
      route?.stage || latestThreadContext?.summary?.conversation_stage || null,
  });
  if (condition_signal && canonical_decision.canonical_intent === "unclear") {
    canonical_decision = applyConditionIntentOverride(canonical_decision, condition_signal);
  }

  const stage =
    clean(classification?.stage_hint) ||
    clean(latestThreadContext?.summary?.conversation_stage) ||
    clean(conversationBrain?.conversation_stage) ||
    clean(route?.stage) ||
    null;

  const identity_class =
    relationship.identity_class ||
    resolveContactIdentityClass({
      detected_intent: canonical_decision.canonical_intent || classification?.primary_intent,
      master_owner_id: ownerId || latestThreadContext?.ids?.master_owner_id,
      prospect_id: prospectId || latestThreadContext?.ids?.prospect_id,
      property_id: propertyId || latestThreadContext?.ids?.property_id,
      conversation_stage: stage,
      owner_confirmed: relationship.ownership_confirmed,
      metadata: {
        ...(classification?.metadata || {}),
        relationship_outcome: relationship.relationship_outcome,
        contact_identity: relationship.identity_class,
        owner_confirmed: relationship.ownership_confirmed,
      },
    });

  const referral = extractSellerReferral({
    message,
    classification,
    relationship,
    source_event_id: inboundEventId,
    source_thread_key: threadKey || inboundFrom,
    source_contact_phone: inboundFrom || threadKey,
    property_id: propertyId,
    master_owner_id: ownerId,
    prospect_id: prospectId,
  });

  const template_result =
    relationship.is_property_scoped && !relationship.ownership_confirmed
      ? { ok: false, reason: "property_scoped_non_owner_no_auto_template", template: null }
      : await selectSafeAutoReplyTemplate({
          supabaseClient,
          classification,
          decision: canonical_decision,
          context: context || latestThreadContext,
        });

  const universal_stage = deriveUniversalStage(
    canonical_decision,
    route,
    latestThreadContext,
    relationship
  );
  const granular_stage = deriveGranularStage(
    canonical_decision,
    template_result?.template,
    route,
    relationship
  );

  const relationship_template = enforceRelationshipTemplatePolicy({
    relationship,
    canonical_intent: canonical_decision.canonical_intent,
    granular_stage,
    template_use_case:
      clean(template_result?.template?.use_case) || canonical_decision.route_hint || null,
  });

  let recommended_use_case = relationship_template.blocked
    ? relationship_template.use_case
    : clean(template_result?.template?.use_case) || canonical_decision.route_hint || null;

  if (relationship_template.blocked && relationship_template.use_case) {
    canonical_decision = {
      ...canonical_decision,
      route_hint: relationship_template.use_case,
      next_action: "mark_human_review",
      should_queue_reply: false,
      reply_mode: "manual_review",
    };
  }

  const follow_up_suppressed = Boolean(
    canonical_decision.should_suppress_contact ||
      isGlobalSuppressionRelationship(relationship) ||
      ["opt_out", "hostile_or_legal"].includes(canonical_decision.canonical_intent)
  );

  const follow_up_recommendation = resolveFollowUpPlan(
    canonical_decision.canonical_intent || classification?.primary_intent || "unclear",
    {
      thread_key: threadKey || inboundFrom,
      is_suppressed: follow_up_suppressed,
      property_scoped_only: relationship.is_property_scoped,
      property_id: propertyId,
      referrals: referral.referrals || [],
    }
  );

  const semantic_intent = canonical_decision.canonical_intent || "unclear";

  const stage_domain = resolveStageDomainRecommendation({
    message,
    classification,
    context: context || latestThreadContext,
    relationship,
    semantic_intent,
    follow_up_recommendation,
    route,
  });

  const domain_recommendation = stage_domain.recommendation;
  recommended_use_case = domain_recommendation.recommended_use_case || recommended_use_case;
  const authoritative_universal_stage =
    domain_recommendation.proposed_next_stage || universal_stage;
  const authoritative_granular_stage =
    stage_domain.engine_result?.stage_decision?.next_stage || granular_stage;

  const execution_blocked_reason = deriveExecutionBlockedReason({
    auto_reply_mode,
    execution_allowed,
    decision: canonical_decision,
    relationship,
  });

  const recommendation_layer = mapRecommendationLayer({
    recommendation: domain_recommendation,
    follow_up_recommendation,
  });

  const semantic_layer = mapSemanticLayer({
    relationship,
    classification,
    canonical_intent: semantic_intent,
    context: context || latestThreadContext,
    route,
    extracted_facts: {
      referrals: referral.referrals || [],
      asking_price: stage_domain.engine_result?.stage_decision?.seller_asking_price ?? null,
      offer_band: stage_domain.engine_result?.stage_decision?.offer_band ?? null,
    },
  });

  const effective_execution_layer = mapEffectiveExecutionLayer({
    execution_allowed,
    execution_blocked_reason,
    recommendation: recommendation_layer,
    relationship,
  });

  const shadow_stage = runShadowStageEngine({
    message,
    classification,
    context: context || latestThreadContext,
    canonical_decision,
    legacy_decision: legacy_plan,
    relationship,
    identity_class,
    relationship_outcome: relationship.relationship_outcome,
    suppression_scope: relationship.suppression_scope,
    universal_stage: authoritative_universal_stage,
    granular_stage: authoritative_granular_stage,
    follow_up_recommendation,
    recommended_use_case,
    human_review_required: recommendation_layer.recommended_human_review,
    route,
    referral,
    orchestrator_recommendation: domain_recommendation,
    execution_allowed,
    execution_blocked_reason,
    extracted_facts: semantic_layer.extracted_facts,
  });

  const human_review_required = Boolean(recommendation_layer.recommended_human_review);

  const intelligence_snapshot = {
    decision_version: INTELLIGENCE_DECISION_VERSION,
    phase: "intelligence",
    canonical_intent: canonical_decision.canonical_intent || "unclear",
    classification_confidence:
      typeof classification?.confidence === "number" ? classification.confidence : null,
    identity_class,
    relationship_outcome: relationship.relationship_outcome,
    relationship_claim: relationship.relationship_claim,
    suppression_scope: relationship.suppression_scope || "none",
    suppression_property_id: relationship.suppression_property_id || null,
    invalidate_phone_globally: Boolean(relationship.invalidate_phone_globally),
    invalidate_person_globally: Boolean(relationship.invalidate_person_globally),
    referred_contact_proposed_stage: relationship.referred_contact_proposed_stage || null,
    automatic_send_allowed: Boolean(relationship.automatic_send_allowed),
    universal_stage: authoritative_universal_stage,
    granular_stage: authoritative_granular_stage,
    safety_status: recommendation_layer.recommended_safety_disposition || "review",
    decision_layers: {
      semantic: semantic_layer,
      recommendation: recommendation_layer,
      execution: effective_execution_layer,
    },
    stage_authority: stage_domain.authority,
    reply_recommendation: {
      should_queue_reply: false,
      reply_mode: "shadow_only",
      route_hint: recommendation_layer.recommended_use_case || null,
      next_action: recommendation_layer.recommended_action || null,
      scheduled_next_action: canonical_decision.scheduled_next_action || null,
    },
    selected_template: template_result?.ok
      ? {
          template_id: template_result.template?.template_id || template_result.template?.id || null,
          use_case: template_result.template?.use_case || null,
          stage_code: template_result.template?.stage_code || null,
          language: template_result.template?.language || null,
          safe_for_auto_reply: template_result.template?.safe_for_auto_reply === true,
        }
      : null,
    recommended_use_case,
    automation_execution_status: execution_allowed ? "execution_eligible" : "shadow_only",
    execution_blocked_reason,
    human_review_required,
    human_review_status: human_review_required
      ? relationship.referral_detected
        ? "referral_review_required"
        : canonical_decision.human_review_reason || "review_required"
      : "not_required",
    referral_detected: Boolean(referral.referral_detected),
    referral,
    follow_up_recommendation: {
      ...follow_up_recommendation,
      shadow_only: true,
      dispatchable: false,
      property_scoped_suppression: relationship.is_property_scoped,
    },
    canonical_decision,
    legacy_decision: legacy_plan || null,
    shadow_stage_engine: shadow_stage,
    shadow_comparison: shadow_stage.three_layer_comparison || shadow_stage.comparison || null,
    three_layer_comparison: shadow_stage.three_layer_comparison || null,
    schema_dependency: {
      required_tables: REQUIRED_SCHEMA_TABLES,
      status: "unverified_until_persist",
      deployment_order: "schema_before_code_or_explicit_degraded_diagnostics",
    },
    source_event_id: clean(inboundEventId) || null,
    source_thread_key: clean(threadKey) || clean(inboundFrom) || null,
    created_at: new Date().toISOString(),
  };

  const seller_stage_reply_plan = automationDecisionToLegacyPlan({
    decision: canonical_decision,
    classification: {
      ...classification,
      primary_intent: canonical_decision.canonical_intent,
    },
    selectedTemplate: template_result?.template || null,
    renderedMessageText: null,
  });

  if (!process.env.INBOUND_INTELLIGENCE_PROOF_MODE) {
    info("[INBOUND_INTELLIGENCE_PHASE]", {
      thread_key: threadKey || null,
      source_event_id: inboundEventId || null,
      canonical_intent: intelligence_snapshot.canonical_intent,
      identity_class: intelligence_snapshot.identity_class,
      suppression_scope: intelligence_snapshot.suppression_scope,
      universal_stage: intelligence_snapshot.universal_stage,
      safety_status: intelligence_snapshot.safety_status,
      execution_blocked_reason,
      referral_detected: intelligence_snapshot.referral_detected,
      shadow_comparison_class: shadow_stage.comparison?.comparison_class,
    });
  }

  return {
    ok: true,
    intelligence_snapshot,
    canonical_decision,
    seller_stage_reply: {
      ok: true,
      queued: false,
      handled: true,
      reason: execution_blocked_reason || "intelligence_only",
      plan: seller_stage_reply_plan,
      brain_stage: intelligence_snapshot.granular_stage,
      automation_decision: canonical_decision,
      intelligence_snapshot,
    },
    template_result,
    referral,
    shadow_stage,
    follow_up_recommendation: intelligence_snapshot.follow_up_recommendation,
  };
}

export default runInboundIntelligencePhase;