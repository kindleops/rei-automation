/**
 * ENTITY GRAPH · UNIVERSE OVERVIEW PAGE — one dashboard across every table
 * (owner 2026-10-12: "I meant an OVERVIEW PAGE … and it says 'Computing the
 * universe' and nothing is loaded").
 *
 *   GET /api/cockpit/entity-graph/universe?scope=properties&markets=["Miami, FL"]&states=["FL"]
 *
 * One request per SCOPE (the page fetches them side by side); each answers
 * one or more CARDS — a total, a few KPIs and a few charts. Every bucket and
 * KPI carries the rail's own field-filter chip, so a click opens that scope's
 * grid with exactly that cohort (the global filters + the bucket's chip).
 *
 * WHERE THE NUMBERS COME FROM (never "Computing"):
 *   properties · pipeline · contacts
 *     public.eg_property_facts with INDEXED aggregates: one GROUP BY per
 *     column, each served by that column's b-tree (egpf_*_k) — measured on
 *     prod 2026-10-12: 90–410 ms per statement warm (176,603 rows), the whole
 *     card family well under 2 s. The WHERE is the list's own
 *     (compileCohort → the browse appliers), so a bar's count is the grid's.
 *     The snapshot is not needed here; the facts refresh time is the as-of.
 *   owners · people · phones · buyers · companies
 *     the Overview snapshot (eg_overview_snapshot, pinned + headline) when it
 *     exists for the unfiltered universe; otherwise the scope's own Overview
 *     computed live on its base table (measured 0.8–3.1 s cold, then served
 *     from the Overview's 10-minute universe cache, stale while it re-reads).
 *
 * GLOBAL FILTERS are applied only where the scope has a field that means the
 * same thing (GLOBAL_FILTER_FIELDS). A scope without one is shown whole and
 * says so — never silently filtered, never silently unfiltered.
 */
import { hasDatabaseUrl, queryWithTimeout } from '@/lib/postgres/client.js'
import { buildEntityGraphOverview, compileCohort, overviewRegistryVersion, paramList } from './entity-graph-overview-service.js'
import { overviewRegistry } from './entity-graph-overview-catalog.js'

const FACTS = 'eg_property_facts'
const SNAPSHOT = 'eg_overview_snapshot'
const STATEMENT_MS = 8_000
const CACHE_TTL_MS = 5 * 60_000
const UNIVERSE_TTL_MS = 10 * 60_000
const CACHE_MAX = 200
const CONCURRENCY = 3
const TOP = 8

/** The page's scopes, in page order (desk tab keys). */
export const UNIVERSE_SCOPES = Object.freeze(['properties', 'master_owners', 'people', 'contact_methods', 'buyers', 'organizations'])

export const SCOPE_LABEL = Object.freeze({
  properties: 'Properties', pipeline: 'Pipeline', contacts: 'Contacts & reach',
  master_owners: 'Owners', people: 'People', contact_methods: 'Phones', buyers: 'Buyers', organizations: 'Companies',
})

/**
 * The global filters, per scope: the field each one maps to (the rail's own
 * key) and what it means there. Absent = the filter does not apply to that
 * scope (shown whole, labelled).
 */
export const GLOBAL_FILTER_FIELDS = Object.freeze({
  properties: { markets: { field_key: 'properties.market', means: 'property market' }, states: { field_key: 'properties.property_address_state', means: 'property state' } },
  buyers: { states: { field_key: 'buyers.states', means: 'bought in' } },
  organizations: { states: { field_key: 'organizations.owner_address_state', means: 'mailing state' } },
})

const clean = (v) => String(v ?? '').trim()

/** `["Miami, FL"]` (JSON) or a single value — market names carry commas, so a list is JSON only. */
export function parseList(raw) {
  if (Array.isArray(raw)) return [...new Set(raw.map(clean).filter(Boolean))]
  const text = clean(raw)
  if (!text) return []
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text)
      return Array.isArray(parsed) ? [...new Set(parsed.map(clean).filter(Boolean))].slice(0, 60) : []
    } catch {
      return []
    }
  }
  return [text]
}

export function parseGlobals(params = {}) {
  return { markets: parseList(params.markets ?? params.market), states: parseList(params.states ?? params.state).map((s) => s.toUpperCase()) }
}

/** The global filters this scope can apply (as rail chips) and the ones it cannot (named). */
export function globalFiltersFor(scope, globals = { markets: [], states: [] }) {
  const map = GLOBAL_FILTER_FIELDS[scope] || {}
  const applied = []
  const ignored = []
  for (const key of ['markets', 'states']) {
    const values = globals[key] || []
    if (!values.length) continue
    const target = map[key]
    if (target) applied.push({ field_key: target.field_key, operator: 'is_any_of', value: values, means: target.means })
    else ignored.push({ key, values, reason: `${SCOPE_LABEL[scope] || scope} has no ${key === 'markets' ? 'market' : 'state'} field — shown for every ${key === 'markets' ? 'market' : 'state'}` })
  }
  return { applied, ignored }
}

const chip = (f) => ({ field_key: f.field_key, operator: f.operator, value: f.value ?? null })

/* ── cache (process-local, stale-while-revalidate for the unfiltered universe) ─ */

const cache = new Map()
const inflight = new Map()
export const __universeTest = { reset() { cache.clear(); inflight.clear() } }

async function cached(key, ttl, now, compute, { staleOk = false } = {}) {
  const hit = cache.get(key)
  if (hit && now - hit.at < ttl) return { ...hit.value, cache: 'fresh' }
  const start = () => {
    if (inflight.has(key)) return inflight.get(key)
    const p = compute().then((value) => {
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value)
      cache.set(key, { at: Date.now(), value })
      return value
    }).finally(() => inflight.delete(key))
    inflight.set(key, p)
    return p
  }
  if (hit && staleOk) {
    start().catch(() => {})
    return { ...hit.value, cache: 'stale' }
  }
  return { ...(await start()), cache: 'miss' }
}

async function pooled(tasks, limit = CONCURRENCY) {
  const out = new Array(tasks.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const i = next
      next += 1
      out[i] = await tasks[i]()
    }
  }))
  return out
}

/* ── facts: the property card family ──────────────────────────────────────── */

const STAGE_LABEL = {
  ownership_confirmation: 'Ownership confirmation', asking_price: 'Asking price', property_condition: 'Property condition',
  offer_interest: 'Offer interest', offer: 'Offer', negotiation: 'Negotiation', contract: 'Contract', closing: 'Closing', closed: 'Closed (lost)',
}
const SMS_LABEL = {
  eligible: 'Eligible', missing_phone: 'No phone', non_sms_capable: 'Not SMS-capable', entity_contact_requires_review: 'Entity contact — review',
  pending_prior_touch: 'Prior touch pending', identity_not_verified: 'Identity not verified', missing_identity_linkage: 'No identity link',
  suppressed: 'Suppressed', wrong_number: 'Wrong number', active_queue_item: 'Already queued', not_in_campaign_audience: 'Not in an audience',
}

/**
 * The statements of the property card family. Each is one GROUP BY (or one
 * count) on an indexed column of eg_property_facts with the cohort's WHERE.
 * `click(key)` is the bucket's chip — the predicate the GROUP BY key equals.
 * least() ignores NULL (least(null, 4) = 4), so a capped bin spells its NULL arm.
 */
export const FACT_STATEMENTS = Object.freeze([
  { id: 'market', column: 'market', expr: '"market"', click: (k) => ({ field_key: 'properties.market', operator: 'is_any_of', value: [k] }) },
  { id: 'state', column: 'property_address_state', expr: '"property_address_state"', click: (k) => ({ field_key: 'properties.property_address_state', operator: 'is_any_of', value: [k] }) },
  { id: 'asset', column: 'asset_type', expr: '"asset_type"', click: (k) => ({ field_key: 'facts.asset_type', operator: 'is_any_of', value: [k] }) },
  { id: 'sms', column: 'sms_status', expr: '"sms_status"', click: (k) => ({ field_key: 'facts.sms_status', operator: 'is_any_of', value: [k] }) },
  {
    id: 'distress', column: 'distress_signal_count', expr: 'case when "distress_signal_count" is null then null else least("distress_signal_count", 4) end',
    click: (k) => (Number(k) >= 4 ? { field_key: 'facts.distress_signal_count', operator: 'gte', value: 4 } : { field_key: 'facts.distress_signal_count', operator: 'between', value: [Number(k), Number(k)] }),
  },
  { id: 'pipeline', column: 'pipeline_stage', expr: '"pipeline_stage"', click: (k) => ({ field_key: 'facts.pipeline_stage', operator: 'is_any_of', value: [k] }) },
  {
    id: 'phones', column: 'contact_candidate_phones', expr: 'case when "contact_candidate_phones" is null then null else least("contact_candidate_phones", 4) end',
    click: (k) => (Number(k) >= 4 ? { field_key: 'facts.contact_candidate_phones', operator: 'gte', value: 4 } : { field_key: 'facts.contact_candidate_phones', operator: 'between', value: [Number(k), Number(k)] }),
  },
  { id: 'equity60', column: 'equity_known_pct', count: '"equity_known_pct" >= 60', filter: { field_key: 'facts.equity_known_pct', operator: 'gte', value: 60 } },
  { id: 'contacted', column: 'last_contact_at', count: '"last_contact_at" is not null', filter: { field_key: 'facts.last_contact_at', operator: 'is_not_empty', value: null } },
])

async function factsRefreshedAt(query) {
  const { rows } = await query(
    `select finished_at as at from public.eg_refresh_log where name = $1 and status = 'ok' order by finished_at desc limit 1`,
    [FACTS], STATEMENT_MS,
  )
  return rows?.[0]?.at ? new Date(rows[0].at).toISOString() : null
}

async function factsColumns(query) {
  const { rows } = await query(
    `select a.attname as c from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = $1 and a.attnum > 0 and not a.attisdropped`,
    [FACTS], STATEMENT_MS,
  )
  return new Set((rows || []).map((r) => r.c))
}

/** The facts family's raw counts for one cohort (where = the list's own WHERE). */
export async function readFactCounts({ query, clauses, params, columns, timings = [] }) {
  const runnable = FACT_STATEMENTS.filter((s) => columns.has(s.column))
  const tasks = runnable.map((s) => async () => {
    const P = paramList()
    const where = P.embed(clauses, params)
    const sql = s.count
      ? `select count(*)::bigint as n from public."${FACTS}" where ${where} and ${s.count}`
      : `select ${s.expr} as k, count(*)::bigint as n from public."${FACTS}" where ${where} group by 1`
    const t0 = Date.now()
    try {
      const { rows } = await query(sql, P.list, STATEMENT_MS)
      timings.push({ label: s.id, ms: Date.now() - t0 })
      return [s.id, s.count ? Number(rows?.[0]?.n) || 0 : (rows || []).map((r) => ({ key: r.k === null || r.k === undefined ? null : String(r.k), count: Number(r.n) || 0 }))]
    } catch (error) {
      timings.push({ label: s.id, ms: Date.now() - t0, error: String(error?.message || error).slice(0, 120) })
      return [s.id, { error: /statement timeout|canceling statement/i.test(String(error?.message)) ? 'Took longer than the 8 s budget — retry.' : 'This count failed — retry.' }]
    }
  })
  return Object.fromEntries(await pooled(tasks))
}

const isErr = (v) => Boolean(v && !Array.isArray(v) && typeof v === 'object' && v.error)
const groups = (v) => (Array.isArray(v) ? v : [])
const sumOf = (v) => groups(v).reduce((a, b) => a + b.count, 0)
const keyed = (v, k) => groups(v).find((g) => g.key === k)?.count ?? 0
const blank = (k) => k === null || k === ''

function bucketsOf(stmt, list, { labels = {}, order = null, noneLabel = 'Not recorded', top = TOP } = {}) {
  const rows = [...groups(list)]
  if (order) rows.sort((a, b) => order(a.key) - order(b.key))
  else rows.sort((a, b) => (blank(a.key) ? 1 : 0) - (blank(b.key) ? 1 : 0) || b.count - a.count)
  const head = rows.filter((r) => !blank(r.key)).slice(0, top)
  const restCount = rows.filter((r) => !blank(r.key)).slice(top).reduce((a, b) => a + b.count, 0)
  const none = rows.filter((r) => blank(r.key)).reduce((a, b) => a + b.count, 0)
  const out = head.map((r) => ({ key: r.key, label: labels[r.key] || r.key, count: r.count, filter: stmt.click(r.key), tone: 'value' }))
  if (restCount) out.push({ key: '__other', label: `${rows.filter((r) => !blank(r.key)).length - top} more`, count: restCount, filter: null, tone: 'other' })
  if (none) out.push({ key: '__none', label: noneLabel, count: none, filter: null, tone: 'none' })
  return out
}

const S = Object.fromEntries(FACT_STATEMENTS.map((s) => [s.id, s]))
const unavailableChart = (key, label, v) => ({ key, label, buckets: [], unavailable: v?.error || 'Not on the property facts read model yet.' })

/** Shape the facts counts into the properties / pipeline / contacts cards. */
export function factCards(counts, { applied = [], ignored = [], asOf = null, ms = null } = {}) {
  const total = isErr(counts.market) || !counts.market ? null : sumOf(counts.market)
  const base = { source: 'facts', as_of: asOf, applied: applied.map(chip), appliedMeans: applied.map((a) => ({ field_key: a.field_key, means: a.means, value: a.value })), ignored, ms }
  const chart = (id, label, opts, form = 'bars') => (isErr(counts[id]) || !counts[id] ? unavailableChart(id, label, counts[id]) : { key: id, label, form, buckets: bucketsOf(S[id], counts[id], opts) })
  const smsEligible = isErr(counts.sms) ? null : keyed(counts.sms, 'eligible')
  const distress2 = isErr(counts.distress) ? null : groups(counts.distress).filter((g) => !blank(g.key) && Number(g.key) >= 2).reduce((a, b) => a + b.count, 0)
  const openDeals = isErr(counts.pipeline) ? null : groups(counts.pipeline).filter((g) => !blank(g.key) && g.key !== 'closed').reduce((a, b) => a + b.count, 0)
  // a phone on file = every property the SMS readiness rule did not stop at "missing_phone" (one indexed read serves both)
  const withPhone = isErr(counts.sms) || !counts.sms ? null : sumOf(counts.sms) - keyed(counts.sms, 'missing_phone')
  const openStages = groups(counts.pipeline).filter((g) => !blank(g.key) && g.key !== 'closed').map((g) => g.key)
  const numOrNull = (v) => (typeof v === 'number' ? v : null)

  const properties = {
    ...base,
    id: 'properties', scope: 'properties', label: SCOPE_LABEL.properties, total,
    kpis: [
      { key: 'sms', label: 'SMS eligible', value: smsEligible, filter: { field_key: 'facts.sms_status', operator: 'is_any_of', value: ['eligible'] } },
      { key: 'equity60', label: '60%+ known equity', value: numOrNull(counts.equity60), filter: S.equity60.filter },
      { key: 'distress2', label: '2+ distress signals', value: distress2, filter: { field_key: 'facts.distress_signal_count', operator: 'gte', value: 2 } },
    ],
    charts: [
      chart('market', 'Markets', {}),
      chart('asset', 'Asset type', {}),
      chart('distress', 'Distress signals stacked', { order: (k) => (blank(k) ? -1 : Number(k)), labels: { 1: '1 signal', 2: '2 signals', 3: '3 signals', 4: '4 or more' }, noneLabel: 'No signals' }, 'histogram'),
    ],
  }
  const pipeline = {
    ...base,
    id: 'pipeline', scope: 'properties', label: SCOPE_LABEL.pipeline, total: openDeals,
    totalLabel: 'open deals',
    totalFilter: openStages.length ? { field_key: 'facts.pipeline_stage', operator: 'is_any_of', value: openStages } : null,
    kpis: [
      { key: 'contacted', label: 'Contacted', value: numOrNull(counts.contacted), filter: S.contacted.filter },
      { key: 'closed', label: 'Closed (lost)', value: isErr(counts.pipeline) ? null : keyed(counts.pipeline, 'closed'), filter: S.pipeline.click('closed') },
    ],
    charts: [chart('pipeline', 'Stage', { labels: STAGE_LABEL, noneLabel: 'Not in pipeline' })].map((c) => ({ ...c, buckets: (c.buckets || []).filter((b) => b.key !== '__none') })),
  }
  const contacts = {
    ...base,
    id: 'contacts', scope: 'properties', label: SCOPE_LABEL.contacts, total: withPhone,
    totalLabel: 'with a phone on file',
    totalFilter: { field_key: 'facts.sms_status', operator: 'is_not_any_of', value: ['missing_phone'] },
    kpis: [
      { key: 'sms', label: 'SMS eligible', value: smsEligible, filter: { field_key: 'facts.sms_status', operator: 'is_any_of', value: ['eligible'] } },
      { key: 'contacted', label: 'Contacted', value: numOrNull(counts.contacted), filter: S.contacted.filter },
    ],
    charts: [
      chart('sms', 'SMS eligibility', { labels: SMS_LABEL }),
      chart('phones', 'Extra phone candidates (not yet in the campaign graph)', { order: (k) => (blank(k) ? -1 : Number(k)), labels: { 0: 'None', 1: '1 phone', 2: '2 phones', 3: '3 phones', 4: '4 or more' }, noneLabel: 'Not counted' }, 'histogram'),
    ],
  }
  return [properties, pipeline, contacts]
}

async function propertiesScope(globals, deps, now) {
  const query = deps.query || queryWithTimeout
  const { applied, ignored } = globalFiltersFor('properties', globals)
  const unfiltered = !applied.length
  const key = `properties|${JSON.stringify(applied.map(chip))}`
  return cached(key, unfiltered ? UNIVERSE_TTL_MS : CACHE_TTL_MS, now, async () => {
    const started = Date.now()
    const timings = []
    const [asOf, columns] = await Promise.all([factsRefreshedAt(query).catch(() => null), factsColumns(query)])
    if (!asOf || !columns.size) {
      return { cards: [{ id: 'properties', scope: 'properties', label: SCOPE_LABEL.properties, total: null, kpis: [], charts: [], applied: applied.map(chip), ignored, source: null, as_of: null, unavailable: 'The property facts read model has no successful refresh yet.' }], timings, ms: Date.now() - started }
    }
    // the list's own WHERE (browse appliers + the rail's field filters), never re-implemented
    const cohort = compileCohort({ tab: 'properties', field_filters: JSON.stringify(applied.map(chip)) }, { tab: 'properties' })
    const counts = await readFactCounts({ query, clauses: cohort.clauses, params: cohort.params, columns, timings })
    const ms = Date.now() - started
    const options = unfiltered ? {
      markets: groups(counts.market).filter((g) => !blank(g.key)).sort((a, b) => b.count - a.count).map((g) => ({ value: g.key, count: g.count })),
      states: groups(counts.state).filter((g) => !blank(g.key)).sort((a, b) => b.count - a.count).map((g) => ({ value: g.key, count: g.count })),
    } : null
    return { cards: factCards(counts, { applied, ignored, asOf, ms }), options, timings, ms }
  }, { staleOk: unfiltered })
}

/* ── the other scopes: snapshot, else their own Overview live ─────────────── */

export async function readScopeSnapshot(query, tab) {
  const { rows } = await query(
    `select distinct on (section) section, payload, refreshed_at from public."${SNAPSHOT}"
      where tab = $1 and section = any($2::text[]) and registry_version = $3 order by section, refreshed_at desc`,
    [tab, ['pinned', 'headline'], overviewRegistryVersion(overviewRegistry(tab))], STATEMENT_MS,
  )
  const by = new Map((rows || []).map((r) => [r.section, r]))
  const pinned = by.get('pinned')?.payload
  const head = by.get('headline')?.payload
  if (!pinned || !head?.headline) return null
  const at = [by.get('pinned')?.refreshed_at, by.get('headline')?.refreshed_at].filter(Boolean).map((d) => new Date(d).getTime())
  return { total: head.total ?? null, headline: head.headline, pinned, refreshedAt: at.length ? new Date(Math.min(...at)).toISOString() : null }
}

/** One scope Overview (pinned fields + headline metrics) → a page card. */
export function overviewCard(scope, { total, headline, pinned }, extra = {}) {
  const metrics = (headline?.metrics || []).filter((m) => m.key !== 'cohort' && !m.sensitive)
  const fields = (pinned?.fields || []).filter((f) => Array.isArray(f.buckets) && f.buckets.length && !f.unavailable && !f.sensitive)
  return {
    id: scope,
    scope,
    label: SCOPE_LABEL[scope] || scope,
    total: typeof total === 'number' ? total : total === null || total === undefined ? null : Number(total),
    kpis: metrics.slice(0, 3).map((m) => ({ key: m.key, label: m.label, value: typeof m.value === 'number' ? m.value : null, filter: m.filter || null })),
    charts: fields.slice(0, 3).map((f) => ({
      key: f.key,
      label: f.label,
      form: f.kind === 'numeric' || f.kind === 'date' ? 'histogram' : 'bars',
      buckets: f.buckets.slice(0, TOP + 2).map((b) => ({ key: b.key ?? null, label: b.label, count: Number(b.count) || 0, filter: b.filter || null, tone: b.tone || 'value' })),
    })),
    ...extra,
  }
}

async function otherScope(scope, globals, deps, now) {
  const query = deps.query || queryWithTimeout
  const { applied, ignored } = globalFiltersFor(scope, globals)
  const unfiltered = !applied.length
  const key = `${scope}|${JSON.stringify(applied.map(chip))}`
  return cached(key, unfiltered ? UNIVERSE_TTL_MS : CACHE_TTL_MS, now, async () => {
    const started = Date.now()
    const base = { applied: applied.map(chip), appliedMeans: applied.map((a) => ({ field_key: a.field_key, means: a.means, value: a.value })), ignored }
    if (unfiltered && !deps.skipSnapshot) {
      const snap = await readScopeSnapshot(query, scope).catch(() => null)
      if (snap) return { cards: [overviewCard(scope, snap, { ...base, source: 'snapshot', as_of: snap.refreshedAt, ms: Date.now() - started })], ms: Date.now() - started }
    }
    // no snapshot (or a filtered cohort): the scope's own Overview, live on its base table (exact)
    const res = await (deps.buildOverview || buildEntityGraphOverview)(
      { tab: scope, sections: 'pinned,headline', ...(applied.length ? { field_filters: JSON.stringify(applied.map(chip)) } : {}) },
      { ...(deps.query ? { query: deps.query } : {}), skipSnapshot: true, allowUniverseScan: unfiltered, timeoutMs: STATEMENT_MS },
    )
    if (!res?.supported) return { cards: [{ id: scope, scope, label: SCOPE_LABEL[scope], total: null, kpis: [], charts: [], ...base, source: null, as_of: null, unavailable: res?.unavailable?.[0]?.reason || 'This scope has no Overview.' }], ms: Date.now() - started }
    const pinned = (res.sections || []).find((s) => s.id === 'pinned') || { fields: [] }
    const card = overviewCard(scope, { total: res.total, headline: res.headline, pinned }, { ...base, source: 'live', as_of: new Date().toISOString(), ms: Date.now() - started })
    if (res.unavailable?.length) card.partial = res.unavailable.map((u) => u.reason).filter((v, i, a) => a.indexOf(v) === i).join(' · ')
    return { cards: [card], ms: Date.now() - started }
  }, { staleOk: unfiltered })
}

/* ── the endpoint ─────────────────────────────────────────────────────────── */

export async function buildEntityGraphUniverse(params = {}, deps = {}) {
  const scope = clean(params.scope || 'properties').toLowerCase()
  if (!UNIVERSE_SCOPES.includes(scope)) {
    const error = new Error(`universe_scope_unknown: ${scope}`)
    error.code = 'universe_scope_unknown'
    throw error
  }
  if (!deps.query && !hasDatabaseUrl()) return { ok: true, scope, cards: [], unavailable: 'The Overview needs the direct database connection.' }
  const globals = parseGlobals(params)
  const now = deps.now ?? Date.now()
  const started = Date.now()
  const out = scope === 'properties' ? await propertiesScope(globals, deps, now) : await otherScope(scope, globals, deps, now)
  // the cache is keyed by what a scope APPLIES; what it ignores is this request's (a cached universe still says so)
  const { ignored } = globalFiltersFor(scope, globals)
  const cards = out.cards.map((c) => ({ ...c, ignored }))
  return { ok: true, scope, globals, cards, options: out.options ?? null, cache: out.cache, timings: { totalMs: Date.now() - started, computedMs: out.ms ?? null, statements: out.timings || [] } }
}

export default buildEntityGraphUniverse
