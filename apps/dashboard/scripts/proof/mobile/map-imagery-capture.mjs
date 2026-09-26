import { chromium } from 'playwright'
import fs from 'node:fs/promises'
/** Hybrid satellite + terrain relief capture. READ ONLY (non-GET /api aborted). */
const OUT = 'artifacts/map-lens'
await fs.mkdir(OUT, { recursive: true })
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
await ctx.addInitScript(() => { localStorage.setItem('nexus.map.mobileLens', JSON.stringify({ lens: 'radar', labels: true, relief: false, market: false })) })
const page = await ctx.newPage()
await page.route('**/api/**', (r) => (['GET', 'OPTIONS'].includes(r.request().method()) ? r.continue() : r.abort()))
const errs = []; page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)))
await page.goto('http://localhost:5173/map', { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => Boolean(window.__nxMap), undefined, { timeout: 90000 })
await page.waitForTimeout(4000)
const openTab = async (label) => { await page.locator('[data-map-control="layers"]').tap(); await page.waitForTimeout(500); await page.locator('.mx-seg__tab', { hasText: label }).tap(); await page.waitForTimeout(300) }
const close = async () => { await page.locator('[data-map-sheet-close]').first().tap(); await page.waitForTimeout(400) }
await openTab('Appearance')
await page.locator('[data-theme-id="satellite"]').tap(); await page.waitForTimeout(2500)
await page.screenshot({ path: `${OUT}/imagery-appearance.png` })
await close()
await page.evaluate(() => window.__nxMap.jumpTo({ center: [-95.398, 29.748], zoom: 15.5 }))
await page.waitForTimeout(6000)
const layers = await page.evaluate(() => window.__nxMap.getStyle().layers.map((l) => l.id).filter((id) => /nx-|satellite/.test(id)))
await page.screenshot({ path: `${OUT}/imagery-hybrid-z15.png` })
await openTab('Appearance')
await page.locator('[role="switch"]', { hasText: 'Terrain relief' }).tap()
await page.locator('.mx-seg__tab', { hasText: 'Tilted' }).tap(); await page.waitForTimeout(300)
await close()
await page.evaluate(() => window.__nxMap.jumpTo({ center: [-97.86, 30.36], zoom: 12.2, pitch: 62, bearing: -25 }))
await page.waitForTimeout(8000)
const terrain = await page.evaluate(() => ({ terrain: window.__nxMap.getTerrain(), pitch: window.__nxMap.getPitch() }))
await page.screenshot({ path: `${OUT}/imagery-relief-3d.png` })
console.log(JSON.stringify({ layers, terrain, errs }))
await browser.close()
