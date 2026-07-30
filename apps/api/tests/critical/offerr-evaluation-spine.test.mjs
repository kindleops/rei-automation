/**
 * Offerr Evaluation Spine — orchestrator safety proof.
 *
 * Exercises evaluateOfferrProperty through the LIVE canonical acquisition
 * engine (calculateAcquisitionDecision with V3 anomaly defense) using the
 * historical audit fixtures from docs/backend/acquisition_engine_v3_audit.md:
 *   - Houston SFR control (clean comps)      -> eligible, deterministic
 *   - Austin duplex 5314 Atascosa Dr         -> $332.5M broadcast comp
 *   - Caldwell 1711 N Illinois Ave           -> 12-row package transaction
 *
 * Proves the mission Phase 6 invariants: unresolved/ambiguous/unsupported and
 * contaminated evidence fail closed with NO seller range; seller facts stay a
 * non-mutating overlay; nonfinite/negative/reversed engine output is a hard
 * failure; idempotency replays deterministically; and the spine performs no
 * queue/message/contract/title side effects.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateOfferrProperty, detectOverlayConflicts } from '@/lib/domain/offerr/offerr-evaluation-service.js';
import { createInMemoryOfferrEvaluationStore } from '@/lib/domain/offerr/offerr-evaluation-store.js';
import { resolveOfferrSubjectProperty } from '@/lib/domain/offerr/offerr-property-resolution.js';
import { applyOfferrSafetyGates } from '@/lib/domain/offerr/offerr-safety-gates.js';
import {
  OFFERR_OUTCOMES,
  OFFERR_RESOLUTION_STATUSES,
} from '@/lib/domain/offerr/offerr-contracts.js';

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

const AUSTIN_DUPLEX = {
  property_id: '2136762817',
  property_address_full: '5314 Atascosa Dr, Austin, TX 78744',
  property_address_zip: '78744',
  market: 'Austin, TX',
  property_type: 'Multifamily 2-4',
  property_class: 'Residential',
  building_square_feet: 1776,
  units_count: 2,
  estimated_value: 391000,
};

const AUSTIN_COMPS = [
  { property_id: '2136437952', property_address_full: '2000 E Stassney Ln, Austin, TX 78744', property_address_zip: '78744', property_type: 'Multi-Family', units_count: 2, building_square_feet: 1728, sale_price: 332500000, sale_date: '2025-04-09' },
  { property_id: '2135840413', property_address_full: '7457 Beckwood Dr, Fort Worth, TX 76112', property_address_zip: '76112', property_type: 'Single Family', units_count: 1, building_square_feet: 1357, sale_price: 332500000, sale_date: '2025-04-09' },
  { property_id: '2130879947', property_address_full: '22202 Meadowgate Dr, Spring, TX 77373', property_address_zip: '77373', property_type: 'Single Family', units_count: 1, building_square_feet: 1546, sale_price: 332500000, sale_date: '2025-04-09' },
  { property_id: '2130712449', property_address_full: '7214 Foxbend Ln, Humble, TX 77338', property_address_zip: '77338', property_type: 'Single Family', units_count: 1, building_square_feet: 1591, sale_price: 332500000, sale_date: '2025-04-09' },
];

const CALDWELL_SFR = {
  property_id: '242567952',
  property_address_full: '1711 N Illinois Ave, Caldwell, ID 83605',
  property_address_zip: '83605',
  market: 'Boise, ID',
  property_type: 'SFR',
  property_class: 'Residential',
  building_square_feet: 1550,
  units_count: 1,
  estimated_value: 309000,
};

const CALDWELL_COMPS = Array.from({ length: 12 }, (_, i) => ({
  property_id: `cald-${i}`,
  property_address_full: `${100 + i} Package Ave, Caldwell, ID 83605`,
  property_address_zip: '83605',
  property_type: 'Single Family',
  units_count: 1,
  building_square_feet: 1500 + i * 10,
  sale_price: 30191000,
  sale_date: '2024-06-21',
}));

function resolvedFor(subject) {
  return async () => ({
    status: OFFERR_RESOLUTION_STATUSES.RESOLVED,
    property_id: subject.property_id,
    match: {
      property_id: subject.property_id,
      property_address_full: subject.property_address_full,
      city: null,
      state: null,
      zip: subject.property_address_zip,
      property_type: subject.property_type,
      market: subject.market,
    },
    candidate_count: 1,
    candidates: [],
    reason: 'single_exact_normalized_match',
    method: 'test_stub',
  });
}

function makeDeps({ subject, comps, overrides = {} } = {}) {
  let seq = 0;
  const calls = { comps: 0, buyers: 0, v3: 0 };
  const deps = {
    now: NOW,
    v3Enabled: true,
    store: createInMemoryOfferrEvaluationStore(),
    generateRequestId: () => `req-${++seq}`,
    generateEvaluationId: () => `eval-${seq}`,
    resolveSubjectProperty: subject ? resolvedFor(subject) : undefined,
    loadSubjectProperty: async () => (subject ? { ...subject } : null),
    loadComparableProperties: async () => {
      calls.comps += 1;
      return (comps ?? []).map((c) => ({ ...c }));
    },
    loadBuyerPurchases: async () => {
      calls.buyers += 1;
      return [];
    },
    loadV3CompCandidates: async () => {
      calls.v3 += 1;
      return null;
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    _calls: calls,
    ...overrides,
  };
  return deps;
}

function intakeFor(subject, key, extra = {}) {
  return {
    address: subject?.property_address_full ?? '123 Nowhere Ln, Nowhere, TX 00000',
    idempotency_key: key,
    ...extra,
  };
}

// ── 1. Known valid residential property: deterministic eligible result ─────

test('clean Houston SFR resolves to a deterministic INSTANT_RANGE_ELIGIBLE result', async () => {
  const runOnce = async (key) => {
    const deps = makeDeps({ subject: HOUSTON_SFR, comps: HOUSTON_COMPS });
    return evaluateOfferrProperty(intakeFor(HOUSTON_SFR, key), deps);
  };

  const a = await runOnce('houston-key-000001');
  const b = await runOnce('houston-key-000002');

  assert.equal(a.ok, true);
  assert.equal(a.outcome, OFFERR_OUTCOMES.INSTANT_RANGE_ELIGIBLE);
  const range = a.seller_projection.preliminary_range;
  assert.ok(range && range.low > 0 && range.high >= range.low, 'range present and ordered');

  const v3 = a.internal_result.decision.v3;
  assert.equal(v3.execution_state, 'SHADOW_MODE_READY');
  assert.ok(range.high <= v3.offer_authorization.authorized_maximum_offer, 'high <= authorized maximum');
  assert.ok(range.high <= v3.buyer_exit.conservative_buyer_exit, 'high <= conservative buyer exit');
  assert.ok(range.high <= v3.value_contract.qualified_market_value.high, 'high <= qualified valuation anchor');

  // Autonomy flags remain OFF — this is a preliminary range, never an auto offer.
  assert.equal(v3.active_feature_flags.ACQUISITION_ENGINE_V3_ALLOW_AUTO_OFFER, false);
  assert.equal(a.internal_result.decision.v3.shadow_mode, true);

  // Deterministic across independent runs with the same inputs.
  assert.deepEqual(a.seller_projection.preliminary_range, b.seller_projection.preliminary_range);
  assert.equal(a.outcome, b.outcome);
  assert.equal(a.internal_result.confidence_label, b.internal_result.confidence_label);
  assert.equal(
    a.internal_result.provenance.comp_set_hash,
    b.internal_result.provenance.comp_set_hash,
    'comp evidence hash is stable',
  );
});

// ── 2. Unknown address fails closed ─────────────────────────────────────────

test('unknown address fails closed: no range, confirm-address next step, no comp loads', async () => {
  const deps = makeDeps({
    subject: null,
    comps: HOUSTON_COMPS,
    overrides: {
      resolveSubjectProperty: async () => ({
        status: OFFERR_RESOLUTION_STATUSES.NOT_FOUND,
        property_id: null,
        match: null,
        candidate_count: 0,
        candidates: [],
        reason: 'no_candidates_found',
        method: 'test_stub',
      }),
    },
  });
  const result = await evaluateOfferrProperty(intakeFor(null, 'unknown-addr-0001'), deps);

  assert.equal(result.ok, true);
  assert.equal(result.outcome, OFFERR_OUTCOMES.REVIEW_REQUIRED);
  assert.equal(result.seller_projection.preliminary_range, null);
  assert.equal(result.seller_projection.next_step, 'confirm_property_address');
  assert.equal(deps._calls.comps, 0, 'comp loader never invoked for unresolved property');
});

// ── 3. Ambiguous resolution fails closed (through the real resolver) ───────

test('ambiguous address (two exact matches) fails closed with no range', async () => {
  const twin = (id) => ({
    property_id: id,
    property_address_full: '6310 Cambridge Glen Ln, Houston, TX 77035',
    property_address_city: 'Houston',
    property_address_state: 'TX',
    property_address_zip: '77035',
    property_type: 'SFR',
    market: 'Houston, TX',
  });
  const deps = makeDeps({
    subject: HOUSTON_SFR,
    comps: HOUSTON_COMPS,
    overrides: {
      resolveSubjectProperty: undefined, // use the real deterministic resolver
      loadCandidates: async () => [twin('p-1'), twin('p-2')],
    },
  });
  const result = await evaluateOfferrProperty(intakeFor(HOUSTON_SFR, 'ambiguous-0000001'), deps);

  assert.equal(result.ok, true);
  assert.equal(result.outcome, OFFERR_OUTCOMES.REVIEW_REQUIRED);
  assert.equal(result.seller_projection.preliminary_range, null);
  assert.equal(result.seller_projection.next_step, 'confirm_property_identity');
  assert.equal(result.internal_result.resolution.status, OFFERR_RESOLUTION_STATUSES.AMBIGUOUS);
});

test('deterministic resolver: exact / partial / none', async () => {
  const row = {
    property_id: 'p-100',
    property_address_full: '6310 Cambridge Glen Ln, Houston, TX 77035',
    property_address_zip: '77035',
    property_type: 'SFR',
  };

  const exact = await resolveOfferrSubjectProperty(
    { normalizedAddress: '6310 cambridge glen ln houston tx 77035' },
    { loadCandidates: async () => [row] },
  );
  assert.equal(exact.status, OFFERR_RESOLUTION_STATUSES.RESOLVED);
  assert.equal(exact.property_id, 'p-100');

  const partialOnly = await resolveOfferrSubjectProperty(
    { normalizedAddress: '6310 cambridge glen ln houston tx 77035' },
    { loadCandidates: async () => [{ ...row, property_address_full: '6310 Cambridge Glen Ln Unit B, Houston, TX 77035' }] },
  );
  assert.equal(partialOnly.status, OFFERR_RESOLUTION_STATUSES.AMBIGUOUS, 'partial matches never auto-resolve');

  const none = await resolveOfferrSubjectProperty(
    { normalizedAddress: '999 missing st nowhere tx 00000' },
    { loadCandidates: async () => [] },
  );
  assert.equal(none.status, OFFERR_RESOLUTION_STATUSES.NOT_FOUND);
});

// ── 4. Unsupported asset lane fails closed ──────────────────────────────────

test('unsupported asset lane returns UNSUPPORTED with no automatic range', async () => {
  const deps = makeDeps({
    subject: HOUSTON_SFR,
    comps: HOUSTON_COMPS,
    overrides: {
      classifyAssetLane: () => ({ lane: 'RETAIL_STRIP_CENTER', confidence: 92, reasoning: ['test'] }),
    },
  });
  const result = await evaluateOfferrProperty(intakeFor(HOUSTON_SFR, 'unsupported-00001'), deps);

  assert.equal(result.ok, true);
  assert.equal(result.outcome, OFFERR_OUTCOMES.UNSUPPORTED);
  assert.equal(result.seller_projection.preliminary_range, null);
  assert.equal(result.seller_projection.next_step, 'not_serviceable_manual_follow_up');
  assert.ok(result.internal_result.reason_codes.some((r) => r.startsWith('unsupported_asset_family:')));
});

// classifyAssetLane falls back to `inferred_from_unit_count(n)` at confidence
// 55 and returns SFR for unit counts of 0/1 when it recognises no type keyword.
// A commercial record whose property_type string it does not know therefore
// arrives as lane=SFR / family=RESIDENTIAL_SINGLE. Offerr must refuse it rather
// than underwrite a commercial building as a house.
test('commercial record misclassified as SFR is refused via the non-residential signal', async () => {
  const COMMERCIAL = {
    ...HOUSTON_SFR,
    property_id: 'commercial-0001',
    property_type: 'Commercial Retail',
    property_class: 'Commercial',
    building_square_feet: 12000,
    units_count: 0,
  };
  // The REAL classifier is used here on purpose: this test's value is that it
  // reproduces the real misclassification rather than stubbing it.
  const result = await evaluateOfferrProperty(
    intakeFor(COMMERCIAL, 'commercial-misclass-1'),
    makeDeps({ subject: COMMERCIAL, comps: HOUSTON_COMPS }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.outcome, OFFERR_OUTCOMES.UNSUPPORTED);
  assert.equal(result.seller_projection.preliminary_range, null);
  assert.ok(
    result.internal_result.reason_codes.includes('non_residential_signal_on_canonical_record'),
    `expected non-residential refusal, got ${JSON.stringify(result.internal_result.reason_codes)}`,
  );
});

test('asset family resting only on a low-confidence guess never earns a range', () => {
  const gates = applyOfferrSafetyGates({
    resolution: { status: OFFERR_RESOLUTION_STATUSES.RESOLVED },
    assetFamily: 'RESIDENTIAL_SINGLE',
    assetLane: 'SFR',
    assetConfidence: 55, // the inferred_from_unit_count fallback
    decision: { v3: { final_confidence: 95 } },
  });

  assert.equal(gates.outcome, OFFERR_OUTCOMES.UNSUPPORTED);
  assert.equal(gates.preliminary_range, null);
  assert.equal(gates.gate_checks.asset_classification_trusted, false);
  assert.ok(
    gates.reason_codes.some((r) => r.startsWith('asset_classification_below_confidence_floor:')),
  );
});

test('omitted asset confidence does not trip the floor (direct-caller compatibility)', () => {
  const gates = applyOfferrSafetyGates({
    resolution: { status: OFFERR_RESOLUTION_STATUSES.RESOLVED },
    assetFamily: 'RESIDENTIAL_SINGLE',
    assetLane: 'SFR',
    decision: null, // falls through to the V3-absent review path, not UNSUPPORTED
  });

  assert.equal(gates.gate_checks.asset_classification_trusted, true);
  assert.equal(gates.outcome, OFFERR_OUTCOMES.REVIEW_REQUIRED);
});

// ── 5. Idempotency: duplicate key does not create a second evaluation ───────

test('same idempotency key replays the stored evaluation, no second snapshot', async () => {
  const store = createInMemoryOfferrEvaluationStore();
  const first = await evaluateOfferrProperty(
    intakeFor(HOUSTON_SFR, 'idem-key-000000001'),
    makeDeps({ subject: HOUSTON_SFR, comps: HOUSTON_COMPS, overrides: { store } }),
  );
  const second = await evaluateOfferrProperty(
    intakeFor(HOUSTON_SFR, 'idem-key-000000001'),
    makeDeps({ subject: HOUSTON_SFR, comps: HOUSTON_COMPS, overrides: { store } }),
  );

  assert.equal(first.ok, true);
  assert.equal(first.idempotent_replay, false);
  assert.equal(second.ok, true);
  assert.equal(second.idempotent_replay, true);
  assert.equal(second.evaluation_id, first.evaluation_id, 'same evaluation returned');
  assert.deepEqual(second.seller_projection, first.seller_projection);

  const stored = await store.findByIdempotencyKey('idem-key-000000001');
  assert.equal(stored.found, true);
  assert.equal(stored.evaluation.evaluation_version, 1, 'exactly one evaluation version exists');
});

// ── 6. Seller facts are an overlay: claims only, canonical data unchanged ──

test('seller-confirmed facts stay an unverified overlay and never mutate the subject', async () => {
  const frozenSubject = Object.freeze({ ...HOUSTON_SFR });
  const canonicalSnapshot = JSON.stringify(frozenSubject);

  const deps = makeDeps({
    subject: frozenSubject,
    comps: HOUSTON_COMPS,
    overrides: { loadSubjectProperty: async () => frozenSubject },
  });
  const result = await evaluateOfferrProperty(
    intakeFor(frozenSubject, 'overlay-key-00001', {
      seller_facts: {
        condition: 'good',
        occupancy: 'vacant',
        repairs: { level: 'major', notes: 'roof and foundation' },
      },
    }),
    deps,
  );

  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(frozenSubject), canonicalSnapshot, 'canonical subject unchanged');

  const overlay = result.internal_result.overlay;
  assert.equal(overlay.facts.condition.source, 'seller_claimed');
  assert.equal(overlay.facts.condition.verified, false);
  assert.equal(overlay.facts.repairs.value.level, 'major');

  // 'good condition' + 'major repairs' is a material conflict -> downgraded
  // from instant to at most a conditional range.
  assert.ok(overlay.material_conflicts.includes('condition_claim_conflicts_with_repair_disclosure'));
  assert.notEqual(result.outcome, OFFERR_OUTCOMES.INSTANT_RANGE_ELIGIBLE);
});

test('detectOverlayConflicts flags asking price far above the independent anchor', () => {
  const conflicts = detectOverlayConflicts(
    { asking_price: { value: 400000, source: 'seller_claimed', verified: false } },
    { estimated_value: 156000 },
  );
  assert.deepEqual(conflicts, ['asking_price_far_above_independent_value']);
});

// ── 7. Low comp quality cannot produce an instant range ────────────────────

test('two-comp evidence cannot be INSTANT; one-comp evidence gets no range at all', async () => {
  const twoComp = await evaluateOfferrProperty(
    intakeFor(HOUSTON_SFR, 'lowdepth-2-00001'),
    makeDeps({ subject: HOUSTON_SFR, comps: HOUSTON_COMPS.slice(0, 2) }),
  );
  assert.equal(twoComp.ok, true);
  assert.notEqual(twoComp.outcome, OFFERR_OUTCOMES.INSTANT_RANGE_ELIGIBLE);

  const oneComp = await evaluateOfferrProperty(
    intakeFor(HOUSTON_SFR, 'lowdepth-1-00001'),
    makeDeps({ subject: HOUSTON_SFR, comps: HOUSTON_COMPS.slice(0, 1) }),
  );
  assert.equal(oneComp.ok, true);
  assert.notEqual(oneComp.outcome, OFFERR_OUTCOMES.INSTANT_RANGE_ELIGIBLE);
  assert.notEqual(oneComp.outcome, OFFERR_OUTCOMES.CONDITIONAL_RANGE);
  assert.equal(oneComp.seller_projection.preliminary_range, null);
  assert.notEqual(oneComp.seller_projection.confidence_label, 'HIGH');
});

// ── 8. Package/broadcast contamination cannot produce an autonomous range ──

test('Caldwell package contamination fails closed to review with no range', async () => {
  const result = await evaluateOfferrProperty(
    intakeFor(CALDWELL_SFR, 'caldwell-key-0001'),
    makeDeps({ subject: CALDWELL_SFR, comps: CALDWELL_COMPS }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.outcome, OFFERR_OUTCOMES.REVIEW_REQUIRED);
  assert.equal(result.seller_projection.preliminary_range, null);

  const v3 = result.internal_result.decision.v3;
  assert.equal(v3.execution_state, 'ANOMALY_QUARANTINE');
  assert.ok(v3.anomaly_flags.includes('PACKAGE_CONSIDERATION_DETECTED'));
  assert.equal(v3.sample.package_cluster_count, 1, '12 rows collapse to one economic transaction');
});

// ── 9. A single extreme comp cannot create high confidence ─────────────────

test('Austin duplex $332.5M broadcast comp yields review, no range, no HIGH label', async () => {
  const result = await evaluateOfferrProperty(
    intakeFor(AUSTIN_DUPLEX, 'austin-key-000001'),
    makeDeps({ subject: AUSTIN_DUPLEX, comps: AUSTIN_COMPS }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.outcome, OFFERR_OUTCOMES.REVIEW_REQUIRED);
  assert.equal(result.seller_projection.preliminary_range, null);
  assert.notEqual(result.seller_projection.confidence_label, 'HIGH');

  const v3 = result.internal_result.decision.v3;
  assert.equal(v3.execution_state, 'ANOMALY_QUARANTINE');
  assert.ok(v3.anomaly_flags.includes('IMPLAUSIBLE_COMP_PRICE'));
});

// ── 10. Nonfinite / negative / reversed engine output is a hard failure ────

function poisonedDecision(authOverrides) {
  return {
    v3: {
      engine_version: 'acq-v3',
      formula_version: 'test',
      execution_state: 'SHADOW_MODE_READY',
      value_classification: 'QUALIFIED',
      final_confidence: 90,
      invariants: { ok: true, violations: [] },
      transaction_anomaly_material: false,
      material_anomaly_reasons: [],
      sample: { effective_sample_size: 5 },
      buyer_exit: { conservative_buyer_exit: 200000 },
      value_contract: {
        qualified_market_value: { low: 150000, mid: 175000, high: 200000 },
      },
      offer_authorization: {
        authorized_opening_offer: 90000,
        authorized_recommended_offer: 100000,
        authorized_maximum_offer: 110000,
        ...authOverrides,
      },
      active_feature_flags: { ACQUISITION_ENGINE_V3_ALLOW_AUTO_OFFER: false },
    },
  };
}

test('NaN, Infinity, negative, and reversed engine outputs are rejected as hard failures', async () => {
  const cases = [
    { over: { authorized_recommended_offer: Number.NaN }, code: 'nonfinite_or_negative_engine_output' },
    { over: { authorized_maximum_offer: Number.POSITIVE_INFINITY }, code: 'nonfinite_or_negative_engine_output' },
    { over: { authorized_opening_offer: -5000 }, code: 'nonfinite_or_negative_engine_output' },
    { over: { authorized_opening_offer: 120000 }, code: 'range_floor_exceeds_ceiling' },
  ];

  for (const [i, c] of cases.entries()) {
    const deps = makeDeps({
      subject: HOUSTON_SFR,
      comps: HOUSTON_COMPS,
      overrides: { calculateDecision: () => poisonedDecision(c.over) },
    });
    const result = await evaluateOfferrProperty(
      intakeFor(HOUSTON_SFR, `poison-key-0000-${i}`),
      deps,
    );
    assert.equal(result.ok, false, `case ${i} fails hard`);
    assert.equal(result.failure_code, c.code, `case ${i} failure code`);
    assert.equal(result.seller_projection, null, `case ${i} exposes no projection`);

    const stored = await deps.store.findByIdempotencyKey(`poison-key-0000-${i}`);
    assert.equal(stored.found, false, `case ${i} persists no evaluation snapshot`);
  }
});

test('range exceeding the conservative ceiling fails closed to review (no range)', () => {
  const gates = applyOfferrSafetyGates({
    resolution: { status: OFFERR_RESOLUTION_STATUSES.RESOLVED },
    assetFamily: 'RESIDENTIAL_SINGLE',
    assetLane: 'SFR',
    decision: poisonedDecision({
      authorized_recommended_offer: 250000, // above conservative_buyer_exit 200000
      authorized_maximum_offer: 260000,
    }),
  });
  assert.equal(gates.hard_failure, false);
  assert.equal(gates.outcome, OFFERR_OUTCOMES.REVIEW_REQUIRED);
  assert.equal(gates.preliminary_range, null);
  assert.ok(gates.reason_codes.includes('range_exceeds_conservative_ceiling'));
});

// ── 11/12. Flag-off engine path + timeout + persistence failure ────────────

test('V3 evidence layer disabled -> review only, never a seller range from V2 output', async () => {
  const result = await evaluateOfferrProperty(
    intakeFor(HOUSTON_SFR, 'v2only-key-00001'),
    makeDeps({ subject: HOUSTON_SFR, comps: HOUSTON_COMPS, overrides: { v3Enabled: false } }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.outcome, OFFERR_OUTCOMES.REVIEW_REQUIRED);
  assert.equal(result.seller_projection.preliminary_range, null);
  assert.ok(result.internal_result.reason_codes.includes('engine_v3_disabled_or_unavailable'));
});

test('deadline exceeded fails closed with evaluation_timeout and no range', async () => {
  const result = await evaluateOfferrProperty(
    intakeFor(HOUSTON_SFR, 'timeout-key-00001'),
    makeDeps({ subject: HOUSTON_SFR, comps: HOUSTON_COMPS, overrides: { timeoutMs: -1 } }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.failure_code, 'evaluation_timeout');
  assert.equal(result.seller_projection, null);
});

test('persistence failure fails closed: no seller range leaves the system', async () => {
  const result = await evaluateOfferrProperty(
    intakeFor(HOUSTON_SFR, 'persistfail-00001'),
    makeDeps({
      subject: HOUSTON_SFR,
      comps: HOUSTON_COMPS,
      overrides: {
        store: {
          findByIdempotencyKey: async () => ({ ok: true, found: false }),
          persistEvaluation: async () => ({ ok: false, error: 'offerr_evaluation_write_failed' }),
        },
      },
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.failure_code, 'offerr_persistence_failed');
  assert.equal(result.seller_projection, null);
});

// ── 14. No contract / message / title / campaign side effects ──────────────

test('offerr spine modules never reference queue, message, contract, or title infrastructure', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const offerrDir = path.join(here, '..', '..', 'src', 'lib', 'domain', 'offerr');
  const routeFile = path.join(
    here, '..', '..', 'src', 'app', 'api', 'internal', 'offerr', 'evaluations', 'route.js',
  );

  const sources = await Promise.all([
    readFile(path.join(offerrDir, 'offerr-contracts.js'), 'utf8'),
    readFile(path.join(offerrDir, 'offerr-property-resolution.js'), 'utf8'),
    readFile(path.join(offerrDir, 'offerr-safety-gates.js'), 'utf8'),
    readFile(path.join(offerrDir, 'offerr-seller-projection.js'), 'utf8'),
    readFile(path.join(offerrDir, 'offerr-evaluation-store.js'), 'utf8'),
    readFile(path.join(offerrDir, 'offerr-evaluation-service.js'), 'utf8'),
    readFile(routeFile, 'utf8'),
  ]);

  const forbidden = [
    'send_queue',
    'message_events',
    'email_send_queue',
    'follow_up_queue',
    'docusign',
    'domain/contracts',
    'domain/title',
    'domain/closings',
    'lib/podio',
    'lib/sms',
    'campaign',
    'scoreProperty',
    'persistAcquisitionScore',
  ];
  for (const source of sources) {
    for (const token of forbidden) {
      assert.equal(
        source.includes(token),
        false,
        `offerr spine source must not reference "${token}"`,
      );
    }
  }
});
