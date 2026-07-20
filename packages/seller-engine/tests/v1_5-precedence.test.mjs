import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCanonical } from '../scores/ownerResolutionCanonical.mjs';
import { outreachEligibility } from '../scores/outreachEligibility.mjs';
import { buildContactPlan } from '../scores/contactPlan.mjs';
import { computeFeatures } from '../features/engine.mjs';
import { scoreDeterministicV1 } from '../scores/deterministicV1.mjs';
import { computeFamilies } from '../scores/families.mjs';

const cand = (o) => ({ id: o.id ?? 'c', person_name: o.name ?? '', link_tier: o.link_tier ?? 'exact',
  owner_token: o.token ?? true, owner_verdict: o.verdict ?? true, renter_flag: !!o.renter,
  exact_key_owner: o.exact_key ?? true, mailing_match: o.mailing, phones: o.phones ?? 1, emails: o.emails ?? 0,
  verified_authority: o.authority, authority_kind: o.authority_kind });

// ---- entity/trust/estate precedence over individual name match ----
test('individual name embedded in TRUST name => entity/authority route, not owner_outreach', () => {
  const r = resolveCanonical({ owner_name: 'John Gipson Irrevocable Trust' },
    [{ ...cand({ id: 'p', name: 'JOHN GIPSON' }), name_match: true }]);
  assert.notEqual(r.execution_route, 'owner_outreach');
  assert.equal(r.owner_resolution_status, 'entity_authority_required');
  assert.equal(r.candidates[0].person_status, 'authority_unverified');
  assert.equal(r.outreach_eligible_candidate_ids.length, 0);
});

test('individual name embedded in ESTATE name => probate authority route', () => {
  const r = resolveCanonical({ owner_name: 'Henry Robert H Estate Of' },
    [{ ...cand({ id: 'p', name: 'HENRY ROBERT' }), name_match: true }]);
  assert.equal(r.owner_resolution_status, 'probate_authority_required');
  assert.equal(r.execution_route, 'probate_counsel_first');
});

test('individual name embedded in LLC name => entity authority route', () => {
  const r = resolveCanonical({ owner_name: 'Smith Family Properties LLC' },
    [{ ...cand({ id: 'p', name: 'JOHN SMITH' }), name_match: true }]);
  assert.equal(r.owner_resolution_status, 'entity_authority_required');
});

test('canonical entity classification overrides individual match', () => {
  const r = resolveCanonical({ owner_name: 'John Smith', is_entity: true },  // classified entity, plain name
    [{ ...cand({ id: 'p', name: 'JOHN SMITH' }), name_match: true }]);
  assert.equal(r.execution_route, 'entity_authority_resolution');
});

test('lexical entity fallback fail-closes even without classification', () => {
  const r = resolveCanonical({ owner_name: 'Cook Guadalupe Living Trust' },  // no classification, lexical only
    [{ ...cand({ id: 'p', name: 'GUADALUPE COOK' }), name_match: true }]);
  assert.equal(r.entity_lexical_fallback, true);
  assert.notEqual(r.execution_route, 'owner_outreach');
});

// ---- verified authority is eligible; unverified is not ----
test('verified trustee authority => authorized_representative (manual approval, not auto)', () => {
  const r = resolveCanonical({ owner_name: 'Smith Family Trust', is_trust: true },
    [{ ...cand({ id: 't', name: 'JANE SMITH', authority: true, authority_kind: 'trustee' }), name_match: true }]);
  const c = r.candidates[0];
  assert.equal(c.person_status, 'authorized_representative');
  // still gated: entity property => manual approval (not auto-outreach)
  assert.equal(outreachEligibility(c, r).status, 'manual_approval_required');
});

test('verified executor authority recognized', () => {
  const r = resolveCanonical({ owner_name: 'Estate of Mary Jones', probate_evidence: true },
    [{ ...cand({ id: 'e', name: 'MARY JONES', authority: true, authority_kind: 'executor' }), name_match: true }]);
  assert.equal(r.candidates[0].person_status, 'authorized_representative');
});

test('verified company officer authority recognized', () => {
  const r = resolveCanonical({ owner_name: 'Acme LLC', is_entity: true },
    [{ ...cand({ id: 'o', name: 'BOSS', authority: true, authority_kind: 'officer' }), name_match: false }]);
  assert.equal(r.candidates[0].person_status, 'authorized_representative');
});

test('registered agent without signing authority is NOT auto-eligible', () => {
  const r = resolveCanonical({ owner_name: 'Acme LLC', is_entity: true },
    [cand({ id: 'ra', name: 'AGENT', authority: false })]);
  assert.notEqual(outreachEligibility(r.candidates[0], r).status, 'outreach_eligible');
});

// ---- Tier B => manual approval (V1.5 policy) ----
test('Tier B token+verdict => manual_approval_required (pending independence audit)', () => {
  const r = resolveCanonical({ owner_name: 'SMITH, JOHN' },
    [{ ...cand({ id: 'b', name: 'JOHN SMITH', link_tier: 'medium', exact_key: false }), name_match: false }]);
  // token+verdict => Tier B
  const c = r.candidates[0];
  assert.equal(c.evidence_tier, 'B');
  const e = outreachEligibility(c, r);
  assert.equal(e.status, 'manual_approval_required');
  assert.ok(e.reason_codes.includes('tier_b_pending_independence_audit'));
});

test('Tier A exact-key on a plain-individual owner stays shadow-eligible', () => {
  const r = resolveCanonical({ owner_name: 'SMITH, JOHN' },
    [{ ...cand({ id: 'a', name: 'JOHN SMITH', exact_key: true, link_tier: 'exact' }), name_match: true }]);
  assert.equal(r.execution_route, 'owner_outreach');
  assert.equal(outreachEligibility(r.candidates[0], r).status, 'outreach_eligible');
});

// ---- exact key without ownership linkage ----
test('exact person key WITHOUT owner verdict or name match is not ownership evidence', () => {
  const r = resolveCanonical({ owner_name: 'SMITH, JOHN' },
    [{ ...cand({ id: 'k', name: 'UNRELATED PERSON', exact_key: false, token: false, verdict: false, link_tier: 'none' }), name_match: false }]);
  assert.notEqual(r.candidates[0].evidence_tier, 'A');
});

// ---- joint-party semantics ----
test('owner_2_name alone => probable_co_owner, not verified required signer; simultaneous=false', () => {
  const r = resolveCanonical({ owner_name: 'SMITH, JOHN' },
    [{ ...cand({ id: 'a', name: 'JOHN SMITH', exact_key: true }), name_match: true },
      { ...cand({ id: 'b', name: 'JANE SMITH', exact_key: true }), name_match: true }]);
  const plan = buildContactPlan({ property_id: 'p', owner_name: 'SMITH, JOHN', owner_two_name: 'JANE SMITH' }, r);
  assert.equal(plan.verified_required_signers.length, 0);
  assert.equal(plan.simultaneous_contact_allowed, false);
  assert.ok(plan.probable_co_owners.length >= 1 || plan.alternate_owner_candidates.length >= 1);
});

test('verified joint signer => simultaneous_contact_allowed true', () => {
  const r = resolveCanonical({ owner_name: 'SMITH, JOHN' },
    [{ ...cand({ id: 'a', name: 'JOHN SMITH', exact_key: true }), name_match: true },
      { ...cand({ id: 's', name: 'CO SIGNER', authority: true, authority_kind: 'trustee' }), name_match: false }]);
  const plan = buildContactPlan({ property_id: 'p', owner_name: 'SMITH, JOHN' }, r);
  assert.ok(plan.verified_required_signers.includes('s'));
  assert.equal(plan.simultaneous_contact_allowed, true);
});

test('no compliant primary contact => no eligible primary (routes to enrichment)', () => {
  const r = resolveCanonical({ owner_name: 'SMITH, JOHN' },
    [{ ...cand({ id: 'a', name: 'JOHN SMITH', exact_key: true, phones: 0, emails: 0 }), name_match: true }]);
  const plan = buildContactPlan({ property_id: 'p', owner_name: 'SMITH, JOHN' }, r);
  assert.equal(plan.primary_outreach_person_id, null);
  assert.equal(plan.manual_approval_required, true);
});

// ---- seller-pressure unchanged ----
test('V1.5: entity precedence does NOT change any seller-pressure family score', () => {
  const base = (ownerName, link) => ({
    property: { id: 'p1', condition_raw: 'Poor', condition_state: 'known', raw_keep: { owner_name: ownerName, property_flags: '[{"code":"tax_delinquent"}]' } },
    valuation: { estimated_value: 200000, estimated_equity: 150000, equity_percent: 75, tax_delinquent: true, tax_delinquent_year: 2022 },
    loans: [], liens: [{ id: 'a', base_type: 'judgment', lifecycle_class: 'judgment', filing_date: '2024-01-01', amount_due: 20000, doc_type_raw: 'JDGLEN' }],
    foreclosure: [], transactions: [{ id: 't', event_role: 'current', sale_date: '2005-01-01', sale_price: 60000, price_qualifier_class: 'valuation' }],
    links: [link], phones: [{ phone_e164: '+15555550100', line_type: 'wireless', do_not_call: false, never_call: false }], emails: [], batchScalarLiveness: 0.2,
  });
  const individual = computeFamilies(computeFeatures(base('SMITH, JOHN', { id: 'o', person_id: 'o', link_tier: 'high', matching_flags: ['Likely Owner'], renter_flag: false, is_matching_property_as_owner: true, person_name: 'JOHN SMITH' }), '2026-07-01T00:00:00Z').features);
  const trust = computeFamilies(computeFeatures(base('Smith Family Trust', { id: 'o', person_id: 'o', link_tier: 'high', matching_flags: ['Likely Owner'], renter_flag: false, is_matching_property_as_owner: true, person_name: 'JOHN SMITH' }), '2026-07-01T00:00:00Z').features);
  for (const fam of ['seller_propensity', 'financial_pressure', 'legal_title_pressure', 'foreclosure_urgency', 'property_distress', 'landlord_fatigue']) {
    assert.equal(trust[fam].score, individual[fam].score, `${fam} must be identity-invariant`);
  }
  // and the routes differ (trust => entity authority)
  assert.equal(trust.execution_priority.route, 'entity_authority_resolution');
  assert.equal(individual.execution_priority.route, 'owner_outreach');
});
