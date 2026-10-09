/**
 * ENTITY GRAPH · PROPERTY SORT — whole-cohort, page-continuous sorting of the
 * properties browse (v_entity_graph_properties) by any indexed column.
 *
 * Owner (RC 8.3.2): "Year built sorts only the loaded rows, and the next page
 * isn't in the same order." A column sorts the ENTIRE cohort only when the
 * database can produce that order cheaply; everything else stays "sorted
 * within loaded rows" on the client.
 *
 * KEYSET MODE (when a `(col, property_id)` btree exists — see detection):
 *   order = col (nulls last), then property_id; page N+1 continues exactly
 *   after the last row of page N via an opaque `after` token, never OFFSET.
 *   Each page is at most three index-ordered reads through the view, each
 *   with LIMIT (measured 10-04 — the planner drives the view from the base
 *   index and nested-loops the joins for only the rows it returns; a
 *   `rec_*` column with IS NOT NULL reduces the LEFT JOIN to an inner join,
 *   so the summary table's index drives instead):
 *     1. ties:   col = v  AND property_id >/< id   ORDER BY property_id
 *     2. values: col >/< v                         ORDER BY col, property_id
 *        (page 1: col IS NOT NULL)
 *     3. nulls:  col IS NULL AND property_id > id  ORDER BY property_id
 *   Nulls are excluded from 1–2, so the NULLS FIRST/LAST flag is chosen to
 *   match the index scan direction exactly (asc: forward, desc: backward).
 *   Ties need property_id IN the index: measured equity_percent DESC with a
 *   single-column index = incremental sort over a 94K-row tie group, 5.5 s.
 *
 * DEPLOY-SAFE: indexes are detected from pg_index over the direct Postgres
 * connection (cached). No index, no connection, or a failed check ⇒ the
 * column is simply not keyset-sortable, and browse keeps its previous
 * behaviour (offset sort for the four single-column-indexed orders, else the
 * fallback order with sort.sortApplied = false).
 */
import { hasDatabaseUrl, queryWithTimeout } from '@/lib/postgres/client.js'

/** View column → the table/column whose `(column, property_id)` index drives it. */
export const KEYSET_SORT_COLUMNS = Object.freeze({
  year_built: { table: 'properties', column: 'year_built' },
  effective_year_built: { table: 'properties', column: 'effective_year_built' },
  total_bedrooms: { table: 'properties', column: 'total_bedrooms' },
  total_baths: { table: 'properties', column: 'total_baths' },
  building_square_feet: { table: 'properties', column: 'building_square_feet' },
  lot_square_feet: { table: 'properties', column: 'lot_square_feet' },
  units_count: { table: 'properties', column: 'units_count' },
  estimated_value: { table: 'properties', column: 'estimated_value' },
  equity_percent: { table: 'properties', column: 'equity_percent' },
  equity_amount: { table: 'properties', column: 'equity_amount' },
  // estimated_repair_cost is deliberately absent: the vendor repair estimate is
  // not a sort (owner valuation lanes 2026-10-09 — MLS ARV lane only).
  sale_date: { table: 'properties', column: 'sale_date' }, // ISO text (YYYY-MM-DD), sorts lexically
  sale_price: { table: 'properties', column: 'sale_price' },
  zoning: { table: 'properties', column: 'zoning' },
  total_loan_balance: { table: 'properties', column: 'total_loan_balance' },
  ownership_years: { table: 'properties', column: 'ownership_years' },
  market: { table: 'properties', column: 'market' },
  property_address_full: { table: 'properties', column: 'property_address_full' },
  rec_mortgage_balance: { table: 'property_record_summary', column: 'mortgage_balance' },
  rec_last_sale_date: { table: 'property_record_summary', column: 'last_sale_date' },
  rec_mortgage_count: { table: 'property_record_summary', column: 'mortgage_count' },
  rec_lien_count: { table: 'property_record_summary', column: 'lien_count' },
})

const TIE = 'property_id'
const CACHE_MS = 10 * 60_000
let cached = null // { at, set: Set<"table.column"> }

/**
 * Valid, non-partial btree indexes whose first two key columns are
 * (column ASC, property_id ASC) — the exact shape keyset mode scans.
 */
export const SORT_INDEX_SQL = `
  select c.relname as table_name, a1.attname as column_name
    from pg_index i
    join pg_class c on c.oid = i.indrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_class ic on ic.oid = i.indexrelid
    join pg_am am on am.oid = ic.relam
    join pg_attribute a1 on a1.attrelid = i.indrelid and a1.attnum = i.indkey[0]
    join pg_attribute a2 on a2.attrelid = i.indrelid and a2.attnum = i.indkey[1]
   where n.nspname = 'public'
     and c.relname in ('properties', 'property_record_summary')
     and am.amname = 'btree'
     and i.indisvalid and i.indisready and i.indpred is null
     and i.indnkeyatts >= 2
     and a2.attname = 'property_id'
     and (i.indoption[0] & 1) = 0 and (i.indoption[1] & 1) = 0`

/** Set of "table.column" with a usable keyset index. Never throws: failure = empty set. */
export async function detectPropertySortIndexes({ query = queryWithTimeout, now = Date.now(), force = false, available = hasDatabaseUrl } = {}) {
  if (!force && cached && now - cached.at < CACHE_MS) return cached.set
  let set = new Set()
  try {
    if (available()) {
      const result = await query(SORT_INDEX_SQL, [], 5_000)
      set = new Set((result?.rows || []).map((r) => `${r.table_name}.${r.column_name}`))
    }
  } catch {
    set = new Set()
  }
  cached = { at: now, set }
  return set
}
export const __sortIndexCacheTest = { reset: () => { cached = null } }

export function keysetSupported(sortBy, indexSet) {
  const spec = KEYSET_SORT_COLUMNS[sortBy]
  return Boolean(spec && indexSet?.has(`${spec.table}.${spec.column}`))
}

/* ── after-token ─────────────────────────────────────────────────────── */

export function encodeAfter(token) {
  return Buffer.from(JSON.stringify(token), 'utf8').toString('base64url')
}

/** Returns the token only if it belongs to this exact sort; anything else is ignored (page 1). */
export function decodeAfter(raw, { column, ascending }) {
  if (!raw) return null
  try {
    const t = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'))
    if (!t || t.c !== column || t.a !== Boolean(ascending)) return null
    if (typeof t.id !== 'string' || !t.id) return null
    if (t.p === 'n') return { c: t.c, a: t.a, p: 'n', id: t.id }
    if (t.p === 'v' && t.v !== null && t.v !== undefined && (typeof t.v === 'string' || typeof t.v === 'number')) {
      return { c: t.c, a: t.a, p: 'v', v: t.v, id: t.id }
    }
    return null
  } catch {
    return null
  }
}

const isNull = (v) => v === null || v === undefined

/**
 * One keyset page. `base()` returns a fresh, filtered PostgREST query on the
 * view (select already applied). Returns { rows, hasMore, nextAfter }.
 */
export async function fetchKeysetPage({ base, column, ascending, after, pageSize }) {
  const asc = Boolean(ascending)
  const want = pageSize + 1 // one extra row proves hasMore without a count
  const rows = []
  const take = async (query) => {
    const { data, error } = await query.limit(want - rows.length)
    if (error) throw error
    for (const r of data || []) rows.push(r)
  }

  let phase = after?.p || 'v'
  if (phase === 'v') {
    if (after) {
      // 1. the rest of the tie group of the last row
      await take(base().eq(column, after.v)[asc ? 'gt' : 'lt'](TIE, after.id).order(TIE, { ascending: asc }))
      // 2. strictly past the last value
      if (rows.length < want) {
        await take(base()[asc ? 'gt' : 'lt'](column, after.v)
          .order(column, { ascending: asc, nullsFirst: !asc })
          .order(TIE, { ascending: asc }))
      }
    } else {
      await take(base().not(column, 'is', null)
        .order(column, { ascending: asc, nullsFirst: !asc })
        .order(TIE, { ascending: asc }))
    }
    if (rows.length < want) phase = 'n'
  }
  if (phase === 'n' && rows.length < want) {
    // 3. the null tail, by property_id (both directions: nulls are always last)
    let q = base().is(column, null)
    if (after?.p === 'n') q = q.gt(TIE, after.id)
    await take(q.order(TIE, { ascending: true }))
  }

  const hasMore = rows.length > pageSize
  const page = rows.slice(0, pageSize)
  const last = page[page.length - 1]
  const nextAfter = hasMore && last
    ? encodeAfter(isNull(last[column])
      ? { c: column, a: asc, p: 'n', id: String(last[TIE]) }
      : { c: column, a: asc, p: 'v', v: last[column], id: String(last[TIE]) })
    : null
  return { rows: page, hasMore, nextAfter }
}
