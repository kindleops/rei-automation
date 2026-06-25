function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

export const CONTACT_IDENTITY_CLASSES = [
  "confirmed_owner",
  "probable_owner",
  "owner_related_contact",
  "authorized_spouse",
  "co_owner",
  "respondent_non_owner",
  "referral_source",
  "referred_possible_owner",
  "former_owner",
  "agent_representative",
  "executor_or_heir",
  "entity_representative",
  "property_manager",
  "renter_occupant",
  "wrong_person",
  "wrong_number",
  "unknown",
];

const CONTACT_IDENTITY_LABELS = {
  confirmed_owner: "Confirmed Owner",
  probable_owner: "Probable Owner",
  owner_related_contact: "Owner-Related Contact",
  authorized_spouse: "Authorized Spouse / Co-Owner",
  co_owner: "Co-Owner",
  respondent_non_owner: "Respondent (Non-Owner)",
  referral_source: "Referral Source",
  referred_possible_owner: "Referred Possible Owner",
  former_owner: "Former Owner",
  agent_representative: "Agent / Representative",
  executor_or_heir: "Executor / Heir",
  entity_representative: "Entity Representative",
  property_manager: "Property Manager",
  renter_occupant: "Renter / Occupant",
  wrong_person: "Wrong Person",
  wrong_number: "Wrong Number",
  unknown: "Unknown",
};

export function contactIdentityLabel(classKey) {
  return CONTACT_IDENTITY_LABELS[lower(classKey)] || CONTACT_IDENTITY_LABELS.unknown;
}

export function resolveContactIdentityClass(row = {}) {
  const intent = lower(row.detected_intent || row.reply_intent || row.ui_intent || row.last_intent || "");
  const disposition = lower(row.disposition || "");
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};

  if (clean(metadata.contact_identity)) {
    return lower(metadata.contact_identity);
  }
  if (metadata.relationship_outcome === "property_specific_non_owner_with_referral") {
    return "referral_source";
  }
  if (
    metadata.relationship_outcome === "property_specific_non_owner" ||
    intent === "non_owner_referral" ||
    intent === "property_specific_non_owner"
  ) {
    return "respondent_non_owner";
  }
  if (intent === "referred_possible_owner" || metadata.is_referred_contact === true) {
    return "referred_possible_owner";
  }
  if (row.wrong_number === true || intent === "wrong_number" || disposition === "wrong_number") {
    return "wrong_number";
  }
  if (
    intent === "wrong_person"
    || disposition === "wrong_person"
    || metadata.contact_identity === "wrong_person"
  ) {
    return "wrong_person";
  }
  if (
    intent === "renter"
    || intent === "renter_occupant"
    || intent === "occupant"
    || row.likely_renter === true
    || metadata.likely_renter === true
  ) {
    return "renter_occupant";
  }
  if (
    metadata.contact_identity === "authorized_spouse" ||
    metadata.relationship_outcome === "co_owner" ||
    intent === "co_owner_respondent"
  ) {
    return "authorized_spouse";
  }
  if (
    metadata.contact_identity === "executor_or_heir" ||
    intent === "executor_heir_respondent"
  ) {
    return "executor_or_heir";
  }
  if (
    metadata.contact_identity === "entity_representative" ||
    intent === "entity_representative_respondent"
  ) {
    return "entity_representative";
  }
  if (
    intent === "ownership_confirmed"
    || row.owner_confirmed === true
    || metadata.owner_confirmed === true
    || metadata.relationship_outcome === "confirmed_owner"
    || lower(row.seller_stage || row.conversation_stage || "") === "ownership_confirmed"
  ) {
    return "confirmed_owner";
  }
  if (clean(row.master_owner_id) && clean(row.property_id)) {
    return "probable_owner";
  }
  if (clean(row.master_owner_id) || clean(row.prospect_id)) {
    return "owner_related_contact";
  }
  return "unknown";
}

export function isSellerIntentIdentity(classKey) {
  const key = lower(classKey);
  return key === "confirmed_owner" || key === "probable_owner" || key === "owner_related_contact";
}