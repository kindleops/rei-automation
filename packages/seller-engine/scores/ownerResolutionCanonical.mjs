// Phase 5 canonical owner & authority resolution (identity/routing ONLY — no
// seller-pressure logic). Governing rule: CONTACTS ARE SUPPRESSED; PROPERTIES
// ARE RESOLVED. A property always has an owner of record, so this resolver
// NEVER emits blocked_not_owner as a property route — it resolves the property
// to a status and a next action. `blocked_not_owner` is retained only as a
// deprecated compatibility value and is never produced here.
//
// Pure, deterministic. Ranks every owner/authorized-contact candidate for a
// property and derives three SEPARATE layers:
//   - person/contact status   (per candidate)
//   - owner-resolution status (per property)
//   - execution route         (per property)
import { nameSignals, ENTITY_NAME_RE } from './ownerResolution.mjs';

export const CANONICAL_RESOLVER_VERSION = 'owner-resolution-canonical-v5';

export const PERSON_STATUS = ['owner_confirmed', 'owner_candidate', 'authorized_representative',
  'renter_suppressed', 'confirmed_not_owner', 'wrong_person', 'unresolved', 'deceased',
  'entity_associated', 'authority_unverified'];
export const OWNER_RESOLUTION_STATUS = ['owner_resolved', 'owner_candidate_found', 'owner_unresolved',
  'conflicting_owner_evidence', 'entity_authority_required', 'probate_authority_required',
  'listing_agent_controls_contact', 'no_reachable_owner_contact'];
export const EXECUTION_ROUTE = ['owner_outreach', 'owner_resolution_required',
  'manual_review_renter_owner_conflict', 'entity_authority_resolution', 'probate_counsel_first',
  'agent_flow_active_listing', 'excluded_reo'];
export const DEPRECATED_ROUTES = ['blocked_not_owner'];

const TIER_STRONG = new Set(['exact', 'high']);
const TIER_MOD = new Set(['exact', 'high', 'medium']);

// ---- evidence tier for a single candidate (A/B/C/D) ----
export function candidateTier(c) {
  const evidence = []; const contra = [];
  const strongTier = TIER_STRONG.has(c.link_tier);
  const modTier = TIER_MOD.has(c.link_tier);
  if (c.owner_token) evidence.push('owner_token');
  if (c.owner_verdict) evidence.push('owner_match_verdict');
  if (c.name_match) evidence.push('owner_name_match');
  if (c.surname_match && !c.name_match) evidence.push('surname_only_match');
  if (c.mailing_match) evidence.push('mailing_address_match');
  if (c.exact_key_owner) evidence.push('exact_individual_key_owner');
  if (c.owner_hash_corroborated) evidence.push('owner_hash_corroborated_name');
  if (c.deed_grantee) evidence.push('deed_grantee_identity');
  if (c.verified_authority) evidence.push(`verified_${c.authority_kind ?? 'authority'}`);
  if (modTier) evidence.push(`link_tier_${c.link_tier}`);
  if (c.renter_flag) contra.push('renter_flag');
  if (c.explicit_not_owner) contra.push('not_owner_verdict');
  if (c.name_conflicts) contra.push('name_conflicts_with_owner_of_record');
  if (c.deceased) contra.push('deceased');

  // Tier A — confirmed owner or authority
  const tierA = c.exact_key_owner
    || (c.owner_hash_corroborated && c.name_match)
    || c.deed_grantee
    || (c.verified_authority === true);
  // Tier B — probable owner
  const tierB = (c.name_match && c.mailing_match)
    || (c.owner_token && c.owner_verdict)
    || (c.name_match && strongTier)
    || (c.independent_source_matches >= 2);
  // Tier C — possible owner
  const tierC = c.name_match || c.owner_token || c.owner_verdict
    || c.mailing_household || modTier || (c.entity_associated === true);
  let tier;
  if (tierA) tier = 'A';
  else if (tierB) tier = 'B';
  else if (tierC) tier = 'C';
  else tier = 'D';
  // conflicting/renter evidence forces Tier D regardless of owner signals
  const conflicted = c.renter_flag && (c.owner_token || c.owner_verdict || c.name_match);
  if (conflicted) tier = 'D';
  return { tier, evidence, contra, conflicted };
}

// per-candidate person/contact status
function personStatus(c, t) {
  if (t.conflicted) return 'unresolved'; // conflict handled at the property layer
  if (c.deceased) return 'deceased';
  if (c.renter_flag) return 'renter_suppressed';
  if (c.explicit_not_owner) return 'confirmed_not_owner';
  if (c.verified_authority) return 'authorized_representative';
  // V1.5: a person on an entity/trust/estate property is at most an associated
  // person with UNVERIFIED authority — a name inside a trust/company name is not
  // a verified trustee/officer.
  if (c.entity_associated && !c.verified_authority) return 'authority_unverified';
  if (t.tier === 'A') return 'owner_confirmed';
  if (t.tier === 'B' || t.tier === 'C') return c.entity_associated ? 'entity_associated' : 'owner_candidate';
  if (c.entity_associated) return c.authority_verified === false ? 'authority_unverified' : 'entity_associated';
  if (c.name_conflicts) return 'wrong_person';
  return 'unresolved';
}

// outreach-eligibility tier gate (Tier A, or the approved Tier-B subset)
export const APPROVED_TIER_B_OUTREACH = true; // Tier B with owner_token+verdict OR name+mailing
function tierBOutreachApproved(c) {
  return (c.owner_token && c.owner_verdict) || (c.name_match && c.mailing_match);
}

// V1.5 lexical authority markers — an owner-of-record name that reads as an
// entity/trust/estate/probate MUST prevent automatic individual outreach until
// reviewed (fail-closed), even without a canonical classification. Lexical
// evidence alone does NOT permanently classify the owner — it gates outreach.
const ESTATE_RE = /\b(estate\s+of|estate|deceased|heirs?|decedent)\b/i;
const TRUST_RE = /\b(trust|trustee|revocable|irrevocable|living\s+trust)\b/i;
const COMPANY_RE = /\b(LLC|L\.?L\.?C|INC|CORP|CORPORATION|LTD|LP|L\.?P|LLP|HOLDINGS|INVESTMENTS|PROPERTIES|GROUP|CAPITAL|VENTURES|REALTY|MANAGEMENT|PARTNERS|COMPANY|ENTERPRISES|ASSOCIATES|FUND|FOUNDATION|CHURCH|BANK|AUTHORITY|ASSN|ASSOCIATION)\b/i;

export function resolveCanonical(property, candidatesIn) {
  const name = property.owner_name ?? '';
  const classifiedEntity = Boolean(property.is_entity);            // company link / classification
  const classifiedTrust = Boolean(property.is_trust);
  const classifiedEstate = Boolean(property.is_estate);
  const lexEstate = ESTATE_RE.test(name);
  const lexTrust = TRUST_RE.test(name);
  const lexCompany = COMPANY_RE.test(name);
  const isEstate = classifiedEstate || Boolean(property.probate_evidence) || lexEstate;
  const isTrust = classifiedTrust || lexTrust;
  const isCompany = classifiedEntity || lexCompany;
  const isEntity = isCompany || isTrust;                            // trust/company need authority
  const entityLexicalFallback = (isEntity || isEstate) && !classifiedEntity && !classifiedTrust && !classifiedEstate && !property.probate_evidence;
  const hasProbate = isEstate;
  const activeListing = Boolean(property.active_listing);
  const reo = Boolean(property.reo);
  const ownerOfRecord = Boolean(property.owner_name);

  const candidates = (candidatesIn ?? []).map((c) => {
    const ns = c.name_match !== undefined ? { name_match: c.name_match, surname_match: c.surname_match }
      : nameSignals(property.owner_name, c.person_name);
    const cc = { ...c, name_match: ns.name_match, surname_match: ns.surname_match,
      mailing_match: c.mailing_match ?? (property.owner_mailing_state && property.situs_state
        ? property.owner_mailing_state === property.situs_state : false),
      entity_associated: c.entity_associated ?? (isEntity || isEstate) };
    const t = candidateTier(cc);
    const status = t.conflicted ? 'renter_suppressed' : personStatus(cc, t);
    const contactable = (c.phones ?? 0) > 0 || (c.emails ?? 0) > 0;
    const suppressed = c.renter_flag === true;
    const outreachTierOk = t.tier === 'A' || (t.tier === 'B' && tierBOutreachApproved(cc));
    const reason = t.conflicted ? 'renter_owner_conflict'
      : suppressed ? 'renter_suppressed'
        : c.deceased ? 'deceased'
          : !ownerEvidence(cc) ? 'no_owner_evidence'
            : !contactable ? 'no_contact_method'
              : outreachTierOk ? 'owner_evidence_sufficient' : 'owner_evidence_insufficient_tier';
    return {
      id: c.id, candidate_type: isEntity ? 'entity_associated_person' : 'individual',
      ownership_relationship: ownershipRel(cc, t),
      authority_relationship: c.verified_authority ? (c.authority_kind ?? 'authorized') : (isEntity ? 'entity_associated_unverified' : 'n/a'),
      evidence: t.evidence, contradictory_evidence: t.contra,
      evidence_tier: t.tier, resolution_confidence: tierConfidence(t.tier, t.conflicted),
      person_status: status, contactable, phones: c.phones ?? 0, emails: c.emails ?? 0,
      suppression_state: suppressed ? 'renter_suppressed' : 'active',
      outreach_tier_ok: outreachTierOk, conflicted: t.conflicted,
      reason_code: reason,
      explanation: explainCandidate(cc, t, status),
    };
  });

  // property-level resolution
  const cleanOwnerCands = candidates.filter((c) => !c.suppression_state.startsWith('renter') && !c.conflicted
    && ['owner_confirmed', 'owner_candidate', 'authorized_representative'].includes(c.person_status));
  const tierAeligible = candidates.filter((c) => c.person_status !== 'renter_suppressed' && !c.conflicted && c.outreach_tier_ok);
  const conflicts = candidates.filter((c) => c.conflicted);
  // a reachable OWNER contact is a non-suppressed, non-conflicted, contactable
  // candidate; a suppressed renter with a phone is NOT a reachable owner contact
  const anyReachableNonSuppressed = candidates.some((c) => c.contactable
    && c.suppression_state !== 'renter_suppressed' && !c.conflicted);

  // V1.5 PRECEDENCE (strict): 1 exclusions → 2/3 entity/trust/estate/probate
  // authority (BEFORE individual — a name match never overrides entity/trust/
  // estate ownership) → 4 conflicting person evidence → 5 individual owner →
  // 6 contact eligibility.
  let owner_resolution_status; let execution_route;
  if (reo) { owner_resolution_status = 'no_reachable_owner_contact'; execution_route = 'excluded_reo'; }
  else if (activeListing) { owner_resolution_status = 'listing_agent_controls_contact'; execution_route = 'agent_flow_active_listing'; }
  else if (isEstate) { owner_resolution_status = 'probate_authority_required'; execution_route = 'probate_counsel_first'; }
  else if (isEntity) { owner_resolution_status = 'entity_authority_required'; execution_route = 'entity_authority_resolution'; }
  else if (conflicts.length > 0 && cleanOwnerCands.length === 0) { owner_resolution_status = 'conflicting_owner_evidence'; execution_route = 'manual_review_renter_owner_conflict'; }
  else if (tierAeligible.length > 0) { owner_resolution_status = 'owner_resolved'; execution_route = 'owner_outreach'; }
  else if (cleanOwnerCands.length > 0) { owner_resolution_status = 'owner_candidate_found'; execution_route = 'owner_resolution_required'; }
  else if (!anyReachableNonSuppressed && ownerOfRecord) { owner_resolution_status = 'no_reachable_owner_contact'; execution_route = 'owner_resolution_required'; }
  else { owner_resolution_status = 'owner_unresolved'; execution_route = 'owner_resolution_required'; }

  // V1.4 legacy route (OLD precedence: individual owner_resolved BEFORE the
  // entity/estate check) — for the exact V1.4-vs-V1.5 comparison only
  let legacy_route_v1_4;
  if (reo) legacy_route_v1_4 = 'excluded_reo';
  else if (tierAeligible.length > 0) legacy_route_v1_4 = 'owner_outreach';
  else if (activeListing) legacy_route_v1_4 = 'agent_flow_active_listing';
  else if (isEntity) legacy_route_v1_4 = 'entity_authority_resolution';
  else if (conflicts.length > 0 && cleanOwnerCands.length === 0) legacy_route_v1_4 = 'manual_review_renter_owner_conflict';
  else if (hasProbate) legacy_route_v1_4 = 'probate_counsel_first';
  else if (cleanOwnerCands.length > 0) legacy_route_v1_4 = 'owner_resolution_required';
  else if (!anyReachableNonSuppressed && ownerOfRecord) legacy_route_v1_4 = 'owner_resolution_required';
  else legacy_route_v1_4 = 'owner_resolution_required';

  const bestCandidate = candidates
    .filter((c) => !c.conflicted && c.person_status !== 'renter_suppressed')
    .sort((a, b) => tierRank(b.evidence_tier) - tierRank(a.evidence_tier) || b.resolution_confidence - a.resolution_confidence)[0] ?? null;

  return {
    version: CANONICAL_RESOLVER_VERSION,
    owner_of_record_present: ownerOfRecord, is_entity: isEntity,
    is_trust: isTrust, is_estate: isEstate, is_company: isCompany,
    entity_lexical_fallback: entityLexicalFallback,
    owner_resolution_status, execution_route, legacy_route_v1_4,
    candidates, best_candidate_id: bestCandidate?.id ?? null,
    best_evidence_tier: bestCandidate?.evidence_tier ?? null,
    // only a genuinely owner_resolved property exposes outreach-eligible
    // candidates — entity/estate/conflict/unresolved never do
    outreach_eligible_candidate_ids: execution_route === 'owner_outreach' ? tierAeligible.map((c) => c.id) : [],
    suppressed_candidate_ids: candidates.filter((c) => c.suppression_state === 'renter_suppressed').map((c) => c.id),
    conflict_candidate_ids: conflicts.map((c) => c.id),
    missing_evidence: missingEvidence(owner_resolution_status, isEntity, hasProbate, anyReachableNonSuppressed),
  };
}

function ownerEvidence(c) { return Boolean(c.owner_token || c.owner_verdict || c.name_match || c.exact_key_owner || c.verified_authority); }
function ownershipRel(c, t) {
  if (c.exact_key_owner) return 'keyed_owner_of_record';
  if (c.name_match && c.owner_verdict) return 'named_owner_verdict';
  if (c.name_match) return 'name_match_owner';
  if (c.owner_verdict) return 'vendor_owner_verdict';
  if (c.owner_token) return 'vendor_owner_token';
  if (t.tier === 'D') return 'no_ownership_evidence';
  return 'weak_association';
}
function tierConfidence(tier, conflicted) {
  if (conflicted) return 0.2;
  return { A: 0.9, B: 0.65, C: 0.4, D: 0.15 }[tier] ?? 0.15;
}
function tierRank(t) { return { A: 4, B: 3, C: 2, D: 1 }[t] ?? 0; }
function missingEvidence(status, isEntity, hasProbate, anyContact) {
  const m = [];
  if (status === 'entity_authority_required') m.push('verified_officer_or_authorized_signer', 'entity_status_confirmation');
  if (status === 'probate_authority_required') m.push('trustee_or_executor_identity', 'letters_testamentary');
  if (status === 'owner_candidate_found') m.push('owner_name_or_mailing_corroboration');
  if (status === 'owner_unresolved' || status === 'no_reachable_owner_contact') m.push('owner_of_record_contact_link');
  if (!anyContact) m.push('any_compliant_contact_method');
  return [...new Set(m)];
}
function explainCandidate(c, t, status) {
  if (t.conflicted) return `Tier D conflict: renter flag + ${[c.owner_token && 'owner token', c.owner_verdict && 'owner verdict', c.name_match && 'owner-name match'].filter(Boolean).join(' / ')} — do not auto-message; manual review.`;
  if (status === 'renter_suppressed') return 'Renter-flagged contact — suppressed (person-scoped).';
  if (status === 'owner_confirmed') return `Tier ${t.tier} confirmed owner: ${t.evidence.join(', ')}.`;
  if (status === 'owner_candidate') return `Tier ${t.tier} owner candidate: ${t.evidence.join(', ') || 'weak evidence'} — needs corroboration before outreach.`;
  if (status === 'authorized_representative') return `Authorized representative: ${c.authority_kind ?? 'verified authority'}.`;
  if (status === 'entity_associated') return 'Associated with an entity-owned property; authority unverified.';
  return `Tier ${t.tier}: ${t.evidence.join(', ') || 'no owner evidence'}.`;
}
