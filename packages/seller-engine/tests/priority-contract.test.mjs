import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priorityScore0100, cohortPercentile, formalizePriority, buildCohortBuckets,
  DISPLAY_SCALE_K, COHORT_MIN_N } from '../scores/priorityContract.mjs';

test('bounds: score_0_100 stays within [0,100) for all raw', () => {
  for (const raw of [0, 1, 37, 112, 500, 100000, -5]) {
    const s = priorityScore0100(raw);
    assert.ok(s >= 0 && s < 100, `raw ${raw} -> ${s}`);
  }
  assert.equal(priorityScore0100(0), 0);
});

test('monotonicity: transform is strictly increasing in raw', () => {
  let prev = -1;
  for (let raw = 0; raw <= 300; raw += 1) {
    const s = priorityScore0100(raw);
    assert.ok(s >= prev, `non-monotonic at raw=${raw}`);
    prev = s;
  }
});

test('order preservation: no two distinct raw values reverse after transform', () => {
  const raws = [0, 3, 7, 12, 19, 37, 48, 61, 80, 99, 112, 140, 200];
  for (let i = 0; i < raws.length; i += 1) {
    for (let j = i + 1; j < raws.length; j += 1) {
      const a = priorityScore0100(raws[i]); const b = priorityScore0100(raws[j]);
      assert.ok(a <= b, `${raws[i]}->${a} should be <= ${raws[j]}->${b}`);
      if (raws[i] !== raws[j]) assert.ok(a < b || (a === b), 'ties allowed, reversals not');
    }
  }
});

test('reproducibility: identical inputs give identical outputs', () => {
  assert.equal(priorityScore0100(37), priorityScore0100(37));
  const buckets = buildCohortBuckets(Array.from({ length: 40 }, (_, i) => ({ asset_class: 'single_family', situs_state: 'TN', raw: i })));
  const a = formalizePriority(20, { asset_class: 'single_family', situs_state: 'TN' }, buckets);
  const b = formalizePriority(20, { asset_class: 'single_family', situs_state: 'TN' }, buckets);
  assert.deepEqual(a, b);
});

test('percentile is cohort-aware and rank-correct', () => {
  const vals = Array.from({ length: 100 }, (_, i) => i); // 0..99
  assert.equal(cohortPercentile(49, vals), 0.5);   // 50 values <= 49
  assert.equal(cohortPercentile(99, vals), 1.0);
  assert.equal(cohortPercentile(-1, vals), 0.0);
});

test('cohort fallback ladder: specific -> asset -> whole batch -> null', () => {
  // asset_class_x_state has <30 (insufficient); asset_class has >=30
  const rows = [];
  for (let i = 0; i < 40; i += 1) rows.push({ asset_class: 'single_family', situs_state: i < 10 ? 'TN' : 'GA', raw: i });
  const buckets = buildCohortBuckets(rows);
  const r = formalizePriority(20, { asset_class: 'single_family', situs_state: 'TN' }, buckets);
  assert.equal(r.percentile_basis, 'asset_class', 'TN has only 10 -> falls back to asset_class');
  assert.equal(r.cohort_n, 40);

  // no cohort data at all -> null percentile, explicit basis
  const none = formalizePriority(20, { asset_class: 'x', situs_state: 'y' }, buildCohortBuckets([]));
  assert.equal(none.execution_priority_percentile, null);
  assert.equal(none.percentile_basis, 'insufficient_data');
});

test('contract preserves raw exactly and declares routing representation', () => {
  const r = formalizePriority(87, { asset_class: 'single_family', situs_state: 'TN' }, null);
  assert.equal(r.execution_priority_raw, 87);
  assert.equal(r.routing_consumes, 'execution_priority_raw');
  assert.equal(r.contract_version, 'priority-contract-v1');
});

test('no routing change: contract does not alter the engine route field', async () => {
  const { computeFeatures } = await import('../features/engine.mjs');
  const { scoreDeterministicV1 } = await import('../scores/deterministicV1.mjs');
  const bundle = {
    property: { id: 'p1', condition_raw: 'Poor', condition_state: 'known', raw_keep: {} },
    valuation: { estimated_value: 200000, equity_percent: 40, tax_delinquent: true, tax_delinquent_year: 2022 },
    loans: [], liens: [], foreclosure: [], transactions: [{ id: 't', event_role: 'current', sale_date: '2010-01-01', sale_price: 90000, price_qualifier_class: 'valuation' }],
    links: [{ id: 'k', link_tier: 'high', matching_flags: ['Likely Owner'], renter_flag: false }],
    phones: [{ phone_e164: '+15555550100', line_type: 'wireless', do_not_call: false, never_call: false }], emails: [], batchScalarLiveness: 0.2,
  };
  const scored = scoreDeterministicV1(computeFeatures(bundle, '2026-07-01T00:00:00Z').features);
  const raw = scored.execution_priority;
  const contract = formalizePriority(raw, { asset_class: 'single_family', situs_state: 'TN' }, null);
  // applying the contract leaves the engine's raw score and route untouched
  assert.equal(contract.execution_priority_raw, raw);
  assert.equal(scored.route, scored.families.execution_priority.route);
});
