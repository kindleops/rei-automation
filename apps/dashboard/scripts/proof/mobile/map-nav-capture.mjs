import { chromium } from 'playwright'
import fs from 'node:fs/promises'
/**
 * Universal navigation + deselect. READ ONLY (non-GET /api aborted). Never taps
 * the seller card's primary action (it can send an Ownership Check SMS).
 */
const OUT = 'artifacts/map-lens'
await fs.mkdir(OUT, { recursive: true })
const W = Number(process.argv.find((a) => a.startsWith('--width='))?.slice(8) ?? 390)
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: W, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
await ctx.addInitScript(() => { localStorage.setItem('nexus.map.mobileLens', JSON.stringify({ lens: 'radar', mapKey: false })) })
const page = await ctx.newPage()
let writes = 0
await page.route('**/api/**', (r) => (['GET', 'OPTIONS'].includes(r.request().method()) ? r.continue() : (writes++, r.abort())))
const errs = []; page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)))
await page.goto('http://localhost:5173/map', { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => Boolean(window.__nxMap), undefined, { timeout: 90000 })
await page.waitForTimeout(4000)
await page.evaluate(() => window.__nxMap.jumpTo({ center: [-95.40, 29.745], zoom: 14 }))
await page.waitForTimeout(6000)
const pt = await page.evaluate(() => {
  const m = window.__nxMap
  const feats = m.queryRenderedFeatures({ layers: ['prop-tiles-hit'] })
  const r = m.getCanvas().getBoundingClientRect()
  for (const f of feats) { const p = m.project(f.geometry.coordinates); const x = r.left + p.x, y = r.top + p.y; if (x > 60 && x < innerWidth - 90 && y > 240 && y < 480) return { x, y } }
  return null
})
const dock = async () => page.evaluate(() => ({
  back: Boolean(document.querySelector('.nx-mobile-command-dock__btn--back')),
  launcher: Boolean(document.querySelector('[aria-label$="open applications"]')),
  context: document.querySelector('.nx-mobile-command-dock__context-label')?.textContent ?? null,
  url: location.pathname + location.search,
}))
const report = { pt }
if (pt) {
  await page.touchscreen.tap(pt.x, pt.y); await page.waitForTimeout(2500)
  report.selected = await dock()
  await page.screenshot({ path: `${OUT}/nav-${W}-selected.png` })
  // Close via the dock's context chip (global clear).
  const clearBtn = page.locator('.nx-mobile-command-dock__context-clear')
  if (await clearBtn.count()) { await clearBtn.tap(); await page.waitForTimeout(1200) }
  report.cleared = await dock()
  report.cardOpen = await page.locator('.smc-mpeek, .smc-card, [class*="smc-"]').count()
  await page.screenshot({ path: `${OUT}/nav-${W}-cleared.png` })
}
// Into another app: launcher must stay reachable next to Back.
await page.evaluate(() => { window.history.pushState({ nxDepth: 1 }, '', '/entity-graph'); window.dispatchEvent(new PopStateEvent('popstate')) })
await page.waitForTimeout(3500)
report.inOther = await dock()
await page.screenshot({ path: `${OUT}/nav-${W}-other.png` })
const launcher = page.locator('[aria-label$="open applications"]').first()
if (await launcher.count()) { await launcher.tap(); await page.waitForTimeout(900); report.launcherOpened = await page.locator('[role="dialog"], .nx-app-launcher, [class*="launcher"]').count() }
await page.screenshot({ path: `${OUT}/nav-${W}-launcher.png` })
console.log(JSON.stringify({ ...report, writes, errs }, null, 1))
await browser.close()
