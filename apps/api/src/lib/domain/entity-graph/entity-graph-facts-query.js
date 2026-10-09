/**
 * ENTITY GRAPH · WHOLE-COHORT SORT, FILTER AND HEADER VALUES OVER PROPERTY FACTS.
 *
 * Two modes, one contract (ordered property ids + an exact total):
 *
 *   TABLE   public.eg_property_facts exists and has a successful refresh in
 *           public.eg_refresh_log (PROPOSED read model — not applied). Keyset
 *           pages straight off a (col, property_id) btree; counts and header
 *           value counts are one statement each. Values are "as of" the last
 *           successful refresh, and the response says so.
 *
 *   LIVE    (interim, no migration) the filtered cohort's facts are computed
 *           at request time with the SAME registry the refresh job uses
 *           (entity-graph-facts.js), then ordered / filtered / counted by SQL
 *           over a jsonb_to_recordset relation — so the ORDER BY, the
 *           collation and the filter predicates are the table mode's own SQL.
 *           The ordered id list is cached briefly so page 2…N continue the
 *           same order without recomputing. Bounded: a cohort larger than
 *           LIVE_MAX_COHORT is refused with an honest reason (never sampled,
 *           never truncated).
 *
 * The WHERE clause is never re-implemented: the browse's own appliers run
 * against the facet-sql recorder; clauses touching computed fact columns are
 * split off and applied after the facts exist.
 */
import { hasDatabaseUrl, queryWithTimeout } from '@/lib/postgres/client.js'
import { FacetUntranslatable, compileFacetWhere, selectClauses } from './entity-graph-facet-sql.js'
import {
  baseColumnsFor,
  widenToFamilies,
  COMPUTED_FACT_COLS,
  FACT_BY_COL,
  computeFacts,
  isComputedFactColumn,
  isPlainFactColumn,
  kindOfPg,
  plainColumnType,
} from './entity-graph-facts.js'

export const FACTS_TABLE = 'eg_property_facts'
export const FACTS_SOURCE_VIEW = 'v_entity_graph_properties'
/** Plain columns: one ordered statement over the view, the whole universe fits. */
export const LIVE_MAX_COHORT = 200_000
const LIST_TTL_MS = 3 * 60_000 // ordered id lists (pages 2…N of one sort)
const LIST_CACHE_MAX = 6
const STATE_TTL_MS = 60_000
const TIMEOUT_MS = 25_000

const IDENT = /^[a-z_][a-z0-9_]*$/
const q = (c) => {
  if (!IDENT.test(String(c))) throw new FacetUntranslatable(`identifier ${c}`)
  return `"${c}"`
}

export class FactsCohortTooLarge extends Error {
  constructor(n, limit = LIVE_MAX_COHORT) {
    super(`facts_cohort_too_large: more than ${limit.toLocaleString('en-US')} properties match — narrow the filters to sort / filter by this column until the property facts read model is approved`)
    this.name = 'FactsCohortTooLarge'
    this.code = 'facts_cohort_too_large'
    this.status = 422
    this.cohort = n
    this.limit = limit
  }
}

/* ── mode ─────────────────────────────────────────────────────────────────────── */

let stateCache = null
/** { mode: 'table'|'live'|'off', asOf, rows } — never throws. */
export async function factsState({ query = queryWithTimeout, now = Date.now(), force = false, available = hasDatabaseUrl, env = process.env } = {}) {
  if (!available()) return { mode: 'off', asOf: null }
  if (!force && stateCache && now - stateCache.at < STATE_TTL_MS) return stateCache.value
  let value = { mode: 'live', asOf: null }
  try {
    if (String(env?.EG_FACTS_TABLE_READS ?? 'on').toLowerCase() !== 'off') {
      const res = await query(`select to_regclass('public.${FACTS_TABLE}') is not null as present, to_regclass('public.eg_refresh_log') is not null as logged`, [], 5_000)
      const r = res?.rows?.[0]
      if (r?.present && r?.logged) {
        const log = await query(`select finished_at, rows from public.eg_refresh_log where name = $1 and status = 'ok' order by finished_at desc limit 1`, [FACTS_TABLE], 5_000)
        const last = log?.rows?.[0]
        if (last?.finished_at) value = { mode: 'table', asOf: new Date(last.finished_at).toISOString(), rows: Number(last.rows) || null }
      }
    }
  } catch {
    value = { mode: 'live', asOf: null }
  }
  stateCache = { at: now, value }
  return value
}
export const __factsStateTest = { reset: () => { stateCache = null } }

/* ── shared pieces ────────────────────────────────────────────────────────────── */

/** Canonical order: values asc|desc, property_id in the same direction; nulls last by property_id asc. */
function orderBy(col, ascending, alias = '') {
  const c = `${alias}${q(col)}`
  const id = `${alias}"property_id"`
  return `(${c} is null), ${c} ${ascending ? 'asc' : 'desc'}, case when ${c} is null then ${id} end asc, case when ${c} is not null then ${id} end ${ascending ? 'asc' : 'desc'}`
}

const factPg = (col) => {
  const f = FACT_BY_COL.get(col)
  if (f) return f.pg
  return plainColumnType(col) || 'text'
}

/** Does this sort/value column exist on the facts relation? */
export function factsColumnSupported(col) {
  return isComputedFactColumn(col) || (isPlainFactColumn(col) && Boolean(plainColumnType(col)))
}

function compile(applyFilters) {
  return compileFacetWhere(applyFilters)
}

const touchesComputed = (cols) => [...cols].some((c) => COMPUTED_FACT_COLS.has(c))

/* ── TABLE mode ───────────────────────────────────────────────────────────────── */

export function encodeFactsAfter(token) {
  return Buffer.from(JSON.stringify(token), 'utf8').toString('base64url')
}
export function decodeFactsAfter(raw) {
  if (!raw) return null
  try {
    const t = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'))
    return t && typeof t === 'object' ? t : null
  } catch {
    return null
  }
}

/**
 * One keyset page over eg_property_facts. Phases (same as entity-graph-property-sort):
 *   v: col is not null and (col, id) past the last row   (index-ordered)
 *   n: col is null and id > last id                      (the null tail)
 */
async function tablePage({ col, ascending, compiled, after, pageSize, query }) {
  const want = pageSize + 1
  const base = compiled.where ? `${compiled.where} and` : 'where'
  const rows = []
  const run = async (extra, extraParams, order) => {
    const params = [...compiled.params, ...extraParams]
    const sql = `select "property_id", ${q(col)} as k from public.${FACTS_TABLE} ${base} ${extra} order by ${order} limit ${want - rows.length}`
    const res = await query(sql.replace(/\$X(\d+)/g, (_, n) => `$${compiled.params.length + Number(n)}`), params, TIMEOUT_MS)
    rows.push(...(res?.rows || []))
  }
  const cmp = ascending ? '>' : '<'
  const t = after && after.m === 'table' && after.c === col && after.a === ascending ? after : null
  let phase = t?.p || 'v'
  const pg = factPg(col)
  if (phase === 'v') {
    if (t) await run(`${q(col)} is not null and (${q(col)}, "property_id") ${cmp} ($X1::${pg}, $X2::text)`, [t.v, t.id], `${q(col)} ${ascending ? 'asc' : 'desc'}, "property_id" ${ascending ? 'asc' : 'desc'}`)
    else await run(`${q(col)} is not null`, [], `${q(col)} ${ascending ? 'asc' : 'desc'}, "property_id" ${ascending ? 'asc' : 'desc'}`)
    if (rows.length < want) phase = 'n'
  }
  if (phase === 'n' && rows.length < want) {
    const idAfter = t?.p === 'n' ? t.id : null
    await run(`${q(col)} is null${idAfter ? ' and "property_id" > $X1::text' : ''}`, idAfter ? [idAfter] : [], '"property_id" asc')
  }
  const hasMore = rows.length > pageSize
  const page = rows.slice(0, pageSize)
  const last = page[page.length - 1]
  const nextAfter = hasMore && last
    ? encodeFactsAfter(last.k === null || last.k === undefined
      ? { m: 'table', c: col, a: ascending, p: 'n', id: String(last.property_id) }
      : { m: 'table', c: col, a: ascending, p: 'v', v: last.k instanceof Date ? last.k.toISOString() : last.k, id: String(last.property_id) })
    : null
  return { ids: page.map((r) => String(r.property_id)), hasMore, nextAfter }
}

/* ── LIVE mode ────────────────────────────────────────────────────────────────── */

const listCache = new Map()
const cacheGet = (key, now) => {
  const hit = listCache.get(key)
  if (hit && now - hit.at < LIST_TTL_MS) return hit.value
  if (hit) listCache.delete(key)
  return null
}
const cachePut = (key, value, now) => {
  if (listCache.size >= LIST_CACHE_MAX) listCache.delete(listCache.keys().next().value)
  listCache.set(key, { at: now, value })
}
export const __factsListCacheTest = { reset: () => listCache.clear(), size: () => listCache.size }

/**
 * The live facts relation for a cohort: base rows from the view (plain
 * clauses), facts computed in JS, returned as a jsonb_to_recordset relation
 * text + its single jsonb parameter. `cols` = computed fact columns needed.
 */
/** Cohorts this small compute their facts keyed + live; larger ones read the universe memo. */
export const LIVE_KEYED_COHORT = 1_500
/** Universe facts per column family, reused across cohorts / sorts / filters. */
export const UNIVERSE_MEMO_TTL_MS = 10 * 60_000
const UNIVERSE_MEMO_MAX = 4
const universeMemo = new Map()
const universeInflight = new Map()
export const __factsUniverseMemoTest = { reset: () => { universeMemo.clear(); universeInflight.clear() }, size: () => universeMemo.size }

/** Facts for EVERY property for `cols` (widened to families) — one sequential pass per source, memoised. */
async function universeFacts(cols, { query, deps, now }) {
  const wide = widenToFamilies(cols)
  const key = wide.join(',')
  const hit = universeMemo.get(key)
  if (hit && now - hit.at < UNIVERSE_MEMO_TTL_MS) return hit
  if (universeInflight.has(key)) return universeInflight.get(key)
  const job = (async () => {
    const started = Date.now()
    const baseCols = baseColumnsFor(wide).filter((c) => c === 'property_id' || plainColumnType(c))
    const base = await query(`select ${baseCols.map(q).join(', ')} from public.${FACTS_SOURCE_VIEW}`, [], TIMEOUT_MS)
    const facts = await computeFacts(base?.rows || [], wide, { query, timeoutMs: TIMEOUT_MS, trace: deps.trace || null, keyedMax: 0, entityRoleMode: await roleMode(deps) })
    const value = { at: now, facts, cols: wide, computedMs: Date.now() - started, computedAt: new Date(now).toISOString() }
    if (universeMemo.size >= UNIVERSE_MEMO_MAX) universeMemo.delete(universeMemo.keys().next().value)
    universeMemo.set(key, value)
    return value
  })()
  universeInflight.set(key, job)
  try { return await job } finally { universeInflight.delete(key) }
}

async function roleMode(deps) {
  if (deps.entityRoleMode) return deps.entityRoleMode
  const { entityRoleMode } = await import('@/lib/domain/campaigns/entity-contact-role.js')
  return entityRoleMode()
}

/**
 * The live facts relation for a cohort: the cohort (plain clauses) from the
 * view, its computed facts (keyed + live for a small cohort, the universe memo
 * otherwise), as records + a lazily serialised jsonb_to_recordset relation.
 */
async function liveRelation({ compiled, cols, plainCols, query, deps, now = Date.now() }) {
  const plainClauses = selectClauses(compiled, (c) => !touchesComputed(c))
  const cohortCols = [...new Set(['property_id', ...plainCols])].filter((c) => c === 'property_id' || plainColumnType(c))
  const where = plainClauses.sql ? `where ${plainClauses.sql}` : ''
  const limit = LIVE_MAX_COHORT
  const cohort = await query(`select ${cohortCols.map(q).join(', ')} from public.${FACTS_SOURCE_VIEW} ${where} limit ${limit + 1}`, plainClauses.params, TIMEOUT_MS)
  const rows = cohort?.rows || []
  if (rows.length > limit) throw new FactsCohortTooLarge(rows.length, limit)
  let facts = new Map()
  let asOf = new Date(now).toISOString()
  let source = 'live'
  if (cols.length && rows.length <= LIVE_KEYED_COHORT) {
    const ids = rows.map((r) => String(r.property_id))
    const baseCols = baseColumnsFor(cols).filter((c) => c === 'property_id' || plainColumnType(c))
    const base = ids.length ? await query(`select ${baseCols.map(q).join(', ')} from public.${FACTS_SOURCE_VIEW} where "property_id" = any($1::text[])`, [ids], TIMEOUT_MS) : { rows: [] }
    facts = await computeFacts(base?.rows || [], cols, { query, timeoutMs: TIMEOUT_MS, trace: deps.trace || null, entityRoleMode: await roleMode(deps) })
  } else if (cols.length) {
    const memo = await universeFacts(cols, { query, deps, now })
    facts = memo.facts
    asOf = memo.computedAt
    source = 'memo'
  }
  const allCols = [...new Set(['property_id', ...plainCols, ...cols])]
  const records = rows.map((r) => {
    const id = String(r.property_id)
    const f = facts.get(id) || {}
    const o = {}
    for (const c of allCols) {
      let v = c in f ? f[c] : r[c]
      if (v instanceof Date) v = v.toISOString()
      o[c] = v === undefined ? null : v
    }
    return o
  })
  const defs = allCols.map((c) => `${q(c)} ${factPg(c) === 'jsonb' ? 'jsonb' : factPg(c)}`).join(', ')
  let json = null
  return {
    relation: `jsonb_to_recordset($1::jsonb) as f(${defs})`,
    // serialised only when a statement actually reads the relation
    get json() { if (json === null) json = JSON.stringify(records); return json },
    records,
    baseCount: rows.length,
    asOf,
    source,
  }
}

/** Columns (plain) the computed-fact clauses read: they must ride in the relation. */
function plainColsOfComputedClauses(compiled) {
  const out = new Set()
  compiled.clauseColumns.forEach((cols) => {
    if (!touchesComputed(cols)) return
    for (const c of cols) if (!COMPUTED_FACT_COLS.has(c)) out.add(c)
  })
  return [...out]
}
function computedColsOfClauses(compiled) {
  const out = new Set()
  for (const cols of compiled.clauseColumns) for (const c of cols) if (COMPUTED_FACT_COLS.has(c)) out.add(c)
  return [...out]
}

/**
 * THE cohort relation every facts read runs on: `select … from ${from} ${where}`
 * with `params`, exposing property_id + every column in `columns` + every
 * column the filters read, under alias f.
 *   table  public.eg_property_facts f
 *   live   the view (no computed column needed) or the live jsonb relation
 * @returns {{ from, where, params, mode, asOf, computedMs?, cached? }}
 */
export async function factsCohortRelation({ applyFilters, columns = [], compiled: pre = null, deps = {} }) {
  const query = deps.query || queryWithTimeout
  const now = deps.now ?? Date.now()
  const compiled = pre || compile(applyFilters)
  const state = deps.factsState ? await deps.factsState() : await factsState({ query })
  for (const c of columns) if (c !== 'property_id' && !factsColumnSupported(c)) throw new FacetUntranslatable(`column ${c}`)
  if (state.mode === 'table') return { from: `public.${FACTS_TABLE} f`, where: compiled.where, params: compiled.params, mode: 'table', asOf: state.asOf }
  if (state.mode !== 'live') throw new FacetUntranslatable('facts unavailable (no direct database connection)')
  const computedFilterCols = computedColsOfClauses(compiled)
  const computedWanted = columns.filter((c) => isComputedFactColumn(c))
  if (!computedWanted.length && !computedFilterCols.length) {
    return { from: `public.${FACTS_SOURCE_VIEW} f`, where: compiled.where, params: compiled.params, mode: 'live', asOf: new Date(now).toISOString() }
  }
  const cols = [...new Set([...computedWanted, ...computedFilterCols])]
  const plainCols = [...new Set([...plainColsOfComputedClauses(compiled), ...columns.filter((c) => c !== 'property_id' && !isComputedFactColumn(c))])]
  const key = JSON.stringify(['rel', compiled.where, compiled.params, cols, plainCols])
  let rel = cacheGet(key, now)
  const cached = Boolean(rel)
  if (!rel) {
    const started = Date.now()
    rel = await liveRelation({ compiled, cols, plainCols, query, deps, now })
    rel.computedMs = Date.now() - started
    rel.computedAt = rel.asOf
    cachePut(key, rel, now)
  }
  const factClauses = selectClauses(compiled, (c) => touchesComputed(c), 1)
  return {
    from: rel.relation,
    where: factClauses.sql ? `where ${factClauses.sql}` : '',
    get params() { return [rel.json, ...factClauses.params] },
    records: rel.records,
    source: rel.source,
    mode: 'live',
    asOf: rel.computedAt,
    computedMs: rel.computedMs,
    cached,
  }
}

/** Lowercase-alphanumeric ids order the same by code unit as by the database's ICU collation. */
const PLAIN_ID = /^[0-9a-z]+$/

/**
 * Order `records` by `col` exactly as SQL `orderBy(col)` would: the distinct
 * values are RANKED BY THE DATABASE (its type, its collation), then rows are
 * placed by rank + property_id. Measured on the 176,603-property universe:
 * ordering the jsonb relation in SQL cost 5.2 s; ranking its 12 distinct SMS
 * values + a JS sort costs milliseconds. Returns null when ids are not plain
 * (test fixtures) — the caller then orders in SQL.
 */
async function orderRecordsByRank(records, col, ascending, query) {
  if (!records.every((r) => PLAIN_ID.test(String(r.property_id)))) return null
  const pg = factPg(col)
  const distinct = [...new Set(records.map((r) => r[col]).filter((v) => v !== null && v !== undefined).map((v) => (typeof v === 'string' ? v : JSON.stringify(v))))]
  const rank = new Map()
  if (distinct.length) {
    const res = await query(`select d.v::text as v, (row_number() over (order by d.v asc))::int as r from (select distinct (x)::${pg} as v from unnest($1::text[]) as x) d`, [distinct.map((v) => (v.startsWith('"') ? JSON.parse(v) : v))], TIMEOUT_MS)
    for (const row of res?.rows || []) rank.set(row.v, row.r)
  }
  // the db's text form of each value → rank (numbers / booleans / timestamps normalised by the cast)
  const keyOf = new Map()
  if (distinct.length) {
    const res = await query(`select x as raw, ((x)::${pg})::text as v from unnest($1::text[]) as x`, [distinct.map((v) => (v.startsWith('"') ? JSON.parse(v) : v))], TIMEOUT_MS)
    for (const row of res?.rows || []) keyOf.set(row.raw, rank.get(row.v))
  }
  const dir = ascending ? 1 : -1
  const rk = (r) => {
    const v = r[col]
    if (v === null || v === undefined) return null
    return keyOf.get(typeof v === 'string' ? v : String(v)) ?? null
  }
  const keyed = records.map((r) => ({ id: String(r.property_id), k: rk(r) }))
  keyed.sort((a, b) => {
    if (a.k === null && b.k === null) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    if (a.k === null) return 1
    if (b.k === null) return -1
    if (a.k !== b.k) return (a.k - b.k) * dir
    return (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) * dir
  })
  return keyed.map((x) => x.id)
}

/** Ordered ids of the whole filtered cohort (live). Cached per (where, sort). */
async function liveOrderedIds({ col, ascending, compiled, query, deps, now }) {
  const key = JSON.stringify(['ids', compiled.where, compiled.params, col, ascending])
  const hit = cacheGet(key, now)
  if (hit) return { ...hit, cached: true }
  const started = Date.now()
  const liveDeps = { ...deps, query, now, factsState: async () => ({ mode: 'live' }) }
  const rel = await factsCohortRelation({ compiled, columns: col === 'property_id' ? [] : [col], deps: liveDeps })
  let ids = null
  if (rel.records) {
    // computed facts: filter in SQL (the table mode's predicates), order by db-ranked values
    let records = rel.records
    if (rel.where) {
      const kept = await query(`select f."property_id" from ${rel.from} ${rel.where}`, rel.params, TIMEOUT_MS)
      const set = new Set((kept?.rows || []).map((r) => String(r.property_id)))
      records = records.filter((r) => set.has(String(r.property_id)))
    }
    ids = await orderRecordsByRank(records, col, ascending, query)
  }
  if (!ids) {
    const res = await query(`select f."property_id" from ${rel.from} ${rel.where} order by ${orderBy(col, ascending, 'f.')} limit ${LIVE_MAX_COHORT + 1}`, rel.params, TIMEOUT_MS)
    ids = (res?.rows || []).map((r) => String(r.property_id))
    if (ids.length > LIVE_MAX_COHORT) throw new FactsCohortTooLarge(ids.length)
  }
  const value = { ids, total: ids.length, computedMs: Date.now() - started, computedAt: rel.asOf || new Date(now).toISOString(), source: rel.source || 'live' }
  cachePut(key, value, now)
  return { ...value, cached: false }
}

/* ── public: a page of ordered ids ────────────────────────────────────────────── */

/**
 * @returns {{ ids, total, hasMore, nextAfter, offset, mode, asOf, computedMs?, cached? }}
 */
export async function factsSortedPage({ sortBy, ascending = false, applyFilters, after = null, cursor = 0, pageSize = 25, deps = {} }) {
  const query = deps.query || queryWithTimeout
  const now = deps.now ?? Date.now()
  const col = String(sortBy || 'property_id')
  if (!factsColumnSupported(col) && col !== 'property_id') throw new FacetUntranslatable(`sort ${col}`)
  const compiled = compile(applyFilters)
  const state = deps.factsState ? await deps.factsState() : await factsState({ query })
  const token = decodeFactsAfter(after)
  if (state.mode === 'table') {
    const [page, counted] = await Promise.all([
      tablePage({ col, ascending, compiled, after: token, pageSize, query }),
      token ? Promise.resolve(null) : query(`select count(*)::bigint as n from public.${FACTS_TABLE} ${compiled.where}`, compiled.params, TIMEOUT_MS).catch(() => null),
    ])
    const offset = token && Number.isFinite(Number(token.o)) ? Number(token.o) : (token ? cursor : 0)
    return {
      ids: page.ids,
      total: counted ? Number(counted.rows?.[0]?.n ?? 0) : null,
      hasMore: page.hasMore,
      nextAfter: page.nextAfter,
      offset,
      mode: 'table',
      asOf: state.asOf,
    }
  }
  if (state.mode !== 'live') throw new FacetUntranslatable('facts unavailable (no direct database connection)')
  const list = await liveOrderedIds({ col, ascending, compiled, query, deps, now })
  const start = token && token.m === 'live' && token.c === col && token.a === ascending && Number.isFinite(Number(token.o)) ? Number(token.o) : 0
  const ids = list.ids.slice(start, start + pageSize)
  const end = start + ids.length
  const hasMore = end < list.total
  return {
    ids,
    total: list.total,
    hasMore,
    nextAfter: hasMore ? encodeFactsAfter({ m: 'live', c: col, a: ascending, o: end }) : null,
    offset: start,
    mode: 'live',
    source: list.source,
    asOf: list.computedAt,
    computedMs: list.computedMs,
    cached: list.cached,
  }
}

/** Every property id of the filtered cohort (select-all → campaign), capped. */
export async function factsCohortIds({ applyFilters, cap = 5000, deps = {} }) {
  const page = await factsSortedPage({ sortBy: 'property_id', ascending: true, applyFilters, pageSize: cap, deps })
  return { ids: page.ids, total: page.total, truncated: page.total !== null && page.total > page.ids.length, mode: page.mode, asOf: page.asOf }
}

/* ── header values ────────────────────────────────────────────────────────────── */

const MAX_VALUES = 300

/**
 * The value distribution of one column over the filtered cohort — the header
 * filter's checklist (categorical / boolean / tokens) or range (numeric / date).
 * `applyFilters` should EXCLUDE the column's own filter so other values stay pickable.
 * @returns {{ column, kind, total, known, values?, distinct?, truncated?, range?, mode, asOf }}
 */
export async function factsHeaderValues({ column, applyFilters, deps = {} }) {
  const query = deps.query || queryWithTimeout
  const col = String(column || '')
  if (!factsColumnSupported(col)) throw new FacetUntranslatable(`column ${col}`)
  const kind = FACT_BY_COL.get(col)?.kind || kindOfPg(plainColumnType(col))
  const rel = await factsCohortRelation({ applyFilters, columns: [col], deps })
  const c = `f.${q(col)}`
  const base = { column: col, kind, mode: rel.mode, source: rel.source || rel.mode, asOf: rel.asOf, ...(rel.computedMs !== undefined ? { computedMs: rel.computedMs, cached: rel.cached } : {}) }
  if (rel.records) return { ...base, ...(await countRecords(rel, col, kind, query)) }
  if (kind === 'numeric' || kind === 'date') {
    const res = await query(`select count(*)::bigint as total, count(${c})::bigint as known, min(${c})::text as min, max(${c})::text as max from ${rel.from} ${rel.where}`, rel.params, TIMEOUT_MS)
    const r = res?.rows?.[0] || {}
    return { ...base, total: Number(r.total || 0), known: Number(r.known || 0), range: { min: r.min ?? null, max: r.max ?? null } }
  }
  const valueExpr = kind === 'tokens' ? 'u.v' : `nullif(btrim(${c}::text), '')`
  const from = kind === 'tokens' ? `${rel.from} left join lateral unnest(${c}) as u(v) on true` : rel.from
  const [grouped, counted] = await Promise.all([
    query(`select ${valueExpr} as value, count(distinct f."property_id")::bigint as n from ${from} ${rel.where} group by 1 order by 2 desc, 1 asc nulls last limit ${MAX_VALUES + 1}`, rel.params, TIMEOUT_MS),
    query(`select count(*)::bigint as total, count(${c})::bigint as known from ${rel.from} ${rel.where}`, rel.params, TIMEOUT_MS),
  ])
  const t = counted?.rows?.[0] || {}
  const rows = (grouped?.rows || []).map((r) => ({ value: r.value === null || r.value === undefined ? null : String(r.value), count: Number(r.n || 0) }))
  return { ...base, total: Number(t.total || 0), known: Number(t.known || 0), values: rows.slice(0, MAX_VALUES), truncated: rows.length > MAX_VALUES }
}

/**
 * Header values counted from the live records (exact; the same grouping as the
 * SQL form: btrim, '' = no value, a token counted once per property). Computed
 * filter clauses are still applied by SQL first.
 */
async function countRecords(rel, col, kind, query) {
  let records = rel.records
  if (rel.where) {
    const kept = await query(`select f."property_id" from ${rel.from} ${rel.where}`, rel.params, TIMEOUT_MS)
    const set = new Set((kept?.rows || []).map((r) => String(r.property_id)))
    records = records.filter((r) => set.has(String(r.property_id)))
  }
  const total = records.length
  if (kind === 'numeric' || kind === 'date') {
    let known = 0
    let min = null
    let max = null
    for (const r of records) {
      const v = r[col]
      if (v === null || v === undefined || v === '') continue
      known += 1
      const k = kind === 'numeric' ? Number(v) : String(v)
      if (min === null || k < min) min = k
      if (max === null || k > max) max = k
    }
    return { total, known, range: { min: min === null ? null : String(min), max: max === null ? null : String(max) } }
  }
  const counts = new Map()
  let known = 0
  for (const r of records) {
    const v = r[col]
    if (kind === 'tokens') {
      const list = Array.isArray(v) ? [...new Set(v.map((x) => String(x ?? '').trim()).filter(Boolean))] : []
      if (Array.isArray(v)) known += 1
      if (!list.length) counts.set(null, (counts.get(null) || 0) + 1)
      for (const t of list) counts.set(t, (counts.get(t) || 0) + 1)
      continue
    }
    if (v !== null && v !== undefined) known += 1
    const key = v === null || v === undefined ? null : (String(v).trim() || null)
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  const rows = [...counts.entries()].map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || (a.value === null ? 1 : b.value === null ? -1 : a.value.localeCompare(b.value)))
  return { total, known, values: rows.slice(0, MAX_VALUES), truncated: rows.length > MAX_VALUES }
}

/** Exact count of the filtered cohort on the facts relation (composition / KPIs with fact filters). */
export async function factsCohortCount({ applyFilters, deps = {} }) {
  const query = deps.query || queryWithTimeout
  const rel = await factsCohortRelation({ applyFilters, deps })
  const res = await query(`select count(*)::bigint as n from ${rel.from} ${rel.where}`, rel.params, TIMEOUT_MS)
  return Number(res?.rows?.[0]?.n ?? 0)
}
