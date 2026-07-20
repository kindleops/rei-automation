// V1.6 — QUALIFIED ENTITY-OWNERSHIP EVIDENCE
//
// Decides whether a property has CURRENT entity/trust/estate ownership, using
// only evidence that actually speaks to the current owner of record.
//
// This module changes WHAT COUNTS AS ENTITY EVIDENCE. It does not change routing
// precedence, seller-pressure logic, weights, features, interactions, score
// families, renter handling, contact planning, or Tier-B policy. The V1.5
// resolver (`ownerResolutionCanonical.mjs`) is called UNCHANGED and stays
// byte-identical/hash-locked — V1.6 only supplies it a qualified `is_entity` /
// `is_trust` / `is_estate` instead of V1.5's raw `company_links > 0`.
//
// §5 — a property may route to entity_authority_resolution only when at least
// one of these exists:
//   1. canonical current corporate/trust/estate ownership classification
//   2. authoritative ownership-rights / vesting evidence
//   3. current owner-of-record entity name WITH corroborating canonical evidence
//   4. current company owner linked through the latest qualifying transfer
//   5. verified entity-owner identifier
//   6. multiple independent current-ownership sources
//
// Lexical evidence remains FAIL-CLOSED but is labelled `lexical_authority_review`
// — it blocks outreach, it never asserts confirmed entity ownership.
import { classifyPropertyCompanyLinks } from './companyRelationship.mjs';

export const ENTITY_EVIDENCE_VERSION = 'entity-ownership-evidence-v1_6';

export const AUTHORITY_EVIDENCE_GRADE = ['canonical_current_ownership', 'ownership_rights_vesting',
  'verified_entity_owner', 'lexical_authority_review', 'none'];

// lexical markers — byte-identical to the frozen V1.5 resolver so the
// fail-closed gate keeps exactly the same reach
const LEX_ESTATE_RE = /\b(estate\s+of|estate|deceased|heirs?|decedent)\b/i;
const LEX_TRUST_RE = /\b(trust|trustee|revocable|irrevocable|living\s+trust)\b/i;
const LEX_COMPANY_RE = /\b(LLC|L\.?L\.?C|INC|CORP|CORPORATION|LTD|LP|L\.?P|LLP|HOLDINGS|INVESTMENTS|PROPERTIES|GROUP|CAPITAL|VENTURES|REALTY|MANAGEMENT|PARTNERS|COMPANY|ENTERPRISES|ASSOCIATES|FUND|FOUNDATION|CHURCH|BANK|AUTHORITY|ASSN|ASSOCIATION)\b/i;

// ---- authoritative vesting / ownership-rights ----
// A borrower in default on a trustee's deed is a DISTRESSED INDIVIDUAL, not a
// trust — it must never read as trust ownership despite containing "Trustee's".
const VESTING_BORROWER_RE = /trustor|borrower\s+in\s+default/i;
// Only UNAMBIGUOUS entity vesting counts. The vendor's ownership-rights domain
// mixes entity forms with how NATURAL PERSONS hold title — "Sole Member",
// "Partner", "Limited Partner" sit in the same list as "Joint Tenants",
// "Single Person or Individual" and "Community Property", and in this corpus
// they attach to plainly individual owners. Treating them as entity ownership
// would repeat the exact over-blocking defect V1.6 exists to remove.
const VESTING_COMPANY_RE = /\b(company\s+or\s+corporation|limited\s+liability\s+(company|partnership)|corporation|partnership|corporate\s+(owner|owned))\b/i;
const VESTING_TRUST_RE = /\b(trustee|conservator|living\s+trust|family\s+trust|revocable\s+trust|corporate\s+trust|trust)\b/i;
const VESTING_ESTATE_RE = /\b(estate|life\s+tenant|life\s+estate|remainder)\b/i;

export function vestingEvidence(vestingRaw) {
  const v = String(vestingRaw ?? '');
  if (!v.trim()) return { company: false, trust: false, estate: false, raw: '' };
  if (VESTING_BORROWER_RE.test(v)) {
    // distressed borrower vesting: explicitly NOT entity/trust ownership
    return { company: false, trust: false, estate: false, raw: v, borrower_in_default: true };
  }
  return {
    company: VESTING_COMPANY_RE.test(v),
    trust: VESTING_TRUST_RE.test(v),
    estate: VESTING_ESTATE_RE.test(v),
    raw: v,
  };
}

/**
 * property: {
 *   owner_name, owner_status, vesting_raw,
 *   canonical_corporate, canonical_trust, canonical_estate, probate_evidence,
 *   verified_entity_owner_id,
 *   company_links: [ { company_source, matched_party, matching_type, company_name, transaction_id } ],
 *   transactions_by_id: { [vendor_transaction_id]: txn },
 *   latest_qualifying_transfer_id, scoring_timestamp
 * }
 */
export function qualifyEntityOwnership(property) {
  const name = property.owner_name ?? '';
  const canonicalCorporate = Boolean(property.canonical_corporate);
  const canonicalTrust = Boolean(property.canonical_trust);
  const canonicalEstate = Boolean(property.canonical_estate);
  const probate = Boolean(property.probate_evidence);
  const verifiedEntityOwner = Boolean(property.verified_entity_owner_id);

  const vest = vestingEvidence(property.vesting_raw);

  // classify each company link against the current owner of record
  const linkCtx = {
    owner_name_of_record: name,
    owner_status: property.owner_status,
    latest_qualifying_transfer_id: property.latest_qualifying_transfer_id ?? null,
    scoring_timestamp: property.scoring_timestamp ?? null,
    canonical_corporate: canonicalCorporate,
    canonical_trust: canonicalTrust,
    canonical_estate: canonicalEstate,
  };
  const links = (property.company_links ?? []).map((l) => ({
    ...l,
    transaction: property.transactions_by_id?.[l.transaction_id] ?? null,
  }));
  // classified per link so each carries its OWN transaction context
  const perLink = links.map((l) => classifyPropertyCompanyLinks([l], {
    ...linkCtx, transaction: l.transaction,
  }).links[0]);
  const currentOwnershipLinks = perLink.filter((c) => c.ownership_relevance === 'establishes_current_entity_ownership');
  const linkEstablishesOwnership = currentOwnershipLinks.length > 0;

  const lexEstate = LEX_ESTATE_RE.test(name);
  const lexTrust = LEX_TRUST_RE.test(name);
  const lexCompany = LEX_COMPANY_RE.test(name);

  // ---- qualifying current-ownership evidence (§5) ----
  const qualifying = [];
  if (canonicalCorporate) qualifying.push('canonical_corporate_classification');
  if (canonicalTrust) qualifying.push('canonical_trust_classification');
  if (canonicalEstate) qualifying.push('canonical_estate_classification');
  if (probate) qualifying.push('probate_life_event');
  if (vest.company) qualifying.push('vesting_corporate_rights');
  if (vest.trust) qualifying.push('vesting_trust_rights');
  if (vest.estate) qualifying.push('vesting_estate_rights');
  if (verifiedEntityOwner) qualifying.push('verified_entity_owner_identifier');
  for (const c of currentOwnershipLinks) qualifying.push(`company_link:${c.relationship_class}`);
  // lexical name corroborated by canonical evidence (§5 rule 3)
  const lexCorroborated = (lexCompany || lexTrust || lexEstate)
    && (canonicalCorporate || canonicalTrust || canonicalEstate || probate
      || vest.company || vest.trust || vest.estate || linkEstablishesOwnership);
  if (lexCorroborated) qualifying.push('owner_name_entity_marker_corroborated');

  // ---- evidence V1.5 counted that V1.6 disqualifies ----
  const disqualified = perLink
    .filter((c) => c.ownership_relevance !== 'establishes_current_entity_ownership')
    .map((c) => `${c.relationship_class}:${c.reason_code}`);

  // ---- family determination ----
  const isEstate = canonicalEstate || probate || vest.estate
    || currentOwnershipLinks.some((c) => c.relationship_class === 'current_owner_estate');
  const isTrust = canonicalTrust || vest.trust
    || currentOwnershipLinks.some((c) => c.relationship_class === 'current_owner_trust');
  const isCompany = canonicalCorporate || vest.company || verifiedEntityOwner
    || currentOwnershipLinks.some((c) => ['current_owner_company', 'current_owner_institution', 'verified_entity_owner'].includes(c.relationship_class));

  const hasQualifying = isEstate || isTrust || isCompany;

  // lexical fail-closed: no qualifying evidence but the NAME reads as an entity
  const lexicalOnly = !hasQualifying && (lexCompany || lexTrust || lexEstate);

  let grade;
  if (verifiedEntityOwner) grade = 'verified_entity_owner';
  else if (canonicalCorporate || canonicalTrust || canonicalEstate || probate || linkEstablishesOwnership) grade = 'canonical_current_ownership';
  else if (vest.company || vest.trust || vest.estate) grade = 'ownership_rights_vesting';
  else if (lexicalOnly) grade = 'lexical_authority_review';
  else grade = 'none';

  const independentSources = new Set(qualifying.map((q) => q.split(':')[0].replace(/_classification$/, '')));

  return {
    version: ENTITY_EVIDENCE_VERSION,
    // resolver inputs — fail-closed: lexical still blocks
    is_estate: isEstate || (lexicalOnly && lexEstate),
    is_trust: isTrust || (lexicalOnly && lexTrust && !lexEstate),
    is_company: isCompany || (lexicalOnly && lexCompany && !lexEstate && !lexTrust),
    is_entity_input: isCompany || isTrust || (lexicalOnly && (lexCompany || lexTrust)),
    authority_evidence_grade: grade,
    confirmed_entity_ownership: hasQualifying,
    lexical_authority_review: lexicalOnly,
    qualifying_evidence: qualifying,
    disqualified_evidence: disqualified,
    independent_current_ownership_sources: independentSources.size,
    multiple_independent_sources: independentSources.size >= 2,
    company_link_classification: perLink,
    company_link_classes: [...new Set(perLink.map((c) => c.relationship_class))].sort(),
    vesting: vest,
    lexical: { company: lexCompany, trust: lexTrust, estate: lexEstate },
    reason_code: hasQualifying ? `qualified:${grade}`
      : lexicalOnly ? 'lexical_authority_review_fail_closed'
        : 'no_current_entity_ownership_evidence',
  };
}
