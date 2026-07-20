// V1.3 owner-resolution + evidence-aware routing (identity/routing ONLY — no
// seller-pressure or economic logic here). Pure, deterministic function shared
// by the feature engine (F-114) and the population census, so the route a
// property gets is computed identically in both places.
//
// Separates the three concepts V1.2 conflated:
//   - person_contact_suppressed  (per person; renter flag => suppressed)
//   - owner_resolution_status    (per property; is the owner of record resolved
//                                 to a canonical, non-renter contact?)
//   - property_execution_route   (per property; the ACTION, decided AFTER owner
//                                 resolution — never directly from a renter flag)
//
// No owner is merged or made outreach-eligible on name alone: a name match can
// PREVENT a hard block but never AUTHORIZES outreach without corroboration.
export const OWNER_RESOLUTION_VERSION = 'owner-resolution-v1.3';

export const ENTITY_NAME_RE = /\b(LLC|L\.?L\.?C|INC|CORP|CORPORATION|LTD|LP|L\.?P|LLP|HOLDINGS|INVESTMENTS|PROPERTIES|GROUP|CAPITAL|VENTURES|REALTY|MANAGEMENT|PARTNERS|TRUST|ESTATE|BANK|COMPANY|ENTERPRISES|ASSOCIATES|FUND|FOUNDATION|CHURCH|CITY OF|COUNTY OF|AUTHORITY|ASSN|ASSOCIATION)\b/i;

const TIER_STRONG = new Set(['exact', 'high']);
const TIER_MOD = new Set(['exact', 'high', 'medium']);

// per-person owner-evidence strength (the ladder). "strong" = corroborated;
// "moderate" = a single real owner signal; "weak" = name/token-only or low tier.
export function ownerEvidenceStrength(p) {
  const strongTier = TIER_STRONG.has(p.link_tier);
  if ((p.owner_token && p.owner_verdict)                    // corroborated token + verdict
    || (p.name_match && strongTier)                         // name-of-record + strong link
    || (p.owner_verdict && strongTier)                      // vendor owner-verdict + strong link
    || (p.exact_key_owner === true)) return 'strong';       // keyed person asserted as owner
  if (p.name_match || p.owner_token || p.owner_verdict || TIER_MOD.has(p.link_tier)) return 'moderate';
  if (p.link_tier === 'low' || p.surname_match) return 'weak';
  return 'none';
}

// material owner evidence for CONFLICT detection (does not require corroboration)
const hasMaterialOwnerEvidence = (p) => Boolean(p.name_match || p.owner_token || p.owner_verdict);

export function resolveOwner(ev) {
  const persons = (ev.persons ?? []).map((p) => ({
    ...p,
    strength: ownerEvidenceStrength(p),
    contact_suppressed: p.renter_flag === true,       // person-scoped suppression
  }));
  const ownerOfRecord = Boolean(ev.owner_name);
  const isEntity = Boolean(ev.is_entity) || (ev.owner_name ? ENTITY_NAME_RE.test(ev.owner_name) : false);

  const cleanOwners = persons.filter((p) => !p.renter_flag && (p.strength === 'strong' || p.strength === 'moderate'));
  const conflicted = persons.filter((p) => p.renter_flag && hasMaterialOwnerEvidence(p));
  const renterPresent = persons.some((p) => p.renter_flag);
  const renterOnly = persons.filter((p) => p.renter_flag && p.strength === 'none');
  const weakOwners = persons.filter((p) => !p.renter_flag && p.strength === 'weak');

  // outreach-eligible = clean owner with at least MODERATE corroboration; a
  // name-only (weak) match never qualifies for outreach on its own.
  const outreachEligible = cleanOwners.filter((p) => p.strength === 'strong'
    || (p.strength === 'moderate' && (p.owner_verdict || p.owner_token || (p.name_match && TIER_MOD.has(p.link_tier)))));

  // V1.5 PRECEDENCE: entity/trust/estate authority (isEntity via classification
  // OR lexical owner-name fallback) BEFORE individual owner resolution — a name
  // match never overrides entity/trust/estate ownership. Conflict before
  // individual too.
  let status; let identity_route; let category;
  if (isEntity) {
    status = 'entity_unresolved';
    identity_route = 'entity_authority_resolution';
    category = 5;
  } else if (conflicted.length > 0 && cleanOwners.length === 0) {
    status = 'renter_owner_conflict';
    identity_route = 'manual_review_renter_owner_conflict';
    category = 3;
  } else if (outreachEligible.length > 0) {
    status = 'resolved_owner_present';
    identity_route = 'owner_outreach_eligible';
    category = renterPresent ? 2 : 0;                       // 2 = renter suppressed, clean owner preserved
  } else if (cleanOwners.length > 0) {
    // a non-renter person with only moderate/weak name-or-token evidence: an
    // owner candidate exists but corroboration is insufficient to authorize
    status = 'owner_candidate_uncorroborated';
    identity_route = 'owner_resolution_required';
    category = 4;
  } else if (weakOwners.length > 0) {
    status = 'ambiguous_identity';
    identity_route = 'owner_resolution_required';
    category = 6;
  } else if (ownerOfRecord) {
    // owner of record exists but no linked person carries owner evidence: the
    // owner was never resolved to a contact — resolve, do NOT block
    status = 'owner_of_record_unlinked';
    identity_route = 'owner_resolution_required';
    category = 4;
  } else if (renterOnly.length > 0) {
    // Phase 5: a property ALWAYS has an owner of record even when our person
    // graph only shows a renter. This is NOT a property block — it is a
    // no-reachable-owner-contact resolution task. blocked_not_owner is
    // deprecated and never emitted here.
    status = 'no_reachable_owner_contact';
    identity_route = 'owner_resolution_required';
    category = 1;
  } else {
    status = 'insufficient_evidence';
    identity_route = 'owner_resolution_required';
    category = 8;
  }

  return {
    version: OWNER_RESOLUTION_VERSION,
    owner_resolution_status: status,
    identity_route,
    census_category: category,
    owner_of_record_present: ownerOfRecord,
    is_entity: isEntity,
    renter_present: renterPresent,
    person_contact_suppressed: persons.map((p) => ({ person_id: p.id, suppressed: p.contact_suppressed, renter_flag: p.renter_flag === true })),
    outreach_eligible_person_ids: outreachEligible.map((p) => p.id),
    clean_owner_count: cleanOwners.length,
    conflicted_count: conflicted.length,
    renter_only_count: renterOnly.length,
    evidence_strengths: persons.map((p) => ({ id: p.id, strength: p.strength, renter: p.renter_flag === true, name_match: p.name_match === true, owner_token: p.owner_token === true, owner_verdict: p.owner_verdict === true, link_tier: p.link_tier })),
  };
}

// normalized owner-name / person-name token match (2+ shared 3+char tokens);
// surname-only match flagged separately (weak)
export function nameSignals(ownerRaw, personName) {
  const toks = (s) => String(s ?? '').toUpperCase().split(/[^A-Z]+/).filter((t) => t.length >= 3);
  const a = new Set(toks(ownerRaw)); const b = toks(personName);
  if (!a.size || !b.length) return { name_match: false, surname_match: false };
  const shared = b.filter((t) => a.has(t));
  return { name_match: shared.length >= 2, surname_match: shared.length === 1 };
}
