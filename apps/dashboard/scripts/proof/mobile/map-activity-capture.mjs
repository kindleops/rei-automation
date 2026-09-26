import { chromium } from 'playwright'
import fs from 'node:fs/promises'
/** Live Activity: realtime feed + real touch scroll. READ ONLY (non-GET /api aborted). */
const OUT = 'artifacts/map-lens'
await fs.mkdir(OUT, { recursive: true })
const THEME = process.argv.find((a) => a.startsWith('--theme='))?.slice(8) ?? 'dark'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
await ctx.addInitScript((t) => {
  const cur = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
  localStorage.setItem('nexus-settings', JSON.stringify({ ...cur, nexusTheme: t }))
  localStorage.setItem('nexus.map.mobileActivity', JSON.stringify({ on: true, scope: 'all', window: 'all' }))
}, THEME)
const page = await ctx.newPage()
let writes = 0
await page.route('**/api/**', (r) => (['GET', 'OPTIONS'].includes(r.request().method()) ? r.continue() : (writes++, r.abort())))
const errs = []; page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)))
await page.goto('http://localhost:5173/map', { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => Boolean(window.__nxMap), undefined, { timeout: 90000 })
await page.waitForTimeout(7000)
await page.screenshot({ path: `${OUT}/activity-${THEME}-peek.png` })
await page.locator('[data-map-control="activity-feed"]').tap(); await page.waitForTimeout(1500)
await page.screenshot({ path: `${OUT}/activity-${THEME}-sheet.png` })
const body = page.locator('.mx-sheet__body')
const before = await body.evaluate((el) => ({ top: el.scrollTop, sh: el.scrollHeight, ch: el.clientHeight }))
const box = await body.boundingBox()
const cdp = await ctx.newCDPSession(page)
const x = box.x + box.width / 2
const y0 = box.y + box.height - 40
const touch = (type, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] })
await touch('touchStart', y0)
for (let i = 1; i <= 12; i++) { await touch('touchMove', y0 - i * 30); await page.waitForTimeout(16) }
await touch('touchEnd', y0 - 360)
await page.waitForTimeout(900)
const after = await body.evaluate((el) => el.scrollTop)
await page.screenshot({ path: `${OUT}/activity-${THEME}-scrolled.png` })
const rows = await page.locator('[data-activity-row]').count()
const live = await page.locator('.mx-streaming').count()
const titles = await page.locator('.mx-feedrow strong').allTextContents()
console.log(JSON.stringify({ before, after, rows, live, titles: titles.slice(0, 8), writes, errs }))
await browser.close()
