import { chromium } from 'playwright'
import fs from 'node:fs/promises'
/** Map search → area card, and address → property. READ ONLY (non-GET /api aborted). */
const OUT = 'artifacts/map-lens'
await fs.mkdir(OUT, { recursive: true })
const THEME = process.argv.find((a) => a.startsWith('--theme='))?.slice(8) ?? 'dark'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
await ctx.addInitScript((t) => {
  const cur = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
  localStorage.setItem('nexus-settings', JSON.stringify({ ...cur, nexusTheme: t }))
  localStorage.setItem('nexus.map.mobileLens', JSON.stringify({ lens: 'radar', mapKey: false, comps: false }))
}, THEME)
const page = await ctx.newPage()
let writes = 0
await page.route('**/api/**', (r) => (['GET', 'OPTIONS'].includes(r.request().method()) ? r.continue() : (writes++, r.abort())))
const errs = []; page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)))
await page.goto('http://localhost:5173/map', { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => Boolean(window.__nxMap), undefined, { timeout: 90000 })
await page.waitForTimeout(4000)
await page.screenshot({ path: `${OUT}/search-${THEME}-idle.png` })
const input = page.locator('.mx-search input')
await input.tap(); await input.fill('houston'); await page.waitForTimeout(1500)
await page.screenshot({ path: `${OUT}/search-${THEME}-results.png` })
const results = await page.locator('.mx-search__results button').allTextContents()
await page.locator('.mx-search__results button[data-search-kind="market"]').first().tap()
await page.waitForTimeout(5000)
await page.screenshot({ path: `${OUT}/search-${THEME}-area.png` })
const card = await page.locator('[data-map-card="area"]').textContent().catch(() => null)
await page.locator('.mx-search__clear').tap(); await page.waitForTimeout(600)
await input.tap(); await input.fill('77006'); await page.waitForTimeout(1500)
await page.locator('.mx-search__results button').first().tap(); await page.waitForTimeout(4500)
await page.screenshot({ path: `${OUT}/search-${THEME}-zip.png` })
console.log(JSON.stringify({ results, card: card?.slice(0, 400), writes, errs }, null, 1))
await browser.close()
