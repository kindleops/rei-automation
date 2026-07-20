import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSnapshot, snapshotForAsOf } from '../comp/snapshotAdapter.mjs';
import { computeFeatures } from '../features/engine.mjs';

const SNAP = {
  id: 'mfs_test1', subject_property_id: 'p1', as_of: '2026-06-01T00:00:00Z',
  asset_class: 'single_family', cohort_rung: 3, cohort_key: 'IL|17031|sfr', cohort_n: 41,
  selected_comp_ids: ['c1', 'c2'], comp_eligibility: { c1: 'arm_length<0.5mi<180d' },
  comp_exclusions: { c9: 'non_arms_length' }, weighted_comp_score: 0.8,
  valuation_low: 180000, valuation_high: 220000, valuation_confidence: 0.7,
  sale_velocity: 62, inventory_absorption: 55, buyer_velocity: 40, buyer_demand_confidence: 0.6,
  warnings: [], source_engine: 'comp_intelligence_v4@fixture',
};

test('P2-2 interface validation: all 20 fields required; bad ranges rejected', () => {
  assert.equal(validateSnapshot(SNAP).valid, true);
  const { id, ...rest } = SNAP;
  assert.equal(validateSnapshot(rest).valid, false);
  assert.equal(validateSnapshot({ ...SNAP, valuation_low: 999999, valuation_high: 1 }).valid, false);
});

test('immutability + time safety: only snapshots at-or-before as-of are eligible', () => {
  const later = { ...SNAP, id: 'mfs2', as_of: '2026-08-01T00:00:00Z' };
  const pick = snapshotForAsOf([SNAP, later], 'p1', '2026-07-01T00:00:00Z');
  assert.equal(pick.id, 'mfs_test1');
  assert.equal(snapshotForAsOf([later], 'p1', '2026-07-01T00:00:00Z'), null);
});

test('engine consumes snapshot: F-056 known with snapshot, blocked without', () => {
  const bundle = { property: { id: 'p1' }, valuation: {}, loans: [], liens: [], foreclosure: [], transactions: [], links: [], phones: [], emails: [] };
  const withSnap = computeFeatures(bundle, '2026-07-01T00:00:00Z', { compSnapshot: SNAP });
  assert.equal(withSnap.features.find((f) => f.feature_id === 'F-056').value_state, 'known');
  const without = computeFeatures(bundle, '2026-07-01T00:00:00Z');
  assert.equal(without.features.find((f) => f.feature_id === 'F-056').value_state, 'blocked');
});

// ---------------- interface v2 (Phase 4) ----------------
import { produceSnapshot } from '../comp/snapshotProducer.mjs';

const mkCand = (id, price, cond, days = 60, sqft = 1500) => ({
  comp_id: id, sale_price: price, sale_date: new Date(Date.parse('2026-06-01T00:00:00Z') - days * 86400000).toISOString().slice(0, 10),
  distance_miles: 1, building_square_feet: sqft, year_built: 1980,
  asset_class: 'single_family', document_type: 'Warranty Deed', price_qualifier_raw: null, condition_raw: cond,
});
const V2_SUBJECT = { property_id: 'p1', asset_class: 'single_family', building_square_feet: 1500, year_built: 1978, condition_raw: 'Poor', situs_state: 'TN', estimated_value: 150000, estimated_repair_cost: 40000 };
const V2_CANDS = [
  mkCand('g1', 240000, 'Good'), mkCand('g2', 250000, 'Very Good'), mkCand('g3', 245000, 'Good'),
  mkCand('b1', 150000, 'Poor'), mkCand('b2', 140000, 'Fair'), mkCand('b3', 155000, 'Unsound'),
];

test('v2: renovated spread measured from condition split; percentiles + repair burden emitted', () => {
  const doc = produceSnapshot({ subject: V2_SUBJECT, candidates: V2_CANDS, asOf: '2026-06-01T00:00:00Z' });
  assert.equal(doc.snapshot_interface_version, 2);
  assert.ok(doc.renovated_spread.spread_abs_for_subject > 50000, 'spread measured from good-vs-poor medians');
  assert.equal(doc.renovated_spread.good_n, 3);
  assert.ok(doc.cohort_value_percentiles.p50 > 0);
  assert.ok(doc.subject_value_percentile >= 0 && doc.subject_value_percentile <= 1);
  assert.equal(doc.repair_burden.repair_to_value, 0.27);
  assert.ok(doc.rent_context === null && doc.warnings.some((w) => /rent_context_unavailable/.test(w)),
    'rent never invented');
  assert.equal(validateSnapshot(doc).valid, true);
});

test('v2: spread withheld without a measurable condition split (never invented)', () => {
  const doc = produceSnapshot({ subject: V2_SUBJECT, candidates: V2_CANDS.slice(0, 3).concat(V2_CANDS[3]), asOf: '2026-06-01T00:00:00Z' });
  assert.equal(doc.renovated_spread, null);
  assert.ok(doc.warnings.some((w) => /renovated_spread_unavailable/.test(w)));
});

test('v2: engine unblocks F-052/F-130/F-132 from measured data; repair_burden family scores', async () => {
  const doc = produceSnapshot({ subject: V2_SUBJECT, candidates: V2_CANDS, asOf: '2026-06-01T00:00:00Z' });
  const bundle = { property: { id: 'p1', condition_raw: 'Poor', condition_state: 'known', raw_keep: { estimated_repair_cost: '40000' } },
    valuation: { estimated_value: 150000 }, loans: [], liens: [], foreclosure: [], transactions: [], links: [], phones: [], emails: [] };
  const { features } = computeFeatures(bundle, '2026-07-01T00:00:00Z', { compSnapshot: doc });
  const f = (id) => features.find((x) => x.feature_id === id);
  assert.equal(f('F-052').value_state, 'known');
  assert.ok(f('F-052').value.headroom > 0, 'Poor subject in measured-spread market has headroom');
  assert.equal(f('F-130').value_state, 'known');
  assert.equal(f('F-132').value_state, 'known');
  const { computeFamilies } = await import('../scores/families.mjs');
  const fam = computeFamilies(features);
  assert.equal(fam.repair_burden.score_state, 'scored');
  assert.ok(fam.repair_burden.score > 0, 'heavy repair-to-value scores capex load');
  assert.ok(fam.discount_potential.components.some((c) => /rehab_headroom/.test(c.component)));
});
