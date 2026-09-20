import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RESOLUTION_BRANCHES,
  VENDOR_FREE_BRANCH,
  PASSTHROUGH_FIELDS,
  COHORT_VENDOR_FREE_REACH,
  RESOLUTION_PARITY,
  RESOLUTION_REPRODUCIBILITY,
  isRealEntityKey,
  normaliseOwnerName,
  isExactNameMatch,
  selectResolutionBranch,
} from '../../src/lib/domain/seller-intelligence/v1-resolution-contract.js';

const property = (over = {}) => ({ owner_1_name: 'JOHN A SMITH', ...over });
const cand = (over = {}) => ({
  individual_key: '150123456789',
  full_name: 'John A Smith',
  matches_property_owner: null,
  likely_renting: false,
  ...over,
});

test('unmatched_* sentinels are not identities', () => {
  assert.equal(isRealEntityKey('150439402196'), true);
  assert.equal(isRealEntityKey('unmatched_email:2103109213:0'), false);
  assert.equal(isRealEntityKey(''), false);
  assert.equal(isRealEntityKey(null), false);
});

test('name normalisation strips punctuation and case', () => {
  assert.equal(normaliseOwnerName('John A. Smith'), 'JOHNASMITH');
  assert.equal(normaliseOwnerName("O'BRIEN, MARY-JO"), 'OBRIENMARYJO');
  assert.ok(isExactNameMatch('John A. Smith', 'JOHN A SMITH'));
  assert.ok(!isExactNameMatch('', 'JOHN A SMITH'), 'empty never matches');
  assert.ok(!isExactNameMatch('Jane Doe', 'JOHN A SMITH'));
});

test('the four branches carry the confidence constants measured in production', () => {
  const byMethod = Object.fromEntries(RESOLUTION_BRANCHES.map((b) => [b.match_method, b]));
  assert.equal(byMethod.name_exact_vendor.identity_confidence, 0.95);
  assert.equal(byMethod.name_exact_vendor.status, 'confirmed');
  assert.equal(byMethod.name_exact.identity_confidence, 0.85);
  assert.equal(byMethod.name_exact.status, 'high_confidence');
  assert.equal(byMethod.vendor_asserted.identity_confidence, 0.65);
  assert.equal(byMethod.name_partial_vendor.identity_confidence, 0.65);
});

test('THE KEY BRANCH: name_exact needs no vendor assertion', () => {
  const spec = RESOLUTION_BRANCHES.find((b) => b.match_method === VENDOR_FREE_BRANCH);
  assert.equal(spec.requires_vendor_assertion, false);
  assert.equal(spec.requires_exact_name, true);
  // Every other branch does require it — that is why the cohort is limited to this one.
  for (const b of RESOLUTION_BRANCHES) {
    if (b.match_method !== VENDOR_FREE_BRANCH) assert.equal(b.requires_vendor_assertion, true);
  }
});

test('a vendor-asserted exact name resolves to confirmed', () => {
  const v = selectResolutionBranch(property(), [cand({ matches_property_owner: true })]);
  assert.equal(v.match_method, 'name_exact_vendor');
  assert.equal(v.status, 'confirmed');
  assert.equal(v.identity_confidence, 0.95);
});

test('THE COHORT CASE: a NULL assertion with an exact name reaches high_confidence', () => {
  // This is exactly what the 6,808 still have, and it clears the 0.65
  // eligibility threshold.
  const v = selectResolutionBranch(property(), [cand({ matches_property_owner: null })]);
  assert.equal(v.match_method, 'name_exact');
  assert.equal(v.status, 'high_confidence');
  assert.ok(v.identity_confidence >= 0.65, 'passes the campaign eligibility gate');
  assert.equal(v.individual_key, '150123456789');
});

test('a vendor assertion with no name match is vendor_asserted, not name_exact', () => {
  const v = selectResolutionBranch(property(), [
    cand({ matches_property_owner: true, full_name: 'Someone Else' }),
  ]);
  assert.equal(v.match_method, 'vendor_asserted');
  assert.equal(v.status, 'medium_confidence');
});

test('a renter-flagged candidate is not treated as an asserted owner', () => {
  const v = selectResolutionBranch(property(), [
    cand({ matches_property_owner: true, likely_renting: true, full_name: 'Someone Else' }),
  ]);
  assert.notEqual(v.match_method, 'vendor_asserted');
});

test('AMBIGUITY IS REFUSED — two exact name matches pick neither', () => {
  const v = selectResolutionBranch(property(), [
    cand({ individual_key: 'A' }), cand({ individual_key: 'B' }),
  ]);
  assert.equal(v.status, 'ambiguous');
  assert.equal(v.match_method, null, 'production records absence, not a label');
  assert.equal(v.individual_key, null);
});

test('no candidates yields unresolved, not ambiguous', () => {
  assert.equal(selectResolutionBranch(property(), []).status, 'unresolved');
  assert.equal(
    selectResolutionBranch(property(), [cand({ individual_key: 'unmatched_email:1:0' })]).status,
    'unresolved',
  );
});

test('a candidate with neither assertion nor name match resolves to nothing', () => {
  const v = selectResolutionBranch(property(), [
    cand({ matches_property_owner: null, full_name: 'Totally Different' }),
  ]);
  assert.equal(v.status, 'ambiguous');
  assert.equal(v.individual_key, null);
});

test('passthrough fields are copies, and recorded as such', () => {
  assert.equal(PASSTHROUGH_FIELDS.deed_owner_name, 'seller.property.owner_1_name');
  const v = selectResolutionBranch(property(), [cand()]);
  assert.equal(v.matched_full_name, 'John A Smith', 'the winner name is carried, not recomputed');
});

test('cohort reach is recorded honestly — 45%, not "most"', () => {
  const r = COHORT_VENDOR_FREE_REACH;
  assert.equal(r.cohort, 6808);
  assert.equal(r.unique_name_match, 3035);
  assert.equal(r.ambiguous_name_match, 32);
  assert.equal(r.no_name_match, 3741);
  assert.equal(r.name_matchable, r.unique_name_match + r.ambiguous_name_match);
  assert.ok(r.unique_name_match / r.cohort < 0.5, 'under half the cohort — stated, not rounded up');
});

test('parity is recorded as measured, including what stays unsolved', () => {
  assert.equal(RESOLUTION_PARITY.sampled, 12000);
  assert.ok(RESOLUTION_PARITY.name_exact_vendor.method_and_key_pct > 95);
  assert.ok(RESOLUTION_PARITY.name_exact_vendor.method_and_key_pct < 100, 'not claimed exact');
  assert.equal(RESOLUTION_PARITY.name_exact_vendor.predicted_ambiguous, 432);
  assert.match(RESOLUTION_PARITY.unrecovered, /tie-break/);
});

test('reproducibility names what is NOT solved', () => {
  assert.equal(RESOLUTION_REPRODUCIBILITY.candidate_set, 'deterministic_recovered');
  assert.match(RESOLUTION_REPRODUCIBILITY.candidate_selection, /95pct_tiebreak_unsolved/);
  assert.equal(RESOLUTION_REPRODUCIBILITY.vendor_branches, 'blocked_missing_vendor_assertion_fields');
  // The 0.92% name residual is admitted rather than rounded to "recovered".
  assert.match(RESOLUTION_REPRODUCIBILITY.name_normalisation, /approximate/);
});
