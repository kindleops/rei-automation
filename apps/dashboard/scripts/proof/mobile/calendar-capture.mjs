import { chromium } from 'playwright'
/**
 * Calendar proof — today, a real campaign day (timeline, window, NOW), event
 * sheet, week, month, attention + group sheet; overflow / tap-size audit and a
 * real wheel scroll of the surface's own container. Read-only: every non-GET
 * /api request is aborted.
 */
const OUT = 'artifacts/calendar'
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const THEME = arg('theme', 'dark')
const W = Number(arg('w', 390))
const DAY = arg('day', '2026-09-29')
const QUICK = process.argv.includes('--quick')
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: W, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId: 'America/Chicago' })
await ctx.addInitScript((t) => { const cur = JSON.parse(localStorage.getItem('nexus-settings') || '{}'); localStorage.setItem('nexus-settings', JSON.stringify({ ...cur, nexusTheme: t })) }, THEME)
const page = await ctx.newPage()
const errors = []
const blocked = []
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
await page.route('**/api/**', (r) => { const m = r.request().method(); if (['GET', 'OPTIONS'].includes(m)) return r.continue(); blocked.push(`${m} ${new URL(r.request().url()).pathname}`); return r.abort() })
const tag = `${THEME}-${W}`
const shot = async (name) => { await page.screenshot({ path: `${OUT}/${tag}-${name}.png` }); console.log('shot', name) }
const click = (sel) => page.locator(sel).first().evaluate((e) => e.click()).catch(() => {})
const audit = () => page.evaluate(() => {
  const root = document.querySelector('.cal2')
  if (!root) return null
  const bad = [...root.querySelectorAll('*')].filter((el) => { if (el.closest('.cal2-strip, .cal2-chips')) return false; const b = el.getBoundingClientRect(); return b.width > 0 && (b.right > innerWidth + 1 || b.left < -1) }).slice(0, 5).map((el) => `${el.className}`.slice(0, 40))
  const small = [...document.querySelectorAll('.cal2 button, .cal2-sheet button')].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 34 }).map((b) => `${b.className}:${Math.round(b.getBoundingClientRect().height)}`).slice(0, 6)
  return { doc: document.documentElement.scrollWidth - innerWidth, offenders: bad, small }
})

await page.goto('http://localhost:5173/calendar', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.cal2-hero h1', { timeout: 240000 }).catch(() => {})
await page.waitForSelector('.cal2-summary:not(.is-skel)', { timeout: 60000 }).catch(() => {})
await page.waitForTimeout(1800)
await shot('01-today')
const R = { greeting: await page.locator('.cal2-hero h1').innerText().catch(() => null), summary: await page.locator('.cal2-summary').innerText().catch(() => null), audit: await audit() }
await click(`.cal2-strip__day:nth-child(${[...Array(14)].length ? 4 : 4})`)
await page.evaluate((d) => { const b = [...document.querySelectorAll('.cal2-strip__day')].find((x) => x.getAttribute('aria-selected') !== null && x.textContent.includes(String(Number(d.slice(8))))); b?.click() }, DAY)
await page.waitForTimeout(900)
await shot('02-campaign-day')
R.dayItems = await page.locator('.cal2-rail .cal2-card, .cal2-band > *').count()
R.window = await page.locator('.cal2-window__time').first().innerText().catch(() => null)
R.url = page.url().replace(/^https?:\/\/[^/]+/, '')
if (!QUICK) {
  await click('.cal2-window'); await page.waitForTimeout(800); await shot('03-window-sheet')
  R.sheetRows = await page.locator('.cal2-sheet__rows').innerText().catch(() => null)
  await click('.cal2-sheet__scrim'); await page.waitForTimeout(400)
  await click('.cal2-rail .cal2-card'); await page.waitForTimeout(800); await shot('04-sends-sheet')
  await click('.cal2-sheet__scrim'); await page.waitForTimeout(400)
  await click('.cal2-views__tab:nth-child(2)'); await page.waitForTimeout(700); await shot('05-week')
  await click('.cal2-views__tab:nth-child(3)'); await page.waitForTimeout(1500); await shot('06-month')
  await click('.cal2-views__tab:nth-child(4)'); await page.waitForTimeout(900); await shot('07-attention')
  R.attnGroups = await page.locator('.cal2-attn__group h4').allInnerTexts()
  await click('.cal2-attn .cal2-card'); await page.waitForTimeout(800); await shot('08-attn-sheet')
  await click('.cal2-sheet__scrim'); await page.waitForTimeout(300)
  const grp = page.locator('.cal2-attn .cal2-card', { hasText: 'messages failed' }).first()
  if (await grp.count()) { await grp.evaluate((e) => e.click()); await page.waitForTimeout(800); await shot('09-group-sheet'); await click('.cal2-sheet__scrim') }
  // real wheel on the surface's own container
  const before = await page.evaluate(() => document.querySelector('.cal2')?.scrollTop ?? -1)
  await page.mouse.move(W / 2, 600); await page.mouse.wheel(0, 700); await page.waitForTimeout(600)
  R.scroll = { before, after: await page.evaluate(() => document.querySelector('.cal2')?.scrollTop ?? -1), sh: await page.evaluate(() => { const r = document.querySelector('.cal2'); return r ? [r.scrollHeight, r.clientHeight] : null }) }
  await shot('10-attention-scrolled')
  R.audit2 = await audit()
}
console.log(JSON.stringify({ ...R, blocked, errors: errors.slice(0, 6) }))
await browser.close()
