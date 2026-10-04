/**
 * MARKET INTELLIGENCE SERVICE: "Where should we be hunting, what is happening
 * there, and why?" (brief §1). Read-only. Never throws to the route.
 *
 * Lifecycle: the first request starts ONE index build (mi-loader → sales index
 * + geography catalog). Until it is ready every op answers
 * { status: 'warming', progress } honestly. A cheap freshness probe (max
 * sold_on + reltuples) runs at most every 15 min; a changed MV is rebuilt in the
 * background while the old index keeps serving.
 *
 * Ops:
 *   status · registry · search · geography · dossier · rank · screen · compare
 *   trends · heat · recent_sales · universe_load
 * Every op except recent_sales and universe_load runs in memory (0 DB queries).
 */
import { createMarketIntelLoader } from './mi-loader.js'
import { createSalesIndexBuilder, aggregate, aggregateBy, rowsOf, monthlySeries, nationalMonthCounts, medianOf, UNIT_BUCKETS, SQFT_BUCKETS } from './mi-sales-index.js'
import { buildGeographyCatalog, parseGeoId, searchGeographies, summaryOf, LEVEL_ORDER, LEVEL_LABEL, titleCase } from './mi-geography.js'
import { METRICS, METRIC_BY_ID, registryPayload, metricSupports } from './mi-metric-registry.js'
import { DEFAULT_PERIOD, PERIODS, dateOfDay, dayOfDate, deriveCoverage, periodWindow, monthLabel } from './mi-periods.js'
import { ASSET_FILTERS, ASSET_LABEL, MI_ASSETS, assetFilterCodes, createAssetClassifier } from './mi-asset-classes.js'
import { salesValues, universeValues, stockValues, censusValues, topBuyers, rankRows, passesFilters, unavailable } from './mi-metric-values.js'
import { createUniverseStore, summarizeUniverse, universeMatches } from './mi-universe.js'
import { readMapBoundaries } from '@/lib/domain/map/map-boundaries-service.js'
import { displayableCompanyName } from '@/lib/domain/entity-graph/buyer-name-privacy.js'
import { lenderClass } from '@/lib/domain/buyer-match/buyer-identity-rules.js'
import { queryWithTimeout } from '@/lib/postgres/client.js'

const PROBE_EVERY_MS = 15 * 60_000
const MAX_AGE_MS = 26 * 3600_000
const BUSY_RETRY_MS = 60_000
const CACHE_MAX = 240
const RECENT_TTL_MS = 30 * 60_000
const assetLabelOf = (code) => ASSET_LABEL[MI_ASSETS[code]] || 'Unknown'

export function createMarketIntelService(deps = {}) {
  const loader = deps.loader || createMarketIntelLoader(deps)
  const clock = deps.clock || (() => Date.now())
  const boundaries = deps.readBoundaries || readMapBoundaries
  const classify = createAssetClassifier()
  const universe = createUniverseStore({ loader, clock, classify })
  let state = { status: 'cold', progress: null, error: null, retryAt: 0 }
  let current = null // { version, index, catalog, aux, coverage, loadedAt, freshness, … }
  let building = null
  let lastProbe = 0
  const cache = new Map()
  const recentCache = new Map()

  // ── lifecycle ──────────────────────────────────────────────────────────
  async function build() {
    const t0 = clock()
    const g = await loader.guard()
    if (!g.ok) { state = { ...state, status: current ? 'ready' : 'deferred', error: g.reason, retryAt: clock() + BUSY_RETRY_MS }; return }
    const fresh = await loader.freshness()
    state = { ...state, status: current ? 'ready' : 'loading', progress: { rows: 0, est: fresh.est_rows, phase: 'sales' }, error: null }
    const b = createSalesIndexBuilder({ classify })
    const tSales = clock()
    await loader.streamSales((rows) => b.ingest(rows), (rows) => { state = { ...state, progress: { rows, est: fresh.est_rows, phase: 'sales' } } })
    const index = b.finish()
    const salesMs = clock() - tSales
    state = { ...state, progress: { rows: index.n, est: fresh.est_rows, phase: 'reference' } }
    const tAux = clock()
    const aux = {}
    for (const name of ['searchAreas', 'markets', 'zipMarket', 'aliases', 'census', 'outlined', 'areaStats', 'graphCoverage', 'parcelZipCounty']) aux[name] = await loader.aux(name)
    const auxMs = clock() - tAux
    const census = new Map(aux.census.map((c) => [c.geo_id, c]))
    const censusZipCounty = aux.census.filter((c) => c.geo_level === 'zip5' && c.county_geo_id).map((c) => ({ zip: c.geo_id.slice(5), state: c.state_code, county_key: c.county_geo_id.replace(/^county:/, ''), county_name: c.county_name }))
    const outlined = { zip: new Set(aux.outlined.filter((r) => r.geo_level === 'zip5').map((r) => r.k)), state: new Set(aux.outlined.filter((r) => r.geo_level === 'state').map((r) => r.k)) }
    const catalog = buildGeographyCatalog(index, { searchAreas: aux.searchAreas, markets: aux.markets, zipMarket: aux.zipMarket, aliases: aux.aliases, censusZipCounty, parcelZipCounty: aux.parcelZipCounty, outlined })
    const coverage = deriveCoverage(nationalMonthCounts(index), index.maxDay)
    const areaStats = new Map(aux.areaStats.map((r) => [`${r.kind}|${r.key}`, r]))
    const propertyN = new Map(aux.searchAreas.map((a) => [`${a.kind}|${a.key}`, Number(a.n) || 0]))
    const marketName = new Map(aux.markets.map((m) => [m.id, m.display_name]))
    const marketSlugByName = new Map(aux.markets.map((m) => [m.display_name, m.id]))
    const zipsByMarket = new Map()
    for (const r of aux.zipMarket) { const l = zipsByMarket.get(r.canonical_market_id) || []; l.push(String(r.zip5)); zipsByMarket.set(r.canonical_market_id, l) }
    const assetPresent = new Set(index.cols.asset)
    const levelNodes = Object.fromEntries(LEVEL_ORDER.map((lv) => [lv, [...catalog.nodes.values()].filter((n) => n.level === lv)]))
    current = {
      version: `${fresh.max_sold_on}|${index.n}|${clock()}`, index, catalog, assetPresent, coverage, census, areaStats, propertyN, marketName, marketSlugByName, zipsByMarket, levelNodes,
      graphCoverage: aux.graphCoverage[0] || null, loadedAt: clock(), freshness: fresh,
      timings: { sales_ms: salesMs, reference_ms: auxMs, total_ms: clock() - t0 }, rawTypes: index.rawTypes,
    }
    cache.clear()
    lastProbe = clock()
    state = { status: 'ready', progress: null, error: null, retryAt: 0 }
    // Prewarm the national tables the first screens read (CPU only, no DB), off the request path.
    if (deps.prewarm !== false) setTimeout(() => { try { for (const lv of ['state', 'market', 'zip']) childTable(lv, 'nation:US', DEFAULT_PERIOD, 'all') } catch { /* best effort */ } }, 0)
  }

  function kick() {
    if (building) return building
    if (state.status === 'deferred' && clock() < state.retryAt) return null
    building = build().catch((error) => { state = { ...state, status: current ? 'ready' : 'error', error: String(error?.message || error), retryAt: clock() + BUSY_RETRY_MS } })
      .finally(() => { building = null })
    return building
  }

  async function probe() {
    if (!current || building || clock() - lastProbe < PROBE_EVERY_MS) return
    lastProbe = clock()
    try {
      const f = await loader.freshness()
      if (f.max_sold_on !== current.freshness.max_sold_on || (f.est_rows && current.freshness.est_rows && f.est_rows !== current.freshness.est_rows) || clock() - current.loadedAt > MAX_AGE_MS) kick()
    } catch { /* keep serving */ }
  }

  function statusPayload() {
    const base = { status: current ? 'ready' : state.status, progress: state.progress, error: state.error }
    if (!current) return base
    const c = current
    return {
      ...base,
      as_of: dateOfDay(c.index.maxDay), first_sale: dateOfDay(c.index.minDay), rows: c.index.n, loaded_at: new Date(c.loadedAt).toISOString(), timings: c.timings,
      coverage: { coverage_start: c.coverage.coverage_start_month === null ? null : monthLabel(c.coverage.coverage_start_month), complete_through: c.coverage.complete_through_month === null ? null : monthLabel(c.coverage.complete_through_month), months: c.coverage.months.map(({ label, n, status }) => ({ label, n, status })) },
      membership: c.catalog.membershipCoverage,
      sources: {
        sales: { source: 'mv_map_market_sales', refresh: 'daily 10:07 UTC (pg_cron refresh_map_market_sales)', as_of: dateOfDay(c.index.maxDay) },
        census: { source: 'US Census ACS 5-year', vintage: [...c.census.values()][0]?.vintage ?? null },
        graph: { source: 'campaign_target_graph', measured_at: c.graphCoverage?.measured_at ?? null, phone_type_coverage: c.graphCoverage?.coverage?.phone_type ?? null, loaded_states: universe.loaded() },
        areas: { source: 'mv_map_search_areas / mv_map_property_area_stats', refresh: 'no scheduled refresh (as last built)' },
      },
      asset_filters: ASSET_FILTERS.map((f) => ({ id: f.id, label: f.label, available: f.id === 'all' || assetAvailable(f.id) })),
      periods: PERIODS.map((p) => ({ id: p.id, label: p.label })),
      raw_types: c.rawTypes,
    }
  }

  function assetAvailable(id) {
    const f = assetFilterCodes(id)
    if (!f.ok || !f.codes) return true
    return [...f.codes].some((code) => current.assetPresent.has(code))
  }

  async function ready() {
    if (!current) {
      const p = kick()
      if (p) await Promise.race([p, new Promise((r) => setTimeout(r, deps.warmWaitMs ?? 1500))])
    } else void probe()
    return Boolean(current)
  }
  const warming = () => ({ ok: true, ...statusPayload(), status: current ? 'ready' : (state.status === 'cold' ? 'loading' : state.status) })

  // ── shared computations ────────────────────────────────────────────────
  function memo(key, fn) {
    const k = `${current.version}|${universeVersion()}|${key}`
    if (cache.has(k)) { const v = cache.get(k); cache.delete(k); cache.set(k, v); return v }
    const v = fn()
    cache.set(k, v)
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
    return v
  }
  const universeVersion = () => universe.loaded().map((s) => `${s}:${universe.get(s)?.loadedAt}`).join(',')

  function ctxFor(periodId, assetId) {
    const p = PERIODS.some((x) => x.id === periodId) ? periodId : DEFAULT_PERIOD
    const asset = assetFilterCodes(assetId || 'all')
    const window = periodWindow(p, current.index.maxDay, current.index.minDay)
    return { periodId: p, window, coverage: current.coverage, asset: asset.ok ? asset : assetFilterCodes('all'), win: { from: window.from, to: window.to, codes: asset.ok ? asset.codes : null } }
  }

  const statesOf = (geo) => {
    if (geo.level === 'nation') return current.levelNodes.state.map((n) => n.key)
    return geo.state ? [geo.state] : []
  }

  function universeFor(geo, codes) {
    const sts = statesOf(geo)
    const loaded = sts.filter((s) => universe.get(s))
    if (!sts.length) return { values: universeValues(null, 'unavailable', 'No state for this geography'), summary: null, loaded: [], missing: [] }
    if (loaded.length < sts.length) {
      const missing = sts.filter((s) => !universe.get(s))
      return { values: universeValues(null, 'not_loaded', geo.level === 'nation' ? `Seller universe loaded for ${loaded.length} of ${sts.length} states` : 'Seller universe not loaded for this state yet'), summary: null, loaded, missing }
    }
    const rows = []
    for (const s of sts) for (const r of universe.get(s).rows) if (universeMatches(r, geo, current.marketName)) rows.push(r)
    const summary = summarizeUniverse(rows, { assetCodes: codes })
    return { values: universeValues(summary), summary, loaded, missing: [] }
  }

  function stockFor(geo) {
    const kind = geo.level === 'zip' ? 'zip' : geo.level === 'county' ? 'county' : geo.level === 'state' ? 'state' : null
    const pnKey = geo.level === 'market' ? `market|${current.marketName.get(geo.key)}` : `${geo.level}|${geo.key}`
    let pn = geo.level === 'nation' ? current.levelNodes.state.reduce((t, n) => t + (current.propertyN.get(`state|${n.key}`) || 0), 0) : current.propertyN.get(pnKey)
    if (pn === undefined) pn = null
    if (geo.level === 'nation') {
      // Mean of means weighted by n is the true national mean.
      const rows = [...current.areaStats.values()].filter((r) => r.kind === 'state')
      const n = rows.reduce((t, r) => t + (Number(r.n) || 0), 0)
      const w = (col) => (n ? rows.reduce((t, r) => t + (Number(r[col]) || 0) * (Number(r.n) || 0), 0) / n : null)
      return stockValues({ n, equity: w('equity'), value: w('value'), year_built: w('year_built'), distress: w('distress'), tax_delinquent: w('tax_delinquent'), free_clear: w('free_clear') }, pn)
    }
    return stockValues(kind ? current.areaStats.get(`${kind}|${geo.key}`) || null : null, pn)
  }

  function censusFor(geo) {
    if (geo.level === 'zip') return censusValues(current.census.get(`zip5:${geo.key}`) || null)
    if (geo.level === 'county' || geo.level === 'city') return censusValues(current.census.get(`${geo.level}:${geo.key}`) || null)
    if (geo.level === 'state') return censusValues(current.census.get(`state:${geo.key}`) || null)
    if (geo.level === 'market') {
      const zips = current.zipsByMarket.get(geo.key) || []
      return censusValues(null, { cells: zips.map((z) => current.census.get(`zip5:${z}`)).filter(Boolean), expected: zips.length })
    }
    const states = [...current.census.values()].filter((c) => c.geo_level === 'state')
    return censusValues(null, { cells: states, expected: current.levelNodes.state.length })
  }

  /** All metric values for one geography (memoised). */
  function valuesFor(geoId, periodId, assetId) {
    return memo(`v|${geoId}|${periodId}|${assetId}`, () => {
      const geo = current.catalog.get(geoId)
      const ctx = ctxFor(periodId, assetId)
      const acc = aggregate(current.index, rowsOf(current.index, current.catalog.selectorFor(geoId)), ctx.win)
      const u = universeFor(geo, ctx.asset.codes)
      return { acc, ctx, values: { ...salesValues(acc, ctx), ...u.values, ...stockFor(geo), ...censusFor(geo) }, universe: u }
    })
  }

  /**
   * Every child of `parentId` at `level` with every metric: the one table that
   * rankings, the screener and heat all read (memoised per index version).
   */
  function childTable(level, parentId, periodId, assetId) {
    return memo(`t|${level}|${parentId}|${periodId}|${assetId}`, () => {
      const parent = current.catalog.get(parentId)
      const ctx = ctxFor(periodId, assetId)
      const child = current.catalog.child[level]
      const accs = aggregateBy(current.index, rowsOf(current.index, current.catalog.selectorFor(parentId)), ctx.win, child.of)
      const byId = new Map([...accs.entries()].map(([k, acc]) => [child.id(k), acc]))
      const parentKey = parent.level === 'nation' ? null : parent.level
      // Children = members by parent attribute ∪ every child with sales inside the parent
      // (a ZIP's sales inside a city are counted for that city, even if the ZIP's majority city differs).
      const nodes = current.levelNodes[level].filter((n) => !parentKey || byId.has(n.id) || n.parents?.[parentKey] === parentId || (parentKey === 'state' && n.state === parent.key))
      // Seller universe grouped once per child when the parent's states are loaded.
      const sts = statesOf(parent)
      const uLoaded = sts.length && sts.every((s) => universe.get(s))
      const uGroups = new Map()
      if (uLoaded) {
        for (const s of sts) {
          for (const r of universe.get(s).rows) {
            if (!universeMatches(r, parent, current.marketName)) continue
            const id = universeChildId(level, r, s)
            if (!id) continue
            const l = uGroups.get(id) || []
            l.push(r)
            uGroups.set(id, l)
          }
        }
      }
      const empty = aggregate(current.index, { all: false, lists: [] }, ctx.win)
      const rows = nodes.map((n) => {
        const acc = byId.get(n.id) || empty
        const uValues = uLoaded ? universeValues(summarizeUniverse(uGroups.get(n.id) || [], { assetCodes: ctx.asset.codes })) : universeValues(null, 'not_loaded', `Seller universe not loaded for ${sts.length === 1 ? sts[0] : `${sts.filter((s) => !universe.get(s)).length} states`}`)
        return { id: n.id, level: n.level, label: n.label, name: n.name, state: n.state, parents: n.parents, centroid: n.centroid, geometry: n.geometry, values: { ...salesValues(acc, ctx), ...uValues, ...stockFor(n), ...censusFor(n) } }
      }).filter((r) => r.values.sales_count.value > 0 || (r.values.seller_record_count?.value ?? 0) > 0 || (r.values.property_count?.value ?? 0) > 0)
      return { rows, ctx, parent, universe: { states: sts, loaded: sts.filter((s) => universe.get(s)) } }
    })
  }

  function universeChildId(level, r, st) {
    switch (level) {
      case 'zip': return r.zip ? `zip:${r.zip}` : null
      case 'city': return r.city ? `city:${st}:${r.city}` : null
      case 'county': return r.county ? `county:${st}:${r.county}` : null
      case 'market': { const slug = current.marketSlugByName.get(r.market); return slug ? `market:${slug}` : null }
      case 'state': return `state:${st}`
      default: return null
    }
  }

  const windowPayload = (ctx) => ({ period: ctx.periodId, from: ctx.window.from_date, to: ctx.window.to_date, asset: ctx.asset.id, asset_label: ctx.asset.label })

  function lineage(geo) {
    return ['nation', 'state', 'market', 'county', 'city'].map((lv) => geo.parents?.[lv]).filter(Boolean).map((id) => current.catalog.get(id)).filter(Boolean).map((n) => ({ id: n.id, level: n.level, label: n.label }))
  }

  /** Where this geography ranks inside each of its parents, for a few headline metrics. */
  function rankContext(geo, periodId, assetId) {
    const out = []
    const parentIds = ['market', 'county', 'state', 'nation'].map((lv) => geo.parents?.[lv]).filter(Boolean)
    for (const pid of parentIds.filter((id) => (current.levelNodes[geo.level] || []).filter((n) => id === 'nation:US' || n.parents?.[current.catalog.get(id)?.level] === id).length >= 3).slice(0, 2)) {
      const t = childTable(geo.level, pid, periodId, assetId)
      const parent = current.catalog.get(pid)
      for (const metric of ['sales_count', 'investor_purchase_count', 'median_sale_price']) {
        const { ranked } = rankRows(t.rows.map((r) => ({ ...r })), metric)
        const me = ranked.find((r) => r.id === geo.id)
        if (me && ranked.length >= 3) out.push({ metric, parent_id: pid, parent_label: parent?.label ?? pid, rank: me.rank, of: ranked.length, level: geo.level })
      }
    }
    return out
  }

  function deterministicBrief(geo, values, ctx, topChild) {
    const fmtN = (n) => Math.round(n).toLocaleString('en-US')
    const usd = (n) => (n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M` : `$${Math.round(n / 1000)}K`)
    const pct = (x) => `${Math.round(x * 100)}%`
    const s = []
    const v = values
    s.push({ text: `${geo.label} had ${fmtN(v.sales_count.value)} recorded sales from ${ctx.window.from_date} to ${ctx.window.to_date} (sales data through ${dateOfDay(current.index.maxDay)}).`, metrics: ['sales_count'] })
    if (v.median_sale_price.status === 'ok') s.push({ text: `Median qualified price ${usd(v.median_sale_price.value)} on ${fmtN(v.median_sale_price.n)} sales${v.median_ppsf.status === 'ok' ? `; $${Math.round(v.median_ppsf.value)} per sq ft` : ''}.`, metrics: ['median_sale_price', 'median_ppsf'] })
    if (v.investor_purchase_share.status === 'ok') s.push({ text: `Investor purchases ${fmtN(v.investor_purchase_count.value)}: ${pct(v.investor_purchase_share.value)} of the ${fmtN(v.investor_purchase_share.n)} sales with a recorded buyer (a buyer is recorded on ${pct(v.buyer_evidence_coverage.value ?? 0)} of sales).`, metrics: ['investor_purchase_count', 'investor_purchase_share', 'buyer_evidence_coverage'] })
    else s.push({ text: `Investor purchases ${fmtN(v.investor_purchase_count.value)}. Only ${fmtN(v.investor_purchase_share.n)} sales record a buyer, too few for an investor share.`, metrics: ['investor_purchase_count', 'investor_purchase_share'] })
    if (topChild) s.push({ text: `${topChild.label} is #1 of ${fmtN(topChild.of)} ${LEVEL_LABEL[topChild.level]}s by investor purchases (${fmtN(topChild.value)}).`, metrics: ['investor_purchase_count'] })
    if (v.cash_purchase_share.status === 'ok') s.push({ text: `Cash share ${pct(v.cash_purchase_share.value)} of ${fmtN(v.cash_purchase_share.n)} sales with cash evidence.`, metrics: ['cash_purchase_share'] })
    s.push({ text: `${fmtN(v.entity_owned_count.value)} properties are entity-owned now. That is a current state, not a count of purchases.`, metrics: ['entity_owned_count'] })
    if (v.sales_growth.status === 'ok') s.push({ text: `Sales ${v.sales_growth.value >= 0 ? 'up' : 'down'} ${Math.abs(Math.round(v.sales_growth.value * 100))}%: ${v.sales_growth.basis}.`, metrics: ['sales_growth'] })
    else s.push({ text: `No sales-change figure: ${v.sales_growth.reason.replace(/^No valid baseline: /, '')}.`, metrics: ['sales_growth'] })
    return s
  }

  // ── ops ────────────────────────────────────────────────────────────────
  const fail = (status, error, extra = {}) => ({ ok: false, status, error, ...extra })
  const geoOr404 = (id) => { const g = current.catalog.get(String(id || '')); return g || null }

  async function run(op, p = {}) {
    try {
      if (op === 'registry') return { ok: true, ...registryPayload(), asset_filters: ASSET_FILTERS, periods: PERIODS }
      if (!(await ready())) return warming()
      switch (op) {
        case 'status': return { ok: true, ...statusPayload() }
        case 'search': return { ok: true, ...searchGeographies(current.catalog, p.q, { limit: Math.min(20, Number(p.limit) || 12) }) }
        case 'geography': {
          const g = geoOr404(p.id)
          if (!g) return fail(404, 'unknown_geography')
          const childLevels = LEVEL_ORDER.slice(LEVEL_ORDER.indexOf(g.level) + 1).filter((lv) => !(g.level === 'county' && lv === 'market') && !(g.level === 'city' && (lv === 'market' || lv === 'county')))
          return { ok: true, geography: { ...summaryOf(g), aliases: g.aliases, county_via: g.county_via || null, lineage: lineage(g) }, child_levels: childLevels }
        }
        case 'dossier': return dossier(p)
        case 'rank': return rank(p)
        case 'screen': return screen(p)
        case 'compare': return compare(p)
        case 'trends': return trends(p)
        case 'heat': return heat(p)
        case 'recent_sales': return recentSales(p)
        case 'universe_load': return universeLoad(p)
        default: return fail(400, 'unknown_op')
      }
    } catch (error) {
      return fail(500, 'market_intel_failed', { message: String(error?.message || error) })
    }
  }

  async function dossier(p) {
    const g = geoOr404(p.id)
    if (!g) return fail(404, 'unknown_geography')
    // A single geography may trigger its state's universe load (one indexed query, cached 6 h).
    if (g.level !== 'nation' && g.state && !universe.get(g.state) && p.load_universe !== '0') {
      await Promise.race([universe.load(g.state).catch(() => null), new Promise((r) => setTimeout(r, deps.universeWaitMs ?? 8000))])
    }
    const period = p.period || DEFAULT_PERIOD
    const asset = p.asset || 'all'
    const { acc, ctx, values, universe: u } = valuesFor(g.id, period, asset)
    const childLevel = { nation: 'state', state: 'market', market: 'zip', county: 'zip', city: 'zip', zip: null }[g.level]
    let children = null
    let topChild = null
    if (childLevel) {
      const t = childTable(childLevel, g.id, period, asset)
      const { ranked } = rankRows(t.rows.map((r) => ({ ...r })), 'investor_purchase_count')
      if (ranked[0] && ranked[0].values.investor_purchase_count.value > 0) topChild = { label: ranked[0].label, level: childLevel, value: ranked[0].values.investor_purchase_count.value, of: ranked.length }
      children = { level: childLevel, count: t.rows.length }
    }
    const series = trendSeries(g.id, asset)
    const buyerKinds = { company_named: acc.namedPurchases, lender_or_agency: acc.lenderPurchases }
    const months = current.coverage.months
    return {
      ok: true,
      geography: { ...summaryOf(g), lineage: lineage(g), county_via: g.county_via || null },
      window: windowPayload(ctx),
      values,
      rank_context: rankContext(g, period, asset),
      children,
      sales: {
        asset_mix: [...acc.assetMix.entries()].map(([code, n]) => ({ asset: MI_ASSETS[code], label: assetLabelOf(code), n })).sort((a, b) => b.n - a.n),
        source_mix: { mls: acc.mls, public_record: acc.sales - acc.mls },
        price_deciles: deciles(acc.prices),
        latest_sale: acc.latestDay === null ? null : dateOfDay(acc.latestDay),
      },
      investors: { top_buyers: topBuyers(acc, current.index, assetLabelOf, 12).map((b) => ({ ...b, last_purchase: dateOfDay(b.last_purchase_day) })), buyer_kinds: buyerKinds, individuals_named: false },
      multifamily: {
        unit_distribution: UNIT_BUCKETS.map(([, , label]) => ({ label, n: acc.unitDist.get(label) || 0 })).concat([{ label: 'not recorded', n: acc.unitDist.get('not recorded') || 0 }]),
        size_distribution: SQFT_BUCKETS.map(([, , label]) => ({ label, n: acc.sqftDist.get(label) || 0 })).concat([{ label: 'not recorded', n: acc.sqftDist.get('not recorded') || 0 }]),
      },
      universe: { loaded_states: u.loaded, missing_states: u.missing, stock: u.summary?.stock ?? null, types: u.summary ? u.summary.types.map((t) => ({ asset: MI_ASSETS[t.code], label: assetLabelOf(t.code), n: t.n })) : null, corporate_owner_count: u.summary?.corporate_owner_count ?? null, never_contacted_count: u.summary?.never_contacted_count ?? null, property_count: u.summary?.property_count ?? null, phone_type_coverage: u.summary?.phone_type_coverage ?? null, authority: 'Campaign Composer computes the authoritative audience; these are graph flags summarised.' },
      trends: series,
      data_quality: dataQuality(g, acc, u),
      brief: deterministicBrief(g, values, ctx, topChild),
      coverage_months: months.map(({ label, status }) => ({ label, status })),
    }
  }

  function deciles(prices) {
    if (prices.length < 10) return null
    const s = [...prices].sort((a, b) => a - b)
    return [0.1, 0.25, 0.5, 0.75, 0.9].map((q) => ({ q, value: s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))] }))
  }

  function dataQuality(g, acc, u) {
    const share = (a, b) => (b ? a / b : null)
    const typed = acc.sales - (acc.assetMix.get(0) || 0)
    return {
      sales_as_of: dateOfDay(current.index.maxDay),
      sales_refresh: 'mv_map_market_sales refreshes daily at 10:07 UTC',
      index_loaded_at: new Date(current.loadedAt).toISOString(),
      coverage_start: current.coverage.coverage_start_month === null ? null : monthLabel(current.coverage.coverage_start_month),
      complete_through: current.coverage.complete_through_month === null ? null : monthLabel(current.coverage.complete_through_month),
      coordinates: 'Every sale in the source is geocoded (rows without coordinates are excluded upstream)',
      property_type_coverage: share(typed, acc.sales),
      unit_count_coverage_mf: acc.mfSales ? share(acc.mfSales - (acc.unitDist.get('not recorded') || 0), acc.mfSales) : null,
      sqft_coverage_priced: share(acc.ppsf.length, acc.qualified),
      buyer_coverage: share(acc.buyerKnown, acc.sales),
      cash_coverage: share(acc.cashKnown, acc.sales),
      county_membership: g.level === 'county' || g.county_via ? (g.county_via === 'parcel_majority' ? 'ZIP parcel-majority county (no census cell)' : 'Census ZIP→county') : null,
      census_vintage: [...current.census.values()][0]?.vintage ?? null,
      graph_measured_at: current.graphCoverage?.measured_at ?? null,
      phone_type_coverage: u.summary?.phone_type_coverage ?? current.graphCoverage?.coverage?.phone_type ?? null,
      geometry: g.geometry === 'none' ? `No ${LEVEL_LABEL[g.level].toLowerCase()} polygon in the database; centroid and bounds only` : 'US Census TIGER polygon',
    }
  }

  function trendSeries(id, assetId) {
    return memo(`s|${id}|${assetId}`, () => {
      const codes = assetFilterCodes(assetId || 'all').codes
      const m = monthlySeries(current.index, rowsOf(current.index, current.catalog.selectorFor(id)), codes)
      return current.coverage.months.map(({ month, label, status }) => {
        const s = m.get(month)
        if (!s) return { month: label, status, sales: 0, median_price: null, median_ppsf: null, investor_purchases: 0, investor_share: null, buyer_known: 0, cash_share: null, cash_known: 0, company_acquisitions: 0 }
        return {
          month: label, status, sales: s.sales,
          median_price: s.prices.length >= 5 ? medianOf(s.prices) : null, price_n: s.prices.length,
          median_ppsf: s.ppsf.length >= 5 ? medianOf(s.ppsf) : null,
          investor_purchases: s.investor, buyer_known: s.buyerKnown, investor_share: s.buyerKnown >= 10 ? s.investor / s.buyerKnown : null,
          cash_known: s.cashKnown, cash_share: s.cashKnown >= 10 ? s.cash / s.cashKnown : null,
          company_acquisitions: s.entityAcq,
        }
      })
    })
  }

  function trends(p) {
    const ids = String(p.ids || p.id || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 6)
    const geos = ids.map(geoOr404)
    if (!geos.length || geos.some((g) => !g)) return fail(404, 'unknown_geography')
    return { ok: true, asset: p.asset || 'all', series: geos.map((g) => ({ id: g.id, label: g.label, months: trendSeries(g.id, p.asset || 'all') })), coverage: current.coverage.months.map(({ label, status }) => ({ label, status })) }
  }

  function resolveWithin(p, level) {
    const within = p.within ? current.catalog.get(String(p.within)) : current.catalog.get('nation:US')
    if (!within) return { error: fail(404, 'unknown_geography') }
    if (LEVEL_ORDER.indexOf(level) <= LEVEL_ORDER.indexOf(within.level)) return { error: fail(400, 'level_not_below_parent', { message: `${LEVEL_LABEL[level]} is not inside a ${LEVEL_LABEL[within.level].toLowerCase()}` }) }
    return { within }
  }

  function rowOut(r, metricIds) {
    return { id: r.id, level: r.level, label: r.label, state: r.state, rank: r.rank ?? null, centroid: r.centroid, values: Object.fromEntries(metricIds.map((m) => [m, r.values[m]])) }
  }

  const DEFAULT_COLUMNS = ['sales_count', 'median_sale_price', 'median_ppsf', 'investor_purchase_count', 'investor_purchase_share', 'cash_purchase_share', 'entity_owned_count', 'sales_growth', 'median_price_per_unit', 'company_buyer_count', 'sms_eligible_count', 'property_count']

  function rank(p) {
    const level = LEVEL_ORDER.includes(p.level) ? p.level : 'zip'
    const metric = METRIC_BY_ID[p.metric] ? p.metric : 'sales_count'
    const def = METRIC_BY_ID[metric]
    const sup = metricSupports(def, { level, asset: p.asset || 'all' })
    if (!sup.ok) return fail(400, 'metric_unsupported', { message: sup.reason })
    if (!def.rankable) return fail(400, 'metric_not_rankable', { message: `${def.label} describes evidence coverage and is not ranked` })
    const r = resolveWithin(p, level)
    if (r.error) return r.error
    const t = childTable(level, r.within.id, p.period || DEFAULT_PERIOD, p.asset || 'all')
    const minSales = Math.max(0, Number(p.min_sales) || 0)
    const rows = t.rows.filter((x) => (x.values.sales_count.value ?? 0) >= minSales).map((x) => ({ ...x }))
    const { ranked, unranked } = rankRows(rows, metric, p.dir === 'asc' ? 'asc' : 'desc')
    const cols = [...new Set([metric, ...DEFAULT_COLUMNS])]
    const limit = Math.min(500, Math.max(1, Number(p.limit) || 200))
    return {
      ok: true, level, within: summaryOf(r.within), metric, dir: p.dir === 'asc' ? 'asc' : 'desc', window: windowPayload(t.ctx), min_sales: minSales,
      total: ranked.length, unranked_count: unranked.length, rows: ranked.slice(0, limit).map((x) => rowOut(x, cols)),
      unranked: unranked.slice(0, 50).map((x) => ({ ...rowOut(x, cols), reason: x.values[metric]?.reason ?? 'unavailable' })),
      universe: t.universe,
    }
  }

  function parseFilters(raw) {
    let list = raw
    if (typeof raw === 'string') { try { list = JSON.parse(raw) } catch { return { error: 'bad_filters' } } }
    if (!Array.isArray(list)) return { filters: [] }
    const out = []
    const rejected = []
    for (const f of list.slice(0, 12)) {
      const def = METRIC_BY_ID[f?.metric]
      const value = Number(f?.value)
      if (!def || !def.screenable) { rejected.push({ metric: f?.metric, reason: 'Not a screenable metric' }); continue }
      if (!['gte', 'lte', 'gt', 'lt', 'eq'].includes(f.op) || !Number.isFinite(value)) { rejected.push({ metric: f.metric, reason: 'Bad operator or value' }); continue }
      out.push({ metric: def.id, op: f.op, value })
    }
    return { filters: out, rejected }
  }

  function screen(p) {
    const level = LEVEL_ORDER.includes(p.level) ? p.level : 'zip'
    const r = resolveWithin(p, level)
    if (r.error) return r.error
    const pf = parseFilters(p.filters)
    if (pf.error) return fail(400, pf.error)
    const unsupported = pf.filters.map((f) => ({ f, s: metricSupports(METRIC_BY_ID[f.metric], { level, asset: p.asset || 'all' }) })).filter((x) => !x.s.ok)
    if (unsupported.length) return fail(400, 'metric_unsupported', { message: unsupported.map((x) => x.s.reason).join('; '), filters: unsupported.map((x) => x.f.metric) })
    const t = childTable(level, r.within.id, p.period || DEFAULT_PERIOD, p.asset || 'all')
    const match = p.match === 'any' ? 'any' : 'all'
    const hits = t.rows.filter((row) => passesFilters(row, pf.filters, match)).map((x) => ({ ...x }))
    const sortBy = METRIC_BY_ID[p.sort] ? p.sort : pf.filters[0]?.metric || 'sales_count'
    const { ranked, unranked } = rankRows(hits, sortBy, p.dir === 'asc' ? 'asc' : 'desc')
    const cols = [...new Set([...pf.filters.map((f) => f.metric), sortBy, ...DEFAULT_COLUMNS])]
    const blocked = pf.filters.some((f) => METRIC_BY_ID[f.metric].group === 'universe') && t.universe.loaded.length < t.universe.states.length
    return {
      ok: true, level, within: summaryOf(r.within), match, filters: pf.filters, rejected: pf.rejected, window: windowPayload(t.ctx), sort: sortBy,
      considered: t.rows.length, total: hits.length, rows: [...ranked, ...unranked].slice(0, 500).map((x) => rowOut(x, cols)),
      universe: t.universe, universe_incomplete: blocked,
    }
  }

  function compare(p) {
    const ids = [...new Set(String(p.ids || '').split(',').map((s) => s.trim()).filter(Boolean))].slice(0, 6)
    if (ids.length < 2) return fail(400, 'compare_needs_two')
    const geos = ids.map(geoOr404)
    if (geos.some((g) => !g)) return fail(404, 'unknown_geography', { ids: ids.filter((id, i) => !geos[i]) })
    const period = p.period || DEFAULT_PERIOD
    const asset = p.asset || 'all'
    const cols = METRICS.filter((m) => m.group !== 'stock' || ['property_count', 'tax_delinquent_share', 'avg_equity_pct'].includes(m.id)).map((m) => m.id)
    const items = geos.map((g) => {
      const v = valuesFor(g.id, period, asset)
      return { id: g.id, level: g.level, label: g.label, state: g.state, values: Object.fromEntries(cols.map((c) => [c, v.values[c]])), window: windowPayload(v.ctx) }
    })
    // Same window, asset, definitions and sample rules for every column (brief §50).
    return { ok: true, window: items[0].window, items, metrics: cols, series: geos.map((g) => ({ id: g.id, label: g.label, months: trendSeries(g.id, asset) })), coverage: current.coverage.months.map(({ label, status }) => ({ label, status })) }
  }

  async function heat(p) {
    const metric = METRIC_BY_ID[p.metric]
    if (!metric || !metric.heatable) return fail(400, 'metric_not_heatable')
    const zoom = Number(p.zoom)
    const bbox = String(p.bbox || '').split(',').map(Number)
    if (bbox.length !== 4 || bbox.some((v) => !Number.isFinite(v)) || !Number.isFinite(zoom)) return fail(400, 'bad_viewport')
    // Zoom-adaptive aggregation over geometry we own (brief §11): states, then ZIPs from z9.
    const level = zoom >= 9 ? 'zip' : 'state'
    const note = level === 'state' && zoom >= 5.5 ? 'County, city and market outlines are not in the database. ZIP outlines appear from zoom 9.' : null
    const sup = metricSupports(metric, { level, asset: p.asset || 'all' })
    if (!sup.ok) return { ok: true, level, metric: metric.id, rows: [], note: sup.reason }
    const outlines = await boundaries({ level, bbox: bbox.join(','), zoom })
    if (!outlines?.available) return { ok: true, level, metric: metric.id, rows: [], note: outlines?.reason === 'too_large' ? 'Zoom in to draw ZIP outlines' : `Outlines unavailable (${outlines?.reason ?? 'unknown'})` }
    const t = childTable(level, 'nation:US', p.period || DEFAULT_PERIOD, p.asset || 'all')
    const byId = new Map(t.rows.map((r) => [r.id, r]))
    const feats = outlines.data?.features || []
    const rows = []
    let missing = 0
    for (const f of feats) {
      const id = `${level}:${f.properties?.key}`
      const r = byId.get(id)
      const v = r?.values?.[metric.id]
      if (!r || v?.status !== 'ok') { missing += 1; continue }
      rows.push({ key: f.properties.key, id, label: r.label, v: v.value, n: v.n, outline: f.geometry, tip: tipFor(r) })
    }
    const sorted = rows.map((r) => r.v).sort((a, b) => a - b)
    const quant = (x) => { let lo = 0; let hi = sorted.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < x) lo = mid + 1; else hi = mid } return sorted.length > 1 ? lo / (sorted.length - 1) : 0.5 }
    for (const r of rows) r.t = Math.max(0, Math.min(1, quant(r.v)))
    return { ok: true, level, metric: metric.id, label: metric.label, unit: metric.unit, window: windowPayload(t.ctx), rows, without_value: missing, note, source: outlines.source }
  }

  function tipFor(r) {
    const v = r.values
    const parts = [r.level === 'zip' ? r.label.split(' · ')[0] : r.label]
    parts.push(`${v.sales_count.value.toLocaleString('en-US')} sales`)
    parts.push(`${v.investor_purchase_count.value.toLocaleString('en-US')} investor purchases`)
    if (v.cash_purchase_share.status === 'ok') parts.push(`${Math.round(v.cash_purchase_share.value * 100)}% cash`)
    if (v.median_sale_price.status === 'ok') parts.push(`$${Math.round(v.median_sale_price.value / 1000)}K median`)
    if (v.median_ppsf.status === 'ok') parts.push(`$${Math.round(v.median_ppsf.value)} PPSF`)
    if (v.sales_growth.status === 'ok') parts.push(`${v.sales_growth.value >= 0 ? '+' : '−'}${Math.abs(Math.round(v.sales_growth.value * 100))}% sales`)
    return parts.join(' · ')
  }

  async function recentSales(p) {
    const g = geoOr404(p.id)
    if (!g) return fail(404, 'unknown_geography')
    const asset = assetFilterCodes(p.asset || 'all')
    const key = `${current.version}|${g.id}|${asset.id}`
    const hit = recentCache.get(key)
    if (hit && hit.expires > clock()) return hit.value
    let where = ''
    let params = []
    if (g.level === 'zip') { where = 'where m.zip = $1'; params = [g.key] }
    else if (g.level === 'city') { where = 'where m.state = $1 and lower(btrim(m.city)) = $2'; params = [g.state, g.key.slice(3)] }
    else if (g.level === 'state') { where = 'where m.state = $1'; params = [g.key] }
    else if (g.level === 'county' || g.level === 'market') {
      const zips = (g.level === 'market' ? current.zipsByMarket.get(g.key) : [...current.catalog.nodes.values()].filter((n) => n.level === 'zip' && n.parents?.county === g.id).map((n) => n.key)) || []
      if (!zips.length) return { ok: true, geography: summaryOf(g), rows: [], note: 'No member ZIPs' }
      where = 'where m.zip = any($1)'; params = [zips]
    }
    const res = await (deps.query || queryWithTimeout)(
      `select m.comp_id, m.sold_on::text, m.price::float8, m.ppsf::float8, m.address, m.city, m.state, m.zip, m.property_type, m.units::float8, m.sqft::float8,
              m.buyer, m.property_id, m.source, m.is_investor, m.is_cash_purchase
         from public.mv_map_market_sales m ${where} order by m.sold_on desc limit 400`, params, 10_000)
    const rows = []
    for (const r of res?.rows || []) {
      const code = classify(r.property_type, r.units)
      if (asset.codes && !asset.codes.has(code)) continue
      const buyer = r.buyer && !lenderClass(r.buyer) ? displayableCompanyName(r.buyer) : null
      rows.push({ comp_id: r.comp_id, sold_on: r.sold_on, price: r.price > 0 ? r.price : null, ppsf: r.price > 0 && r.ppsf > 0 ? r.ppsf : null, address: r.address, city: r.city ? titleCase(r.city) : null, state: r.state, zip: r.zip,
        asset: MI_ASSETS[code], asset_label: assetLabelOf(code), units: r.units, sqft: r.sqft, buyer, property_id: r.property_id, source: r.source, investor: r.is_investor === true, cash: r.is_cash_purchase })
      if (rows.length >= Math.min(50, Number(p.limit) || 25)) break
    }
    const value = { ok: true, geography: summaryOf(g), asset: asset.id, rows, kind: 'market_sales', note: 'Recorded market sales, not valuation comps' }
    recentCache.set(key, { value, expires: clock() + RECENT_TTL_MS })
    while (recentCache.size > 60) recentCache.delete(recentCache.keys().next().value)
    return value
  }

  async function universeLoad(p) {
    const all = current.levelNodes.state.map((n) => n.key)
    const want = String(p.states || '') === 'all' ? all : String(p.states || '').split(',').map((s) => s.trim().toUpperCase()).filter((s) => all.includes(s))
    if (!want.length) return fail(400, 'no_states')
    for (const st of want) void universe.load(st).catch(() => null)
    return { ok: true, requested: want, status: Object.fromEntries(want.map((s) => [s, universe.status(s)])), loaded: universe.loaded() }
  }

  return { run, _state: () => ({ state, current, universe }), _kick: kick }
}

let shared = null
export function marketIntelService() {
  if (!shared) shared = createMarketIntelService()
  return shared
}
export { parseGeoId, dayOfDate, unavailable }
