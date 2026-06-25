/**
 * Transition-aware stage comparison shape.
 * Compares proposed transitions, not invocation context vs post-decision stage.
 */

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

const STAGE_ALIASES = Object.freeze({
  "ownership confirmation": "ownership_confirmation",
  ownership_check: "ownership_confirmation",
  ownership: "ownership_confirmation",
  "consider selling": "offer_interest",
  consider_selling: "offer_interest",
  "asking price": "asking_price",
  asking_price: "asking_price",
  "condition probe": "condition_justification",
  condition_justification: "condition_justification",
  offer_interest: "offer_interest",
  offer_negotiation: "offer_negotiation",
  seller_contract: "seller_contract",
});

const EVENT_TRANSITIONS = Object.freeze({
  ownership_confirmed: {
    proposed_next_stage: "offer_interest",
    transition_reason: "ownership_confirmed_advance_offer_interest",
  },
  condition_disclosed: {
    proposed_next_stage: "condition_justification",
    transition_reason: "condition_disclosed_advance_condition_justification",
  },
  asking_price_provided: {
    proposed_next_stage: "asking_price",
    transition_reason: "asking_price_provided_advance_asking_price",
  },
  latent_interest: {
    proposed_next_stage: "offer_interest",
    transition_reason: "latent_interest_hold_offer_interest",
  },
  non_owner_referral: {
    proposed_next_stage: "ownership_confirmation",
    transition_reason: "referral_review_hold_stage",
  },
  property_specific_non_owner: {
    proposed_next_stage: "ownership_confirmation",
    transition_reason: "property_scoped_non_owner_hold_stage",
  },
});

export function normalizeStageLabel(stage = null) {
  const key = lower(stage);
  return STAGE_ALIASES[key] || key || null;
}

function deriveProposedNextStage({
  canonical_intent = null,
  granular_stage = null,
  route_hint = null,
  relationship = null,
} = {}) {
  const intent = lower(canonical_intent);
  if (EVENT_TRANSITIONS[intent]) {
    return EVENT_TRANSITIONS[intent].proposed_next_stage;
  }
  if (relationship?.ownership_confirmed) return "offer_interest";
  if (relationship?.referral_detected) return "ownership_confirmation";
  if (granular_stage) return normalizeStageLabel(granular_stage);
  if (route_hint) return normalizeStageLabel(route_hint);
  return null;
}

function deriveStageAfterDecision({
  stage_before = null,
  proposed_next_stage = null,
  transition_allowed = false,
  event_intent = null,
} = {}) {
  if (!transition_allowed) return stage_before;
  if (EVENT_TRANSITIONS[lower(event_intent)]) {
    return EVENT_TRANSITIONS[lower(event_intent)].proposed_next_stage;
  }
  return proposed_next_stage || stage_before;
}

export function mapCanonicalTransitionShape({
  context = null,
  route = null,
  canonical_decision = {},
  relationship = null,
  universal_stage = null,
  granular_stage = null,
  classification = null,
} = {}) {
  const stage_before_message = normalizeStageLabel(
    context?.summary?.conversation_stage || route?.stage || "ownership_confirmation"
  );
  const event_intent =
    clean(relationship?.canonical_intent) ||
    clean(canonical_decision?.canonical_intent) ||
    clean(classification?.primary_intent) ||
    "unclear";

  const proposed_next_stage = deriveProposedNextStage({
    canonical_intent: event_intent,
    granular_stage,
    route_hint: canonical_decision?.route_hint,
    relationship,
  });

  const event_rule = EVENT_TRANSITIONS[lower(event_intent)];
  const transition_allowed = Boolean(
    event_rule ||
      (proposed_next_stage && proposed_next_stage !== stage_before_message)
  );

  const stage_after_decision = deriveStageAfterDecision({
    stage_before: stage_before_message,
    proposed_next_stage,
    transition_allowed,
    event_intent,
  });

  return {
    stage_before_message,
    event_intent: lower(event_intent),
    proposed_next_stage,
    stage_after_decision,
    transition_reason:
      event_rule?.transition_reason ||
      (relationship?.referral_detected
        ? "referral_review_hold_stage"
        : transition_allowed
          ? "intent_stage_transition"
          : "hold_current_stage"),
    transition_allowed: stage_after_decision !== stage_before_message || Boolean(event_rule),
    transition_confidence:
      typeof classification?.confidence === "number" ? classification.confidence : null,
  };
}

export function mapShadowTransitionShape({
  context = null,
  shadow_engine = {},
  relationship = null,
  canonical_decision = null,
  classification = null,
} = {}) {
  const stage_before_message = normalizeStageLabel(
    context?.summary?.conversation_stage || "ownership_confirmation"
  );
  const proposed = shadow_engine.proposed_decision || {};
  const event_intent =
    clean(relationship?.canonical_intent) ||
    clean(canonical_decision?.canonical_intent) ||
    clean(proposed.inbound_intent) ||
    clean(classification?.primary_intent) ||
    "unclear";

  const proposed_next_stage = deriveProposedNextStage({
    canonical_intent: event_intent,
    granular_stage: shadow_engine.granular_stage || proposed.next_stage,
    relationship,
  });

  const event_rule = EVENT_TRANSITIONS[lower(event_intent)];
  const transition_allowed = Boolean(
    event_rule ||
      (proposed_next_stage && proposed_next_stage !== stage_before_message)
  );

  const stage_after_decision = deriveStageAfterDecision({
    stage_before: stage_before_message,
    proposed_next_stage,
    transition_allowed,
    event_intent,
  });

  return {
    stage_before_message,
    event_intent: lower(event_intent),
    proposed_next_stage,
    stage_after_decision,
    transition_reason: proposed.policy_source
      ? `shadow_${proposed.policy_source}`
      : event_rule?.transition_reason || "shadow_stage_engine",
    transition_allowed: stage_after_decision !== stage_before_message || Boolean(event_rule),
    transition_confidence:
      typeof classification?.confidence === "number" ? classification.confidence : null,
  };
}

export function compareTransitionShapes(canonical = {}, shadow = {}) {
  const fields = [
    "stage_before_message",
    "event_intent",
    "proposed_next_stage",
    "stage_after_decision",
    "transition_allowed",
  ];
  const agreement = {};
  const disagreement_fields = [];

  for (const field of fields) {
    const agrees = canonical[field] === shadow[field];
    agreement[field] = agrees;
    if (!agrees) disagreement_fields.push(field);
  }

  const same_before = canonical.stage_before_message === shadow.stage_before_message;
  const same_event = canonical.event_intent === shadow.event_intent;
  const same_after = canonical.stage_after_decision === shadow.stage_after_decision;
  const same_proposed = canonical.proposed_next_stage === shadow.proposed_next_stage;

  let comparison_class = "full_agreement";

  if (!same_before || !same_event) {
    comparison_class = "insufficient_context";
  } else if (same_after && same_proposed) {
    comparison_class = "full_agreement";
  } else if (same_after && !same_proposed) {
    comparison_class = "expected_transition_context_difference";
  } else if (
    canonical.event_intent === "ownership_confirmed" &&
    canonical.stage_after_decision === "offer_interest" &&
    shadow.stage_after_decision === "offer_interest"
  ) {
    comparison_class = "full_agreement";
  } else if (disagreement_fields.length > 0) {
    comparison_class = "material_disagreement";
  }

  return {
    agreement,
    disagreement_fields,
    comparison_class,
    canonical_transition: canonical,
    shadow_transition: shadow,
  };
}

export default mapCanonicalTransitionShape;