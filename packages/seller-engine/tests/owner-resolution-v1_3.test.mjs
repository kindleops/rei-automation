import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveOwner, nameSignals } from '../scores/ownerResolution.mjs';
import { computeFeatures } from '../features/engine.mjs';
import { scoreDeterministicV1 } from '../scores/deterministicV1.mjs';
import { computeFamilies } from '../scores/families.mjs';

const AS_OF = '2026-07-01T00:00:00Z';

// ---- resolver unit tests (the evidence ladder) ----
const person = (o) => ({ id: o.id ?? 'x', identity_tier: o.tier ?? 'key', renter_flag: !!o.renter,
  link_tier: o.link_tier ?? 'none', owner_token: !!o.token, owner_verdict: !!o.verdict,
  name_match: !!o.name_match, surname_match: !!o.surname, exact_key_owner: !!o.exact_key });

test('renter contact + clean owner => owner_outreach, renter suppressed', () => {
  const r = resolveOwner({ owner_name: 'SMITH, JOHN', is_entity: false, persons: [
    person({ id: 'owner', link_tier: 'high', token: true, verdict: true, name_match: true }),
    person({ id: 'renter', renter: true, link_tier: 'none' }),
  ] });
  assert.equal(r.identity_route, 'owner_outreach_eligible');
  assert.ok(r.outreach_eligible_person_ids.includes('owner'));
  assert.ok(r.person_contact_suppressed.find((s) => s.person_id === 'renter').suppressed);
});

test('renter person who IS the named owner => manual review conflict', () => {
  const r = resolveOwner({ owner_name: 'SMITH, JOHN', is_entity: false, persons: [
    person({ id: 'p', renter: true, link_tier: 'high', name_match: true, token: true }),
  ] });
  assert.equal(r.identity_route, 'manual_review_renter_owner_conflict');
  assert.equal(r.census_category, 3);
});

test('renter token + owner token conflict (same person) => manual review', () => {
  const r = resolveOwner({ owner_name: 'DOE, JANE', is_entity: false, persons: [
    person({ id: 'p', renter: true, link_tier: 'high', token: true, verdict: true }),
  ] });
  assert.equal(r.identity_route, 'manual_review_renter_owner_conflict');
});

test('owner of record missing from person graph => owner_resolution_required', () => {
  const r = resolveOwner({ owner_name: 'SMITH, JOHN', is_entity: false, persons: [
    person({ id: 'renter', renter: true, link_tier: 'none' }),
  ] });
  assert.equal(r.identity_route, 'owner_resolution_required');
  assert.equal(r.owner_resolution_status, 'owner_of_record_unlinked');
});

test('company owner + renter occupant => entity_authority_resolution', () => {
  const r = resolveOwner({ owner_name: 'ACME HOLDINGS LLC', is_entity: true, persons: [
    person({ id: 'occ', renter: true, link_tier: 'none' }),
  ] });
  assert.equal(r.identity_route, 'entity_authority_resolution');
  assert.equal(r.census_category, 5);
});

test('trust/estate owner + unrelated occupant => entity_authority_resolution', () => {
  const r = resolveOwner({ owner_name: 'JOHN SMITH FAMILY TRUST', is_entity: true, persons: [
    person({ id: 'occ', renter: false, link_tier: 'low', surname: true }),
  ] });
  assert.equal(r.identity_route, 'entity_authority_resolution');
});

test('fallback-identity renter (non-key tier) still person-suppressed, not auto-blocked when owner of record exists', () => {
  const r = resolveOwner({ owner_name: 'SMITH, JOHN', is_entity: false, persons: [
    person({ id: 'renter', renter: true, tier: 'name_address', link_tier: 'none' }),
  ] });
  assert.equal(r.identity_route, 'owner_resolution_required');
  assert.ok(r.person_contact_suppressed[0].suppressed);
});

test('exact individual-key owner => strong evidence, outreach eligible', () => {
  const r = resolveOwner({ owner_name: 'SMITH, JOHN', is_entity: false, persons: [
    person({ id: 'o', tier: 'key', link_tier: 'exact', verdict: true, name_match: true, exact_key: true }),
  ] });
  assert.equal(r.evidence_strengths[0].strength, 'strong');
  assert.equal(r.identity_route, 'owner_outreach_eligible');
});

test('owner-name match without corroboration => resolution required, NOT outreach', () => {
  const r = resolveOwner({ owner_name: 'SMITH, JOHN', is_entity: false, persons: [
    person({ id: 'o', link_tier: 'none', name_match: true }),   // name-only, no token/verdict/tier
  ] });
  assert.notEqual(r.identity_route, 'owner_outreach_eligible');
  assert.equal(r.outreach_eligible_person_ids.length, 0);
});

test('multiple people, mixed owner/renter evidence => clean owner wins, renter suppressed', () => {
  const r = resolveOwner({ owner_name: 'SMITH, JOHN', is_entity: false, persons: [
    person({ id: 'renter', renter: true, link_tier: 'high', token: true }),
    person({ id: 'owner', renter: false, link_tier: 'high', verdict: true, name_match: true }),
  ] });
  assert.equal(r.identity_route, 'owner_outreach_eligible');
  assert.ok(r.person_contact_suppressed.find((s) => s.person_id === 'renter').suppressed);
  assert.ok(r.outreach_eligible_person_ids.includes('owner'));
});

test('V1.4: renter with no owner name is NOT blocked_not_owner (deprecated) — routes to owner resolution', () => {
  const r = resolveOwner({ owner_name: null, is_entity: false, persons: [
    person({ id: 'renter', renter: true, link_tier: 'none' }),
  ] });
  assert.equal(r.identity_route, 'owner_resolution_required');
  assert.equal(r.owner_resolution_status, 'no_reachable_owner_contact');
  assert.notEqual(r.identity_route, 'blocked_not_owner');
});

test('route reproducibility: identical evidence => identical resolution', () => {
  const ev = { owner_name: 'SMITH, JOHN', is_entity: false, persons: [person({ id: 'p', renter: true, name_match: true, link_tier: 'high' })] };
  assert.deepEqual(resolveOwner(ev), resolveOwner(ev));
});

test('name signals: SMITH, JOHN vs JOHN SMITH matches; single-token is surname-only', () => {
  assert.equal(nameSignals('SMITH, JOHN', 'JOHN SMITH').name_match, true);
  assert.equal(nameSignals('SMITH, JOHN', 'SMITH').surname_match, true);
  assert.equal(nameSignals('SMITH, JOHN', 'SMITH').name_match, false);
});

// ---- unchanged seller-pressure families between routing scenarios ----
const pressureBundle = (linkOver) => ({
  property: { id: 'p1', year_built: 1960, condition_raw: 'Poor', condition_state: 'known',
    raw_keep: { owner_name: 'SMITH, JOHN', property_flags: '[{"code":"tax_delinquent"}]' } },
  valuation: { estimated_value: 200000, estimated_equity: 150000, equity_percent: 75, tax_delinquent: true, tax_delinquent_year: 2022 },
  loans: [], checksums: null,
  liens: [{ id: 'a', base_type: 'judgment', lifecycle_class: 'judgment', filing_date: '2024-01-01', amount_due: 20000, doc_type_raw: 'JDGLEN' }],
  foreclosure: [], transactions: [{ id: 't', event_role: 'current', sale_date: '2005-01-01', sale_price: 60000, price_qualifier_class: 'valuation' }],
  links: [linkOver], phones: [{ phone_e164: '+15555550100', line_type: 'wireless', do_not_call: false, never_call: false }],
  emails: [], batchScalarLiveness: 0.2,
});
const MOTIVATION = ['seller_propensity', 'financial_pressure', 'legal_title_pressure', 'foreclosure_urgency',
  'property_distress', 'physical_obsolescence', 'landlord_fatigue', 'portfolio_liquidation'];

test('V1.3: identity route does NOT change any seller-pressure/financial family score', () => {
  // same property, three very different identity situations
  const cleanOwner = computeFamilies(computeFeatures(pressureBundle(
    { id: 'o', person_id: 'o', link_tier: 'high', matching_flags: ['Likely Owner'], renter_flag: false, is_matching_property_as_owner: true, person_name: 'JOHN SMITH' }), AS_OF).features);
  const renterConflict = computeFamilies(computeFeatures(pressureBundle(
    { id: 'r', person_id: 'r', link_tier: 'high', matching_flags: ['Likely Owner'], renter_flag: true, is_matching_property_as_owner: true, person_name: 'JOHN SMITH' }), AS_OF).features);
  const unresolved = computeFamilies(computeFeatures(pressureBundle(
    { id: 'x', person_id: 'x', link_tier: 'none', matching_flags: [], renter_flag: true, person_name: 'OTHER PERSON' }), AS_OF).features);
  for (const fam of MOTIVATION) {
    assert.equal(renterConflict[fam].score, cleanOwner[fam].score, `${fam} must be identity-invariant`);
    assert.equal(unresolved[fam].score, cleanOwner[fam].score, `${fam} must be identity-invariant`);
  }
  // and the routes genuinely differ
  const route = (f) => f.execution_priority.route;
  assert.equal(route(cleanOwner), 'owner_outreach');
  assert.equal(route(renterConflict), 'manual_review_renter_owner_conflict');
  assert.equal(route(unresolved), 'owner_resolution_required');
});

test('V1.3 engine: F-114 emitted with route + person suppression; confirmed block only without owner of record', () => {
  const { features } = computeFeatures(pressureBundle(
    { id: 'r', person_id: 'r', link_tier: 'none', matching_flags: [], renter_flag: true, person_name: 'X' }), AS_OF);
  const f114 = features.find((f) => f.feature_id === 'F-114');
  assert.ok(f114 && f114.value.identity_route === 'owner_resolution_required'); // owner of record present -> not blocked
  const s = scoreDeterministicV1(features);
  assert.notEqual(s.route, 'blocked_not_owner');
});
