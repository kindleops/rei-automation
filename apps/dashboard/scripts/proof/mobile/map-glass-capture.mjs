import { chromium } from 'playwright'
import fs from 'node:fs/promises'
/** Liquid glass presets on the Map. READ ONLY (non-GET /api aborted). */
const OUT = 'artifacts/map-lens'
await fs.mkdir(OUT, { recursive: true })
const THEME = process.argv.find((a) => a.startsWith('--theme='))?.slice(8) ?? 'dark'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
await ctx.addInitScript((t) => {
  const cur = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
  localStorage.setItem('nexus-settings', JSON.stringify({ ...cur, nexusTheme: t }))
  localStorage.setItem('nexus.map.mobileLens', JSON.stringify({ lens: 'census_income', market: true }))
}, THEME)
const page = await ctx.newPage()
await page.route('**/api/**', (r) => (['GET', 'OPTIONS'].includes(r.request().method()) ? r.continue() : r.abort()))
const errs = []; page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)))
await page.goto('http://localhost:5173/map', { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => Boolean(window.__nxMap), undefined, { timeout: 90000 })
await page.waitForTimeout(3000)
await page.evaluate(() => window.__nxMap.jumpTo({ center: [-95.40, 29.74], zoom: 10.5 }))
await page.waitForTimeout(5000)
await page.locator('[data-map-control="layers"]').tap(); await page.waitForTimeout(500)
await page.locator('.mx-seg__tab', { hasText: 'Appearance' }).tap(); await page.waitForTimeout(400)
await page.screenshot({ path: `${OUT}/glass-${THEME}-picker.png` })
const report = {}
for (const p of ['clear', 'frosted', 'crystal', 'smoke']) {
  await page.locator(`[data-glass-preset="${p}"]`).tap(); await page.waitForTimeout(300)
  report[p] = await page.evaluate(() => ({ attr: document.documentElement.getAttribute('data-liquid-glass'), blur: getComputedStyle(document.documentElement).getPropertyValue('--nx-glass-blur').trim(), mx: getComputedStyle(document.querySelector('.mx')).getPropertyValue('--mx-glass').trim() }))
  await page.locator('[data-map-sheet-close]').first().tap(); await page.waitForTimeout(700)
  await page.screenshot({ path: `${OUT}/glass-${THEME}-${p}.png` })
  await page.locator('[data-map-control="layers"]').tap(); await page.waitForTimeout(500)
  await page.locator('.mx-seg__tab', { hasText: 'Appearance' }).tap(); await page.waitForTimeout(300)
}
await page.locator('[data-glass-preset="theme"]').tap()
console.log(JSON.stringify({ report, errs }, null, 1))
await browser.close()
