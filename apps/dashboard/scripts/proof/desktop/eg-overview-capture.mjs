/**
 * ENTITY GRAPH OVERVIEW capture (READ ONLY, NO DEV SERVER).
 *
 * Serves a dev-mode build from an in-process static server. GET
 * /api/cockpit/entity-graph/overview is answered LIVE by the real Overview
 * service over a read-only pool (default_transaction_read_only, statement
 * timeout); every other /api/cockpit/entity-graph/* GET comes from a fixture
 * file (apps/api/scripts/entity-graph-fixtures.mjs). Every non-GET and every
 * other API / Supabase request is aborted. Misses → <out>/misses.json.
 *
 * Run from apps/api (the service imports resolve through its alias loader):
 *   node --import ./tests/register-aliases.mjs ../dashboard/scripts/proof/desktop/eg-overview-capture.mjs \
 *     --dist=/tmp/egov-dist --fixtures=<fx.json> --out=<dir> --themes=dark,light --sizes=1440x900,1920x1080
 */
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import pg from 'pg'

const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const DIST = path.resolve(arg('dist', '/tmp/egov-dist'))
const OUT = path.resolve(arg('out', '/tmp/egov-shots'))
const FIX = arg('fixtures', '')
const THEMES = arg('themes', 'dark').split(',')
const SIZES = arg('sizes', '1440x900').split(',').filter(Boolean).map((s) => s.split('x').map(Number))
const ONLY = arg('scenes', '')
const ff = (filters) => encodeURIComponent(JSON.stringify(filters))
const DALLAS = [{ field_key: 'properties.market', operator: 'is_any_of', value: ['Dallas, TX'] }]
const SCENES = [
  ['01-band-dallas', `/entity-graph?ff=${ff(DALLAS)}`],
  ['02-band-dallas-vacant', `/entity-graph?ff=${ff([...DALLAS, { field_key: 'properties.flags', operator: 'is_all_of', value: ['Vacant Home'] }])}`],
  ['03-mode-dallas', `/entity-graph?ff=${ff(DALLAS)}`, 'mode'],
  ['04-mode-dallas-debt', `/entity-graph?ff=${ff(DALLAS)}`, 'mode-debt'],
  ['05-click-cross-filter', `/entity-graph?ff=${ff(DALLAS)}`, 'click'],
].filter(([n]) => !ONLY || ONLY.split(',').some((o) => n.startsWith(o)))

const { buildEntityGraphOverview } = await import('@/lib/domain/entity-graph/entity-graph-overview-service.js')
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL || readFileSync('/tmp/.dburl', 'utf8').trim(), ssl: { rejectUnauthorized: false }, max: 4 })
pool.on('connect', (c) => c.query('set default_transaction_read_only = on'))
const query = async (sql, params, ms) => { const c = await pool.connect(); try { await c.query(`set statement_timeout = ${Math.min(30_000, Math.trunc(ms || 8000))}`); return await c.query(sql, params) } finally { c.release() } }
const overviewDeps = { query, skipSnapshot: true, timeoutMs: 30_000, fetchEntityContactReviewBlocks: async () => ({ ok: true, blocked: new Set() }) }

await fs.mkdir(OUT, { recursive: true })
const watchdog = setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 20 * 60_000)
const fixtures = FIX ? JSON.parse(await fs.readFile(FIX, 'utf8')) : {}
const misses = new Set()
const timings = []
const keyOf = (u) => {
  const qs = new URLSearchParams()
  for (const k of [...new Set([...u.searchParams.keys()])].sort()) qs.set(k, u.searchParams.get(k))
  const s = qs.toString()
  return s ? `${u.pathname}?${s}` : u.pathname
}
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' }
const server = http.createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  let file = path.join(DIST, p)
  try { if (!(await fs.stat(file)).isFile()) throw 0 } catch { file = path.join(DIST, 'index.html') }
  res.setHeader('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream')
  res.end(await fs.readFile(file))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`

async function guard(page) {
  await page.route('**/*', async (r) => {
    const req = r.request()
    const u = new URL(req.url())
    const isApi = u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)
    if (isApi && req.method() !== 'GET') return r.abort()
    if (u.pathname === '/api/cockpit/entity-graph/overview') {
      const t0 = Date.now()
      try {
        const body = await buildEntityGraphOverview(Object.fromEntries(u.searchParams.entries()), overviewDeps)
        timings.push({ sections: u.searchParams.get('sections'), filters: (JSON.parse(u.searchParams.get('field_filters') || '[]')).length, ms: Date.now() - t0, server: body.timings?.totalMs })
        return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, ...body }) })
      } catch (e) {
        return r.fulfill({ status: e?.code === 'unsupported_entity_graph_filters' ? 422 : 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: e?.code || 'failed', message: String(e?.message || e) }) })
      }
    }
    if (u.pathname.startsWith('/api/cockpit/entity-graph/')) {
      const k = keyOf(u)
      if (k in fixtures) {
        const body = fixtures[k]
        return r.fulfill({ status: body && body.ok === false ? 404 : 200, contentType: 'application/json', body: JSON.stringify(body) })
      }
      misses.add(`${u.pathname}${u.search}`)
      return r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'fixture_missing' }) })
    }
    if (isApi || u.hostname.includes('googleapis') || u.hostname.includes('basemaps')) return r.abort()
    return r.continue()
  })
}

const browser = await chromium.launch()
const report = []
for (const theme of THEMES) for (const [W, H] of SIZES) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, serviceWorkers: 'block' })
  await ctx.addInitScript((t) => {
    try {
      localStorage.removeItem('nexus.desktop.split')
      sessionStorage.removeItem('lc.workspace.session.v1')
      localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
      const s = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
      localStorage.setItem('nexus-settings', JSON.stringify({ ...s, nexusTheme: t }))
    } catch { /* ignore */ }
  }, theme)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
  await guard(page)
  const label = `${theme}-${W}x${H}`
  for (const [name, route, mode] of SCENES) {
    const row = { label, name }
    try {
      await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await page.waitForSelector('.egdk', { timeout: 60_000 })
      // a scene before may have left Overview mode on (session preference): band scenes start from the grid
      if (!(mode && mode.startsWith('mode')) && await page.locator('.egov-mode').count()) {
        await page.locator('.egov-mode__head button', { hasText: 'Records' }).click()
        await page.waitForSelector('.egov-band', { timeout: 30_000 })
      }
      if (mode && mode.startsWith('mode')) {
        await page.getByRole('radio', { name: 'Overview' }).first().click().catch(async () => { await page.locator('button', { hasText: 'All fields' }).first().click() })
        await page.waitForSelector('.egov-mode', { timeout: 30_000 })
        if (mode === 'mode-debt') {
          await page.locator('.egov-mode__nav .egov-chip', { hasText: 'Debt' }).click()
          await page.waitForFunction(() => document.querySelectorAll('#egov-sec-debt .egov-card:not(.is-skeleton)').length >= 4, null, { timeout: 90_000 }).catch(() => { row.note = 'debt still loading' })
          await page.locator('#egov-sec-debt').scrollIntoViewIfNeeded()
        }
        await page.waitForFunction(() => document.querySelectorAll('.egov-mode .egov-card:not(.is-skeleton)').length >= 8, null, { timeout: 90_000 }).catch(() => { row.note = 'cards still loading' })
      } else {
        await page.waitForFunction(() => document.querySelectorAll('.egov-band .egov-card:not(.is-skeleton)').length >= 6, null, { timeout: 90_000 }).catch(() => { row.note = 'band still loading' })
      }
      await page.waitForTimeout(900)
      if (mode === 'click') {
        // click the "Single Family" bar in the band: the chip lands in the rail's filter list and everything refetches
        const bar = page.locator('.egov-band .egov-card[data-field="properties.property_type"] .egov-bar', { hasText: 'Single Family' }).first()
        const before = await page.locator('.egov-band__summary b').first().innerText().catch(() => null)
        await bar.click()
        await page.waitForFunction((b) => { const t = document.querySelector('.egov-band__summary b')?.textContent; return t && t !== b }, before, { timeout: 60_000 }).catch(() => { row.note = 'total did not change' })
        await page.waitForTimeout(1200)
        row.click = {
          before,
          after: await page.locator('.egov-band__summary b').first().innerText().catch(() => null),
          url: decodeURIComponent(new URL(page.url()).searchParams.get('ff') || ''),
          grid: await page.locator('.egdk-tablebar__count').first().innerText().catch(() => null),
        }
      }
      await page.screenshot({ path: path.join(OUT, `${label}-${name}.png`) })
    } catch (e) {
      row.failed = String(e.message).slice(0, 200)
      await page.screenshot({ path: path.join(OUT, `${label}-${name}-failed.png`) }).catch(() => {})
    }
    report.push(row)
    console.log(JSON.stringify(row))
  }
  if (errors.length) console.log('page errors:', label, errors.slice(0, 6))
  await ctx.close()
}
await browser.close()
server.close()
await pool.end()
clearTimeout(watchdog)
await fs.writeFile(path.join(OUT, 'misses.json'), JSON.stringify([...misses], null, 1))
await fs.writeFile(path.join(OUT, 'report.json'), JSON.stringify({ report, timings }, null, 1))
console.log('fixture misses:', misses.size, '· overview requests:', timings.length)
