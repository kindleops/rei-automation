/**
 * Normalized shadow-comparison contract.
 * Maps canonical orchestrator and deterministic stage-engine outputs into the
 * same semantic dimensions before per-field agreement evaluation.
 */

export const COMPARISON_FIELDS = Object.freeze([
  "canonical_intent",
  "identity_class",
  "relationship_outcome",
  "suppression_scope",
  "universal_stage",
  "granular_stage",
  "safety_disposition",
  "proposed_action",
  "selected_use_case",
  "follow_up_policy",
  "human_review_required",
]);

/** Fields whose disagreement always affects routing, suppression, or execution. */
export const ALWAYS_MATERIAL_FIELDS = Object.freeze([
  "canonical_intent",
  "identity_class",
  "relationship_outcome",
  "suppression_scope",
  "safety_disposition",
  "proposed_action",
  "selected_use_case",
  "follow_up_policy",
  "human_review_required",
]);

/** Material only when the disagreement changes downstream execution semantics. */
export const CONDITIONALLY_MATERIAL_FIELDS = Object.freeze(["granular_stage"]);

/** Presentation/context fields — non-material when transition shapes agree. */
export const PRESENTATION_ONLY_FIELDS = Object.freeze(["universal_stage"]);

export const MATERIAL_COMPARISON_FIELDS = Object.freeze(
  new Set([...ALWAYS_MATERIAL_FIELDS, ...CONDITIONALLY_MATERIAL_FIELDS])
);

const GRANULAR_DOWNSTREAM_FIELDS = Object.freeze([
  "selected_use_case",
  "proposed_action",
  "follow_up_policy",
  "human_review_required",
]);

const UNIVERSAL_STAGE_ALIASES = Object.freeze({
  ownership_confirmation: "ownership_confirmation",
  "ownership confirmation": "ownership_confirmation",
  ownership_check: "ownership_confirmation",
  offer_interest: "offer_interest",
  "consider selling": "offer_interest",
  consider_selling: "offer_interest",
  asking_price: "asking_price",
  "asking price": "asking_price",
  condition_justification: "condition_justification",
  "condition probe": "condition_justification",
  offer_negotiation: "offer_negotiation",
  seller_contract: "seller_contract",
});

const GRANULAR_STAGE_ALIASES = Object.freeze({
  ownership_check: "ownership_check",
  ownership: "ownership_check",
  consider_selling: "consider_selling",
  wrong_person: "wrong_person",
  referral_review: "referral_review",
  property_scoped_non_owner: "property_scoped_non_owner",
  former_owner: "former_owner",
  tenant_or_occupancy: "tenant_or_occupancy",
  property_manager: "property_manager",
  agent_representative: "agent_representative",
  authorized_spouse: "authorized_spouse",
  executor_or_heir: "executor_or_heir",
  entity_representative: "entity_representative",
  hostile_or_legal: "hostile_or_legal",
  stop_or_opt_out: "stop_or_opt_out",
  condition_disclosed: "condition_disclosed",
  price_high_condition_probe: "condition_disclosed",
  offer: "offer",
});

const INTENT_ALIASES = Object.freeze({
  wrong_person: "wrong_number",
  tenant_occupied: "tenant_respondent",
  executor_heir_respondent: "executor_or_heir_respondent",
  entity_representative_respondent: "entity_representative_respondent",
  co_owner_respondent: "co_owner_respondent",
});

const IDENTITY_ALIASES = Object.freeze({
  wrong_person: "wrong_number",
  renter_occupant: "renter_occupant",
  owner_related_contact: "authorized_spouse",
});

const PROPOSED_ACTION_ALIASES = Object.freeze({
  mark_human_review: "human_review",
  queue_auto_reply: "auto_reply",
  archive_wrong_number: "suppress_globally",
  suppress_contact: "suppress_globally",
});

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function normalizeUniversalStage(value) {
  const key = lower(value);
  return UNIVERSAL_STAGE_ALIASES[key] || key || null;
}

function normalizeGranularStage(value) {
  const key = lower(value);
  return GRANULAR_STAGE_ALIASES[key] || key || null;
}

function normalizeIntent(value) {
  const key = lower(value);
  return INTENT_ALIASES[key] || key || null;
}

function normalizeIdentity(value) {
  const key = lower(value);
  return IDENTITY_ALIASES[key] || key || null;
}

function normalizeProposedAction(value) {
  const key = lower(value);
  return PROPOSED_ACTION_ALIASES[key] || key || null;
}

function normalizeFollowUpPolicy(value) {
  const key = lower(value);
  if (!key) return null;
  if (key === "follow_up_policy_not_approved" || key.includes("review_required_no_schedule")) {
    return "review_required_no_schedule";
  }
  if (key.includes("permanent_suppression") || key.includes("thread_already_suppressed")) {
    return "suppressed";
  }
  if (key.includes("active_workflow")) return "active_workflow";
  if (key.includes("referral_source")) return "referral_source_no_nurture";
  if (key.includes("nurture")) return "nurture";
  if (key.includes("no_followup")) return "no_followup";
  return key;
}

function normalizeField(field, value) {
  if (value === null || value === undefined || value === "") return null;
  switch (field) {
    case "canonical_intent":
      return normalizeIntent(value);
    case "identity_class":
      return normalizeIdentity(value);
    case "relationship_outcome":
      return lower(value) || null;
    case "suppression_scope":
      return lower(value) || "none";
    case "universal_stage":
      return normalizeUniversalStage(value);
    case "granular_stage":
      return normalizeGranularStage(value);
    case "safety_disposition":
      return lower(value) || null;
    case "proposed_action":
      return normalizeProposedAction(value);
    case "selected_use_case":
      return lower(value) || null;
    case "follow_up_policy":
      return normalizeFollowUpPolicy(value);
    case "human_review_required":
      return Boolean(value);
    default:
      return value;
  }
}

function deriveSafetyDisposition({ safety_status, safety_tier, should_suppress_contact } = {}) {
  if (should_suppress_contact) return "suppressed";
  return lower(safety_status || safety_tier) || "review";
}

function deriveProposedAction({ next_action, should_suppress_contact, should_queue_reply } = {}) {
  if (should_suppress_contact) return "suppress_globally";
  if (next_action) return normalizeProposedAction(next_action);
  if (should_queue_reply) return "auto_reply";
  return "human_review";
}

/**
 * Map canonical orchestrator output to normalized comparison shape.
 */
export function mapCanonicalToComparisonShape({
  canonical_decision = {},
  identity_class = null,
  relationship_outcome = null,
  suppression_scope = null,
  universal_stage = null,
  granular_stage = null,
  follow_up_recommendation = null,
  recommended_use_case = null,
  human_review_required = false,
} = {}) {
  return {
    canonical_intent: normalizeField(
      "canonical_intent",
      canonical_decision.canonical_intent
    ),
    identity_class: normalizeField("identity_class", identity_class),
    relationship_outcome: normalizeField("relationship_outcome", relationship_outcome),
    suppression_scope: normalizeField(
      "suppression_scope",
      suppression_scope ?? canonical_decision.suppression_scope
    ),
    universal_stage: normalizeField("universal_stage", universal_stage),
    granular_stage: normalizeField("granular_stage", granular_stage),
    safety_disposition: normalizeField(
      "safety_disposition",
      deriveSafetyDisposition({
        safety_status: canonical_decision.safety_status,
        should_suppress_contact: canonical_decision.should_suppress_contact,
      })
    ),
    proposed_action: normalizeField(
      "proposed_action",
      deriveProposedAction({
        next_action: canonical_decision.next_action,
        should_suppress_contact: canonical_decision.should_suppress_contact,
        should_queue_reply: canonical_decision.should_queue_reply,
      })
    ),
    selected_use_case: normalizeField(
      "selected_use_case",
      recommended_use_case || canonical_decision.route_hint
    ),
    follow_up_policy: normalizeField(
      "follow_up_policy",
      follow_up_recommendation?.follow_up_policy ||
        follow_up_recommendation?.reason ||
        follow_up_recommendation?.source_respondent?.reason
    ),
    human_review_required: normalizeField(
      "human_review_required",
      human_review_required || canonical_decision.should_mark_human_review
    ),
  };
}

/**
 * Map deterministic stage-engine output to normalized comparison shape.
 */
export function mapShadowToComparisonShape({
  shadow_engine = {},
  relationship = null,
  canonical_decision = null,
  follow_up_recommendation = null,
  recommended_use_case = null,
} = {}) {
  const proposed = shadow_engine.proposed_decision || {};
  const relationship_override =
    relationship?.referral_detected ||
    relationship?.ownership_confirmed ||
    relationship?.should_suppress_contact;
  const relationship_intent = relationship_override
    ? relationship?.canonical_intent
    : canonical_decision?.canonical_intent ||
      relationship?.canonical_intent ||
      proposed.inbound_intent;
  const relationship_identity = relationship?.identity_class;
  const relationship_outcome = relationship?.relationship_outcome;

  const suppress_globally =
    relationship?.invalidate_phone_globally ||
    relationship?.should_suppress_contact ||
    proposed.suppression_reason?.includes("wrong_number") ||
    proposed.suppression_reason?.includes("opt_out") ||
    proposed.suppression_reason?.includes("hostile");

  const shadow_safety_tier = proposed.safety_tier;
  const shadow_suppressed =
    Boolean(proposed.suppression_reason) ||
    shadow_safety_tier === "suppress" ||
    relationship?.should_suppress_contact;

  return {
    canonical_intent: normalizeField("canonical_intent", relationship_intent),
    identity_class: normalizeField("identity_class", relationship_identity),
    relationship_outcome: normalizeField("relationship_outcome", relationship_outcome),
    suppression_scope: normalizeField(
      "suppression_scope",
      relationship?.suppression_scope ||
        (suppress_globally ? "phone" : "none")
    ),
    universal_stage: normalizeField("universal_stage", shadow_engine.universal_stage),
    granular_stage: normalizeField(
      "granular_stage",
      shadow_engine.granular_stage || proposed.next_stage
    ),
    safety_disposition: normalizeField(
      "safety_disposition",
      deriveSafetyDisposition({
        safety_tier: shadow_safety_tier,
        safety_status: relationship?.safety_status,
        should_suppress_contact: shadow_suppressed,
      })
    ),
    proposed_action: normalizeField(
      "proposed_action",
      suppress_globally || proposed.suppression_reason
        ? "suppress_globally"
        : proposed.should_queue_reply
          ? "auto_reply"
          : "human_review"
    ),
    selected_use_case: normalizeField(
      "selected_use_case",
      recommended_use_case || proposed.template_use_case
    ),
    follow_up_policy: normalizeField(
      "follow_up_policy",
      follow_up_recommendation?.follow_up_policy ||
        follow_up_recommendation?.reason
    ),
    human_review_required: normalizeField(
      "human_review_required",
      shadow_suppressed
        ? false
        : relationship?.human_review_required ||
          proposed.safety_tier === "review" ||
          proposed.safety_tier === "suppress"
    ),
  };
}

function fieldsEquivalent(field, left, right) {
  const a = normalizeField(field, left);
  const b = normalizeField(field, right);
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a === b;
}

function isFieldMaterial(field, agreement, canonical = {}, shadow = {}) {
  if (agreement[field] !== false) return false;

  if (ALWAYS_MATERIAL_FIELDS.includes(field)) {
    return true;
  }

  if (field === "granular_stage") {
    return GRANULAR_DOWNSTREAM_FIELDS.some((downstream) => agreement[downstream] === false);
  }

  if (field === "universal_stage") {
    return false;
  }

  return MATERIAL_COMPARISON_FIELDS.has(field);
}

function classifyComparison({
  agreement = {},
  canonical = {},
  shadow = {},
  transition_comparison = null,
} = {}) {
  const transition_class = transition_comparison?.comparison_class || null;
  const transition_agrees =
    transition_class === "full_agreement" ||
    transition_class === "expected_transition_context_difference";

  const material_disagreement_fields = COMPARISON_FIELDS.filter((field) =>
    isFieldMaterial(field, agreement, canonical, shadow)
  );

  const both_suppress =
    normalizeField("proposed_action", canonical.proposed_action) === "suppress_globally" &&
    normalizeField("proposed_action", shadow.proposed_action) === "suppress_globally";

  if (transition_agrees) {
    for (const field of PRESENTATION_ONLY_FIELDS) {
      const idx = material_disagreement_fields.indexOf(field);
      if (idx >= 0) material_disagreement_fields.splice(idx, 1);
    }
    if (
      agreement.granular_stage === false &&
      !GRANULAR_DOWNSTREAM_FIELDS.some((f) => agreement[f] === false)
    ) {
      const idx = material_disagreement_fields.indexOf("granular_stage");
      if (idx >= 0) material_disagreement_fields.splice(idx, 1);
    }
  }

  if (both_suppress) {
    for (const field of ["selected_use_case", "granular_stage", "human_review_required"]) {
      const idx = material_disagreement_fields.indexOf(field);
      if (idx >= 0) material_disagreement_fields.splice(idx, 1);
    }
  }

  const insufficient_context_fields = COMPARISON_FIELDS.filter((field) => {
    const c = normalizeField(field, canonical[field]);
    const s = normalizeField(field, shadow[field]);
    return (c === null || s === null) && c !== s;
  });

  const review_required_both =
    canonical.human_review_required === true && shadow.human_review_required === true;

  const non_material_disagreement_fields = COMPARISON_FIELDS.filter(
    (field) => agreement[field] === false && !material_disagreement_fields.includes(field)
  );

  if (material_disagreement_fields.length === 0 && insufficient_context_fields.length === 0) {
    if (non_material_disagreement_fields.length > 0 && transition_agrees) {
      return {
        comparison_class: "non_material_disagreement",
        material_disagreement: false,
        material_disagreement_fields: [],
        non_material_disagreement_fields,
        insufficient_context_fields: [],
      };
    }
    return {
      comparison_class: transition_class === "expected_transition_context_difference"
        ? "expected_transition_context_difference"
        : "full_agreement",
      material_disagreement: false,
      material_disagreement_fields: [],
      non_material_disagreement_fields,
      insufficient_context_fields: [],
    };
  }

  if (material_disagreement_fields.length === 0 && insufficient_context_fields.length > 0) {
    return {
      comparison_class: "insufficient_context",
      material_disagreement: false,
      material_disagreement_fields: [],
      non_material_disagreement_fields,
      insufficient_context_fields,
    };
  }

  if (material_disagreement_fields.length === 0) {
    return {
      comparison_class: "non_material_disagreement",
      material_disagreement: false,
      material_disagreement_fields: [],
      non_material_disagreement_fields,
      insufficient_context_fields,
    };
  }

  if (
    review_required_both &&
    material_disagreement_fields.every((f) =>
      ["granular_stage", "selected_use_case", "proposed_action"].includes(f)
    ) &&
    !material_disagreement_fields.includes("safety_disposition") &&
    !material_disagreement_fields.includes("suppression_scope")
  ) {
    return {
      comparison_class: "intentionally_review_required",
      material_disagreement: false,
      material_disagreement_fields: [],
      non_material_disagreement_fields,
      insufficient_context_fields,
    };
  }

  return {
    comparison_class: "material_disagreement",
    material_disagreement: true,
    material_disagreement_fields,
    non_material_disagreement_fields,
    insufficient_context_fields,
  };
}

/**
 * Compare canonical and shadow normalized shapes field-by-field.
 */
export function compareNormalizedDecisionShapes(
  canonical_shape = {},
  shadow_shape = {},
  { transition_comparison = null } = {}
) {
  const agreement = {};
  let agreed_count = 0;

  for (const field of COMPARISON_FIELDS) {
    const agrees = fieldsEquivalent(field, canonical_shape[field], shadow_shape[field]);
    agreement[field] = agrees;
    if (agrees) agreed_count += 1;
  }

  const agreement_score =
    COMPARISON_FIELDS.length > 0
      ? Math.round((agreed_count / COMPARISON_FIELDS.length) * 1000) / 1000
      : 1;

  const classification = classifyComparison({
    agreement,
    canonical: canonical_shape,
    shadow: shadow_shape,
    transition_comparison,
  });

  return {
    agreement,
    agreement_score,
    material_disagreement: classification.material_disagreement,
    material_disagreement_fields: classification.material_disagreement_fields,
    non_material_disagreement_fields: classification.non_material_disagreement_fields || [],
    insufficient_context_fields: classification.insufficient_context_fields,
    comparison_class: classification.comparison_class,
    materiality_model: {
      always_material: ALWAYS_MATERIAL_FIELDS,
      conditionally_material: CONDITIONALLY_MATERIAL_FIELDS,
      presentation_only: PRESENTATION_ONLY_FIELDS,
    },
    transition_comparison: transition_comparison || null,
    canonical_shape,
    shadow_shape,
  };
}

export default compareNormalizedDecisionShapes;