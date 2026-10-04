/**
 * Whole-cohort keyset sort for the Entity Graph properties browse: page
 * continuity, nulls last, ties by property_id, and the index-absent fallback.
 * An in-memory PostgREST fake implements the filter / order / limit
 * semantics the keyset reads use, so walking every page must reproduce the
 * exact full sort.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  KEYSET_SORT_COLUMNS,
  SORT_INDEX_SQL,
  __sortIndexCacheTest,
  decodeAfter,
  detectPropertySortIndexes,
  encodeAfter,
  keysetSupported,
} from '../../src/lib/domain/entity-graph/entity-graph-property-sort.js'
import { browseEntityGraph } from '../../src/lib/domain/entity-graph/entity-graph-service.js'

const isNull = (v) => v === null || v === undefined
function cmp(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
}

/** PostgREST-ish fake over `rows`. Records every read. */
function memoryClient(rows) {
  const reads = []
  const from = () => {
    const st = { filters: [], orders: [], limit: Infinity, head: false, offsetRange: null }
    const run = () => {
      let out = rows.filter((r) => st.filters.every((f) => f(r)))
      if (st.orders.length) {
        out = [...out].sort((x, y) => {
          for (const o of st.orders) {
            const a = x[o.col]; const b = y[o.col]
            if (isNull(a) && isNull(b)) continue
            if (isNull(a)) return o.nullsFirst ? -1 : 1
            if (isNull(b)) return o.nullsFirst ? 1 : -1
            const c = cmp(a, b)
            if (c) return o.asc ? c : -c
          }
          return 0
        })
      }
      if (st.offsetRange) out = out.slice(st.offsetRange[0], st.offsetRange[1] + 1)
      if (Number.isFinite(st.limit)) out = out.slice(0, st.limit)
      return out
    }
    const q = {
      select(_c, opts) { st.head = Boolean(opts?.head); return q },
      eq(c, v) { st.filters.push((r) => !isNull(r[c]) && cmp(r[c], v) === 0); return q },
      gt(c, v) { st.filters.push((r) => !isNull(r[c]) && cmp(r[c], v) > 0); return q },
      lt(c, v) { st.filters.push((r) => !isNull(r[c]) && cmp(r[c], v) < 0); return q },
      not(c, op, v) { if (op === 'is' && v === null) st.filters.push((r) => !isNull(r[c])); return q },
      is(c, v) { if (v === null) st.filters.push((r) => isNull(r[c])); return q },
      order(col, opts = {}) { st.orders.push({ col, asc: opts.ascending !== false, nullsFirst: Boolean(opts.nullsFirst) }); return q },
      limit(n) { st.limit = n; reads.push({ ...st }); return Promise.resolve({ data: run(), error: null }) },
      range(a, b) { st.offsetRange = [a, b]; reads.push({ ...st }); return Promise.resolve({ data: run(), error: null }) },
      then(resolve, reject) { return Promise.resolve({ data: null, count: run().length, error: null }).then(resolve, reject) },
    }
    return q
  }
  return { reads, from }
}

// 23 rows: duplicate values (ties), nulls, out-of-order ids.
const ROWS = [
  [1958, 'P10'], [1990, 'P03'], [null, 'P07'], [1958, 'P02'], [2005, 'P15'], [1990, 'P01'],
  [null, 'P04'], [1958, 'P21'], [1975, 'P05'], [2005, 'P06'], [null, 'P20'], [1990, 'P08'],
  [1920, 'P09'], [1958, 'P11'], [2018, 'P12'], [null, 'P13'], [1975, 'P14'], [1990, 'P16'],
  [1958, 'P17'], [2005, 'P18'], [1920, 'P19'], [1999, 'P22'], [1958, 'P23'],
].map(([year_built, property_id]) => ({ property_id, year_built, property_address_full: `${property_id} Main St` }))

function expected(asc) {
  const vals = ROWS.filter((r) => !isNull(r.year_built)).sort((a, b) => {
    const c = a.year_built - b.year_built
    if (c) return asc ? c : -c
    return asc ? cmp(a.property_id, b.property_id) : cmp(b.property_id, a.property_id)
  })
  const nulls = ROWS.filter((r) => isNull(r.year_built)).sort((a, b) => cmp(a.property_id, b.property_id))
  return [...vals, ...nulls].map((r) => r.property_id)
}

async function walk(asc, pageSize) {
  const client = memoryClient(ROWS)
  const deps = { supabase: client, propertySortIndexes: async () => new Set(['properties.year_built']) }
  const seen = []
  let after = null
  let cursor = 0
  let first = null
  for (let guard = 0; guard < 50; guard += 1) {
    const out = await browseEntityGraph({ tab: 'properties', sort_by: 'year_built', ascending: asc ? '1' : '0', page_size: String(pageSize), cursor: String(cursor), ...(after ? { after } : {}) }, deps)
    first = first ?? out
    seen.push(...out.results.map((r) => r.entityId))
    assert.equal(out.pagination.sort.mode, 'keyset')
    if (!out.pagination.hasMore) { assert.equal(out.pagination.nextAfter, null); break }
    after = out.pagination.nextAfter
    cursor = out.pagination.nextCursor
  }
  return { seen, first, client }
}

for (const asc of [true, false]) {
  for (const pageSize of [1, 4, 5, 23, 60]) {
    test(`keyset ${asc ? 'asc' : 'desc'} page ${pageSize}: pages concatenate to the exact full sort (nulls last, ties by id)`, async () => {
      const { seen } = await walk(asc, pageSize)
      assert.deepEqual(seen, expected(asc))
      assert.equal(new Set(seen).size, ROWS.length, 'no duplicates, no gaps')
    })
  }
}

test('page 1 counts the cohort; continuation pages do not re-count and never use OFFSET', async () => {
  const { first, client } = await walk(true, 5)
  assert.equal(first.pagination.total, ROWS.length)
  assert.ok(client.reads.every((r) => r.offsetRange === null), 'keyset reads only')
  // Every value read orders by the column with the nulls flag matching the index scan direction.
  const ordered = client.reads.filter((r) => r.orders[0]?.col === 'year_built')
  assert.ok(ordered.every((r) => r.orders[0].nullsFirst === false && r.orders[1].col === 'property_id'))
})

test('desc reads scan the (col, property_id) index backward: DESC NULLS FIRST on a not-null set', async () => {
  const { client } = await walk(false, 5)
  const ordered = client.reads.filter((r) => r.orders[0]?.col === 'year_built')
  assert.ok(ordered.length > 0)
  assert.ok(ordered.every((r) => r.orders[0].asc === false && r.orders[0].nullsFirst === true && r.orders[1].asc === false))
})

test('index absent: no keyset; the old offset / fallback behaviour is unchanged', async () => {
  const client = memoryClient(ROWS)
  const out = await browseEntityGraph({ tab: 'properties', sort_by: 'year_built', ascending: '1' }, { supabase: client, propertySortIndexes: async () => new Set() })
  assert.equal(out.pagination.sort.sortApplied, false)
  assert.deepEqual(out.pagination.sort.applied, { column: 'property_address_full', ascending: true })
  assert.equal(out.pagination.nextAfter, undefined)
})

test('a token from another sort is ignored (served from page 1), a forged token too', () => {
  const t = encodeAfter({ c: 'year_built', a: true, p: 'v', v: 1958, id: 'P10' })
  assert.deepEqual(decodeAfter(t, { column: 'year_built', ascending: true }), { c: 'year_built', a: true, p: 'v', v: 1958, id: 'P10' })
  assert.equal(decodeAfter(t, { column: 'year_built', ascending: false }), null)
  assert.equal(decodeAfter(t, { column: 'zoning', ascending: true }), null)
  assert.equal(decodeAfter('not-base64-json', { column: 'year_built', ascending: true }), null)
  assert.equal(decodeAfter(encodeAfter({ c: 'year_built', a: true, p: 'v', v: { x: 1 }, id: 'P1' }), { column: 'year_built', ascending: true }), null)
})

test('only whitelisted view columns can be keyset-sorted, and only with their index', () => {
  const set = new Set(['properties.year_built', 'property_record_summary.mortgage_balance'])
  assert.equal(keysetSupported('year_built', set), true)
  assert.equal(keysetSupported('rec_mortgage_balance', set), true)
  assert.equal(keysetSupported('zoning', set), false)
  assert.equal(keysetSupported('raw_payload_json', new Set(['properties.raw_payload_json'])), false)
  assert.equal(KEYSET_SORT_COLUMNS.rec_last_sale_date.table, 'property_record_summary')
})

test('index detection: reads pg_index once per cache window; failure or no DB url = no indexes', async () => {
  __sortIndexCacheTest.reset()
  let calls = 0
  const query = async (sql) => { calls += 1; assert.equal(sql, SORT_INDEX_SQL); return { rows: [{ table_name: 'properties', column_name: 'year_built' }] } }
  const a = await detectPropertySortIndexes({ query, available: () => true, now: 1_000 })
  const b = await detectPropertySortIndexes({ query, available: () => true, now: 2_000 })
  assert.deepEqual([...a], ['properties.year_built'])
  assert.equal(b, a)
  assert.equal(calls, 1)
  const failed = await detectPropertySortIndexes({ query: async () => { throw new Error('down') }, available: () => true, force: true })
  assert.equal(failed.size, 0)
  const none = await detectPropertySortIndexes({ query, available: () => false, force: true })
  assert.equal(none.size, 0)
  __sortIndexCacheTest.reset()
})
