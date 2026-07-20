import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SELLER_ENGINE_VAR ??= mkdtempSync(join(tmpdir(), 'se-shadow-'));
const { eligibleFeatureIds, validateHistoricalFeatureRow, buildVintagePair, VintageLeakageError } = await import('../backtest/vintageProtocol.mjs');
const { createShadowCohort } = await import('../shadow/createShadowCohort.mjs');
const { loadCohort, verifyCohortIntegrity, evaluateShadowCohort } = await import('../shadow/evaluateShadowCohort.mjs');
const { computeFeatures } = await import('../features/engine.mjs');

test('eligibility registry: document-dated features eligible; current-state prohibited', () => {
  const strict = eligibleFeatureIds();
  assert.ok(strict.has('F-001'));   // tenure from dated transaction
  assert.ok(strict.has('F-013'));   // lien docs
  assert.ok(!strict.has('F-007'));  // equity = current-state
  assert.ok(!strict.has('F-110'));  // matching tokens = current-state
  assert.ok(!strict.has('F-029'));  // vendor repair baseline = prohibited
  const withEv = eligibleFeatureIds({ withEventHistory: true });
  assert.ok(withEv.has('F-018'));   // foreclosure stage with event history
  assert.ok(!withEv.has('F-022'));  // vacancy stays current-state
});

test('historical backtest REJECTS rows where current-state features leak into an earlier vintage', () => {
  const features = [
    { feature_id: 'F-001', value_state: 'known', value: 10, source_evidence: [{ kind: 'transaction', date: '2019-01-01' }] },
    { feature_id: 'F-007', value_state: 'known', value: 62, source_evidence: [] },  // current-state equity
  ];
  assert.throws(() => validateHistoricalFeatureRow(features, '2024-01-01T00:00:00Z'),
    (e) => e instanceof VintageLeakageError && e.rejected.some((r) => r.feature_id === 'F-007' && r.reason === 'not_historically_eligible'));
});

test('historical backtest rejects post-as-of evidence even on eligible features', () => {
  const features = [
    { feature_id: 'F-013', value_state: 'known', value: { open_episodes: 1 }, source_evidence: [{ kind: 'lien_episode', date: '2025-06-01' }] },
  ];
  assert.throws(() => validateHistoricalFeatureRow(features, '2024-01-01T00:00:00Z'), VintageLeakageError);
  // and accepts when dated before as-of
  const r = validateHistoricalFeatureRow(features, '2025-12-01T00:00:00Z');
  assert.ok(r.accepted >= 1);
});

test('vintage pairs must be strictly ordered', () => {
  const a = { id: 'b1', scraped_at_min: '2026-07-12T00:00:00Z', scraped_at_max: '2026-07-12T12:00:00Z' };
  const b = { id: 'b2', scraped_at_min: '2026-10-14T00:00:00Z', scraped_at_max: '2026-10-15T00:00:00Z' };
  const pair = buildVintagePair({ scoreBatch: a, labelBatch: b });
  assert.ok(pair.horizon_days_available >= 90);
  assert.throws(() => buildVintagePair({ scoreBatch: b, labelBatch: a }), VintageLeakageError);
});

const mkBundle = (id) => ({
  property: { id, year_built: 1950, condition_raw: 'Fair', condition_state: 'known' },
  valuation: { estimated_value: 150000 + (id.length * 1000), equity_percent: 60, tax_delinquent: id.endsWith('1') },
  loans: [], checksums: null, liens: [], foreclosure: [],
  transactions: [{ id: `t${id}`, event_role: 'current', sale_date: '2010-01-01', sale_price: 70000, price_qualifier_class: 'valuation' }],
  links: [{ id: `k${id}`, link_tier: 'medium', matching_flags: ['Potential Owner'], renter_flag: false }],
  phones: [], emails: [], batchScalarLiveness: 0,
});

test('shadow cohort: frozen, hash-verified, reproducible; evaluation grades post-as-of outcomes only', () => {
  const asOf = '2026-07-01T00:00:00Z';
  const bundles = ['pa1', 'pb2', 'pc3'].map(mkBundle);
  const { manifest } = createShadowCohort({ bundles, asOf, cohortName: 'test_cohort' });
  const loaded = loadCohort('test_cohort');
  assert.equal(loaded.records.length, 3);
  const integrity = verifyCohortIntegrity(loaded);
  assert.equal(integrity.intact, true);
  // tamper detection
  const tampered = structuredClone(loaded);
  tampered.records[0].deterministic_v1_score = 999;
  assert.equal(verifyCohortIntegrity(tampered).intact, false);
  // frozen record carries all mandated freezes
  const r = loaded.records[0];
  for (const k of ['canonical_input_hash', 'feature_snapshot', 'score_families',
    'deterministic_v1_score', 'v12_score', 'explanations', 'versions', 'scoring_timestamp']) {
    assert.ok(k in r, k);
  }
  // evaluation: outcome before as-of never grades; after does
  const outcomes = [
    { family: 'verified_sale', property_id: 'pa1', event_ts: '2026-06-01T00:00:00Z' },  // before as-of -> ignored
    { family: 'verified_sale', property_id: 'pb2', event_ts: '2026-08-15T00:00:00Z' },  // within 90d
  ];
  const ev = evaluateShadowCohort(loaded, outcomes, { observedThrough: '2026-11-01T00:00:00Z' });
  assert.equal(ev.state, 'ok');
  assert.equal(ev.report.horizons['90d'].positives, 1);
  assert.ok(ev.report.horizons['365d'].censored >= 1); // window not fully observed
});
