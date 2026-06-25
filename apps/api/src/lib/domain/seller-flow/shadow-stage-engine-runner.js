import { SELLER_FLOW_STAGES } from "@/lib/domain/seller-flow/canonical-seller-flow.js";
import { classifyStage2OfferInterest } from "@/lib/domain/seller-flow/stage2-offer-interest-engine.js";
import { classifyStage3AskingPrice } from "@/lib/domain/seller-flow/stage3-asking-price-engine.js";
import { classifyStage4Condition } from "@/lib/domain/seller-flow/stage4-condition-justification-engine.js";
import { classifyStage5Negotiation } from "@/lib/domain/seller-flow/stage5-offer-negotiation-engine.js";
import { classifyStage6Contract } from "@/lib/domain/seller-flow/stage6-seller-contract-engine.js";
import { resolveDeterministicStageTransition } from "@/lib/domain/seller-flow/deterministic-stage-map.js";

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function normalizeUniversalStage(stage = null) {
  const value = lower(stage);
  if (!value) return "ownership_confirmation";
  if (value.includes("ownership") || value === "s1" || value === SELLER_FLOW_STAGES.OWNERSHIP_CHECK) {
    return "ownership_confirmation";
  }
  if (value.includes("consider") || value === "s2" || value === SELLER_FLOW_STAGES.CONSIDER_SELLING) {
    return "offer_interest";
  }
  if (value.includes("asking") || value === "s3" || value === SELLER_FLOW_STAGES.ASKING_PRICE) {
    return "asking_price";
  }
  if (value.includes("condition") || value.includes("basics") || value === "s4") {
    return "condition_justification";
  }
  if (value.includes("offer") || value.includes("negotiat") || value === "s5") {
    return "offer_negotiation";
  }
  if (value.includes("contract") || value.includes("close") || value === "s6") {
    return "seller_contract";
  }
  return value;
}

function runStage1Shadow({ message, classification, context } = {}) {
  const intent = clean(classification?.primary_intent || classification?.detected_intent) || "unclear";
  const stage_decision = resolveDeterministicStageTransition({
    current_stage: context?.summary?.conversation_stage || SELLER_FLOW_STAGES.OWNERSHIP_CHECK,
    inbound_intent: intent,
    should_queue_reply: false,
    autopilot_enabled: false,
  });

  return {
    engine: "stage1_ownership_shadow",
    universal_stage: "ownership_confirmation",
    granular_stage: stage_decision?.next_stage || SELLER_FLOW_STAGES.OWNERSHIP_CHECK,
    proposed_decision: stage_decision,
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

function compareDecisions(canonical = {}, shadow = {}) {
  const canonical_stage =
    clean(canonical.granular_stage) ||
    clean(canonical.stage_hint) ||
    clean(canonical.route_hint);
  const shadow_stage =
    clean(shadow.granular_stage) ||
    clean(shadow.proposed_decision?.next_stage) ||
    clean(shadow.proposed_decision?.next_stage_code);

  const canonical_intent = clean(canonical.canonical_intent);
  const shadow_intent =
    clean(shadow.proposed_decision?.inbound_intent) ||
    clean(shadow.proposed_decision?.outcome) ||
    clean(shadow.proposed_decision?.primary_intent);

  const agrees =
    (!canonical_stage || !shadow_stage || canonical_stage === shadow_stage) &&
    (!canonical_intent || !shadow_intent || canonical_intent === shadow_intent);

  return {
    agrees,
    disagreement_reason: agrees
      ? null
      : [
          canonical_stage && shadow_stage && canonical_stage !== shadow_stage
            ? `stage_mismatch:${canonical_stage}!=${shadow_stage}`
            : null,
          canonical_intent && shadow_intent && canonical_intent !== shadow_intent
            ? `intent_mismatch:${canonical_intent}!=${shadow_intent}`
            : null,
        ]
          .filter(Boolean)
          .join("; ") || "shadow_disagreement",
  };
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
} = {}) {
  const current_stage =
    clean(classification?.stage_hint) ||
    clean(context?.summary?.conversation_stage) ||
    SELLER_FLOW_STAGES.OWNERSHIP_CHECK;
  const universal_stage = normalizeUniversalStage(current_stage);

  const shadow = runStageEngine(universal_stage, {
    message,
    classification,
    context,
    current_stage,
    conversation_stage: current_stage,
    seller_message: message,
  });

  const canonical_comparison = compareDecisions(
    {
      canonical_intent: canonical_decision?.canonical_intent,
      granular_stage: canonical_decision?.stage_hint || canonical_decision?.route_hint,
      stage_hint: canonical_decision?.stage_hint,
      route_hint: canonical_decision?.route_hint,
    },
    shadow
  );

  const legacy_comparison = compareDecisions(
    {
      canonical_intent: legacy_decision?.inbound_intent || legacy_decision?.detected_intent,
      granular_stage: legacy_decision?.next_stage || legacy_decision?.selected_use_case,
    },
    shadow
  );

  return {
    universal_stage,
    shadow_stage_engine: shadow,
    canonical_agreement: canonical_comparison.agrees,
    legacy_agreement: legacy_comparison.agrees,
    canonical_disagreement_reason: canonical_comparison.disagreement_reason,
    legacy_disagreement_reason: legacy_comparison.disagreement_reason,
    shadow_mode: true,
    execution_authority: false,
  };
}

export default runShadowStageEngine;