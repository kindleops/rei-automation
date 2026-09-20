import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROPAGATION_STAGE_KEYS,
  PROPAGATION_STATE,
  classifyPropertyPropagation,
  missingStages,
  inapplicableStages,
  selectCatchUpWork,
  buildPropagationReport,
  buildCatchUpSql,
} from '../../src/lib/domain/seller-intelligence/propagation-status.js';

/** A fully propagated property with canonical inputs present. */
const complete = (over = {}) => ({
  property_id: 'p-complete',
  owner_hash: 'hash-1',
  owner_name: 'Jane Doe',
  linked_owner_count: 3,
  owner_resolution_status: 'confirmed',
  has_owner_resolution: true,
  has_best_contact: true,
  has_features: true,
  has_scores: true,
  ...over,
});

/** The 6,808 in miniature: real property, real owner name, NO owner_hash. */
const cohortRow = (over = {}) => ({
  property_id: 'p-cohort',
  owner_hash: null,
  owner_name: 'Edward R Johnson',
  linked_owner_count: 0,
  owner_resolution_status: null,
  has_owner_resolution: false,
  has_best_contact: false,
  has_features: false,
  has_scores: false,
  first_observed_at: '2026-08-31T08:05:57Z',
  ...over,
});

test('stage order is the dependency order the persisted schema implies', () => {
  assert.deepEqual(PROPAGATION_STAGE_KEYS, ['owner_resolution', 'best_contact', 'features', 'scores']);
});

test('a fully projected property is complete and contributes no work', () => {
  const verdict = classifyPropertyPropagation(complete());
  assert.equal(verdict.state, PROPAGATION_STATE.COMPLETE);
  assert.deepEqual(verdict.missing_stages, []);
  assert.equal(verdict.next_stage, null);
});

test('missing stages come back in dependency order, not discovery order', () => {
  const row = complete({ has_scores: false, has_best_contact: false });
  assert.deepEqual(missingStages(row), ['best_contact', 'scores']);
  assert.equal(classifyPropertyPropagation(row).next_stage, 'best_contact');
});

test('THE PHANTOM BACKLOG: entity_owned is not owed a best contact', () => {
  // 48,135 entity_owned + 5,358 unresolved properties carry no best-contact row
  // BY DESIGN. Counting them as outstanding invented a 72,119-property backlog
  // that no runner could ever drain.
  const entity = complete({ owner_resolution_status: 'entity_owned', has_best_contact: false });
  assert.deepEqual(missingStages(entity), []);
  assert.deepEqual(inapplicableStages(entity), ['best_contact']);
  assert.equal(classifyPropertyPropagation(entity).state, PROPAGATION_STATE.COMPLETE);
});

test('a confirmed owner IS owed a best contact', () => {
  const confirmed = complete({ owner_resolution_status: 'confirmed', has_best_contact: false });
  assert.deepEqual(missingStages(confirmed), ['best_contact']);
});

test('applicability is undetermined until owner resolution has run', () => {
  const unresolvedYet = cohortRow();
  // best_contact must not be counted either way while its input is unknown
  assert.deepEqual(missingStages(unresolvedYet), ['owner_resolution', 'features', 'scores']);
  assert.deepEqual(inapplicableStages(unresolvedYet), []);
});

test('an incomplete property WITH canonical inputs is ready for a runner', () => {
  const verdict = classifyPropertyPropagation(complete({ has_features: false, has_scores: false }));
  assert.equal(verdict.state, PROPAGATION_STATE.READY);
  assert.deepEqual(verdict.missing_stages, ['features', 'scores']);
});

test('THE COHORT DEFECT: no owner_hash and no linked owner is BLOCKED, never ready', () => {
  const verdict = classifyPropertyPropagation(cohortRow());
  assert.equal(verdict.state, PROPAGATION_STATE.BLOCKED_NO_OWNER_LINK);
  assert.equal(verdict.blocked_reason, 'no_owner_hash_and_no_linked_owner');
  // The distinction is the whole point: a runner that treated this as ready
  // would resolve an owner it cannot actually identify.
  assert.notEqual(verdict.state, PROPAGATION_STATE.READY);
});

test('a linked owner rescues a property that has no owner_hash of its own', () => {
  const verdict = classifyPropertyPropagation(cohortRow({ linked_owner_count: 2 }));
  assert.equal(verdict.state, PROPAGATION_STATE.READY);
});

test('a property with no owner of record is blocked on its own terms', () => {
  const verdict = classifyPropertyPropagation(
    cohortRow({ owner_hash: 'h', linked_owner_count: 1, owner_name: null }),
  );
  assert.equal(verdict.state, PROPAGATION_STATE.BLOCKED_NO_OWNER_OF_RECORD);
});

test('catch-up finds OLD failed rows, not just new ones (§23)', () => {
  // The high-water-mark failure mode, stated as a test: the ancient row is the
  // one a `created_at > cursor` catch-up loses forever.
  const ancient = complete({
    property_id: 'p-ancient',
    has_scores: false,
    first_observed_at: '2024-01-01T00:00:00Z',
  });
  const fresh = complete({ property_id: 'p-fresh', has_scores: false, first_observed_at: '2026-09-20T00:00:00Z' });
  const work = selectCatchUpWork([ancient, fresh, complete()]);
  assert.deepEqual(work.ready.map((r) => r.property_id).sort(), ['p-ancient', 'p-fresh']);
  assert.equal(work.complete, 1);
});

test('catch-up is blind to import batch — no File-10 special casing (§22)', () => {
  const fromFile10 = complete({ property_id: 'a', import_batch_id: null, has_features: false });
  const fromRegistered = complete({ property_id: 'b', import_batch_id: 'batch-7', has_features: false });
  const work = selectCatchUpWork([fromFile10, fromRegistered]);
  assert.equal(work.ready.length, 2, 'both are selected on projection state alone');
});

test('blocked rows are excluded from the work set but surfaced with a reason', () => {
  const work = selectCatchUpWork([cohortRow(), complete()]);
  assert.deepEqual(work.ready, []);
  assert.deepEqual(work.blocked, [{ property_id: 'p-cohort', reason: 'no_owner_hash_and_no_linked_owner' }]);
});

test('the report counts real rows per stage and blends nothing into a health score', () => {
  const report = buildPropagationReport([
    complete(),
    complete({ property_id: 'x', has_scores: false }),
    complete({ property_id: 'e', owner_resolution_status: 'entity_owned', has_best_contact: false }),
    cohortRow(),
  ]);
  assert.equal(report.total_seller_properties, 4);
  assert.equal(report.awaiting.owner_resolution, 1); // the cohort row only
  assert.equal(report.awaiting.scores, 2); // the cohort row + 'x'
  assert.equal(report.awaiting.best_contact, 0, 'entity_owned is not owed one');
  assert.equal(report.not_owed.best_contact, 1);
  assert.equal(report.campaign_eligibility_available, 2); // complete() and 'e'
  assert.equal(report.by_state[PROPAGATION_STATE.BLOCKED_NO_OWNER_LINK], 1);
  assert.equal(report.blocked_reasons.no_owner_hash_and_no_linked_owner, 1);
  assert.equal(report.oldest_pending_first_observed_at, '2026-08-31T08:05:57Z');
  assert.ok(!('health_score' in report), 'no fabricated health score');
});

test('the report groups by county/state without inventing buckets', () => {
  const report = buildPropagationReport(
    [complete({ state: 'TX' }), cohortRow({ state: 'TX' }), complete({ state: 'GA', has_scores: false })],
    { groupBy: 'state' },
  );
  assert.deepEqual(report.groups, [
    { key: 'TX', total: 2, complete: 1, ready: 0, blocked: 1 },
    { key: 'GA', total: 1, complete: 0, ready: 1, blocked: 0 },
  ]);
});

test('the catch-up SQL gates on missing projections, never on a timestamp cursor', () => {
  const sql = buildCatchUpSql({ limit: 500 });
  for (const table of [
    'seller.property_owner_resolution_v1',
    'seller.property_best_contact_v1',
    'seller.property_features_v1',
    'seller.property_scores_v1',
  ]) {
    assert.ok(sql.includes(`exists (select 1 from ${table}`), `probes ${table}`);
  }
  assert.ok(!/first_observed_at\s*>/.test(sql), 'no high-water-mark predicate');
  assert.ok(!/import_batch_id\s*=/.test(sql), 'no import-batch special casing');
  assert.ok(sql.includes('limit 500'), 'bounded batch');
  assert.ok(sql.includes('owner_resolution_status'), 'carries the applicability input');
});

test('the canary properties cannot enter this report at all', () => {
  // The 7 INTERNAL_CANARY rows live only in public.properties; the catch-up
  // query reads seller.property, so they are structurally out of scope (§25).
  const sql = buildCatchUpSql({});
  assert.ok(sql.includes('from seller.property p'));
  assert.ok(!sql.includes('public.properties'), 'never reads the public universe');
});
