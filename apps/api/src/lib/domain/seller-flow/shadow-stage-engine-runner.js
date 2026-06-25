import { resolveStageDomainRecommendation } from "@/lib/domain/seller-flow/stage-domain-recommendation.js";
import {
  compareThreeLayerDecisions,
  mapEffectiveExecutionLayer,
  mapRecommendationLayer,
  mapSemanticLayer,
} from "@/lib/domain/seller-flow/three-layer-decision-contract.js";
import {
  compareTransitionShapes,
  mapCanonicalTransitionShape,
  mapShadowTransitionShape,
} from "@/lib/domain/seller-flow/shadow-stage-transition.js";

function clean(value) {
  return String(value ?? "").trim();
}

function buildExtractedFacts({ message = "", referral = null, stage_domain = null } = {}) {
  const facts = {};
  const decision = stage_domain?.engine_result?.stage_decision || {};
  if (decision.seller_asking_price != null) facts.asking_price = decision.seller_asking_price;
  if (decision.offer_band) facts.offer_band = decision.offer_band;
  if (decision.repair_facts) facts.repair_facts = decision.repair_facts;
  if (referral?.referrals?.length) facts.referrals = referral.referrals;
  if (message) facts.message_preview = message.slice(0, 120);
  return facts;
}

/**
 * Build three-layer shadow comparison: orchestrator vs authoritative stage engine.
 */
export function runShadowStageEngine({
  message = "",
  classification = null,
  context = null,
  canonical_decision = null,
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
  referral = null,
  orchestrator_recommendation = null,
  execution_allowed = false,
  execution_blocked_reason = null,
  extracted_facts = null,
} = {}) {
  const semantic_intent =
    clean(relationship?.canonical_intent) ||
    clean(canonical_decision?.canonical_intent) ||
    clean(classification?.primary_intent) ||
    "unclear";

  const stage_domain = resolveStageDomainRecommendation({
    message,
    classification,
    context,
    relationship,
    semantic_intent,
    follow_up_recommendation,
    route,
  });

  const facts =
    extracted_facts ||
    buildExtractedFacts({ message, referral, stage_domain });

  const orchestrator_semantic = mapSemanticLayer({
    relationship: {
      ...relationship,
      identity_class: identity_class || relationship?.identity_class,
      relationship_outcome: relationship_outcome || relationship?.relationship_outcome,
      suppression_scope: suppression_scope || relationship?.suppression_scope,
    },
    classification,
    canonical_intent: semantic_intent,
    context,
    route,
    extracted_facts: facts,
  });

  const stage_semantic = mapSemanticLayer({
    relationship,
    classification,
    canonical_intent: semantic_intent,
    context,
    route,
    extracted_facts: facts,
  });

  const orchestrator_recommendation_layer = mapRecommendationLayer({
    recommendation: orchestrator_recommendation || stage_domain.recommendation,
    follow_up_recommendation,
  });

  const stage_recommendation_layer = mapRecommendationLayer({
    recommendation: stage_domain.recommendation,
    follow_up_recommendation,
  });

  const orchestrator_execution = mapEffectiveExecutionLayer({
    execution_allowed,
    execution_blocked_reason,
    recommendation: orchestrator_recommendation_layer,
    relationship,
  });

  const stage_execution = mapEffectiveExecutionLayer({
    execution_allowed: false,
    execution_blocked_reason: execution_blocked_reason || "auto_reply_mode_disabled",
    recommendation: stage_recommendation_layer,
    relationship,
  });

  const three_layer_comparison = compareThreeLayerDecisions({
    orchestrator: {
      semantic: orchestrator_semantic,
      recommendation: orchestrator_recommendation_layer,
      execution: orchestrator_execution,
    },
    stage_engine: {
      semantic: stage_semantic,
      recommendation: stage_recommendation_layer,
      execution: stage_execution,
    },
  });

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
    shadow_engine: {
      universal_stage: stage_domain.recommendation.proposed_next_stage,
      granular_stage: stage_domain.engine_result?.stage_decision?.next_stage,
      proposed_decision: stage_domain.engine_result?.stage_decision || {},
    },
    relationship,
    canonical_decision,
    classification,
  });

  const transition_comparison = compareTransitionShapes(canonical_transition, shadow_transition);

  return {
    universal_stage: stage_domain.recommendation.proposed_next_stage,
    invocation_stage: stage_domain.invocation_stage,
    stage_authority: stage_domain.authority,
    shadow_stage_engine: stage_domain.engine_result,
    stage_domain_recommendation: stage_domain.recommendation,
    shadow_mode: true,
    execution_authority: false,
    transition_comparison,
    three_layer_comparison,
    comparison: three_layer_comparison,
    layers: three_layer_comparison.layers,
  };
}

export default runShadowStageEngine;