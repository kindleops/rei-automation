import { chromium } from 'playwright'
import fs from 'node:fs/promises'
/** Sold comps: layer, card, portfolio, filters. READ ONLY (non-GET /api aborted). */
const OUT = 'artifacts/map-lens'
await fs.mkdir(OUT, { recursive: true })
const THEME = process.argv.find((a) => a.startsWith('--theme='))?.slice(8) ?? 'dark'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
await ctx.addInitScript((t) => {
  const cur = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
  localStorage.setItem('nexus-settings', JSON.stringify({ ...cur, nexusTheme: t }))
  localStorage.setItem('nexus.map.mobileLens', JSON.stringify({ lens: 'radar', comps: true, mapKey: false, everyProperty: false }))
}, THEME)
const page = await ctx.newPage()
let writes = 0
await page.route('**/api/**', (r) => (['GET', 'OPTIONS'].includes(r.request().method()) ? r.continue() : (writes++, r.abort())))
const errs = []; page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)))
await page.goto('http://localhost:5173/map', { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => Boolean(window.__nxMap), undefined, { timeout: 90000 })
await page.waitForTimeout(4000)
const report = {}
for (const [name, c, z] of [['national', [-96, 37.5], 3.8], ['metro', [-111.9, 33.45], 9.5], ['street', [-111.673, 33.4202], 16]]) {
  await page.evaluate(([c, z]) => window.__nxMap.jumpTo({ center: c, zoom: z }), [c, z])
  await page.waitForTimeout(4500)
  report[name] = await page.locator('[data-map-control="comps"]').textContent().catch(() => null)
  await page.screenshot({ path: `${OUT}/comps-${THEME}-${name}.png` })
}
// Tap a single comp near the centre.
const pt = await page.evaluate(() => {
  const m = window.__nxMap
  const f = m.queryRenderedFeatures({ layers: ['nx-comps-point'] })
  const r = m.getCanvas().getBoundingClientRect()
  for (const x of f) { const p = m.project(x.geometry.coordinates); if (p.y > 250 && p.y < 520 && p.x > 40 && p.x < 330) return { x: r.left + p.x, y: r.top + p.y } }
  return null
})
if (pt) {
  await page.evaluate((p) => { const m = window.__nxMap; const r = m.getCanvas().getBoundingClientRect(); m.fire('click', { point: { x: p.x - r.left, y: p.y - r.top }, lngLat: m.unproject([p.x - r.left, p.y - r.top]), originalEvent: new MouseEvent('click') }) }, pt)
  await page.waitForTimeout(3000)
  await page.screenshot({ path: `${OUT}/comps-${THEME}-card.png` })
  const gold = page.locator('.mx-act.is-gold')
  if (await gold.count()) { await gold.tap(); await page.waitForTimeout(1800); await page.screenshot({ path: `${OUT}/comps-${THEME}-portfolio.png` }) }
  report.card = await page.locator('[data-map-card="comp"]').textContent().catch(() => null)
  await page.locator('.mx-comp__close').tap().catch(() => {})
}
await page.locator('[data-map-control="comps"]').tap(); await page.waitForTimeout(800)
await page.screenshot({ path: `${OUT}/comps-${THEME}-filters.png` })
console.log(JSON.stringify({ pt, report: { ...report, card: report.card?.slice(0, 300) }, writes, errs }, null, 1))
await browser.close()
