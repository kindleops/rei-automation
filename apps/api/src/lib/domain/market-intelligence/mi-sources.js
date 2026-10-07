/**
 * MARKET INTELLIGENCE: where the numbers come from. Two sources, ONE interface,
 * so every op in mi-service.js is source-agnostic:
 *
 *   summary  (production)  the latest READY build of the market summary
 *                          (PROPOSED_20261004150000_market_intel_geo_rollup.sql). Reads are
 *                          small and indexed: one (level, period, asset) slice of ≤ ~10K rows,
 *                          one month-sum query per slice, ≤ 60 month rows per geography, and
 *                          the ~12.7K named-buyer rows once per build. Cached per build.
 *   raw      (DEV ONLY)    the old full stream of mv_map_market_sales into memory. Never
 *                          started in production (see mi-service.js devRawAllowed()).
 *
 *   source.meta                 { mode, build, asOfDay, firstDay, rows, coverage, catalog, assetsWithSales, … }
 *   source.levelAggs(level, ctx)  Map(geoId → agg)   every geography of a level (national)
 *   source.geoAgg(geoId, ctx)     agg for one geography
 *   source.geoMonths(geoId, asset) Map(month → point) for trends
 *   source.buyerName(key)         display name for a buyer key in agg.buyers
 * agg is the shape in mi-agg.js; ctx = { periodId, window, coverage, windows, asset: { id, codes } }.
 */
import { aggFromSummaryRow, addBuyer, emptyAgg, finalizeAcc, medianOf } from './mi-agg.js'
import { createAssetClassifier, ASSET_CODE, assetFilterCodes } from './mi-asset-classes.js'
import { buildGeographyCatalog, factsFromIndex, factsFromSummary, parseGeoId, rawAccessors } from './mi-geography.js'
import { dateOfDay, dayOfDate, deriveCoverage, firstDayOfMonth, monthOfDay } from './mi-periods.js'
import { aggregate, aggregateBy, monthlySeries, nationalMonthCounts, rowsOf, F } from './mi-sales-index.js'
import { windowSumsFromMonths } from './mi-metric-values.js'
import { displayableCompanyName } from '@/lib/domain/entity-graph/buyer-name-privacy.js'
import { lenderClass } from '@/lib/domain/buyer-match/buyer-identity-rules.js'
import { loadInferred, inferredAggFromRow, topStacks } from './mi-inferred-source.js'

const SLICE_CACHE_MAX = 160
const isoMonth = (m) => dateOfDay(firstDayOfMonth(m))
const num = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null)
const lru = (map, max) => { while (map.size > max) map.delete(map.keys().next().value) }

/** Shared reference inputs → aux for the catalog (both sources). */
export function auxFromReference(ref) {
  return {
    searchAreas: ref.searchAreas, markets: ref.markets, aliases: ref.aliases,
    outlined: { zip: new Set(ref.outlined.filter((r) => r.geo_level === 'zip5').map((r) => r.k)), state: new Set(ref.outlined.filter((r) => r.geo_level === 'state').map((r) => r.k)) },
  }
}

// ── summary ────────────────────────────────────────────────────────────────

/** Named-buyer policy, decided once per name with the JS rules (privacy + lender). */
function buyerPolicy() {
  const memo = new Map()
  return (name) => {
    let p = memo.get(name)
    if (!p) { const lender = Boolean(lenderClass(name)); p = { lender, listable: !lender && Boolean(displayableCompanyName(name)) }; memo.set(name, p) }
    return p
  }
}

export async function createSummarySource({ loader, build, ref, classify = createAssetClassifier() }) {
  const id = build.build_id
  const [zipGeo, cityRows, stateRows, nationMonths, assetRows, buyerRows] = [
    await loader.summary('zipGeo', [id]),
    await loader.summary('slice', [id, 'city', 'all', 'all']),
    await loader.summary('slice', [id, 'state', 'all', 'all']),
    await loader.summary('geoMonths', [id, 'nation', 'US', 'all']),
    await loader.summary('assets', [id]),
    await loader.summary('buyers', [id], 20_000),
  ]
  // The inferred-investor extension is optional: any failure leaves it unavailable, never the core.
  const inferred = await loadInferred({ loader, build }).catch((e) => ({ available: false, reason: 'error', error: String(e?.message || e), meta: null }))
  const facts = factsFromSummary(zipGeo, cityRows, stateRows, build.source_rows)
  const catalog = buildGeographyCatalog(facts, {
    ...auxFromReference(ref),
    zipCounty: zipGeo.filter((r) => r.county_key).map((r) => ({ zip: r.zip, key: r.county_key, name: r.county_name, via: r.county_via })),
    zipMarket: zipGeo.filter((r) => r.market_key).map((r) => ({ zip5: r.zip, canonical_market_id: r.market_key })),
  })
  const asOfDay = dayOfDate(build.source_as_of)
  const firstDay = build.source_first ? dayOfDate(build.source_first) : null
  const coverage = deriveCoverage(new Map(nationMonths.map((r) => [monthOfDay(dayOfDate(r.month)), Number(r.sales) || 0])), asOfDay)

  // Named-buyer rows, classified with the JS asset classifier and the JS identity rules.
  const policy = buyerPolicy()
  const buyers = buyerRows.map((r) => {
    const p = policy(r.buyer)
    return { day: Number(r.d), month: monthOfDay(Number(r.d)), zip: r.zip, state: r.state, cityKey: r.city_key, asset: classify(r.property_type, num(r.units)),
      price: num(r.price), qualified: r.qualified === true, investor: r.is_investor === true, name: r.buyer, lender: p.lender, listable: p.listable }
  })
  const geoOfBuyer = {
    nation: () => 'nation:US',
    state: (b) => `state:${b.state}`,
    city: (b) => (b.cityKey ? `city:${b.cityKey}` : null),
    zip: (b) => (b.zip ? `zip:${b.zip}` : null),
    county: (b) => { const k = b.zip ? catalog.zipCounty.get(b.zip) : null; return k ? `county:${k}` : null },
    market: (b) => { const k = b.zip ? catalog.zipMarket.get(b.zip) : null; return k ? `market:${k}` : null },
  }
  function buyerStatsBy(level, ctx, only = null) {
    const out = new Map()
    for (const b of buyers) {
      if (b.day < ctx.window.from || b.day > ctx.window.to) continue
      if (ctx.asset.codes && !ctx.asset.codes.has(b.asset)) continue
      const g = geoOfBuyer[level](b)
      if (!g || (only && g !== only)) continue
      let s = out.get(g)
      if (!s) { s = { buyers: new Map(), namedPurchases: 0, lenderPurchases: 0 }; out.set(g, s) }
      if (b.lender) s.lenderPurchases += 1
      else if (b.listable) { s.namedPurchases += 1; addBuyer(s.buyers, b.name, { day: b.day, price: b.price ?? 0, qualified: b.qualified, assetCode: b.asset }) }
    }
    return out
  }

  const slices = new Map()
  const sliceRows = (level, period, asset) => {
    const k = `${level}|${period}|${asset}`
    if (!slices.has(k)) { slices.set(k, loader.summary('slice', [id, level, period, asset]).then((rows) => new Map(rows.map((r) => [r.geo_key, r])))); lru(slices, SLICE_CACHE_MAX) }
    return slices.get(k)
  }
  const sums = new Map()
  const monthSums = (level, asset, pw) => {
    const range = (w) => (w ? [isoMonth(w.from), isoMonth(w.to)] : ['1900-01-01', '1899-12-01'])
    const params = [id, level, asset, ...range(pw.rate), ...range(pw.cur), ...range(pw.prior)]
    const k = params.join('|')
    if (!sums.has(k)) { sums.set(k, loader.summary('monthSums', params).then((rows) => new Map(rows.map((r) => [r.geo_key, r])))); lru(sums, SLICE_CACHE_MAX) }
    return sums.get(k)
  }
  const keyOf = (geoId) => geoId.slice(geoId.indexOf(':') + 1)

  async function levelAggs(level, ctx) {
    const inf = inferred?.available ? inferred : null
    const [rows, ms, irows] = await Promise.all([sliceRows(level, ctx.periodId, ctx.asset.id), monthSums(level, ctx.asset.id, ctx.windows),
      inf ? inf.slice(level, ctx.periodId, ctx.asset.id).catch(() => null) : null])
    const bs = buyerStatsBy(level, ctx)
    const out = new Map()
    for (const [key, r] of rows) {
      const gid = level === 'nation' ? 'nation:US' : `${level}:${key}`
      const m = ms.get(key)
      out.set(gid, { ...aggFromSummaryRow(r, bs.get(gid)), rateSum: m?.rate_sum ?? 0, curSum: m?.cur_sum ?? 0, priorSum: m?.prior_sum ?? 0,
        inferred: irows ? inferredAggFromRow(irows.get(key), inf.meta) : null })
    }
    return out
  }
  async function geoAgg(geoId, ctx) {
    const level = parseGeoId(geoId)?.level
    if (!level) return emptyAgg()
    const all = await levelAggs(level, ctx)
    return all.get(geoId) || { ...emptyAgg(buyerStatsBy(level, ctx, geoId).get(geoId)), rateSum: 0, curSum: 0, priorSum: 0,
      inferred: inferred?.available ? inferredAggFromRow(undefined, inferred.meta) : null }
  }
  async function geoMonths(geoId, assetId, codes) {
    const g = parseGeoId(geoId)
    if (!g) return new Map()
    const rows = await loader.summary('geoMonths', [id, g.level, g.level === 'nation' ? 'US' : keyOf(geoId), assetId])
    const out = new Map(rows.map((r) => [monthOfDay(dayOfDate(r.month)), {
      sales: Number(r.sales) || 0, investor: Number(r.investor) || 0, buyerKnown: Number(r.buyer_known) || 0, cash: Number(r.cash) || 0, cashKnown: Number(r.cash_known) || 0,
      companyAcq: 0, priceMed: num(r.median_price), priceN: Number(r.price_n) || 0, ppsfMed: num(r.median_ppsf), ppsfN: Number(r.ppsf_n) || 0,
    }]))
    for (const b of buyers) {
      if (!b.listable || (codes && !codes.has(b.asset))) continue
      if (geoOfBuyer[g.level](b) !== geoId) continue
      const p = out.get(b.month)
      if (p) p.companyAcq += 1
    }
    return out
  }
  /** Monthly sales + recorded investor purchases for many geographies of ONE level: one indexed read. */
  async function geoMonthsMany(level, geoIds, assetId) {
    const keys = geoIds.map(keyOf)
    const out = new Map(geoIds.map((g) => [g, new Map()]))
    if (!keys.length) return out
    const rows = await loader.summary('geoMonthsMany', [id, level, assetId, keys])
    for (const r of rows) {
      const gid = level === 'nation' ? 'nation:US' : `${level}:${r.geo_key}`
      out.get(gid)?.set(monthOfDay(dayOfDate(r.month)), { sales: Number(r.sales) || 0, investor: Number(r.investor) || 0 })
    }
    return out
  }
  return {
    meta: {
      mode: 'summary', version: `summary:${id}`, build, asOfDay, firstDay, rows: Number(build.source_rows) || 0, coverage, catalog,
      assetsWithSales: new Set(assetRows.filter((r) => Number(r.sale_count) > 0).map((r) => r.asset)),
      reads: { zip_geo: zipGeo.length, buyers: buyers.length, stack_activity: inferred?.activity?.length ?? 0 },
      inferred: inferred ? { available: inferred.available, reason: inferred.available ? null : inferred.reason, errors: inferred.errors ?? null, meta: inferred.meta } : { available: false, reason: 'not_supported', meta: null },
    },
    levelAggs, geoAgg, geoMonths, geoMonthsMany, buyerName: (k) => k,
    /** Top owner-portfolio stacks for a geography and window (companies named only), or null. */
    inferredStacks(geoId, ctx, limit) {
      const level = parseGeoId(geoId)?.level
      return level ? topStacks(inferred, geoId, ctx, geoOfBuyer[level], limit) : null
    },
  }
}

// ── raw (DEV ONLY) ─────────────────────────────────────────────────────────

export function createRawSource({ index, ref, parcelZipCounty, zipMarket, timings }) {
  const censusZipCounty = ref.census.filter((c) => c.geo_level === 'zip5' && c.county_geo_id)
    .map((c) => ({ zip: c.geo_id.slice(5), state: c.state_code, county_key: c.county_geo_id.replace(/^county:/, ''), county_name: c.county_name }))
  const catalog = buildGeographyCatalog(factsFromIndex(index), { ...auxFromReference(ref), zipMarket, censusZipCounty, parcelZipCounty })
  const acc = rawAccessors(index, catalog)
  const coverage = deriveCoverage(nationalMonthCounts(index), index.maxDay)
  const present = new Set(index.cols.asset)
  const cache = new Map()
  const winOf = (ctx) => ({ from: ctx.window.from, to: ctx.window.to, codes: ctx.asset.codes })
  function levelAggs(level, ctx) {
    const k = `${level}|${ctx.periodId}|${ctx.asset.id}`
    if (!cache.has(k)) {
      const child = acc.child[level]
      const accs = aggregateBy(index, { all: true, n: index.n }, winOf(ctx), child.of)
      cache.set(k, new Map([...accs].map(([key, a]) => [child.id(key), finalizeAcc(a)])))
      lru(cache, 60)
    }
    return Promise.resolve(cache.get(k))
  }
  function geoAgg(geoId, ctx) {
    return Promise.resolve(finalizeAcc(aggregate(index, rowsOf(index, acc.selectorFor(geoId)), winOf(ctx))))
  }
  function geoMonths(geoId, assetId, codes) {
    const m = monthlySeries(index, rowsOf(index, acc.selectorFor(geoId)), codes)
    return Promise.resolve(new Map([...m].map(([mo, s]) => [mo, {
      sales: s.sales, investor: s.investor, buyerKnown: s.buyerKnown, cash: s.cash, cashKnown: s.cashKnown, companyAcq: s.entityAcq,
      priceN: s.prices.length, priceMed: medianOf(s.prices), ppsfN: s.ppsf.length, ppsfMed: medianOf(s.ppsf),
    }])))
  }
  const assetsWithSales = new Set(['all', 'sfr', 'mf_2_4', 'mf_5_plus', 'mf', 'land', 'commercial'].filter((f) => {
    const members = { all: null, sfr: ['sfr'], mf_2_4: ['mf_2_4'], mf_5_plus: ['mf_5_plus'], mf: ['mf_2_4', 'mf_5_plus', 'mf_unknown'], land: ['land'], commercial: ['commercial'] }[f]
    return !members || members.some((m) => present.has(ASSET_CODE[m]))
  }))
  return {
    meta: { mode: 'raw_dev', version: `raw:${index.maxDay}|${index.n}`, build: null, asOfDay: index.maxDay, firstDay: index.minDay, rows: index.n, coverage, catalog, assetsWithSales, timings, rawTypes: index.rawTypes,
      inferred: { available: false, reason: 'dev_raw', meta: null } },
    inferredStacks: () => null,
    levelAggs, geoAgg, geoMonths, buyerName: (b) => index.dicts.buyers[b],
    async geoMonthsMany(level, geoIds, assetId) {
      const a = assetFilterCodes(assetId || 'all'); const codes = a.ok ? a.codes : null
      return new Map(await Promise.all(geoIds.map(async (g) => [g, await geoMonths(g, assetId, codes)])))
    },
    _index: index, F, windowSums: windowSumsFromMonths,
  }
}
