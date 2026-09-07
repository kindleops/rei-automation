// ─── resolve-seller-salutation.js ────────────────────────────────────────────
// ONE authority for the name we put in front of a seller.
//
// WHY THIS EXISTS
//   Three real defects shipped from having no single authority:
//     * "Randy & Tammy Reid" -- an earlier message said "Hi Tammy", the next
//       batch said "Randy". The same household addressed as two different
//       people, because the first token of the owner string won.
//     * "Jose & Maricela Munoz" -- earlier "Hola Maricela", later "Jose".
//     * "D & S LLC" -- a COMPANY, rendered as the first name "D".
//
//   A seller who is greeted by the wrong name knows immediately that nobody is
//   really writing to them, and greeting a legal entity as "D" is worse than
//   sending nothing.
//
// THE RULE THAT PREVENTS ALL THREE
//   Never derive a human first name from a string that was not established as
//   a human contact. A multi-owner household has no obvious "first" person, and
//   an entity has no person at all. When the evidence does not name someone,
//   this returns NO NAME and says why -- the caller then picks neutral copy or
//   routes to review. It never guesses.

function clean(value) {
  return String(value ?? "").trim();
}

/**
 * Legal-entity markers. If the owner string carries one of these it is an
 * organisation, and no token inside it is a person's first name.
 */
const ENTITY_PATTERN =
  /\b(LLC|L\.?L\.?C|INC|INCORPORATED|CORP|CORPORATION|COMPANY|CO|TRUST|TRUSTEE|LP|LLP|PLLC|PC|FOUNDATION|PROPERTIES|PROPERTY|HOLDINGS|HOLDING|GROUP|ENTERPRISES|ENTERPRISE|PARTNERS|PARTNERSHIP|INVESTMENTS|INVESTMENT|REALTY|ASSOCIATES|VENTURES|CAPITAL|ESTATE OF|ET AL)\b/i;

/** "A & B", "A AND B", "A/B" -- two or more owners, no defensible "first". */
const MULTI_OWNER_PATTERN = /\s(&|\band\b|\+)\s|\//i;

/** Salutations we have actually used, so a prior send can be read back. */
const SALUTATION_PATTERN =
  /^\s*(?:hi|hey|hello|hola|buenos d[ií]as|buenas tardes)\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’-]{1,30})\s*[,.!?]/i;

export function isEntityName(value) {
  const name = clean(value);
  if (!name) return false;
  return ENTITY_PATTERN.test(name);
}

export function isMultiOwnerName(value) {
  const name = clean(value);
  if (!name) return false;
  return MULTI_OWNER_PATTERN.test(name);
}

/**
 * The name we last addressed this person by, read from our own outbound copy.
 *
 * This is the strongest evidence available for an ongoing conversation: it is
 * what the seller has already been called, so continuing to use it is both
 * correct and consistent. Only trusted when every prior salutation agrees --
 * if we have called them two different things, the history is not authority,
 * it is the bug.
 */
export function resolveEstablishedAddressee(outboundBodies = []) {
  const names = [];
  for (const body of outboundBodies) {
    const match = SALUTATION_PATTERN.exec(clean(body));
    if (match && match[1]) names.push(match[1].trim());
  }
  if (!names.length) return { name: null, consistent: true, seen: [] };

  const distinct = [...new Set(names.map((n) => n.toLowerCase()))];
  if (distinct.length > 1) {
    return { name: null, consistent: false, seen: [...new Set(names)] };
  }
  return { name: names[0], consistent: true, seen: [names[0]] };
}

/**
 * Resolve the seller-facing first name.
 *
 * Evidence order, strongest first:
 *   1. confirmed_contact_first_name  an explicitly recorded human contact
 *   2. established addressee         what our own prior messages called them
 *   3. owner record                  ONLY when it is a single human
 *
 * Returns { name, source, needs_review, reason }. A null name is a valid,
 * deliberate outcome: use a template variant that needs no name, or review.
 */
export function resolveSellerSalutation({
  confirmedContactFirstName = null,
  outboundBodies = [],
  ownerName = null,
  contactIdentityClass = null,
} = {}) {
  const confirmed = clean(confirmedContactFirstName);
  if (confirmed && !isEntityName(confirmed)) {
    return { name: confirmed, source: "confirmed_contact", needs_review: false, reason: null };
  }

  const established = resolveEstablishedAddressee(outboundBodies);
  if (established.name) {
    return { name: established.name, source: "established_addressee", needs_review: false, reason: null };
  }
  if (!established.consistent) {
    // We have called this person more than one thing. Guessing again is how
    // the inconsistency compounds.
    return {
      name: null,
      source: "conflicting_history",
      needs_review: true,
      reason: `prior_salutations_disagree:${established.seen.join("|")}`,
    };
  }

  const owner = clean(ownerName);
  if (!owner) {
    return { name: null, source: "none", needs_review: true, reason: "no_contact_name_evidence" };
  }

  // An organisation has no first name. "D & S LLC" must never become "D".
  if (isEntityName(owner) || clean(contactIdentityClass).toLowerCase() === "entity") {
    return { name: null, source: "entity_owner", needs_review: false, reason: "owner_is_legal_entity" };
  }

  // A household has no defensible "first" person. Taking the leading token is
  // exactly what addressed Tammy's household as "Randy".
  if (isMultiOwnerName(owner)) {
    return {
      name: null,
      source: "multi_owner",
      needs_review: true,
      reason: "multi_owner_household_without_confirmed_contact",
    };
  }

  const first = owner.split(/\s+/)[0];
  if (!first || first.length < 2) {
    return { name: null, source: "unusable_owner_name", needs_review: true, reason: "owner_name_not_a_person" };
  }
  return { name: first, source: "single_human_owner", needs_review: false, reason: null };
}

export default { resolveSellerSalutation, resolveEstablishedAddressee, isEntityName, isMultiOwnerName };
