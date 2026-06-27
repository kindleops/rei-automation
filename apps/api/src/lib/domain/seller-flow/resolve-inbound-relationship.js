import { normalizeUsPhoneToE164 } from "@/lib/sms/sanitize.js";
import {
  extractReferralCandidates,
  buildReferralDedupeKey,
  buildReferralProposedOperations,
} from "@/lib/domain/seller-flow/extract-seller-referral.js";

export const RELATIONSHIP_CLAIMS = Object.freeze([
  "ownership_confirmed",
  "actual_wrong_number",
  "never_been_owner",
  "not_owner",
  "former_owner",
  "tenant",
  "property_manager",
  "agent",
  "spouse_co_owner",
  "executor_heir",
  "llc_representative",
  "referral_source",
]);

export const PROPERTY_SCOPED_CLAIMS = new Set([
  "never_been_owner",
  "not_owner",
  "former_owner",
  "tenant",
  "property_manager",
  "agent",
  "spouse_co_owner",
  "executor_heir",
  "llc_representative",
  "referral_source",
]);

const OWNERSHIP_CONFIRM_PHRASES = [
  "yes i own",
  "yes, i own",
  "i own it",
  "i'm the owner",
  "im the owner",
  "i am the owner",
  "that's my property",
  "yes that's my property",
  "yes, that's my property",
  "yes that is my property",
  "i own the property",
  "i own this property",
];

const ACTUAL_WRONG_NUMBER_PHRASES = [
  "wrong number",
  "you have the wrong number",
  "incorrect number",
  "this is the wrong number",
  "not this number",
  "no longer my number",
];

const NEVER_OWNER_PHRASES = ["never been the owner", "never was the owner", "never owned"];
const FORMER_OWNER_PHRASES = [
  "no longer own",
  "sold it",
  "already sold",
  "sold years ago",
  "former owner",
];
const TENANT_PHRASES = ["tenant", "renter", "lease", "leasing", "occupied by tenant"];
const PROPERTY_MANAGER_PHRASES = ["property manager", "manages the property", "management company"];
const AGENT_PHRASES = ["realtor", "real estate agent", "listing agent", "my agent"];
const SPOUSE_PHRASES = ["my wife owns", "my husband owns", "spouse owns", "co-owner", "co owner"];
const EXECUTOR_PHRASES = ["executor", "heir", "estate", "probate", "trustee"];
const LLC_PHRASES = ["llc", "representative for", "on behalf of the company"];

const SAFETY_PRIORITY_INTENTS = new Set(["opt_out", "hostile_or_legal"]);

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function includesAny(text, phrases = []) {
  const normalized = lower(text);
  return phrases.some((phrase) => normalized.includes(lower(phrase)));
}

const NEGATIVE_OWNERSHIP_PHRASES = [
  "do not own",
  "don't own",
  "not the owner",
  "not the property owner",
  "not the homeowner",
  "not my property",
  "not mine",
  "never been the owner",
  "never was the owner",
  "never owned",
  "wrong person",
  "no soy el dueño",
  "no soy el dueno",
  "no soy la dueña",
  "no soy la duena",
];

function detectOwnershipConfirmation(message = "", classifier_intent = null) {
  const text = lower(message);
  if (includesAny(text, NEGATIVE_OWNERSHIP_PHRASES)) return false;
  if (classifier_intent === "ownership_confirmed") return true;
  return includesAny(text, OWNERSHIP_CONFIRM_PHRASES);
}

function detectRelationshipClaim(message = "") {
  const text = lower(message);
  if (includesAny(text, ACTUAL_WRONG_NUMBER_PHRASES) && !includesAny(text, NEVER_OWNER_PHRASES)) {
    return "actual_wrong_number";
  }
  if (includesAny(text, NEVER_OWNER_PHRASES)) return "never_been_owner";
  if (includesAny(text, FORMER_OWNER_PHRASES)) return "former_owner";
  if (includesAny(text, TENANT_PHRASES)) return "tenant";
  if (includesAny(text, PROPERTY_MANAGER_PHRASES)) return "property_manager";
  if (includesAny(text, AGENT_PHRASES)) return "agent";
  if (includesAny(text, SPOUSE_PHRASES)) return "spouse_co_owner";
  if (includesAny(text, EXECUTOR_PHRASES)) return "executor_heir";
  if (includesAny(text, LLC_PHRASES)) return "llc_representative";
  if (
    includesAny(text, [
      "not the owner",
      "not the property owner",
      "not the homeowner",
      "don't own",
      "do not own",
      "not my property",
      "not mine",
      "wrong person",
      "no soy el dueño",
      "no soy el dueno",
      "no soy la dueña",
      "no soy la duena",
    ])
  ) {
    return "not_owner";
  }
  return null;
}

function deriveCanonicalIntent({
  relationship_claim = null,
  referral_detected = false,
  classifier_intent = null,
  ownership_confirmed = false,
} = {}) {
  if (classifier_intent === "hostile_or_legal") return "hostile_or_legal";
  if (relationship_claim === "actual_wrong_number" || classifier_intent === "opt_out") {
    return classifier_intent === "opt_out" ? "opt_out" : "wrong_number";
  }
  if (referral_detected) return "non_owner_referral";
  if (ownership_confirmed || relationship_claim === "ownership_confirmed") {
    return "ownership_confirmed";
  }
  if (relationship_claim === "tenant") return "tenant_respondent";
  if (relationship_claim === "former_owner") return "former_owner_respondent";
  if (relationship_claim === "property_manager") return "property_manager_respondent";
  if (relationship_claim === "agent") return "agent_representative_respondent";
  if (relationship_claim === "spouse_co_owner") return "co_owner_respondent";
  if (relationship_claim === "executor_heir") return "executor_heir_respondent";
  if (relationship_claim === "llc_representative") return "entity_representative_respondent";
  if (PROPERTY_SCOPED_CLAIMS.has(relationship_claim)) return "property_specific_non_owner";
  return classifier_intent || "unclear";
}

function deriveIdentityClass({
  relationship_claim = null,
  referral_detected = false,
  ownership_confirmed = false,
} = {}) {
  if (relationship_claim === "actual_wrong_number") return "wrong_number";
  if (referral_detected || relationship_claim === "referral_source") return "respondent_non_owner";
  if (ownership_confirmed || relationship_claim === "ownership_confirmed") {
    return "confirmed_owner";
  }
  if (relationship_claim === "tenant") return "renter_occupant";
  if (relationship_claim === "agent") return "agent_representative";
  if (relationship_claim === "property_manager") return "property_manager";
  if (relationship_claim === "former_owner") return "former_owner";
  if (relationship_claim === "spouse_co_owner") return "authorized_spouse";
  if (relationship_claim === "executor_heir") return "executor_or_heir";
  if (relationship_claim === "llc_representative") return "entity_representative";
  if (PROPERTY_SCOPED_CLAIMS.has(relationship_claim)) return "respondent_non_owner";
  return "unknown";
}

function deriveRelationshipOutcome({
  relationship_claim = null,
  referral_detected = false,
  ownership_confirmed = false,
} = {}) {
  if (relationship_claim === "actual_wrong_number") return "actual_wrong_number";
  if (referral_detected) return "property_specific_non_owner_with_referral";
  if (ownership_confirmed || relationship_claim === "ownership_confirmed") {
    return "confirmed_owner";
  }
  if (relationship_claim === "spouse_co_owner") return "co_owner";
  if (relationship_claim === "executor_heir") return "executor_or_heir";
  if (relationship_claim === "llc_representative") return "entity_representative";
  if (PROPERTY_SCOPED_CLAIMS.has(relationship_claim)) return "property_specific_non_owner";
  return null;
}

function deriveSuppression({
  relationship_claim = null,
  property_id = null,
  classifier_intent = null,
  ownership_confirmed = false,
} = {}) {
  if (ownership_confirmed) {
    return {
      suppression_scope: "none",
      suppression_property_id: null,
      invalidate_phone_globally: false,
      invalidate_person_globally: false,
      should_suppress_contact: false,
      safety_status: "allowed",
    };
  }

  if (classifier_intent === "opt_out" || classifier_intent === "hostile_or_legal") {
    return {
      suppression_scope: classifier_intent === "opt_out" ? "global" : "incident",
      suppression_property_id: null,
      invalidate_phone_globally: classifier_intent === "opt_out",
      invalidate_person_globally: classifier_intent === "opt_out",
      should_suppress_contact: true,
      safety_status: "suppressed",
    };
  }

  if (relationship_claim === "actual_wrong_number") {
    return {
      suppression_scope: "phone",
      suppression_property_id: null,
      invalidate_phone_globally: true,
      invalidate_person_globally: false,
      should_suppress_contact: true,
      safety_status: "suppressed",
    };
  }

  if (PROPERTY_SCOPED_CLAIMS.has(relationship_claim)) {
    return {
      suppression_scope: "property",
      suppression_property_id: clean(property_id) || null,
      invalidate_phone_globally: false,
      invalidate_person_globally: false,
      should_suppress_contact: false,
      safety_status: "review",
    };
  }

  return {
    suppression_scope: "none",
    suppression_property_id: null,
    invalidate_phone_globally: false,
    invalidate_person_globally: false,
    should_suppress_contact: false,
    safety_status: null,
  };
}

/**
 * Resolve property-scoped relationship semantics that must not collapse into
 * global wrong-number suppression.
 */
export function resolveInboundRelationship({
  message = "",
  classification = null,
  source_event_id = null,
  source_thread_key = null,
  source_contact_phone = null,
  property_id = null,
  master_owner_id = null,
  prospect_id = null,
  known_phones = [],
} = {}) {
  const text = clean(message);
  const classifier_intent = clean(
    classification?.primary_intent || classification?.detected_intent
  );

  const ownership_confirmed = detectOwnershipConfirmation(text, classifier_intent);
  let relationship_claim = ownership_confirmed
    ? "ownership_confirmed"
    : detectRelationshipClaim(text);

  const referral_candidates = extractReferralCandidates(text, known_phones);
  const referral_detected =
    !SAFETY_PRIORITY_INTENTS.has(classifier_intent) &&
    !ownership_confirmed &&
    referral_candidates.referral_detected;

  const referrals = referral_candidates.referrals;
  const primary_referral = referrals.find((r) => r.name || r.phone_e164) || null;

  const canonical_intent = deriveCanonicalIntent({
    relationship_claim,
    referral_detected,
    classifier_intent,
    ownership_confirmed,
  });
  const identity_class = deriveIdentityClass({
    relationship_claim,
    referral_detected,
    ownership_confirmed,
  });
  const relationship_outcome = deriveRelationshipOutcome({
    relationship_claim,
    referral_detected,
    ownership_confirmed,
  });
  const suppression = deriveSuppression({
    relationship_claim,
    property_id,
    classifier_intent,
    ownership_confirmed,
  });

  const referred_automatic_send_candidate =
    referral_detected &&
    !referral_candidates.ambiguous &&
    referrals.length === 1 &&
    Boolean(primary_referral?.phone_e164) &&
    !primary_referral?.malformed &&
    primary_referral?.dedupe_status !== "already_known" &&
    !SAFETY_PRIORITY_INTENTS.has(classifier_intent);

  const human_review_required = referred_automatic_send_candidate
    ? false
    : (
      referral_detected ||
      referral_candidates.ambiguous ||
      referrals.length > 1 ||
      relationship_claim === "spouse_co_owner" ||
      (PROPERTY_SCOPED_CLAIMS.has(relationship_claim) && relationship_claim !== "ownership_confirmed") ||
      canonical_intent === "unclear"
    );

  const automatic_send_allowed = false;
  const referred_automatic_send_allowed = referred_automatic_send_candidate;

  const referred_contact_proposed_stage = referral_detected
    ? "ownership_confirmation"
    : null;

  const proposed_operations =
    referral_detected || PROPERTY_SCOPED_CLAIMS.has(relationship_claim)
      ? buildReferralProposedOperations({
          referrals,
          source_contact_phone:
            normalizeUsPhoneToE164(source_contact_phone) || clean(source_contact_phone),
          property_id,
          master_owner_id,
          prospect_id,
          relationship_outcome,
          ambiguous: referral_candidates.ambiguous,
        })
      : [];

  if (
    source_contact_phone &&
    property_id &&
    PROPERTY_SCOPED_CLAIMS.has(relationship_claim) &&
    !proposed_operations.some((op) => op.op === "mark_contact_property_non_owner")
  ) {
    proposed_operations.unshift({
      op: "mark_contact_property_non_owner",
      phone_e164: normalizeUsPhoneToE164(source_contact_phone) || source_contact_phone,
      property_id,
      scope: "property_specific",
      invalidate_globally: false,
    });
  }

  return {
    relationship_claim,
    canonical_intent,
    identity_class,
    relationship_outcome,
    referral_detected,
    referrals,
    ambiguous_pairing: referral_candidates.ambiguous,
    referred_name: primary_referral?.name || null,
    referred_phone_e164: primary_referral?.phone_e164 || null,
    referred_contact_proposed_stage,
    referred_role: referral_detected ? "referred_possible_owner" : null,
    suppression_scope: suppression.suppression_scope,
    suppression_property_id: suppression.suppression_property_id,
    invalidate_phone_globally: suppression.invalidate_phone_globally,
    invalidate_person_globally: suppression.invalidate_person_globally,
    should_suppress_contact: suppression.should_suppress_contact,
    safety_status: suppression.safety_status,
    human_review_required,
    automatic_send_allowed,
    referred_automatic_send_allowed,
    ownership_confirmed,
    universal_stage: ownership_confirmed ? "offer_interest" : null,
    is_property_scoped: PROPERTY_SCOPED_CLAIMS.has(relationship_claim),
    is_global_suppression: suppression.invalidate_phone_globally,
    source_event_id: clean(source_event_id) || null,
    source_thread_key: clean(source_thread_key) || null,
    source_contact_phone:
      normalizeUsPhoneToE164(source_contact_phone) || clean(source_contact_phone) || null,
    property_id: clean(property_id) || null,
    master_owner_id: clean(master_owner_id) || null,
    prospect_id: clean(prospect_id) || null,
    dedupe_key: buildReferralDedupeKey({
      source_event_id,
      referred_phone_e164: primary_referral?.phone_e164,
      referred_name: primary_referral?.name,
      property_id,
    }),
    proposed_operations,
    review_status: referral_detected ? "pending_review" : null,
    extraction_method: "relationship_resolver_v2",
  };
}

export function isGlobalSuppressionRelationship(relationship = null) {
  if (!relationship) return false;
  return Boolean(
    relationship.is_global_suppression ||
      relationship.invalidate_phone_globally ||
      relationship.suppression_scope === "global" ||
      relationship.suppression_scope === "phone"
  );
}

export default resolveInboundRelationship;