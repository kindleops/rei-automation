/**
 * MARKET INTELLIGENCE SERVICE: "Where should we be hunting, what is happening
 * there, and why?" (brief §1). Read-only. Never throws to the route.
 *
 * READ PATH (owner decision 2026-10-04): raw sales are the source of truth; the
 * MARKET SUMMARY (mi_geo_period_rollup & co., built off-hours by mi_rollup_tick)
 * is the analytical projection Market Intelligence reads. See mi-sources.js.
 *
 *   summary ready            → every op reads small, indexed, cached summary slices.
 *   summary missing/not built → { status: 'summary_missing', message: 'Market summary not built yet' }.
 *                              Nothing streams. Re-checked at most once a minute.
 *   dev only                 → the old full in-memory stream of mv_map_market_sales, ONLY when
 *                              MI_DEV_RAW_FALLBACK=1 and NODE_ENV !== 'production'
 *                              (devRawAllowed). Never in production, whatever the env says.
 * The schema guard lists catalog columns and never selects a possibly-missing column, so a
 * phantom column cannot break it.
 *
 * Ops: status · registry · search · geography · dossier · rank · screen · compare · trends ·
 * heat · recent_sales · universe_load · sale_owner
 *
 * INFERRED INVESTOR (owner-based; mi-inferred-investor.js): a SEPARATE metric family, present only
 * when the ready build carries the inferred extension (status.inferred_investor.available).
 * sale_owner (the shared sale-buyer resolver, mi-sale-owner.js) needs no summary at all.
 */
import { createMarketIntelLoader } from './mi-loader.js'
import { createSalesIndexBuilder } from './mi-sales-index.js'
import { createRawSource, createSummarySource } from './mi-sources.js'
import { searchGeographies, summaryOf, LEVEL_ORDER, LEVEL_LABEL, titleCase } from './mi-geography.js'
import { METRICS, METRIC_BY_ID, registryPayload, metricSupports } from './mi-metric-registry.js'
import { DEFAULT_PERIOD, PERIODS, dateOfDay, periodWindow, monthLabel } from './mi-periods.js'
import { ASSET_FILTERS, ASSET_LABEL, MI_ASSETS, assetFilterCodes, createAssetClassifier } from './mi-asset-classes.js'
import { NOT_RECORDED, SQFT_LABELS, UNIT_LABELS } from './mi-agg.js'
import { salesValues, periodWindows, universeValues, stockValues, censusValues, topBuyers, rankRows, passesFilters, unavailable } from './mi-metric-values.js'
import { createUniverseStore, summarizeUniverse, universeMatches } from './mi-universe.js'
import { readMapBoundaries } from '@/lib/domain/map/map-boundaries-service.js'
import { displayableCompanyName } from '@/lib/domain/entity-graph/buyer-name-privacy.js'
import { lenderClass } from '@/lib/domain/buyer-match/buyer-identity-rules.js'
import { queryWithTimeout } from '@/lib/postgres/client.js'
import { createSaleOwnerReader, saleOwnerIds, salePropertyKeys, SALE_OWNER_MAX_IDS } from './mi-sale-owner.js'
import { LINK_RULE, TIER_RULE, TIER_LABEL, TIERS } from './mi-inferred-investor.js'

const SUMMARY_PROBE_MS = 5 * 60_000
const MISSING_RETRY_MS = 60_000
const BUSY_RETRY_MS = 60_000
const CACHE_MAX = 240
const RECENT_TTL_MS = 30 * 60_000
const assetLabelOf = (code) => ASSET_LABEL[MI_ASSETS[code]] || 'Unknown'
export const SUMMARY_MISSING_MESSAGE = 'Market summary not built yet'
export const INFERRED_UNAVAILABLE_REASON = 'Inferred investor (owner-based) is not available for this market summary build'

/** The dev-only raw stream is allowed only by an explicit flag, and never in production. */
export function devRawAllowed(env = process.env) {
  return env.MI_DEV_RAW_FALLBACK === '1' && env.NODE_ENV !== 'production'
}

export function createMarketIntelService(deps = {}) {
  const loader = deps.loader || createMarketIntelLoader(deps)
  const clock = deps.clock || (() => Date.now())
  const boundaries = deps.readBoundaries || readMapBoundaries
  const env = deps.env || process.env
  const classify = createAssetClassifier()
  const universe = createUniverseStore({ loader, clock, classify })
  const readSaleOwners = deps.readSaleOwners || createSaleOwnerReader(deps)
  let state = { status: 'cold', progress: null, error: null, retryAt: 0, summary: null }
  let current = null
  let building = null
  let lastProbe = 0
  const cache = new Map()
  const recentCache = new Map()

  // ── lifecycle ──────────────────────────────────────────────────────────
  async function loadReference(withParcels) {
    const ref = {}
    for (const name of ['searchAreas', 'markets', 'aliases', 'census', 'outlined', 'areaStats', 'graphCoverage', 'zipMarket']) ref[name] = await loader.aux(name)
    if (withParcels) ref.parcelZipCounty = await loader.aux('parcelZipCounty')
    return ref
  }

  function install(source, ref) {
    const census = new Map(ref.census.map((c) => [c.geo_id, c]))
    current = {
      source, ref, census, catalog: source.meta.catalog,
      areaStats: new Map(ref.areaStats.map((r) => [`${r.kind}|${r.key}`, r])),
      propertyN: new Map(ref.searchAreas.map((a) => [`${a.kind}|${a.key}`, Number(a.n) || 0])),
      marketName: new Map(ref.markets.map((m) => [m.id, m.display_name])),
      marketSlugByName: new Map(ref.markets.map((m) => [m.display_name, m.id])),
      graphCoverage: ref.graphCoverage[0] || null, loadedAt: clock(),
    }
    cache.clear()
    recentCache.clear()
    lastProbe = clock()
    state = { status: 'ready', progress: null, error: null, retryAt: 0, summary: null }
    if (deps.prewarm !== false) setTimeout(() => { for (const lv of ['state', 'market']) void childTable(lv, 'nation:US', DEFAULT_PERIOD, 'all').catch(() => null) }, 0)
  }

  async function initSummary() {
    const missing = await loader.summarySchema()
    if (missing.length) return { ok: false, reason: 'not_installed', missing }
    const [build] = await loader.summary('ready')
    if (!build) {
      const [prog] = await loader.summary('building')
      return { ok: false, reason: prog ? 'building' : 'never_built', building: prog || null }
    }
    const ref = await loadReference(false)
    const source = await createSummarySource({ loader, build, ref, classify })
    install(source, ref)
    return { ok: true }
  }

  async function initRawDev() {
    const t0 = clock()
    const g = await loader.guard()
    if (!g.ok) { state = { ...state, status: 'deferred', error: g.reason, retryAt: clock() + BUSY_RETRY_MS }; return }
    const fresh = await loader.freshness()
    state = { ...state, status: 'loading', progress: { rows: 0, est: fresh.est_rows, phase: 'sales' }, error: null }
    const b = createSalesIndexBuilder({ classify })
    const tSales = clock()
    await loader.streamSales((rows) => b.ingest(rows), (rows) => { state = { ...state, progress: { rows, est: fresh.est_rows, phase: 'sales' } } })
    const index = b.finish()
    const salesMs = clock() - tSales
    const ref = await loadReference(true)
    const source = createRawSource({ index, ref, parcelZipCounty: ref.parcelZipCounty, zipMarket: ref.zipMarket, timings: { sales_ms: salesMs, total_ms: clock() - t0 } })
    install(source, ref)
  }

  async function init() {
    const s = await initSummary()
    if (s.ok) return
    if (devRawAllowed(env)) { await initRawDev(); return }
    state = { status: 'summary_missing', progress: null, error: null, retryAt: clock() + MISSING_RETRY_MS,
      summary: { reason: s.reason, missing_columns: s.missing?.length ?? 0, building: s.building ?? null } }
  }

  function kick() {
    if (building) return building
    if ((state.status === 'deferred' || state.status === 'summary_missing' || state.status === 'error') && clock() < state.retryAt) return null
    building = init().catch((error) => { state = { ...state, status: current ? 'ready' : 'error', error: String(error?.message || error), retryAt: clock() + BUSY_RETRY_MS } })
      .finally(() => { building = null })
    return building
  }

  /** In summary mode, pick up a newer ready build (cheap: one indexed row). */
  async function probe() {
    if (!current || building || clock() - lastProbe < SUMMARY_PROBE_MS) return
    lastProbe = clock()
    try {
      if (current.source.meta.mode !== 'summary') { if ((await loader.summarySchema()).length === 0 && (await loader.summary('ready')).length) kick(); return }
      const [b] = await loader.summary('ready')
      if (b && b.build_id !== current.source.meta.build.build_id) {
        building = initSummary().catch(() => null).finally(() => { building = null })
      }
    } catch { /* keep serving */ }
  }

  async function ready() {
    if (!current) {
      const p = kick()
      if (p) await Promise.race([p, new Promise((r) => setTimeout(r, deps.warmWaitMs ?? 1500))])
    } else void probe()
    return Boolean(current)
  }

  const warming = () => {
    if (state.status === 'summary_missing') {
      const b = state.summary?.building
      return { ok: true, status: 'summary_missing', message: SUMMARY_MISSING_MESSAGE,
        detail: state.summary?.reason === 'not_installed' ? 'The market summary tables are not installed (proposed migration not applied).'
          : b ? `A build is in progress: unit ${b.cursor} of ${b.units}${b.next_unit ? ` (next: ${b.next_unit})` : ''}.` : 'No build has completed yet.',
        summary: state.summary, progress: null, error: null }
    }
    return { ok: true, status: state.status === 'cold' ? 'loading' : state.status, progress: state.progress, error: state.error }
  }

  function statusPayload() {
    const c = current
    const m = c.source.meta
    const b = m.build
    return {
      status: 'ready', mode: m.mode, progress: null, error: null,
      as_of: dateOfDay(m.asOfDay), first_sale: m.firstDay === null ? null : dateOfDay(m.firstDay), rows: m.rows, loaded_at: new Date(c.loadedAt).toISOString(),
      summary: b ? { build_id: b.build_id, built_at: b.ready_at, started_at: b.started_at, source_as_of: b.source_as_of, source_rows: Number(b.source_rows), db_ms: Number(b.db_ms), ticks: b.ticks, rows_written: Number(b.rows_written), unmapped_types: b.notes?.unmapped_types ?? [] } : null,
      timings: m.timings ?? null,
      coverage: { coverage_start: m.coverage.coverage_start_month === null ? null : monthLabel(m.coverage.coverage_start_month), complete_through: m.coverage.complete_through_month === null ? null : monthLabel(m.coverage.complete_through_month), months: m.coverage.months.map(({ label, n, status }) => ({ label, n, status })) },
      membership: c.catalog.membershipCoverage,
      sources: {
        sales: { source: m.mode === 'summary' ? 'mi_geo_period_rollup (market summary of mv_map_market_sales)' : 'mv_map_market_sales (DEV raw stream)', refresh: m.mode === 'summary' ? 'nightly build after refresh_map_market_sales' : 'in memory', as_of: dateOfDay(m.asOfDay), built_at: b?.ready_at ?? null },
        census: { source: 'US Census ACS 5-year', vintage: [...c.census.values()][0]?.vintage ?? null },
        graph: { source: 'campaign_target_graph', measured_at: c.graphCoverage?.measured_at ?? null, phone_type_coverage: c.graphCoverage?.coverage?.phone_type ?? null, loaded_states: universe.loaded() },
        areas: { source: 'mv_map_search_areas / mv_map_property_area_stats', refresh: 'no scheduled refresh (as last built)' },
      },
      asset_filters: ASSET_FILTERS.map((f) => ({ id: f.id, label: f.label, available: m.assetsWithSales.has(f.id) })),
      periods: PERIODS.map((p) => ({ id: p.id, label: p.label })),
      inferred_investor: inferredStatus(),
    }
  }

  // ── inferred investor (owner-based) ─────────────────────────────────────
  function inferredReasonText(inf) {
    if (inf?.available) return null
    switch (inf?.reason) {
      case 'not_installed': return 'Inferred investor (owner-based) is not installed: the proposed summary extension is not applied'
      case 'not_built': return 'This market summary build predates the inferred-investor extension; the next nightly build adds it'
      case 'build_failed': return 'The inferred-investor units failed in this build; recorded investor metrics are unaffected'
      case 'dev_raw': return 'Inferred investor is computed only in the market summary (not in the dev raw stream)'
      default: return 'Inferred investor (owner-based) is unavailable'
    }
  }
  function inferredStatus() {
    const inf = current.source.meta.inferred
    const meta = inf?.meta
    return {
      available: Boolean(inf?.available), reason: inf?.available ? null : inf?.reason ?? 'not_supported', message: inf?.available ? null : inferredReasonText(inf),
      errors: inf?.errors ?? null,
      rules: { link: LINK_RULE, tier: TIER_RULE, tiers: TIERS.map((t) => ({ id: t, label: TIER_LABEL[t], counted: t === 'strong' || t === 'likely' })) },
      national: meta ? { sales: meta.sales, linked: meta.linked, coverage: meta.sales ? meta.linked / meta.sales : null, tiers: meta.tiers, stacks: meta.stacks,
        validation: { ...meta.validation, matrix: meta.matrix, truth: 'recorded investor buyer (is_investor) on owner-linked sales that also record a buyer' } } : null,
    }
  }

  // ── shared computations ────────────────────────────────────────────────
  const universeVersion = () => universe.loaded().map((s) => `${s}:${universe.get(s)?.loadedAt}`).join(',')
  function memo(key, fn) {
    const k = `${current.source.meta.version}|${universeVersion()}|${key}`
    if (cache.has(k)) { const v = cache.get(k); cache.delete(k); cache.set(k, v); return v }
    const v = fn()
    cache.set(k, v)
    if (v && typeof v.catch === 'function') v.catch(() => cache.delete(k))
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
    return v
  }

  function ctxFor(periodId, assetId) {
    const m = current.source.meta
    const p = PERIODS.some((x) => x.id === periodId) ? periodId : DEFAULT_PERIOD
    const asset = assetFilterCodes(assetId || 'all')
    const a = asset.ok ? asset : assetFilterCodes('all')
    const window = periodWindow(p, m.asOfDay, m.firstDay ?? m.asOfDay - 5 * 366)
    // one value-level reason in every mode (the status payload carries the specific cause)
    const ctx = { periodId: p, window, coverage: m.coverage, asset: a, inferredReason: m.inferred?.available ? 'No owner-linked sales in this geography and period' : INFERRED_UNAVAILABLE_REASON }
    ctx.windows = periodWindows(ctx)
    return ctx
  }

  const statesOf = (geo) => (geo.level === 'nation' ? current.catalog.levelNodes.state.map((n) => n.key) : geo.state ? [geo.state] : [])

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
    let pn = geo.level === 'nation' ? current.catalog.levelNodes.state.reduce((t, n) => t + (current.propertyN.get(`state|${n.key}`) || 0), 0) : current.propertyN.get(pnKey)
    if (pn === undefined) pn = null
    if (geo.level === 'nation') {
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
      const zips = current.catalog.marketZips.get(geo.key) || []
      return censusValues(null, { cells: zips.map((z) => current.census.get(`zip5:${z}`)).filter(Boolean), expected: zips.length })
    }
    const states = [...current.census.values()].filter((c) => c.geo_level === 'state')
    return censusValues(null, { cells: states, expected: current.catalog.levelNodes.state.length })
  }

  /** All metric values for one geography (memoised promise). */
  function valuesFor(geoId, periodId, assetId) {
    return memo(`v|${geoId}|${periodId}|${assetId}`, async () => {
      const geo = current.catalog.get(geoId)
      const ctx = ctxFor(periodId, assetId)
      const agg = await current.source.geoAgg(geoId, ctx)
      const u = universeFor(geo, ctx.asset.codes)
      return { agg, ctx, values: { ...salesValues(agg, ctx), ...u.values, ...stockFor(geo), ...censusFor(geo) }, universe: u }
    })
  }

  /**
   * Every child of `parentId` at `level` with every metric: the one table rankings,
   * the screener and heat read. Children are members (a ZIP belongs to its majority
   * city / its county / its market); a child's values are the whole child's.
   */
  function childTable(level, parentId, periodId, assetId) {
    return memo(`t|${level}|${parentId}|${periodId}|${assetId}`, async () => {
      const parent = current.catalog.get(parentId)
      const ctx = ctxFor(periodId, assetId)
      const aggs = await current.source.levelAggs(level, ctx)
      const nodes = current.catalog.childrenOf(level, parentId)
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
      const rows = []
      for (const n of nodes) {
        const agg = aggs.get(n.id)
        const uValues = uLoaded ? universeValues(summarizeUniverse(uGroups.get(n.id) || [], { assetCodes: ctx.asset.codes })) : universeValues(null, 'not_loaded', `Seller universe not loaded for ${sts.length === 1 ? sts[0] : `${sts.filter((s) => !universe.get(s)).length} states`}`)
        const values = { ...(agg ? salesValues(agg, ctx) : salesValues(emptyAggFor(), ctx)), ...uValues, ...stockFor(n), ...censusFor(n) }
        if (!(values.sales_count.value > 0 || (values.seller_record_count?.value ?? 0) > 0 || (values.property_count?.value ?? 0) > 0)) continue
        rows.push({ id: n.id, level: n.level, label: n.label, name: n.name, state: n.state, parents: n.parents, centroid: n.centroid, geometry: n.geometry, values })
      }
      return { rows, ctx, parent, universe: { states: sts, loaded: sts.filter((s) => universe.get(s)) } }
    })
  }
  const emptyAggFor = () => ({ sales: 0, priced: 0, qualified: 0, mls: 0, mfSales: 0, investor: 0, buyerKnown: 0, cashKnown: 0, cash: 0, entity: 0, latestDay: null,
    med: { price: { v: null, n: 0 }, ppsf: { v: null, n: 0 }, ppu: { v: null, n: 0 }, inv: { v: null, n: 0 } }, deciles: null,
    assetMix: new Map(), unitDist: new Map(), sqftDist: new Map(), buyers: new Map(), namedPurchases: 0, lenderPurchases: 0, rateSum: 0, curSum: 0, priorSum: 0 })

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
  const lineage = (geo) => ['nation', 'state', 'market', 'county', 'city'].map((lv) => geo.parents?.[lv]).filter(Boolean).map((id) => current.catalog.get(id)).filter(Boolean).map((n) => ({ id: n.id, level: n.level, label: n.label }))

  async function rankContext(geo, periodId, assetId) {
    const out = []
    const parentIds = ['market', 'county', 'state', 'nation'].map((lv) => geo.parents?.[lv]).filter(Boolean)
      .filter((pid) => current.catalog.childrenOf(geo.level, pid).length >= 3).slice(0, 2)
    for (const pid of parentIds) {
      const t = await childTable(geo.level, pid, periodId, assetId)
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
    s.push({ text: `${geo.label} had ${fmtN(v.sales_count.value)} recorded sales from ${ctx.window.from_date} to ${ctx.window.to_date} (sales data through ${dateOfDay(current.source.meta.asOfDay)}).`, metrics: ['sales_count'] })
    if (v.median_sale_price.status === 'ok') s.push({ text: `Median qualified price ${usd(v.median_sale_price.value)} on ${fmtN(v.median_sale_price.n)} sales${v.median_ppsf.status === 'ok' ? `; $${Math.round(v.median_ppsf.value)} per sq ft` : ''}.`, metrics: ['median_sale_price', 'median_ppsf'] })
    // Shares lead, with their evidence base; counts are never set against total sales.
    const bcov = v.buyer_evidence_coverage.value ?? 0
    if (v.investor_purchase_share.status === 'ok') s.push({ text: `Investor share ${pct(v.investor_purchase_share.value)} of the ${fmtN(v.investor_purchase_share.n)} sales with a recorded buyer (${fmtN(v.investor_purchase_count.value)} investor purchases). Buyer identity is recorded on ${pct(bcov)} of deeds here.`, metrics: ['investor_purchase_share', 'buyer_evidence_coverage', 'investor_purchase_count'] })
    else s.push({ text: `No investor share: only ${fmtN(v.investor_purchase_share.n)} sales here record a buyer (${pct(bcov)} of deeds).`, metrics: ['investor_purchase_share', 'buyer_evidence_coverage'] })
    if (topChild) s.push({ text: `${topChild.label} is #1 of ${fmtN(topChild.of)} ${LEVEL_LABEL[topChild.level]}s by investor purchases (${fmtN(topChild.value)}).`, metrics: ['investor_purchase_count'] })
    if (v.cash_purchase_share.status === 'ok') s.push({ text: `Cash share ${pct(v.cash_purchase_share.value)} of the ${fmtN(v.cash_purchase_share.n)} sales with cash evidence (recorded on ${pct(v.cash_evidence_coverage.value ?? 0)} of deeds).`, metrics: ['cash_purchase_share', 'cash_evidence_coverage'] })
    s.push({ text: `${fmtN(v.entity_owned_count.value)} properties are entity-owned now. That is a current state, not a count of purchases.`, metrics: ['entity_owned_count'] })
    if (v.inferred_investor_share?.status === 'ok') s.push({ text: `${v.inferred_investor_share.label}. Owner-linked on ${pct(v.owner_link_coverage.value ?? 0)} of sales; separate from recorded investor purchases.`, metrics: ['inferred_investor_share', 'owner_link_coverage', 'linked_sale_count'] })
    if (v.sales_growth.status === 'ok') s.push({ text: `Sales ${v.sales_growth.value >= 0 ? 'up' : 'down'} ${Math.abs(Math.round(v.sales_growth.value * 100))}%: ${v.sales_growth.basis}.`, metrics: ['sales_growth'] })
    else s.push({ text: `No sales-change figure: ${v.sales_growth.reason.replace(/^No valid baseline: /, '')}.`, metrics: ['sales_growth'] })
    return s
  }

  // ── ops ────────────────────────────────────────────────────────────────
  const fail = (status, error, extra = {}) => ({ ok: false, status, error, ...extra })
  const geoOr404 = (id) => current.catalog.get(String(id || '')) || null

  async function run(op, p = {}) {
    try {
      if (op === 'registry') return { ok: true, ...registryPayload(), asset_filters: ASSET_FILTERS, periods: PERIODS }
      if (op === 'sale_owner') return await saleOwner(p)
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
        case 'dossier': return await dossier(p)
        case 'rank': return await rank(p)
        case 'screen': return await screen(p)
        case 'compare': return await compare(p)
        case 'trends': return await trends(p)
        case 'heat': return await heat(p)
        case 'recent_sales': return await recentSales(p)
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
    if (g.level !== 'nation' && g.state && !universe.get(g.state) && p.load_universe !== '0') {
      await Promise.race([universe.load(g.state).catch(() => null), new Promise((r) => setTimeout(r, deps.universeWaitMs ?? 8000))])
    }
    const period = p.period || DEFAULT_PERIOD
    const asset = p.asset || 'all'
    const { agg, ctx, values, universe: u } = await valuesFor(g.id, period, asset)
    const childLevel = { nation: 'state', state: 'market', market: 'zip', county: 'zip', city: 'zip', zip: null }[g.level]
    let children = null
    let topChild = null
    if (childLevel) {
      const t = await childTable(childLevel, g.id, period, asset)
      const { ranked } = rankRows(t.rows.map((r) => ({ ...r })), 'investor_purchase_count')
      if (ranked[0] && ranked[0].values.investor_purchase_count.value > 0) topChild = { label: ranked[0].label, level: childLevel, value: ranked[0].values.investor_purchase_count.value, of: ranked.length }
      children = { level: childLevel, count: t.rows.length }
    }
    const series = await trendSeries(g.id, asset)
    return {
      ok: true,
      geography: { ...summaryOf(g), lineage: lineage(g), county_via: g.county_via || null },
      window: windowPayload(ctx),
      values,
      rank_context: await rankContext(g, period, asset),
      children,
      sales: {
        asset_mix: [...agg.assetMix.entries()].map(([code, n]) => ({ asset: MI_ASSETS[code], label: assetLabelOf(code), n })).sort((a, b) => (b.n - a.n) || a.asset.localeCompare(b.asset)),
        source_mix: { mls: agg.mls, public_record: agg.sales - agg.mls },
        price_deciles: agg.deciles,
        latest_sale: agg.latestDay === null ? null : dateOfDay(agg.latestDay),
      },
      investors: { top_buyers: topBuyers(agg, current.source.buyerName, assetLabelOf, 12).map((b) => ({ ...b, last_purchase: dateOfDay(b.last_purchase_day) })), buyer_kinds: { company_named: agg.namedPurchases, lender_or_agency: agg.lenderPurchases }, individuals_named: false },
      inferred_investors: inferredSection(g, agg, ctx, values),
      multifamily: {
        unit_distribution: [...UNIT_LABELS, NOT_RECORDED].map((label) => ({ label, n: agg.unitDist.get(label) || 0 })),
        size_distribution: [...SQFT_LABELS, NOT_RECORDED].map((label) => ({ label, n: agg.sqftDist.get(label) || 0 })),
      },
      universe: { loaded_states: u.loaded, missing_states: u.missing, stock: u.summary?.stock ?? null, types: u.summary ? u.summary.types.map((t) => ({ asset: MI_ASSETS[t.code], label: assetLabelOf(t.code), n: t.n })) : null, corporate_owner_count: u.summary?.corporate_owner_count ?? null, never_contacted_count: u.summary?.never_contacted_count ?? null, property_count: u.summary?.property_count ?? null, phone_type_coverage: u.summary?.phone_type_coverage ?? null, authority: 'Campaign Composer computes the authoritative audience; these are graph flags summarised.' },
      trends: series,
      data_quality: dataQuality(g, agg, u),
      brief: deterministicBrief(g, values, ctx, topChild),
      coverage_months: current.source.meta.coverage.months.map(({ label, status }) => ({ label, status })),
    }
  }

  /** The dossier's inferred-investor block: label, tiers, local + national validation, top stacks. */
  function inferredSection(g, agg, ctx, values) {
    const st = inferredStatus()
    if (!st.available || !agg.inferred) return { available: false, reason: st.reason ?? 'no_rows', message: st.message ?? ctx.inferredReason }
    const inf = agg.inferred
    const stacks = current.source.inferredStacks?.(g.id, ctx, 10) || []
    return {
      available: true,
      label: values.inferred_investor_share.label ?? values.inferred_investor_count.label,
      recorded_label: values.investor_purchase_share.status === 'ok' ? `Recorded investor (deed buyer) · ${Math.round(values.investor_purchase_share.value * 100)}% of ${values.investor_purchase_share.n.toLocaleString('en-US')} sales with a recorded buyer` : `Recorded investor (deed buyer) · ${values.investor_purchase_count.value.toLocaleString('en-US')} purchases; too few recorded buyers for a share`,
      sales: inf.sales, linked: inf.linked, coverage: inf.sales ? inf.linked / inf.sales : null,
      tiers: TIERS.map((t) => ({ id: t, label: TIER_LABEL[t], n: inf.tiers[t], counted: t === 'strong' || t === 'likely' })),
      validation: { national: st.national?.validation ?? null, local: inf.local.n >= 100 ? inf.local : null, local_n: inf.local.n },
      top_stacks: stacks.map((s) => ({ ...s, last_purchase: dateOfDay(s.last_purchase_day) })),
      caveats: [
        'Inferred from the current owner of record, not the deed; never added to recorded investor purchases.',
        'Only the most recent sale of a property, with no later transfer, inherits today\'s owner.',
        'In-state absentee owners cannot be detected (the mailing address is held as a keyed hash); absentee here means an out-of-state tax-mailing address.',
        'A tax-mailing-address stack is not proof of one legal owner: registered agents and management offices group unrelated owners.',
        'Owner names are not on record for most properties; a stack is named only when its own recorded purchases name the same company.',
      ],
      individuals_named: false,
    }
  }

  /** op=sale_owner&ids=t:1,p:2 — the shared sale-buyer resolver (≤ 100 sales). Needs no summary. */
  async function saleOwner(p) {
    const ids = saleOwnerIds(p.ids || p.id)
    const props = salePropertyKeys(p.props).keys
    if (!ids.length && !props.length) return fail(400, 'no_ids', { message: `Pass ids=<comp_id>,… or props=<property_id>@<YYYY-MM-DD>,… (≤ ${SALE_OWNER_MAX_IDS})` })
    const missing = (id) => ({ comp_id: id, buyer_of_record: null, owner_link: null, inferred: null, missing: true })
    const rows = []
    if (ids.length) { const map = await readSaleOwners(ids); for (const id of ids) rows.push(map.get(id) || missing(id)) }
    if (props.length && readSaleOwners.byProperty) { const map = await readSaleOwners.byProperty(props); for (const k of props) rows.push(map.get(k) || missing(k)) }
    return { ok: true, rule: { link: LINK_RULE.id, tier: TIER_RULE.id }, rows }
  }

  function dataQuality(g, agg, u) {
    const share = (a, b) => (b ? a / b : null)
    const m = current.source.meta
    const typed = agg.sales - (agg.assetMix.get(0) || 0)
    return {
      sales_as_of: dateOfDay(m.asOfDay),
      sales_refresh: m.mode === 'summary' ? `Market summary build ${m.build.build_id}, built ${m.build.ready_at}` : 'DEV raw stream of mv_map_market_sales',
      summary_built_at: m.build?.ready_at ?? null,
      index_loaded_at: new Date(current.loadedAt).toISOString(),
      coverage_start: m.coverage.coverage_start_month === null ? null : monthLabel(m.coverage.coverage_start_month),
      complete_through: m.coverage.complete_through_month === null ? null : monthLabel(m.coverage.complete_through_month),
      coordinates: 'Every sale in the source is geocoded (rows without coordinates are excluded upstream)',
      property_type_coverage: share(typed, agg.sales),
      unit_count_coverage_mf: agg.mfSales ? share(agg.mfSales - (agg.unitDist.get(NOT_RECORDED) || 0), agg.mfSales) : null,
      sqft_coverage_priced: share(agg.med.ppsf.n, agg.qualified),
      buyer_coverage: share(agg.buyerKnown, agg.sales),
      cash_coverage: share(agg.cashKnown, agg.sales),
      county_membership: g.level === 'county' || g.county_via ? (g.county_via === 'parcel_majority' ? 'ZIP parcel-majority county (no census cell)' : 'Census ZIP→county') : null,
      census_vintage: [...current.census.values()][0]?.vintage ?? null,
      graph_measured_at: current.graphCoverage?.measured_at ?? null,
      phone_type_coverage: u.summary?.phone_type_coverage ?? current.graphCoverage?.coverage?.phone_type ?? null,
      geometry: g.geometry === 'none' ? `No ${LEVEL_LABEL[g.level].toLowerCase()} polygon in the database; centroid and bounds only` : 'US Census TIGER polygon',
    }
  }

  function trendSeries(id, assetId) {
    return memo(`s|${id}|${assetId}`, async () => {
      const codes = assetFilterCodes(assetId || 'all').codes
      const m = await current.source.geoMonths(id, assetFilterCodes(assetId || 'all').id || 'all', codes)
      return current.source.meta.coverage.months.map(({ month, label, status }) => {
        const s = m.get(month)
        if (!s) return { month: label, status, sales: 0, median_price: null, price_n: 0, median_ppsf: null, investor_purchases: 0, investor_share: null, buyer_known: 0, cash_share: null, cash_known: 0, company_acquisitions: 0 }
        return {
          month: label, status, sales: s.sales,
          median_price: s.priceN >= 5 ? s.priceMed : null, price_n: s.priceN,
          median_ppsf: s.ppsfN >= 5 ? s.ppsfMed : null,
          investor_purchases: s.investor, buyer_known: s.buyerKnown, investor_share: s.buyerKnown >= 10 ? s.investor / s.buyerKnown : null,
          cash_known: s.cashKnown, cash_share: s.cashKnown >= 10 ? s.cash / s.cashKnown : null,
          company_acquisitions: s.companyAcq,
        }
      })
    })
  }

  async function trends(p) {
    const ids = String(p.ids || p.id || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 6)
    const geos = ids.map(geoOr404)
    if (!geos.length || geos.some((g) => !g)) return fail(404, 'unknown_geography')
    const series = []
    for (const g of geos) series.push({ id: g.id, label: g.label, months: await trendSeries(g.id, p.asset || 'all') })
    return { ok: true, asset: p.asset || 'all', series, coverage: current.source.meta.coverage.months.map(({ label, status }) => ({ label, status })) }
  }

  function resolveWithin(p, level) {
    const within = p.within ? current.catalog.get(String(p.within)) : current.catalog.get('nation:US')
    if (!within) return { error: fail(404, 'unknown_geography') }
    if (LEVEL_ORDER.indexOf(level) <= LEVEL_ORDER.indexOf(within.level)) return { error: fail(400, 'level_not_below_parent', { message: `${LEVEL_LABEL[level]} is not inside a ${LEVEL_LABEL[within.level].toLowerCase()}` }) }
    return { within }
  }

  const rowOut = (r, metricIds) => ({ id: r.id, level: r.level, label: r.label, state: r.state, rank: r.rank ?? null, centroid: r.centroid, values: Object.fromEntries(metricIds.map((m) => [m, r.values[m]])) })
  const DEFAULT_COLUMNS = ['sales_count', 'median_sale_price', 'median_ppsf', 'investor_purchase_share', 'buyer_evidence_coverage', 'investor_purchase_count', 'cash_purchase_share', 'cash_evidence_coverage', 'entity_owned_count', 'sales_growth', 'median_price_per_unit', 'company_buyer_count', 'sms_eligible_count', 'property_count', 'inferred_investor_share', 'owner_link_coverage']

  async function rank(p) {
    const level = LEVEL_ORDER.includes(p.level) ? p.level : 'zip'
    const metric = METRIC_BY_ID[p.metric] ? p.metric : 'sales_count'
    const def = METRIC_BY_ID[metric]
    const sup = metricSupports(def, { level, asset: p.asset || 'all' })
    if (!sup.ok) return fail(400, 'metric_unsupported', { message: sup.reason })
    if (!def.rankable) return fail(400, 'metric_not_rankable', { message: `${def.label} describes evidence coverage and is not ranked` })
    const r = resolveWithin(p, level)
    if (r.error) return r.error
    const t = await childTable(level, r.within.id, p.period || DEFAULT_PERIOD, p.asset || 'all')
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
    if (!Array.isArray(list)) return { filters: [], rejected: [] }
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

  async function screen(p) {
    const level = LEVEL_ORDER.includes(p.level) ? p.level : 'zip'
    const r = resolveWithin(p, level)
    if (r.error) return r.error
    const pf = parseFilters(p.filters)
    if (pf.error) return fail(400, pf.error)
    const unsupported = pf.filters.map((f) => ({ f, s: metricSupports(METRIC_BY_ID[f.metric], { level, asset: p.asset || 'all' }) })).filter((x) => !x.s.ok)
    if (unsupported.length) return fail(400, 'metric_unsupported', { message: unsupported.map((x) => x.s.reason).join('; '), filters: unsupported.map((x) => x.f.metric) })
    const t = await childTable(level, r.within.id, p.period || DEFAULT_PERIOD, p.asset || 'all')
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

  async function compare(p) {
    const ids = [...new Set(String(p.ids || '').split(',').map((s) => s.trim()).filter(Boolean))].slice(0, 6)
    if (ids.length < 2) return fail(400, 'compare_needs_two')
    const geos = ids.map(geoOr404)
    if (geos.some((g) => !g)) return fail(404, 'unknown_geography', { ids: ids.filter((id, i) => !geos[i]) })
    const period = p.period || DEFAULT_PERIOD
    const asset = p.asset || 'all'
    const cols = METRICS.filter((m) => m.group !== 'stock' || ['property_count', 'tax_delinquent_share', 'avg_equity_pct'].includes(m.id)).map((m) => m.id)
    const items = []
    const series = []
    for (const g of geos) {
      const v = await valuesFor(g.id, period, asset)
      items.push({ id: g.id, level: g.level, label: g.label, state: g.state, values: Object.fromEntries(cols.map((c) => [c, v.values[c]])), window: windowPayload(v.ctx) })
      series.push({ id: g.id, label: g.label, months: await trendSeries(g.id, asset) })
    }
    return { ok: true, window: items[0].window, items, metrics: cols, series, coverage: current.source.meta.coverage.months.map(({ label, status }) => ({ label, status })) }
  }

  async function heat(p) {
    const metric = METRIC_BY_ID[p.metric]
    if (!metric || !metric.heatable) return fail(400, 'metric_not_heatable')
    const zoom = Number(p.zoom)
    const bbox = String(p.bbox || '').split(',').map(Number)
    if (bbox.length !== 4 || bbox.some((v) => !Number.isFinite(v)) || !Number.isFinite(zoom)) return fail(400, 'bad_viewport')
    const level = zoom >= 9 ? 'zip' : 'state'
    const note = level === 'state' && zoom >= 5.5 ? 'County, city and market outlines are not in the database. ZIP outlines appear from zoom 9.' : null
    const sup = metricSupports(metric, { level, asset: p.asset || 'all' })
    if (!sup.ok) return { ok: true, level, metric: metric.id, rows: [], note: sup.reason }
    const outlines = await boundaries({ level, bbox: bbox.join(','), zoom })
    if (!outlines?.available) return { ok: true, level, metric: metric.id, rows: [], note: outlines?.reason === 'too_large' ? 'Zoom in to draw ZIP outlines' : `Outlines unavailable (${outlines?.reason ?? 'unknown'})` }
    const t = await childTable(level, 'nation:US', p.period || DEFAULT_PERIOD, p.asset || 'all')
    const byId = new Map(t.rows.map((r) => [r.id, r]))
    const rows = []
    let missing = 0
    for (const f of outlines.data?.features || []) {
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

  /** One honest line: shares carry their evidence base; investor counts are never set against total sales. */
  function tipFor(r) {
    const v = r.values
    const parts = [r.level === 'zip' ? r.label.split(' · ')[0] : r.label]
    parts.push(`${v.sales_count.value.toLocaleString('en-US')} sales`)
    if (v.median_sale_price.status === 'ok') parts.push(`$${Math.round(v.median_sale_price.value / 1000)}K median`)
    if (v.median_ppsf.status === 'ok') parts.push(`$${Math.round(v.median_ppsf.value)} PPSF`)
    if (v.investor_purchase_share.status === 'ok') parts.push(`investor share ${Math.round(v.investor_purchase_share.value * 100)}% of ${v.investor_purchase_share.n.toLocaleString('en-US')} with a known buyer`)
    else parts.push(`buyer known on ${v.buyer_evidence_coverage.value === null ? 0 : Math.round(v.buyer_evidence_coverage.value * 100)}% (too few for a share)`)
    if (v.cash_purchase_share.status === 'ok') parts.push(`cash ${Math.round(v.cash_purchase_share.value * 100)}% of ${v.cash_purchase_share.n.toLocaleString('en-US')} with cash evidence`)
    if (v.sales_growth.status === 'ok') parts.push(`${v.sales_growth.value >= 0 ? '+' : '−'}${Math.abs(Math.round(v.sales_growth.value * 100))}% sales`)
    return parts.join(' · ')
  }

  /**
   * Row-level evidence can't be summarised. A bounded read of raw sales: the area's
   * bounding box hits the (lat, lng) covering index; a state reads newest-first by sold_on.
   */
  async function recentSales(p) {
    const g = geoOr404(p.id)
    if (!g) return fail(404, 'unknown_geography')
    const asset = assetFilterCodes(p.asset || 'all')
    const key = `${current.source.meta.version}|${g.id}|${asset.id}`
    const hit = recentCache.get(key)
    if (hit && hit.expires > clock()) return hit.value
    const conds = []
    const params = []
    const add = (sql, v) => { params.push(v); conds.push(sql.replace('?', `$${params.length}`)) }
    const box = g.bbox
    if (box && g.level !== 'state' && g.level !== 'nation' && box[2] - box[0] <= 3 && box[3] - box[1] <= 3) {
      add('m.lat >= ?', box[1]); add('m.lat <= ?', box[3]); add('m.lng >= ?', box[0]); add('m.lng <= ?', box[2])
    }
    if (g.level === 'zip') add('m.zip = ?', g.key)
    else if (g.level === 'city') { add('upper(btrim(m.state)) = ?', g.state); add('lower(btrim(m.city)) = ?', g.key.slice(3)) }
    else if (g.level === 'state') add('upper(btrim(m.state)) = ?', g.key)
    else if (g.level === 'county' || g.level === 'market') {
      const zips = g.level === 'market' ? current.catalog.marketZips.get(g.key) || [] : [...current.catalog.zipCounty].filter(([, k]) => `county:${k}` === g.id).map(([z]) => z)
      if (!zips.length) return { ok: true, geography: summaryOf(g), rows: [], note: 'No member ZIPs' }
      add('m.zip = any(?)', zips)
    } else return { ok: true, geography: summaryOf(g), rows: [], note: 'Pick a state or smaller area for recent sales' }
    const res = await (deps.query || queryWithTimeout)(
      `select m.comp_id, m.sold_on::text, m.price::float8, m.ppsf::float8, m.address, m.city, m.state, m.zip, m.property_type, m.units::float8, m.sqft::float8,
              m.buyer, m.property_id, m.source, m.is_investor, m.is_cash_purchase
         from public.mv_map_market_sales m where ${conds.join(' and ')} order by m.sold_on desc limit 400`, params, 10_000)
    const rows = []
    for (const r of res?.rows || []) {
      const code = classify(r.property_type, r.units)
      if (asset.codes && !asset.codes.has(code)) continue
      const buyer = r.buyer && !lenderClass(r.buyer) ? displayableCompanyName(r.buyer) : null
      rows.push({ comp_id: r.comp_id, sold_on: r.sold_on, price: r.price > 0 ? r.price : null, ppsf: r.price > 0 && r.ppsf > 0 ? r.ppsf : null, address: r.address, city: r.city ? titleCase(r.city) : null, state: r.state, zip: r.zip,
        asset: MI_ASSETS[code], asset_label: assetLabelOf(code), units: r.units, sqft: r.sqft, buyer, property_id: r.property_id, source: r.source, investor: r.is_investor === true, cash: r.is_cash_purchase })
      if (rows.length >= Math.min(50, Number(p.limit) || 25)) break
    }
    // The shared resolver: each sale's buyer of record (recorded buyer, else today's owner when linked).
    let owners = null
    try { owners = await readSaleOwners(rows.map((r) => r.comp_id)) } catch { owners = null }
    for (const r of rows) {
      const o = owners?.get(r.comp_id)
      r.buyer_of_record = o?.buyer_of_record ?? null
      r.owner_link = o?.owner_link ?? null
      r.inferred = o?.inferred ?? null
    }
    const value = { ok: true, geography: summaryOf(g), asset: asset.id, rows, kind: 'market_sales', note: 'Recorded market sales, not valuation comps', buyer_resolver: owners ? 'ok' : 'unavailable' }
    recentCache.set(key, { value, expires: clock() + RECENT_TTL_MS })
    while (recentCache.size > 60) recentCache.delete(recentCache.keys().next().value)
    return value
  }

  function universeLoad(p) {
    const all = current.catalog.levelNodes.state.map((n) => n.key)
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
export { unavailable }
