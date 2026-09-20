import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NAME_EXACT_ROW_CONTRACT,
  COLUMN_SOURCES,
  GOLDEN_PARITY,
  WRITABLE_TABLES,
  FORBIDDEN_TABLES,
  BACKFILL_RESULT,
  buildResolutionRow,
  mayWriteRow,
} from '../../src/lib/domain/seller-intelligence/owner-resolution-row-contract.js';

const entry = (over = {}) => ({
  property_id: '2125622433',
  individual_key: '150439402196',
  matched_full_name: 'John A Smith',
  deed_owner_name: 'JOHN A SMITH',
  candidate_count: 9,
  co_owner_individual_key: null,
  ...over,
});
const prov = { as_of_date: '2026-08-31', built_at: '2026-09-20T00:00:00Z', source_manifest_sha256: 'abc' };

const okState = (over = {}) => ({
  in_manifest: true,
  existing_resolution_row: false,
  is_entity: false,
  qualifying_candidate_count: 1,
  resolved_individual_key: '150439402196',
  name_still_matches: true,
  vendor_branch_now_applies: false,
  ...over,
});

test('the branch constants are the ones measured in production', () => {
  assert.equal(NAME_EXACT_ROW_CONTRACT.owner_resolution_status, 'high_confidence');
  assert.equal(NAME_EXACT_ROW_CONTRACT.match_method, 'name_exact');
  assert.equal(NAME_EXACT_ROW_CONTRACT.identity_confidence, 0.85);
  assert.equal(NAME_EXACT_ROW_CONTRACT.owner_role, 'primary_legal_owner');
  assert.equal(NAME_EXACT_ROW_CONTRACT.resolution_version, 'v1.0.0');
});

test('a File-10 row has no operational counterpart, so both operational columns are NULL', () => {
  const row = buildResolutionRow(entry(), null, prov);
  assert.equal(row.master_owner_id, null);
  assert.equal(row.operational_owner_name, null);
  assert.equal(row.conflict_status, 'no_operational_assignment');
});

test('an operational counterpart flips conflict_status to consistent', () => {
  // The 1:1 relationship measured across all 945 golden rows.
  const row = buildResolutionRow(entry(), { master_owner_id: 'MO-1', owner_name: 'JOHN SMITH' }, prov);
  assert.equal(row.master_owner_id, 'MO-1');
  assert.equal(row.operational_owner_name, 'JOHN SMITH');
  assert.equal(row.conflict_status, 'consistent');
});

test('reason codes track the co-owner exactly', () => {
  assert.deepEqual(buildResolutionRow(entry(), null, prov).reason_codes, ['OWNRES_NAME_EXACT']);
  const withCo = buildResolutionRow(entry({ co_owner_individual_key: 'CO-1' }), null, prov);
  assert.deepEqual(withCo.reason_codes, ['OWNRES_NAME_EXACT', 'OWNRES_CO_OWNER_MATCHED']);
  assert.equal(withCo.co_owner_individual_key, 'CO-1');
});

test('PROVENANCE IS TRUTHFUL — no historical fingerprint is reused', () => {
  const row = buildResolutionRow(entry(), null, prov);
  assert.equal(row.source_manifest_sha256, 'abc');
  // The historical producer's manifest must never be stamped on a new row.
  assert.notEqual(row.source_manifest_sha256,
    'e44887d04ac35d2e196bea4c3c6a48de7dc9a7f7175ffef7be1d08685d55b3fd');
  assert.equal(row.as_of_date, '2026-08-31', 'File-10 observation date, not 2026-07-18');
  assert.notEqual(row.as_of_date, '2026-07-18');
});

test('sub_owner_id is always null on this branch', () => {
  assert.equal(buildResolutionRow(entry(), null, prov).sub_owner_id, null);
});

test('candidate_count counts sentinels too — the producer counted what it looked at', () => {
  assert.match(COLUMN_SOURCES.candidate_count, /sentinels included/);
  assert.equal(buildResolutionRow(entry({ candidate_count: 9 }), null, prov).candidate_count, 9);
});

test('golden parity is recorded, including the number that authorised the write', () => {
  assert.equal(GOLDEN_PARITY.rows, 945);
  assert.equal(GOLDEN_PARITY.silent_wrong_individual_key, 0);
  assert.ok(GOLDEN_PARITY.fields_at_full_parity.includes('individual_key'));
  assert.ok(GOLDEN_PARITY.fields_at_full_parity.includes('operational_owner_name'));
});

test('WRITE GUARDS: every refusal path is distinct and fails closed', () => {
  assert.equal(mayWriteRow(entry(), okState()).allowed, true);
  const cases = [
    ['not_in_manifest', { in_manifest: false }],
    ['already_resolved', { existing_resolution_row: true }],
    ['entity_gate', { is_entity: true }],
    ['not_exactly_one_candidate', { qualifying_candidate_count: 2 }],
    ['not_exactly_one_candidate', { qualifying_candidate_count: 0 }],
    ['candidate_drift', { resolved_individual_key: 'SOMEONE-ELSE' }],
    ['name_drift', { name_still_matches: false }],
    ['vendor_branch_precedence', { vendor_branch_now_applies: true }],
  ];
  for (const [refusal, patch] of cases) {
    const v = mayWriteRow(entry(), okState(patch));
    assert.equal(v.allowed, false, `${refusal} must refuse`);
    assert.equal(v.refusal, refusal);
  }
});

test('the manifest is the blast radius — nothing is discovered at run time', () => {
  // Even a perfectly valid-looking row outside the manifest is refused.
  const v = mayWriteRow(entry(), okState({ in_manifest: false }));
  assert.equal(v.allowed, false);
  assert.equal(v.refusal, 'not_in_manifest');
});

test('exactly one table is writable, and the rest are named as forbidden', () => {
  assert.deepEqual(WRITABLE_TABLES, ['seller.property_owner_resolution_v1']);
  for (const t of ['seller.property_best_contact_v1', 'seller.property_features_v1',
    'seller.property_scores_v1', 'public.properties', 'public.campaign_target_graph', 'seller.property']) {
    assert.ok(FORBIDDEN_TABLES.includes(t), `${t} is forbidden this pass`);
    assert.ok(!WRITABLE_TABLES.includes(t));
  }
});

test('the backfill result reconciles arithmetically', () => {
  const r = BACKFILL_RESULT;
  assert.equal(r.total_before + r.inserted, r.total_after);
  assert.equal(r.inserted, r.manifest_rows);
  assert.equal(r.refused, 0);
  assert.equal(r.rerun_inserted, 0, 'idempotent');
  assert.equal(r.duplicates, 0);
  assert.match(r.manifest_sha256, /^[0-9a-f]{64}$/);
});
