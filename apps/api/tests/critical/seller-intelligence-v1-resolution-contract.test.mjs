import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RESOLUTION_BRANCHES,
  VENDOR_FREE_BRANCH,
  PASSTHROUGH_FIELDS,
  COHORT_VENDOR_FREE_REACH,
  RESOLUTION_PARITY,
  REJECTED_TIEBREAKS,
  FILE10_DRY_RUN,
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

test('normalisation is uppercase + strip-non-alpha, and nothing more', () => {
  // 977/977 of name_exact winners are explained by exactly this. A suffix rule
  // would be inert here, so it is deliberately absent.
  assert.ok(isExactNameMatch('Charles W Price', 'CHARLES W PRICE'));
  assert.ok(!isExactNameMatch('Charles W Price Sr', 'Charles W Price'),
    'suffixes are NOT stripped by this function');
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

test('GOLDEN PARITY: the cohort branch has ZERO silent wrong winners (§8)', () => {
  assert.equal(RESOLUTION_PARITY.sampled, 60000);
  assert.equal(RESOLUTION_PARITY.name_exact.silent_wrong, 0, 'the number that matters');
  // The vendor branches carry a small residual; the cohort cannot use them anyway.
  assert.equal(RESOLUTION_PARITY.name_exact_vendor.silent_wrong, 7);
  assert.equal(RESOLUTION_PARITY.vendor_asserted.silent_wrong, 9);
  // The entity gate agrees with production on all but one row.
  const g = RESOLUTION_PARITY.entity_gate;
  assert.equal(g.predicted - g.agreed_entity_owned, 1);
});

test('NO TIE-BREAK WAS ACCEPTED — 92% is not good enough (§6/§7)', () => {
  assert.equal(REJECTED_TIEBREAKS.accepted, null);
  // Every candidate rule is recorded with the score that disqualified it.
  for (const [rule, score] of Object.entries(REJECTED_TIEBREAKS)) {
    if (rule === 'accepted') continue;
    assert.ok(score < 1, `${rule} is not deterministic`);
  }
  assert.ok(RESOLUTION_PARITY.refused_ambiguous > 0, 'ties fail closed');
});

test('the File-10 dry run adds up and claims nothing extra (§9/§21)', () => {
  const d = FILE10_DRY_RUN;
  const sum = d.high_confidence_name_exact + d.medium_confidence_vendor_asserted
    + d.confirmed_name_exact_vendor + d.ambiguous_tie_failed_closed
    + d.unresolved_no_qualifying_branch + d.entity_owned;
  assert.equal(sum, d.total, 'every one of the 6,808 is accounted for');
  assert.equal(d.safely_resolved,
    d.high_confidence_name_exact + d.medium_confidence_vendor_asserted + d.confirmed_name_exact_vendor);
  assert.ok(d.best_contact_derivable <= d.safely_resolved);
  assert.ok(d.safely_resolved < d.total / 2, 'under half — stated, not rounded up');
  assert.match(d.manifest_md5, /^[0-9a-f]{32}$/);
});

test('the earlier 3,035 estimate is superseded, not preserved (§11)', () => {
  // 3,035 came from an exploratory query with no branch precedence and no
  // fail-closed tie handling. Applying both moves it to 2,962 on name_exact,
  // with 66 + 79 reaching vendor branches and 60 refused as ambiguous.
  assert.equal(FILE10_DRY_RUN.high_confidence_name_exact, 2962);
  assert.notEqual(FILE10_DRY_RUN.high_confidence_name_exact, 3035);
});

test('reproducibility names what is NOT solved', () => {
  assert.equal(RESOLUTION_REPRODUCIBILITY.candidate_set, 'deterministic_recovered');
  assert.match(RESOLUTION_REPRODUCIBILITY.candidate_selection, /95pct_tiebreak_unsolved/);
  assert.equal(RESOLUTION_REPRODUCIBILITY.vendor_branches, 'blocked_missing_vendor_assertion_fields');
  assert.equal(RESOLUTION_REPRODUCIBILITY.name_normalisation, 'exact_for_name_exact_branch');
});
