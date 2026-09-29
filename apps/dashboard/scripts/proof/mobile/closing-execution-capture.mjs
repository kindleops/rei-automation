import { chromium } from 'playwright'
/**
 * Closing Desk (mobile execution surface) proof. Demo scenarios (?demo=1 — the
 * real derivation over raw scenario rows) for the populated states, plus the
 * LIVE empty state. Overflow / tap-size / scroll-owner audit. Read-only: every
 * non-GET /api request is aborted.
 *   node scripts/proof/mobile/closing-execution-capture.mjs --theme=dark --w=390
 */
const OUT = 'artifacts/closing'
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const THEME = arg('theme', 'dark')
const W = Number(arg('w', 390))
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
const audit = (root) => page.evaluate((rootSel) => {
  const root = document.querySelector(rootSel)
  if (!root) return null
  const bad = [...root.querySelectorAll('*')].filter((el) => { if (el.closest('.cd2-chips')) return false; const b = el.getBoundingClientRect(); return b.width > 0 && (b.right > innerWidth + 1 || b.left < -1) }).slice(0, 5).map((el) => `${el.className}`.slice(0, 40))
  const small = [...root.querySelectorAll('button')].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 34 }).map((b) => `${b.className}:${Math.round(b.getBoundingClientRect().height)}`).slice(0, 6)
  return { doc: document.documentElement.scrollWidth - innerWidth, offenders: bad, small }
}, root)

const R = {}
await page.goto('http://localhost:5173/closing-desk?demo=1', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.cd2-next, .cd2-state', { timeout: 240000 }).catch(() => {})
await page.waitForTimeout(1500)
await shot('01-portfolio')
R.head = await page.locator('.cd2-head').innerText().catch(() => null)
R.cards = await page.locator('.cd2-card').count()
R.audit = await audit('.cd2')
if (!QUICK) {
  const before = await page.evaluate(() => document.querySelector('.cd2')?.scrollTop ?? -1)
  await page.mouse.move(W / 2, 600); await page.mouse.wheel(0, 900); await page.waitForTimeout(600)
  R.scroll = { before, after: await page.evaluate(() => document.querySelector('.cd2')?.scrollTop ?? -1) }
  await shot('02-portfolio-scrolled')
  // ready to close — tomorrow
  await page.evaluate(() => document.querySelector('.cd2')?.scrollTo(0, 0))
  await click('.cd2-next'); await page.waitForSelector('.cd2-room .cd2-hero', { timeout: 20000 }).catch(() => {}); await page.waitForTimeout(900)
  await shot('03-room-ready'); R.roomReady = await page.locator('.cd2-hero').innerText().catch(() => null); R.roomAudit = await audit('.cd2-room')
  await page.evaluate(() => document.querySelector('.cd2-room__scroll')?.scrollTo(0, 700)); await page.waitForTimeout(400); await shot('04-room-ready-rail')
  await click('.cd2-room__bar .cd2-icon'); await page.waitForTimeout(500)
  // blocked closing tomorrow
  await page.evaluate(() => { const c = [...document.querySelectorAll('.cd2-card')].find((x) => x.textContent.includes('3847 Bloomington')); c?.click() }); await page.waitForTimeout(1100)
  await shot('05-room-blocked')
  await page.evaluate(() => { const s = [...document.querySelectorAll('.cd2-sec__head')].find((x) => x.textContent.includes('Documents')); s?.click() }); await page.waitForTimeout(300)
  await page.evaluate(() => { const s = [...document.querySelectorAll('.cd2-sec__head')].find((x) => x.textContent.includes('Earnest')); s?.click() }); await page.waitForTimeout(300)
  await page.evaluate(() => { const r = document.querySelector('.cd2-room__scroll'); r?.scrollTo(0, r.scrollHeight) }); await page.waitForTimeout(400); await shot('06-room-blocked-docs')
  await click('.cd2-doc.is-bad'); await page.waitForTimeout(700); await shot('07-doc-sheet'); await click('.cd2-sheet__scrim'); await page.waitForTimeout(300)
  await click('.cd2-room__bar .cd2-icon'); await page.waitForTimeout(500)
  // closed
  await page.evaluate(() => { const c = [...document.querySelectorAll('.cd2-card')].find((x) => x.textContent.includes('5021 34th')); c?.click() }); await page.waitForTimeout(1100)
  await shot('08-room-closed'); await page.evaluate(() => document.querySelector('.cd2-room__scroll')?.scrollTo(0, 560)); await page.waitForTimeout(400); await shot('09-room-closed-settlement')
  R.closedAudit = await audit('.cd2-room')
  await click('.cd2-room__bar .cd2-icon'); await page.waitForTimeout(500)
  // live (no demo): production is empty
  await page.goto('http://localhost:5173/closing-desk', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.cd2-state, .cd2-next, .cd2-card', { timeout: 120000 }).catch(() => {})
  await page.waitForTimeout(1500); await shot('10-live')
  R.live = await page.locator('.cd2').innerText().catch(() => null)
}
console.log(JSON.stringify({ ...R, blocked, errors: errors.slice(0, 6) }))
await browser.close()
