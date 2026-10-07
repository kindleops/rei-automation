import { chromium, devices } from 'playwright'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
/**
 * ENTITY GRAPH v2 capture (READ ONLY, NO DATABASE, NO DEV SERVER).
 *
 * Serves a dev-mode build (NODE_ENV=development vite build --mode development --outDir <dist>)
 * from an in-process static server. GET /api/cockpit/entity-graph/* is answered from a FIXTURE
 * file extracted read-only from production by apps/api/scripts/entity-graph-fixtures.mjs (the
 * real services over one BEGIN READ ONLY connection — labelled fixtures, real values at
 * extraction time). Every other /api and Supabase request is aborted; every non-GET is aborted.
 * Unknown fixture keys are written to <out>/misses.json (the extractor fills them, then re-run).
 *
 *   node /Users/ryankindle/.claude/jobs/c39b0175/tmp/with-lock.mjs capture node scripts/proof/desktop/eg-v2-capture.mjs \
 *     --dist=/tmp/eg-v2-after --fixtures=<fx.json> --out=<dir> --tag=after --themes=dark,light --sizes=1440x900,1920x1080 [--phone=1] [--proof=1]
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const DIST = path.resolve(arg('dist', '/tmp/eg-v2-after'))
const OUT = path.resolve(arg('out', 'artifacts/eg-v2'))
const FIX = path.resolve(arg('fixtures', 'fixtures.json'))
const TAG = arg('tag', 'after')
const THEMES = arg('themes', 'dark').split(',')
const SIZES = arg('sizes', '1440x900').split(',').filter(Boolean).map((s) => s.split('x').map(Number))
const PHONE = arg('phone', '0') === '1'
const PROOF = arg('proof', '0') === '1'
const ONLY = arg('scenes', '')
const SCENES = [
  ['01-properties', '/entity-graph'],
  ['02-property-inspector', '/entity-graph/property/237814852'],
  ['03-owner-graph', '/entity-graph/owner/mo_c5b0124c58cd26d14eafe503?egv=graph'],
  ['04-search-atlanta', '/entity-graph?q=Atlanta'],
  ['05-market-facet', `/entity-graph?ff=${encodeURIComponent(JSON.stringify([{ field_key: 'properties.market', operator: 'is_any_of', value: ['Atlanta, GA'] }]))}`],
].filter(([n]) => !ONLY || ONLY.split(',').some((o) => n.startsWith(o)))

await fs.mkdir(OUT, { recursive: true })
const watchdog = setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 15 * 60_000)
const fixtures = JSON.parse(await fs.readFile(FIX, 'utf8'))
const misses = new Set()
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
  await page.route('**/*', (r) => {
    const req = r.request()
    const u = new URL(req.url())
    const isApi = u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)
    if (isApi && req.method() !== 'GET') return r.abort()
    if (u.pathname.startsWith('/api/cockpit/entity-graph/')) {
      const k = keyOf(u)
      if (k in fixtures) {
        const body = fixtures[k]
        return r.fulfill({ status: body && body.ok === false ? 404 : 200, contentType: 'application/json', body: JSON.stringify(body) })
      }
      misses.add(`${u.pathname}${u.search}`)
      return r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'fixture_missing', message: 'Not in the capture fixture' }) })
    }
    // SELLER_SCREENER is OFF in production (default): the read answers exactly this.
    if (u.pathname.startsWith('/api/cockpit/campaigns/why-targeted')) {
      return r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'seller_screener_disabled' }) })
    }
    if (isApi || u.hostname.includes('googleapis') || u.hostname.includes('basemaps')) return r.abort()
    return r.continue()
  })
}

async function settle(page) {
  await page.waitForSelector('.egdk, .egm, .egx-listmode, .egx', { timeout: 60_000 })
  await page.waitForTimeout(2200)
}

const browser = await chromium.launch()
const report = []
const contexts = []
for (const theme of THEMES) for (const [W, H] of SIZES) contexts.push({ theme, W, H, phone: false })
if (PHONE) contexts.push({ theme: THEMES[0], W: 390, H: 844, phone: true })

for (const c of contexts) {
  const opts = c.phone
    ? { ...devices['iPhone 13'], serviceWorkers: 'block' }
    : { viewport: { width: c.W, height: c.H }, deviceScaleFactor: 1, serviceWorkers: 'block' }
  const ctx = await browser.newContext(opts)
  await ctx.addInitScript((t) => {
    try {
      localStorage.removeItem('nexus.desktop.split')
      sessionStorage.removeItem('lc.workspace.session.v1')
      localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
      const s = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
      localStorage.setItem('nexus-settings', JSON.stringify({ ...s, nexusTheme: t }))
    } catch { /* ignore */ }
  }, c.theme)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
  await guard(page)
  const label = c.phone ? `phone-${c.theme}-390x844` : `${c.theme}-${c.W}x${c.H}`
  const scenes = c.phone ? SCENES.slice(0, 1) : SCENES
  for (const [name, route] of scenes) {
    const row = { label, name }
    try {
      await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await settle(page)
      await page.screenshot({ path: path.join(OUT, `${TAG}-${label}-${name}.png`) })
      if (PROOF && !c.phone && name === '01-properties' && c.theme === THEMES[0] && c.W === SIZES[0][0]) row.proof = await interactionProof(page, path.join(OUT, `${TAG}-${label}`))
    } catch (e) {
      row.failed = String(e.message).slice(0, 200)
      await page.screenshot({ path: path.join(OUT, `${TAG}-${label}-${name}-failed.png`) }).catch(() => {})
    }
    report.push(row)
    console.log(JSON.stringify(row))
  }
  if (errors.length) console.log('page errors:', label, errors.slice(0, 6))
  await ctx.close()
}

/** Grid scroll, column resize and header sort — measured, not assumed. */
async function interactionProof(page, prefix) {
  const out = {}
  const sc = page.locator('.egdk .lc-grid__scroller').first()
  if (!(await sc.count())) return { error: 'no desk grid' }
  out.before = await sc.evaluate((el) => ({ top: el.scrollTop, left: el.scrollLeft, sw: el.scrollWidth, cw: el.clientWidth, sh: el.scrollHeight, ch: el.clientHeight }))
  await sc.evaluate((el) => { el.scrollTop = 600; el.scrollLeft = 400; el.dispatchEvent(new Event('scroll')) })
  await page.waitForTimeout(400)
  out.afterScroll = await sc.evaluate((el) => ({ top: el.scrollTop, left: el.scrollLeft }))
  await page.screenshot({ path: `${prefix}-proof-scrolled.png` })
  await sc.evaluate((el) => { el.scrollTop = 0; el.scrollLeft = 0 })
  await page.waitForTimeout(300)
  // resize the second header by dragging its edge 120px
  const th = page.locator('.egdk .lc-grid__th').nth(1)
  const w0 = await th.evaluate((el) => el.getBoundingClientRect().width)
  const grip = th.locator('.lc-grid__resize')
  const gb = await grip.boundingBox()
  if (gb) {
    await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2)
    await page.mouse.down()
    await page.mouse.move(gb.x + 60, gb.y + gb.height / 2, { steps: 6 })
    await page.mouse.move(gb.x + 120, gb.y + gb.height / 2, { steps: 6 })
    await page.mouse.up()
  }
  await page.waitForTimeout(300)
  out.resize = { header: await th.innerText().catch(() => ''), before: Math.round(w0), after: Math.round(await th.evaluate((el) => el.getBoundingClientRect().width)) }
  // sort: click the Value header (server keyset/index sort), read aria-sort and the request it made
  const sortBtn = page.locator('.egdk .lc-grid__th .lc-grid__sort', { hasText: 'Equity' }).first()
  const reqs = []
  const onReq = (r) => { if (r.url().includes('/entity-graph/browse')) reqs.push(new URL(r.url()).searchParams.toString()) }
  page.on('request', onReq)
  if (await sortBtn.count()) {
    await sortBtn.click()
    await page.waitForTimeout(1600)
    out.sort = {
      ariaSort: await page.locator('.egdk .lc-grid__th.is-sorted').first().getAttribute('aria-sort').catch(() => null),
      request: reqs.at(-1) ?? null,
      firstValues: await page.locator('.egdk .lc-grid__row').evaluateAll((rows) => rows.slice(0, 5).map((r) => r.innerText.split('\n').join(' | ').slice(0, 120))),
    }
    await page.screenshot({ path: `${prefix}-proof-sorted.png` })
  }
  page.off('request', onReq)
  return out
}

await browser.close()
server.close()
clearTimeout(watchdog)
await fs.writeFile(path.join(OUT, `${TAG}-misses.json`), JSON.stringify([...misses], null, 1))
await fs.writeFile(path.join(OUT, `${TAG}-report.json`), JSON.stringify(report, null, 1))
console.log('fixture misses:', misses.size)
