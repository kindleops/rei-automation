import { chromium } from 'playwright'
/** KPI pulse dropdown: open, hold a metric to pin it, verify the bar readout. Read-only. */
const OUT = 'artifacts/shell-v2'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const page = await ctx.newPage()
await page.route('**/api/**', (r) => (['GET', 'OPTIONS'].includes(r.request().method()) ? r.continue() : r.abort()))
const R = {}
await page.goto('http://localhost:5173/map', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(9000)
R.readoutBefore = await page.locator('.nx-kpi-orb__readout').textContent().catch(() => null)
await page.screenshot({ path: `${OUT}/pulse-0-bar.png`, clip: { x: 0, y: 0, width: 390, height: 120 } })
await page.locator('.nx-mobile-command-dock__slot--kpi [role="button"]').first().tap()
await page.waitForSelector('.nx-pulse-drop .nx-pulse-card', { timeout: 30000 }).catch(() => {})
await page.waitForTimeout(1500)
R.dropRect = await page.evaluate(() => { const r = document.querySelector('.nx-pulse-drop')?.getBoundingClientRect(); return r && { top: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width) } })
await page.screenshot({ path: `${OUT}/pulse-1-drop.png` })
// Hold "Delivered" to pin it.
const card = page.locator('.nx-pulse-card', { hasText: 'Delivered' }).first()
const box = await card.boundingBox()
if (box) {
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down(); await page.waitForTimeout(650); await page.mouse.up()
}
await page.waitForTimeout(900)
R.pinned = await page.locator('.nx-pulse-card.is-pinned').count()
R.toast = await page.locator('.nx-pulse-toast').textContent().catch(() => null)
await page.screenshot({ path: `${OUT}/pulse-2-pinned.png` })
await page.mouse.click(200, 800); await page.waitForTimeout(900)
R.closed = await page.locator('.nx-pulse-drop').count()
R.readoutAfter = await page.locator('.nx-kpi-orb__readout').textContent().catch(() => null)
await page.screenshot({ path: `${OUT}/pulse-3-bar-pinned.png`, clip: { x: 0, y: 0, width: 390, height: 120 } })
await page.evaluate(() => localStorage.removeItem('nexus.kpiPin'))
console.log(JSON.stringify(R, null, 1))
await browser.close()
