import { chromium } from 'playwright'
/**
 * Comps Intelligence proof — subject hero, evidence map, readout, set toggle +
 * reset, excluded view, strips, inspector, search-area sheet, overflow and
 * touch-target audit. Read-only: every non-GET /api request is aborted.
 */
const OUT = 'artifacts/comps'
const THEME = process.argv.find((a) => a.startsWith('--theme='))?.slice(8) ?? 'dark'
const W = Number(process.argv.find((a) => a.startsWith('--w='))?.slice(4) ?? 390)
const PID = process.argv.find((a) => a.startsWith('--pid='))?.slice(6) ?? '225438557'
const QUICK = process.argv.includes('--quick')
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: W, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
await ctx.addInitScript((t) => { const cur = JSON.parse(localStorage.getItem('nexus-settings') || '{}'); localStorage.setItem('nexus-settings', JSON.stringify({ ...cur, nexusTheme: t })) }, THEME)
const page = await ctx.newPage()
const errors = []
const blocked = []
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
await page.route('**/api/**', (r) => { const m = r.request().method(); if (['GET', 'OPTIONS'].includes(m)) return r.continue(); blocked.push(`${m} ${new URL(r.request().url()).pathname}`); return r.abort() })
const tag = `${THEME}-${W}-${PID}`
const shot = async (name) => { await page.screenshot({ path: `${OUT}/${tag}-${name}.png` }); console.log('shot', name) }
const overflow = () => page.evaluate(() => {
  const root = document.querySelector('.cev')
  if (!root) return null
  const bad = [...root.querySelectorAll('*')].filter((el) => { if (el.closest('.cev-rail, .cev-chipbar, .cev-sortbar__opts, .cev-map')) return false; const b = el.getBoundingClientRect(); return b.width > 0 && (b.right > window.innerWidth + 1 || b.left < -1) }).slice(0, 5).map((el) => `${el.className}`.slice(0, 50))
  return { doc: document.documentElement.scrollWidth - window.innerWidth, offenders: bad }
})
const small = () => page.evaluate(() => [...document.querySelectorAll('.cev button, .cev-sheet button')].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 32 && !b.classList.contains('cev-dot') }).map((b) => `${b.className}:${Math.round(b.getBoundingClientRect().height)}`).slice(0, 8))
const to = (sel) => page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: 'start' }), sel)

await page.goto(`http://localhost:5173/comp-intelligence?property_id=${PID}`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector(".cev-subject", { timeout: 240000 }).catch(() => {})
await page.waitForTimeout(3500)
await page.evaluate(() => document.querySelector('.cev-subject')?.scrollIntoView({ block: 'center' })); await page.waitForTimeout(700); await shot('01-subject')
// The PWA gives the document no scroll: .cev must own it, and a real wheel/drag must move it.
const scroll = await (async () => {
  const before = await page.evaluate(() => { const r = document.querySelector('.cev'); if (!r) return null; r.scrollTop = 0; return { sh: r.scrollHeight, ch: r.clientHeight, oy: getComputedStyle(r).overflowY } })
  await page.mouse.move(W / 2, 500); await page.mouse.wheel(0, 900); await page.waitForTimeout(700)
  const after = await page.evaluate(() => document.querySelector('.cev')?.scrollTop ?? 0)
  await page.evaluate(() => { const r = document.querySelector('.cev'); if (r) r.scrollTop = 0 })
  return before && { ...before, wheelTop: after, owns: before.sh > before.ch && after > 0 }
})()
const R = { scroll, cards: await page.locator('.cev-card').count(), tabs: await page.locator('.cev-views__tab').allInnerTexts(), overflow: await overflow() }
await to('.cev-readout'); await page.waitForTimeout(600); await shot('02-readout')
await to('.cev-mapwrap'); await page.waitForTimeout(1800); await shot('03-map')
await page.locator('.cev-map__recenter').evaluate((e) => e.click()).catch(() => {}); await page.waitForTimeout(3500); await page.evaluate(() => document.querySelector('.cev-mapwrap')?.scrollIntoView({ block: 'center' })); await shot('03b-map-3d')
await to('.cev-views'); await page.waitForTimeout(600); await shot('04-gallery')
if (!QUICK) {
  R.setBefore = await page.locator('.cev-setpill b').innerText().catch(() => null)
  await page.locator('.cev-card__toggle').first().evaluate((e) => e.click()); await page.waitForTimeout(900)
  R.setAfter = await page.locator('.cev-setpill b').innerText().catch(() => null)
  R.medianAfter = await page.locator('.cev-readout__hero strong').innerText().catch(() => null)
  await to('.cev-readout'); await page.waitForTimeout(700); await shot('05-your-set')
  await page.locator('.cev-reset').evaluate((e) => e.click()).catch(() => {}); await page.waitForTimeout(700)
  R.setReset = await page.locator('.cev-setpill b').innerText().catch(() => null)
  await page.locator('.cev-views__tab', { hasText: 'Excluded' }).evaluate((e) => e.click()); await page.waitForTimeout(800)
  await to('.cev-views'); await page.waitForTimeout(500); await shot('06-excluded')
  await to('.cev-strip'); await page.waitForTimeout(700); await shot('07-strips')
  await page.locator('.cev-market, .cev-sources').first().evaluate((e) => e.scrollIntoView({ block: 'end' })); await page.waitForTimeout(600); await shot('08-bottom')
  await page.locator('.cev-views__tab', { hasText: 'Your set' }).evaluate((e) => e.click()); await page.waitForTimeout(600)
  await page.locator('.cev-card__open').first().evaluate((e) => e.click()); await page.waitForTimeout(1100); await shot('09-inspector')
  R.inspector = await page.locator('.cev-sheet.is-inspector').count()
  await page.evaluate(() => document.querySelector('.cev-sheet__panel')?.scrollTo(0, 2000)); await page.waitForTimeout(500); await shot('10-inspector-2')
  await page.locator('.cev-x').evaluate((e) => e.click()); await page.waitForTimeout(500)
  await page.locator('.cev-mapbar .cev-chip').nth(1).evaluate((e) => e.click()); await page.waitForTimeout(800); await shot('11-area-sheet')
  await page.keyboard.press('Escape'); await page.waitForTimeout(400)
  await to('.cev-subject'); await page.waitForTimeout(300)
  await page.locator('.cev-lookbtn').evaluate((e) => e.click()).catch(() => {}); await page.waitForTimeout(6000); await shot('12-look')
  R.look = await page.locator('.cev-look').count()
  R.small = await small()
}
await browser.close().catch(() => {})
console.log(JSON.stringify({ ...R, blocked, errors: errors.slice(0, 6) }))
