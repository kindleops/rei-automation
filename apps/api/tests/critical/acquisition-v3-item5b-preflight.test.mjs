/**
 * Acquisition Engine V3 — Item 5B preflight integrity checks.
 *
 * 1. No economic transaction is double-counted across valuation-universe ESS.
 * 2. The thin-wholesale exception uses lane-appropriate, NON-OVERLAPPING
 *    corroboration rather than always requiring a public-record transaction.
 * 3. total-clean vs wholesale-pricing vs dominant-universe counts are kept as
 *    distinct, separately-named fields; `clean_*` is not silently redefined.
 * 4. The peer-outlier MIN_REL_DEV tight-cluster safeguard is preserved and is
 *    recorded as a future calibration item.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VALUATION_UNIVERSES as U,
  FUTURE_CALIBRATION_ITEMS,
  WHOLESALE_EXCEPTION,
} from '@/lib/acquisition/modelConstants.js';
import { normalizeCandidate } from '@/lib/acquisition/compIdentityEnrichment.js';
import { qualifyComps } from '@/lib/acquisition/transactionQualification.js';
import { buildV3Decision } from '@/lib/acquisition/v3DecisionPipeline.js';
import { classifyPeerOutliers, PEER_STATUS } from '@/lib/acquisition/peerRelativeOutliers.js';

const NOW = new Date('2026-06-21T12:00:00.000Z');
const Z = '75201';
const cand = (id, o = {}) => ({ comp_id: id, property_id: id, address: `${id} St`, zip: Z, city: 'Dallas', state: 'TX', latitude: 32.78, longitude: -96.79, sale_price: o.price ?? 0, sale_date: o.date ?? '2025-06-01', mls_sold_price: o.mls ?? null, asset_class: 'single_family', property_type: 'Single Family', units_count: 1, sqft: o.sqft ?? 1400, beds: 3, baths: 2, year_built: o.yr ?? 1990, building_condition: 'Average', construction_type: 'Frame', distance_miles: 1.5, similarity_score: 88 });
const raw = (id, o = {}) => ({ id, property_id: id, apn_parcel_id: `apn-${id}`, owner_name: o.owner ?? null, owner_1_name: o.owner ?? null, is_corporate_owner: o.corp ?? false, owner_address_full: '1 Mail', document_type: '', last_sale_doc_type: o.doc ?? 'Warranty Deed', recording_date: null, sale_price: o.price ?? 0, mls_sold_price: o.mls ?? null });
const e = (id, o) => normalizeCandidate(cand(id, o), raw(id, o), null);
const investor = (id, price, date) => e(id, { price, date, owner: `INV ${id} LLC`, corp: true });
const mls = (id, price, date) => e(id, { price, date, mls: price }); // retail/MLS resale
const SFR = { property_id: 's', property_type: 'Single Family', property_address_zip: Z, building_square_feet: 1400, units_count: 1, estimated_value: 200000 };
const decide = (subject, comps) => buildV3Decision({ subjectRow: subject, qualification: qualifyComps(subject, comps), buyerPurchases: [], now: NOW }).v3;

test('§1 no transaction is double-counted across valuation-universe ESS', () => {
  const comps = [
    investor('i1', 185000, '2025-03-01'), investor('i2', 192000, '2025-06-01'),
    mls('m1', 250000, '2025-04-01'), mls('m2', 248000, '2025-07-01'), mls('m3', 252000, '2025-08-01'),
  ];
  const v3 = decide(SFR, comps);
  const d = v3.evidence_depth;
  // Each universe ESS is independent; the wholesale pool is exactly the sum of
  // its three disjoint contributors and never exceeds total accepted depth.
  assert.equal(d.wholesale_pricing_ess, d.investor_pricing_ess + d.institutional_pricing_ess + d.public_pricing_ess);
  // Retail is NOT part of the wholesale pool (no overlap).
  assert.equal(d.investor_pricing_ess, 2);
  assert.equal(d.retail_pricing_ess, 3);
  assert.equal(d.wholesale_pricing_ess, 2);
  // Sum of every universe's accepted independent count cannot exceed the total
  // accepted transactions — i.e. no comp appears in two universes.
  const perUniverseTotal = Object.values(v3.universes)
    .filter((u) => u && u.available)
    .reduce((s, u) => s + (u.accepted_independent_transaction_count ?? 0), 0);
  assert.ok(perUniverseTotal <= v3.total_clean_accepted_transaction_count + 1e-9,
    `per-universe sum ${perUniverseTotal} must not exceed total accepted ${v3.total_clean_accepted_transaction_count}`);
});

test('§2 thin wholesale set: all-investor with NO independent corroboration does NOT pass exception', () => {
  // 3 investor comps, no public/retail/income corroborator → exception fails.
  const v3 = decide(SFR, [investor('a', 185000, '2025-03-01'), investor('b', 192000, '2025-06-01'), investor('c', 178000, '2025-09-01')]);
  assert.equal(v3.evidence_depth.wholesale_pricing_ess, 3);
  assert.equal(v3.strategy_depth_gate.cash.exception_met, false);
  assert.deepEqual(v3.strategy_depth_gate.cash.exception_corroboration, []);
  assert.equal(v3.execution_state, 'REVIEW_REQUIRED');
});

test('§2 thin wholesale set corroborated by an INDEPENDENT qualified income value passes (no public txn required)', () => {
  // Small-multi (income lane) with a verified NOI+cap → QUALIFIED income value,
  // plus exactly 3 investor wholesale comps and ZERO public-record comps.
  const DUPLEX = { property_id: 'd', property_type: 'Duplex', property_address_zip: Z, building_square_feet: 2400, units_count: 2, estimated_value: 300000, noi_estimate: 24000, cap_rate: 0.07 };
  const dcand = (id, price, date) => ({ comp_id: id, property_id: id, address: `${id} St`, zip: Z, city: 'Dallas', state: 'TX', latitude: 32.78, longitude: -96.79, sale_price: price, sale_date: date, asset_class: 'duplex', property_type: 'Duplex', units_count: 2, sqft: 2400, beds: 4, baths: 2, year_built: 1990, building_condition: 'Average', construction_type: 'Frame', distance_miles: 1.0, similarity_score: 92 });
  const dinv = (id, price, date) => normalizeCandidate(dcand(id, price, date), raw(id, { owner: `INV ${id} LLC`, corp: true, price }), null);
  const v3 = decide(DUPLEX, [dinv('a', 295000, '2025-03-01'), dinv('b', 305000, '2025-06-01'), dinv('c', 300000, '2025-09-01')]);
  assert.equal(v3.evidence_depth.public_pricing_ess, 0, 'no public-record corroboration available');
  assert.equal(v3.evidence_depth.wholesale_pricing_ess, 3);
  assert.ok(
    v3.strategy_depth_gate.cash.exception_corroboration.includes('independent_income_value'),
    `expected income corroboration, got ${JSON.stringify(v3.strategy_depth_gate.cash.exception_corroboration)}`,
  );
});

test('§2 exception never counts the same transaction as both primary and corroboration', () => {
  // Single contributor = investor. Corroboration must exclude the investor pool.
  const v3 = decide(SFR, [investor('a', 185000, '2025-03-01'), investor('b', 192000, '2025-06-01'), investor('c', 178000, '2025-09-01')]);
  const corr = v3.strategy_depth_gate.cash.exception_corroboration;
  assert.ok(!corr.includes('qualified_local_investor'), 'investor (the sole primary) cannot corroborate itself');
});

test('§3 total-clean, wholesale-pricing and dominant-universe counts are distinct fields', () => {
  // 3 investor (wholesale) + many MLS (retail/dominant-by-depth) so the three
  // semantics take DIFFERENT values.
  const comps = [
    investor('i1', 185000, '2025-03-01'), investor('i2', 192000, '2025-06-01'), investor('i3', 178000, '2025-09-01'),
    mls('m1', 250000, '2025-04-01'), mls('m2', 248000, '2025-07-01'), mls('m3', 252000, '2025-08-01'), mls('m4', 249000, '2025-05-01'),
  ];
  const v3 = decide(SFR, comps);
  assert.equal(v3.total_clean_accepted_transaction_count, 7, 'all 7 clean accepted');
  assert.equal(v3.wholesale_pricing_ess, 3, 'wholesale pool = 3 investor only');
  assert.equal(v3.wholesale_pricing_independent_count, 3);
  assert.equal(v3.dominant_universe_ess, 4, 'dominant universe = the 4 retail comps');
  assert.equal(v3.dominant_universe_independent_count, 4);
  // `clean_*` keeps its established wholesale meaning (not redefined to total).
  assert.equal(v3.clean_independent_transaction_count, v3.wholesale_pricing_ess);
  assert.equal(v3.clean_effective_sample_size, v3.wholesale_pricing_ess);
  // The three semantics are genuinely different numbers here.
  assert.notEqual(v3.total_clean_accepted_transaction_count, v3.wholesale_pricing_ess);
  assert.notEqual(v3.wholesale_pricing_ess, v3.dominant_universe_ess);
});

test('§4 MIN_REL_DEV tight-cluster safeguard preserved: a value within ±20% is not flagged', () => {
  // A tight cluster around 100 with one member at 118 (+18%, inside ±20%).
  // MAD/IQR fences would be razor-thin; the safeguard prevents a false outlier.
  const items = [98, 100, 101, 99, 118].map((v, i) => ({ key: String(i), value: v }));
  const out = classifyPeerOutliers(items);
  const judged = out.get('4');
  assert.notEqual(judged.status, PEER_STATUS.PEER_HIGH_OUTLIER,
    'value within ±20% of a tight cluster must not be flagged as a high outlier');
});

test('§4 MIN_REL_DEV is recorded as a deferred future calibration item', () => {
  const item = FUTURE_CALIBRATION_ITEMS.find((i) => i.id === 'PEER_OUTLIER_MIN_REL_DEV');
  assert.ok(item, 'MIN_REL_DEV must be registered as a future calibration item');
  assert.equal(item.current_value, 0.2);
  assert.equal(item.status, 'DEFERRED');
});

test('§2 exception config no longer hard-requires public corroboration', () => {
  assert.equal(WHOLESALE_EXCEPTION.min_independent_corroboration, 1);
});
