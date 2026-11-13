// ─── ZIP MODEL BUILDER JOB (8.5.20-b) — OFF BY DEFAULT, BOUNDED, INCREMENTAL ──
// run({ markets }) rebuilds the ZIP acquisition-economics cells of at most
// max_markets markets per call, and ONLY markets whose source generation changed
// (generation = max(sold_on) + row count of the market's recorded sales). Each market
// is read in one bounded query (max_rows); a market above the bound is skipped and
// reported (never truncated into a biased model). Watermarks live in the store
// (public.zip_model_build_state in the PROPOSED schema).
//
// Gate: ZIP_INTEL_BUILDER_ENABLED=1 — absent ⇒ every call returns skipped (nothing read).
// Reads only recorded sales + geography; writes only its own tables through the store.
import { buildZipCells, ZIP_MODEL_VERSION } from './zip-model.js'

export const ZIP_BUILDER_FLAG = 'ZIP_INTEL_BUILDER_ENABLED'
export const ZIP_BUILDER_LIMITS = Object.freeze({ max_markets: 3, max_rows: 150_000, window_months: 12 })

export function zipBuilderEnabled(env = process.env) {
  return String(env?.[ZIP_BUILDER_FLAG] ?? '').trim() === '1'
}

/** The SQL source (read-only runner: local PG, or the read-only proof over the pooler). */
export function createZipSqlSource({ query }) {
  return Object.freeze({
    kind: 'sql',
    async zipsForMarket(market) {
      return (await query('select zip5 from public.market_zip_membership where canonical_market_id = $1 order by zip5 limit 2000', [market])).map((r) => String(r.zip5))
    },
    async geoForZips(zips) {
      const rows = await query(`select distinct on (zip) zip, county_key, state, market_key from public.mi_zip_geo where zip = any($1::text[]) order by zip, build_id desc`, [zips])
      return Object.fromEntries(rows.map((r) => [String(r.zip), { county: r.county_key ? `${r.state}:${r.county_key}` : null, state: r.state || null }]))
    },
    async generation(zips) {
      const r = await query('select max(sold_on)::text g, count(*)::int n from public.mv_map_market_sales where zip = any($1::text[])', [zips])
      return r[0]?.g ? `${r[0].g}#${r[0].n}` : null
    },
    async sales(zips, { since, limit }) {
      return query(`select s.zip, s.property_type, s.units, s.price, s.sold_on, s.estimated_value, s.is_investor, s.buyer_kind, s.is_cash_purchase, s.is_arms_length, s.is_priced, s.buyer_archetype,
                           p.building_condition as condition,
                           case when p.estimated_repair_cost > 0 and p.estimated_value > 0 then p.estimated_repair_cost / p.estimated_value end as repair_to_value
                      from public.mv_map_market_sales s
                      left join public.properties p on p.property_id = s.property_id
                     where s.zip = any($1::text[]) and s.sold_on >= $2::date
                     limit $3`, [zips, since, limit])
    },
  })
}

/** In-memory store (tests, the read-only proof). */
export function createZipMemoryStore() {
  const cells = new Map()
  const wm = new Map()
  return Object.freeze({
    kind: 'memory',
    cells,
    async getWatermark(market) { return wm.get(market) || null },
    async setWatermark(market, w) { wm.set(market, { ...w }) },
    async replaceMarketCells(market, rows) {
      for (const [k, v] of cells) if (v.build_scope === `market:${market}`) cells.delete(k)
      for (const r of rows) cells.set(`${r.model_version}|${r.zip5}|${r.property_type}|${r.condition_band}|${r.value_band}`, r)
      return rows.length
    },
  })
}

/** PostgREST store for the PROPOSED tables (service role; never the agent read client). */
export function createZipSupabaseStore({ supabase }) {
  const must = (r, what) => { if (r?.error) throw Object.assign(new Error(`${what} failed`), { code: 'ZIP_STORE_FAILED' }); return r.data }
  return Object.freeze({
    kind: 'postgrest',
    async getWatermark(market) { return must(await supabase.from('zip_model_build_state').select('*').eq('market', market).maybeSingle(), 'watermark read') },
    async setWatermark(market, w) { must(await supabase.from('zip_model_build_state').upsert({ market, ...w }, { onConflict: 'market' }), 'watermark write') },
    async replaceMarketCells(market, rows) {
      must(await supabase.from('zip_acquisition_economics').delete().eq('build_scope', `market:${market}`).eq('model_version', ZIP_MODEL_VERSION), 'cells delete')
      for (let i = 0; i < rows.length; i += 500) must(await supabase.from('zip_acquisition_economics').insert(rows.slice(i, i + 500)), 'cells insert')
      return rows.length
    },
  })
}

/**
 * @param {{ source: object, store: object, env?: object, now?: () => number, limits?: object }} deps
 */
export function createZipModelBuilder({ source, store, env = process.env, now = () => Date.now(), limits = {} }) {
  const L = { ...ZIP_BUILDER_LIMITS, ...limits }
  return Object.freeze({
    async run({ markets = [], force = false } = {}) {
      if (!zipBuilderEnabled(env)) return { ok: true, skipped: 'ZIP_INTEL_BUILDER_DISABLED', markets: [] }
      const out = []
      for (const market of markets.slice(0, L.max_markets)) {
        const zips = await source.zipsForMarket(market)
        if (!zips.length) { out.push({ market, status: 'no_zips' }); continue }
        const generation = await source.generation(zips)
        const prev = await store.getWatermark(market)
        if (!force && prev && prev.generation === generation && prev.model_version === ZIP_MODEL_VERSION) { out.push({ market, status: 'unchanged', generation }); continue }
        const nowMs = now()
        const since = new Date(nowMs - L.window_months * 30.44 * 864e5).toISOString().slice(0, 10)
        const rows = await source.sales(zips, { since, limit: L.max_rows + 1 })
        if (rows.length > L.max_rows) { out.push({ market, status: 'too_large_for_one_bounded_read', rows_seen: rows.length }); continue }
        const geo = await source.geoForZips(zips)
        for (const z of zips) geo[z] = { ...(geo[z] || {}), metro: market }
        const built = buildZipCells(rows, geo, { now: nowMs, scope: `market:${market}` })
        const written = await store.replaceMarketCells(market, built.cells)
        await store.setWatermark(market, { generation, model_version: ZIP_MODEL_VERSION, built_at: built.built_at, rows: rows.length, cells: written })
        out.push({ market, status: 'built', generation, rows: rows.length, observations: built.observations, cells: written })
      }
      return { ok: true, markets: out }
    },
  })
}
