import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  inClause,
  requireNonEmptyPartition,
  scoreVintageScope,
} from '../pilot/secondPassScope.mjs';

test('second-pass SQL scope is safe for empty and quoted property ids', () => {
  assert.equal(
    inClause([]),
    'select null::text where false',
  );
  assert.equal(
    inClause(['prop_a', "prop_b'b"]),
    "'prop_a','prop_b''b'",
  );
});

test('second-pass refuses to certify an empty representative partition', () => {
  assert.throws(
    () => requireNonEmptyPartition([]),
    /representative partition is empty/,
  );
  assert.deepEqual(
    requireNonEmptyPartition(['prop_a']),
    ['prop_a'],
  );
});

test('second-pass score lookup is pinned to exact property, as-of and engine', () => {
  const current = scoreVintageScope({
    propertyId: 'prop_a',
    asOf: '2026-07-01T00:00:00Z',
    engineVersion: 'seller_v1.cfg.abc',
  });
  const prior = scoreVintageScope({
    propertyId: 'prop_a',
    asOf: '2026-06-01T00:00:00Z',
    engineVersion: 'seller_v1.cfg.abc',
  });
  const otherEngine = scoreVintageScope({
    propertyId: 'prop_a',
    asOf: '2026-07-01T00:00:00Z',
    engineVersion: 'seller_v1.cfg.xyz',
  });

  assert.notEqual(current.fsId, prior.fsId);
  assert.notEqual(current.fsId, otherEngine.fsId);

  assert.match(current.fsWhere, /fs\.id = 'fsnap_/);
  assert.match(current.fsWhere, /fs\.property_id = 'prop_a'/);
  assert.match(
    current.fsWhere,
    /fs\.as_of = '2026-07-01T00:00:00Z'::timestamptz/,
  );
  assert.match(
    current.fsWhere,
    /fs\.engine_version_id = 'seller_v1\.cfg\.abc'/,
  );

  assert.match(
    current.scoreWhere,
    /ss\.feature_snapshot_id = 'fsnap_/,
  );
  assert.match(
    current.scoreWhere,
    /ss\.engine_version_id = 'seller_v1\.cfg\.abc'/,
  );
});
