import { chromium } from 'playwright'
/**
 * Buyer Match proof — subject hero, match hero + orbit, buyer cards, market,
 * disposition rail, why-not, inspector tabs, compare, controls. Read-only:
 * every non-GET /api request is aborted.
 */
const OUT = 'artifacts/buyer-match'
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const THEME = arg('theme', 'dark')
const W = Number(arg('w', 390))
const PID = arg('pid', '24613730')
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
const center = (sel) => page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: 'center' }), sel)
const start = (sel) => page.evaluate((s) => { const el = document.querySelector(s); const sc = document.querySelector('.bmx'); if (el && sc) sc.scrollBy(0, el.getBoundingClientRect().top - 70) }, sel)
const overflow = () => page.evaluate(() => {
  const root = document.querySelector('.bmx')
  if (!root) return null
  const bad = [...root.querySelectorAll('*')].filter((el) => { if (el.closest('.bmx-views, .bmx-sorts, .bmx-subject__photo, .bmx-orbit, .bmx-hero__glow')) return false; const b = el.getBoundingClientRect(); return b.width > 0 && (b.right > window.innerWidth + 1 || b.left < -1) }).slice(0, 5).map((el) => `${el.className}`.slice(0, 50))
  return { doc: document.documentElement.scrollWidth - window.innerWidth, offenders: bad }
})
const small = () => page.evaluate(() => [...document.querySelectorAll('.bmx button, .bmx-sheet button')].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 32 && !b.closest('.bmx-orbit') }).map((b) => `${b.className}:${Math.round(b.getBoundingClientRect().height)}`).slice(0, 8))

await page.goto(`http://localhost:5173/buyer-match?property_id=${PID}`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.bmx-subject, .bmx-empty', { timeout: 240000 }).catch(() => {})
await page.waitForTimeout(2500)
await center('.bmx-subject'); await page.waitForTimeout(500); await shot('01-subject')
await center('.bmx-hero'); await page.waitForTimeout(1600); await shot('02-hero')
const R = {
  cards: await page.locator('.bmx-card').count(),
  names: await page.locator('.bmx-card__id h3').allInnerTexts().then((x) => x.slice(0, 8)),
  tiers: await page.locator('.bmx-tiers b').allInnerTexts(),
  overflow: await overflow(),
}
await start('.bmx-views'); await page.waitForTimeout(700); await shot('03-cards')
if (!QUICK) {
  await page.evaluate(() => document.querySelector('.bmx')?.scrollBy(0, 640)); await page.waitForTimeout(500); await shot('04-cards-2')
  await center('.bmx-market'); await page.waitForTimeout(700); await shot('05-market')
  await center('.bmx-rail'); await page.waitForTimeout(600); await shot('06-rail')
  await center('.bmx-whynot'); await page.waitForTimeout(500); await shot('07-whynot')
  const first = page.locator('.bmx-card__open').first()
  if (await first.count()) {
    await first.evaluate((e) => e.click()); await page.waitForTimeout(2500); await shot('08-insp-why')
    await page.evaluate(() => document.querySelector('.bmx-sheet__panel')?.scrollTo(0, 700)); await page.waitForTimeout(500); await shot('09-insp-why-2')
    for (const [i, name] of [[1, '10-insp-box'], [2, '11-insp-activity'], [3, '12-insp-portfolio'], [4, '13-insp-geo'], [5, '14-insp-entity']]) {
      await page.locator('.bmx-tabs button').nth(i).evaluate((e) => e.click()); await page.evaluate(() => document.querySelector('.bmx-sheet__panel')?.scrollTo(0, 0)); await page.waitForTimeout(900); await shot(name)
    }
    R.inspector = await page.locator('.bmx-sheet.is-inspector').count()
    R.inspectorName = await page.locator('.bmx-insp__head h3').innerText().catch(() => null)
    await page.locator('.bmx-sheet .bmx-x').first().evaluate((e) => e.click()); await page.waitForTimeout(500)
    const cmp = page.locator('.bmx-card__foot .bmx-iconbtn[aria-label="Compare"]')
    if ((await cmp.count()) >= 2) {
      await cmp.nth(0).evaluate((e) => e.click()); await cmp.nth(1).evaluate((e) => e.click()); await page.waitForTimeout(500); await shot('15-dock')
      await page.locator('.bmx-dock .bmx-btn').evaluate((e) => e.click()); await page.waitForTimeout(900); await shot('16-compare')
      await page.locator('.bmx-sheet .bmx-x').first().evaluate((e) => e.click()); await page.waitForTimeout(400)
    }
  }
  await page.locator('.bmx-toolbar .bmx-chip').first().evaluate((e) => e.click()).catch(() => {}); await page.waitForTimeout(800); await shot('17-controls')
  R.small = await small()
}
R.blocked = blocked
R.errors = errors
console.log(JSON.stringify(R))
await browser.close()
