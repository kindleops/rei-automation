import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
/**
 * MARKET INTELLIGENCE v2 capture (READ ONLY, NO DATABASE, NO DEV SERVER).
 *
 * Serves a dev-mode build (NODE_ENV=development vite build --outDir <dist>) from an in-process
 * static server and answers GET /api/cockpit/market-intel from a FIXTURE file extracted read-only
 * from production by apps/api/scripts/market-intel-fixtures.mjs (real values at extraction time,
 * labelled fixtures). Every other /api and Supabase request is aborted, every non-GET is aborted.
 * Basemap tiles (CARTO) load from the network as on the real Map. Unknown MI keys are written to
 * <out>/misses.json so the extractor can fill them, then the capture is re-run.
 *
 *   node /Users/ryankindle/.claude/jobs/c39b0175/tmp/with-lock.mjs capture node scripts/proof/desktop/mi-v2-capture.mjs \
 *     --dist=/tmp/mi-v2-after --fixtures=<fixtures.json> --out=<dir> --tag=after --themes=dark,light --sizes=1440x900,1920x1080
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const DIST = path.resolve(arg('dist', '/tmp/mi-v2-after'))
const OUT = path.resolve(arg('out', 'artifacts/mi-v2'))
const FIX = path.resolve(arg('fixtures', 'fixtures.json'))
const TAG = arg('tag', 'after')
const THEMES = arg('themes', 'dark').split(',')
const SIZES = arg('sizes', '1440x900').split(',').map((s) => s.split('x').map(Number))
const ONLY = arg('scenes', '')
const MI = '/market-intelligence'
const SCENES = [
  ['01-nation-overview', `${MI}`],
  ['02-minneapolis-market', `${MI}?geo=market:minneapolis-mn`],
  ['03-dallas-investor-share', `${MI}?geo=market:dallas-tx&hm=investor_purchase_share`],
  ['04-dallas-zip-inspect', `${MI}?geo=market:dallas-tx&hm=sales_count`, 'inspect'],
  ['05-zip-55411', `${MI}?geo=zip:55411`],
].filter(([n]) => !ONLY || ONLY.split(',').some((o) => n.startsWith(o)))
await fs.mkdir(OUT, { recursive: true })
const watchdog = setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 12 * 60_000)
const fixtures = JSON.parse(await fs.readFile(FIX, 'utf8'))
const misses = new Map()
const seen = new Map()
const keyOf = (u) => { const q = new URLSearchParams(); for (const k of [...new Set([...u.searchParams.keys()])].sort()) q.set(k, u.searchParams.get(k)); return q.toString() }

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

const browser = await chromium.launch()
const report = []
for (const theme of THEMES) {
  for (const [W, H] of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, serviceWorkers: 'block' })
    await ctx.addInitScript((t) => {
      try {
        localStorage.removeItem('nexus.desktop.split')
        localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
        const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
        localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t }))
      } catch { /* ignore */ }
    }, theme)
    const page = await ctx.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
    await page.route('**/*', (r) => {
      const req = r.request()
      const u = new URL(req.url())
      const isApi = u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)
      if (isApi && req.method() !== 'GET') return r.abort()
      if (u.pathname.startsWith('/api/cockpit/market-intel')) {
        const k = keyOf(u)
        seen.set(k, Object.fromEntries(u.searchParams))
        if (k in fixtures) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixtures[k]) })
        misses.set(k, Object.fromEntries(u.searchParams))
        return r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'fixture_missing', message: 'Not in the capture fixture' }) })
      }
      if (isApi || u.hostname.includes('googleapis')) return r.abort()
      return r.continue()
    })
    for (const [name, route, mode] of SCENES) {
      const row = { theme, size: `${W}x${H}`, name }
      try {
        await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
        await page.waitForSelector('.mi', { timeout: 60_000 })
        await page.waitForFunction(() => document.querySelector('.mi-hero, .mi-warming'), null, { timeout: 60_000 }).catch(() => {})
        // the hero map: wait for its first idle render (real tiles + the heat layers)
        await page.waitForFunction(() => { const m = document.querySelector('.mi-atlas'); return !m || m.getAttribute('data-state') === 'ready' || m.getAttribute('data-state') === 'failed' }, null, { timeout: 45_000 }).catch(() => { row.mapWait = 'timeout' })
        await page.waitForTimeout(2500)
        if (mode === 'inspect') {
          await page.locator('.mi-board__row').first().click().catch(() => { row.inspect = 'no row' })
          await page.waitForSelector('.mi-side .mi-insp', { timeout: 15_000 }).catch(() => {})
          await page.waitForTimeout(1200)
        }
        row.probe = await page.evaluate(() => {
          const m = document.querySelector('.mi-atlas')
          return m ? { state: m.getAttribute('data-state'), heatFeatures: Number(m.getAttribute('data-heat-n') || 0), areas: Number(m.getAttribute('data-area-n') || 0), layers: m.getAttribute('data-layers'), canvas: Boolean(m.querySelector('canvas')) } : null
        })
        await page.screenshot({ path: path.join(OUT, `${TAG}-${theme}-${W}x${H}-${name}.png`), timeout: 120_000 })
      } catch (e) {
        row.failed = String(e.message).slice(0, 200)
        await page.screenshot({ path: path.join(OUT, `${TAG}-${theme}-${W}x${H}-${name}-failed.png`) }).catch(() => {})
      }
      report.push(row)
      console.log(JSON.stringify(row))
    }
    if (errors.length) console.log('page errors:', errors)
    await ctx.close()
  }
}
await browser.close()
server.close()
clearTimeout(watchdog)
await fs.writeFile(path.join(OUT, 'misses.json'), JSON.stringify([...misses.values()], null, 1))
await fs.writeFile(path.join(OUT, 'requested.json'), JSON.stringify([...seen.values()], null, 1))
console.log('fixture misses:', misses.size)
