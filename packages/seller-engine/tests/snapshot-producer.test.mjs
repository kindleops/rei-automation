import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adaptLoaderResult } from '../comp/acquisitionEngineAdapter.mjs';
import { produceSnapshot } from '../comp/snapshotProducer.mjs';
import { validateSnapshot, snapshotForAsOf } from '../comp/snapshotAdapter.mjs';
import { computeFeatures } from '../features/engine.mjs';

const FIX = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'comp_candidates_fixture.json'), 'utf8'));
const AS_OF = '2026-07-01T00:00:00Z';

function make() {
  const { candidates } = adaptLoaderResult(FIX.loaderResult);
  return produceSnapshot({ subject: FIX.subject, candidates, asOf: AS_OF, buyerStats: FIX.buyerStats });
}

test('producer emits a valid interface-conformant snapshot from V3-adapter candidates', () => {
  const snap = make();
  const v = validateSnapshot(snap);
  assert.equal(v.valid, true, v.errors.join('; '));
  assert.equal(snap.subject_property_id, 'prop_fixture_1');
  assert.ok(snap.selected_comp_ids.length >= 5);
  assert.ok(snap.valuation_low < snap.valuation_high);
  assert.ok(snap.valuation_confidence > 0.2);
  assert.match(snap.source_engine, /snapshotProducer@p4-v2 over acq-v3/);
});

test('every exclusion carries an explicit reason; time-safety and reliability enforced', () => {
  const snap = make();
  assert.match(snap.comp_exclusions.c4, /price_reliability:distress_context/); // non-arms-length
  assert.match(snap.comp_exclusions.c5, /post_as_of_sale/);                    // Aug sale vs Jul as-of
  assert.match(snap.comp_exclusions.c6, /stale/);                              // 2022 sale
  assert.match(snap.comp_exclusions.c7, /distance/);                           // 6.5mi > 4mi residential
  for (const id of snap.selected_comp_ids) {
    assert.ok(snap.comp_eligibility[id].weight > 0);
    assert.ok(['valuation', 'valuation_caution'].includes(snap.comp_eligibility[id].price_reliability));
  }
});

test('determinism: same inputs => identical snapshot id and content', () => {
  const a = make(); const b = make();
  assert.equal(a.id, b.id);
  assert.deepEqual(a, b);
});

test('produced snapshot unblocks the snapshot-gated features end-to-end', () => {
  const snap = make();
  const bundle = {
    property: { id: 'prop_fixture_1', year_built: 1950 },
    valuation: { estimated_value: 205000, equity_percent: 55, estimated_equity: 110000 },
    loans: [{ id: 'l1', slot_class: 'current_recorded', slot_ordinal: 1, estimated_balance: 90000, recording_date: '2018-01-01', blanket_loan_flag: false }],
    liens: [], foreclosure: [], transactions: [], links: [{ id: 'k', link_tier: 'high', matching_flags: [], renter_flag: false }],
    phones: [], emails: [],
  };
  const picked = snapshotForAsOf([snap], 'prop_fixture_1', AS_OF);
  assert.ok(picked);
  const { features } = computeFeatures(bundle, AS_OF, { compSnapshot: picked });
  const f = (id) => features.find((x) => x.feature_id === id);
  assert.equal(f('F-056').value_state, 'known');            // sale velocity
  assert.equal(f('F-058').value_state, 'known');            // buyer velocity (fixture stats)
  assert.equal(f('F-060').value_state, 'known');            // guarded spread
  assert.equal(f('F-061').value_state, 'known');            // deal size band
  assert.equal(f('F-057').value_state, 'unknown');          // snapshot present but inventory feed absent -> unknown, not invented
  assert.ok(f('F-060').value > 0);
});

test('insufficient comps degrade honestly: warnings + national rung + no invented valuation', () => {
  const { candidates } = adaptLoaderResult({ candidates: FIX.loaderResult.candidates.slice(0, 2) });
  const snap = produceSnapshot({ subject: FIX.subject, candidates, asOf: AS_OF });
  assert.ok(snap.warnings.some((w) => /insufficient_eligible_comps/.test(w)));
  assert.equal(snap.valuation_low, null);
  assert.equal(snap.cohort_rung, 7);
});
