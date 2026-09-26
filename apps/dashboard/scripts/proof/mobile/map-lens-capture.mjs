import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * Map lenses — mobile capture. READ ONLY: every non-GET /api call is aborted.
 * (Supabase lens reads are read-only RPCs.)
 *
 *   node scripts/proof/mobile/map-lens-capture.mjs --width=390 --theme=dark --shots=opportunity@11,census_income@9
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const WIDTH = Number(arg('width', '390'))
const THEME = arg('theme', 'dark')
const STYLE = arg('style', '')
const CENTER = arg('center', '-95.40,29.74').split(',').map(Number)
const SHOTS = arg('shots', 'radar@11,opportunity@11,equity@11,census_income@9,territory@9,year_built@14').split(',')
const EXTRA = arg('extra', 'gallery,market').split(',')
const PREFS = JSON.parse(arg('prefs', '{}'))
const OUT = path.resolve(arg('out', 'artifacts/map-lens'))
await fs.mkdir(OUT, { recursive: true })

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: WIDTH, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
await ctx.addInitScript(([t, style, prefs]) => {
  try {
    const cur = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
    localStorage.setItem('nexus-settings', JSON.stringify({ ...cur, nexusTheme: t }))
    const lp = JSON.parse(localStorage.getItem('nexus.map.mobileLens') || '{}')
    localStorage.setItem('nexus.map.mobileLens', JSON.stringify({ ...lp, ...prefs }))
    if (style) localStorage.setItem('nexus.commandMap.styleMode', style)
  } catch {}
}, [THEME, STYLE, PREFS])
const page = await ctx.newPage()
let writes = 0
await page.route('**/api/**', (r) => (['GET', 'OPTIONS'].includes(r.request().method()) ? r.continue() : (writes++, r.abort())))
const errs = []; page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)))
page.on('console', (m) => { if (m.type() === 'error' && /lens|rpc|maplibre|Style/i.test(m.text())) errs.push(m.text().slice(0, 160)) })

await page.goto(`${BASE}/map`, { waitUntil: 'domcontentloaded', timeout: 180000 })
await page.addStyleTag({ content: ':root{--nx-mobile-safe-bottom:34px !important}' })
await page.waitForSelector('canvas.maplibregl-canvas', { timeout: 120000 })
await page.waitForFunction(() => Boolean(window.__nxMap), undefined, { timeout: 60000 }).catch(() => {})
await page.waitForTimeout(5000)

const pick = async (id) => {
  await page.locator('[data-map-control="layers"]').tap()
  await page.waitForTimeout(500)
  await page.locator(`[data-lens-id="${id}"]`).tap()
  await page.waitForTimeout(400)
}
const report = []
for (const s of SHOTS) {
  const [id, z] = s.split('@')
  await page.evaluate(([c, z]) => window.__nxMap?.jumpTo({ center: c, zoom: Number(z) }), [CENTER, z])
  await pick(id)
  await page.waitForTimeout(3200)
  const info = await page.evaluate(() => {
    const m = window.__nxMap
    const src = m?.getSource('nx-lens')
    const vis = ['nx-lens-field', 'nx-lens-heat', 'nx-lens-dots'].map((l) => `${l}:${m?.getLayer(l) ? m.getLayoutProperty(l, 'visibility') : 'absent'}`)
    const n = m ? m.queryRenderedFeatures({ layers: ['nx-lens-field', 'nx-lens-heat', 'nx-lens-dots'].filter((l) => m.getLayer(l)) }).length : 0
    return { vis, rendered: n, legend: document.querySelector('[data-map-card="legend"]')?.textContent?.slice(0, 120) ?? null, pill: document.querySelector('[data-map-control="mode"]')?.textContent?.slice(0, 60) }
  })
  report.push({ s, ...info })
  await page.screenshot({ path: `${OUT}/${WIDTH}-${THEME}-${id}-z${z}.png` })
}
if (EXTRA.includes('gallery')) {
  await page.locator('[data-map-control="layers"]').tap(); await page.waitForTimeout(700)
  await page.screenshot({ path: `${OUT}/${WIDTH}-${THEME}-gallery.png` })
  await page.locator('.mx-sheet__body').evaluate((el) => { el.scrollTop = 700 })
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${OUT}/${WIDTH}-${THEME}-gallery-2.png` })
  await page.locator('.mx-seg__tab', { hasText: 'Intel' }).tap(); await page.waitForTimeout(400)
  await page.screenshot({ path: `${OUT}/${WIDTH}-${THEME}-intel.png` })
  if (EXTRA.includes('market')) {
    const t = page.locator('[role="switch"]', { hasText: 'Market panel' })
    if ((await t.getAttribute('aria-checked')) !== 'true') await t.tap()
  }
  await page.locator('[data-map-sheet-close]').first().tap(); await page.waitForTimeout(3000)
  await page.screenshot({ path: `${OUT}/${WIDTH}-${THEME}-market.png` })
}
if (EXTRA.includes('tap')) {
  // Tap a lens cell that has no property under it.
  const pt = await page.evaluate(() => {
    const m = window.__nxMap
    const layers = ['nx-lens-field', 'nx-lens-dots'].filter((l) => m.getLayer(l) && m.getLayoutProperty(l, 'visibility') !== 'none')
    for (const f of m.queryRenderedFeatures({ layers })) {
      const p = m.project(f.geometry.coordinates)
      if (p.y < 240 || p.y > 600 || p.x < 40 || p.x > 320) continue
      return { x: p.x, y: p.y }
    }
    return null
  })
  const at = pt ?? { x: 200, y: 420 }
  await page.evaluate((p) => { const m = window.__nxMap; m.fire('contextmenu', { point: p, lngLat: m.unproject([p.x, p.y]), originalEvent: new MouseEvent('contextmenu') }) }, at)
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${OUT}/${WIDTH}-${THEME}-readout.png` })
  report.push({ readout: await page.locator('.mx-readout').textContent().catch(() => null) })
}
console.log(JSON.stringify({ report, writes, errs: errs.slice(0, 8) }, null, 1))
await browser.close()
