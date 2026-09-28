import { chromium } from 'playwright'
/**
 * Analytics proof — hero, story, changes, geography (volume / change / surface
 * / states, inspector, full screen), trend, flow + cohort, campaigns, deals,
 * operations. Read-only: every non-GET /api request is aborted. Scrolls the
 * surface's own container (the installed PWA gives the document no scroll).
 */
const OUT = 'artifacts/analytics'
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const THEME = arg('theme', 'dark')
const W = Number(arg('w', 390))
const RANGE = arg('range', '30d')
const QUICK = process.argv.includes('--quick')
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: W, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
await ctx.addInitScript(([t, r]) => { const cur = JSON.parse(localStorage.getItem('nexus-settings') || '{}'); localStorage.setItem('nexus-settings', JSON.stringify({ ...cur, nexusTheme: t })); localStorage.setItem('anx:range:v1', r) }, [THEME, RANGE])
const page = await ctx.newPage()
const errors = []
const blocked = []
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
await page.route('**/api/**', (r) => { const m = r.request().method(); if (['GET', 'OPTIONS'].includes(m)) return r.continue(); blocked.push(`${m} ${new URL(r.request().url()).pathname}`); return r.abort() })
const tag = `${THEME}-${W}-${RANGE}`
const shot = async (name) => { await page.screenshot({ path: `${OUT}/${tag}-${name}.png` }); console.log('shot', name) }
const to = (sel, off = 70) => page.evaluate(([s, o]) => { const el = document.querySelector(s); const sc = document.querySelector('.anx'); if (el && sc) sc.scrollBy(0, el.getBoundingClientRect().top - o) }, [sel, off])
const click = (sel) => page.locator(sel).first().evaluate((e) => e.click()).catch(() => {})
const audit = () => page.evaluate(() => {
  const root = document.querySelector('.anx')
  if (!root) return null
  const bad = [...root.querySelectorAll('*')].filter((el) => { if (el.closest('.anx-metricbar, .anx-tabs, .anx-geo__canvas')) return false; const b = el.getBoundingClientRect(); return b.width > 0 && (b.right > innerWidth + 1 || b.left < -1) }).slice(0, 5).map((el) => `${el.className}`.slice(0, 40))
  const small = [...document.querySelectorAll('.anx button, .anx-sheet button')].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 30 }).map((b) => `${b.className}:${Math.round(b.getBoundingClientRect().height)}`).slice(0, 6)
  return { doc: document.documentElement.scrollWidth - innerWidth, offenders: bad, small, scroll: root.scrollHeight > root.clientHeight }
})

await page.goto('http://localhost:5173/analytics', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.anx-hero, .anx-empty', { timeout: 240000 }).catch(() => {})
await page.waitForTimeout(2500)
await shot('01-top')
const R = { hero: await page.locator('.anx-hero__primary strong').innerText().catch(() => null), changes: await page.locator('.anx-changes li').count(), audit: await audit() }
await to('.anx-story'); await page.waitForTimeout(700); await shot('02-story')
await to('.anx-geo', 64); await page.waitForTimeout(2600); await shot('03-geo')
if (!QUICK) {
  await page.locator('.anx-seg button', { hasText: 'Change' }).first().evaluate((e) => e.click()).catch(() => {}); await page.waitForTimeout(1600); await shot('04-geo-change')
  await page.locator('.anx-seg button', { hasText: 'States' }).first().evaluate((e) => e.click()).catch(() => {}); await page.waitForTimeout(1400); await shot('05-geo-states')
  await page.locator('.anx-seg button', { hasText: 'Volume' }).first().evaluate((e) => e.click()).catch(() => {})
  await page.locator('.anx-seg button', { hasText: 'Surface' }).first().evaluate((e) => e.click()).catch(() => {})
  await page.locator('.anx-pill.is-gold').first().evaluate((e) => e.click()).catch(() => {}); await page.waitForTimeout(1600); await shot('06-geo-surface')
  await click('.anx-rank button'); await page.waitForTimeout(2200); await shot('07-inspector')
  R.inspector = await page.locator('.anx-sheet h3').innerText().catch(() => null)
  await click('.anx-sheet .anx-x'); await page.waitForTimeout(1200); await shot('08-geo-market')
  await click('.anx-round[aria-label="Full screen"]'); await page.waitForTimeout(1600); await shot('09-fullscreen')
  await click('.anx-round[aria-label="Exit full screen"]'); await page.waitForTimeout(800)
  await to('.anx-trend'); await page.waitForTimeout(900); await shot('10-trend')
  await to('.anx-flow'); await page.waitForTimeout(900); await shot('11-flow')
  await click('.anx-bottleneck'); await page.waitForTimeout(900); await shot('12-cohort')
  R.cohort = await page.locator('.anx-cohort li').count()
  await click('.anx-sheet .anx-x'); await page.waitForTimeout(500)
  await to('.anx-campaigns'); await page.waitForTimeout(800); await shot('13-campaigns')
  await to('.anx-down'); await page.waitForTimeout(700); await shot('14-deals')
  await to('.anx-ops'); await page.waitForTimeout(800); await shot('15-ops')
  await page.evaluate(() => { const sc = document.querySelector('.anx'); sc.scrollTop = sc.scrollHeight }); await page.waitForTimeout(700); await shot('16-bottom')
  R.auditEnd = await audit()
}
R.blocked = blocked
R.errors = errors
console.log(JSON.stringify(R))
await browser.close()
