import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFeatures } from '../features/engine.mjs';
import { scoreDeterministicV1 } from '../scores/deterministicV1.mjs';
import { loadRegistry, IMPLEMENTED } from '../features/registry.mjs';

const AS_OF = '2026-07-01T00:00:00Z';
const bundle = {
  property: { id: 'p1', year_built: 1950, condition_raw: 'Fair', condition_state: 'known' },
  valuation: { estimated_value: 180000, equity_percent: 55, tax_delinquent: false },
  loans: [{ id: 'l1', slot_class: 'current_recorded', slot_ordinal: 1, estimated_balance: 80000, recording_date: '2016-01-01', blanket_loan_flag: false }],
  checksums: { num_of_mortgages: 1 },
  liens: [], foreclosure: [], transactions: [{ id: 't1', event_role: 'current', sale_date: '2012-01-01', sale_price: 90000, price_qualifier_class: 'valuation' }],
  links: [{ id: 'k1', link_tier: 'medium', matching_flags: ['Potential Owner'], renter_flag: false }],
  phones: [], emails: [], batchScalarLiveness: 0.0,
};

test('reproducible rescoring: identical bundle + as-of => byte-identical features and scores', () => {
  const a = computeFeatures(structuredClone(bundle), AS_OF);
  const b = computeFeatures(structuredClone(bundle), AS_OF);
  assert.deepEqual(a, b);
  const sa = scoreDeterministicV1(a.features);
  const sb = scoreDeterministicV1(b.features);
  assert.deepEqual(sa, sb);
});

test('registry: all 87 features reconcile — 84 implemented, 3 blocked with reasons', () => {
  const reg = loadRegistry();
  assert.equal(reg.length, 87);
  const ids = new Set(reg.map((r) => r.feature_id));
  for (const id of IMPLEMENTED) assert.ok(ids.has(id), `implemented ${id} must exist in dictionary`);
  const implemented = reg.filter((r) => r.implementation === 'implemented');
  const blocked = reg.filter((r) => r.implementation === 'blocked');
  assert.equal(implemented.length, 84);
  assert.equal(blocked.length, 3);
  assert.ok(blocked.every((r) => r.block_reason), 'every blocked feature carries an explicit reason');
  assert.equal(implemented.length + blocked.length, 87);
});
