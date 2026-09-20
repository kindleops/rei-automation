import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REHYDRATION_REASON,
  REHYDRATION_VERDICT,
  evaluateRehydration,
  buildRehydrationAudit,
  buildRehydrationUpdateSql,
  summariseRehydrationPlan,
} from '../../src/lib/domain/seller-intelligence/owner-hash-rehydration.js';

const HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);
const MANIFEST = new Set(['2125622433', '2125625736']);

const dbRow = (over = {}) => ({ property_id: '2125622433', owner_hash: null, ...over });
const vendor = (over = {}) => ({
  requested_property_id: '2125622433',
  returned_property_id: '2125622433',
  owner_hash: HASH,
  ...over,
});

test('a clean cohort row with a matching vendor answer is writable', () => {
  const v = evaluateRehydration(dbRow(), vendor(), MANIFEST);
  assert.equal(v.verdict, REHYDRATION_VERDICT.WRITE);
  assert.equal(v.owner_hash, HASH);
});

test('THE BLAST RADIUS: a property outside the manifest is refused', () => {
  // The 169,790 processed rows must be untouchable even if a query widens.
  const v = evaluateRehydration(dbRow({ property_id: '999999999' }), vendor({
    requested_property_id: '999999999', returned_property_id: '999999999',
  }), MANIFEST);
  assert.equal(v.verdict, REHYDRATION_VERDICT.SKIP_NOT_IN_MANIFEST);
  assert.equal(v.owner_hash, null);
});

test('an existing owner_hash is NEVER overwritten', () => {
  const v = evaluateRehydration(dbRow({ owner_hash: OTHER_HASH }), vendor(), MANIFEST);
  assert.equal(v.verdict, REHYDRATION_VERDICT.SKIP_ALREADY_SET);
});

test('a blank-but-present owner_hash still counts as set', () => {
  const v = evaluateRehydration(dbRow({ owner_hash: '   ' }), vendor(), MANIFEST);
  // Whitespace is not a canonical key, so this falls through to the normal
  // path rather than being treated as an existing value to protect.
  assert.equal(v.verdict, REHYDRATION_VERDICT.WRITE);
});

test('IDENTITY: a response about a different property is refused', () => {
  const v = evaluateRehydration(dbRow(), vendor({ returned_property_id: '2125625736' }), MANIFEST);
  assert.equal(v.verdict, REHYDRATION_VERDICT.SKIP_IDENTITY_MISMATCH);
  assert.equal(v.owner_hash, null);
});

test('a response with no property id at all is refused', () => {
  const v = evaluateRehydration(dbRow(), vendor({ returned_property_id: '' }), MANIFEST);
  assert.equal(v.verdict, REHYDRATION_VERDICT.SKIP_IDENTITY_MISMATCH);
});

test('a vendor row carrying no owner_hash is refused, not filled', () => {
  for (const empty of [null, undefined, '', '   ']) {
    const v = evaluateRehydration(dbRow(), vendor({ owner_hash: empty }), MANIFEST);
    assert.equal(v.verdict, REHYDRATION_VERDICT.SKIP_NO_HASH);
  }
});

test('a malformed hash is refused rather than stored', () => {
  for (const bad of ['not-a-hash', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
    const v = evaluateRehydration(dbRow(), vendor({ owner_hash: bad }), MANIFEST);
    assert.equal(v.verdict, REHYDRATION_VERDICT.SKIP_MALFORMED, `rejects ${bad.slice(0, 12)}`);
  }
});

test('the audit record tells the truth about where the value came from', () => {
  const v = evaluateRehydration(dbRow(), vendor(), MANIFEST);
  const audit = buildRehydrationAudit(v, {
    run_id: 'run-1', recovered_at: '2026-09-20T13:26:00Z',
  });
  assert.equal(audit.reason, REHYDRATION_REASON);
  assert.equal(audit.reason, 'file10_identity_rehydration', 'never claims it came from the contact export');
  assert.equal(audit.old_owner_hash, null, 'emptiness is recorded, not omitted');
  assert.equal(audit.new_owner_hash, HASH);
  assert.equal(audit.recovery_run_id, 'run-1');
  assert.ok(audit.vendor_source.includes('parcel-card'));
  assert.ok(audit.producer_path.includes('scraper2.py'));
});

test('no audit record is produced for a refusal', () => {
  const v = evaluateRehydration(dbRow({ owner_hash: OTHER_HASH }), vendor(), MANIFEST);
  assert.equal(buildRehydrationAudit(v, {}), null);
});

test('the UPDATE touches one column and re-checks the null itself', () => {
  const sql = buildRehydrationUpdateSql();
  assert.ok(sql.includes('set owner_hash = $2'));
  assert.ok(sql.includes('and owner_hash is null'), 'the race is settled in the database');
  assert.ok(sql.includes('where property_id = $1'));
  // Nothing else may be written: no resolution, features, scores, or public tables.
  for (const forbidden of ['property_owner_resolution_v1', 'property_features_v1',
    'property_scores_v1', 'property_best_contact_v1', 'public.properties', 'campaign_target_graph']) {
    assert.ok(!sql.includes(forbidden), `must not touch ${forbidden}`);
  }
});

test('the plan summary never reports having written anything', () => {
  const plan = summariseRehydrationPlan([
    { verdict: REHYDRATION_VERDICT.WRITE },
    { verdict: REHYDRATION_VERDICT.WRITE },
    { verdict: REHYDRATION_VERDICT.SKIP_ALREADY_SET },
    { verdict: REHYDRATION_VERDICT.SKIP_IDENTITY_MISMATCH },
  ]);
  assert.equal(plan.total, 4);
  assert.equal(plan.eligible_to_write, 2);
  assert.equal(plan.writes_executed, 0);
  assert.deepEqual(plan.refusals, {
    [REHYDRATION_VERDICT.SKIP_ALREADY_SET]: 1,
    [REHYDRATION_VERDICT.SKIP_IDENTITY_MISMATCH]: 1,
  });
});

test('every refusal reason is distinct — no hidden "other" bucket (§8)', () => {
  const values = Object.values(REHYDRATION_VERDICT);
  assert.equal(new Set(values).size, values.length);
  assert.ok(!values.some((v) => /other|unknown|misc/i.test(v)));
});
