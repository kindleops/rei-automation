/**
 * Relationship-first template / use-case policy.
 * Non-owner and referral outcomes must never recommend standard seller-interest templates.
 */

const NON_OWNER_CANONICAL_INTENTS = new Set([
  "non_owner_referral",
  "property_specific_non_owner",
  "former_owner_respondent",
  "tenant_respondent",
  "property_manager_respondent",
  "family_member_respondent",
  "agent_representative_respondent",
  "co_owner_respondent",
  "executor_heir_respondent",
  "entity_representative_respondent",
]);

const RELATIONSHIP_USE_CASE_BY_INTENT = Object.freeze({
  non_owner_referral: "referral_review",
  property_specific_non_owner: "property_scoped_non_owner",
  former_owner_respondent: "former_owner",
  tenant_respondent: "tenant_or_occupancy",
  property_manager_respondent: "property_manager",
  family_member_respondent: "family_member",
  agent_representative_respondent: "agent_representative",
  co_owner_respondent: "authorized_spouse",
  executor_heir_respondent: "executor_or_heir",
  entity_representative_respondent: "entity_representative",
});

const SELLER_INTEREST_USE_CASES = new Set([
  "consider_selling",
  "seller_asking_price",
  "price_response",
  "price_discovery",
  "ownership_check",
]);

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

export function shouldSkipRelationshipAutoTemplate({
  relationship = null,
  canonical_intent = null,
} = {}) {
  if (!relationship) return false;
  if (relationship.ownership_confirmed) return false;
  if (relationship.referral_detected) return true;
  if (relationship.is_property_scoped) return true;
  if (NON_OWNER_CANONICAL_INTENTS.has(lower(canonical_intent))) return true;
  return false;
}

export function resolveRelationshipUseCase({
  relationship = null,
  canonical_intent = null,
  granular_stage = null,
} = {}) {
  const intent = lower(canonical_intent || relationship?.canonical_intent);
  if (relationship?.referral_detected || intent === "non_owner_referral") {
    return {
      use_case: "referral_review",
      stage_code: "referral_review",
      reason: "non_owner_referral_no_seller_interest_template",
      automatic_send_allowed: false,
    };
  }
  if (NON_OWNER_CANONICAL_INTENTS.has(intent)) {
    return {
      use_case: RELATIONSHIP_USE_CASE_BY_INTENT[intent] || "property_scoped_non_owner",
      stage_code: granular_stage || RELATIONSHIP_USE_CASE_BY_INTENT[intent] || "property_scoped_non_owner",
      reason: "relationship_outcome_template_policy",
      automatic_send_allowed: false,
    };
  }
  return null;
}

export function isSellerInterestUseCase(use_case = null) {
  return SELLER_INTEREST_USE_CASES.has(lower(use_case));
}

export function enforceRelationshipTemplatePolicy({
  relationship = null,
  canonical_intent = null,
  granular_stage = null,
  template_use_case = null,
} = {}) {
  const policy = resolveRelationshipUseCase({ relationship, canonical_intent, granular_stage });
  if (!policy) {
    return {
      blocked: false,
      use_case: template_use_case || null,
      reason: null,
    };
  }
  if (template_use_case && isSellerInterestUseCase(template_use_case)) {
    return {
      blocked: true,
      use_case: policy.use_case,
      stage_code: policy.stage_code,
      reason: policy.reason,
      leaked_use_case: template_use_case,
      automatic_send_allowed: false,
    };
  }
  return {
    blocked: Boolean(policy),
    use_case: policy.use_case,
    stage_code: policy.stage_code,
    reason: policy.reason,
    automatic_send_allowed: false,
  };
}

export default resolveRelationshipUseCase;