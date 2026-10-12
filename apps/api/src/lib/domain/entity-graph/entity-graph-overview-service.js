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
import { applyBuyerFilters, applyOwnerFilters, applyPhoneFilters, applyPropertyFilters, applyProspectFilters, parseBrowseFilters } from './entity-graph-service.js'
import { propertySmsEligibility } from './entity-graph-outreach-state.js'
import { primeCampaignScope } from './entity-graph-campaign-scope.js'
import { FACT_BY_COL } from './entity-graph-facts.js'
import { factsCohortRelation, factsHeaderValues } from './entity-graph-facts-query.js'
import {
  CATEGORICAL_TOP,
  OVERVIEW_COMPANY_FIELDS,
  OVERVIEW_TAB,
  bandsFromEdges,
  formatEdge,
  moneyRangeFloor,
  numericBinsFor,
  overviewPinnedFor,
  overviewRegistry,
  overviewSectionsFor,
} from './entity-graph-overview-catalog.js'

const VIEW = 'v_entity_graph_properties'
const FACTS = 'eg_property_facts'
const SNAPSHOT = 'eg_overview_snapshot'
const STATEMENT_MS = 8_000
const CACHE_TTL_MS = 5 * 60_000
const UNIVERSE_TTL_MS = 10 * 60_000
const CACHE_MAX = 300
const SCHEMA_TTL_MS = 10 * 60_000
const ENGAGEMENT_TTL_MS = 5 * 60_000
const LIVE_SMS_MAX = 10_000
const GROUP_SETS_PER_STATEMENT = 40
const GHOST_MAX = 5
const CONCURRENCY = 2
/** Engagement for a cohort is read keyed by its ids (indexed) — above this, only from the facts read model. */
const ENGAGEMENT_KEYED_MAX = 20_000

/**
 * The relation, id column and browse appliers of each scope — the list's own
 * (entity-graph-service.js browse*), so an Overview total is the grid total.
 * `browseKeys` = the legacy params that scope's appliers actually narrow on.
 */
export const OVERVIEW_SCOPE = Object.freeze({
  properties: { relation: 'v_entity_graph_properties', id: 'property_id', noun: 'properties', base: applyPropertyFilters, browseKeys: ['market', 'city', 'state', 'zip', 'assetType', 'county', 'unitsMin', 'unitsMax'] },
  master_owners: { relation: 'master_owners', id: 'master_owner_id', noun: 'owners', base: applyOwnerFilters, browseKeys: ['ownerType', 'priorityTier', 'market', 'coverageMin'] },
  people: { relation: 'prospects', id: 'prospect_id', noun: 'people', base: applyProspectFilters, browseKeys: ['language', 'reachable'] },
  contact_methods: { relation: 'phones', id: 'phone_id', noun: 'phones', base: applyPhoneFilters, browseKeys: ['contactStatus', 'reachable'] },
  buyers: { relation: 'eg_buyer_index', id: 'buyer_id', noun: 'buyers', base: applyBuyerFilters, browseKeys: ['state', 'entityType'] },
  organizations: { relation: 'sub_owners', id: 'sub_owner_id', noun: 'companies', base: (b) => b, browseKeys: [] },
})
const scopeOf = (tab) => OVERVIEW_SCOPE[String(tab || OVERVIEW_TAB).toLowerCase()] || null

const clean = (v) => String(v ?? '').trim()
// computed-fact filters compile here; the relation choice then requires the facts read model for them
const FACTS_OK = Object.freeze({ allowComputedFacts: true })
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v))

/* ── shared state (process-local) ─────────────────────────────────────────── */

const cache = new Map()
let schemaMemo = null

export const __overviewTest = {
  reset() { cache.clear(); schemaMemo = null; engagementCache.clear(); edgeMemo.clear() },
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
function resolveFilter(filter, tab = OVERVIEW_TAB) {
  if (!filter) return null
  const { resolved, unsupported } = resolveEntityGraphFieldFilters(tab, [filter], tab === OVERVIEW_TAB ? FACTS_OK : {})
  return unsupported.length || !resolved.length ? null : resolved[0]
}

/** The click filter, compiled exactly as the list compiles it, as one predicate in `P`. */
function predicateFor(filter, P, tab = OVERVIEW_TAB) {
  const entry = resolveFilter(filter, tab)
  if (!entry) return null
  const { clauses, params } = record((b) => applyEntityGraphFieldFilters(b, [entry]))
  if (!clauses.length) return null
  return P.embed(clauses, params)
}

/** The columns a field reads: its own, or — for a derived field — the ones its filter compiles to. */
function fieldColumns(field, tab = OVERVIEW_TAB) {
  if (!field.derived) return new Set([field.column])
  const sample = field.kind === 'derived_boolean'
    ? { field_key: field.key, operator: 'is_true', value: null }
    : field.kind === 'derived_categorical'
      ? { field_key: field.key, operator: 'is_any_of', value: [field.derivedValues?.[0]] }
      : { field_key: field.key, operator: 'gte', value: 0 }
  const pred = predicateFor(sample, paramList(), tab)
  return pred ? columnsIn(pred) : new Set([field.column])
}

/* ── the cohort ───────────────────────────────────────────────────────────── */

/** The list's WHERE for these params, as clauses + params (never re-implemented). */
export function compileCohort(params = {}, { exceptFieldKey = null, tab = clean(params.tab || OVERVIEW_TAB).toLowerCase() } = {}) {
  const scope = scopeOf(tab)
  if (!scope) throw new FacetUntranslatable(`overview tab ${tab}`)
  const filters = parseBrowseFilters(params)
  const { resolved } = resolveEntityGraphFieldFiltersOrThrow(tab, params, tab === OVERVIEW_TAB ? FACTS_OK : {})
  const fieldFilters = exceptFieldKey ? resolved.filter((r) => r.field_key !== exceptFieldKey) : resolved
  const { clauses, params: values } = record((b) => applyEntityGraphFieldFilters(scope.base(b, filters), fieldFilters))
  // fieldFilters: every requested chip (the ghost bars' "active" set); applied: the ones this WHERE carries
  return { clauses, params: values, filters, fieldFilters: resolved, applied: fieldFilters, includeTest: Boolean(filters.includeTest), tab }
}

/** The facts deps the 8.5.6 facet path runs with (tests inject theirs; a request reads the pool). */
const factsDepsOf = (deps = {}) => deps.factsDeps || (deps.query ? { query: deps.query } : {})

/** An addendum fact column the read model does not serve (missing, or no refresh wrote it yet). */
const unservedAddendum = (col, served) => Boolean(FACT_BY_COL.get(col)?.addendum) && !(served && served.has(col))

/**
 * A cohort chip on an addendum fact the read model cannot execute yet (a
 * click on the canonical Property type bar) is resolved to its EXACT property
 * ids on the rail's own facet path (factsCohortRelation: the same filters,
 * the live facts relation), and the cohort WHERE carries `property_id = any(ids)`
 * instead — so every other section still reads the read model in one scan.
 * The ids are computed for THIS cohort's full filter set (a ghost cohort
 * resolves its own). Nothing is sampled; a failure fails the request (never a
 * silently wider cohort).
 */
export async function substituteLiveChips(cohort, { served = null, deps = {}, timings = [] } = {}) {
  if (cohort.tab !== OVERVIEW_TAB || cohort.includeTest) return cohort
  const live = cohort.applied.filter((r) => unservedAddendum(r.source_column, served))
  if (!live.length) return cohort
  const scope = scopeOf(cohort.tab)
  const fdeps = factsDepsOf(deps)
  const t0 = Date.now()
  const rel = await (deps.factsCohortRelation || factsCohortRelation)({
    applyFilters: (b) => applyEntityGraphFieldFilters(scope.base(b, cohort.filters), cohort.applied),
    columns: [],
    deps: fdeps,
  })
  let ids
  if (rel.records && !rel.where) ids = rel.records.map((r) => String(r.property_id))
  else {
    const res = await (fdeps.query || queryWithTimeout)(`select f."property_id" from ${rel.from} ${rel.where}`, rel.params, 25_000)
    ids = (res?.rows || []).map((r) => String(r.property_id))
  }
  timings.push({ label: `live-chips(${live.map((r) => r.source_column).join(',')})`, ms: Date.now() - t0, cached: Boolean(rel.cached), source: rel.source || rel.mode || null, ids: ids.length })
  const rest = cohort.applied.filter((r) => !live.includes(r))
  // an empty match is an empty cohort: a property id no row carries (a predicate, not a value)
  const { clauses, params } = record((b) => applyEntityGraphFieldFilters(scope.base(b, cohort.filters), rest).in('property_id', ids.length ? ids : ['__no_property__']))
  return { ...cohort, clauses, params, liveChips: { fields: live.map((r) => r.field_key), ids: ids.length, mode: rel.source || rel.mode || null } }
}

/** No narrowing at all: the whole scope (only ever read from the snapshot / facts read model, never scanned live). */
export function isUnfiltered(cohort, params = {}) {
  const f = cohort.filters
  const keys = scopeOf(cohort.tab)?.browseKeys || []
  const set = keys.some((k) => {
    const v = f[k]
    return v !== null && v !== undefined && v !== '' && v !== false
  })
  return !set && !(cohort.applied ?? cohort.fieldFilters).length && !cohort.includeTest && !clean(params.q)
}

/* ── schema (which relations exist, with which columns) ──────────────────── */

async function loadSchema(query, now) {
  if (schemaMemo && now - schemaMemo.at < SCHEMA_TTL_MS) return schemaMemo.value
  // pg_attribute, not information_schema.columns: the latter omits MATERIALIZED VIEWS, so the buyers
  // scope (eg_buyer_index is a matview) never had a relation and its Overview always 422'd (measured 2026-10-12)
  const { rows } = await query(
    `select c.relname as table_name, a.attname as column_name,
            case when t.typcategory = 'A' then 'ARRAY' else format_type(a.atttypid, null) end as data_type
       from pg_attribute a
       join pg_class c on c.oid = a.attrelid
       join pg_namespace n on n.oid = c.relnamespace
       join pg_type t on t.oid = a.atttypid
      where n.nspname = 'public' and c.relname = any($1::text[]) and a.attnum > 0 and not a.attisdropped`,
    [[VIEW, FACTS, SNAPSHOT, 'eg_refresh_log', ...Object.values(OVERVIEW_SCOPE).map((x) => x.relation)]],
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

/** Pick the relation: the facts read model when it covers `needed`, else the view (other scopes: their base table). */
export function chooseRelation(schema, needed, { includeTest = false, tab = OVERVIEW_TAB } = {}) {
  const covers = (rel) => schema[rel] && [...needed].every((c) => schema[rel].has(c))
  if (tab !== OVERVIEW_TAB) {
    const rel = scopeOf(tab)?.relation
    return rel && covers(rel) ? { relation: rel, mode: 'base' } : null
  }
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

/** The "has a value" filter of a derived number (its own predicate with no bound). */
function knownFilterFor(field) {
  // an age is 0–150 years: an unbounded month-of-birth range would be an invalid date
  if (field.derived === 'age_from_mob' || field.key === 'prospects.age_years') return { field_key: field.key, operator: 'between', value: [0, 150] }
  return { field_key: field.key, operator: 'gte', value: -1e15 }
}

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
    const pred = predicateFor(filter, P, ctx.tab)
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
      // derived (known equity, age from month of birth): "known" is the derived filter with no bound
      filtered('known', knownFilterFor(field))
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
  } else if (field.kind === 'categorical' || field.kind === 'banded_text') {
    groups.push({ id: `${key}|value`, expr: `${q(col)}::text` })
  } else if (field.kind === 'derived_categorical') {
    plan.values = (field.derivedValues || []).filter((v, i) => filtered(`v:${i}`, { field_key: key, operator: 'is_any_of', value: [v] }))
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
  // the headline's grouped extras (distress × market) are subqueries over the SAME materialised cohort
  const extraSubs = extras.filter((e) => e.subquery)
  for (const e of extras.filter((x) => !x.subquery)) { aggExprs.push(`${e.sql} as "${e.alias}"`); fragments.push(e.sql) }
  for (const e of extraSubs) fragments.push(e.sql)
  // distinct counts of coverage-only fields ride on the same scan (never a second read of the relation)
  const distinctPlans = plans.filter((p) => p.field.kind === 'coverage')
  distinctPlans.forEach((p, i) => {
    const sql = `count(distinct nullif(btrim(${q(p.field.column)}::text), ''))`
    aggExprs.push(`${sql} as "d${i}"`)
    fragments.push(sql)
  })
  const sets = plans.flatMap((plan) => plan.fresh.groups)
  for (const g of sets) fragments.push(g.expr)
  const from = 'c'
  const tokenPlans = plans.filter((p) => p.fresh.tokens)
  const tokenParts = tokenPlans.map((p) => { p.fresh.tokens = p.tokens || p.fresh.tokens; const sql = tokenSql(p.fresh, P, from); fragments.push(sql); return { plan: p, sql } })
  const relCols = ctx.schema[ctx.relation]
  const cols = [...new Set([...fragments.flatMap((f) => [...columnsIn(f)])])].filter((c) => relCols.has(c))
  const select = cols.length ? cols.map(q).join(', ') : q(scopeOf(ctx.tab)?.id || 'property_id')
  const groupBatches = []
  for (let i = 0; i < sets.length; i += GROUP_SETS_PER_STATEMENT) groupBatches.push(sets.slice(i, i + GROUP_SETS_PER_STATEMENT))
  const sql = `with c as materialized (select ${select} from public.${q(ctx.relation)} where ${where})
    select (select row_to_json(a) from (select count(*)::bigint as "t"${aggExprs.length ? `, ${aggExprs.join(', ')}` : ''} from c) a) as agg
    ${groupBatches.map((batch, i) => `, (select coalesce(json_agg(gw), '[]'::json) from (${groupsSql(batch, from)}) gw) as "g${i}"`).join('\n')}
    ${tokenParts.map((t, i) => `, (select coalesce(json_agg(tk), '[]'::json) from (${t.sql}) tk) as "k${i}"`).join('\n')}
    ${extraSubs.map((e) => `, (select coalesce(json_agg(xs), '[]'::json) from (${e.sql}) xs) as "${e.alias}"`).join('\n')}`
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
  const distinct = new Map(distinctPlans.map((p, i) => [p, num(agg[`d${i}`])]))
  const extrasOut = { ...agg }
  for (const e of extraSubs) extrasOut[e.alias] = row?.[e.alias] || []
  return { total, values, groups, tokens, distinct, extras: extrasOut }
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

/**
 * Money-range text ("$35,000-$39,999") folded into ordered currency bands by
 * each stored value's lower bound. A band's chip is `is_any_of` its exact
 * stored values, so its cohort is exactly the bar. Values without a readable
 * bound are "Other values" (shown, not a chip); blanks are "Not recorded".
 */
export function bandedTextBuckets(field, group, total) {
  const values = group?.values || []
  const edges = field.bandEdges || [25000, 50000, 100000, 250000]
  const bands = bandsFromEdges(edges, { format: field.format || 'money', under: edges[0] > 0, over: true })
    .map((b) => ({ ...b, count: 0, values: [], clickable: true }))
  let unread = 0
  let none = 0
  for (const v of values) {
    if (v.key === null || v.key.trim() === '') { none += v.count; continue }
    const floor = moneyRangeFloor(v.key)
    const band = floor === null ? null : bands.find((b) => (b.lo === null || floor >= b.lo) && (b.hi === null || floor <= b.hi))
    if (!band) { unread += v.count; continue }
    band.count += v.count
    band.values.push(v.key)
    if (v.key !== v.key.trim()) band.clickable = false
  }
  const canAny = field.operators.includes('is_any_of')
  const truncated = group && group.distinct > 501
  const buckets = bands.map((b) => ({
    key: b.key,
    label: b.label,
    count: b.count,
    filter: canAny && b.values.length && b.clickable && !truncated ? { field_key: field.key, operator: 'is_any_of', value: [...b.values].sort() } : null,
    tone: 'value',
    lo: b.lo,
    hi: b.hi,
  }))
  while (buckets.length && buckets[0].count === 0) buckets.shift()
  while (buckets.length && buckets[buckets.length - 1].count === 0) buckets.pop()
  if (unread > 0) buckets.push({ key: '__other', label: 'Other values', count: unread, filter: null, tone: 'other' })
  const missing = Math.max(0, total - values.reduce((acc, v) => acc + v.count, 0)) + none
  if (missing > 0) buckets.push({ key: '__none', label: 'Not recorded', count: missing, filter: field.operators.includes('is_empty') ? { field_key: field.key, operator: 'is_empty', value: null } : null, tone: 'none' })
  return { buckets, known: total - missing, distinct: values.filter((v) => v.key !== null && v.key.trim()).length }
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
    ...(field.sensitive ? { sensitive: true } : {}),
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
  if (field.kind === 'banded_text') {
    const { buckets, known, distinct: d } = bandedTextBuckets(field, groups.get(`${field.key}|value`), total)
    return { ...base, coverage: coverage(known), buckets, distinct: d, note: 'Bands of the stored ranges (by each range’s lower bound); a bar filters the exact stored values in it.' }
  }
  if (field.kind === 'derived_categorical') {
    const buckets = (plan.fresh.values || []).map((value, i) => ({ key: value, label: value, count: num(v[`v:${i}`]) ?? 0, filter: { field_key: field.key, operator: 'is_any_of', value: [value] }, tone: value === 'Other' ? 'other' : 'value' }))
    return { ...base, coverage: coverage(total), buckets }
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
  const { total, values, groups, tokens, distinct, extras } = await runCohortStatement(ctx, plans, extraAgg)
  return { total, extras, fields: plans.map((plan) => shapeField(plan, { total, values, groups, tokens, distinct: distinct.get(plan) })) }
}

/* ── engagement (per-property facts that are not property columns) ───────── */

/**
 * Engagement for a cohort, KEYED by its property ids (inbox_thread_state,
 * campaign_target_graph and acquisition_opportunities are all indexed on the
 * property) — never a scan of the graph. The cohort's ids come off the
 * section's own materialised cohort (no extra read of the relation).
 */
export const ENGAGEMENT_SQL = Object.freeze({
  threads: `select property_id,
                   bool_or(coalesce(outbound_count, 0) > 0 or last_outbound_at is not null) as contacted,
                   bool_or(coalesce(inbound_count, 0) > 0 or last_inbound_at is not null) as replied,
                   bool_or(lead_temperature in ('warm', 'hot')) as positive,
                   (array_agg(inbox_bucket order by latest_message_at desc nulls last, thread_key))[1] as inbox_bucket
              from public.inbox_thread_state
             where property_id = any($1::text[])
             group by property_id`,
  graph: `select property_id, bool_or(last_outbound_at is not null) as contacted, bool_or(last_inbound_at is not null) as replied
            from public.campaign_target_graph
           where property_id = any($1::text[]) and (last_outbound_at is not null or last_inbound_at is not null)
           group by property_id`,
  deals: `select distinct on (primary_property_id) primary_property_id as property_id, acquisition_stage, opportunity_status
            from public.acquisition_opportunities
           where primary_property_id = any($1::text[])
           order by primary_property_id, updated_at desc nulls last, id`,
})

export const ENGAGEMENT_DEFINITIONS = Object.freeze({
  contacted: 'An outbound message on file — an inbox thread with an outbound message, or a campaign-graph last-outbound time.',
  replied: 'An inbound reply on file — an inbox thread with an inbound message, or a campaign-graph last-inbound time.',
  positive: 'The conversation classifier rates the thread warm or hot (inbox_thread_state.lead_temperature).',
  inbox: 'The latest thread’s inbox bucket; "Not classified" is a thread the classifier has not bucketed.',
  pipeline: 'The property’s most recently updated deal (acquisition_opportunities.acquisition_stage). "Closed" is closed-lost.',
})

const engagementCache = new Map()
async function engagementForIds(query, ids, now) {
  const key = createHash('sha1').update(ids.join(',')).digest('hex')
  const hit = engagementCache.get(key)
  if (hit && now - hit.at < ENGAGEMENT_TTL_MS) return hit
  const out = { at: Date.now(), map: new Map() }
  if (ids.length) {
    const [threads, graph, deals] = await Promise.all([
      query(ENGAGEMENT_SQL.threads, [ids], STATEMENT_MS),
      query(ENGAGEMENT_SQL.graph, [ids], STATEMENT_MS),
      query(ENGAGEMENT_SQL.deals, [ids], STATEMENT_MS),
    ])
    const get = (id) => { const k = clean(id); if (!out.map.has(k)) out.map.set(k, { contacted: false, replied: false, positive: false, inbox: undefined, stage: null, status: null }); return out.map.get(k) }
    for (const r of threads.rows || []) { const e = get(r.property_id); e.contacted ||= Boolean(r.contacted); e.replied ||= Boolean(r.replied); e.positive ||= Boolean(r.positive); e.inbox = r.inbox_bucket ?? null }
    for (const r of graph.rows || []) { const e = get(r.property_id); e.contacted ||= Boolean(r.contacted); e.replied ||= Boolean(r.replied) }
    for (const r of deals.rows || []) { const e = get(r.property_id); e.stage = clean(r.acquisition_stage) || null; e.status = clean(r.opportunity_status) || null }
    out.map.delete('')
  }
  if (engagementCache.size >= 50) engagementCache.delete(engagementCache.keys().next().value)
  engagementCache.set(key, out)
  return out
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

/** The cohort's engagement tally from its ids (≤ 20,000 — above that the read model answers). */
async function engagementFor(ctx, ids) {
  if (!ids) throw new Error(`Engagement is counted for cohorts up to ${ENGAGEMENT_KEYED_MAX.toLocaleString('en-US')} properties (larger cohorts: the property facts read model / snapshot)`)
  const e = await engagementForIds(ctx.query, ids, ctx.now)
  const tally = { contacted: 0, replied: 0, positive: 0, inbox: new Map(), stage: new Map(), threads: 0 }
  for (const id of ids) {
    const x = e.map.get(clean(id))
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
async function liveSmsEligibility(ctx, ids, deps) {
  if (!ids || ids.length > LIVE_SMS_MAX) return { unavailable: `Cohort above ${LIVE_SMS_MAX.toLocaleString('en-US')} — needs the property facts read model (eg_property_facts).` }
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

export const DISTRESS_SIGNALS = Object.freeze([
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
/** "Distress signals by market": the cohort's largest markets × each signal. */
const MARKET_MATRIX_TOP = 12
/** Signal stack: how many of the signals above each property carries (0 · 1 · 2 · 3 · 4+). */
export const STACK_BUCKETS = Object.freeze([
  { key: 's0', label: 'None', test: '= 0' },
  { key: 's1', label: '1 signal', test: '= 1' },
  { key: 's2', label: '2 signals', test: '= 2' },
  { key: 's3', label: '3 signals', test: '= 3' },
  { key: 's4', label: '4+ signals', test: '>= 4' },
])

/** The other scopes' headline counts: each is a chip of that scope (so a metric is clickable). */
export const SCOPE_METRICS = Object.freeze({
  master_owners: [
    { key: 'multi', label: '3+ properties', filter: { field_key: 'master_owners.property_count', operator: 'gte', value: 3 } },
    { key: 'tax', label: 'Tax-delinquent holdings', filter: { field_key: 'master_owners.tax_delinquent_count', operator: 'gte', value: 1 } },
    { key: 'lien', label: 'Active liens', filter: { field_key: 'master_owners.active_lien_count', operator: 'gte', value: 1 } },
    { key: 'equity', label: '$250K+ portfolio equity', filter: { field_key: 'master_owners.portfolio_total_equity', operator: 'gte', value: 250000 } },
    { key: 'reach', label: 'Contactability 50+', filter: { field_key: 'master_owners.contactability_score', operator: 'gte', value: 50 } },
  ],
  people: [
    { key: 'sms', label: 'SMS eligible', filter: { field_key: 'prospects.sms_eligible', operator: 'is_true', value: null } },
    { key: 'age_known', label: 'Age on file', filter: { field_key: 'prospects.age_years', operator: 'between', value: [0, 150] }, sensitive: true },
    { key: 'age_65', label: '65 or older', filter: { field_key: 'prospects.age_years', operator: 'gte', value: 65 }, sensitive: true },
    { key: 'income', label: 'Income on file', filter: { field_key: 'prospects.est_household_income', operator: 'is_not_empty', value: null } },
    { key: 'nav', label: 'Net asset value on file', filter: { field_key: 'prospects.net_asset_value', operator: 'is_not_empty', value: null } },
  ],
  contact_methods: [
    { key: 'wireless', label: 'Wireless', filter: { field_key: 'phones.phone_type', operator: 'is_any_of', value: ['W'] } },
    { key: 'active12', label: 'Active 12+ months', filter: { field_key: 'phones.activity_status', operator: 'is_any_of', value: ['Active for 12 months or longer'] } },
    { key: 'heavy', label: 'Heavy usage (12 mo)', filter: { field_key: 'phones.usage_12_months', operator: 'is_any_of', value: ['Heavy Usage', 'Very Heavy Usage'] } },
  ],
  buyers: [
    { key: 'active', label: 'Active', filter: { field_key: 'buyers.activity_status', operator: 'is_any_of', value: ['active'] } },
    { key: 'recent', label: 'Bought, last 90 days of sales', filter: { field_key: 'buyers.trailing_90d', operator: 'gte', value: 1 } },
    { key: 'buybox', label: 'Has a buy box', filter: { field_key: 'buyers.has_buybox', operator: 'is_true', value: null } },
    { key: 'crossover', label: 'Owns and sells', filter: { field_key: 'buyers.is_crossover', operator: 'is_true', value: null } },
  ],
  organizations: [
    { key: 'llc', label: 'LLC / corporation', filter: { field_key: 'organizations.entity_class', operator: 'is_any_of', value: ['LLC/Corporation'] } },
    { key: 'trust', label: 'Trust', filter: { field_key: 'organizations.entity_class', operator: 'is_any_of', value: ['Trust'] } },
    { key: 'estate', label: 'Estate', filter: { field_key: 'organizations.entity_class', operator: 'is_any_of', value: ['Estate'] } },
    { key: 'linked', label: 'Linked to an owner', filter: { field_key: 'organizations.has_master_owner', operator: 'is_true', value: null } },
  ],
})

/** The headline counts as extra aggregates on a cohort statement (no scan of their own). */
function headlineAgg(ctx) {
  const relCols = ctx.schema[ctx.relation]
  const facts = ctx.mode === 'facts'
  const props = ctx.tab === OVERVIEW_TAB
  const meta = { signals: [], sms: false, stack: false, metrics: [], ids: false, matrix: false }
  const compiles = (pred) => pred && [...columnsIn(pred)].every((c) => relCols.has(c))
  const make = (P) => {
    const out = []
    meta.signals = []
    meta.metrics = []
    if (!props) {
      for (const m of SCOPE_METRICS[ctx.tab] || []) {
        const pred = predicateFor(m.filter, P, ctx.tab)
        if (!compiles(pred)) continue
        meta.metrics.push(m)
        out.push({ alias: `h_m_${m.key}`, sql: `count(*) filter (where ${pred})` })
      }
      return out
    }
    const preds = []
    for (const s of DISTRESS_SIGNALS) {
      const pred = predicateFor(s.filter, P, ctx.tab)
      if (!compiles(pred)) continue
      meta.signals.push(s)
      preds.push({ key: s.key, pred })
      out.push({ alias: `h_s_${s.key}`, sql: `count(*) filter (where ${pred})` })
    }
    if (preds.length) {
      // the signal stack: how many of these each property carries, from the same predicates
      const sum = preds.map((x) => `(coalesce((${x.pred}), false))::int`).join(' + ')
      for (const b of STACK_BUCKETS) out.push({ alias: `h_st_${b.key}`, sql: `count(*) filter (where (${sum}) ${b.test})` })
      meta.stack = true
      if (relCols.has('market')) {
        meta.matrix = true
        out.push({
          alias: 'h_mkt',
          subquery: true,
          sql: `select "market" as k, count(*)::bigint as n, ${preds.map((x) => `count(*) filter (where ${x.pred})::bigint as "s_${x.key}"`).join(', ')}
                  from c group by 1 order by ("market" is null), count(*) desc, "market" limit ${MARKET_MATRIX_TOP}`,
        })
      }
    }
    const knownPred = predicateFor({ field_key: 'properties.known_equity_percent', operator: 'gte', value: -1e15 }, P, ctx.tab)
    if (knownPred) out.push({ alias: 'h_known_equity', sql: `count(*) filter (where ${knownPred})` })
    const highPred = predicateFor({ field_key: 'properties.known_equity_percent', operator: 'gte', value: 60 }, P, ctx.tab)
    if (highPred) out.push({ alias: 'h_high_equity', sql: `count(*) filter (where ${highPred})` })
    const smsPred = facts ? predicateFor({ field_key: 'facts.sms_eligible', operator: 'is_true', value: null }, P, ctx.tab) : null
    meta.sms = Boolean(smsPred)
    if (smsPred) out.push({ alias: 'h_sms', sql: `count(*) filter (where ${smsPred})` })
    // the cohort's ids for the KEYED engagement + live SMS reads (bounded; above it the read model answers)
    meta.ids = !ctx.allowUniverseScan
    if (meta.ids) out.push({ alias: 'h_ids', subquery: true, sql: `select "property_id" as id from c limit ${ENGAGEMENT_KEYED_MAX + 1}` })
    return out
  }
  return { make, meta }
}

async function universeEngagementIds(ctx) {
  // the snapshot job only (allowUniverseScan): the cohort's ids, read once with the job's own budget
  const P = paramList()
  const where = P.embed(ctx.cohort.clauses, ctx.cohort.params)
  const rows = await run(ctx, `select property_id from public.${q(ctx.relation)} where ${where}`, P.list, 'universe-ids')
  return rows.map((r) => clean(r.property_id)).filter(Boolean)
}

async function headline(ctx, deps, agg, extrasRow) {
  const { meta } = agg
  const facts = ctx.mode === 'facts'
  const row = extrasRow || {}
  const total = num(row.t) ?? 0
  const unavailable = []
  const noun = scopeOf(ctx.tab)?.noun || 'records'
  const cohortMetric = { key: 'cohort', label: noun.replace(/^\w/, (c) => c.toUpperCase()), value: total, basis: 'The filtered cohort — the same count as the grid.' }

  if (ctx.tab !== OVERVIEW_TAB) {
    const metrics = [cohortMetric, ...meta.metrics.map((m) => ({ key: m.key, label: m.label, value: num(row[`h_m_${m.key}`]), basis: `${m.label} — the rail’s own filter, counted on this cohort.`, filter: m.filter, ...(m.sensitive ? { sensitive: true } : {}) }))]
    return { total, metrics, distress: [], stack: null, pipeline: null, inbox: null, smsReasons: null, distressByMarket: null, engagementRefreshedAt: null, definitions: {}, unavailable }
  }

  let ids = null
  if (meta.ids) {
    const list = (row.h_ids || []).map((r) => clean(r.id)).filter(Boolean)
    ids = list.length > ENGAGEMENT_KEYED_MAX ? null : list
  } else if (ctx.allowUniverseScan) {
    ids = await universeEngagementIds(ctx)
  }
  const [eng, sms] = await Promise.all([
    (ctx.allowUniverseScan ? engagementForIdsUnbounded(ctx, ids) : engagementFor(ctx, ids)).catch((error) => { unavailable.push({ section: 'headline', field: 'engagement', reason: timeoutReason(error) }); return null }),
    facts ? Promise.resolve(null) : liveSmsEligibility(ctx, ids, deps).catch((error) => ({ unavailable: timeoutReason(error) })),
  ])

  const metrics = [
    cohortMetric,
    meta.sms
      ? { key: 'sms', label: 'SMS eligible', value: num(row.h_sms), basis: 'The campaign target builder’s readiness rule, per property (eg_property_facts.sms_eligible).', filter: { field_key: 'facts.sms_eligible', operator: 'is_true', value: null } }
      : sms?.unavailable
        ? { key: 'sms', label: 'SMS eligible', value: null, unavailable: sms.unavailable, basis: 'The campaign target builder’s readiness rule, per property.' }
        : { key: 'sms', label: 'SMS eligible', value: sms?.eligible ?? null, basis: 'The campaign target builder’s readiness rule, per property (live: campaign_target_graph + entity-contact review).' },
    { key: 'known_equity', label: 'Known equity', value: num(row.h_known_equity), basis: 'Equity that is actually known (equity_known_v1): a loan on file and a value, or free & clear evidence.', filter: { field_key: 'properties.known_equity_percent', operator: 'gte', value: -1e15 } },
    { key: 'high_equity', label: '60%+ known equity', value: num(row.h_high_equity), basis: 'Known equity of 60% or more.', filter: { field_key: 'properties.known_equity_percent', operator: 'gte', value: 60 } },
    { key: 'distressed', label: '2+ distress signals', value: meta.stack ? (num(row.h_st_s2) ?? 0) + (num(row.h_st_s3) ?? 0) + (num(row.h_st_s4) ?? 0) : null, basis: 'Properties carrying two or more of the distress signals below (tax, liens, judgment, probate, death, lis pendens, default, foreclosure, vacant).' },
    { key: 'contacted', label: 'Contacted', value: eng ? eng.tally.contacted : null, basis: ENGAGEMENT_DEFINITIONS.contacted },
    { key: 'replied', label: 'Replied', value: eng ? eng.tally.replied : null, basis: ENGAGEMENT_DEFINITIONS.replied },
    { key: 'positive', label: 'Positive', value: eng ? eng.tally.positive : null, basis: ENGAGEMENT_DEFINITIONS.positive },
    { key: 'pipeline', label: 'In pipeline', value: eng ? [...eng.tally.stage.entries()].filter(([k]) => k !== 'closed').reduce((acc, [, n]) => acc + n, 0) : null, basis: `${ENGAGEMENT_DEFINITIONS.pipeline} Counts open deals (not closed-lost).` },
  ]
  for (const m of metrics) if (m.value === null && !m.unavailable && ['contacted', 'replied', 'positive', 'pipeline'].includes(m.key)) m.unavailable = unavailable.find((u) => u.field === 'engagement')?.reason || null
  const distress = meta.signals.map((s) => ({ key: s.key, label: s.label, count: num(row[`h_s_${s.key}`]) ?? 0, filter: s.filter, tone: 'value' }))
  const stack = meta.stack ? STACK_BUCKETS.map((b) => ({ key: b.key, label: b.label, count: num(row[`h_st_${b.key}`]) ?? 0, filter: null, tone: 'value' })) : null
  const distressByMarket = meta.matrix ? {
    signals: meta.signals.map((s) => ({ key: s.key, label: s.label, filter: s.filter })),
    markets: (row.h_mkt || []).map((m) => ({
      key: m.k ?? '__none',
      label: m.k ?? 'Not recorded',
      total: Number(m.n) || 0,
      filter: m.k ? { field_key: 'properties.market', operator: 'is_any_of', value: [m.k] } : null,
      counts: Object.fromEntries(meta.signals.map((s) => [s.key, Number(m[`s_${s.key}`]) || 0])),
    })),
    note: `The cohort’s ${MARKET_MATRIX_TOP} largest markets. A property can carry several signals.`,
  } : null
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
    stackNote: `How many of the ${meta.signals.length} distress signals each property carries.`,
    distressByMarket,
    pipeline,
    inbox,
    smsReasons,
    engagementRefreshedAt: eng?.refreshedAt ?? null,
    definitions: ENGAGEMENT_DEFINITIONS,
    unavailable,
  }
}

/** The snapshot job's engagement: the same keyed reads, chunked over the whole universe. */
async function engagementForIdsUnbounded(ctx, ids) {
  const tally = { contacted: 0, replied: 0, positive: 0, inbox: new Map(), stage: new Map(), threads: 0 }
  let at = Date.now()
  for (let i = 0; i < (ids || []).length; i += ENGAGEMENT_KEYED_MAX) {
    const part = ids.slice(i, i + ENGAGEMENT_KEYED_MAX)
    const { tally: t, refreshedAt } = await engagementFor(ctx, part)
    at = Math.min(at, new Date(refreshedAt).getTime())
    tally.contacted += t.contacted; tally.replied += t.replied; tally.positive += t.positive; tally.threads += t.threads
    for (const [k, n] of t.inbox) tally.inbox.set(k, (tally.inbox.get(k) || 0) + n)
    for (const [k, n] of t.stage) tally.stage.set(k, (tally.stage.get(k) || 0) + n)
  }
  return { tally, refreshedAt: new Date(at).toISOString() }
}

function timeoutReason(error) {
  const m = String(error?.message || '')
  if (/statement timeout|canceling statement/i.test(m)) return 'Unavailable — took longer than the 8 s budget. Retry.'
  return `Unavailable — ${m.slice(0, 140) || 'the read failed'}. Retry.`
}

/* ── the endpoint ─────────────────────────────────────────────────────────── */

/**
 * ADDENDUM FACTS (8.5.6: facts.property_type_class / _group / _confidence /
 * _basis, property_use_raw, person_source) the read model does not serve yet
 * — the column is missing or no successful refresh has written it. They are
 * counted on the SAME path the rail's Property type facet and the header
 * pickers use (factsHeaderValues → factsCohortRelation: the table once it
 * serves the column, else the live facts relation), so a bar's count is the
 * facet's count and its click is the facet's own chip. Exact, never sampled.
 * The unfiltered universe is never computed live here: "Computing" until the
 * read model serves the column or the snapshot job has run.
 */
export const LIVE_FACT_UNIVERSE = 'Computing — this field is counted from the property facts read model once its refresh writes it (eg_property_facts field-accuracy addendum) or by the snapshot job; it is never scanned live for the whole universe. Pick any filter to count it now.'

/**
 * The canonical property-type family only (one memoised pass over the property-use observations).
 * person_source is an addendum too, but its family (the person fallbacks) costs 50–100 s cold on the
 * live path (measured 2026-10-11) — it waits for the read model, labelled.
 */
export const LIVE_FACT_COLUMNS = Object.freeze(new Set(['property_type_class', 'property_type_group', 'property_type_confidence', 'property_type_basis', 'property_use_raw']))
export const LIVE_FACT_PENDING = 'Counting the canonical property type (the first read after a restart computes it for every property, ~20 s) — retry in a moment.'

export function isLiveFactField(field, ctx) {
  return ctx.tab === OVERVIEW_TAB && !ctx.cohort.includeTest && Boolean(field.computedFact)
    && field.kind === 'categorical' && LIVE_FACT_COLUMNS.has(field.column) && Boolean(FACT_BY_COL.get(field.column)?.addendum)
}

/** A facet-path read inside the section's budget; past it the read keeps warming the memo, the card says retry. */
function withinBudget(promise, ms) {
  let timer
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('live_fact_budget'), { code: 'live_fact_budget' })), ms) })
  promise.catch(() => {})
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}

async function liveFactField(ctx, field, params, deps = {}) {
  const base = {
    key: field.key, label: field.label, kind: field.kind, format: field.format, section: field.section, column: field.column,
    privacy: field.privacy, computedFact: true, emptySource: field.emptySource, pinned: field.pinned, liveFact: true,
    ...(field.sensitive ? { sensitive: true } : {}),
    ...(field.caution ? { caution: field.caution } : {}),
  }
  if (ctx.unfiltered && !ctx.allowUniverseScan) return { ...base, buckets: [], computing: true, unavailable: LIVE_FACT_UNIVERSE }
  const scope = scopeOf(ctx.tab)
  const count = async (cohort) => {
    const t0 = Date.now()
    const out = await withinBudget((deps.factsHeaderValues || factsHeaderValues)({
      column: field.column,
      applyFilters: (b) => applyEntityGraphFieldFilters(scope.base(b, cohort.filters), cohort.applied),
      deps: factsDepsOf(deps),
    }), ctx.timeoutMs)
    ctx.timings.push({ label: `live-fact(${field.column})`, ms: Date.now() - t0, cached: Boolean(out.cached), source: out.source || out.mode || null })
    const values = (out.values || []).map((v) => ({ key: v.value === null || v.value === undefined ? null : String(v.value), count: Number(v.count) || 0 }))
    const total = Number(out.total) || 0
    return { total, out, ...categoricalBuckets(field, { values, distinct: out.truncated ? 502 : values.length }, total) }
  }
  try {
    const r = await count(ctx.cohort)
    const field_ = {
      ...base,
      coverage: { known: r.known, total: r.total, share: pct(r.known, r.total) },
      buckets: r.buckets,
      distinct: r.distinct,
      source: { mode: r.out.mode || null, from: r.out.source || null, asOf: r.out.asOf || null },
      note: 'Counted on the facet path (the rail’s own counts) — the facts read model does not serve this field yet.',
    }
    // the ghost: this field's own distribution without its own chip (never the whole universe live)
    if (ctx.cohort.fieldFilters.some((x) => x.field_key === field.key)) {
      const gcohort = compileCohort(params, { exceptFieldKey: field.key, tab: ctx.tab })
      if (!isUnfiltered(gcohort, params) || ctx.allowUniverseScan) {
        const g = await count(gcohort).catch(() => null)
        if (g) field_.ghost = { total: g.total, buckets: g.buckets.map((b) => ({ key: b.key, label: b.label, count: b.count, filter: b.filter, tone: b.tone })) }
      }
    }
    return field_
  } catch (error) {
    return { ...base, buckets: [], unavailable: error?.code === 'live_fact_budget' ? LIVE_FACT_PENDING : timeoutReason(error), retry: true }
  }
}

export const UNIVERSE_COMPUTING = 'Every field of the whole universe is precomputed by the snapshot job (eg_overview_snapshot) and has not run yet — the Entity Graph Overview page shows the universe now. Pick any filter to chart that cohort here.'

function parseSections(raw) {
  const ids = clean(raw) ? clean(raw).split(',').map(clean).filter(Boolean) : ['pinned', 'headline']
  return [...new Set(ids)]
}

export async function buildEntityGraphOverview(params = {}, deps = {}) {
  const tab = clean(params.tab || OVERVIEW_TAB).toLowerCase()
  const sectionsMeta = overviewSectionsFor(tab)
  if (!sectionsMeta || !scopeOf(tab)) return { tab, supported: false, total: null, sections: [], unavailable: [{ reason: 'The Overview has no registry for this tab.' }] }
  const query = deps.query || queryWithTimeout
  if (!deps.query && !hasDatabaseUrl()) return { tab, supported: false, total: null, sections: [], unavailable: [{ reason: 'The Overview needs the direct database connection.' }] }
  const now = deps.now ?? Date.now()
  const started = Date.now()

  if (clean(params.q)) {
    const error = new Error('overview_search_unsupported')
    error.code = 'overview_search_unsupported'
    throw error
  }
  // the campaign scope chip resolves its exact membership before the cohort compiles (never "no filter")
  await primeCampaignScope(params, deps.campaignScopeDeps || (deps.query ? { query: deps.query } : {}))
  // fail closed on an untranslatable filter (422 upstream), never a silent universe
  let cohort = compileCohort(params, { tab })
  const unfiltered = isUnfiltered(cohort, params)
  const loaded = await loadSchema(query, now)
  // the read model counts only once a refresh has logged 'ok' (until then the live relation answers)
  const refresh = tab === OVERVIEW_TAB && loaded[FACTS] ? await factsRefreshed(query, loaded).catch(() => null) : null
  const factsAt = refresh?.at || null
  // an ADDENDUM column (added after the base eg_property_facts migration: the canonical property type,
  // person_source …) is read from the table only once a successful refresh wrote it (its log names the
  // addendum) — the 8.5.6 tableServes rule; until then it is not a column of the read model here
  const schema = factsAt ? { ...loaded, [FACTS]: servedFactsColumns(loaded[FACTS], refresh.addenda) } : { ...loaded, [FACTS]: undefined }
  const registry = deps.registry || overviewRegistry(tab)
  const preTimings = []
  try {
    cohort = await withinBudget(substituteLiveChips(cohort, { served: schema[FACTS], deps, timings: preTimings }), deps.timeoutMs ?? STATEMENT_MS)
  } catch (error) {
    if (error?.code !== 'live_fact_budget') throw error
    // the chip's ids are still being counted (the memo keeps warming): every section says retry — never a wider cohort
    const ids = parseSections(params.sections).filter((id) => id !== 'headline')
    return {
      tab, supported: true, total: null, computing: false,
      source: { relation: null, mode: 'live_chips', note: LIVE_FACT_PENDING, factsFiltersExecutable: false },
      refreshed_at: { facts: factsAt, engagement: null, snapshot: null },
      headline: null,
      sections: ids.map((id) => ({ id, label: id === 'pinned' ? 'Pinned' : sectionsMeta.find((x) => x.id === id)?.label || id, fields: [], unavailable: LIVE_FACT_PENDING })),
      unavailable: [{ reason: LIVE_FACT_PENDING, retry: true }],
      timings: { totalMs: Date.now() - started, statements: preTimings },
    }
  }
  const whereCols = columnsIn(cohort.clauses.join(' '))
  const picked = chooseRelation(schema, whereCols, { includeTest: cohort.includeTest, tab })
  if (!picked) {
    const error = new Error('overview_filters_need_facts')
    error.code = 'overview_filters_need_facts'
    error.columns = [...whereCols].filter((c) => !schema[tab === OVERVIEW_TAB ? VIEW : scopeOf(tab).relation]?.has(c))
    throw error
  }
  const factsRefreshedAt = picked.mode === 'facts' ? factsAt : null
  const allowUniverseScan = Boolean(deps.allowUniverseScan)
  const ctx = {
    query, now, schema, cohort, unfiltered, timings: preTimings, tab, allowUniverseScan,
    relation: picked.relation, mode: picked.mode, factsRefreshedAt,
    // 8 s per statement in live mode (the snapshot job passes its own budget)
    timeoutMs: deps.timeoutMs ?? STATEMENT_MS,
  }

  const wanted = parseSections(params.sections)
  const relCols = schema[ctx.relation]
  const unavailable = []
  const sections = []
  let total = null

  // the snapshot (PROPOSED eg_overview_snapshot) answers the unfiltered universe instantly when present
  const snapshot = unfiltered && schema[SNAPSHOT] && !deps.skipSnapshot ? await readSnapshot(query, wanted, tab).catch(() => null) : null
  // NO unbounded scan of the PROPERTIES universe in a request: the snapshot's, else "computing" (measured
  // 2026-10-11: pinned + headline over all 176,603 eg_property_facts rows ran past the 8 s budget; the Overview
  // PAGE answers it from indexed GROUP BYs instead). The other scopes' universes are small base tables: computed
  // live (measured 2026-10-12 on prod, pinned + headline cold: owners 1.8 s, people 2.9 s, phones 0.9 s, buyers
  // 0.25 s, companies 2.8 s), then served from the 10-minute universe cache — never "Computing" there.
  const universeBlocked = unfiltered && !allowUniverseScan && tab === OVERVIEW_TAB

  // the universe snapshot, read once per request, for ghost bars of a field whose own chip is the only filter
  let universeSnap = null
  const universeSnapshotField = async (key) => {
    if (!schema[SNAPSHOT] || deps.skipSnapshot) return null
    if (!universeSnap) universeSnap = readSnapshot(query, ['pinned', ...sectionsMeta.map((x) => x.id)], tab).catch(() => new Map())
    const map = await universeSnap
    for (const [, payload] of map) {
      const hit = (payload?.fields || []).find((x) => x.key === key && Array.isArray(x.buckets))
      if (hit) return hit
    }
    return null
  }
  const fieldsFor = (id) => {
    if (id === 'pinned') return overviewPinnedFor(tab).map((k) => registry.find((f) => f.key === k)).filter(Boolean)
    return registry.filter((f) => f.section === id)
  }
  // the headline's counts ride on the first section's scan (pinned in the band), else on a scan of their own
  const wantsHead = wanted.includes('headline')
  const headAgg = wantsHead ? headlineAgg(ctx) : null
  const fieldSections = wanted.filter((id) => id !== 'headline' && (id === 'pinned' || sectionsMeta.some((x) => x.id === id)) && !snapshot?.has(id))
  const host = wantsHead && !(snapshot?.has('headline')) ? fieldSections[0] || null : null
  let headRow = null

  const tasks = wanted.filter((id) => id !== 'headline').map((id) => async () => {
    const meta = id === 'pinned' ? { id: 'pinned', label: 'Pinned' } : sectionsMeta.find((x) => x.id === id)
    if (!meta) return null
    if (snapshot?.has(id)) return { ...snapshot.get(id), snapshot: true }
    if (universeBlocked) return { id: meta.id, label: meta.label, fields: [], computing: true, unavailable: UNIVERSE_COMPUTING }
    const all = fieldsFor(id)
    const usable = []
    const missing = []
    const liveFacts = []
    for (const f of all) {
      // a computed fact is only ever read from the facts read model — a same-named legacy view column is not it
      if ((!f.computedFact || ctx.mode === 'facts') && [...fieldColumns(f, tab)].every((c) => relCols.has(c))) usable.push(f)
      // an addendum fact the table does not serve yet (the canonical property type): the rail's own live facts path
      else if (isLiveFactField(f, ctx)) liveFacts.push(f)
      else missing.push({ key: f.key, label: f.label, kind: f.kind, section: f.section, computedFact: f.computedFact, ...(f.sensitive ? { sensitive: true } : {}), unavailable: f.computedFact ? 'Needs the property facts read model (eg_property_facts) — not live yet.' : 'This column is not on the cohort relation.' })
    }
    if (id === 'company' && tab === OVERVIEW_TAB) {
      for (const c of OVERVIEW_COMPANY_FIELDS) {
        if (!all.some((f) => f.key === c.key)) missing.push({ key: c.key, label: c.label, kind: c.kind, section: 'company', computedFact: true, unavailable: 'Not in the field catalog yet — arrives with the property facts read model (company registry status).' })
      }
    }
    // in facts mode, a plain field the read model does not carry is read from the view (exact, one more scan)
    const viewCols = schema[VIEW]
    const viewOk = ctx.mode === 'facts' && viewCols && [...whereCols].every((c) => viewCols.has(c))
    const viaView = viewOk ? missing.filter((m) => !m.computedFact).map((m) => all.find((f) => f.key === m.key)).filter((f) => f && [...fieldColumns(f, tab)].every((c) => viewCols.has(c))) : []
    if (viaView.length) for (const f of viaView) missing.splice(missing.findIndex((m) => m.key === f.key), 1)
    const hosting = host === id
    // the facet-path fields run beside the section's one scan (their own budget each)
    const livePending = Promise.all(liveFacts.map((f) => liveFactField(ctx, f, params, deps)))
    try {
      const out = usable.length || hosting ? await computeFields(ctx, usable, hosting ? headAgg.make : null) : { total: null, fields: [] }
      if (viaView.length) out.fields.push(...(await computeFields({ ...ctx, relation: VIEW, mode: 'view' }, viaView)).fields)
      if (liveFacts.length) {
        out.fields.push(...(await livePending))
        // registry order (the pinned band: market, Property type, …), whichever path counted a field
        const order = new Map(all.map((f, i) => [f.key, i]))
        out.fields.sort((a, b) => (order.get(a.key) ?? 1e9) - (order.get(b.key) ?? 1e9))
      }
      if (out.total !== null) total = out.total
      if (hosting) headRow = out.extras
      // ghost bars: each filtered field's own distribution without its own filter (≤ 5, in parallel)
      const active = new Set(cohort.fieldFilters.map((r) => r.field_key))
      const ghostFields = out.fields.filter((f) => active.has(f.key) && f.buckets?.length && !f.liveFact).slice(0, GHOST_MAX)
      if (ghostFields.length) {
        await Promise.all(ghostFields.map(async (f) => {
          try {
            const gcohort = await substituteLiveChips(compileCohort(params, { exceptFieldKey: f.key, tab }), { served: schema[FACTS], deps, timings: ctx.timings })
            // a ghost of the WHOLE universe is a universe scan: only from the snapshot / read model
            if (isUnfiltered(gcohort, params) && !allowUniverseScan) {
              const snap = await universeSnapshotField(f.key)
              if (snap) f.ghost = { total: snap.coverage?.total ?? null, buckets: (snap.buckets || []).map((b) => ({ key: b.key, label: b.label, count: b.count, filter: b.filter, tone: b.tone })), snapshot: true }
              return
            }
            const g = await computeFields({ ...ctx, cohort: gcohort }, [usable.find((u) => u.key === f.key)])
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
    head = { ...snapshot.get('headline').headline, total: snapshot.get('headline').total, unavailable: [], snapshot: true }
  } else if (wantsHead && universeBlocked) {
    unavailable.push({ section: 'headline', reason: UNIVERSE_COMPUTING, computing: true })
  } else if (wantsHead) {
    try {
      if (!headRow) headRow = (await computeFields(ctx, [], headAgg.make)).extras
      head = await headline(ctx, deps, headAgg, headRow)
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
    computing: universeBlocked && !snapshot?.size,
    ...(cohort.liveChips ? { liveChips: cohort.liveChips } : {}),
    source: {
      relation: ctx.relation,
      mode: snapshot?.size ? 'snapshot' : ctx.mode,
      note: snapshot?.size
        ? 'Universe snapshot (eg_overview_snapshot) — exact as of its refresh.'
        : ctx.mode === 'facts'
          ? 'Property facts read model (eg_property_facts).'
          : ctx.mode === 'base'
            ? `${scopeOf(tab).relation} — exact, live.`
            : 'Browse relation (v_entity_graph_properties) — exact; computed facts (SMS eligibility, owner, people, contacts, company status, ZIP market) arrive with the property facts read model.',
      factsFiltersExecutable: ctx.mode === 'facts',
    },
    refreshed_at: { facts: factsRefreshedAt, engagement: head?.engagementRefreshedAt ?? null, snapshot: snapshot?.refreshedAt ?? null },
    headline: head ? { metrics: head.metrics, distress: head.distress, distressNote: head.distressNote, stack: head.stack, stackNote: head.stackNote, distressByMarket: head.distressByMarket ?? null, pipeline: head.pipeline, inbox: head.inbox, smsReasons: head.smsReasons, definitions: head.definitions } : null,
    sections,
    unavailable,
    timings: { totalMs: Date.now() - started, statements: ctx.timings },
  }
}

/** The last successful facts refresh: when, and which addenda it wrote (eg_refresh_log.detail.addenda). */
async function factsRefreshed(query, schema) {
  if (schema.eg_refresh_log) {
    const { rows } = await query(`select finished_at as at, detail from public.eg_refresh_log where name = $1 and status = 'ok' order by finished_at desc limit 1`, [FACTS], STATEMENT_MS)
    const r = rows?.[0]
    if (r?.at) {
      const detail = r.detail && typeof r.detail === 'object' ? r.detail : {}
      return { at: new Date(r.at).toISOString(), addenda: new Set(Array.isArray(detail.addenda) ? detail.addenda.map(String) : []) }
    }
  }
  for (const col of ['refreshed_at', 'facts_refreshed_at', 'computed_at']) {
    if (schema[FACTS]?.has(col)) {
      const { rows } = await query(`select max(${q(col)}) as at from public.${q(FACTS)}`, [], STATEMENT_MS)
      return rows?.[0]?.at ? { at: new Date(rows[0].at).toISOString(), addenda: new Set() } : null
    }
  }
  return null
}

/** The read model's columns minus addendum columns no successful refresh has written yet. */
export function servedFactsColumns(columns, addenda = new Set()) {
  if (!columns) return columns
  const out = new Map()
  for (const [col, type] of columns) {
    const addendum = FACT_BY_COL.get(col)?.addendum
    if (addendum && !addenda.has(addendum)) continue
    out.set(col, type)
  }
  return out
}

/** A snapshot row is only read while the registry it was built from is the current one. */
export function overviewRegistryVersion(registry = overviewRegistry()) {
  return createHash('sha1').update(JSON.stringify(registry.map((f) => [f.key, f.kind, f.section, f.sensitive ? 1 : 0]))).digest('hex').slice(0, 16)
}

async function readSnapshot(query, wanted, tab = OVERVIEW_TAB) {
  const { rows } = await query(
    `select distinct on (section) section, payload, refreshed_at from public.${q(SNAPSHOT)}
      where tab = $1 and section = any($2::text[]) and registry_version = $3 order by section, refreshed_at desc`,
    [tab, wanted, overviewRegistryVersion(overviewRegistry(tab))], STATEMENT_MS,
  )
  const map = new Map((rows || []).filter((r) => r.payload && (Array.isArray(r.payload.fields) || r.payload.headline)).map((r) => [r.section, r.payload]))
  const at = (rows || []).map((r) => r.refreshed_at).filter(Boolean).sort()[0]
  map.refreshedAt = at ? new Date(at).toISOString() : null
  return map
}

/**
 * The rows the refresh job writes into eg_overview_snapshot after a successful
 * facts refresh (D8: after the 09:17 UTC read-model refresh and after property
 * imports, outside 11:15–14:30 UTC) — every scope's unfiltered universe.
 * Read-only here (it computes); writeOverviewSnapshots does the insert.
 */
export async function buildOverviewSnapshotRows(deps = {}) {
  const out = []
  const skipped = []
  for (const tab of (deps.tabs || Object.keys(OVERVIEW_SCOPE)).filter((t) => scopeOf(t) && overviewSectionsFor(t))) {
    const sectionIds = ['pinned', 'headline', ...overviewSectionsFor(tab).map((x) => x.id).filter((id) => id !== 'headline')]
    let res
    try {
      res = await buildEntityGraphOverview({ tab, sections: sectionIds.join(',') }, { ...deps, skipSnapshot: true, allowUniverseScan: true, timeoutMs: deps.timeoutMs ?? 120_000 })
    } catch (error) {
      // one scope failing never blanks the others (2026-10-12: the table was still empty after the cron lane armed)
      skipped.push({ tab, section: '*', reason: String(error?.message || error).slice(0, 200) })
      continue
    }
    if (!res.supported) continue
    const base = { tab, registry_version: overviewRegistryVersion(overviewRegistry(tab)), total: res.total, source_relation: res.source.relation }
    // only COMPLETE sections are written; an incomplete one keeps its previous snapshot (or the live path) and is named
    // (a field-level gap — headline engagement — is written as "unavailable" inside the section, not a missing section)
    const failed = new Set((res.unavailable || []).filter((u) => !u.field).map((u) => u.section).filter(Boolean))
    for (const section of res.sections) {
      if (section.unavailable || failed.has(section.id)) { skipped.push({ tab, section: section.id, reason: section.unavailable || 'unavailable' }); continue }
      out.push({ ...base, section: section.id, payload: section })
    }
    if (res.headline && !failed.has('headline')) out.push({ ...base, section: 'headline', payload: { headline: res.headline, total: res.total } })
    else skipped.push({ tab, section: 'headline', reason: (res.unavailable || []).find((u) => u.section === 'headline')?.reason || 'unavailable' })
  }
  out.skipped = skipped
  return out
}

/**
 * Write every scope's snapshot in ONE transaction (the job; never a request
 * path). Inert unless EG_OVERVIEW_SNAPSHOT_ENABLED=true and the table exists.
 */
export async function writeOverviewSnapshots({ pool, env = process.env, tabs } = {}) {
  if (String(env?.EG_OVERVIEW_SNAPSHOT_ENABLED ?? '').toLowerCase() !== 'true') return { ok: false, skipped: 'EG_OVERVIEW_SNAPSHOT_ENABLED is not true' }
  const client = await pool.connect()
  const started = Date.now()
  try {
    await client.query(`set statement_timeout = '120s'`)
    const present = await client.query(`select to_regclass('public.${SNAPSHOT}') is not null as ok`)
    if (!present.rows[0]?.ok) return { ok: false, skipped: 'eg_overview_snapshot not applied' }
    const query = (sql, params) => client.query({ text: sql, values: params })
    const rows = await buildOverviewSnapshotRows({ query, tabs })
    await client.query('begin')
    for (const r of rows) {
      await client.query(
        `insert into public.${SNAPSHOT} (tab, section, registry_version, payload, total, source_relation) values ($1, $2, $3, $4::jsonb, $5, $6)`,
        [r.tab, r.section, r.registry_version, JSON.stringify(r.payload), r.total ?? 0, r.source_relation],
      )
    }
    await client.query(`delete from public.${SNAPSHOT} where refreshed_at < now() - interval '7 days'`)
    await client.query('commit')
    return { ok: true, rows: rows.length, tabs: [...new Set(rows.map((r) => r.tab))], skipped: rows.skipped || [], ms: Date.now() - started }
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

export default buildEntityGraphOverview
