/**
 * Acquisition Engine V3 — Item 5B §0: universe-specific sample integrity +
 * strategy-specific execution depth gates + dominant-model confidence caps.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { VALUATION_UNIVERSES as U } from '@/lib/acquisition/modelConstants.js';
import { normalizeCandidate } from '@/lib/acquisition/compIdentityEnrichment.js';
import { qualifyComps } from '@/lib/acquisition/transactionQualification.js';
import { buildV3Decision } from '@/lib/acquisition/v3DecisionPipeline.js';

const NOW = new Date('2026-06-21T12:00:00.000Z');
const Z = '75201';
const cand = (id, o = {}) => ({ comp_id: id, property_id: id, address: `${id} St`, zip: Z, city: 'Dallas', state: 'TX', latitude: 32.78, longitude: -96.79, sale_price: o.price ?? 0, sale_date: o.date ?? '2025-06-01', mls_sold_price: o.mls ?? null, asset_class: 'single_family', property_type: 'Single Family', units_count: 1, sqft: o.sqft ?? 1400, beds: 3, baths: 2, year_built: o.yr ?? 1990, building_condition: 'Average', construction_type: 'Frame', distance_miles: 1.5, similarity_score: 88 });
const raw = (id, o = {}) => ({ id, property_id: id, apn_parcel_id: `apn-${id}`, owner_name: o.owner ?? null, owner_1_name: o.owner ?? null, is_corporate_owner: o.corp ?? false, owner_address_full: '1 Mail', document_type: '', last_sale_doc_type: o.doc ?? 'Warranty Deed', recording_date: null, sale_price: o.price ?? 0, mls_sold_price: o.mls ?? null });
const e = (id, o) => normalizeCandidate(cand(id, o), raw(id, o), null);
const investor = (id, price, date) => e(id, { price, date, owner: `INV ${id} LLC`, corp: true });
const SFR = { property_id: 's', property_type: 'Single Family', property_address_zip: Z, building_square_feet: 1400, units_count: 1, estimated_value: 200000 };
const decide = (subject, comps) => buildV3Decision({ subjectRow: subject, qualification: qualifyComps(subject, comps), buyerPurchases: [], now: NOW }).v3;

test('§0 three thin SFR investor comps do NOT auto-pass (REVIEW, not SHADOW)', () => {
  const v3 = decide(SFR, [investor('a', 185000, '2025-03-01'), investor('b', 192000, '2025-06-01'), investor('c', 178000, '2025-09-01')]);
  assert.equal(v3.evidence_depth.wholesale_pricing_ess, 3);
  assert.equal(v3.strategy_depth_gate.cash.passed, false);
  assert.equal(v3.execution_state, 'REVIEW_REQUIRED');
  assert.equal(v3.offer_authorization.authorized_recommended_offer, null);
});

test('§0 four SFR investor comps meet the preferred wholesale gate (SHADOW)', () => {
  const v3 = decide(SFR, [investor('a', 185000, '2025-03-01'), investor('b', 192000, '2025-06-01'), investor('c', 178000, '2025-09-01'), investor('d', 188000, '2025-11-01')]);
  assert.ok(v3.evidence_depth.wholesale_pricing_ess >= 4);
  assert.equal(v3.strategy_depth_gate.cash.passed, true);
  assert.equal(v3.execution_state, 'SHADOW_MODE_READY');
});

test('§0 distressed/builder/flip/government do NOT increase investor/wholesale ESS', () => {
  const comps = [
    investor('i1', 185000, '2025-03-01'), investor('i2', 192000, '2025-06-01'), investor('i3', 178000, '2025-09-01'),
    e('fore', { price: 180000, owner: 'A LLC', corp: true, doc: 'Trustee’s Deed' }), // distressed
    e('build', { price: 360000, yr: 2025, date: '2026-02-01', owner: 'B LLC', corp: true }), // new construction
    e('flip', { price: 320000, owner: 'Macfarlane Renovations LLC', corp: true }), // flip
    e('gov', { price: 150000, owner: 'County Housing Authority', corp: true }), // government
  ];
  const v3 = decide(SFR, comps);
  // only the 3 ordinary investor comps count toward investor/wholesale depth
  assert.equal(v3.evidence_depth.investor_pricing_ess, 3);
  assert.equal(v3.evidence_depth.wholesale_pricing_ess, 3);
  // distressed/government excluded from pricing entirely; builder/flip route to retail
  assert.equal(comps.find((c) => c.id === 'fore').v3_pricing_eligible, false);
  assert.equal(comps.find((c) => c.id === 'gov').v3_pricing_eligible, false);
  assert.equal(v3.execution_state, 'REVIEW_REQUIRED'); // still only 3 wholesale
});

test('§0 dominant-model confidence is capped by dominant-universe depth (3 → ≤72)', () => {
  const v3 = decide(SFR, [investor('a', 185000, '2025-03-01'), investor('b', 192000, '2025-06-01'), investor('c', 178000, '2025-09-01')]);
  assert.equal(v3.dominant_model_ess, 3);
  assert.ok(v3.dominant_model_confidence_cap <= 72);
  assert.ok(v3.final_confidence <= 72, `final ${v3.final_confidence} must be capped by dominant depth`);
});

test('§0 high total candidate count cannot rescue thin dominant depth', () => {
  // 3 ordinary investor + many non-wholesale (builder/flip) records
  const comps = [
    investor('i1', 185000, '2025-03-01'), investor('i2', 192000, '2025-06-01'), investor('i3', 178000, '2025-09-01'),
    ...[1, 2, 3, 4, 5].map((n) => e(`b${n}`, { price: 350000 + n * 1000, yr: 2025, date: '2026-01-01', owner: `Builder ${n} LLC`, corp: true })),
  ];
  const v3 = decide(SFR, comps);
  assert.equal(v3.evidence_depth.wholesale_pricing_ess, 3, 'builder records add retail depth, not wholesale');
  assert.equal(v3.execution_state, 'REVIEW_REQUIRED');
});
