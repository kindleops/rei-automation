/**
 * ENTITY GRAPH · OVERVIEW — every field's distribution for the cohort on
 * screen, exact, cross-filtering (spec 9 §4; owner 2026-10-09: "an overview
 * section where it shows the advanced metrics and the graph and the charts and
 * basically a breakdown of all the fields filtered").
 *
 *   GET /api/cockpit/entity-graph/overview?tab=properties&sections=geography,value&<browse filter params>
 *
 * SINGLE AUDIENCE TRUTH. The WHERE clause is the list's own: the browse
 * appliers (applyPropertyFilters + applyEntityGraphFieldFilters) run against
 * the facet-sql RECORDER, so the Overview cannot describe a different cohort
 * than the grid (total == browse total for the same params). Every bucket is
 * either
 *   - `count(*) FILTER (WHERE <the bucket's click filter, compiled the same
 *     way>)` — numeric bands, booleans, derived fields, flag tokens, date
 *     windows; or
 *   - an exact GROUP BY whose key IS the click filter's value — categorical
 *     values (`= any(…)`), date years / months (`between` the bin's bounds),
 *     array elements (`&&`).
 * So a click adds a chip whose cohort is exactly the bar's count. Nothing is
 * sampled; a statement that runs past its budget is "unavailable — retry",
 * never an estimate.
 *
 * DATA-SOURCE SEAM. The relation is chosen per request from what exists:
 *   1. public.eg_property_facts (the PROPOSED narrow read model built by the
 *      facts work) when it exists and carries every column the WHERE and the
 *      section read — computed facts (SMS eligibility, pipeline, owner,
 *      person, contact, ZIP, company status) are only available here;
 *   2. public.v_entity_graph_properties (the browse relation) otherwise —
 *      exact, slower on a cold cache (measured, see the commit).
 * `include_test=1` always reads the view (the read model excludes canaries).
 *
 * ONE SCAN PER STATEMENT: a section is one aggregate statement (coverage,
 * every band as a FILTER, percentiles) + one GROUPING SETS statement
 * (categorical values, date years / months) + one statement per token field.
 * Server LRU (5 min; 10 min for the unfiltered universe, served stale while it
 * re-reads), keyed by relation + SQL + params + the read model's refresh time.
 *
 * Engagement (contacted / replied / positive / inbox bucket / pipeline stage)
 * is not a property column: the per-property engagement facts (~15K
 * properties: inbox threads, campaign-graph contact timestamps, deals) are
 * read once per 5 minutes and intersected with the cohort by property id.
 */
import { createHash } from 'node:crypto'
import { hasDatabaseUrl, queryWithTimeout } from '@/lib/postgres/client.js'
import { createSqlRecorder, FacetUntranslatable } from './entity-graph-facet-sql.js'
import { applyEntityGraphFieldFilters, resolveEntityGraphFieldFilters, resolveEntityGraphFieldFiltersOrThrow } from './entity-graph-field-filters.js'
import { applyPropertyFilters, parseBrowseFilters } from './entity-graph-service.js'
import { propertySmsEligibility } from './entity-graph-outreach-state.js'
import {
  CATEGORICAL_TOP,
  OVERVIEW_COMPANY_FIELDS,
  OVERVIEW_PINNED,
  OVERVIEW_SECTIONS,
  OVERVIEW_TAB,
  numericBinsFor,
  overviewRegistry,
} from './entity-graph-overview-catalog.js'

const VIEW = 'v_entity_graph_properties'
const FACTS = 'eg_property_facts'
const SNAPSHOT = 'eg_overview_snapshot'
const STATEMENT_MS = 8_000
const UNIVERSE_STATEMENT_MS = 30_000
const CACHE_TTL_MS = 5 * 60_000
const UNIVERSE_TTL_MS = 10 * 60_000
const CACHE_MAX = 300
const SCHEMA_TTL_MS = 10 * 60_000
const ENGAGEMENT_TTL_MS = 5 * 60_000
const LIVE_SMS_MAX = 10_000
const DISTINCT_MAX_COHORT = 50_000
const GROUP_SETS_PER_STATEMENT = 40
const GHOST_MAX = 5
const CONCURRENCY = 2

const clean = (v) => String(v ?? '').trim()
// computed-fact filters compile here; the relation choice then requires the facts read model for them
const FACTS_OK = Object.freeze({ allowComputedFacts: true })
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v))

/* ── shared state (process-local) ─────────────────────────────────────────── */

const cache = new Map()
let schemaMemo = null
let engagementMemo = null
let engagementLoading = null

export const __overviewTest = {
  reset() { cache.clear(); schemaMemo = null; engagementMemo = null; engagementLoading = null },
}

function cacheGet(key, now) {
  const hit = cache.get(key)
  if (!hit) return null
  if (now - hit.at < hit.ttl) return { rows: hit.rows, fresh: true }
  return { rows: hit.rows, fresh: false }
}
function cachePut(key, rows, ttl, now) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value)
  cache.set(key, { at: now, rows, ttl })
}

/* ── SQL helpers ──────────────────────────────────────────────────────────── */

const IDENT = /^[a-z_][a-z0-9_]*$/
function q(column) {
  const c = String(column ?? '')
  if (!IDENT.test(c)) throw new FacetUntranslatable(`identifier ${c}`)
  return `"${c}"`
}

/** A parameter list a statement grows; recorded clauses are renumbered into it. */
export function paramList(initial = []) {
  const list = [...initial]
  return {
    list,
    bind(value) { list.push(value); return `$${list.length}` },
    embed(clauses, params) {
      const offset = list.length
      list.push(...params)
      const sql = clauses.map((c) => c.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + offset}`))
      return sql.length ? sql.join(' and ') : 'true'
    },
  }
}

function record(apply) {
  const recorder = createSqlRecorder()
  let result
  try {
    result = apply(recorder.builder)
  } catch (error) {
    if (error instanceof TypeError) throw new FacetUntranslatable(error.message)
    throw error
  }
  if (result && result !== recorder.builder) throw new FacetUntranslatable('applier returned a foreign builder')
  return { clauses: recorder.clauses, params: recorder.params }
}

/** Every identifier a compiled SQL fragment reads. */
export function columnsIn(sql) {
  const out = new Set()
  for (const m of String(sql).matchAll(/"([a-z_][a-z0-9_]*)"/g)) out.add(m[1])
  return out
}

/** A click filter (the rail's AST entry) → its resolved entry, or null when the catalog would refuse it. */
function resolveFilter(filter) {
  if (!filter) return null
  const { resolved, unsupported } = resolveEntityGraphFieldFilters(OVERVIEW_TAB, [filter], FACTS_OK)
  return unsupported.length || !resolved.length ? null : resolved[0]
}

/** The click filter, compiled exactly as the list compiles it, as one predicate in `P`. */
function predicateFor(filter, P) {
  const entry = resolveFilter(filter)
  if (!entry) return null
  const { clauses, params } = record((b) => applyEntityGraphFieldFilters(b, [entry]))
  if (!clauses.length) return null
  return P.embed(clauses, params)
}

/** The columns a field reads: its own, or — for a derived field — the ones its filter compiles to. */
function fieldColumns(field) {
  if (!field.derived) return new Set([field.column])
  const sample = field.kind === 'derived_boolean'
    ? { field_key: field.key, operator: 'is_true', value: null }
    : { field_key: field.key, operator: 'gte', value: 0 }
  const pred = predicateFor(sample, paramList())
  return pred ? columnsIn(pred) : new Set([field.column])
}

/* ── the cohort ───────────────────────────────────────────────────────────── */

/** The list's WHERE for these params, as clauses + params (never re-implemented). */
export function compileCohort(params = {}, { exceptFieldKey = null } = {}) {
  const filters = parseBrowseFilters(params)
  const { resolved } = resolveEntityGraphFieldFiltersOrThrow(OVERVIEW_TAB, params, FACTS_OK)
  const fieldFilters = exceptFieldKey ? resolved.filter((r) => r.field_key !== exceptFieldKey) : resolved
  const { clauses, params: values } = record((b) => applyEntityGraphFieldFilters(applyPropertyFilters(b, filters), fieldFilters))
  return { clauses, params: values, filters, fieldFilters: resolved, includeTest: Boolean(filters.includeTest) }
}

function isUnfiltered(cohort, params) {
  const f = cohort.filters
  const browseFilterSet = ['market', 'city', 'state', 'zip', 'assetType', 'county'].some((k) => clean(f[k])) || f.unitsMin !== null || f.unitsMax !== null
  return !browseFilterSet && !cohort.fieldFilters.length && !cohort.includeTest && !clean(params.q)
}

/* ── schema (which relations exist, with which columns) ──────────────────── */

async function loadSchema(query, now) {
  if (schemaMemo && now - schemaMemo.at < SCHEMA_TTL_MS) return schemaMemo.value
  const { rows } = await query(
    `select table_name, column_name, data_type from information_schema.columns
      where table_schema = 'public' and table_name = any($1::text[])`,
    [[VIEW, FACTS, SNAPSHOT, 'eg_refresh_log']],
    STATEMENT_MS,
  )
  const value = {}
  for (const r of rows || []) {
    value[r.table_name] = value[r.table_name] || new Map()
    value[r.table_name].set(r.column_name, r.data_type)
  }
  schemaMemo = { at: now, value }
  return value
}

/** Pick the relation: the facts read model when it covers `needed`, else the view. */
export function chooseRelation(schema, needed, { includeTest = false } = {}) {
  const covers = (rel) => schema[rel] && [...needed].every((c) => schema[rel].has(c))
  if (!includeTest && covers(FACTS)) return { relation: FACTS, mode: 'facts' }
  if (covers(VIEW)) return { relation: VIEW, mode: 'view' }
  return null
}

/* ── per-field statement parts ────────────────────────────────────────────── */

const yearBounds = (y, pg) => (/timestamp/.test(pg) ? [`${y}-01-01T00:00:00Z`, `${y}-12-31T23:59:59.999999Z`] : [`${y}-01-01`, `${y}-12-31`])
function monthBounds(ym, pg) {
  const [y, m] = ym.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const mm = String(m).padStart(2, '0')
  return /timestamp/.test(pg) ? [`${y}-${mm}-01T00:00:00Z`, `${y}-${mm}-${last}T23:59:59.999999Z`] : [`${y}-${mm}-01`, `${y}-${mm}-${String(last).padStart(2, '0')}`]
}
function dateGroupExprs(col, pg) {
  if (/timestamp/.test(pg)) return { year: `to_char(${q(col)} at time zone 'UTC', 'YYYY')`, month: `to_char(${q(col)} at time zone 'UTC', 'YYYY-MM')` }
  if (pg === 'date') return { year: `to_char(${q(col)}, 'YYYY')`, month: `to_char(${q(col)}, 'YYYY-MM')` }
  // ISO text dates (facts.last_sale_on): only well-formed values are binned
  return {
    year: `case when ${q(col)}::text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then left(${q(col)}::text, 4) end`,
    month: `case when ${q(col)}::text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then left(${q(col)}::text, 7) end`,
  }
}

const bandFilter = (key, band) => (band.lo !== null && band.hi !== null
  ? { field_key: key, operator: 'between', value: [band.lo, band.hi] }
  : band.lo !== null ? { field_key: key, operator: 'gte', value: band.lo } : { field_key: key, operator: 'lte', value: band.hi })

const isoDay = (d) => d.toISOString().slice(0, 10)

/**
 * The plan for one field: aggregate slots (FILTER counts, coverage, stats),
 * grouping sets, or a token statement. `pg` is the column's type on the relation.
 */
function planField(field, pg, P, ctx) {
  const { now, edgeHints } = ctx
  const key = field.key
  const col = field.column
  const agg = []
  const groups = []
  let tokens = null
  const add = (slot, sql) => agg.push({ slot, sql })
  const filtered = (slot, filter) => {
    const pred = predicateFor(filter, P)
    if (pred) add(slot, `count(*) filter (where ${pred})`)
    return Boolean(pred)
  }
  const plan = { field, pg, agg, groups, tokens: null, bands: null, windows: null }

  if (field.kind === 'coverage') {
    add('known', /char|text/.test(pg) || !pg ? `count(nullif(btrim(${q(col)}::text), ''))` : `count(${q(col)})`)
  } else if (field.kind === 'boolean') {
    add('known', `count(${q(col)})`)
    plan.yes = filtered('yes', { field_key: key, operator: 'is_true', value: null })
    plan.no = filtered('no', { field_key: key, operator: 'is_false', value: null })
  } else if (field.kind === 'derived_boolean') {
    plan.yes = filtered('yes', { field_key: key, operator: 'is_true', value: null })
  } else if (field.kind === 'numeric' || field.kind === 'derived_number') {
    const integer = /integer|bigint|smallint/.test(pg || '')
    const bands = numericBinsFor(col, { format: field.format, integer, range: edgeHints?.[col] || null })
    if (!bands) {
      plan.needsEdges = true
      add('known', `count(${q(col)})`)
      return plan
    }
    plan.bands = bands.filter((b) => filtered(`b:${b.key}`, bandFilter(key, b)))
    if (field.kind === 'numeric') {
      add('known', `count(${q(col)})`)
      add('stats', `percentile_cont(array[0.25, 0.5, 0.75]) within group (order by ${q(col)})`)
      add('min', `min(${q(col)})::float8`)
      add('max', `max(${q(col)})::float8`)
    } else {
      // derived (known equity): "known" is the derived filter with no bound
      filtered('known', { field_key: key, operator: 'gte', value: -1e15 })
    }
  } else if (field.kind === 'date') {
    add('known', `count(${q(col)})`)
    add('min', `min(${q(col)})::text`)
    add('max', `max(${q(col)})::text`)
    const today = new Date(now)
    plan.windows = [30, 90, 365].map((days) => {
      const since = isoDay(new Date(today.getTime() - days * 86_400_000))
      return { key: `d${days}`, label: `Within ${days} days`, filter: { field_key: key, operator: 'on_or_after', value: since } }
    }).filter((w) => filtered(`w:${w.key}`, w.filter))
    const ex = dateGroupExprs(col, pg)
    groups.push({ id: `${key}|year`, expr: ex.year }, { id: `${key}|month`, expr: ex.month })
  } else if (field.kind === 'categorical') {
    groups.push({ id: `${key}|value`, expr: `${q(col)}::text` })
  } else if (field.kind === 'tokens' || field.kind === 'array') {
    const isArray = field.kind === 'array' || /\[\]|ARRAY/.test(pg || '')
    add('known', isArray ? `count(*) filter (where cardinality(${q(col)}) > 0)` : `count(nullif(btrim(${q(col)}::text), ''))`)
    tokens = { mode: isArray ? 'array' : 'split', separator: field.tokenSeparator || '; ' }
    plan.tokens = tokens
  }
  return plan
}

/* ── statements ───────────────────────────────────────────────────────────── */

async function run(ctx, sql, params, label) {
  const key = `${ctx.relation}|${ctx.factsRefreshedAt || ''}|${sql}|${JSON.stringify(params)}`
  const hit = cacheGet(key, ctx.now)
  if (hit?.fresh) return hit.rows
  const t0 = Date.now()
  const exec = ctx.query(sql, params, ctx.timeoutMs).then((res) => {
    const rows = res?.rows || []
    cachePut(key, rows, ctx.ttlMs || (ctx.unfiltered ? UNIVERSE_TTL_MS : CACHE_TTL_MS), Date.now())
    ctx.timings.push({ label, ms: Date.now() - t0, cached: false })
    return rows
  })
  // the unfiltered universe is served stale while it re-reads
  if (hit && ctx.unfiltered) {
    exec.catch(() => {})
    ctx.timings.push({ label, ms: 0, cached: 'stale' })
    return hit.rows
  }
  return exec
}

function whereSql(ctx, P) {
  return `where ${P.embed(ctx.cohort.clauses, ctx.cohort.params)}`
}

/** flagTokenPatterns' own sanitising: the token a chip value actually matches. */
export const sanitizeToken = (t) => String(t ?? '').replace(/[^A-Za-z0-9 +\-/&']/g, '').trim()

/**
 * The tokens of a delimited text column, each counted per row EXACTLY as its
 * click filter matches (applyEntityGraphFieldFilters → flagTokenPatterns:
 * ilike `t`, `t<core>%`, `%<sep>t`, `%<sep>t<core>%`). Split on the core
 * character, a row carries token t iff its FIRST piece is t, or a LATER piece
 * is <sep minus core>t (the "; " lead) — case-insensitively. That is the four
 * patterns, piece by piece, so the grouped count equals the chip's cohort
 * without one ilike scan per token (24 s on the universe vs one split).
 */
function tokenSql(plan, P, from) {
  const col = q(plan.field.column)
  if (plan.tokens.mode === 'array') {
    return `select s.__tok as k, s.__tok as label, count(*)::bigint as n
              from ${from} cross join lateral (select distinct x as __tok from unnest(${col}) as x where x is not null and btrim(x) <> '') s
             group by 1 order by 3 desc, 1 limit 200`
  }
  const sep = plan.tokens.separator || '; '
  const core = sep.trim() || sep
  const lead = sep.startsWith(core) ? sep.slice(core.length) : ''
  const split = P.bind(core.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const later = lead ? `when left(x.p, ${lead.length}) = ${P.bind(lead)} then substr(x.p, ${lead.length + 1})` : 'else x.p'
  return `select s.__tok as k, min(s.__orig) as label, count(*)::bigint as n
            from ${from} cross join lateral (
              select distinct on (lower(y.t)) lower(y.t) as __tok, y.t as __orig
                from (select case when x.o = 1 then x.p ${later} end as t
                        from regexp_split_to_table(coalesce(${col}::text, ''), ${split}) with ordinality as x(p, o)) y
               where y.t is not null and y.t <> ''
               order by lower(y.t), y.t) s
           group by 1 order by 3 desc, 1 limit 200`
}

function groupsSql(sets, from) {
  const which = `case ${sets.map((s, j) => `when grouping(${s.expr}) = 0 then ${j}`).join(' ')} end`
  const keyExpr = `case ${sets.map((s) => `when grouping(${s.expr}) = 0 then (${s.expr})::text`).join(' ')} end`
  return `select gi, k, n, cnt from (
            select gi, k, n,
                   row_number() over (partition by gi order by (k is null) desc, n desc, k) as rn,
                   count(*) over (partition by gi) as cnt
              from (select ${which} as gi, ${keyExpr} as k, count(*)::bigint as n
                      from ${from}
                     group by grouping sets (${sets.map((s) => `(${s.expr})`).join(', ')})) g
          ) w where rn <= 501`
}

/**
 * ONE statement, ONE scan of the relation: the cohort's needed columns are
 * materialised once, then every aggregate (coverage, FILTER bands, percentiles,
 * extra headline counts), every grouping set and every token field is read
 * from that. On a cold cache the relation scan is the whole cost (the
 * properties heap is ~350 MB: 11–13 s cold, ~1 s warm), so a section must
 * never scan it twice.
 */
async function runCohortStatement(ctx, plans, extraAgg = null) {
  const P = paramList()
  const where = P.embed(ctx.cohort.clauses, ctx.cohort.params)
  const fragments = [where]
  const slots = []
  const aggExprs = []
  for (const plan of plans) {
    const fresh = planField(plan.field, plan.pg, P, ctx)
    plan.fresh = fresh
    for (const a of fresh.agg) {
      const alias = `a${slots.length}`
      slots.push({ plan, slot: a.slot, alias })
      aggExprs.push(`${a.sql} as "${alias}"`)
      fragments.push(a.sql)
    }
  }
  const extras = extraAgg ? extraAgg(P) : []
  for (const e of extras) { aggExprs.push(`${e.sql} as "${e.alias}"`); fragments.push(e.sql) }
  const sets = plans.flatMap((plan) => plan.fresh.groups)
  for (const g of sets) fragments.push(g.expr)
  const from = 'c'
  const tokenPlans = plans.filter((p) => p.fresh.tokens)
  const tokenParts = tokenPlans.map((p) => { p.fresh.tokens = p.tokens || p.fresh.tokens; const sql = tokenSql(p.fresh, P, from); fragments.push(sql); return { plan: p, sql } })
  const relCols = ctx.schema[ctx.relation]
  const cols = [...new Set([...fragments.flatMap((f) => [...columnsIn(f)])])].filter((c) => relCols.has(c))
  const select = cols.length ? cols.map(q).join(', ') : q('property_id')
  const groupBatches = []
  for (let i = 0; i < sets.length; i += GROUP_SETS_PER_STATEMENT) groupBatches.push(sets.slice(i, i + GROUP_SETS_PER_STATEMENT))
  const sql = `with c as materialized (select ${select} from public.${q(ctx.relation)} where ${where})
    select (select row_to_json(a) from (select count(*)::bigint as "t"${aggExprs.length ? `, ${aggExprs.join(', ')}` : ''} from c) a) as agg
    ${groupBatches.map((batch, i) => `, (select coalesce(json_agg(gw), '[]'::json) from (${groupsSql(batch, from)}) gw) as "g${i}"`).join('\n')}
    ${tokenParts.map((t, i) => `, (select coalesce(json_agg(tk), '[]'::json) from (${t.sql}) tk) as "k${i}"`).join('\n')}`
  const [row] = await run(ctx, sql, P.list, plans.length ? `cohort(${plans.length} fields)` : 'cohort(headline)')
  const agg = row?.agg || {}
  const total = num(agg.t) ?? 0
  const values = new Map()
  for (const s of slots) {
    if (!values.has(s.plan)) values.set(s.plan, {})
    values.get(s.plan)[s.slot] = agg[s.alias]
  }
  const groups = new Map()
  groupBatches.forEach((batch, i) => {
    for (const r of row?.[`g${i}`] || []) {
      const set = batch[Number(r.gi)]
      if (!set) continue
      if (!groups.has(set.id)) groups.set(set.id, { values: [], distinct: Number(r.cnt) })
      groups.get(set.id).values.push({ key: r.k === null || r.k === undefined ? null : String(r.k), count: Number(r.n) })
    }
  })
  const tokens = new Map()
  tokenParts.forEach((t, i) => tokens.set(t.plan, (row?.[`k${i}`] || []).map((r) => ({ key: String(r.k), label: clean(r.label ?? r.k), count: Number(r.n) }))))
  return { total, values, groups, tokens, extras: agg }
}

/** Exact distinct counts for coverage fields — only where cheap (cohort ≤ 50,000). */
async function runDistinct(ctx, plans) {
  const P = paramList()
  const where = whereSql(ctx, P)
  const exprs = plans.map((p, i) => `count(distinct nullif(btrim(${q(p.field.column)}::text), '')) as "d${i}"`)
  const [row] = await run(ctx, `select ${exprs.join(', ')} from public.${q(ctx.relation)} ${where}`, P.list, 'distinct')
  return new Map(plans.map((p, i) => [p, num(row?.[`d${i}`])]))
}

/** Universe p02 / p98 for numeric columns without catalog edges (the read model only), cached an hour. */
const edgeMemo = new Map()
async function loadEdgeHints(ctx, plans) {
  const need = plans.filter((p) => p.needsEdges).map((p) => p.field.column).filter((c) => !edgeMemo.has(`${ctx.relation}|${c}`))
  if (need.length) {
    const exprs = need.flatMap((c, i) => [
      `percentile_disc(0.02) within group (order by ${q(c)})::float8 as "lo${i}"`,
      `percentile_disc(0.98) within group (order by ${q(c)})::float8 as "hi${i}"`,
      `bool_and(${q(c)} = trunc(${q(c)})) as "int${i}"`,
    ])
    const [row] = await run({ ...ctx, unfiltered: true }, `select ${exprs.join(', ')} from public.${q(ctx.relation)}`, [], 'edges')
    need.forEach((c, i) => {
      const lo = num(row?.[`lo${i}`])
      const hi = num(row?.[`hi${i}`])
      edgeMemo.set(`${ctx.relation}|${c}`, Number.isFinite(lo) && Number.isFinite(hi) ? { lo, hi, integer: Boolean(row?.[`int${i}`]) } : null)
    })
  }
  const hints = {}
  for (const p of plans) if (p.needsEdges) hints[p.field.column] = edgeMemo.get(`${ctx.relation}|${p.field.column}`) || null
  return hints
}

/* ── shaping ──────────────────────────────────────────────────────────────── */

const pct = (n, d) => (d ? n / d : null)

function categoricalBuckets(field, group, total) {
  const values = group?.values || []
  const blankKey = values.find((v) => v.key === null)
  const notRecorded = blankKey?.count || 0
  const blanks = values.filter((v) => v.key !== null && v.key.trim() === '')
  const blankCount = blanks.reduce((s, v) => s + v.count, 0)
  const valued = values.filter((v) => v.key !== null && v.key.trim() !== '')
  const shown = valued.slice(0, CATEGORICAL_TOP)
  const canAny = field.operators.includes('is_any_of')
  const buckets = shown.map((v) => ({
    key: v.key,
    label: v.key.trim(),
    count: v.count,
    // a stored value with surrounding spaces is not what the chip would match — shown, not clickable
    filter: canAny && v.key === v.key.trim() ? { field_key: field.key, operator: 'is_any_of', value: [v.key] } : null,
    tone: 'value',
  }))
  const known = total - notRecorded - blankCount
  const other = known - shown.reduce((s, v) => s + v.count, 0)
  if (other > 0) buckets.push({ key: '__other', label: 'Everything else', count: other, filter: null, tone: 'other' })
  if (blankCount > 0) buckets.push({ key: '__blank_text', label: 'Blank', count: blankCount, filter: null, tone: 'none' })
  if (notRecorded > 0) buckets.push({ key: '__none', label: field.section === 'outreach' ? 'Not classified' : 'Not recorded', count: notRecorded, filter: field.operators.includes('is_empty') ? { field_key: field.key, operator: 'is_empty', value: null } : null, tone: 'none' })
  const truncated = group && group.distinct > 501
  return { buckets, known, distinct: group ? group.distinct - (blankKey ? 1 : 0) : 0, truncated }
}

function dateBuckets(field, years, months, total, known) {
  const yv = (years?.values || []).filter((v) => v.key)
  const keys = yv.map((v) => Number(v.key)).filter(Number.isFinite)
  const minY = keys.length ? Math.min(...keys) : null
  const maxY = keys.length ? Math.max(...keys) : null
  const canBetween = field.operators.includes('between')
  const buckets = []
  let grain = 'year'
  if (minY !== null && maxY - minY <= 2) {
    grain = 'month'
    const mv = (months?.values || []).filter((v) => v.key).sort((a, b) => a.key.localeCompare(b.key))
    for (const v of mv) {
      const [lo, hi] = monthBounds(v.key, field.pg)
      buckets.push({ key: v.key, label: v.key, count: v.count, filter: canBetween ? { field_key: field.key, operator: 'between', value: [lo, hi] } : null, tone: 'value' })
    }
  } else {
    // yearly over the densest 30-year window; years outside fold into exact "Before" / "After" bins
    const sorted = [...yv].sort((a, b) => Number(a.key) - Number(b.key))
    let from = minY
    if (maxY !== null && maxY - minY > 29) {
      let best = -1
      for (let y = minY; y <= maxY - 29; y += 1) {
        const sum = sorted.reduce((acc, v) => acc + (Number(v.key) >= y && Number(v.key) <= y + 29 ? v.count : 0), 0)
        if (sum > best) { best = sum; from = y }
      }
    }
    const to = from !== null ? from + 29 : null
    const early = sorted.filter((v) => Number(v.key) < from)
    const late = sorted.filter((v) => Number(v.key) > to)
    if (early.length) {
      buckets.push({ key: `lt_${from}`, label: `Before ${from}`, count: early.reduce((acc, v) => acc + v.count, 0), filter: field.operators.includes('on_or_before') ? { field_key: field.key, operator: 'on_or_before', value: yearBounds(from - 1, field.pg)[1] } : null, tone: 'value' })
    }
    for (const v of sorted.filter((x) => Number(x.key) >= from && Number(x.key) <= to)) {
      const [lo, hi] = yearBounds(v.key, field.pg)
      buckets.push({ key: v.key, label: v.key, count: v.count, filter: canBetween ? { field_key: field.key, operator: 'between', value: [lo, hi] } : null, tone: 'value' })
    }
    if (late.length) {
      buckets.push({ key: `gt_${to}`, label: `After ${to}`, count: late.reduce((acc, v) => acc + v.count, 0), filter: field.operators.includes('on_or_after') ? { field_key: field.key, operator: 'on_or_after', value: yearBounds(to + 1, field.pg)[0] } : null, tone: 'value' })
    }
  }
  const missing = total - known
  if (missing > 0) buckets.push({ key: '__none', label: 'Not recorded', count: missing, filter: field.operators.includes('is_empty') ? { field_key: field.key, operator: 'is_empty', value: null } : null, tone: 'none' })
  return { buckets, grain }
}

function shapeField(plan, { total, values, groups, tokens = new Map(), distinct }) {
  const field = plan.field
  const v = values.get(plan) || {}
  const base = {
    key: field.key, label: field.label, kind: field.kind, format: field.format, section: field.section, column: field.column,
    privacy: field.privacy, computedFact: field.computedFact, emptySource: field.emptySource, pinned: field.pinned,
    ...(field.caution ? { caution: field.caution } : {}),
  }
  const coverage = (known) => ({ known, total, share: pct(known, total) })
  if (field.kind === 'coverage') {
    const known = num(v.known) ?? 0
    return { ...base, coverage: coverage(known), buckets: [], distinct: distinct ?? null, note: field.privacy === 'coverage_only' ? 'Identifier or personal field — coverage only; values never leave the server.' : 'More than 500 distinct values — coverage and distinct count only.' }
  }
  if (field.kind === 'boolean') {
    const yes = num(v.yes) ?? 0
    const no = num(v.no) ?? 0
    const known = num(v.known) ?? yes + no
    const buckets = [
      { key: 'yes', label: 'Yes', count: yes, filter: plan.fresh.yes ? { field_key: field.key, operator: 'is_true', value: null } : null, tone: 'yes' },
      { key: 'no', label: 'No', count: no, filter: plan.fresh.no ? { field_key: field.key, operator: 'is_false', value: null } : null, tone: 'no' },
    ]
    if (total - yes - no > 0) buckets.push({ key: '__none', label: 'Not recorded', count: total - yes - no, filter: field.operators.includes('is_empty') ? { field_key: field.key, operator: 'is_empty', value: null } : null, tone: 'none' })
    return { ...base, coverage: coverage(known), buckets }
  }
  if (field.kind === 'derived_boolean') {
    const yes = num(v.yes) ?? 0
    return {
      ...base,
      coverage: coverage(total),
      buckets: [
        { key: 'yes', label: 'Yes', count: yes, filter: plan.fresh.yes ? { field_key: field.key, operator: 'is_true', value: null } : null, tone: 'yes' },
        { key: 'no', label: 'No / not on file', count: total - yes, filter: null, tone: 'none' },
      ],
    }
  }
  if (field.kind === 'numeric' || field.kind === 'derived_number') {
    const known = num(v.known) ?? 0
    if (!plan.fresh.bands) {
      return { ...base, coverage: coverage(known), buckets: [], note: 'No histogram range for this field yet.' }
    }
    const buckets = plan.fresh.bands.map((b) => ({ key: b.key, label: b.label, count: num(v[`b:${b.key}`]) ?? 0, filter: bandFilter(field.key, b), tone: 'value', lo: b.lo, hi: b.hi }))
    // drop empty open-ended tails so a histogram does not start with "Under …: 0"
    while (buckets.length && buckets[0].count === 0 && buckets[0].lo === null) buckets.shift()
    while (buckets.length && buckets[buckets.length - 1].count === 0 && buckets[buckets.length - 1].hi === null) buckets.pop()
    if (total - known > 0) buckets.push({ key: '__none', label: field.kind === 'derived_number' ? 'Not known' : 'Not recorded', count: total - known, filter: field.kind === 'numeric' && field.operators.includes('is_empty') ? { field_key: field.key, operator: 'is_empty', value: null } : null, tone: 'none' })
    const q3 = Array.isArray(v.stats) ? v.stats.map(num) : null
    const stats = field.kind === 'numeric' && known > 0 ? { min: num(v.min), p25: q3?.[0] ?? null, p50: q3?.[1] ?? null, p75: q3?.[2] ?? null, max: num(v.max) } : null
    return { ...base, coverage: coverage(known), buckets, ...(stats ? { stats } : {}) }
  }
  if (field.kind === 'date') {
    const known = num(v.known) ?? 0
    const { buckets, grain } = dateBuckets({ ...field, pg: plan.pg }, groups.get(`${field.key}|year`), groups.get(`${field.key}|month`), total, known)
    const windows = (plan.fresh.windows || []).map((w) => ({ key: w.key, label: w.label, count: num(v[`w:${w.key}`]) ?? 0, filter: w.filter }))
    return { ...base, coverage: coverage(known), buckets, grain, windows, stats: known ? { min: v.min ? String(v.min).slice(0, 10) : null, max: v.max ? String(v.max).slice(0, 10) : null } : null }
  }
  if (field.kind === 'categorical') {
    const { buckets, known, distinct: d, truncated } = categoricalBuckets(field, groups.get(`${field.key}|value`), total)
    return { ...base, coverage: coverage(known), buckets, distinct: d, ...(truncated ? { note: 'More than 500 values in this cohort — the 500 largest are counted; the rest are "Everything else".' } : {}) }
  }
  if (field.kind === 'tokens' || field.kind === 'array') {
    const known = num(v.known) ?? 0
    const isArray = plan.fresh.tokens?.mode === 'array'
    const op = isArray ? 'is_any_of' : (field.operators.includes('is_all_of') ? 'is_all_of' : 'is_any_of')
    const counted = (tokens.get(plan) || []).map((t) => {
      // the chip value must be the token the filter matches (sanitised / trimmed), else shown but not clickable
      const clickable = isArray ? t.key === t.key.trim() : sanitizeToken(t.label) === t.label && t.label.toLowerCase() === t.key
      return { key: t.key, label: t.label, count: t.count, filter: clickable ? { field_key: field.key, operator: op, value: [isArray ? t.key : t.label] } : null, tone: 'value' }
    }).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    const buckets = counted.slice(0, 24)
    if (total - known > 0) buckets.push({ key: '__none', label: 'None recorded', count: total - known, filter: null, tone: 'none' })
    const hidden = counted.length - Math.min(24, counted.length)
    return {
      ...base,
      coverage: coverage(known),
      buckets,
      distinct: counted.length,
      additive: false,
      note: `A property can carry several ${field.kind === 'tokens' ? 'flags' : 'values'}, so these shares do not add up to 100%.${hidden ? ` ${hidden} rarer values not shown.` : ''}`,
    }
  }
  return { ...base, coverage: coverage(0), buckets: [] }
}

async function pooled(tasks, limit = CONCURRENCY) {
  const results = new Array(tasks.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const i = next
      next += 1
      results[i] = await tasks[i]()
    }
  }))
  return results
}

/** Compute a list of fields for one cohort in one statement (+ distinct counts for small cohorts). */
async function computeFields(ctx, fields, extraAgg = null) {
  const schemaCols = ctx.schema[ctx.relation]
  const plans = fields.map((field) => ({ field, pg: schemaCols.get(field.column) || null }))
  // a probe compile finds numeric fields with no histogram range (facts columns): their edges come first
  const probe = paramList()
  for (const plan of plans) Object.assign(plan, planField(plan.field, plan.pg, probe, ctx))
  if (plans.some((p) => p.needsEdges) && ctx.mode === 'facts') ctx.edgeHints = { ...(ctx.edgeHints || {}), ...(await loadEdgeHints(ctx, plans)) }
  const { total, values, groups, tokens, extras } = await runCohortStatement(ctx, plans, extraAgg)
  const coveragePlans = plans.filter((p) => p.field.kind === 'coverage')
  const distinct = coveragePlans.length && total <= DISTINCT_MAX_COHORT ? await runDistinct(ctx, coveragePlans).catch(() => new Map()) : new Map()
  return { total, extras, fields: plans.map((plan) => shapeField(plan, { total, values, groups, tokens, distinct: distinct.get(plan) })) }
}

/* ── engagement (per-property facts that are not property columns) ───────── */

export const ENGAGEMENT_SQL = Object.freeze({
  threads: `select property_id,
                   bool_or(coalesce(outbound_count, 0) > 0 or last_outbound_at is not null) as contacted,
                   bool_or(coalesce(inbound_count, 0) > 0 or last_inbound_at is not null) as replied,
                   bool_or(lead_temperature in ('warm', 'hot')) as positive,
                   (array_agg(inbox_bucket order by latest_message_at desc nulls last, thread_key))[1] as inbox_bucket
              from public.inbox_thread_state
             where nullif(btrim(property_id), '') is not null
             group by property_id`,
  graph: `select property_id, bool_or(last_outbound_at is not null) as contacted, bool_or(last_inbound_at is not null) as replied
            from public.campaign_target_graph
           where last_outbound_at is not null or last_inbound_at is not null
           group by property_id`,
  deals: `select distinct on (primary_property_id) primary_property_id as property_id, acquisition_stage, opportunity_status
            from public.acquisition_opportunities
           where nullif(btrim(primary_property_id), '') is not null
           order by primary_property_id, updated_at desc nulls last, id`,
})

export const ENGAGEMENT_DEFINITIONS = Object.freeze({
  contacted: 'An outbound message on file — an inbox thread with an outbound message, or a campaign-graph last-outbound time.',
  replied: 'An inbound reply on file — an inbox thread with an inbound message, or a campaign-graph last-inbound time.',
  positive: 'The conversation classifier rates the thread warm or hot (inbox_thread_state.lead_temperature).',
  inbox: 'The latest thread’s inbox bucket; "Not classified" is a thread the classifier has not bucketed.',
  pipeline: 'The property’s most recently updated deal (acquisition_opportunities.acquisition_stage). "Closed" is closed-lost.',
})

async function loadEngagement(query, now) {
  if (engagementMemo && now - engagementMemo.at < ENGAGEMENT_TTL_MS) return engagementMemo
  if (engagementLoading) return engagementMemo || engagementLoading
  engagementLoading = (async () => {
    const [threads, graph, deals] = await Promise.all([
      query(ENGAGEMENT_SQL.threads, [], 20_000),
      query(ENGAGEMENT_SQL.graph, [], 20_000),
      query(ENGAGEMENT_SQL.deals, [], 20_000),
    ])
    const map = new Map()
    const get = (id) => { const k = clean(id); if (!map.has(k)) map.set(k, { contacted: false, replied: false, positive: false, inbox: undefined, stage: null, status: null }); return map.get(k) }
    for (const r of threads.rows || []) { const e = get(r.property_id); e.contacted ||= Boolean(r.contacted); e.replied ||= Boolean(r.replied); e.positive ||= Boolean(r.positive); e.inbox = r.inbox_bucket ?? null }
    for (const r of graph.rows || []) { const e = get(r.property_id); e.contacted ||= Boolean(r.contacted); e.replied ||= Boolean(r.replied) }
    for (const r of deals.rows || []) { const e = get(r.property_id); e.stage = clean(r.acquisition_stage) || null; e.status = clean(r.opportunity_status) || null }
    map.delete('')
    engagementMemo = { at: Date.now(), map, ids: [...map.keys()] }
    return engagementMemo
  })().finally(() => { engagementLoading = null })
  return engagementMemo || engagementLoading
}

const STAGE_LABEL = Object.freeze({
  ownership_confirmation: 'S1 · Ownership confirmed', offer_interest: 'S2 · Offer interest', asking_price: 'S3 · Asking price',
  property_condition: 'S4 · Condition', offer: 'S5 · Offer', negotiation: 'S5 · Negotiation', contract: 'S6 · Contract',
  under_contract: 'S6 · Under contract', escrow: 'S8 · Escrow', title: 'S7 · Title', closing: 'S9 · Closing', closed_won: 'Closed · won', closed: 'Closed · lost',
})
const BUCKET_LABEL = Object.freeze({
  priority: 'Priority', new_replies: 'New replies', needs_review: 'Needs review', waiting: 'Waiting', follow_up: 'Follow-up',
  cold: 'Cold', dead: 'Dead', suppressed: 'Suppressed',
})

async function engagementFor(ctx) {
  const e = await loadEngagement(ctx.query, ctx.now)
  const P = paramList()
  const where = P.embed(ctx.cohort.clauses, ctx.cohort.params)
  const ids = P.bind(e.ids)
  const rows = await run(ctx, `select property_id from public.${q(ctx.relation)} where ${where} and property_id = any(${ids}::text[])`, P.list, 'engagement')
  const tally = { contacted: 0, replied: 0, positive: 0, inbox: new Map(), stage: new Map(), threads: 0 }
  for (const r of rows) {
    const x = e.map.get(clean(r.property_id))
    if (!x) continue
    if (x.contacted) tally.contacted += 1
    if (x.replied) tally.replied += 1
    if (x.positive) tally.positive += 1
    if (x.inbox !== undefined) { tally.threads += 1; tally.inbox.set(x.inbox ?? null, (tally.inbox.get(x.inbox ?? null) || 0) + 1) }
    if (x.stage) tally.stage.set(x.stage, (tally.stage.get(x.stage) || 0) + 1)
  }
  return { tally, refreshedAt: new Date(e.at).toISOString() }
}

/** SMS eligibility without the read model: the campaign graph's verdict, per property, for a cohort ≤ 10,000. */
async function liveSmsEligibility(ctx, total, deps) {
  if (total > LIVE_SMS_MAX) return { unavailable: `Cohort above ${LIVE_SMS_MAX.toLocaleString('en-US')} — needs the property facts read model (eg_property_facts).` }
  const P = paramList()
  const where = whereSql(ctx, P)
  const idRows = await run(ctx, `select property_id from public.${q(ctx.relation)} ${where}`, P.list, 'sms-ids')
  const ids = idRows.map((r) => clean(r.property_id)).filter(Boolean)
  if (!ids.length) return { eligible: 0, reasons: new Map() }
  const graph = await run(ctx, `select property_id, queue_eligible, queue_block_reason, seller_person_key, prospect_id, canonical_prospect_id,
                                       canonical_e164, phone_id, timezone, identity_alignment
                                  from public.campaign_target_graph where property_id = any($1::text[])`, [ids], 'sms-graph')
  let review = new Set()
  try {
    const fetchReview = deps.fetchEntityContactReviewBlocks || (await import('@/lib/domain/campaigns/campaign-recipient-metrics.js')).fetchEntityContactReviewBlocks
    const result = await fetchReview(ids, deps.supabase ? { supabase: deps.supabase } : {})
    if (result?.ok === false) return { unavailable: 'The entity-contact review flags did not load — eligibility is not guessed.' }
    review = result?.blocked || new Set()
  } catch {
    return { unavailable: 'The entity-contact review flags did not load — eligibility is not guessed.' }
  }
  const byId = new Map()
  for (const r of graph) { const k = clean(r.property_id); if (!byId.has(k)) byId.set(k, []); byId.get(k).push(r) }
  let eligible = 0
  const reasons = new Map()
  for (const id of ids) {
    const v = propertySmsEligibility(byId.get(id) || [], review.has(id))
    if (v.eligible) eligible += 1
    const k = v.eligible ? 'eligible' : v.reason
    reasons.set(k, (reasons.get(k) || 0) + 1)
  }
  return { eligible, reasons }
}

/* ── headline (KPIs) ──────────────────────────────────────────────────────── */

const DISTRESS_SIGNALS = Object.freeze([
  { key: 'tax', label: 'Tax delinquent', filter: { field_key: 'properties.tax_delinquent_any', operator: 'is_true', value: null } },
  { key: 'lien', label: 'Recorded lien', filter: { field_key: 'records.has_lien', operator: 'is_true', value: null } },
  { key: 'judgment', label: 'Judgment', filter: { field_key: 'records.has_judgment', operator: 'is_true', value: null } },
  { key: 'probate', label: 'Probate', filter: { field_key: 'records.has_probate', operator: 'is_true', value: null } },
  { key: 'death', label: 'Death record', filter: { field_key: 'records.has_death_record', operator: 'is_true', value: null } },
  { key: 'lis_pendens', label: 'Lis pendens', filter: { field_key: 'records.has_lis_pendens', operator: 'is_true', value: null } },
  { key: 'default', label: 'Notice of default', filter: { field_key: 'records.has_default_notice', operator: 'is_true', value: null } },
  { key: 'foreclosure', label: 'Foreclosure filing', filter: { field_key: 'records.foreclosure_count', operator: 'gte', value: 1 } },
  { key: 'vacant', label: 'Vacant', filter: { field_key: 'properties.flags', operator: 'is_all_of', value: ['Vacant Home'] } },
])

/** The headline counts as extra aggregates on a cohort statement (no scan of their own). */
function headlineAgg(ctx) {
  const relCols = ctx.schema[ctx.relation]
  const facts = ctx.mode === 'facts'
  const meta = { signals: [], sms: false, stack: false }
  const make = (P) => {
    const out = []
    meta.signals = []
    for (const s of DISTRESS_SIGNALS) {
      const pred = predicateFor(s.filter, P)
      if (!pred || ![...columnsIn(pred)].every((c) => relCols.has(c))) continue
      meta.signals.push(s)
      out.push({ alias: `h_s_${s.key}`, sql: `count(*) filter (where ${pred})` })
    }
    const knownPred = predicateFor({ field_key: 'properties.known_equity_percent', operator: 'gte', value: -1e15 }, P)
    if (knownPred) out.push({ alias: 'h_known_equity', sql: `count(*) filter (where ${knownPred})` })
    const highPred = predicateFor({ field_key: 'properties.known_equity_percent', operator: 'gte', value: 60 }, P)
    if (highPred) out.push({ alias: 'h_high_equity', sql: `count(*) filter (where ${highPred})` })
    const smsPred = facts ? predicateFor({ field_key: 'facts.sms_eligible', operator: 'is_true', value: null }, P) : null
    meta.sms = Boolean(smsPred)
    if (smsPred) out.push({ alias: 'h_sms', sql: `count(*) filter (where ${smsPred})` })
    meta.stack = facts && relCols.has('distress_signal_count')
    if (meta.stack) {
      out.push(
        { alias: 'h_s0', sql: 'count(*) filter (where coalesce("distress_signal_count", 0) = 0)' },
        { alias: 'h_s1', sql: 'count(*) filter (where "distress_signal_count" = 1)' },
        { alias: 'h_s2', sql: 'count(*) filter (where "distress_signal_count" = 2)' },
        { alias: 'h_s3', sql: 'count(*) filter (where "distress_signal_count" >= 3)' },
      )
    }
    return out
  }
  return { make, meta }
}

async function headline(ctx, deps, agg, extrasRow, engagementPromise) {
  const { meta } = agg
  const facts = ctx.mode === 'facts'
  const row = extrasRow || {}
  const total = num(row.t) ?? 0
  const smsPred = meta.sms
  const signals = meta.signals
  const stackCol = meta.stack
  const unavailable = []

  const [eng, sms] = await Promise.all([
    engagementPromise.catch((error) => { unavailable.push({ section: 'headline', field: 'engagement', reason: timeoutReason(error) }); return null }),
    facts ? Promise.resolve(null) : liveSmsEligibility(ctx, total, deps).catch((error) => ({ unavailable: timeoutReason(error) })),
  ])

  const metrics = [
    { key: 'cohort', label: 'Properties', value: total, basis: 'The filtered cohort — the same count as the grid.' },
    smsPred
      ? { key: 'sms', label: 'SMS eligible', value: num(row.h_sms), basis: 'The campaign target builder’s readiness rule, per property (eg_property_facts.sms_eligible).', filter: { field_key: 'facts.sms_eligible', operator: 'is_true', value: null } }
      : sms?.unavailable
        ? { key: 'sms', label: 'SMS eligible', value: null, unavailable: sms.unavailable, basis: 'The campaign target builder’s readiness rule, per property.' }
        : { key: 'sms', label: 'SMS eligible', value: sms?.eligible ?? null, basis: 'The campaign target builder’s readiness rule, per property (live: campaign_target_graph + entity-contact review).' },
    { key: 'known_equity', label: 'Known equity', value: num(row.h_known_equity), basis: 'Equity that is actually known (equity_known_v1): a loan on file and a value, or free & clear evidence.' },
    { key: 'high_equity', label: '60%+ known equity', value: num(row.h_high_equity), basis: 'Known equity of 60% or more.', filter: { field_key: 'properties.known_equity_percent', operator: 'gte', value: 60 } },
    { key: 'contacted', label: 'Contacted', value: eng ? eng.tally.contacted : null, basis: ENGAGEMENT_DEFINITIONS.contacted },
    { key: 'replied', label: 'Replied', value: eng ? eng.tally.replied : null, basis: ENGAGEMENT_DEFINITIONS.replied },
    { key: 'positive', label: 'Positive', value: eng ? eng.tally.positive : null, basis: ENGAGEMENT_DEFINITIONS.positive },
  ]
  const distress = signals.map((s) => ({ key: s.key, label: s.label, count: num(row[`h_s_${s.key}`]) ?? 0, filter: s.filter, tone: 'value' }))
  const stack = stackCol ? [
    { key: 's0', label: 'No distress signal', count: num(row.h_s0) ?? 0, filter: null, tone: 'none' },
    { key: 's1', label: '1 signal', count: num(row.h_s1) ?? 0, filter: { field_key: 'facts.distress_signal_count', operator: 'between', value: [1, 1] }, tone: 'value' },
    { key: 's2', label: '2 signals', count: num(row.h_s2) ?? 0, filter: { field_key: 'facts.distress_signal_count', operator: 'between', value: [2, 2] }, tone: 'value' },
    { key: 's3', label: '3+ signals', count: num(row.h_s3) ?? 0, filter: { field_key: 'facts.distress_signal_count', operator: 'gte', value: 3 }, tone: 'value' },
  ] : null
  const pipeline = eng ? [...eng.tally.stage.entries()].sort((a, b) => b[1] - a[1]).map(([stage, count]) => ({
    key: stage, label: STAGE_LABEL[stage] || stage.replace(/_/g, ' '), count,
    filter: facts ? { field_key: 'facts.pipeline_stage', operator: 'is_any_of', value: [stage] } : null, tone: stage === 'closed' ? 'none' : 'value',
  })) : null
  const inbox = eng ? [...eng.tally.inbox.entries()].sort((a, b) => b[1] - a[1]).map(([bucket, count]) => ({
    key: bucket ?? '__none', label: bucket ? (BUCKET_LABEL[bucket] || bucket) : 'Not classified', count, filter: null, tone: bucket ? 'value' : 'none',
  })) : null
  const smsReasons = sms?.reasons ? [...sms.reasons.entries()].sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ key: reason, label: reason === 'eligible' ? 'Eligible' : reason.replace(/_/g, ' '), count, filter: null, tone: reason === 'eligible' ? 'yes' : 'no' })) : null
  return {
    total,
    metrics,
    distress,
    distressNote: 'A property can carry several signals, so these do not add up.',
    stack,
    pipeline,
    inbox,
    smsReasons,
    engagementRefreshedAt: eng?.refreshedAt ?? null,
    definitions: ENGAGEMENT_DEFINITIONS,
    unavailable,
  }
}

function timeoutReason(error) {
  const m = String(error?.message || '')
  if (/statement timeout|canceling statement/i.test(m)) return 'Unavailable — took longer than the time budget. Retry.'
  return `Unavailable — ${m.slice(0, 140) || 'the read failed'}. Retry.`
}

/* ── the endpoint ─────────────────────────────────────────────────────────── */

function parseSections(raw) {
  const ids = clean(raw) ? clean(raw).split(',').map(clean).filter(Boolean) : ['pinned', 'headline']
  return [...new Set(ids)]
}

export async function buildEntityGraphOverview(params = {}, deps = {}) {
  const tab = clean(params.tab || OVERVIEW_TAB).toLowerCase()
  if (tab !== OVERVIEW_TAB) return { tab, supported: false, total: null, sections: [], unavailable: [{ reason: 'The Overview covers the properties tab first (spec 9 §4); other tabs come next.' }] }
  const query = deps.query || queryWithTimeout
  if (!deps.query && !hasDatabaseUrl()) return { tab, supported: false, total: null, sections: [], unavailable: [{ reason: 'The Overview needs the direct database connection.' }] }
  const now = deps.now ?? Date.now()
  const started = Date.now()

  // fail closed on an untranslatable filter (422 upstream), never a silent universe
  const cohort = compileCohort(params)
  const unfiltered = isUnfiltered(cohort, params)
  if (clean(params.q)) {
    const error = new Error('overview_search_unsupported')
    error.code = 'overview_search_unsupported'
    throw error
  }
  const loaded = await loadSchema(query, now)
  // the read model counts only once a refresh has logged 'ok' (until then the live relation answers)
  const factsAt = loaded[FACTS] ? await factsRefreshed(query, loaded).catch(() => null) : null
  const schema = factsAt ? loaded : { ...loaded, [FACTS]: undefined }
  const registry = deps.registry || overviewRegistry()
  const whereCols = columnsIn(cohort.clauses.join(' '))
  const picked = chooseRelation(schema, whereCols, { includeTest: cohort.includeTest })
  if (!picked) {
    const error = new Error('overview_filters_need_facts')
    error.code = 'overview_filters_need_facts'
    error.columns = [...whereCols].filter((c) => !schema[VIEW]?.has(c))
    throw error
  }
  const factsRefreshedAt = picked.mode === 'facts' ? factsAt : null
  const ctx = {
    query, now, schema, cohort, unfiltered, timings: [],
    relation: picked.relation, mode: picked.mode, factsRefreshedAt,
    timeoutMs: deps.timeoutMs ?? (unfiltered ? UNIVERSE_STATEMENT_MS : STATEMENT_MS),
  }

  const wanted = parseSections(params.sections)
  const relCols = schema[ctx.relation]
  const unavailable = []
  const sections = []
  let total = null

  // the snapshot (PROPOSED eg_overview_snapshot) answers the unfiltered universe instantly when present
  const snapshot = unfiltered && schema[SNAPSHOT] && !deps.skipSnapshot ? await readSnapshot(query, wanted).catch(() => null) : null

  const fieldsFor = (id) => {
    if (id === 'pinned') return OVERVIEW_PINNED.map((k) => registry.find((f) => f.key === k)).filter(Boolean)
    return registry.filter((f) => f.section === id)
  }
  // the headline's counts ride on the first section's scan (pinned in the band), else on a scan of their own
  const wantsHead = wanted.includes('headline')
  const headAgg = wantsHead ? headlineAgg(ctx) : null
  const engagementPromise = wantsHead ? engagementFor(ctx) : null
  engagementPromise?.catch(() => {})
  const fieldSections = wanted.filter((id) => id !== 'headline' && (id === 'pinned' || OVERVIEW_SECTIONS.some((s) => s.id === id)) && !snapshot?.has(id))
  const host = wantsHead ? fieldSections[0] || null : null
  let headRow = null

  const tasks = wanted.filter((id) => id !== 'headline').map((id) => async () => {
    const meta = id === 'pinned' ? { id: 'pinned', label: 'Pinned' } : OVERVIEW_SECTIONS.find((s) => s.id === id)
    if (!meta) return null
    if (snapshot?.has(id)) return { ...snapshot.get(id), snapshot: true }
    const all = fieldsFor(id)
    const usable = []
    const missing = []
    for (const f of all) {
      // a computed fact is only ever read from the facts read model — a same-named legacy view column is not it
      if ((!f.computedFact || ctx.mode === 'facts') && [...fieldColumns(f)].every((c) => relCols.has(c))) usable.push(f)
      else missing.push({ key: f.key, label: f.label, kind: f.kind, section: f.section, computedFact: f.computedFact, unavailable: f.computedFact ? 'Needs the property facts read model (eg_property_facts) — not live yet.' : 'This column is not on the cohort relation.' })
    }
    if (id === 'company') {
      for (const c of OVERVIEW_COMPANY_FIELDS) {
        if (!all.some((f) => f.key === c.key)) missing.push({ key: c.key, label: c.label, kind: c.kind, section: 'company', computedFact: true, unavailable: 'Not in the field catalog yet — arrives with the property facts read model (company registry status).' })
      }
    }
    // in facts mode, a plain field the read model does not carry is read from the view (exact, one more scan)
    const viewCols = schema[VIEW]
    const viewOk = ctx.mode === 'facts' && viewCols && [...whereCols].every((c) => viewCols.has(c))
    const viaView = viewOk ? missing.filter((m) => !m.computedFact).map((m) => all.find((f) => f.key === m.key)).filter((f) => f && [...fieldColumns(f)].every((c) => viewCols.has(c))) : []
    if (viaView.length) for (const f of viaView) missing.splice(missing.findIndex((m) => m.key === f.key), 1)
    const hosting = host === id
    try {
      const out = usable.length || hosting ? await computeFields(ctx, usable, hosting ? headAgg.make : null) : { total: null, fields: [] }
      if (viaView.length) out.fields.push(...(await computeFields({ ...ctx, relation: VIEW, mode: 'view' }, viaView)).fields)
      if (out.total !== null) total = out.total
      if (hosting) headRow = out.extras
      // ghost bars: each filtered field's own distribution without its own filter (≤ 5, in parallel)
      const active = new Set(cohort.fieldFilters.map((r) => r.field_key))
      const ghostFields = out.fields.filter((f) => active.has(f.key) && f.buckets?.length).slice(0, GHOST_MAX)
      if (ghostFields.length) {
        await Promise.all(ghostFields.map(async (f) => {
          try {
            const gctx = { ...ctx, cohort: compileCohort(params, { exceptFieldKey: f.key }) }
            const g = await computeFields(gctx, [usable.find((u) => u.key === f.key)])
            // the field's own distribution without its own filter: the context its chip was picked from
            f.ghost = { total: g.total, buckets: g.fields[0].buckets.map((b) => ({ key: b.key, label: b.label, count: b.count, filter: b.filter, tone: b.tone })) }
          } catch { /* a ghost is context, never a blocker */ }
        }))
      }
      return { id: meta.id, label: meta.label, fields: [...out.fields, ...missing] }
    } catch (error) {
      if (error instanceof FacetUntranslatable) throw error
      unavailable.push({ section: meta.id, reason: timeoutReason(error), retry: true })
      return { id: meta.id, label: meta.label, fields: missing, unavailable: timeoutReason(error) }
    }
  })

  const done = await pooled(tasks)
  for (const sct of done) if (sct) sections.push(sct)
  let head = null
  if (wantsHead && snapshot?.has('headline')) {
    head = { ...snapshot.get('headline').headline, total: snapshot.get('headline').total, unavailable: [] }
  } else if (wantsHead) {
    try {
      if (!headRow) headRow = (await computeFields(ctx, [], headAgg.make)).extras
      head = await headline(ctx, deps, headAgg, headRow, engagementPromise)
    } catch (error) {
      if (error instanceof FacetUntranslatable) throw error
      unavailable.push({ section: 'headline', reason: timeoutReason(error), retry: true })
    }
  }
  if (head) {
    total = head.total
    unavailable.push(...head.unavailable)
  }

  return {
    tab,
    supported: true,
    total,
    source: {
      relation: ctx.relation,
      mode: ctx.mode,
      note: ctx.mode === 'facts'
        ? 'Property facts read model (eg_property_facts).'
        : 'Browse relation (v_entity_graph_properties) — exact; computed facts (SMS eligibility, owner, people, contacts, company status, ZIP market) arrive with the property facts read model.',
      factsFiltersExecutable: ctx.mode === 'facts',
    },
    refreshed_at: { facts: factsRefreshedAt, engagement: head?.engagementRefreshedAt ?? (engagementMemo ? new Date(engagementMemo.at).toISOString() : null) },
    headline: head ? { metrics: head.metrics, distress: head.distress, distressNote: head.distressNote, stack: head.stack, pipeline: head.pipeline, inbox: head.inbox, smsReasons: head.smsReasons, definitions: head.definitions } : null,
    sections,
    unavailable,
    timings: { totalMs: Date.now() - started, statements: ctx.timings },
  }
}

async function factsRefreshed(query, schema) {
  if (schema.eg_refresh_log) {
    const { rows } = await query(`select max(finished_at) as at from public.eg_refresh_log where name = $1 and status = 'ok'`, [FACTS], STATEMENT_MS)
    if (rows?.[0]?.at) return new Date(rows[0].at).toISOString()
  }
  for (const col of ['refreshed_at', 'facts_refreshed_at', 'computed_at']) {
    if (schema[FACTS]?.has(col)) {
      const { rows } = await query(`select max(${q(col)}) as at from public.${q(FACTS)}`, [], STATEMENT_MS)
      return rows?.[0]?.at ? new Date(rows[0].at).toISOString() : null
    }
  }
  return null
}

/** A snapshot row is only read while the registry it was built from is the current one. */
export function overviewRegistryVersion(registry = overviewRegistry()) {
  return createHash('sha1').update(JSON.stringify(registry.map((f) => [f.key, f.kind, f.section]))).digest('hex').slice(0, 16)
}

async function readSnapshot(query, wanted) {
  const { rows } = await query(
    `select distinct on (section) section, payload from public.${q(SNAPSHOT)}
      where tab = $1 and section = any($2::text[]) and registry_version = $3 order by section, refreshed_at desc`,
    [OVERVIEW_TAB, wanted, overviewRegistryVersion()], STATEMENT_MS,
  )
  return new Map((rows || []).filter((r) => r.payload && (Array.isArray(r.payload.fields) || r.payload.headline)).map((r) => [r.section, r.payload]))
}

/**
 * The rows the refresh job writes into eg_overview_snapshot after a successful
 * facts refresh (D8: after the 09:17 UTC read-model refresh and after property
 * imports, outside 11:15–14:30 UTC). Read-only here: it computes the
 * unfiltered universe Overview; the job does the insert.
 */
export async function buildOverviewSnapshotRows(deps = {}) {
  const sections = ['pinned', 'headline', ...OVERVIEW_SECTIONS.map((x) => x.id).filter((id) => id !== 'headline')]
  const out = await buildEntityGraphOverview({ tab: OVERVIEW_TAB, sections: sections.join(',') }, { ...deps, skipSnapshot: true, timeoutMs: deps.timeoutMs ?? 120_000 })
  if (out.unavailable?.length) throw new Error(`overview_snapshot_incomplete: ${out.unavailable.map((u) => u.section).join(',')}`)
  const version = overviewRegistryVersion()
  const base = { tab: OVERVIEW_TAB, registry_version: version, total: out.total, source_relation: out.source.relation }
  return [
    ...out.sections.map((section) => ({ ...base, section: section.id, payload: section })),
    { ...base, section: 'headline', payload: { headline: out.headline, total: out.total } },
  ]
}

export default buildEntityGraphOverview
