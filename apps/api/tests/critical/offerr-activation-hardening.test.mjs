/**
 * Offerr Evaluation Spine — activation-blocker regressions.
 *
 * One executable proof per remaining finding in
 * docs/offerr/offerr-staging-verification-report.md §14.9 (plus the route-gate
 * ordering decision in §14.5). Each test fails against the pre-fix code.
 *
 *   §14.9-3  the deadline was advisory — no awaited stage was bounded, so a
 *            hung loader ran to the route's 60 s maxDuration instead of
 *            returning `evaluation_timeout`;
 *   §14.9-4  subject hydration and the engine call had no failure-code
 *            boundary, so transient faults became HTTP 500 + Sentry noise
 *            instead of structured, correctly-classified codes;
 *   §14.9-5  the compensating delete result was unchecked, so a failed delete
 *            permanently poisoned the idempotency key while the route kept
 *            advertising the state as a transient, retryable race.
 *
 * §14.9-1 (unordered/truncated candidate query) and §14.9-2 (five-digit house
 * number eaten as a ZIP) are proven in offerr-candidate-completeness.test.mjs
 * and offerr-property-resolution.test.mjs respectively.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { handleOfferrEvaluationsRequest } from '@/app/api/internal/offerr/evaluations/route.js';
import { evaluateOfferrProperty } from '@/lib/domain/offerr/offerr-evaluation-service.js';
import {
  createInMemoryOfferrEvaluationStore,
  createSupabaseOfferrEvaluationStore,
} from '@/lib/domain/offerr/offerr-evaluation-store.js';
import { OFFERR_INTAKE_LIMITS } from '@/lib/domain/offerr/offerr-contracts.js';

const NOW = new Date('2026-07-31T12:00:00.000Z');

const SUBJECT = {
  property_id: 'hardening-subject',
  property_address_full: '6310 Cambridge Glen Ln, Houston, TX 77035',
  property_address_zip: '77035',
  property_type: 'SFR',
  property_class: 'Residential',
  building_square_feet: 1356,
  units_count: 1,
  estimated_value: 156000,
};

const RESOLVED = {
  status: 'RESOLVED',
  property_id: SUBJECT.property_id,
  match: {
    property_id: SUBJECT.property_id,
    property_address_full: SUBJECT.property_address_full,
    city: 'Houston',
    state: 'TX',
    zip: '77035',
    property_type: 'SFR',
    market: 'Houston, TX',
  },
  candidate_count: 1,
  candidates: [],
  reason: 'unique_structured_match',
  method: 'test_stub',
};

/** A promise that never settles — a wedged network call. */
const hang = () => new Promise(() => {});

function deps(overrides = {}) {
  let seq = 0;
  return {
    now: NOW,
    v3Enabled: true,
    store: createInMemoryOfferrEvaluationStore(),
    generateRequestId: () => `req-${++seq}`,
    generateEvaluationId: () => `eval-${seq}`,
    resolveSubjectProperty: async () => ({ ...RESOLVED }),
    loadSubjectProperty: async () => ({ ...SUBJECT }),
    loadComparableProperties: async () => [],
    loadBuyerPurchases: async () => [],
    loadV3CompCandidates: async () => null,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    ...overrides,
  };
}

const intake = (key) => ({ address: SUBJECT.property_address_full, idempotency_key: key });

/* ── §14.9-3: the deadline must bound the awaited work itself ─────────────── */

test('a hung resolver returns evaluation_timeout inside the budget, not at maxDuration', async () => {
  const started = Date.now();
  const result = await evaluateOfferrProperty(
    intake('hardening-timeout-resolution'),
    deps({ timeoutMs: 120, resolveSubjectProperty: hang }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.failure_code, 'evaluation_timeout');
  assert.equal(result.timeout_stage, 'resolution');
  assert.ok(Date.now() - started < 5_000, 'the wait itself was bounded, not just measured after');
});

test('a hung subject hydration times out at its own stage', async () => {
  const result = await evaluateOfferrProperty(
    intake('hardening-timeout-subject'),
    deps({ timeoutMs: 120, loadSubjectProperty: hang }),
  );
  assert.equal(result.failure_code, 'evaluation_timeout');
  assert.equal(result.timeout_stage, 'subject_hydration');
});

test('a hung comp loader times out at its own stage', async () => {
  const result = await evaluateOfferrProperty(
    intake('hardening-timeout-comps'),
    deps({ timeoutMs: 120, loadComparableProperties: hang }),
  );
  assert.equal(result.failure_code, 'evaluation_timeout');
  assert.equal(result.timeout_stage, 'comp_loading');
});

test('a hung idempotency lookup times out instead of blocking the request', async () => {
  const result = await evaluateOfferrProperty(
    intake('hardening-timeout-idem'),
    deps({
      timeoutMs: 120,
      store: { findByIdempotencyKey: hang, persistEvaluation: async () => ({ ok: true }) },
    }),
  );
  assert.equal(result.failure_code, 'evaluation_timeout');
  assert.equal(result.timeout_stage, 'idempotency_lookup');
});

test('a timeout maps to 504 at the route, never to an unhandled 500', async () => {
  const res = await handleOfferrEvaluationsRequest(
    {
      headers: new Headers({ 'x-internal-api-secret': 'test' }),
      json: async () => intake('hardening-timeout-route'),
    },
    deps({ timeoutMs: 120, getSystemFlag: async () => true, loadComparableProperties: hang }),
  );
  assert.equal(res.status, 504);
  const payload = await res.json();
  assert.equal(payload.failure_code, 'evaluation_timeout');
});

/* ── §14.9-4: hydration and engine need the same failure boundary ─────────── */

test('a transient subject-hydration fault becomes a structured retryable code', async () => {
  const result = await evaluateOfferrProperty(
    intake('hardening-hydration-throw'),
    deps({
      loadSubjectProperty: async () => {
        throw Object.assign(new Error('connection terminated unexpectedly'), { code: '57P01' });
      },
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.failure_code, 'subject_hydration_error');
  assert.equal(result.seller_projection, null);
});

test('subject_hydration_error is a 503 at the route, not a 500 exception', async () => {
  const res = await handleOfferrEvaluationsRequest(
    {
      headers: new Headers({ 'x-internal-api-secret': 'test' }),
      json: async () => intake('hardening-hydration-route'),
    },
    deps({
      getSystemFlag: async () => true,
      loadSubjectProperty: async () => {
        throw new Error('supabase read failed');
      },
    }),
  );
  assert.equal(res.status, 503);
  const payload = await res.json();
  // Reaching the structured envelope proves the route's catch block — the only
  // path that calls captureRouteException and returns the generic 500 — was
  // never entered, so this fault is not reported to Sentry as an exception.
  assert.equal(payload.error, 'offerr_evaluation_failed');
  assert.equal(payload.failure_code, 'subject_hydration_error');
  assert.notEqual(payload.error, 'offerr_evaluations_route_failed');
});

test('a decision-engine throw becomes decision_engine_error, not a route exception', async () => {
  const result = await evaluateOfferrProperty(
    intake('hardening-engine-throw'),
    deps({
      calculateDecision: () => {
        throw new TypeError('cannot read properties of undefined');
      },
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.failure_code, 'decision_engine_error');
});

test('decision_engine_error is a 500 — deterministic, so not advertised as retryable', async () => {
  const res = await handleOfferrEvaluationsRequest(
    {
      headers: new Headers({ 'x-internal-api-secret': 'test' }),
      json: async () => intake('hardening-engine-route'),
    },
    deps({
      getSystemFlag: async () => true,
      calculateDecision: () => {
        throw new Error('engine exploded');
      },
    }),
  );
  assert.equal(res.status, 500);
  const payload = await res.json();
  // Still the structured envelope, NOT the generic route-failure envelope.
  assert.equal(payload.error, 'offerr_evaluation_failed');
  assert.equal(payload.failure_code, 'decision_engine_error');
});

/* ── §14.9-5: a failed compensating delete must not be silent ─────────────── */

/** Minimal Supabase double: insert/select/delete with injectable failures. */
function storeDouble({ failEvaluationInsert = false, failCompensatingDelete = false } = {}) {
  const calls = [];
  const client = {
    _calls: calls,
    from(table) {
      return {
        select() {
          const q = {
            eq: () => q,
            order: () => q,
            limit: () => q,
            maybeSingle: async () => {
              calls.push({ table, method: 'select' });
              return { data: null, error: null };
            },
            single: async () => {
              calls.push({ table, method: 'select' });
              return { data: null, error: null };
            },
          };
          return q;
        },
        insert(row) {
          const q = {
            select: () => q,
            single: async () => {
              calls.push({ table, method: 'insert' });
              if (failEvaluationInsert && table === 'offerr_evaluations') {
                return { data: null, error: { code: '23514', message: 'check constraint' } };
              }
              return { data: { id: row?.id ?? 'generated-id', ...row }, error: null };
            },
            then: (resolve) => {
              calls.push({ table, method: 'insert' });
              return Promise.resolve({ data: null, error: null }).then(resolve);
            },
          };
          return q;
        },
        delete() {
          const q = {
            eq: () => q,
            then: (resolve) => {
              calls.push({ table, method: 'delete' });
              return Promise.resolve(
                failCompensatingDelete
                  ? { data: null, error: { code: '42501', message: 'permission denied' } }
                  : { data: [], error: null },
              ).then(resolve);
            },
          };
          return q;
        },
      };
    },
  };
  return client;
}

test('a successful compensating delete reports the ordinary write failure', async () => {
  const client = storeDouble({ failEvaluationInsert: true });
  const store = createSupabaseOfferrEvaluationStore({ db: client });

  const result = await store.persistEvaluation({
    request: { id: 'r1', idempotency_key: 'compensate-ok-1' },
    evaluation: { id: 'e1' },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'offerr_evaluation_write_failed');
  assert.equal(result.compensation_failed, false);
  assert.equal(result.orphaned_request_id, null);
  assert.ok(
    client._calls.some((c) => c.table === 'offerr_evaluation_requests' && c.method === 'delete'),
    'the request row was compensated away',
  );
});

test('a FAILED compensating delete is surfaced, named, and not called retryable', async () => {
  const client = storeDouble({ failEvaluationInsert: true, failCompensatingDelete: true });
  const store = createSupabaseOfferrEvaluationStore({ db: client });

  const result = await store.persistEvaluation({
    request: { id: 'orphan-me', idempotency_key: 'compensate-fail-1' },
    evaluation: { id: 'e1' },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'offerr_evaluation_write_orphaned');
  assert.equal(result.compensation_failed, true);
  assert.equal(result.orphaned_request_id, 'orphan-me');
  assert.equal(result.compensation_error, 'permission denied');
});

test('an orphaned request row is a 500, not the retry-forever 503', async () => {
  // offerr_incomplete_snapshot is 503 because it IS transient. An orphan row is
  // permanent until an operator deletes it, so advertising "retry" is wrong.
  const result = await evaluateOfferrProperty(
    intake('hardening-orphan-1'),
    deps({
      store: {
        findByIdempotencyKey: async () => ({ ok: true, found: false }),
        persistEvaluation: async () => ({
          ok: false,
          error: 'offerr_evaluation_write_orphaned',
          compensation_failed: true,
          orphaned_request_id: 'orphan-me',
        }),
      },
    }),
  );
  assert.equal(result.failure_code, 'offerr_persistence_orphaned');

  const res = await handleOfferrEvaluationsRequest(
    {
      headers: new Headers({ 'x-internal-api-secret': 'test' }),
      json: async () => intake('hardening-orphan-route'),
    },
    deps({
      getSystemFlag: async () => true,
      store: {
        findByIdempotencyKey: async () => ({ ok: true, found: false }),
        persistEvaluation: async () => ({
          ok: false,
          error: 'offerr_evaluation_write_orphaned',
          compensation_failed: true,
          orphaned_request_id: 'orphan-me',
        }),
      },
    }),
  );
  assert.equal(res.status, 500);
  assert.equal((await res.json()).failure_code, 'offerr_persistence_orphaned');
});

/* ── §14.5: the disabled-route gate ordering, asserted rather than assumed ── */

test('the flag gate precedes body parsing and size checks, and stays that way', async () => {
  // Documented, deliberate behaviour: while Offerr is disabled EVERY
  // authenticated request gets the canonical 423, including malformed and
  // oversized bodies. This test pins that contract so a future reordering is a
  // conscious decision rather than an accident.
  let bodyReads = 0;
  const disabled = (headers, body) =>
    handleOfferrEvaluationsRequest(
      {
        headers: new Headers({ 'x-internal-api-secret': 'test', ...headers }),
        json: async () => {
          bodyReads += 1;
          return body;
        },
      },
      deps({ getSystemFlag: async () => false }),
    );

  const oversized = await disabled(
    { 'content-length': String(OFFERR_INTAKE_LIMITS.max_request_bytes * 4) },
    {},
  );
  assert.equal(oversized.status, 423, 'oversized body still gets the canonical disabled envelope');

  const malformed = await disabled({}, 'not-an-object');
  assert.equal(malformed.status, 423);

  const payload = await malformed.json();
  assert.equal(payload.flag_key, 'offerr_evaluation_enabled');
  assert.equal(bodyReads, 0, 'a disabled Offerr never parses an untrusted body');
});

test('when enabled, the size and shape checks do run, in order', async () => {
  const enabled = (headers, body) =>
    handleOfferrEvaluationsRequest(
      {
        headers: new Headers({ 'x-internal-api-secret': 'test', ...headers }),
        json: async () => body,
      },
      deps({ getSystemFlag: async () => true }),
    );

  const oversized = await enabled(
    { 'content-length': String(OFFERR_INTAKE_LIMITS.max_request_bytes + 1) },
    {},
  );
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error, 'payload_too_large');

  const malformed = await enabled({}, null);
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error, 'invalid_offerr_intake');
});

/* ── The internal-secret env finding (PR #57) is a false positive ─────────── */

test('INTERNAL_API_SECRET is configured by the critical-test runner itself', async () => {
  // A review finding claimed the route tests needed INTERNAL_API_SECRET set
  // before running. `npm run test:critical` already exports
  // INTERNAL_API_SECRET=test, and shared-secret auth fails OPEN (with reason
  // `internal_api_secret_not_configured`) outside production when it is unset —
  // so an unset secret would make the 401 assertions fail loudly, not pass
  // vacuously. This asserts the precondition directly.
  assert.equal(
    process.env.INTERNAL_API_SECRET,
    'test',
    'the critical-test runner must export INTERNAL_API_SECRET=test',
  );

  const wrongSecret = await handleOfferrEvaluationsRequest(
    {
      headers: new Headers({ 'x-internal-api-secret': 'not-the-secret' }),
      json: async () => intake('hardening-auth-1'),
    },
    deps({ getSystemFlag: async () => true }),
  );
  assert.equal(wrongSecret.status, 401);
});

/* ── Independent review additions (clean-room re-review of this PR) ────────── */

/**
 * withDeadline begins with `if (!(remainingMs > 0)) return STAGE_TIMEOUT`.
 *
 * The stage promise is the ARGUMENT expression, so the caller has already
 * started that work before withDeadline is entered. Returning the sentinel
 * without subscribing left the promise unobserved, and a later rejection from
 * it arrived as an unhandledRejection — which Node terminates the process on by
 * default. A single request exceeding its budget could therefore take down the
 * instance serving every other request.
 *
 * Against the pre-fix implementation this test does not fail, it CRASHES the
 * test process, which is precisely the production failure mode.
 */
test('an already-spent budget still observes the stage it abandons', async () => {
  const result = await evaluateOfferrProperty(
    intake('hardening-spent-budget'),
    deps({
      // Budget exhausted before stage 2 runs, so remainingMs() <= 0 on the
      // very first withDeadline call.
      timeoutMs: 0,
      store: {
        findByIdempotencyKey: () =>
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error('late rejection after budget spent')), 20);
          }),
        persistEvaluation: async () => ({ ok: true }),
      },
    }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.failure_code, 'evaluation_timeout');
  assert.equal(result.timeout_stage, 'idempotency_lookup');
  assert.equal(result.seller_projection, null, 'a timeout never produces a seller range');

  // Outlive the abandoned stage so its rejection actually fires.
  await new Promise((resolve) => setTimeout(resolve, 120));
});

/**
 * The retryability taxonomy this PR introduces (transient canonical-read fault
 * -> 503, deterministic compute fault -> 500) left two sibling codes
 * unclassified, so they fell through to the default 500 and were advertised as
 * permanent when they are in fact retryable.
 */
test('property_resolution_error is a retryable 503, not a default 500', async () => {
  const res = await handleOfferrEvaluationsRequest(
    {
      headers: new Headers({ 'x-internal-api-secret': 'test' }),
      json: async () => intake('hardening-resolution-fault'),
    },
    deps({
      getSystemFlag: async () => true,
      resolveSubjectProperty: async () => {
        throw Object.assign(new Error('offerr_property_lookup_failed'), {
          code: 'offerr_property_lookup_failed',
        });
      },
    }),
  );
  assert.equal(res.status, 503);
  const payload = await res.json();
  assert.equal(payload.failure_code, 'property_resolution_error');
});

test('comp_load_error is a retryable 503, not a default 500', async () => {
  const res = await handleOfferrEvaluationsRequest(
    {
      headers: new Headers({ 'x-internal-api-secret': 'test' }),
      json: async () => intake('hardening-comp-fault'),
    },
    deps({
      getSystemFlag: async () => true,
      loadComparableProperties: async () => {
        throw new Error('supabase read failed');
      },
    }),
  );
  assert.equal(res.status, 503);
  const payload = await res.json();
  assert.equal(payload.failure_code, 'comp_load_error');
});

/**
 * The idempotency key is caller-supplied and up to 128 characters, so it can
 * carry a seller identifier. The compensation-failure log named it in the
 * clear while the rest of the spine deliberately logs only hashed references.
 */
test('a failed compensation logs a hashed idempotency reference, never the raw key', async () => {
  const RAW_KEY = 'seller+jane.doe@example.com';
  const logged = [];
  const evaluationError = { message: 'evaluation insert failed' };

  const db = {
    from(table) {
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
        }),
        insert: (payload) => ({
          select: () => ({
            single: async () =>
              table === 'offerr_evaluations'
                ? { data: null, error: evaluationError }
                : { data: { id: 'req-orphan-1', ...payload }, error: null },
          }),
        }),
        delete: () => ({
          eq: async () => ({ error: { message: 'delete failed too' } }),
        }),
      };
    },
  };

  const store = createSupabaseOfferrEvaluationStore({
    db,
    logger: { error: (event, fields) => logged.push({ event, fields }) },
  });

  const persisted = await store.persistEvaluation({
    request: { idempotency_key: RAW_KEY },
    evaluation: {},
  });

  assert.equal(persisted.ok, false);
  assert.equal(persisted.error, 'offerr_evaluation_write_orphaned');

  const serialized = JSON.stringify(logged);
  assert.ok(!serialized.includes(RAW_KEY), 'the raw idempotency key must never be logged');
  assert.ok(
    serialized.includes('idempotency_key_sha256_12'),
    'a hashed reference is logged instead',
  );
});
