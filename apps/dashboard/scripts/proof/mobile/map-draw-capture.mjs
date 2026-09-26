import { chromium } from 'playwright'
import fs from 'node:fs/promises'
/**
 * Draw-an-area capture. READ ONLY: every non-GET /api call is aborted, and the
 * draft is never confirmed (only the confirm step is shown).
 */
const OUT = 'artifacts/map-lens'
await fs.mkdir(OUT, { recursive: true })
const SHAPE = process.argv.find((a) => a.startsWith('--shape='))?.slice(8) ?? 'lasso'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
await ctx.addInitScript(() => { localStorage.setItem('nexus.map.mobileLens', JSON.stringify({ lens: 'radar', market: false })) })
const page = await ctx.newPage()
let writes = 0
await page.route('**/api/**', (r) => (['GET', 'OPTIONS'].includes(r.request().method()) ? r.continue() : (writes++, r.abort())))
const errs = []; page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)))
await page.goto('http://localhost:5173/map', { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => Boolean(window.__nxMap), undefined, { timeout: 90000 })
await page.waitForTimeout(4000)
await page.evaluate(() => window.__nxMap.jumpTo({ center: [-95.40, 29.745], zoom: 13 }))
await page.waitForTimeout(6000)
await page.locator('[data-map-control="draw"]').tap(); await page.waitForTimeout(500)
if (SHAPE === 'circle') { await page.locator('.mx-draw-bar__mode', { hasText: 'Circle' }).tap(); await page.waitForTimeout(200) }
await page.screenshot({ path: `${OUT}/draw-${SHAPE}-ready.png` })
const cdp = await ctx.newCDPSession(page)
const t = (type, p) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: p ? [{ x: p.x, y: p.y }] : [] })
const cx = 195, cy = 420
if (SHAPE === 'circle') {
  await t('touchStart', { x: cx, y: cy })
  for (let i = 1; i <= 15; i++) { await t('touchMove', { x: cx + i * 8, y: cy + i * 3 }); await page.waitForTimeout(16) }
  await page.screenshot({ path: `${OUT}/draw-${SHAPE}-drawing.png` })
  await t('touchEnd')
} else {
  const pts = []
  for (let i = 0; i <= 48; i++) { const a = (i / 48) * Math.PI * 2; const r = 120 + 25 * Math.sin(a * 3); pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r * 1.2 }) }
  await t('touchStart', pts[0])
  for (const p of pts.slice(1, 36)) { await t('touchMove', p); await page.waitForTimeout(12) }
  await page.screenshot({ path: `${OUT}/draw-${SHAPE}-drawing.png` })
  for (const p of pts.slice(36)) { await t('touchMove', p); await page.waitForTimeout(12) }
  await t('touchEnd')
}
await page.waitForTimeout(3500)
await page.screenshot({ path: `${OUT}/draw-${SHAPE}-summary.png` })
const summary = await page.locator('.mx-area__hero').textContent().catch(() => null)
const draftBtn = page.locator('[data-area-action="draft"]')
if (await draftBtn.count()) { await draftBtn.tap(); await page.waitForTimeout(500); await page.screenshot({ path: `${OUT}/draw-${SHAPE}-confirm.png` }) }
await page.locator('[data-map-sheet-close]').first().tap().catch(() => {}); await page.waitForTimeout(800)
await page.screenshot({ path: `${OUT}/draw-${SHAPE}-held.png` })
console.log(JSON.stringify({ summary, writes, errs }))
await browser.close()
