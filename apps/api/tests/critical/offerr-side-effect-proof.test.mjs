/**
 * Offerr Evaluation Spine — executable side-effect proof.
 *
 * Runs evaluateOfferrProperty through the REAL default loaders (subject
 * hydration, comp loading, V3 candidate RPC) and the REAL Supabase-backed
 * store against a recording fake client, then asserts from the recorded
 * operations — not from comments — that the spine:
 *
 *   - writes ONLY offerr_* tables (never property_acquisition_scores,
 *     send_queue, message_events, contracts, campaigns, offers, ...)
 *   - never touches outbound-execution tables even for reads
 *   - makes no network request
 *   - never persists more than one snapshot per idempotency key, even under
 *     concurrent same-key races
 *   - compensates a failed evaluation insert instead of leaving a consumed
 *     idempotency key behind, and never presents a partial snapshot as a
 *     completed evaluation
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateOfferrProperty } from '@/lib/domain/offerr/offerr-evaluation-service.js';
import {
  createSupabaseOfferrEvaluationStore,
  createInMemoryOfferrEvaluationStore,
  OFFERR_REQUESTS_TABLE,
  OFFERR_EVALUATIONS_TABLE,
  OFFERR_EVENTS_TABLE,
} from '@/lib/domain/offerr/offerr-evaluation-store.js';

const NOW = new Date('2026-07-29T12:00:00.000Z');

const HOUSTON_SUBJECT = {
  property_id: '2130847744',
  property_address_full: '6310 Cambridge Glen Ln, Houston, TX 77035',
  property_address: '6310 Cambridge Glen Ln',
  property_address_city: 'Houston',
  property_address_state: 'TX',
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

const WRITE_METHODS = new Set(['insert', 'update', 'upsert', 'delete']);

const FORBIDDEN_TABLES = [
  'send_queue',
  'message_events',
  'email_send_queue',
  'follow_up_queue',
  'campaigns',
  'campaign_targets',
  'contracts',
  'offers',
  'property_acquisition_scores',
  'property_cash_offer_snapshots',
  'acquisition_opportunities',
  'universal_lead_command_cache',
  'deal_thread_state',
];

/**
 * Proxy-based recording client: any chained filter method returns the same
 * query, terminals resolve canned per-table data, and every entry operation
 * (select/insert/update/delete/upsert/rpc) is recorded.
 */
function makeRecordingSupabase({ tableData = {}, insertErrors = {} } = {}) {
  const ops = [];

  function makeQuery(result) {
    const target = {
      then(resolve, reject) {
        return Promise.resolve(result).then(resolve, reject);
      },
      maybeSingle: async () => ({
        data: Array.isArray(result.data) ? result.data[0] ?? null : result.data,
        error: result.error ?? null,
      }),
      single: async () => ({
        data: Array.isArray(result.data) ? result.data[0] ?? null : result.data,
        error: result.error ?? null,
      }),
    };
    return new Proxy(target, {
      get(t, prop) {
        if (prop in t) return t[prop];
        if (prop === 'catch') return (fn) => Promise.resolve(result).catch(fn);
        if (prop === 'finally') return (fn) => Promise.resolve(result).finally(fn);
        if (typeof prop === 'symbol') return undefined;
        return () => makeQuery(result);
      },
    });
  }

  const client = {
    _ops: ops,
    from(table) {
      return new Proxy(
        {},
        {
          get(_t, method) {
            if (typeof method === 'symbol') return undefined;
            return (payload) => {
              ops.push({ table, method: String(method) });
              if (method === 'insert') {
                if (insertErrors[table]) {
                  return makeQuery({ data: null, error: insertErrors[table] });
                }
                const row = Array.isArray(payload) ? payload[0] : payload;
                return makeQuery({
                  data: [{ id: row?.id ?? `gen-${ops.length}`, ...row }],
                  error: null,
                });
              }
              if (WRITE_METHODS.has(String(method))) {
                return makeQuery({ data: [], error: null });
              }
              // PostgREST returns an exact row count alongside the data when
              // the caller asks for one, and the Offerr resolver proves
              // candidate completeness from it. A double that omitted `count`
              // would make every real-path read look truncated, so the canned
              // rows carry their own count exactly as the server would.
              const rows = tableData[table] ?? [];
              return makeQuery({ data: rows, error: null, count: rows.length });
            };
          },
        },
      );
    },
    async rpc(name) {
      ops.push({ table: `rpc:${name}`, method: 'rpc' });
      return { data: [], error: null };
    },
  };
  return client;
}

function realPathDeps(client, overrides = {}) {
  let seq = 0;
  return {
    now: NOW,
    v3Enabled: true,
    db: client,
    supabase: client,
    store: createSupabaseOfferrEvaluationStore({ db: client }),
    generateRequestId: () => `req-${++seq}`,
    generateEvaluationId: () => `eval-${seq}`,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    ...overrides,
  };
}

test('real loader path writes only offerr_* tables and never touches execution tables', async () => {
  const client = makeRecordingSupabase({
    tableData: { properties: [HOUSTON_SUBJECT] },
  });

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('network blocked');
  };

  let result;
  try {
    result = await evaluateOfferrProperty(
      {
        address: '6310 Cambridge Glen Ln, Houston, TX 77035',
        idempotency_key: 'side-effect-proof-001',
      },
      realPathDeps(client),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(result.ok, true, `evaluation completed: ${result.failure_code ?? 'ok'}`);
  assert.equal(fetchCalls, 0, 'no network request anywhere in the spine');

  const writes = client._ops.filter((op) => WRITE_METHODS.has(op.method));
  assert.ok(writes.length >= 2, 'request + evaluation snapshots were written');
  for (const op of writes) {
    assert.ok(
      op.table.startsWith('offerr_'),
      `write to non-offerr table detected: ${op.table}.${op.method}`,
    );
  }

  const touched = new Set(client._ops.map((op) => op.table));
  for (const forbidden of FORBIDDEN_TABLES) {
    assert.equal(
      touched.has(forbidden),
      false,
      `forbidden table touched (read or write): ${forbidden}`,
    );
  }

  // The canonical read path was actually exercised (not stubbed away).
  assert.ok(touched.has('properties'), 'canonical properties table was read');
  assert.ok(touched.has('rpc:get_comp_candidates_for_subject'), 'canonical comp RPC was called');
});

test('concurrent same-key evaluations settle on exactly one snapshot', async () => {
  const store = createInMemoryOfferrEvaluationStore();
  const intake = {
    address: '6310 Cambridge Glen Ln, Houston, TX 77035',
    idempotency_key: 'concurrent-key-0001',
  };
  const deps = () => ({
    now: NOW,
    v3Enabled: false,
    store,
    generateRequestId: () => `req-${Math.random().toString(36).slice(2, 8)}`,
    generateEvaluationId: () => `eval-${Math.random().toString(36).slice(2, 8)}`,
    resolveSubjectProperty: async () => ({
      status: 'RESOLVED',
      property_id: HOUSTON_SUBJECT.property_id,
      match: {
        property_id: HOUSTON_SUBJECT.property_id,
        property_address_full: HOUSTON_SUBJECT.property_address_full,
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
    }),
    loadSubjectProperty: async () => ({ ...HOUSTON_SUBJECT }),
    loadComparableProperties: async () => [],
    loadBuyerPurchases: async () => [],
    loadV3CompCandidates: async () => null,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  const results = await Promise.all(
    Array.from({ length: 5 }, () => evaluateOfferrProperty(intake, deps())),
  );

  const okResults = results.filter((r) => r.ok);
  assert.equal(okResults.length, 5, 'all concurrent callers get a result');
  const evaluationIds = new Set(okResults.map((r) => r.evaluation_id));
  assert.equal(evaluationIds.size, 1, 'every caller sees the same single evaluation');

  const stored = await store.findByIdempotencyKey(intake.idempotency_key);
  assert.equal(stored.evaluation.evaluation_version, 1, 'exactly one snapshot version exists');
});

test('failed evaluation insert compensates the request row instead of consuming the key', async () => {
  const client = makeRecordingSupabase({
    tableData: { properties: [HOUSTON_SUBJECT] },
    insertErrors: { [OFFERR_EVALUATIONS_TABLE]: { code: 'XX000', message: 'boom' } },
  });
  const store = createSupabaseOfferrEvaluationStore({ db: client });

  const persisted = await store.persistEvaluation({
    request: { id: 'req-x', idempotency_key: 'compensate-key-1', normalized_submitted_address: 'x' },
    evaluation: { id: 'eval-x', evaluation_version: 1, outcome: 'REVIEW_REQUIRED' },
    event: null,
  });

  assert.equal(persisted.ok, false);
  assert.equal(persisted.error, 'offerr_evaluation_write_failed');

  const requestOps = client._ops.filter((op) => op.table === OFFERR_REQUESTS_TABLE);
  assert.ok(
    requestOps.some((op) => op.method === 'delete'),
    'compensating delete removed the orphaned request row',
  );
  const eventOps = client._ops.filter((op) => op.table === OFFERR_EVENTS_TABLE);
  assert.equal(eventOps.length, 0, 'no audit event for a failed snapshot');
});

test('a request row without an evaluation snapshot is never replayed as success', async () => {
  const result = await evaluateOfferrProperty(
    {
      address: '6310 Cambridge Glen Ln, Houston, TX 77035',
      idempotency_key: 'orphan-key-00001',
    },
    {
      now: NOW,
      store: {
        findByIdempotencyKey: async () => ({
          ok: true,
          found: true,
          request: { id: 'req-orphan', normalized_submitted_address: '6310 cambridge glen ln houston tx 77035' },
          evaluation: null,
        }),
        persistEvaluation: async () => {
          throw new Error('must not be reached');
        },
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.failure_code, 'offerr_incomplete_snapshot');
  assert.equal(result.seller_projection, null);
});

test('idempotency key reuse with a different address is a stable conflict, not a replay', async () => {
  const store = createInMemoryOfferrEvaluationStore();
  const deps = (overrides = {}) => ({
    now: NOW,
    v3Enabled: false,
    store,
    generateRequestId: () => 'req-reuse',
    generateEvaluationId: () => 'eval-reuse',
    resolveSubjectProperty: async () => ({
      status: 'NOT_FOUND',
      property_id: null,
      match: null,
      candidate_count: 0,
      candidates: [],
      reason: 'no_candidates_found',
      method: 'test_stub',
    }),
    loadSubjectProperty: async () => null,
    loadComparableProperties: async () => [],
    loadBuyerPurchases: async () => [],
    loadV3CompCandidates: async () => null,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    ...overrides,
  });

  const first = await evaluateOfferrProperty(
    { address: '100 First St, Austin, TX 78701', idempotency_key: 'reuse-key-000001' },
    deps(),
  );
  assert.equal(first.ok, true);

  const second = await evaluateOfferrProperty(
    { address: '999 Different Ave, Austin, TX 78701', idempotency_key: 'reuse-key-000001' },
    deps(),
  );
  assert.equal(second.ok, false);
  assert.equal(second.failure_code, 'idempotency_key_reused_with_different_payload');
  assert.equal(second.seller_projection, null);
});
