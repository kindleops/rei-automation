import { SELLER_FLOW_STAGES } from "@/lib/domain/seller-flow/canonical-seller-flow.js";
import { classifyStage2OfferInterest } from "@/lib/domain/seller-flow/stage2-offer-interest-engine.js";
import { classifyStage3AskingPrice } from "@/lib/domain/seller-flow/stage3-asking-price-engine.js";
import { classifyStage4Condition } from "@/lib/domain/seller-flow/stage4-condition-justification-engine.js";
import { classifyStage5Negotiation } from "@/lib/domain/seller-flow/stage5-offer-negotiation-engine.js";
import { classifyStage6Contract } from "@/lib/domain/seller-flow/stage6-seller-contract-engine.js";
import { resolveDeterministicStageTransition } from "@/lib/domain/seller-flow/deterministic-stage-map.js";
import {
  compareNormalizedDecisionShapes,
  mapCanonicalToComparisonShape,
  mapShadowToComparisonShape,
} from "@/lib/domain/seller-flow/shadow-comparison-contract.js";
import {
  compareTransitionShapes,
  mapCanonicalTransitionShape,
  mapShadowTransitionShape,
} from "@/lib/domain/seller-flow/shadow-stage-transition.js";
import { enforceRelationshipTemplatePolicy } from "@/lib/domain/seller-flow/relationship-template-policy.js";

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function normalizeUniversalStage(stage = null) {
  const value = lower(stage);
  if (!value) return "ownership_confirmation";
  if (value === "offer_interest" || value.includes("consider")) return "offer_interest";
  if (value.includes("ownership") || value === "s1" || value === SELLER_FLOW_STAGES.OWNERSHIP_CHECK) {
    return "ownership_confirmation";
  }
  if (value.includes("asking") || value === "s3" || value === SELLER_FLOW_STAGES.ASKING_PRICE) {
    return "asking_price";
  }
  if (value.includes("condition") || value.includes("basics") || value === "s4") {
    return "condition_justification";
  }
  if (value.includes("negotiat") || value === "s5") {
    return "offer_negotiation";
  }
  if (value.includes("contract") || value.includes("close") || value === "s6") {
    return "seller_contract";
  }
  return value;
}

function resolveShadowInboundIntent({
  classification = null,
  canonical_decision = null,
  relationship = null,
} = {}) {
  return (
    clean(relationship?.canonical_intent) ||
    clean(canonical_decision?.canonical_intent) ||
    clean(classification?.primary_intent || classification?.detected_intent) ||
    "unclear"
  );
}

function applyRelationshipPolicyToShadow(shadow, { relationship, canonical_decision, granular_stage }) {
  const policy = enforceRelationshipTemplatePolicy({
    relationship,
    canonical_intent: canonical_decision?.canonical_intent,
    granular_stage,
    template_use_case: shadow.proposed_decision?.template_use_case,
  });
  if (!policy.blocked && !policy.use_case) return shadow;
  return {
    ...shadow,
    granular_stage: policy.stage_code || shadow.granular_stage,
    proposed_decision: {
      ...shadow.proposed_decision,
      template_use_case: policy.use_case || null,
      next_stage: policy.stage_code || shadow.proposed_decision?.next_stage,
      should_queue_reply: false,
      policy_source: policy.reason || "relationship_template_policy",
    },
  };
}

function runStage1Shadow({
  message,
  classification,
  context,
  canonical_decision = null,
  relationship = null,
} = {}) {
  const intent = resolveShadowInboundIntent({
    classification,
    canonical_decision,
    relationship,
  });

  const stage_decision = resolveDeterministicStageTransition({
    current_stage: context?.summary?.conversation_stage || SELLER_FLOW_STAGES.OWNERSHIP_CHECK,
    inbound_intent: intent,
    should_queue_reply: false,
    autopilot_enabled: false,
  });

  const universal_stage =
    relationship?.universal_stage ||
    (intent === "ownership_confirmed" ? "offer_interest" : "ownership_confirmation");

  return {
    engine: "stage1_ownership_shadow",
    universal_stage,
    granular_stage: stage_decision?.next_stage || SELLER_FLOW_STAGES.OWNERSHIP_CHECK,
    proposed_decision: {
      ...stage_decision,
      inbound_intent: intent,
      identity_class: relationship?.identity_class || null,
      relationship_outcome: relationship?.relationship_outcome || null,
      suppression_scope: relationship?.suppression_scope || "none",
    },
    proposed_lifecycle_events: [
      {
        event_type: "stage1_shadow_evaluated",
        intent,
        next_stage: stage_decision?.next_stage || null,
      },
    ],
    execution_authority: false,
  };
}

function runStageEngine(universal_stage, input) {
  switch (universal_stage) {
    case "ownership_confirmation":
      return runStage1Shadow(input);
    case "offer_interest":
      return {
        engine: "stage2_offer_interest_shadow",
        universal_stage,
        granular_stage: SELLER_FLOW_STAGES.CONSIDER_SELLING,
        proposed_decision: classifyStage2OfferInterest(input),
        proposed_lifecycle_events: [{ event_type: "stage2_shadow_evaluated" }],
        execution_authority: false,
      };
    case "asking_price":
      return {
        engine: "stage3_asking_price_shadow",
        universal_stage,
        granular_stage: SELLER_FLOW_STAGES.ASKING_PRICE,
        proposed_decision: classifyStage3AskingPrice(input),
        proposed_lifecycle_events: [{ event_type: "stage3_shadow_evaluated" }],
        execution_authority: false,
      };
    case "condition_justification":
      return {
        engine: "stage4_condition_shadow",
        universal_stage,
        granular_stage: SELLER_FLOW_STAGES.PRICE_HIGH_CONDITION_PROBE,
        proposed_decision: classifyStage4Condition(input),
        proposed_lifecycle_events: [{ event_type: "stage4_shadow_evaluated" }],
        execution_authority: false,
      };
    case "offer_negotiation":
      return {
        engine: "stage5_negotiation_shadow",
        universal_stage,
        granular_stage: SELLER_FLOW_STAGES.OFFER_REVEAL_CASH,
        proposed_decision: classifyStage5Negotiation(input),
        proposed_lifecycle_events: [{ event_type: "stage5_shadow_evaluated" }],
        execution_authority: false,
      };
    case "seller_contract":
      return {
        engine: "stage6_contract_shadow",
        universal_stage,
        granular_stage: SELLER_FLOW_STAGES.CLOSE_HANDOFF,
        proposed_decision: classifyStage6Contract(input),
        proposed_lifecycle_events: [{ event_type: "stage6_shadow_evaluated" }],
        execution_authority: false,
      };
    default:
      return runStage1Shadow(input);
  }
}

/**
 * Invoke the deterministic stage engine in shadow mode.
 * Persists comparison metadata only — no execution authority.
 */
export function runShadowStageEngine({
  message = "",
  classification = null,
  context = null,
  canonical_decision = null,
  legacy_decision = null,
  relationship = null,
  identity_class = null,
  relationship_outcome = null,
  suppression_scope = null,
  universal_stage = null,
  granular_stage = null,
  follow_up_recommendation = null,
  recommended_use_case = null,
  human_review_required = false,
  route = null,
} = {}) {
  const post_decision_stage =
    clean(universal_stage) ||
    clean(classification?.stage_hint) ||
    clean(context?.summary?.conversation_stage) ||
    SELLER_FLOW_STAGES.OWNERSHIP_CHECK;

  const invocation_stage = normalizeUniversalStage(
    clean(context?.summary?.conversation_stage) ||
      clean(classification?.stage_hint) ||
      post_decision_stage
  );
  const normalized_universal_stage = normalizeUniversalStage(post_decision_stage);

  let shadow = runStageEngine(invocation_stage, {
    message,
    classification,
    context,
    current_stage: post_decision_stage,
    conversation_stage: clean(context?.summary?.conversation_stage) || post_decision_stage,
    seller_message: message,
    canonical_decision,
    relationship,
    route,
  });

  shadow = applyRelationshipPolicyToShadow(shadow, {
    relationship,
    canonical_decision,
    granular_stage,
  });

  const relationship_template = enforceRelationshipTemplatePolicy({
    relationship,
    canonical_intent: canonical_decision?.canonical_intent,
    granular_stage,
    template_use_case: recommended_use_case,
  });

  const effective_recommended_use_case = relationship_template.blocked
    ? relationship_template.use_case
    : recommended_use_case;

  const shadow_recommended_use_case = relationship_template.blocked
    ? relationship_template.use_case
    : shadow.proposed_decision?.template_use_case || null;

  const canonical_transition = mapCanonicalTransitionShape({
    context,
    route,
    canonical_decision,
    relationship,
    universal_stage,
    granular_stage,
    classification,
  });

  const shadow_transition = mapShadowTransitionShape({
    context,
    shadow_engine: shadow,
    relationship,
    canonical_decision,
    classification,
  });

  const transition_comparison = compareTransitionShapes(
    canonical_transition,
    shadow_transition
  );

  const canonical_shape = mapCanonicalToComparisonShape({
    canonical_decision,
    identity_class,
    relationship_outcome,
    suppression_scope,
    universal_stage: universal_stage || shadow.universal_stage,
    granular_stage,
    follow_up_recommendation,
    recommended_use_case: effective_recommended_use_case,
    human_review_required,
  });

  const shadow_shape = mapShadowToComparisonShape({
    shadow_engine: shadow,
    relationship,
    canonical_decision,
    follow_up_recommendation,
    recommended_use_case: shadow_recommended_use_case,
  });

  const comparison = compareNormalizedDecisionShapes(canonical_shape, shadow_shape, {
    transition_comparison,
  });

  return {
    universal_stage: normalized_universal_stage,
    shadow_stage_engine: shadow,
    canonical_agreement: comparison.comparison_class === "full_agreement",
    legacy_agreement: false,
    canonical_disagreement_reason: comparison.material_disagreement
      ? comparison.material_disagreement_fields.join(",")
      : comparison.comparison_class,
    legacy_disagreement_reason: null,
    shadow_mode: true,
    execution_authority: false,
    transition_comparison,
    comparison,
  };
}

export default runShadowStageEngine;