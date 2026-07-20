// Phase 5 fail-closed outreach eligibility (person/contact level). Default is
// INELIGIBLE; a contact becomes eligible only on explicit positive evidence and
// only when every gate passes. Never authorizes outreach for a suppressed,
// conflicted, unresolved, or authority-pending contact. Pure/deterministic.
export const OUTREACH_ELIGIBILITY_VERSION = 'outreach-eligibility-v5';

export const ELIGIBILITY_CONFIG = {
  identity_confidence_threshold: 0.6,   // Tier A (0.9) clears; B/C/D do not auto-clear
  outreach_tiers: ['A'],                // V1.5: only Tier A auto-eligible (shadow, pending exact-key audit)
  tier_b_auto: false,                   // V1.5: Tier B => manual_approval until independence proven
};

// candidate: a resolved candidate from ownerResolutionCanonical.resolveCanonical
// propertyResolution: the property-level resolution object. Fail-closed:
// default is NOT eligible; a contact clears only when every gate passes.
export function outreachEligibility(candidate, propertyResolution, cfg = ELIGIBILITY_CONFIG) {
  const out = (status, ...rs) => ({ status, reason_codes: rs, contact_id: candidate.id, version: OUTREACH_ELIGIBILITY_VERSION });

  // person-level hard gates
  if (candidate.suppression_state === 'renter_suppressed') return out('outreach_ineligible', 'renter_suppressed');
  if (candidate.conflicted) return out('manual_approval_required', 'unresolved_renter_owner_conflict');
  if (candidate.person_status === 'deceased') return out('outreach_ineligible', 'deceased_contact');
  if (candidate.person_status === 'confirmed_not_owner') return out('outreach_ineligible', 'confirmed_not_owner');
  if (candidate.person_status === 'wrong_person') return out('outreach_ineligible', 'wrong_person');
  // V1.5: an entity/trust/estate associated person is authority-unverified — a
  // name inside a trust/company name is never a verified signer
  if (candidate.person_status === 'authority_unverified') return out('manual_approval_required', 'entity_or_trust_authority_unverified');

  // property-level authority gates (fail-closed) — entity/trust/estate/probate
  // never auto-outreach
  if (propertyResolution.owner_resolution_status === 'entity_authority_required') return out('manual_approval_required', 'entity_authority_unresolved');
  if (propertyResolution.owner_resolution_status === 'probate_authority_required') return out('manual_approval_required', 'probate_authority_unresolved');
  if (propertyResolution.owner_resolution_status === 'conflicting_owner_evidence') return out('manual_approval_required', 'unresolved_renter_owner_conflict');
  if (propertyResolution.owner_resolution_status === 'listing_agent_controls_contact') return out('outreach_ineligible', 'listing_agent_controls_contact');
  if (propertyResolution.execution_route === 'excluded_reo') return out('outreach_ineligible', 'reo_excluded');
  if (propertyResolution.execution_route !== 'owner_outreach') return out('manual_approval_required', 'property_not_owner_resolved');

  // contactability + confidence + tier gates
  if (!candidate.contactable) return out('outreach_ineligible', 'no_compliant_contact_method');
  if ((candidate.resolution_confidence ?? 0) < cfg.identity_confidence_threshold) return out('manual_approval_required', 'identity_confidence_below_threshold');
  // V1.5: Tier B moves to manual approval until the provenance/independence audit
  // approves specific rules (SELLER_OWNERSHIP_EVIDENCE_PROVENANCE)
  if (candidate.evidence_tier === 'B') return out('manual_approval_required', 'tier_b_pending_independence_audit');
  if (!cfg.outreach_tiers.includes(candidate.evidence_tier)) return out('manual_approval_required', 'owner_evidence_tier_insufficient');

  // Tier A + compliant contact + owner_resolved property: shadow-eligible
  return out('outreach_eligible', 'tier_a_exact_key_shadow_eligible');
}

// property-level roll-up of contact eligibility
export function propertyOutreachSummary(propertyResolution, cfg = ELIGIBILITY_CONFIG) {
  const evals = (propertyResolution.candidates ?? []).map((c) => ({ ...outreachEligibility(c, propertyResolution, cfg), candidate: c.id }));
  const eligible = evals.filter((e) => e.status === 'outreach_eligible');
  const manual = evals.filter((e) => e.status === 'manual_approval_required');
  return {
    any_outreach_eligible: eligible.length > 0,
    outreach_eligible_ids: eligible.map((e) => e.contact_id),
    manual_approval_ids: manual.map((e) => e.contact_id),
    ineligible_ids: evals.filter((e) => e.status === 'outreach_ineligible').map((e) => e.contact_id),
    per_contact: evals,
  };
}
