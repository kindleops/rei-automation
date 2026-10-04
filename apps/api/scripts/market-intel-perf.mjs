// Read-only perf harness: runs the real Market Intelligence service against prod with its own
// read-only pool (BEGIN READ ONLY + SET LOCAL statement_timeout; one connection). Run only in a quiet
// window. Usage (from apps/api): node --import 'data:text/javascript,import { register } from "node:module"; import { pathToFileURL } from "node:url"; register("./tests/alias-loader.mjs", pathToFileURL("./"));' scripts/market-intel-perf.mjs
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const pg = createRequire(import.meta.url)('pg')
const url = readFileSync('/tmp/.dburl', 'utf8').trim()
const pool = new pg.Pool({ connectionString: url, ssl: url.includes('localhost') ? false : { rejectUnauthorized: false }, max: 1 })
pool.on('connect', (c) => { c.query('SET default_transaction_read_only = on').catch(() => {}) })
const query = async (sql, params = [], timeoutMs = 30_000) => {
  const c = await pool.connect()
  try { await c.query('BEGIN READ ONLY'); await c.query(`SET LOCAL statement_timeout = ${Math.trunc(timeoutMs)}`); const r = await c.query(sql, params); await c.query('COMMIT'); return r }
  catch (e) { try { await c.query('ROLLBACK') } catch {} throw e } finally { c.release() }
}
const { createMarketIntelLoader } = await import('../src/lib/domain/market-intelligence/mi-loader.js')
const { createMarketIntelService } = await import('../src/lib/domain/market-intelligence/mi-service.js')
const loader = createMarketIntelLoader({ query, connect: () => pool.connect() })
const noBoundaries = async () => ({ available: false, reason: 'harness' })
// Benchmarks the DEV raw stream explicitly (production reads the market summary and never streams).
const svc = createMarketIntelService({ loader, query, warmWaitMs: 120000, universeWaitMs: 30000, readBoundaries: noBoundaries, env: { MI_DEV_RAW_FALLBACK: '1', NODE_ENV: 'development' } })
const t = async (label, op, p) => { const s = performance.now(); const r = await svc.run(op, p); const ms = performance.now() - s; console.log(`${label.padEnd(46)} ${ms.toFixed(1).padStart(9)} ms  ok=${r.ok} ${r.status && typeof r.status === 'string' ? r.status : ''} ${summ(op, r)}`); return r }
const summ = (op, r) => op === 'rank' || op === 'screen' ? `rows=${r.rows?.length} total=${r.total} first=${r.rows?.[0]?.label}` : op === 'dossier' ? `sales=${r.values?.sales_count?.value} med=${r.values?.median_sale_price?.value} inv=${r.values?.investor_purchase_count?.value} share=${r.values?.investor_purchase_share?.value?.toFixed?.(3)}(${r.values?.investor_purchase_share?.status}) ent=${r.values?.entity_owned_count?.value}` : op === 'search' ? r.results?.slice(0, 4).map((x) => x.id).join(' ') + (r.ambiguous ? ' [ambiguous]' : '') : op === 'compare' ? `items=${r.items?.length}` : op === 'recent_sales' ? `rows=${r.rows?.length}` : op === 'status' ? `rows=${r.rows} as_of=${r.as_of} cov=${r.coverage?.coverage_start}..${r.coverage?.complete_through} timings=${JSON.stringify(r.timings)}` : ''
const g = await query(`select count(*) filter (where state='active' and backend_type='client backend')::int a from pg_stat_activity`)
console.log('active sessions before:', g.rows[0].a)
const m0 = process.memoryUsage().heapUsed
await t('BUILD (status, cold)', 'status', {})
console.log('heapUsed delta MB', ((process.memoryUsage().heapUsed - m0) / 1048576).toFixed(1), 'rss MB', (process.memoryUsage().rss / 1048576).toFixed(0))
const st = await svc.run('status'); console.log('membership', JSON.stringify(st.membership)); console.log('assets', JSON.stringify(st.asset_filters)); console.log('months', st.coverage.months.slice(-15).map((m) => `${m.label}:${m.n}:${m.status}`).join(' '))
for (const q of ['55411', 'Dallas', 'Harris County', 'Minneapolis', 'Texas', 'atlanta ga']) await t(`search "${q}"`, 'search', { q })
const nl = { load_universe: '0' }
await t('dossier ZIP 55411 (cold)', 'dossier', { id: 'zip:55411', ...nl })
await t('dossier ZIP 55411 (warm)', 'dossier', { id: 'zip:55411', ...nl })
await t('dossier city Minneapolis', 'dossier', { id: 'city:MN:minneapolis', ...nl })
await t('dossier county Hennepin', 'dossier', { id: 'county:MN:hennepin', ...nl })
await t('dossier market Minneapolis', 'dossier', { id: 'market:minneapolis-mn', ...nl })
await t('dossier market Dallas', 'dossier', { id: 'market:dallas-tx', ...nl })
await t('dossier state TX', 'dossier', { id: 'state:TX', ...nl })
await t('dossier nation', 'dossier', { id: 'nation:US', ...nl })
await t('rank states nationally by sales', 'rank', { level: 'state', within: 'nation:US', metric: 'sales_count' })
await t('rank markets nationally by investor purch', 'rank', { level: 'market', within: 'nation:US', metric: 'investor_purchase_count' })
await t('rank ZIPs nationally (top 100) by inv purch', 'rank', { level: 'zip', within: 'nation:US', metric: 'investor_purchase_count', limit: 100 })
await t('rank ZIPs nationally by median price (warm tbl)', 'rank', { level: 'zip', within: 'nation:US', metric: 'median_sale_price', limit: 100 })
await t('rank Texas ZIPs by investor purchases', 'rank', { level: 'zip', within: 'state:TX', metric: 'investor_purchase_count' })
await t('rank Minneapolis-market ZIPs by sales', 'rank', { level: 'zip', within: 'market:minneapolis-mn', metric: 'sales_count' })
await t('compare 6 markets', 'compare', { ids: 'market:dallas-tx,market:houston-tx,market:atlanta-ga,market:minneapolis-mn,market:phoenix-az,market:miami-fl' })
await t('screener TX ZIPs sales>=100 & inv share>=15%', 'screen', { level: 'zip', within: 'state:TX', filters: JSON.stringify([{ metric: 'sales_count', op: 'gte', value: 100 }, { metric: 'investor_purchase_share', op: 'gte', value: 0.15 }]) })
await t('screener ALL ZIPs MF ppu<=150K & mf>=10', 'screen', { level: 'zip', within: 'nation:US', asset: 'mf', filters: JSON.stringify([{ metric: 'median_price_per_unit', op: 'lte', value: 150000 }, { metric: 'sales_count', op: 'gte', value: 10 }]) })
await t('trends ZIP 55411', 'trends', { ids: 'zip:55411' })
await t('recent_sales ZIP 55411 (DB)', 'recent_sales', { id: 'zip:55411' })
await t('recent_sales market Minneapolis MF (DB)', 'recent_sales', { id: 'market:minneapolis-mn', asset: 'mf' })
const u0 = performance.now(); const { universe } = svc._state(); await universe.load('MN'); console.log('universe load MN (DB)'.padEnd(46), (performance.now() - u0).toFixed(1).padStart(9), 'ms rows', universe.get('MN').rows.length)
await t('dossier ZIP 55411 with universe', 'dossier', { id: 'zip:55411', ...nl })
const d = await svc.run('dossier', { id: 'zip:55411', ...nl })
console.log('55411 sms', JSON.stringify(d.values.sms_eligible_count), 'brief:'); for (const s of d.brief) console.log('  -', s.text)
const dm = await svc.run('dossier', { id: 'market:minneapolis-mn', ...nl }); console.log('Mpls brief:'); for (const s of dm.brief) console.log('  -', s.text)
console.log('Mpls top buyers', dm.investors.top_buyers.slice(0, 5).map((b) => `${b.name}:${b.purchases}`).join(' | '))
console.log('Mpls rank ctx', JSON.stringify(dm.rank_context))
const g2 = await query(`select count(*) filter (where state='active' and backend_type='client backend')::int a from pg_stat_activity`)
console.log('active sessions after:', g2.rows[0].a)
await pool.end()
