/**
 * Offerr Evaluation Spine — seller-safe projection leak tripwire.
 *
 * The projection is the ONLY payload that may eventually reach a seller.
 * These tests serialize real evaluations (through the live engine) and assert
 * the projection carries exactly the allowlisted keys and none of the
 * internal underwriting vocabulary (MAO math, assignment fees, buyer
 * identities, comp rows, execution states, private identifiers).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateOfferrProperty } from '@/lib/domain/offerr/offerr-evaluation-service.js';
import { createInMemoryOfferrEvaluationStore } from '@/lib/domain/offerr/offerr-evaluation-store.js';
import {
  buildOfferrSellerProjection,
  OFFERR_SELLER_PROJECTION_FORBIDDEN_TOKENS,
} from '@/lib/domain/offerr/offerr-seller-projection.js';
import { OFFERR_OUTCOMES } from '@/lib/domain/offerr/offerr-contracts.js';

const NOW = new Date('2026-06-20T12:00:00.000Z');

const HOUSTON_SFR = {
  property_id: '2130847744',
  property_address_full: '6310 Cambridge Glen Ln, Houston, TX 77035',
  property_address_zip: '77035',
  market: 'Houston, TX',
  property_type: 'SFR',
  property_class: 'Residential',
  building_square_feet: 1356,
  units_count: 1,
  estimated_value: 156000,
  latitude: 29.65086,
  longitude: -95.50109,
};

const HOUSTON_COMPS = [
  { property_id: 'h1', property_address_full: '6300 Cambridge Glen Ln, Houston, TX 77035', property_address_zip: '77035', property_type: 'Single Family', units_count: 1, building_square_feet: 1340, sale_price: 165000, sale_date: '2025-09-01', latitude: 29.6510, longitude: -95.5012 },
  { property_id: 'h2', property_address_full: '6412 Sharpview Dr, Houston, TX 77035', property_address_zip: '77035', property_type: 'Single Family', units_count: 1, building_square_feet: 1400, sale_price: 190000, sale_date: '2025-08-15', latitude: 29.6520, longitude: -95.5030 },
  { property_id: 'h3', property_address_full: '5810 Birdwood Rd, Houston, TX 77035', property_address_zip: '77035', property_type: 'Single Family', units_count: 1, building_square_feet: 1290, sale_price: 178000, sale_date: '2025-07-20', latitude: 29.6495, longitude: -95.4995 },
  { property_id: 'h4', property_address_full: '5102 Grape St, Houston, TX 77035', property_address_zip: '77035', property_type: 'Single Family', units_count: 1, building_square_feet: 1500, sale_price: 205000, sale_date: '2025-06-10', latitude: 29.6531, longitude: -95.5040 },
  { property_id: 'h5', property_address_full: '4710 Loch Lomond Dr, Houston, TX 77035', property_address_zip: '77035', property_type: 'Single Family', units_count: 1, building_square_feet: 1420, sale_price: 198000, sale_date: '2025-05-05', latitude: 29.6488, longitude: -95.4980 },
];

function makeDeps(overrides = {}) {
  let seq = 0;
  return {
    now: NOW,
    v3Enabled: true,
    store: createInMemoryOfferrEvaluationStore(),
    generateRequestId: () => `req-${++seq}`,
    generateEvaluationId: () => `eval-${seq}`,
    resolveSubjectProperty: async () => ({
      status: 'RESOLVED',
      property_id: HOUSTON_SFR.property_id,
      match: {
        property_id: HOUSTON_SFR.property_id,
        property_address_full: HOUSTON_SFR.property_address_full,
        city: 'Houston',
        state: 'TX',
        zip: '77035',
        property_type: 'SFR',
        market: 'Houston, TX',
      },
      candidate_count: 1,
      candidates: [],
      reason: 'single_exact_normalized_match',
      method: 'test_stub',
    }),
    loadSubjectProperty: async () => ({ ...HOUSTON_SFR }),
    loadComparableProperties: async () => HOUSTON_COMPS.map((c) => ({ ...c })),
    loadBuyerPurchases: async () => [],
    loadV3CompCandidates: async () => null,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    ...overrides,
  };
}

const EXPECTED_KEYS = [
  'evaluation_id',
  'spine_version',
  'outcome',
  'property',
  'preliminary_range',
  'confidence_label',
  'next_step',
  'assumptions',
  'data_conflicts',
  'binding',
  'preliminary',
  'disclaimer',
  'expires_at',
  'processing_ms',
].sort();

test('seller projection carries exactly the allowlisted keys and no internal vocabulary', async () => {
  const result = await evaluateOfferrProperty(
    {
      address: HOUSTON_SFR.property_address_full,
      idempotency_key: 'projection-key-001',
      seller_facts: { condition: 'good' },
    },
    makeDeps(),
  );
  assert.equal(result.ok, true);

  const projection = result.seller_projection;
  assert.deepEqual(Object.keys(projection).sort(), EXPECTED_KEYS);

  const serialized = JSON.stringify(projection);
  for (const token of OFFERR_SELLER_PROJECTION_FORBIDDEN_TOKENS) {
    assert.equal(
      serialized.includes(token),
      false,
      `seller projection must not contain "${token}"`,
    );
  }

  // Non-binding designation is explicit and machine-readable.
  assert.equal(projection.binding, false);
  assert.equal(projection.preliminary, true);
  assert.ok(projection.disclaimer.includes('not an offer'));
  assert.ok(projection.expires_at, 'expiration timestamp present');
  assert.ok(Number.isFinite(projection.processing_ms), 'processing duration present');

  // Property summary is address-level only — no private identifiers.
  assert.deepEqual(Object.keys(projection.property).sort(), [
    'address_line',
    'city',
    'property_type',
    'state',
    'zip',
  ]);
});

test('review outcomes project with a null range and the same safe shape', async () => {
  const result = await evaluateOfferrProperty(
    { address: HOUSTON_SFR.property_address_full, idempotency_key: 'projection-key-002' },
    makeDeps({ v3Enabled: false }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.outcome, OFFERR_OUTCOMES.REVIEW_REQUIRED);

  const projection = result.seller_projection;
  assert.deepEqual(Object.keys(projection).sort(), EXPECTED_KEYS);
  assert.equal(projection.preliminary_range, null);

  const serialized = JSON.stringify(projection);
  for (const token of OFFERR_SELLER_PROJECTION_FORBIDDEN_TOKENS) {
    assert.equal(serialized.includes(token), false, `must not contain "${token}"`);
  }
});

test('projection refuses malformed ranges instead of presenting them', () => {
  const reversed = buildOfferrSellerProjection({
    evaluationId: 'eval-x',
    outcome: OFFERR_OUTCOMES.INSTANT_RANGE_ELIGIBLE,
    preliminaryRange: { low: 200000, high: 100000 },
    confidenceLabel: 'HIGH',
    nextStep: 'schedule_walkthrough_verification',
    matchedProperty: null,
  });
  assert.equal(reversed.preliminary_range, null, 'reversed range never presented');

  const nonfinite = buildOfferrSellerProjection({
    evaluationId: 'eval-y',
    outcome: OFFERR_OUTCOMES.CONDITIONAL_RANGE,
    preliminaryRange: { low: Number.NaN, high: 100000 },
    confidenceLabel: 'MEDIUM',
    nextStep: 'verify_property_condition_details',
    matchedProperty: null,
  });
  assert.equal(nonfinite.preliminary_range, null, 'nonfinite range never presented');
});
