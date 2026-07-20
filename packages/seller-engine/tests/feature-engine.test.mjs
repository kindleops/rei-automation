import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFeatures } from '../features/engine.mjs';
import { LeakageError } from '../lib/timeSafety.mjs';

const AS_OF = '2026-07-01T00:00:00Z';

const bundle = (over = {}) => ({
  property: { id: 'p1', year_built: 1950, condition_raw: 'Poor', condition_state: 'known' },
  valuation: { estimated_value: 200000, equity_percent: 70, tax_delinquent: true, tax_delinquent_year: 2023 },
  loans: [{ id: 'l1', slot_class: 'current_recorded', slot_ordinal: 1, estimated_balance: 60000, recording_date: '2015-03-01', loan_type_raw: 'New Conventional', blanket_loan_flag: false }],
  checksums: { num_of_mortgages: 1 },
  liens: [], foreclosure: [], transactions: [{ id: 't1', event_role: 'current', sale_date: '2010-06-15', sale_price: 80000, price_qualifier_class: 'valuation' }],
  links: [{ id: 'k1', link_tier: 'high', matching_type: 'mailing_address', matching_flags: ['Likely Owner'], likely_owner_scalar: true, renter_flag: false }],
  phones: [{ phone_e164: '+15555550100', line_type: 'wireless', rank: 1, do_not_call: false, never_call: false }],
  emails: [], batchScalarLiveness: 0.21,
  ...over,
});

test('every feature result carries the 9 required fields', () => {
  const { features } = computeFeatures(bundle(), AS_OF);
  for (const f of features) {
    for (const k of ['feature_id', 'value', 'value_state', 'confidence', 'source_evidence',
      'as_of', 'formula_version', 'missing_dependencies', 'explanation_fragment']) {
      assert.ok(k in f, `${f.feature_id} missing ${k}`);
    }
  }
});

test('T-10 leakage: future-dated input throws LeakageError', () => {
  assert.throws(
    () => computeFeatures(bundle({ transactions: [{ id: 't2', event_role: 'current', sale_date: '2026-08-01' }] }), AS_OF),
    LeakageError,
  );
});

test('inputs_max_observed_at proves as-of safety', () => {
  const { inputs_max_observed_at } = computeFeatures(bundle(), AS_OF);
  assert.ok(Date.parse(inputs_max_observed_at) <= Date.parse(AS_OF));
});

test('T-05: blanket loan withholds LTV instead of emitting a poisoned ratio', () => {
  const { features } = computeFeatures(bundle({
    loans: [{ id: 'l9', slot_class: 'current_recorded', slot_ordinal: 1, estimated_balance: 200_000_000, recording_date: '2015-03-01', blanket_loan_flag: true }],
  }), AS_OF);
  const ltv = features.find((f) => f.feature_id === 'F-006');
  assert.equal(ltv.value, null);
  assert.match(ltv.explanation_fragment, /blanket/i);
});

test('blocked market features stay blocked without a comp snapshot (P2-2)', () => {
  const { features } = computeFeatures(bundle(), AS_OF);
  for (const id of ['F-056', 'F-057', 'F-058', 'F-060']) {
    const f = features.find((x) => x.feature_id === id);
    assert.equal(f.value_state, 'blocked', id);
    assert.ok(f.missing_dependencies.length > 0);
  }
});

test('OD-13: scalar corroboration only reads in live batches', () => {
  const live = computeFeatures(bundle(), AS_OF).features.find((f) => f.feature_id === 'F-111');
  assert.equal(live.value, true);
  const dead = computeFeatures(bundle({ batchScalarLiveness: 0.0001 }), AS_OF)
    .features.find((f) => f.feature_id === 'F-111');
  assert.equal(dead.value_state, 'not_applicable');
});

test('F-101 aggregate conflict surfaces disagreement (OD-12)', () => {
  const { features } = computeFeatures(bundle({ checksums: { num_of_mortgages: 3 } }), AS_OF);
  const f = features.find((x) => x.feature_id === 'F-101');
  assert.equal(f.value.disagree, true);
});

test('T-06: non-valuation basis excluded from appreciation math', () => {
  const { features } = computeFeatures(bundle({
    transactions: [{ id: 't3', event_role: 'current', sale_date: '2010-06-15', sale_price: 100, price_qualifier_class: 'distress_context' }],
  }), AS_OF);
  const f = features.find((x) => x.feature_id === 'F-133');
  assert.equal(f.value, null);
  assert.equal(f.value_state, 'not_applicable');
});
