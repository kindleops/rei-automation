import test from 'node:test';
import assert from 'node:assert/strict';
import { listOpportunities } from '../../src/lib/domain/opportunity/opportunity-service.js';

/**
 * PIPELINE-MOBILE-LOCK-1B §1 — the Pipeline search clause.
 *
 * Pipeline search is server-side because scope `all` holds 768 opportunities
 * against MAX_LIMIT = 500, so a client-side filter could never reach the
 * remaining 268. What is fragile is the SHAPE of the clause rather than the
 * plumbing:
 *
 *   - `id` is a uuid. PostgREST cannot `ilike` a uuid column — including it in
 *     the or() would make the whole query fail, taking the entire board down
 *     with it (the same class of failure as the phantom-column guard death).
 *     So it is matched with `eq`, and only when the query is a full UUID.
 *   - `primary_property_id` is text, so ilike is correct there and a partial
 *     property id still matches.
 *   - city/state/zip are NOT columns on acquisition_opportunities — they are
 *     hydrated from `properties` after this query — so they must NOT appear in
 *     the clause. They remain reachable through property_address_full, which
 *     carries them as text.
 *
 * Asserted against the builder rather than the database: the point is the
 * predicate that gets sent, and a fake client makes that visible without a
 * network round trip.
 */

/** Records every filter call and returns itself, like the PostgREST builder. */
function captureQuery() {
  const calls = { or: [], eq: [], range: [], select: [] };
  const builder = {
    calls,
    select(...a) { calls.select.push(a); return builder; },
    or(...a) { calls.or.push(a); return builder; },
    eq(...a) { calls.eq.push(a); return builder; },
    not() { return builder; },
    gte() { return builder; },
    lte() { return builder; },
    order() { return builder; },
    in() { return builder; },
    range(...a) { calls.range.push(a); return Promise.resolve({ data: [], count: 0, error: null }); },
  };
  return builder;
}

function fakeClient() {
  const builder = captureQuery();
  return {
    builder,
    from() { return builder; },
  };
}

const runSearch = async (params) => {
  const client = fakeClient();
  await listOpportunities(params, { supabase: client });
  return client.builder.calls;
};

const orClause = (calls) => (calls.or[0]?.[0] ?? '');

test('search matches the fields the operator actually types', async () => {
  const clause = orClause(await runSearch({ q: 'Frauli' }));
  for (const field of [
    'seller_display_name.ilike.%Frauli%',
    'property_address_full.ilike.%Frauli%',
    'market.ilike.%Frauli%',
    'primary_thread_key.ilike.%Frauli%',
    'primary_property_id.ilike.%Frauli%',
    'latest_message_preview.ilike.%Frauli%',
  ]) {
    assert.ok(clause.includes(field), `missing ${field} in: ${clause}`);
  }
});

test('a uuid query matches the opportunity id by equality, never ilike', async () => {
  const id = '1d2a75e1-8526-4ca4-9df8-32acc82ee977';
  const clause = orClause(await runSearch({ q: id }));
  assert.ok(clause.includes(`id.eq.${id}`), `expected an eq match on id, got: ${clause}`);
  // `id.ilike.` on a uuid column errors and takes the whole query with it.
  assert.ok(!/(^|,)id\.ilike\./.test(clause), `id must never be ilike'd: ${clause}`);
});

test('a non-uuid query does not attempt to match the opportunity id', async () => {
  for (const q of ['Frauli', '250991336', '1d2a75e1', '7401 E 48th']) {
    const clause = orClause(await runSearch({ q }));
    assert.ok(!/(^|,)id\.eq\./.test(clause), `partial/non-uuid "${q}" must not filter on id: ${clause}`);
  }
});

test('a property id is searchable as text, so a partial one still matches', async () => {
  const clause = orClause(await runSearch({ q: '250991336' }));
  assert.ok(clause.includes('primary_property_id.ilike.%250991336%'), clause);
});

test('hydrated-only geo fields are not in the clause', async () => {
  const clause = orClause(await runSearch({ q: 'Houston' }));
  for (const absent of ['property_city', 'property_state', 'property_zip']) {
    assert.ok(!clause.includes(absent), `${absent} is hydrated after the query, not filterable: ${clause}`);
  }
  // Reachable through the address text instead.
  assert.ok(clause.includes('property_address_full.ilike.%Houston%'), clause);
});

test('scope and query compose rather than replace each other', async () => {
  // `status` is the scope leg the pipeline routes pass through; it must survive
  // alongside the search, or a search would silently widen the scope.
  const calls = await runSearch({ q: 'Frauli', status: 'dead' });
  assert.ok(calls.eq.some(([col, val]) => col === 'opportunity_status' && val === 'dead'),
    `scope filter lost: ${JSON.stringify(calls.eq)}`);
  assert.ok(orClause(calls).includes('seller_display_name.ilike.%Frauli%'));
});

test('an empty query applies no search predicate at all', async () => {
  for (const q of ['', '   ', undefined]) {
    const calls = await runSearch(q === undefined ? {} : { q });
    assert.equal(calls.or.length, 0, `empty query must not add an or() clause (q=${JSON.stringify(q)})`);
  }
});

test('the response cap stays at 500 — search does not raise it', async () => {
  const calls = await runSearch({ q: 'Frauli', limit: 5000 });
  const [from, to] = calls.range[0];
  assert.equal(from, 0);
  assert.equal(to, 499, 'MAX_LIMIT must remain 500; corpus reach comes from the query, not a bigger page');
});
