import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
/**
 * COMP INTELLIGENCE desktop layout probe (READ ONLY, NO NETWORK WRITES).
 *
 * Serves a dev-mode build (NODE_ENV=development vite build --outDir <dir>) from an
 * in-process static server, answers /api/cockpit/comps/workspace with a
 * synthetic fixture (no production read), aborts every other /api, Supabase and
 * Street View request, then measures the Compare plane:
 *   - is every panel inside the viewport (nothing clipped)
 *   - does the feature matrix scroll on wheel / shift-wheel / horizontal wheel
 *   - is the first column + header sticky, is the last comp column reachable
 *   - does the map ↔ plane splitter resize (when present)
 *
 *   node scripts/proof/desktop/comps-layout-probe.mjs --dist=/tmp/ciw-after \
 *     --out=/path/out --tag=after --sizes=1280x800,1440x900,1920x1080
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const DIST = path.resolve(arg('dist', '/tmp/ciw-before'))
const OUT = path.resolve(arg('out', 'artifacts/comps-layout'))
const TAG = arg('tag', 'probe')
const THEME = arg('theme', 'dark')
const SIZES = arg('sizes', '1280x800,1440x900,1920x1080').split(',').map((s) => s.split('x').map(Number))
await fs.mkdir(OUT, { recursive: true })
const watchdog = setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 8 * 60_000)

// ── synthetic workspace (shape of CompsWorkspace; values are fixture, not data) ──
const comp = (i, state) => {
  const key = `${state[0]}${i}`
  return {
    key, corpus: i % 3 ? 'engine_pool' : 'transaction_corpus', compId: key, propertyId: null, address: `${100 + i * 7} Fixture Avenue North, Minneapolis, MN`, city: 'Minneapolis', zip: '55430',
    lat: 45.048 + Math.sin(i) * 0.012, lng: -93.311 + Math.cos(i) * 0.016, salePrice: 250000 + i * 6100, saleDate: `2026-0${1 + (i % 8)}-1${i % 9}`, distanceMiles: 0.2 + i * 0.17,
    propertyType: 'Single Family', units: 1, beds: 3 + (i % 2), baths: 1 + (i % 3) * 0.5, sqft: 1050 + i * 31, lotSqft: 5200 + i * 90, yearBuilt: 1948 + i, condition: i % 2 ? 'Average' : 'Good', renovation: null,
    ppsf: 230 + i, ppu: 250000 + i * 6100, source: 'MLS sold', mls: true, buyerKind: null, buyerCompany: null, buyerId: null, buyerAcquisitions: null, buyerActivity: null,
    sellerKind: null, armsLength: true, cash: false, docType: null, photo: null, assetMatch: true, state, reasons: state === 'excluded' ? [{ code: 'outside_radius', label: 'Outside the search radius' }] : [],
    engine: state === 'excluded' ? { origin: 'live', eligible: false, reasons: ['outside_radius'] } : { origin: state === 'system' ? 'stored' : 'live', eligible: true, reasons: [], score: 96 - i, completeness: 62, weight: 0.78 - i * 0.02, adjustedPrice: 262000 + i * 3000, saleSource: 'mls_sold' },
    compare: { sqftPct: Math.round(((1050 + i * 31 - 1122) / 1122) * 100), beds: i % 2, baths: (i % 3) * 0.5 - 0.5, years: i - 6, lotPct: Math.round(((5200 + i * 90 - 6098) / 6098) * 100), units: 0, days: 60 + i * 20 },
    features: { subdivision: i % 2 ? 'Fixture Hills' : 'Lakeview', zoning: 'R1', quality: null, garage: 'Attached 2', pool: 'No', stories: 1, county: 'Hennepin' },
  }
}
const SYSTEM = Array.from({ length: 10 }, (_, i) => comp(i + 1, 'system'))
const CANDS = Array.from({ length: 6 }, (_, i) => comp(i + 11, 'candidate'))
const EXCL = Array.from({ length: 2 }, (_, i) => comp(i + 17, 'excluded'))
const FIXTURE = {
  generatedAt: '2026-10-06T15:00:00Z',
  query: { radiusMiles: 4, months: 30, radiusOptions: [1, 2, 4, 10], monthOptions: [12, 30, 36], engineWindow: { radiusMiles: 4, months: 30, clamped: false } },
  subject: { propertyId: 'FIXTURE-1', address: '4421 Fixture Avenue North', city: 'Minneapolis', state: 'MN', zip: '55430', lat: 45.048, lng: -93.311, propertyType: 'Single Family', family: 'residential', familyLabel: 'Single family', units: 1, beds: 3, baths: 1.5, sqft: 1122, lotSqft: 6098, yearBuilt: 1954, condition: 'Average', estimatedValue: 260000, mlsStatus: null, mlsListPrice: null, dimensions: [], subdivision: 'Lakeview', garage: 'Attached 2', pool: 'No', stories: 1 },
  counts: { system: 10, candidates: 6, excluded: 2, enginePool: 18, transactions: 0, transactionsInRadius: 0, transactionsSameFamily: 0, transactionsReturned: 0 },
  systemStats: { count: 10, medianPrice: null, low: null, high: null, medianPpsf: null, medianPpu: null, medianAdjusted: null, medianDistance: null, medianAgeDays: null },
  sufficiency: { level: 'moderate', usable: 16, withinMile: 6, withinMileLastYear: 4 },
  conclusion: null,
  market: null,
  comps: [...SYSTEM, ...CANDS, ...EXCL],
}

// ── static server for the built bundle (SPA fallback) ──
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
const results = []
for (const [W, H] of SIZES) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, serviceWorkers: 'block' })
  await ctx.addInitScript((t) => {
    try {
      localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
      const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
      localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t }))
    } catch { /* ignore */ }
  }, THEME)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
  await page.route('**/*', (r) => {
    const req = r.request()
    const u = new URL(req.url())
    if (u.pathname.startsWith('/api/cockpit/comps/workspace')) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: FIXTURE }) })
    if (u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname) || u.hostname.includes('googleapis')) return r.abort()
    return r.continue()
  })
  const shot = (scene) => page.screenshot({ path: path.join(OUT, `${TAG}-${THEME}-${W}x${H}-${scene}.png`) })
  const row = { size: `${W}x${H}` }
  try {
    await page.goto(`${BASE}/comp-intelligence?property_id=FIXTURE-1`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForFunction(() => document.querySelector('.ciw')?.getAttribute('data-state') === 'ready', null, { timeout: 60_000 })
    await page.waitForTimeout(1500)
    await page.locator('.ciw-plane [role="tab"]', { hasText: 'Compare' }).first().click()
    await page.waitForTimeout(900)
    await shot('compare')
    const measure = () => page.evaluate(() => {
      const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), bottom: Math.round(b.bottom), right: Math.round(b.right) } }
      const mx = document.querySelector('.ciw-matrix')
      const heads = [...document.querySelectorAll('.ciw-matrix thead .ciw-matrix__comp')]
      return {
        vw: innerWidth, vh: innerHeight,
        ciw: r('.ciw'), body: r('.ciw-body'), map: r('.ciw-map'), plane: r('.ciw-plane'), planeBody: r('.ciw-plane__body'), matrix: r('.ciw-matrix'), insights: r('.ciw-insights'),
        mx: mx ? { cw: mx.clientWidth, sw: mx.scrollWidth, ch: mx.clientHeight, sh: mx.scrollHeight, sl: Math.round(mx.scrollLeft), st: Math.round(mx.scrollTop) } : null,
        pb: (() => { const e = document.querySelector('.ciw-plane__body'); return e ? { ch: e.clientHeight, sh: e.scrollHeight, st: Math.round(e.scrollTop) } : null })(),
        compCols: heads.length,
        lastColRight: heads.length ? Math.round(heads[heads.length - 1].getBoundingClientRect().right) : null,
        featureColLeft: (() => { const e = document.querySelector('.ciw-matrix tbody th'); return e ? Math.round(e.getBoundingClientRect().left) : null })(),
        headTop: (() => { const e = document.querySelector('.ciw-matrix thead th'); return e ? Math.round(e.getBoundingClientRect().top) : null })(),
        splitter: Boolean(document.querySelector('.ciw-split')),
      }
    })
    const m0 = await measure()
    row.initial = m0
    if (m0.matrix) {
      const px = m0.matrix.x + m0.matrix.w / 2
      const py = Math.min(m0.matrix.y + Math.min(m0.matrix.h / 2, 200), m0.vh - 20)
      row.pointTarget = await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e ? `${e.tagName}.${String(e.className).slice(0, 60)} in-matrix=${Boolean(e.closest('.ciw-matrix'))}` : null }, [px, py])
      await page.mouse.move(px, py); await page.waitForTimeout(150)
      await page.mouse.wheel(0, 300); await page.waitForTimeout(600)
      const a = await measure()
      await page.keyboard.down('Shift'); await page.mouse.wheel(0, 400); await page.keyboard.up('Shift'); await page.waitForTimeout(350)
      const b = await measure()
      await page.mouse.wheel(5000, 0); await page.waitForTimeout(350)
      const c = await measure()
      await shot('compare-scrolled')
      row.wheel = { matrixTopDelta: a.mx.st - m0.mx.st, planeBodyTopDelta: a.pb.st - m0.pb.st }
      row.shiftWheel = { matrixLeftDelta: b.mx.sl - a.mx.sl }
      row.hWheel = { matrixLeftAfter: c.mx.sl, maxLeft: c.mx.sw - c.mx.cw, lastColRight: c.lastColRight, matrixRight: c.matrix.right, stickyFeatureLeft: c.featureColLeft, matrixLeft: c.matrix.x, headTop: c.headTop, matrixTop: c.matrix.y }
    }
    if (m0.splitter) {
      const s = await page.locator('.ciw-split').boundingBox()
      await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2)
      await page.mouse.down(); await page.mouse.move(s.x - 260, s.y + s.height / 2, { steps: 8 }); await page.mouse.up()
      await page.waitForTimeout(500)
      const d = await measure()
      row.splitter = { planeW0: m0.plane.w, planeW1: d.plane.w, matrixCw: d.mx?.cw }
      await shot('compare-resized')
      await page.locator('.ciw-split').focus(); await page.keyboard.press('ArrowRight'); await page.waitForTimeout(200)
      row.splitter.afterKey = (await measure()).plane.w
      await page.locator('.ciw-split').dblclick(); await page.waitForTimeout(300)
      row.splitter.afterReset = (await measure()).plane.w
    }
    // a Shell pane: the app root at ~half the window
    await page.addStyleTag({ content: '.ciw { width: 720px !important; }' })
    await page.waitForTimeout(700)
    const p = await measure()
    row.pane720 = { plane: p.plane, map: p.map, mx: p.mx, compCols: p.compCols }
    await shot('compare-pane720')
  } catch (e) {
    row.failed = String(e.message).slice(0, 240)
    await shot('failed').catch(() => {})
  }
  row.errors = errors.slice(0, 5)
  results.push(row)
  await ctx.close()
}
await browser.close()
server.close()
clearTimeout(watchdog)
console.log(JSON.stringify(results, null, 1))
