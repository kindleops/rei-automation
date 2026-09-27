import { chromium } from 'playwright'
/** Global shell audit: the top bar on every app + launcher + overflow + dock. Read-only. */
const OUT = 'artifacts/shell-v2'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const page = await ctx.newPage()
await page.route('**/api/**', (r) => (['GET', 'OPTIONS'].includes(r.request().method()) ? r.continue() : r.abort()))
const report = {}
for (const path of ['/home', '/inbox', '/map', '/entity-graph', '/campaigns', '/queue', '/pipeline', '/analytics', '/buyer-match', '/calendar']) {
  await page.goto('http://localhost:5173' + path, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(6000)
  const bar = await page.evaluate(() => {
    const els = [...document.querySelectorAll('header, [class*="command-dock"], [class*="mobile-dock"], [class*="top-bar"], [class*="topbar"]')]
      .filter((e) => { const r = e.getBoundingClientRect(); return r.top < 140 && r.height > 30 && r.width > 300 })
    const el = els[0]
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { cls: String(el.className).slice(0, 90), top: Math.round(r.top), h: Math.round(r.height), buttons: [...el.querySelectorAll('button, a')].map((b) => (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 24)).filter(Boolean) }
  })
  report[path] = bar
  await page.screenshot({ path: `${OUT}/top-${path.slice(1)}.png`, clip: { x: 0, y: 0, width: 390, height: 260 } })
}
// Launcher + overflow + notifications from Map and Inbox
for (const path of ['/map', '/inbox']) {
  await page.goto('http://localhost:5173' + path, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(5000)
  await page.locator('.nx-mobile-command-dock__btn--workspace').first().tap(); await page.waitForTimeout(1600)
  await page.screenshot({ path: `${OUT}/open-launcher-${path.slice(1)}.png` })
  await page.keyboard.press('Escape'); await page.waitForTimeout(600)
}
await page.locator('button[aria-label^="More controls"]').first().tap(); await page.waitForTimeout(1400)
await page.screenshot({ path: `${OUT}/open-overflow.png` })
report.handle = await page.evaluate(() => { const h = document.querySelector('.nx-mobile-bottom-sheet__handle'); if (!h) return null; const r = h.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) } })
console.log(JSON.stringify(report, null, 1))
await browser.close()
