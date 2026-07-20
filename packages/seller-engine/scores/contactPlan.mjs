// Phase 5 property-level contact plan (identity/routing layer — no scoring).
// For an owner_resolved property, selects ONE primary outreach person, keeps
// other eligible people as alternates, preserves required joint decision-makers,
// and encodes contact sequence + suppression-propagation + stop conditions.
// Pure/deterministic. Sends nothing; produces a plan only.
import { outreachEligibility } from './outreachEligibility.mjs';

export const CONTACT_PLAN_VERSION = 'contact-plan-v5';

const TIER_RANK = { A: 4, B: 3, C: 2, D: 1 };

// deterministic primary ranking among eligible candidates
function rankKey(c) {
  return [TIER_RANK[c.evidence_tier] ?? 0, c.resolution_confidence ?? 0, (c.phones ?? 0) + (c.emails ?? 0)];
}
function betterThan(a, b) {
  const ka = rankKey(a); const kb = rankKey(b);
  for (let i = 0; i < ka.length; i += 1) { if (ka[i] !== kb[i]) return ka[i] > kb[i]; }
  return String(a.id) < String(b.id); // stable lexicographic tiebreak
}

// property fields: owner_two_name (co-owner), vesting_raw (life estate/TIC),
// is_trust/estate. resolved: from resolveCanonical. Returns a contact plan.
export function buildContactPlan(property, resolved, cfg) {
  const summary = { candidates: resolved.candidates };
  const eligible = resolved.candidates.filter((c) => outreachEligibility(c, resolved, cfg).status === 'outreach_eligible');
  const rankedEligible = [...eligible].sort((a, b) => (betterThan(a, b) ? -1 : 1));
  const primary = rankedEligible[0] ?? null;
  const alternates = rankedEligible.slice(1);

  // V1.5 joint-party semantics — evidence-classed, never conflated. Only
  // AUTHORITATIVE evidence (deed vesting, recorded interest, verified trustee/
  // executor/officer, title evidence, contractual signature requirement) makes
  // a VERIFIED required signer. owner_2_name / shared surname / marital status /
  // household / trust reference alone are NOT sufficient.
  const nonPrimaryOwnerCands = resolved.candidates
    .filter((c) => c.id !== primary?.id && !c.conflicted && c.suppression_state !== 'renter_suppressed');
  const verifiedRequiredSigners = nonPrimaryOwnerCands
    .filter((c) => c.authority_relationship && /verified|trustee|executor|officer|deed_grantee/.test(c.authority_relationship)
      && c.person_status === 'authorized_representative')
    .map((c) => c.id);
  const probableCoOwners = nonPrimaryOwnerCands
    .filter((c) => ['owner_confirmed', 'owner_candidate'].includes(c.person_status)
      || (property.owner_two_name && (c.evidence?.includes?.('owner_name_match'))))
    .map((c) => c.id);
  const authorityUnknownParties = nonPrimaryOwnerCands
    .filter((c) => c.person_status === 'authority_unverified').map((c) => c.id);
  const alternateOwnerCandidates = alternates.map((c) => c.id)
    .filter((id) => !probableCoOwners.includes(id) && !verifiedRequiredSigners.includes(id) && !authorityUnknownParties.includes(id));
  // co-owner named on record but not linked = unlinked co-owner (probable, needs resolution)
  const unlinkedCoOwner = Boolean(property.owner_two_name) && probableCoOwners.length === 0;

  // simultaneous contact is FALSE by default; only VERIFIED joint authority may
  // enable it. owner_2_name / vesting text alone never does.
  const simultaneous = verifiedRequiredSigners.length > 0;
  return {
    version: CONTACT_PLAN_VERSION,
    property_id: property.property_id,
    primary_outreach_person_id: primary?.id ?? null,
    alternate_outreach_person_ids: alternateOwnerCandidates,
    verified_required_signers: verifiedRequiredSigners,
    probable_co_owners: probableCoOwners,
    alternate_owner_candidates: alternateOwnerCandidates,
    authority_unknown_parties: authorityUnknownParties,
    unlinked_co_owner_present: unlinkedCoOwner,
    primary_selection_evidence: primary ? { tier: primary.evidence_tier, confidence: primary.resolution_confidence, evidence: primary.evidence } : null,
    ownership_relationship: primary?.ownership_relationship ?? null,
    authority_relationship: primary?.authority_relationship ?? null,
    primary_phone_available: (primary?.phones ?? 0) > 0,
    primary_email_available: (primary?.emails ?? 0) > 0,
    contact_method_compliance: primary ? 'compliant_only_counted' : 'none',
    contact_sequence: primary ? [primary.id, ...alternateOwnerCandidates] : [],
    simultaneous_contact_allowed: simultaneous,
    suppression_propagation_rules: {
      opt_out: 'suppress the responding person; do not blanket-suppress other owners of record',
      wrong_person: 'remove that person as a candidate; re-resolve the property (may reopen owner_resolution_required)',
      ownership_dispute: 'halt all outreach for the property; route manual_review',
      renter_flag: 'person-scoped suppression only (never property-scoped)',
    },
    stop_conditions: [
      'valid owner response halts alternate outreach unless owner redirects or joint authority is required',
      'opt-out / DNC halts outreach to that person',
      'wrong-person evidence removes that person and triggers re-resolution',
      'ownership-dispute or suppression event halts property outreach pending review',
    ],
    plan_status: primary
      ? (verifiedRequiredSigners.length > 0 ? 'primary_plus_verified_required_signers'
        : probableCoOwners.length > 0 ? 'primary_plus_probable_co_owners' : 'single_primary')
      : 'no_eligible_primary',
    manual_approval_required: !primary,
  };
}
