import { chromium } from 'playwright'
/** Notification dropdown proof. Read-only: non-GET /api aborted (no mark-read/dismiss writes). */
const OUT = 'artifacts/shell-v2'
const THEME = process.argv.find((a) => a.startsWith('--theme='))?.slice(8) ?? 'dark'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
await ctx.addInitScript((t) => { const cur = JSON.parse(localStorage.getItem('nexus-settings') || '{}'); localStorage.setItem('nexus-settings', JSON.stringify({ ...cur, nexusTheme: t })) }, THEME)
const page = await ctx.newPage()
await page.route('**/api/**', (r) => (['GET', 'OPTIONS'].includes(r.request().method()) ? r.continue() : r.abort()))
await page.goto('http://localhost:5173/map', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(8000)
await page.locator('button[aria-label="Notifications"]').first().tap(); await page.waitForTimeout(3500)
await page.screenshot({ path: `${OUT}/notif-${THEME}-1.png` })
const R = { rows: await page.locator('[data-notif-id], .nx-mnc__row').count(), panel: await page.evaluate(() => { const el = document.querySelector('.nx-ntf, .nx-mnc'); if (!el) return null; const r = el.getBoundingClientRect(); return { cls: el.className, top: Math.round(r.top), h: Math.round(r.height) } }) }
const body = page.locator('.nx-ntf__body, .nx-mnc__body').first()
if (await body.count()) { await body.evaluate((el) => { el.scrollTop = 700 }); await page.waitForTimeout(700); await page.screenshot({ path: `${OUT}/notif-${THEME}-2.png` }) }
console.log(JSON.stringify(R))
await browser.close()
