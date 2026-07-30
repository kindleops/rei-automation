/**
 * Offerr Evaluation Spine — internal route contract.
 *
 * POST /api/internal/offerr/evaluations must be internal-secret protected,
 * feature-flag gated (system_control offerr_evaluation_enabled, default OFF,
 * canonical 423 system_control_disabled envelope), size-limited, idempotent,
 * and must return only the sanitized seller-safe evaluation payload.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { handleOfferrEvaluationsRequest } from '@/app/api/internal/offerr/evaluations/route.js';
import { createInMemoryOfferrEvaluationStore } from '@/lib/domain/offerr/offerr-evaluation-store.js';
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

function makeRequest({ body = {}, headers = {}, contentLength = null } = {}) {
  const merged = { 'x-internal-api-secret': 'test', ...headers };
  if (contentLength !== null) merged['content-length'] = String(contentLength);
  const headerBag = new Headers(merged);
  return {
    headers: headerBag,
    json: async () => body,
  };
}

function evaluationDeps(overrides = {}) {
  let seq = 0;
  return {
    now: NOW,
    v3Enabled: true,
    store: createInMemoryOfferrEvaluationStore(),
    generateRequestId: () => `req-${++seq}`,
    generateEvaluationId: () => `eval-${seq}`,
    getSystemFlag: async () => true,
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

const VALID_BODY = {
  address: HOUSTON_SFR.property_address_full,
  idempotency_key: 'route-key-000000001',
};

test('missing internal secret is rejected before any evaluation work', async () => {
  let flagReads = 0;
  let evaluateCalls = 0;
  const res = await handleOfferrEvaluationsRequest(
    makeRequest({ headers: { 'x-internal-api-secret': '' }, body: VALID_BODY }),
    evaluationDeps({
      getSystemFlag: async () => {
        flagReads += 1;
        return true;
      },
      evaluateOfferrProperty: async () => {
        evaluateCalls += 1;
        return { ok: false, failure_code: 'unreachable' };
      },
    }),
  );
  assert.equal(res.status, 401);
  const payload = await res.json();
  assert.equal(payload.ok, false);
  assert.equal(flagReads, 0, 'auth happens before the flag read');
  assert.equal(evaluateCalls, 0, 'auth happens before any evaluation work');
});

test('disabled flag short-circuits before any evaluation work', async () => {
  let evaluateCalls = 0;
  const res = await handleOfferrEvaluationsRequest(
    makeRequest({ body: VALID_BODY }),
    evaluationDeps({
      getSystemFlag: async () => false,
      evaluateOfferrProperty: async () => {
        evaluateCalls += 1;
        return { ok: false, failure_code: 'unreachable' };
      },
    }),
  );
  assert.equal(res.status, 423);
  assert.equal(evaluateCalls, 0, 'flag gate precedes evaluation');
});

test('malformed JSON body is a stable 400 with a correlation id', async () => {
  const request = {
    headers: new Headers({ 'x-internal-api-secret': 'test' }),
    json: async () => {
      throw new SyntaxError('Unexpected token');
    },
  };
  const res = await handleOfferrEvaluationsRequest(request, evaluationDeps());
  assert.equal(res.status, 400);
  const payload = await res.json();
  assert.equal(payload.error, 'invalid_offerr_intake');
  assert.deepEqual(payload.validation_errors, ['malformed_json_body']);
  assert.ok(payload.correlation_id, 'correlation id present on pre-validation failure');
});

test('idempotency payload-reuse conflict maps to 409', async () => {
  const res = await handleOfferrEvaluationsRequest(
    makeRequest({ body: VALID_BODY }),
    evaluationDeps({
      evaluateOfferrProperty: async () => ({
        ok: false,
        failure_code: 'idempotency_key_reused_with_different_payload',
      }),
    }),
  );
  assert.equal(res.status, 409);
  const payload = await res.json();
  assert.equal(payload.failure_code, 'idempotency_key_reused_with_different_payload');
  assert.ok(payload.correlation_id);
});

test('feature flag disabled returns the canonical 423 system_control_disabled envelope', async () => {
  const res = await handleOfferrEvaluationsRequest(
    makeRequest({ body: VALID_BODY }),
    evaluationDeps({ getSystemFlag: async () => false }),
  );
  assert.equal(res.status, 423);
  const payload = await res.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.error, 'system_control_disabled');
  assert.equal(payload.flag_key, 'offerr_evaluation_enabled');
});

test('oversized payload is rejected with 413 before parsing', async () => {
  const res = await handleOfferrEvaluationsRequest(
    makeRequest({ body: VALID_BODY, contentLength: 1_000_000 }),
    evaluationDeps(),
  );
  assert.equal(res.status, 413);
  const payload = await res.json();
  assert.equal(payload.error, 'payload_too_large');
});

test('invalid intake returns 400 with structured validation errors', async () => {
  const res = await handleOfferrEvaluationsRequest(
    makeRequest({ body: { address: 'short', idempotency_key: 'x' } }),
    evaluationDeps(),
  );
  assert.equal(res.status, 400);
  const payload = await res.json();
  assert.equal(payload.error, 'invalid_offerr_intake');
  assert.ok(Array.isArray(payload.validation_errors) && payload.validation_errors.length > 0);
});

test('valid request returns 200 with only the seller-safe evaluation payload', async () => {
  const deps = evaluationDeps();
  const res = await handleOfferrEvaluationsRequest(makeRequest({ body: VALID_BODY }), deps);
  assert.equal(res.status, 200);
  const payload = await res.json();

  assert.equal(payload.ok, true);
  assert.equal(payload.route, 'internal/offerr/evaluations');
  assert.ok(payload.request_id, 'internal request identifier returned');
  assert.ok(payload.evaluation_id, 'evaluation identifier returned');
  assert.equal(payload.idempotent_replay, false);
  assert.equal(payload.evaluation.outcome, OFFERR_OUTCOMES.INSTANT_RANGE_ELIGIBLE);
  assert.equal(payload.evaluation.binding, false);

  // The full underwriting result must never ride along on the HTTP envelope.
  assert.equal('internal_result' in payload, false);
  assert.equal('decision' in payload, false);
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes('recommended_cash_offer'), false);
  assert.equal(serialized.includes('assignment_fee'), false);
});

test('duplicate idempotency key replays the same evaluation over HTTP', async () => {
  const store = createInMemoryOfferrEvaluationStore();
  const first = await handleOfferrEvaluationsRequest(
    makeRequest({ body: VALID_BODY }),
    evaluationDeps({ store }),
  );
  const second = await handleOfferrEvaluationsRequest(
    makeRequest({ body: VALID_BODY }),
    evaluationDeps({ store }),
  );
  const a = await first.json();
  const b = await second.json();

  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(b.idempotent_replay, true);
  assert.equal(b.evaluation_id, a.evaluation_id);
  assert.deepEqual(b.evaluation, a.evaluation);
});

test('failure codes map to structured error statuses (timeout 504, persistence 503)', async () => {
  const timeout = await handleOfferrEvaluationsRequest(
    makeRequest({ body: VALID_BODY }),
    evaluationDeps({
      evaluateOfferrProperty: async () => ({
        ok: false,
        failure_code: 'evaluation_timeout',
      }),
    }),
  );
  assert.equal(timeout.status, 504);
  const timeoutPayload = await timeout.json();
  assert.equal(timeoutPayload.error, 'offerr_evaluation_failed');
  assert.equal(timeoutPayload.failure_code, 'evaluation_timeout');

  const persistence = await handleOfferrEvaluationsRequest(
    makeRequest({ body: VALID_BODY }),
    evaluationDeps({
      evaluateOfferrProperty: async () => ({
        ok: false,
        failure_code: 'offerr_persistence_failed',
      }),
    }),
  );
  assert.equal(persistence.status, 503);
});
