import { SELLER_FLOW_STAGES } from "@/lib/domain/seller-flow/canonical-seller-flow.js";
import { classifyStage2OfferInterest } from "@/lib/domain/seller-flow/stage2-offer-interest-engine.js";
import { classifyStage3AskingPrice } from "@/lib/domain/seller-flow/stage3-asking-price-engine.js";
import { classifyStage4Condition } from "@/lib/domain/seller-flow/stage4-condition-justification-engine.js";
import { classifyStage5Negotiation } from "@/lib/domain/seller-flow/stage5-offer-negotiation-engine.js";
import { classifyStage6Contract } from "@/lib/domain/seller-flow/stage6-seller-contract-engine.js";
import { resolveDeterministicStageTransition } from "@/lib/domain/seller-flow/deterministic-stage-map.js";
import { enforceRelationshipTemplatePolicy } from "@/lib/domain/seller-flow/relationship-template-policy.js";
import { resolveLatentInterestPolicy } from "@/lib/domain/seller-flow/latent-interest-policy.js";
import { normalizeStageLabel } from "@/lib/domain/seller-flow/shadow-stage-transition.js";

const STAGE_AUTHORITY = Object.freeze({
  ownership_confirmation: "stage1_ownership_engine",
  offer_interest: "stage2_offer_interest_engine",
  asking_price: "stage3_asking_price_engine",
  condition_justification: "stage4_condition_engine",
  offer_negotiation: "stage5_negotiation_engine",
  seller_contract: "stage6_contract_engine",
});

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function normalizeUniversalStage(stage = null) {
  return normalizeStageLabel(stage) || "ownership_confirmation";
}

function normalizeSafetyTier(tier = null, { suppressed = false } = {}) {
  if (suppressed) return "suppressed";
  const key = lower(tier);
  if (key === "auto_send" || key === "allowed") return "allowed";
  if (key === "suppress") return "suppressed";
  return "review";
}

function mapEngineAction(decision = {}, relationship = null) {
  if (relationship?.should_suppress_contact || decision.suppression_reason) {
    return "suppress_contact";
  }
  if (relationship?.referral_detected) return "referral_review";
  if (relationship?.ownership_confirmed) return "ask_offer_interest";
  const action = lower(decision.acquisition_action || "");
  if (action.includes("suppress")) return "suppress_contact";
  if (action.includes("gather_condition")) return "gather_condition_data";
  if (action.includes("advance_to_price")) return "ask_asking_price";
  if (action.includes("schedule")) return "schedule_follow_up";
  if (action.includes("human_review")) return "human_review";
  if (decision.should_queue_reply) return "queue_recommended_reply";
  if (decision.should_mark_human_review) return "human_review";
  return "hold_for_review";
}

function runStageEngine(universal_stage, input) {
  // Persisted ADE authority + negotiation state feed the price/negotiation
  // engines — without them every band is "unknown" and counters dead-end in
  // review. Loaded by the orchestrator BEFORE the intelligence phase.
  const underwriting = input.underwriting || {};
  const negotiation_state = input.deal_state?.negotiation_state || {};

  switch (universal_stage) {
    case "ownership_confirmation":
      return {
        engine: STAGE_AUTHORITY.ownership_confirmation,
        universal_stage,
        stage_decision: resolveDeterministicStageTransition({
          current_stage: input.context?.summary?.conversation_stage || SELLER_FLOW_STAGES.OWNERSHIP_CHECK,
          inbound_intent: input.semantic_intent,
          should_queue_reply: true,
          autopilot_enabled: false,
        }),
      };
    case "offer_interest":
      return {
        engine: STAGE_AUTHORITY.offer_interest,
        universal_stage,
        stage_decision: classifyStage2OfferInterest(input),
      };
    case "asking_price":
      return {
        engine: STAGE_AUTHORITY.asking_price,
        universal_stage,
        stage_decision: classifyStage3AskingPrice({
          message: input.message,
          context: input.context,
          seller_asking_price:
            negotiation_state.current_asking_price ?? negotiation_state.current_ask ?? null,
          underwriting,
        }),
      };
    case "condition_justification":
      return {
        engine: STAGE_AUTHORITY.condition_justification,
        universal_stage,
        stage_decision: classifyStage4Condition({
          message: input.message,
          context: input.context,
        }),
      };
    case "offer_negotiation":
      return {
        engine: STAGE_AUTHORITY.offer_negotiation,
        universal_stage,
        stage_decision: classifyStage5Negotiation({
          ...input,
          recommended_cash_offer:
            input.recommended_cash_offer ?? underwriting.recommended_cash_offer ?? null,
          max_allowable_offer:
            input.max_allowable_offer ?? underwriting.max_allowable_offer ?? null,
          seller_asking_price:
            input.seller_asking_price ??
            negotiation_state.current_asking_price ??
            negotiation_state.current_ask ??
            null,
          repair_estimate: input.repair_estimate ?? underwriting.repair_estimate ?? null,
          lowest_relevant_comp:
            input.lowest_relevant_comp ?? underwriting.lowest_relevant_comp ?? null,
        }),
      };
    case "seller_contract":
      return {
        engine: STAGE_AUTHORITY.seller_contract,
        universal_stage,
        stage_decision: classifyStage6Contract(input),
      };
    default:
      return runStageEngine("ownership_confirmation", input);
  }
}

function applyLatentInterestOverlay(recommendation, { message, confidence } = {}) {
  const policy = resolveLatentInterestPolicy({ message, confidence });
  return {
    ...recommendation,
    recommended_use_case: policy.recommended_use_case,
    recommended_action: policy.recommended_action,
    recommended_human_review: policy.recommended_human_review,
    recommendation_reason: policy.recommendation_reason,
    policy_source: policy.policy_key,
  };
}

function buildRecommendationFromEngine({
  engine_result = {},
  relationship = null,
  semantic_intent = null,
  follow_up_recommendation = null,
  message = "",
  confidence = null,
} = {}) {
  const decision = engine_result.stage_decision || {};
  const suppressed = Boolean(relationship?.should_suppress_contact || decision.suppression_reason);
  const relationship_policy = enforceRelationshipTemplatePolicy({
    relationship,
    canonical_intent: semantic_intent,
    granular_stage: decision.next_stage,
    template_use_case: decision.template_use_case,
  });

  let recommendation = {
    authority: engine_result.engine,
    proposed_next_stage: normalizeUniversalStage(decision.next_stage || engine_result.universal_stage),
    recommended_action: mapEngineAction(decision, relationship),
    recommended_use_case: relationship_policy.blocked
      ? relationship_policy.use_case
      : decision.template_use_case || null,
    recommended_template: relationship_policy.blocked
      ? relationship_policy.use_case
      : decision.template_use_case || null,
    recommended_follow_up_policy:
      follow_up_recommendation?.follow_up_policy || follow_up_recommendation?.reason || null,
    recommended_human_review: suppressed
      ? false
      : Boolean(
          relationship?.human_review_required ||
            decision.should_mark_human_review ||
            normalizeSafetyTier(decision.safety_tier) === "review"
        ),
    recommended_safety_disposition: normalizeSafetyTier(decision.safety_tier, { suppressed }),
    recommendation_reason: relationship_policy.reason || decision.acquisition_action || engine_result.engine,
    engine_decision: decision,
  };

  if (semantic_intent === "ownership_confirmed" && relationship?.ownership_confirmed) {
    recommendation = {
      ...recommendation,
      proposed_next_stage: "offer_interest",
      recommended_action: "ask_offer_interest",
      recommended_use_case: "consider_selling",
      recommended_template: "consider_selling",
      recommended_human_review: false,
      recommended_safety_disposition: "allowed",
      recommendation_reason: "ownership_confirmed_advance_offer_interest",
    };
  }

  if (semantic_intent === "latent_interest") {
    recommendation = applyLatentInterestOverlay(recommendation, { message, confidence });
    recommendation.proposed_next_stage = "offer_interest";
  }

  if (relationship_policy.blocked) {
    recommendation.recommended_action = relationship.referred_automatic_send_allowed
      ? "referral_auto_outreach"
      : "referral_review";
    recommendation.recommended_human_review = !relationship.referred_automatic_send_allowed;
    recommendation.recommended_safety_disposition = relationship.referred_automatic_send_allowed
      ? "allowed"
      : "review";
  }

  return recommendation;
}

/**
 * Authoritative stage-engine domain recommendation.
 * Orchestrator Layer B must derive from this — not recreate stage logic.
 */
export function resolveStageDomainRecommendation({
  message = "",
  classification = null,
  context = null,
  relationship = null,
  semantic_intent = null,
  follow_up_recommendation = null,
  route = null,
  underwriting = null,
  deal_state = null,
} = {}) {
  const invocation_stage = normalizeUniversalStage(
    clean(context?.summary?.conversation_stage) ||
      clean(route?.stage) ||
      clean(classification?.stage_hint) ||
      "ownership_confirmation"
  );

  const engine_result = runStageEngine(invocation_stage, {
    message,
    classification,
    context,
    relationship,
    semantic_intent,
    seller_message: message,
    underwriting,
    deal_state,
  });

  const recommendation = buildRecommendationFromEngine({
    engine_result,
    relationship,
    semantic_intent,
    follow_up_recommendation,
    message,
    confidence: classification?.confidence ?? null,
  });

  return {
    invocation_stage,
    authority: engine_result.engine,
    stage_authority_by_universal_stage: STAGE_AUTHORITY,
    engine_result,
    recommendation,
  };
}

export { STAGE_AUTHORITY };
export default resolveStageDomainRecommendation;