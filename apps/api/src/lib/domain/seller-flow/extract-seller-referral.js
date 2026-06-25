import { normalizeUsPhoneToE164 } from "@/lib/sms/sanitize.js";

const NAME_SEGMENT_PATTERNS = [
  /(?:his|her|their)\s+name\s+is\s+([^/\n]+?)(?=\s*(?:\/|tel|phone|cell|#|\d|or\s+(?:his|her|their)\s+name)|$)/gi,
  /name\s+is\s+([^/\n]+?)(?=\s*(?:\/|tel|phone|cell|#|\d|or\s+(?:his|her|their)\s+name)|$)/gi,
  /(?:llame\s+a|llamar\s+a|contact(?:ar)?\s+a)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){0,3})/gi,
  /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s+(?:\d{3}[\s\-.()]*\d{3}[\s\-.()]*\d{4})/g,
];

const INVALID_REFERRAL_NAME_TOKENS = new Set([
  "me",
  "us",
  "him",
  "her",
  "them",
  "his",
  "again",
  "me again",
  "or his",
  "or her",
]);

const PHONE_PATTERN =
  /(?:tel|phone|cell|mobile|call|llame|#)?\s*[:\.]?\s*(\+?1?[\s\-.()]*\d{3}[\s\-.()]*\d{3}[\s\-.()]*\d{4})|(\+?1?[\s\-.()]*\d{3}[\s\-.()]*\d{3}[\s\-.()]*\d{4})/gi;

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

export function sanitizeReferredName(rawName = "") {
  let name = clean(rawName)
    .replace(/\s+(tel|phone|cell|mobile)$/i, "")
    .replace(/\s+or\s+(his|her|their)$/i, "")
    .replace(/[.,;:!?]+$/g, "");
  if (!name) return null;
  const normalized = lower(name);
  if (INVALID_REFERRAL_NAME_TOKENS.has(normalized)) return null;
  if (/^(his|her|their|or)$/i.test(name)) return null;
  if (normalized.split(/\s+/).every((token) => INVALID_REFERRAL_NAME_TOKENS.has(token))) {
    return null;
  }
  return name;
}

export function extractAllReferredNames(message = "") {
  const found = [];
  const seen = new Set();

  for (const pattern of NAME_SEGMENT_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(message)) !== null) {
      const sanitized = sanitizeReferredName(match[1]);
      if (!sanitized) continue;
      const key = lower(sanitized);
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({
        name: sanitized,
        source_span: match[0],
        start: match.index,
      });
    }
  }

  return found;
}

export function extractAllReferredPhones(message = "") {
  const found = [];
  const seen = new Set();
  let match;

  PHONE_PATTERN.lastIndex = 0;
  while ((match = PHONE_PATTERN.exec(message)) !== null) {
    const raw = match[1] || match[2];
    const normalized = normalizeUsPhoneToE164(raw);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    found.push({
      phone_e164: normalized,
      source_span: match[0],
      start: match.index,
      malformed: false,
    });
  }

  const malformed_match = message.match(/(?:tel|phone|cell|#)\s*[:\.]?\s*(\d{1,5})\b/i);
  if (malformed_match && found.length === 0) {
    found.push({
      phone_e164: null,
      source_span: malformed_match[0],
      start: malformed_match.index,
      malformed: true,
    });
  }

  return found;
}

function pairReferralCandidates(names = [], phones = []) {
  const referrals = [];

  if (names.length === 1 && phones.length === 1 && !phones[0].malformed) {
    referrals.push({
      name: names[0].name,
      phone_e164: phones[0].phone_e164,
      confidence: 0.98,
      source_span: `${names[0].source_span} ${phones[0].source_span}`.trim(),
      dedupe_status: "new_or_unknown",
      pairing: "explicit_single",
    });
    return { referrals, ambiguous: false };
  }

  if (names.length === 0 && phones.length === 1 && !phones[0].malformed) {
    referrals.push({
      name: null,
      phone_e164: phones[0].phone_e164,
      confidence: 0.82,
      source_span: phones[0].source_span,
      dedupe_status: "new_or_unknown",
      pairing: "phone_only",
    });
    return { referrals, ambiguous: false };
  }

  if (names.length === 1 && phones.length === 0) {
    referrals.push({
      name: names[0].name,
      phone_e164: null,
      confidence: 0.78,
      source_span: names[0].source_span,
      dedupe_status: "new_or_unknown",
      pairing: "name_only",
    });
    return { referrals, ambiguous: false };
  }

  const ambiguous = names.length > 1 || phones.length > 1;

  for (const name_entry of names) {
    const nearest_phone = phones
      .filter((p) => !p.malformed && p.phone_e164)
      .sort(
        (a, b) =>
          Math.abs(a.start - name_entry.start) - Math.abs(b.start - name_entry.start)
      )[0];

    const within_window =
      nearest_phone && Math.abs(nearest_phone.start - name_entry.start) <= 80;

    referrals.push({
      name: name_entry.name,
      phone_e164: within_window ? nearest_phone.phone_e164 : null,
      confidence: within_window ? 0.9 : 0.72,
      source_span: name_entry.source_span,
      dedupe_status: "new_or_unknown",
      pairing: within_window ? "proximity_pair" : "name_unpaired",
    });
  }

  for (const phone_entry of phones) {
    if (phone_entry.malformed) {
      referrals.push({
        name: null,
        phone_e164: null,
        confidence: 0.2,
        source_span: phone_entry.source_span,
        dedupe_status: "malformed_phone",
        pairing: "malformed",
        malformed: true,
      });
      continue;
    }

    const already_paired = referrals.some((r) => r.phone_e164 === phone_entry.phone_e164);
    if (!already_paired) {
      referrals.push({
        name: null,
        phone_e164: phone_entry.phone_e164,
        confidence: 0.8,
        source_span: phone_entry.source_span,
        dedupe_status: "new_or_unknown",
        pairing: "phone_unpaired",
      });
    }
  }

  return { referrals, ambiguous };
}

export function extractReferredName(message = "") {
  const names = extractAllReferredNames(message);
  return names[0]?.name || null;
}

export function extractReferredPhone(message = "") {
  const phones = extractAllReferredPhones(message).filter((p) => p.phone_e164);
  return phones[0]?.phone_e164 || null;
}

export function extractReferralCandidates(message = "", known_phones = []) {
  const names = extractAllReferredNames(message);
  const phones = extractAllReferredPhones(message);
  const { referrals, ambiguous } = pairReferralCandidates(names, phones);

  const known_set = new Set((known_phones || []).map((p) => clean(p)));
  for (const referral of referrals) {
    if (referral.phone_e164 && known_set.has(referral.phone_e164)) {
      referral.dedupe_status = "already_known";
      referral.confidence = Math.min(referral.confidence, 0.95);
    }
  }

  return {
    referrals,
    ambiguous,
    referral_detected:
      referrals.some((r) => r.name || r.phone_e164) &&
      !referrals.every((r) => r.malformed),
  };
}

export function buildReferralDedupeKey({
  source_event_id = null,
  referred_phone_e164 = null,
  property_id = null,
  referred_name = null,
} = {}) {
  return [
    clean(source_event_id) || "no-event",
    clean(referred_phone_e164) || clean(referred_name) || "no-contact",
    clean(property_id) || "no-property",
  ].join(":");
}

export function buildReferralProposedOperations({
  referrals = [],
  source_contact_phone = null,
  property_id = null,
  master_owner_id = null,
  prospect_id = null,
  relationship_outcome = null,
  ambiguous = false,
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

  for (const referral of referrals) {
    if (referral.malformed) continue;

    if (referral.phone_e164) {
      operations.push({
        op: "propose_phone_link",
        phone_e164: referral.phone_e164,
        property_id,
        master_owner_id,
        prospect_id,
        idempotent: true,
        dedupe_status: referral.dedupe_status,
      });
    }

    if (referral.name) {
      operations.push({
        op: "propose_prospect_create_or_link",
        display_name: referral.name,
        property_id,
        master_owner_id,
        idempotent: true,
        dedupe_status: referral.dedupe_status,
      });
    }

    if (referral.phone_e164 || referral.name) {
      operations.push({
        op: "propose_child_thread",
        parent_thread_key: source_contact_phone,
        child_phone_e164: referral.phone_e164,
        child_display_name: referral.name,
        property_id,
        route_to_stage: "ownership_check",
        send_message: false,
        merge_with_parent_timeline: false,
        dedupe_status: referral.dedupe_status,
      });
    }
  }

  if (relationship_outcome === "property_specific_non_owner_with_referral") {
    operations.push({
      op: "route_referred_contact_stage_1",
      stage: "ownership_check",
      universal_stage: "ownership_confirmation",
      granular_stage: "ownership_check",
      automatic_send_allowed: false,
      review_required: true,
      ambiguous_pairing: ambiguous,
    });
  }

  return operations;
}

/**
 * Enrich a resolved relationship with multi-candidate referral extraction.
 */
export function extractSellerReferral(args = {}) {
  const relationship = args.relationship || null;
  if (!relationship) {
    return {
      referral_detected: false,
      referrals: [],
      relationship_outcome: null,
      reason: "missing_relationship",
    };
  }

  if (!relationship.relationship_claim && !relationship.referral_detected) {
    return {
      referral_detected: false,
      referrals: [],
      relationship_outcome: null,
      reason: "not_non_owner_message",
    };
  }

  const candidate_result = extractReferralCandidates(
    args.message || "",
    args.known_phones || []
  );

  const referrals = candidate_result.referrals;
  const referral_detected = Boolean(
    relationship.referral_detected || candidate_result.referral_detected
  );

  const human_review_required =
    relationship.human_review_required ||
    candidate_result.ambiguous ||
    referrals.length > 1;

  const proposed_operations = buildReferralProposedOperations({
    referrals,
    source_contact_phone: relationship.source_contact_phone,
    property_id: relationship.property_id,
    master_owner_id: relationship.master_owner_id,
    prospect_id: relationship.prospect_id,
    relationship_outcome: relationship.relationship_outcome,
    ambiguous: candidate_result.ambiguous,
  });

  const primary = referrals.find((r) => r.name || r.phone_e164) || null;

  return {
    ...relationship,
    referrals,
    referral_detected,
    referred_name: primary?.name || null,
    referred_phone_e164: primary?.phone_e164 || null,
    ambiguous_pairing: candidate_result.ambiguous,
    human_review_required,
    confidence: primary?.confidence ?? null,
    extraction_method: "referral_extractor_v2",
    proposed_operations,
    reason: referral_detected ? "referral_extracted" : "non_owner_without_referral",
  };
}

export default extractSellerReferral;