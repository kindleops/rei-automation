/**
 * Offerr PostgREST adapter — query-shape contract.
 *
 * The adapter is verification tooling, but the whole real-comp-path proof rests
 * on it faithfully reproducing PostgREST semantics. If `.in()` silently emitted
 * the wrong SQL, or `.select()` quietly degraded to `SELECT *`, the E2E harness
 * would report a green run that proved nothing.
 *
 * These tests drive the adapter against a stub pool that captures the emitted
 * SQL, so every newly supported operation is pinned without needing a database.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPgRestAdapter } from '../../scripts/offerr/offerr-pg-rest-adapter.mjs';

/** Minimal pool stub that records the SQL and params it was asked to run. */
function stubPool(result = { rows: [], rowCount: 0 }) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (result instanceof Error) throw result;
      return typeof result === 'function' ? result(sql, params) : result;
    },
  };
}

test('adapter emits real column projection, not SELECT *', async () => {
  const pool = stubPool();
  const db = createPgRestAdapter(pool);
  await db.from('properties').select('property_id,latitude, longitude').eq('property_id', 'P1');

  assert.equal(pool.calls.length, 1);
  assert.equal(
    pool.calls[0].sql,
    'SELECT "property_id", "latitude", "longitude" FROM "properties" WHERE "property_id" = $1',
  );
  assert.deepEqual(pool.calls[0].params, ['P1']);
});

test('adapter select("*") and select() fall back to SELECT *', async () => {
  const pool = stubPool();
  const db = createPgRestAdapter(pool);
  await db.from('offerr_evaluations').select('*').eq('id', 1);
  await db.from('offerr_evaluations').select().eq('id', 2);
  assert.ok(pool.calls[0].sql.startsWith('SELECT * FROM "offerr_evaluations"'));
  assert.ok(pool.calls[1].sql.startsWith('SELECT * FROM "offerr_evaluations"'));
});

test('a projected column the database lacks surfaces as SQLSTATE 42703', async () => {
  // This is the behaviour acquisitionDecisionEngine's optionalEnrichmentQuery
  // column-narrowing loop depends on. With SELECT * it could never trigger.
  const missing = Object.assign(new Error('column "nope" does not exist'), { code: '42703' });
  const db = createPgRestAdapter(stubPool(missing));
  const { data, error } = await db.from('properties').select('nope').eq('property_id', 'P1');
  assert.equal(data, null);
  assert.equal(error.code, '42703');
});

test('adapter .in() emits an IN list with one placeholder per value', async () => {
  const pool = stubPool();
  const db = createPgRestAdapter(pool);
  await db.from('buyer_comp_raw_v2').select('id,owner_name').in('id', ['a', 'b', 'c']);

  assert.equal(
    pool.calls[0].sql,
    'SELECT "id", "owner_name" FROM "buyer_comp_raw_v2" WHERE "id" IN ($1, $2, $3)',
  );
  assert.deepEqual(pool.calls[0].params, ['a', 'b', 'c']);
});

test('adapter .in() with an empty list matches nothing instead of everything', async () => {
  // PostgREST semantics. Emitting no predicate here would turn "look up these
  // zero comps" into "return the entire comp corpus".
  const pool = stubPool();
  const db = createPgRestAdapter(pool);
  await db.from('buyer_entities_v2').select('buyer_key').in('normalized_buyer_name', []);
  assert.equal(pool.calls[0].sql, 'SELECT "buyer_key" FROM "buyer_entities_v2" WHERE FALSE');
  assert.deepEqual(pool.calls[0].params, []);
});

test('adapter .in() accepts a scalar and wraps it', async () => {
  const pool = stubPool();
  const db = createPgRestAdapter(pool);
  await db.from('t').select('id').in('id', 'solo');
  assert.equal(pool.calls[0].sql, 'SELECT "id" FROM "t" WHERE "id" IN ($1)');
  assert.deepEqual(pool.calls[0].params, ['solo']);
});

test('adapter supports gte/lte/gt/lt range filters', async () => {
  const pool = stubPool();
  const db = createPgRestAdapter(pool);
  await db.from('buyer_comp_raw_v2').select('id')
    .gte('sale_date', '2024-01-01')
    .lte('sale_date', '2026-12-31')
    .gt('sale_price', 0)
    .lt('sale_price', 10_000_000);

  assert.equal(
    pool.calls[0].sql,
    'SELECT "id" FROM "buyer_comp_raw_v2" WHERE "sale_date" >= $1 AND "sale_date" <= $2'
    + ' AND "sale_price" > $3 AND "sale_price" < $4',
  );
  assert.deepEqual(pool.calls[0].params, ['2024-01-01', '2026-12-31', 0, 10_000_000]);
});

test('adapter composes eq + ilike + order + limit deterministically', async () => {
  const pool = stubPool();
  const db = createPgRestAdapter(pool);
  await db.from('properties').select('property_id')
    .ilike('property_address_full', '4100 %')
    .ilike('property_address_full', '%Sandbox%')
    .order('property_id', { ascending: false })
    .limit(25);

  assert.equal(
    pool.calls[0].sql,
    'SELECT "property_id" FROM "properties" WHERE "property_address_full" ILIKE $1'
    + ' AND "property_address_full" ILIKE $2 ORDER BY "property_id" DESC LIMIT 25',
  );
});

test('adapter .rpc() emits named arguments, so parameter order is irrelevant', async () => {
  const pool = stubPool({ rows: [{ comp_id: 'x' }], rowCount: 1 });
  const db = createPgRestAdapter(pool);
  const { data, error } = await db.rpc('get_comp_candidates_for_subject', {
    p_subject_property_id: 'P1',
    p_radius_miles: 4,
    p_months_back: 30,
    p_limit: 100,
  });

  assert.equal(error, null);
  assert.deepEqual(data, [{ comp_id: 'x' }]);
  assert.equal(
    pool.calls[0].sql,
    'SELECT * FROM "get_comp_candidates_for_subject"("p_subject_property_id" => $1,'
    + ' "p_radius_miles" => $2, "p_months_back" => $3, "p_limit" => $4)',
  );
  assert.deepEqual(pool.calls[0].params, ['P1', 4, 30, 100]);
});

test('adapter .rpc() returns the Supabase error envelope, never throws', async () => {
  const boom = Object.assign(new Error('function does not exist'), { code: '42883' });
  const db = createPgRestAdapter(stubPool(boom));
  const { data, error } = await db.rpc('get_comp_candidates_for_subject', { p_subject_property_id: 'P1' });
  assert.equal(data, null);
  assert.equal(error.code, '42883');
});

test('adapter records rpc operations so read-only behaviour is provable', async () => {
  const db = createPgRestAdapter(stubPool({ rows: [], rowCount: 0 }));
  await db.rpc('get_comp_candidates_for_subject', { p_subject_property_id: 'P1' });
  await db.from('buyer_comp_raw_v2').select('id').in('id', ['a']);

  assert.deepEqual(db._operations.map((o) => [o.table, o.method]), [
    ['rpc:get_comp_candidates_for_subject', 'rpc'],
    ['buyer_comp_raw_v2', 'select'],
  ]);
  assert.ok(db._operations.every((o) => o.method === 'rpc' || o.method === 'select'),
    'no write was recorded');
});

test('adapter insert honours RETURNING projection and reports 23505 unchanged', async () => {
  const pool = stubPool({ rows: [{ id: 'r1' }], rowCount: 1 });
  const db = createPgRestAdapter(pool);
  const { data } = await db.from('offerr_evaluation_requests')
    .insert({ id: 'r1', idempotency_key: 'k' })
    .select('id')
    .single();
  assert.deepEqual(data, { id: 'r1' });
  assert.ok(pool.calls[0].sql.endsWith('RETURNING "id"'));

  const dup = Object.assign(new Error('duplicate key'), { code: '23505' });
  const db2 = createPgRestAdapter(stubPool(dup));
  const { error } = await db2.from('offerr_evaluation_requests')
    .insert({ id: 'r1' }).select('*').single();
  assert.equal(error.code, '23505', 'the store branches on this exact code');
});

test('adapter single() reports PGRST116 for an empty result', async () => {
  const db = createPgRestAdapter(stubPool({ rows: [], rowCount: 0 }));
  const { data, error } = await db.from('t').select('*').eq('id', 'nope').single();
  assert.equal(data, null);
  assert.equal(error.code, 'PGRST116');
});

test('adapter maybeSingle() returns null rather than an error for an empty result', async () => {
  const db = createPgRestAdapter(stubPool({ rows: [], rowCount: 0 }));
  const { data, error } = await db.from('t').select('*').eq('id', 'nope').maybeSingle();
  assert.equal(data, null);
  assert.equal(error, null);
});

test('adapter refuses unsafe identifiers in every position', async () => {
  const db = createPgRestAdapter(stubPool());
  // The query builders are PostgREST-style thenables rather than Promises, so
  // each one is adapted before assert.rejects sees it.
  const run = (build) => Promise.resolve().then(build);

  await assert.rejects(run(() => db.from('bad name').select('*')), /unsafe identifier/);
  await assert.rejects(run(() => db.from('t').select('a; DROP TABLE x')), /unsafe identifier/);
  await assert.rejects(run(() => db.from('t').select('*').eq('a"b', 1)), /unsafe identifier/);
  await assert.rejects(run(() => db.from('t').select('*').in('a-b', [1])), /unsafe identifier/);
  await assert.rejects(run(() => db.from('t').select('*').order('x;y')), /unsafe identifier/);
  await assert.rejects(() => db.rpc('fn; DROP TABLE x', {}), /unsafe identifier/);
  await assert.rejects(() => db.rpc('fn', { 'bad arg': 1 }), /unsafe identifier/);
});

test('adapter passes arrays through as arrays, not JSON strings', async () => {
  // buyer_entities_v2.markets_active is text[]; JSON-encoding it would break
  // the insert with a type error.
  const pool = stubPool({ rows: [], rowCount: 0 });
  const db = createPgRestAdapter(pool);
  await db.from('buyer_entities_v2').insert({ buyer_key: 'k', markets_active: ['Houston, TX'] });
  assert.deepEqual(pool.calls[0].params, ['k', ['Houston, TX']]);
});

test('adapter JSON-encodes plain objects for jsonb columns', async () => {
  const pool = stubPool({ rows: [], rowCount: 0 });
  const db = createPgRestAdapter(pool);
  await db.from('offerr_evaluations').insert({ id: 'e1', provenance: { a: 1 } });
  assert.deepEqual(pool.calls[0].params, ['e1', '{"a":1}']);
});
