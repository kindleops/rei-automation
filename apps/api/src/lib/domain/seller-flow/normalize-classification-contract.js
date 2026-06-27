import { normalizeCanonicalIntent } from "@/lib/domain/seller-flow/coverage-net/canonical-intent-aliases.js";
import { resolveInboundRelationship } from "@/lib/domain/seller-flow/resolve-inbound-relationship.js";
import { resolveOwnershipProbeDisinterestTransition } from "@/lib/domain/inbox/resolve-inbox-state-from-classification.js";

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

const OWNERSHIP_SIGNALS = Object.freeze({
  CONFIRMED: "confirmed",
  INFERRED: "inferred",
  DENIED: "denied",
  UNKNOWN: "unknown",
});

function deriveOwnershipSignal({
  classification = {},
  relationship = null,
  ownership_probe = null,
} = {}) {
  if (relationship?.ownership_confirmed) return OWNERSHIP_SIGNALS.CONFIRMED;
  if (ownership_probe?.ownership_status === "inferred") return OWNERSHIP_SIGNALS.INFERRED;
  if (ownership_probe?.ownership_status === "confirmed") return OWNERSHIP_SIGNALS.CONFIRMED;

  const primary = normalizeCanonicalIntent(classification.primary_intent);
  if (primary === "ownership_confirmed") return OWNERSHIP_SIGNALS.CONFIRMED;
  if (primary === "wrong_number" || relationship?.relationship_claim === "never_been_owner") {
    return OWNERSHIP_SIGNALS.DENIED;
  }
  if (
    ["not_owner", "former_owner", "actual_wrong_number"].includes(relationship?.relationship_claim)
  ) {
    return OWNERSHIP_SIGNALS.DENIED;
  }
  if (primary === "not_interested" && ownership_probe) return OWNERSHIP_SIGNALS.INFERRED;
  return OWNERSHIP_SIGNALS.UNKNOWN;
}

function deriveInterestSignal(classification = {}) {
  const primary = normalizeCanonicalIntent(classification.primary_intent);
  if (["seller_interested", "latent_interest", "asks_offer", "asking_price_provided"].includes(primary)) {
    return "interested";
  }
  if (primary === "not_interested") return "not_interested";
  if (primary === "need_time") return "conditional";
  return "unknown";
}

function deriveReviewRequirement(classification = {}) {
  const primary = normalizeCanonicalIntent(classification.primary_intent);
  const confidence =
    typeof classification.confidence === "number" ? classification.confidence : 0;
  const automation = classification.automation_decision || {};

  if (automation.human_review_required === true) return { required: true, reason: "automation_review" };
  if (primary === "unclear" && confidence < 0.82) {
    return { required: true, reason: "unclear_low_confidence" };
  }
  if (primary === "property_correction") return { required: true, reason: "property_correction" };
  if (primary === "hostile_or_legal") return { required: true, reason: "hostile_or_legal" };
  return { required: false, reason: null };
}

/**
 * Normalize classify.js output into the canonical inbound classification contract
 * consumed by seller-flow orchestration.
 */
export function normalizeClassificationContract({
  classification = null,
  message = "",
  messageId = null,
  threadId = null,
  propertyId = null,
  participantId = null,
  prospectId = null,
  phone = null,
  context = null,
  inboundEventId = null,
} = {}) {
  if (!classification || typeof classification !== "object") {
    return {
      ok: false,
      reason: "missing_classification",
      contract: null,
    };
  }

  const relationship = resolveInboundRelationship({
    message,
    classification,
    source_event_id: inboundEventId,
    source_thread_key: threadId || phone,
    source_contact_phone: phone || threadId,
    property_id: propertyId,
    master_owner_id: context?.ids?.master_owner_id || null,
    prospect_id: prospectId || participantId || null,
  });

  const ownership_probe = resolveOwnershipProbeDisinterestTransition({
    classification,
    messageEvent: { message_body: message, direction: "inbound" },
    existingState: {
      conversation_stage:
        context?.summary?.conversation_stage || classification.stage_hint || null,
      seller_stage: context?.summary?.seller_stage || null,
      ownership_status: context?.summary?.ownership_status || null,
    },
  });

  const normalized_intent = normalizeCanonicalIntent(
    relationship?.canonical_intent || classification.primary_intent
  );
  const review = deriveReviewRequirement(classification);
  const seller_state = classification.seller_state || {};

  const contract = {
    message_id: clean(messageId) || clean(inboundEventId) || null,
    thread_id: clean(threadId) || clean(phone) || null,
    property_id: clean(propertyId) || clean(context?.ids?.property_id) || null,
    participant_id: clean(participantId) || clean(prospectId) || clean(context?.ids?.prospect_id) || null,
    prospect_id: clean(prospectId) || clean(context?.ids?.prospect_id) || null,
    phone: clean(phone) || clean(threadId) || null,
    language: clean(classification.language) || "English",
    normalized_intent,
    confidence: typeof classification.confidence === "number" ? classification.confidence : null,
    extracted_facts: {
      asking_price: seller_state.price_mentioned ?? classification.asking_price ?? null,
      condition: classification.condition_facts || seller_state.condition || null,
      motivation: seller_state.motivation_level || classification.motivation_score || null,
      timeline: seller_state.timeline || null,
      offer_response: classification.offer_response || null,
      contract_response: classification.contract_response || null,
      referral: relationship?.referral_detected
        ? {
            name: relationship.referred_name || null,
            phone: relationship.referred_phone_e164 || null,
            relationship: relationship.relationship_claim || null,
          }
        : null,
      tenant_occupied: seller_state.tenant_occupied === true,
      creative_finance_open: seller_state.creative_finance_open === true,
    },
    ownership_signal: deriveOwnershipSignal({ classification, relationship, ownership_probe }),
    interest_signal: deriveInterestSignal(classification),
    wrong_number_signal: normalized_intent === "wrong_number" || relationship?.invalidate_phone_globally === true,
    opt_out_signal:
      normalized_intent === "opt_out" || clean(classification.compliance_flag) === "stop_texting",
    ambiguity_review_required: review.required,
    review_reason: review.reason,
    relationship,
    ownership_probe_transition: ownership_probe,
    raw_classification: classification,
    automation_decision: classification.automation_decision || null,
  };

  return { ok: true, contract };
}

export { OWNERSHIP_SIGNALS };
export default normalizeClassificationContract;