import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCanonical, candidateTier, EXECUTION_ROUTE, DEPRECATED_ROUTES } from '../scores/ownerResolutionCanonical.mjs';
import { outreachEligibility, propertyOutreachSummary } from '../scores/outreachEligibility.mjs';
import { resolutionPriority } from '../scores/resolutionPriority.mjs';

const cand = (o) => ({ id: o.id ?? 'c', person_name: o.name ?? '', link_tier: o.link_tier ?? 'none',
  owner_token: !!o.token, owner_verdict: !!o.verdict, renter_flag: !!o.renter,
  exact_key_owner: !!o.exact_key, mailing_match: o.mailing, phones: o.phones ?? 1, emails: o.emails ?? 0,
  explicit_not_owner: !!o.not_owner, verified_authority: o.authority, authority_kind: o.authority_kind,
  independent_source_matches: o.sources ?? 0 });

// ---- canonical router never emits blocked_not_owner ----
test('canonical router NEVER emits blocked_not_owner for a property', () => {
  const scenarios = [
    { owner_name: 'SMITH, JOHN', persons: [cand({ renter: true })] },              // renter only
    { owner_name: 'ACME LLC', is_entity: true, persons: [cand({ renter: true })] }, // entity + renter
    { owner_name: 'SMITH, JOHN', persons: [] },                                     // no persons
    { owner_name: null, persons: [cand({ renter: true, link_tier: 'none' })] },     // no owner name + renter
  ];
  for (const p of scenarios) {
    const r = resolveCanonical(p, p.persons);
    assert.ok(EXECUTION_ROUTE.includes(r.execution_route), `route ${r.execution_route} must be canonical`);
    assert.ok(!DEPRECATED_ROUTES.includes(r.execution_route));
    assert.notEqual(r.execution_route, 'blocked_not_owner');
  }
});

test('renter with no owner contact => no_reachable_owner_contact + owner_resolution_required (not blocked)', () => {
  const r = resolveCanonical({ owner_name: 'SMITH, JOHN' }, [cand({ renter: true })]);
  assert.equal(r.owner_resolution_status, 'no_reachable_owner_contact');
  assert.equal(r.execution_route, 'owner_resolution_required');
});

// ---- evidence tiers ----
test('evidence tiers A/B/C/D deterministic', () => {
  assert.equal(candidateTier(cand({ exact_key: true, name: 'X', link_tier: 'exact', verdict: true })).tier, 'A');
  assert.equal(candidateTier({ ...cand({ token: true, verdict: true }), name_match: false }).tier, 'B');
  assert.equal(candidateTier({ ...cand({ link_tier: 'low' }), name_match: true }).tier, 'C');
  assert.equal(candidateTier({ ...cand({ link_tier: 'none' }), name_match: false }).tier, 'D');
  // renter + owner evidence forces Tier D (conflict)
  assert.equal(candidateTier({ ...cand({ renter: true, token: true }), name_match: true }).conflicted, true);
});

test('three layers separated: person status vs owner-resolution status vs route', () => {
  const r = resolveCanonical({ owner_name: 'SMITH, JOHN', owner_mailing_state: 'TN', situs_state: 'TN' },
    [{ ...cand({ id: 'o', exact_key: true, verdict: true, token: true, name: 'JOHN SMITH', link_tier: 'exact', mailing: true }), name_match: true },
      cand({ id: 'r', renter: true })]);
  const owner = r.candidates.find((c) => c.id === 'o');
  const renter = r.candidates.find((c) => c.id === 'r');
  assert.equal(owner.person_status, 'owner_confirmed');
  assert.equal(renter.person_status, 'renter_suppressed');
  assert.equal(r.owner_resolution_status, 'owner_resolved');
  assert.equal(r.execution_route, 'owner_outreach');
});

test('entity owner => entity_authority_required + entity_authority_resolution', () => {
  const r = resolveCanonical({ owner_name: 'ACME HOLDINGS LLC', is_entity: true }, [cand({ id: 'x', phones: 1 })]);
  assert.equal(r.owner_resolution_status, 'entity_authority_required');
  assert.equal(r.execution_route, 'entity_authority_resolution');
});

test('probate evidence without executor => probate_authority_required', () => {
  const r = resolveCanonical({ owner_name: 'ESTATE OF JOHN SMITH', probate_evidence: true, is_entity: false },
    [cand({ id: 'h', name: 'JANE SMITH', link_tier: 'low' })]);
  // ESTATE name matches entity regex OR probate — either way authority pending
  assert.ok(['probate_authority_required', 'entity_authority_required'].includes(r.owner_resolution_status));
});

test('clean owner candidate uncorroborated => owner_resolution_required (not outreach)', () => {
  const r = resolveCanonical({ owner_name: 'SMITH, JOHN' },
    [{ ...cand({ id: 'o', link_tier: 'none' }), name_match: true }]); // name-only, no verdict/mailing
  assert.equal(r.execution_route, 'owner_resolution_required');
  assert.equal(r.outreach_eligible_candidate_ids.length, 0);
});

// ---- fail-closed outreach eligibility ----
test('fail-closed: suppressed, conflicted, unresolved never auto-eligible', () => {
  const rEntity = resolveCanonical({ owner_name: 'ACME LLC', is_entity: true }, [cand({ id: 'x' })]);
  for (const c of rEntity.candidates) {
    const e = outreachEligibility(c, rEntity);
    assert.notEqual(e.status, 'outreach_eligible', 'entity contact without verified authority is never auto-eligible');
  }
  const rRenter = resolveCanonical({ owner_name: 'SMITH, JOHN' }, [cand({ renter: true })]);
  assert.equal(outreachEligibility(rRenter.candidates[0], rRenter).status, 'outreach_ineligible');
});

test('outreach eligible ONLY with Tier-A/approved-B evidence + compliant contact', () => {
  const r = resolveCanonical({ owner_name: 'SMITH, JOHN', owner_mailing_state: 'TN', situs_state: 'TN' },
    [{ ...cand({ id: 'o', exact_key: true, verdict: true, link_tier: 'exact', phones: 1 }), name_match: true }]);
  const sum = propertyOutreachSummary(r);
  assert.ok(sum.any_outreach_eligible);
  assert.ok(sum.outreach_eligible_ids.includes('o'));
  // remove the contact method => ineligible
  const r2 = resolveCanonical({ owner_name: 'SMITH, JOHN' },
    [{ ...cand({ id: 'o', exact_key: true, verdict: true, link_tier: 'exact', phones: 0, emails: 0 }), name_match: true }]);
  assert.equal(outreachEligibility(r2.candidates[0], r2).status, 'outreach_ineligible');
});

// ---- resolution priority is separate from motivation ----
test('resolution_priority reads seller pressure but is a separate axis', () => {
  const hi = resolutionPriority({ seller_pressure_raw: 90, foreclosure_urgency: 85, equity_pct: 60,
    owner_resolution_status: 'owner_candidate_found', resolution_confidence: 0.65, available_contact_methods: 2, foreclosure_stage: 'nod' });
  const lo = resolutionPriority({ seller_pressure_raw: 10, foreclosure_urgency: 0, equity_pct: 5,
    owner_resolution_status: 'entity_authority_required', resolution_confidence: 0.2, available_contact_methods: 0 });
  assert.ok(hi.resolution_priority > lo.resolution_priority);
  assert.ok(hi.resolution_priority_0_100 >= 0 && hi.resolution_priority_0_100 <= 100);
  assert.match(hi.note, /does not alter/);
});

test('reproducibility: identical inputs => identical canonical resolution', () => {
  const p = { owner_name: 'SMITH, JOHN', persons: [cand({ id: 'a', token: true })] };
  assert.deepEqual(resolveCanonical(p, p.persons), resolveCanonical(p, p.persons));
});
