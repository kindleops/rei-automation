import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  V1_SCORE_USAGE_RESTRICTIONS,
  V1_BUILD,
  ELIGIBILITY_GATING_SCORE_COLUMNS,
  FEATURE_DERIVED_GATING_COLUMNS,
  NON_ROUTING_SCORE_COLUMNS,
  IDENTITY_CONFIDENCE_BY_STATUS,
  ELIGIBLE_RESOLUTION_STATUSES,
  ELIGIBILITY_THRESHOLDS,
  MATCH_METHODS,
  PRIORITY_PILLAR_EXPONENTS,
  composePriorityScore,
  scoreColumnRoutingRole,
  V1_REPRODUCIBILITY,
} from '../../src/lib/domain/seller-intelligence/v1-contract.js';

const MODULE_PATH = new URL(
  '../../src/lib/domain/seller-intelligence/v1-contract.js',
  import.meta.url,
);

test('the restriction text is recorded verbatim, not paraphrased (§1)', () => {
  assert.ok(V1_SCORE_USAGE_RESTRICTIONS.includes('not eligible for campaign routing'));
  assert.ok(V1_SCORE_USAGE_RESTRICTIONS.includes('uncalibrated: weights origin=ordinal_default'));
  assert.equal(V1_SCORE_USAGE_RESTRICTIONS.length, 4);
});

test('the whole population is provisional — there is no calibrated subset', () => {
  assert.equal(V1_BUILD.provisional, true);
  assert.equal(V1_BUILD.score_version, 'v1.0.0-provisional');
  assert.equal(V1_BUILD.rows, 169790);
  // The feature layer is NOT provisional — that distinction carries the audit.
  assert.equal(V1_BUILD.feature_version, 'v1.0.0');
});

test('THE ROUTING ANSWER: gating columns are confidence, not weighted scores (§2)', () => {
  assert.deepEqual([...ELIGIBILITY_GATING_SCORE_COLUMNS].sort(),
    ['identity_confidence', 'overall_data_confidence', 'score_coverage']);
  for (const weighted of NON_ROUTING_SCORE_COLUMNS) {
    assert.ok(!ELIGIBILITY_GATING_SCORE_COLUMNS.includes(weighted),
      `${weighted} must not gate eligibility`);
  }
});

test('every gating column is feature-derived, so no weight touches the gate', () => {
  for (const col of ELIGIBILITY_GATING_SCORE_COLUMNS) {
    assert.ok(FEATURE_DERIVED_GATING_COLUMNS.includes(col), `${col} is copied from features`);
    const role = scoreColumnRoutingRole(col);
    assert.equal(role.gates_eligibility, true);
    assert.equal(role.weight_dependent, false);
  }
});

test('the uncalibrated scores gate nothing and order nothing (§17)', () => {
  for (const col of NON_ROUTING_SCORE_COLUMNS) {
    const role = scoreColumnRoutingRole(col);
    assert.equal(role.gates_eligibility, false);
    assert.equal(role.affects_ordering, false);
    assert.equal(role.weight_dependent, true);
  }
});

test('an unreferenced column is reported as unreferenced, not as safe', () => {
  const role = scoreColumnRoutingRole('motivation_score');
  assert.equal(role.gates_eligibility, false);
  assert.equal(role.weight_dependent, null, 'unknown is null, not false');
});

test('identity_confidence is an exact constant per status (§9)', () => {
  assert.equal(IDENTITY_CONFIDENCE_BY_STATUS.confirmed, 0.95);
  assert.equal(IDENTITY_CONFIDENCE_BY_STATUS.entity_owned, 0.90);
  assert.equal(IDENTITY_CONFIDENCE_BY_STATUS.high_confidence, 0.85);
  assert.equal(IDENTITY_CONFIDENCE_BY_STATUS.medium_confidence, 0.65);
  assert.equal(IDENTITY_CONFIDENCE_BY_STATUS.ambiguous, 0.35);
  assert.equal(IDENTITY_CONFIDENCE_BY_STATUS.conflicting_existing_assignment, 0.25);
  // NULL, not 0: no identity was established at all.
  assert.equal(IDENTITY_CONFIDENCE_BY_STATUS.unresolved, null);
});

test('the eligible statuses are exactly those clearing the confidence threshold, minus entities', () => {
  for (const status of ELIGIBLE_RESOLUTION_STATUSES) {
    assert.ok(IDENTITY_CONFIDENCE_BY_STATUS[status] >= ELIGIBILITY_THRESHOLDS.identity_confidence,
      `${status} clears ${ELIGIBILITY_THRESHOLDS.identity_confidence}`);
  }
  // entity_owned clears the threshold at 0.90 but is excluded by the status
  // allowlist — authority, not confidence, is what it lacks.
  assert.ok(IDENTITY_CONFIDENCE_BY_STATUS.entity_owned >= ELIGIBILITY_THRESHOLDS.identity_confidence);
  assert.ok(!ELIGIBLE_RESOLUTION_STATUSES.includes('entity_owned'));
  // The excluded low-confidence statuses genuinely fall below it.
  for (const status of ['ambiguous', 'conflicting_existing_assignment']) {
    assert.ok(IDENTITY_CONFIDENCE_BY_STATUS[status] < ELIGIBILITY_THRESHOLDS.identity_confidence);
  }
});

test('match methods map only to statuses actually observed (§10)', () => {
  assert.deepEqual(MATCH_METHODS.name_exact_vendor, ['confirmed']);
  assert.deepEqual(MATCH_METHODS.entity_flags, ['entity_owned']);
  const known = new Set(Object.keys(IDENTITY_CONFIDENCE_BY_STATUS));
  for (const [method, statuses] of Object.entries(MATCH_METHODS)) {
    for (const s of statuses) assert.ok(known.has(s), `${method} -> ${s} is a real status`);
  }
  // ambiguous/unresolved persist NULL rather than a method label.
  const labelled = new Set(Object.values(MATCH_METHODS).flat());
  assert.ok(!labelled.has('ambiguous') && !labelled.has('unresolved'));
});

test('THE COMPOSITION: priority = M^0.4 · E^0.4 · F^0.2, to measured precision (§12)', () => {
  assert.deepEqual(PRIORITY_PILLAR_EXPONENTS, { M: 0.4, E: 0.4, F: 0.2 });
  // Real persisted rows, pillars and score taken from production.
  const cases = [
    { M: 0.020313, E: 0.633413, F: 0.698873, expected: 0.163177 },
    { M: 0.020313, E: 0.685487, F: 0.514653, expected: 0.158419 },
    { M: 0.025000, E: 0.731565, F: 0.699196, expected: 0.187844 },
    { M: 0.034197, E: 0.670330, F: 0.644056, expected: 0.202253 },
    { M: 0.037614, E: 0.562676, F: 0.608834, expected: 0.193707 },
  ];
  for (const c of cases) {
    const got = composePriorityScore(c);
    assert.ok(Math.abs(got - c.expected) < 5e-5,
      `M=${c.M} -> ${got} vs persisted ${c.expected}`);
  }
});

test('the score is MULTIPLICATIVE — a zero pillar zeroes it', () => {
  // priority_score was 0 on exactly the rows where M was 0, and no others.
  assert.equal(composePriorityScore({ M: 0, E: 0.9, F: 0.9 }), 0);
  assert.equal(composePriorityScore({ M: 0.9, E: 0, F: 0.9 }), 0);
  assert.ok(composePriorityScore({ M: 0.5, E: 0.5, F: 0.5 }) > 0);
});

test('non-numeric or negative pillars yield null, never a score', () => {
  for (const bad of [{}, { M: 'x', E: 1, F: 1 }, { M: -1, E: 1, F: 1 }, { M: 1, E: 1 }]) {
    assert.equal(composePriorityScore(bad), null);
  }
});

test('reproducibility is classified per layer, with owner_hash named as the blocker (§14)', () => {
  assert.equal(V1_REPRODUCIBILITY.priority_composition, 'deterministic_recovered');
  assert.equal(V1_REPRODUCIBILITY.identity_confidence, 'deterministic_recovered');
  assert.equal(V1_REPRODUCIBILITY.owner_resolution_status, 'owner_hash_dependent');
  assert.equal(V1_REPRODUCIBILITY.best_contact, 'owner_hash_dependent');
  assert.equal(V1_REPRODUCIBILITY.component_and_pillar_weights, 'not_persisted_as_parameters');
});

test('the module performs no IO — no DB, no vendor, no writes (§20)', () => {
  const code = readFileSync(MODULE_PATH, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
    .toLowerCase();
  for (const forbidden of ['fetch(', 'require(', 'supabase', 'pg', 'http', 'insert into', 'update ', 'delete from']) {
    assert.ok(!code.includes(forbidden), `must not contain "${forbidden}"`);
  }
});
