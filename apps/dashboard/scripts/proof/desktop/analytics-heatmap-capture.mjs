import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * ANALYTICS 4.1 — the continuous trend + the geographic heat map (READ ONLY).
 *
 * One pass, live reads through the Vite proxy (the local API reads
 * PRODUCTION): every non-GET to /api or Supabase is aborted and counted, the
 * shell's direct PostgREST counters are not issued. Element screenshots of the
 * hero trend (at rest + scrubbed onto an empty day) and the heat map at
 * nation / state / county / city / ZIP, Dark + Light at 1440.
 *
 * ZIP outlines have two legs. The live API answers { available: false } until
 * public.analytics_zip_boundaries is applied, so the plain city / ZIP shots
 * are the FALLBACK leg as production serves it. The `*-zcta-*` shots are the
 * POLYGON leg: the harness (never production code) fulfils /boundaries from
 * fixtures/zcta-minneapolis.json — a read-only copy of exactly what the
 * function returns for those ZIPs (its own SQL against the ZCTA table).
 *
 *   node scripts/proof/desktop/analytics-heatmap-capture.mjs --out=<dir>
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/analytics-heatmap'))
const ONLY = arg('only', '')
const TZ = 'America/Chicago'
await fs.mkdir(OUT, { recursive: true })
const watchdog = setTimeout(() => { console.log('WATCHDOG — exiting'); process.exit(2) }, Number(arg('watchdog', 25 * 60_000)))

const stats = { blocked: [], api: 0, stubbed: 0 }
let inflight = 0
let lastApi = Date.now()
async function quiet(ms = 2500, max = 240_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < max) { if (inflight === 0 && Date.now() - lastApi > ms) return true; await new Promise((r) => setTimeout(r, 300)) }
  return false
}
const ZCTA = JSON.parse(await fs.readFile(new URL('./fixtures/zcta-minneapolis.json', import.meta.url), 'utf8'))
function zctaAnswer(url) {
  const asked = (new URL(url).searchParams.get('zips') || '').split(',').filter((z) => /^[0-9]{5}$/.test(z))
  const zips = Object.fromEntries(asked.filter((z) => ZCTA.zips[z]).map((z) => [z, ZCTA.zips[z]]))
  return { ok: true, data: { available: true, source: 'US Census ZCTA', zips, missing: asked.filter((z) => !ZCTA.zips[z]) } }
}
async function context(browser, { width, height, theme, stubZcta = false }) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, timezoneId: TZ })
  await ctx.addInitScript(({ t }) => {
    try {
      localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
      sessionStorage.removeItem('lc.workspace.session.v1')
      localStorage.removeItem('anx:intel:ctx:v1')
      const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
      localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t }))
    } catch { /* ignore */ }
  }, { t: theme })
  // the request guard: nothing but GET / HEAD / OPTIONS reaches /api or Supabase
  await ctx.route('**/*', async (route) => {
    const req = route.request()
    const u = new URL(req.url())
    const m = req.method()
    const api = u.pathname.startsWith('/api/')
    const supa = /supabase\.co$/.test(u.hostname)
    if ((api || supa) && !['GET', 'HEAD', 'OPTIONS'].includes(m)) { stats.blocked.push(`${m} ${u.pathname}`); return route.abort() }
    if (supa && /\/rest\/v1\//.test(u.pathname)) return route.abort()
    if (stubZcta && m === 'GET' && u.pathname === '/api/cockpit/analytics/lab/boundaries') {
      stats.stubbed += 1
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(zctaAnswer(req.url())) })
    }
    if (api) {
      stats.api += 1; inflight += 1; lastApi = Date.now()
      try { return await route.continue() } finally { inflight -= 1; lastApi = Date.now() }
    }
    return route.continue()
  })
  return ctx
}
const labUrl = (over = {}) => {
  const c = { v: 1, tz: TZ, lens: 'overview', metric: 'reply_rate', groupBy: null, view: 'line', filters: [], segment: [], range: { preset: '30d' }, compare: { mode: 'previous' }, grain: 'auto', ...over }
  return `${BASE}/analytics?lab=${Buffer.from(JSON.stringify(c)).toString('base64url')}`
}
const MN = { dim: 'state', value: 'MN', label: 'Minnesota' }
const HEN = { dim: 'county', value: 'Hennepin|MN', label: 'Hennepin, MN' }
const MPLS = { dim: 'city', value: 'Minneapolis|MN', label: 'Minneapolis, MN' }
const ZIP = { dim: 'zip', value: '55411', label: '55411' }
const SHOTS = [
  ...['dark', 'light'].flatMap((theme) => [
    { id: `trend-reply-rate-${theme}`, theme, ctx: {}, el: '.ix-hero' },
    { id: `trend-reply-rate-gap-hover-${theme}`, theme, ctx: {}, el: '.ix-hero', scrub: 0.47 },
    { id: `trend-sellers-reached-${theme}`, theme, ctx: { metric: 'sellers_reached' }, el: '.ix-hero' },
    { id: `map-nation-${theme}`, theme, ctx: { lens: 'geography' }, el: '.ix-geo', hover: 'MN' },
    { id: `map-state-${theme}`, theme, ctx: { lens: 'geography', segment: [MN] }, el: '.ix-geo', hover: 'Hennepin|MN' },
    { id: `map-county-${theme}`, theme, ctx: { lens: 'geography', segment: [MN, HEN] }, el: '.ix-geo', hover: 'Minneapolis|MN' },
    { id: `map-city-${theme}`, theme, ctx: { lens: 'geography', segment: [MN, HEN, MPLS] }, el: '.ix-geo', hover: '55412' },
    { id: `map-zip-${theme}`, theme, ctx: { lens: 'geography', segment: [MN, HEN, MPLS, ZIP] }, el: '.ix-geo' },
  ]),
  // the polygon leg (harness-stubbed /boundaries from the read-only ZCTA fixture)
  { id: 'map-city-zcta-dark', theme: 'dark', ctx: { lens: 'geography', segment: [MN, HEN, MPLS] }, el: '.ix-geo', hover: '55412', stubZcta: true },
  { id: 'map-city-zcta-light', theme: 'light', ctx: { lens: 'geography', segment: [MN, HEN, MPLS] }, el: '.ix-geo', hover: '55412', stubZcta: true },
  { id: 'map-zip-zcta-dark', theme: 'dark', ctx: { lens: 'geography', segment: [MN, HEN, MPLS, ZIP] }, el: '.ix-geo', stubZcta: true },
  { id: 'map-nation-sellers-reached-dark', theme: 'dark', ctx: { lens: 'geography', metric: 'sellers_reached' }, el: '.ix-geo', hover: 'TX' },
  { id: 'map-state-tx-delivery-rate-dark', theme: 'dark', ctx: { lens: 'geography', metric: 'delivery_rate', segment: [{ dim: 'state', value: 'TX', label: 'Texas' }] }, el: '.ix-geo' },
].filter((s) => !ONLY || ONLY.split(',').includes(s.id))

const browser = await chromium.launch()
const report = []
for (const s of SHOTS) {
  const ctx = await context(browser, { width: 1440, height: 900, theme: s.theme, stubZcta: Boolean(s.stubZcta) })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
  const t0 = Date.now()
  try {
    await page.goto(labUrl(s.ctx), { waitUntil: 'domcontentloaded', timeout: 180_000 })
    await page.waitForSelector(s.el, { timeout: 240_000 })
    await quiet(2500, 300_000)
    const el = page.locator(s.el).first()
    await el.scrollIntoViewIfNeeded()
    await quiet(2000, 120_000)
    if (s.el === '.ix-geo') await page.waitForFunction(() => !document.querySelector('.ix-geo__state') && document.querySelector('.ix-geo__area[style], .ix-geo__pt'), null, { timeout: 180_000 }).catch(() => {})
    else await page.waitForSelector('.ix-hero .ixt__plot', { timeout: 240_000 }).catch(() => {})
    await quiet(1500, 120_000)
    await page.waitForTimeout(1200)
    if (s.scrub) {
      const plot = page.locator('.ix-hero .ixt__plot').first()
      const b = await plot.boundingBox()
      if (b) { await page.mouse.move(b.x + b.width * s.scrub, b.y + b.height * 0.5); await page.waitForTimeout(300); await page.mouse.move(b.x + b.width * s.scrub + 1, b.y + b.height * 0.5) }
      await quiet(1500, 120_000)
      await page.waitForTimeout(700)
    }
    if (s.hover) {
      const target = page.locator(`.ix-geo [data-k="${s.hover}"]`).first()
      if (await target.count()) {
        const b = await target.boundingBox()
        if (b) { await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.waitForTimeout(400); await page.mouse.move(b.x + b.width / 2 + 1, b.y + b.height / 2) }
        await page.waitForTimeout(500)
      }
    }
    const file = `${OUT}/${s.id}.png`
    await el.screenshot({ path: file, timeout: 60_000 })
    const m = await page.evaluate((sel) => {
      const root = document.querySelector(sel)
      const txt = root?.textContent || ''
      return {
        garbage: (txt.match(/\bNaN\b|\bundefined\b|\[object Object\]|Infinity/g) || []).slice(0, 5),
        areas: document.querySelectorAll('.ix-geo__area').length, filled: [...document.querySelectorAll('.ix-geo__area')].filter((e) => e.getAttribute('style')).length,
        points: document.querySelectorAll('.ix-geo__pt').length, src: document.querySelector('.ix-geo__src')?.textContent || null, crumbs: [...document.querySelectorAll('.ix-geo__crumbs button')].map((b) => b.textContent).join(' › '),
        tip: document.querySelector('.ix-geo__tip, .ix-hero__basis')?.textContent?.slice(0, 160) || null,
      }
    }, s.el)
    report.push({ id: s.id, file, ...m, errors, ms: Date.now() - t0 })
    console.log(s.id.padEnd(40), m.garbage.length || errors.length ? 'FLAG' : 'ok', JSON.stringify({ ...m, errors }))
  } catch (e) {
    report.push({ id: s.id, fail: String(e.message).slice(0, 200), errors })
    console.log(s.id.padEnd(40), 'FAIL', String(e.message).slice(0, 160))
  }
  await ctx.close()
}
await fs.writeFile(path.join(OUT, 'report.json'), JSON.stringify({ report, stats: { api: stats.api, blockedWrites: stats.blocked.length, blocked: stats.blocked.slice(0, 20) } }, null, 2))
console.log('stats', JSON.stringify({ api: stats.api, stubbedBoundaries: stats.stubbed, blockedWrites: stats.blocked.length }))
await browser.close()
clearTimeout(watchdog)
