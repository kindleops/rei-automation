import { clean, lower } from "@/lib/utils/strings.js";
import {
  calculateOwnerProspectAlignment,
  normalizeMatchingFlags,
} from "@/lib/identity/ownerProspectAlignment.js";
import {
  evaluatePreSendEligibility,
  selectNextBestOwnerContact,
} from "@/lib/domain/outbound/presend-eligibility-engine.js";
import { resolveContactIdentityClass } from "@/lib/domain/inbox/contact-identity.js";

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

const OWNERSHIP_INFER_PHRASES = [
  "not for sale",
  "not interested",
  "we are not selling",
  "we're not selling",
  "not selling",
  "no interest",
  "do not want an offer",
  "don't want an offer",
  "stop asking about the house",
  "stop asking about this house",
];

const OWNERSHIP_DENY_PHRASES = [
  "not the owner",
  "not the property owner",
  "not the homeowner",
  "don't own",
  "do not own",
  "not my property",
  "not mine",
  "wrong person",
  "never been the owner",
  "never owned",
];

const FLAG_LABELS = Object.freeze({
  confirmed_owner: "Confirmed Owner",
  likely_owner: "Likely Owner",
  property_owner: "Property Owner",
  family: "Family",
  spouse: "Spouse",
  resident: "Resident",
  primary_decision_maker: "Primary Decision Maker",
  co_owner: "Co-owner",
  heir: "Heir",
  executor: "Executor",
  authorized_representative: "Authorized Representative",
  likely_renter: "Likely Renter",
  tenant: "Tenant",
  property_manager: "Property Manager",
  wrong_person: "Wrong Person",
});

const RENTER_ONLY_FLAGS = new Set([
  "likely_renter",
  "tenant",
]);

const OWNER_EVIDENCE_FLAGS = new Set([
  "confirmed_owner",
  "likely_owner",
  "property_owner",
  "spouse",
  "family",
  "co_owner",
  "heir",
  "executor",
  "authorized_representative",
]);

function includesAny(text, phrases = []) {
  const normalized = lower(text);
  return phrases.some((phrase) => normalized.includes(lower(phrase)));
}

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseFlagsText(text = "") {
  return lower(clean(text))
    .split(/[,;|]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function detectOwnershipFromMessage(message = "", existing = {}) {
  const text = clean(message);
  const prior = lower(existing.ownership_status || "");
  if (prior === "confirmed" && !includesAny(text, OWNERSHIP_DENY_PHRASES)) {
    return {
      ownership_status: "confirmed",
      confidence: existing.ownership_confidence ?? 0.95,
      source: existing.confirmation_source || "prior_confirmation",
      inference_reason: null,
    };
  }
  if (includesAny(text, OWNERSHIP_DENY_PHRASES)) {
    return {
      ownership_status: "denied",
      confidence: 0.9,
      source: "message_denial",
      inference_reason: "explicit_non_owner",
    };
  }
  if (includesAny(text, OWNERSHIP_CONFIRM_PHRASES) || existing.owner_confirmed === true) {
    return {
      ownership_status: "confirmed",
      confidence: 0.92,
      source: "message_confirmation",
      inference_reason: null,
    };
  }
  if (includesAny(text, OWNERSHIP_INFER_PHRASES)) {
    return {
      ownership_status: "inferred",
      confidence: 0.72,
      source: "message_property_knowledge",
      inference_reason: "property_specific_response_without_owner_confirmation",
    };
  }
  if (lower(existing.relationship_outcome) === "confirmed_owner" || existing.owner_confirmed === true) {
    return {
      ownership_status: "confirmed",
      confidence: existing.ownership_confidence ?? 0.88,
      source: existing.confirmation_source || "relationship_outcome",
      inference_reason: null,
    };
  }
  return {
    ownership_status: "unconfirmed",
    confidence: null,
    source: null,
    inference_reason: null,
  };
}

export function deriveOwnerMatchFlags(participant = {}) {
  const flags = new Set();
  const matching = parseFlagsText(participant.matching_flags || "");
  const person = parseFlagsText(participant.person_flags_text || "");
  const identity = lower(participant.identity_class || participant.relationship_to_property || "");
  const ownership = lower(participant.ownership_status || "");

  if (ownership === "confirmed" || identity === "confirmed_owner") flags.add("confirmed_owner");
  if (participant.likely_owner === true || matching.includes("likely owner") || matching.includes("likely_owner")) {
    flags.add("likely_owner");
  }
  if (matching.includes("property owner") || person.includes("property owner")) flags.add("property_owner");
  if (person.includes("family") || matching.includes("family") || matching.includes("relative")) flags.add("family");
  if (person.includes("spouse") || matching.includes("spouse") || identity === "authorized_spouse") flags.add("spouse");
  if (person.includes("resident") || matching.includes("resident") || person.includes("occupant")) flags.add("resident");
  if (person.includes("primary decision maker") || person.includes("decision maker")) flags.add("primary_decision_maker");
  if (person.includes("co-owner") || person.includes("co owner") || identity === "co_owner") flags.add("co_owner");
  if (person.includes("heir") || identity === "executor_or_heir") flags.add("heir");
  if (person.includes("executor") || identity === "executor_or_heir") flags.add("executor");
  if (person.includes("representative") || identity === "entity_representative") flags.add("authorized_representative");
  if (participant.likely_renting === true || matching.includes("likely renting") || matching.includes("tenant")) {
    flags.add("likely_renter");
  }
  if (person.includes("tenant") || person.includes("renter") || identity === "renter_occupant") flags.add("tenant");
  if (person.includes("property manager") || identity === "property_manager") flags.add("property_manager");
  if (identity === "wrong_person" || identity === "wrong_number") flags.add("wrong_person");

  const alignment = participant.alignment || null;
  if (alignment?.status === "verified" && !flags.has("confirmed_owner")) flags.add("likely_owner");
  if (alignment?.status === "probable" && !flags.has("likely_owner")) flags.add("likely_owner");

  return [...flags].map((key) => ({
    key,
    label: FLAG_LABELS[key] || key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
  }));
}

export function isRenterTenantOnly(participant = {}) {
  const flags = deriveOwnerMatchFlags(participant).map((row) => row.key);
  const renterFlags = flags.filter((key) => RENTER_ONLY_FLAGS.has(key));
  if (!renterFlags.length) return false;
  const hasOwnerEvidence = flags.some((key) => OWNER_EVIDENCE_FLAGS.has(key));
  const ownership = lower(participant.ownership_status || "");
  if (hasOwnerEvidence || ownership === "confirmed" || ownership === "inferred") return false;
  return true;
}

function contactRankLabel(rank, participant = {}) {
  if (rank === 1) {
    if (participant.ownership_status === "confirmed") return "Primary contact";
    return "#1 recommended";
  }
  if (rank === 2) return "#2 alternate";
  if (rank >= 3) return `#${rank} alternate`;
  if (participant._eligibility?.hard_block || isRenterTenantOnly(participant)) return "Low-confidence contact";
  return "Alternate contact";
}

function scoreParticipant(participant = {}, masterOwnerName = "") {
  const alignment = calculateOwnerProspectAlignment({
    masterOwnerName,
    ownerDisplayName: masterOwnerName,
    ownerName: masterOwnerName,
    prospectFullName: participant.display_name,
    phoneFullName: participant.display_name,
    likelyOwner: participant.likely_owner,
    likelyRenting: participant.likely_renting,
    matchingFlags: participant.matching_flags,
    personFlagsText: participant.person_flags_text,
    bestPhoneScore: participant.best_phone_score,
    contactScoreFinal: participant.contact_score,
    smsEligible: participant.sms_eligible,
    canonicalProspectId: participant.prospect_id,
    bestPhoneId: participant.phone_id,
    phoneId: participant.phone_id,
    normalizedPhoneId: participant.phone_id,
  });

  const eligibility = evaluatePreSendEligibility({
    ...participant,
    identity_alignment: alignment,
  });

  let score = eligibility.ownership_confidence || 0;
  if (participant.ownership_status === "confirmed") score += 25;
  if (participant.ownership_status === "inferred") score += 10;
  if (participant.last_message_at) score += 5;
  if (participant.safe_to_contact === false) score -= 40;
  if (isRenterTenantOnly(participant)) score -= 50;
  if (participant.is_referred_contact) score -= 5;
  score += asNumber(participant.contact_score) || 0;
  score += (asNumber(participant.best_phone_score) || 0) * 0.2;

  return {
    score,
    alignment,
    eligibility,
    contactable: eligibility.eligible && !eligibility.hard_block && participant.safe_to_contact !== false,
  };
}

export function rankParticipants(participants = [], { master_owner_name = null, selected_phone = null } = {}) {
  const masterOwnerName = clean(master_owner_name);
  const scored = (Array.isArray(participants) ? participants : []).map((row) => {
    const scoredRow = scoreParticipant(row, masterOwnerName);
    return {
      ...row,
      alignment: scoredRow.alignment,
      _eligibility: scoredRow.eligibility,
      _rank_score: scoredRow.score,
      contactable: scoredRow.contactable,
      excluded_as_renter: isRenterTenantOnly(row),
      identity_class: row.identity_class || resolveContactIdentityClass(row),
    };
  });

  const eligible = scored
    .filter((row) => row.contactable && !row.excluded_as_renter)
    .sort((a, b) => b._rank_score - a._rank_score);

  const ineligible = scored
    .filter((row) => !row.contactable || row.excluded_as_renter)
    .sort((a, b) => b._rank_score - a._rank_score);

  const ordered = [...eligible, ...ineligible];
  const normalizedSelected = clean(selected_phone);

  return ordered.map((row, index) => {
    const rank = index + 1;
    const isSelected = normalizedSelected
      ? clean(row.canonical_e164) === normalizedSelected
      : Boolean(row.is_current_participant);
    return {
      ...row,
      contact_rank: rank,
      contact_rank_label: isSelected
        ? contactRankLabel(eligible.findIndex((item) => item.participant_id === row.participant_id) + 1 || rank, row)
        : contactRankLabel(eligible.findIndex((item) => item.participant_id === row.participant_id) + 1 || null, row),
      is_selected: isSelected,
      owner_match_flags: deriveOwnerMatchFlags(row),
      needs_review: row.excluded_as_renter && (row._rank_score || 0) > 20,
    };
  });
}

export function selectNextEligibleParticipant(
  participants = [],
  { current_phone = null, master_owner_name = null, exclude_phones = [] } = {},
) {
  const ranked = rankParticipants(participants, {
    master_owner_name,
    selected_phone: current_phone,
  });
  const exclude = new Set(
    [current_phone, ...(Array.isArray(exclude_phones) ? exclude_phones : [])]
      .map((value) => clean(value))
      .filter(Boolean),
  );

  const next = ranked.find((row) => {
    const phone = clean(row.canonical_e164);
    if (!phone || exclude.has(phone)) return false;
    return row.contactable && !row.excluded_as_renter;
  }) || null;

  const fallback = selectNextBestOwnerContact(
    ranked.map((row) => ({
      ...row,
      phone_id: row.phone_id,
      canonical_e164: row.canonical_e164,
      likely_owner: row.likely_owner,
      likely_renting: row.likely_renting,
      matching_flags: row.matching_flags,
      person_flags_text: row.person_flags_text,
      best_phone_score: row.best_phone_score,
      sms_eligible: row.sms_eligible,
      identity_alignment: row.alignment,
    })),
    {
      exclude_phone_ids: ranked
        .filter((row) => exclude.has(clean(row.canonical_e164)))
        .map((row) => row.phone_id)
        .filter(Boolean),
    },
  );

  const selected = next || fallback.selected || null;
  return {
    selected,
    ranked,
    reason: selected
      ? (next ? "next_ranked_eligible_participant" : fallback.reason)
      : "no_eligible_participant",
    selection_log: selected
      ? {
          participant_id: selected.participant_id,
          canonical_e164: selected.canonical_e164,
          contact_rank: selected.contact_rank,
          contact_rank_label: selected.contact_rank_label,
          ownership_status: selected.ownership_status,
          excluded_as_renter: selected.excluded_as_renter,
        }
      : null,
  };
}

export function enrichParticipantRow(row = {}, context = {}) {
  const ownership = detectOwnershipFromMessage(context.latest_inbound_message || "", row);
  const merged = {
    ...row,
    ownership_status: row.ownership_status || ownership.ownership_status,
    ownership_confidence: row.ownership_confidence ?? ownership.confidence,
    ownership_source: row.ownership_source || ownership.source,
    ownership_inference_reason: row.ownership_inference_reason || ownership.inference_reason,
    identity_class: row.identity_class || resolveContactIdentityClass(row),
    sms_eligible: row.sms_eligible ?? row.safe_to_contact !== false,
    contact_score: asNumber(row.contact_score),
    best_phone_score: asNumber(row.best_phone_score),
    contact_rank_label: row.contact_rank_label || null,
    owner_match_flags: deriveOwnerMatchFlags({ ...row, ownership_status: ownership.ownership_status }),
    excluded_as_renter: isRenterTenantOnly({ ...row, ownership_status: ownership.ownership_status }),
  };
  return merged;
}

export default {
  detectOwnershipFromMessage,
  deriveOwnerMatchFlags,
  isRenterTenantOnly,
  rankParticipants,
  selectNextEligibleParticipant,
  enrichParticipantRow,
};