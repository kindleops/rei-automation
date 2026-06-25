import { normalizeUsPhoneToE164 } from "@/lib/sms/sanitize.js";
import { resolveInboundRelationship } from "@/lib/domain/seller-flow/resolve-inbound-relationship.js";

const NON_OWNER_PHRASES = [
  "never been the owner",
  "never was the owner",
  "not the owner",
  "not the property owner",
  "not the homeowner",
  "don't own",
  "do not own",
  "doesn't own",
  "does not own",
  "not my property",
  "not mine",
  "wrong person",
  "not associated with",
];

const NAME_PATTERNS = [
  /(?:his|her|their)\s+name\s+is\s+([^/\n]+?)(?:\s*(?:\/|tel|phone|cell|#|\d)|$)/i,
  /name\s+is\s+([^/\n]+?)(?:\s*(?:\/|tel|phone|cell|#|\d)|$)/i,
];

const INVALID_REFERRAL_NAME_TOKENS = new Set([
  "me",
  "us",
  "him",
  "her",
  "them",
  "again",
  "me again",
]);

const PHONE_PATTERNS = [
  /(?:tel|phone|cell|mobile|#)\s*[:\.]?\s*(\+?1?[\s\-.()]*\d{3}[\s\-.()]*\d{3}[\s\-.()]*\d{4})/i,
  /(\+?1?[\s\-.()]*\d{3}[\s\-.()]*\d{3}[\s\-.()]*\d{4})/,
];

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

export function sanitizeReferredName(rawName = "") {
  let name = clean(rawName)
    .replace(/\s+(tel|phone|cell|mobile)$/i, "")
    .replace(/[.,;:!?]+$/g, "");
  if (!name) return null;
  const normalized = lower(name);
  if (INVALID_REFERRAL_NAME_TOKENS.has(normalized)) return null;
  if (normalized.split(/\s+/).every((token) => INVALID_REFERRAL_NAME_TOKENS.has(token))) {
    return null;
  }
  return name;
}

export function extractReferredName(message = "") {
  for (const pattern of NAME_PATTERNS) {
    const match = message.match(pattern);
    if (match?.[1]) {
      const sanitized = sanitizeReferredName(match[1]);
      if (sanitized) return sanitized;
    }
  }
  return null;
}

export function extractReferredPhone(message = "") {
  for (const pattern of PHONE_PATTERNS) {
    const match = message.match(pattern);
    if (!match?.[1]) continue;
    const normalized = normalizeUsPhoneToE164(match[1]);
    if (normalized) return normalized;
  }
  return null;
}

/**
 * Deterministic referral / next-best-contact extraction.
 * Does not mutate contacts — returns a reviewable proposal only.
 */
export function extractSellerReferral(args = {}) {
  const relationship = resolveInboundRelationship(args);
  if (!relationship.relationship_claim && !relationship.referral_detected) {
    return {
      referral_detected: false,
      relationship_outcome: null,
      reason: "not_non_owner_message",
    };
  }

  const confidence =
    relationship.referred_name && relationship.referred_phone_e164
      ? 0.92
      : relationship.referred_name || relationship.referred_phone_e164
        ? 0.78
        : 0.65;

  return {
    ...relationship,
    confidence,
    extraction_method: relationship.extraction_method,
    proposed_operations: relationship.proposed_operations,
    reason: relationship.referral_detected ? "referral_extracted" : "non_owner_without_referral",
  };
}

function buildReferralProposedOperations({
  referred_name = null,
  referred_phone_e164 = null,
  source_contact_phone = null,
  property_id = null,
  master_owner_id = null,
  prospect_id = null,
  relationship_outcome = null,
} = {}) {
  const operations = [];

  if (source_contact_phone && property_id) {
    operations.push({
      op: "mark_contact_property_non_owner",
      phone_e164: source_contact_phone,
      property_id,
      scope: "property_specific",
      invalidate_globally: false,
    });
  }

  if (referred_phone_e164) {
    operations.push({
      op: "propose_phone_link",
      phone_e164: referred_phone_e164,
      property_id,
      master_owner_id,
      prospect_id,
      idempotent: true,
    });
  }

  if (referred_name) {
    operations.push({
      op: "propose_prospect_create_or_link",
      display_name: referred_name,
      property_id,
      master_owner_id,
      idempotent: true,
    });
  }

  if (referred_phone_e164 || referred_name) {
    operations.push({
      op: "propose_child_thread",
      parent_thread_key: source_contact_phone,
      child_phone_e164: referred_phone_e164,
      child_display_name: referred_name,
      property_id,
      route_to_stage: "ownership_check",
      send_message: false,
    });
  }

  if (relationship_outcome === "property_specific_non_owner_with_referral") {
    operations.push({
      op: "route_referred_contact_stage_1",
      stage: "ownership_check",
      universal_stage: "ownership_confirmation",
      granular_stage: "ownership_check",
    });
  }

  return operations;
}

export function buildReferralDedupeKey({
  source_event_id = null,
  referred_phone_e164 = null,
  property_id = null,
} = {}) {
  return [
    clean(source_event_id) || "no-event",
    clean(referred_phone_e164) || "no-phone",
    clean(property_id) || "no-property",
  ].join(":");
}

export default extractSellerReferral;