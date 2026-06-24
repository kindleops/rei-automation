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
  "renter_occupant",
  "wrong_person",
  "wrong_number",
  "unknown",
];

const CONTACT_IDENTITY_LABELS = {
  confirmed_owner: "Confirmed Owner",
  probable_owner: "Probable Owner",
  owner_related_contact: "Owner-Related Contact",
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
    intent === "ownership_confirmed"
    || row.owner_confirmed === true
    || metadata.owner_confirmed === true
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