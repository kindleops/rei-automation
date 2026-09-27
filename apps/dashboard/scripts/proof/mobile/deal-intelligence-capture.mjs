import { chromium } from 'playwright'
/**
 * Deal Intelligence decision surface proof — hero, spectrum, layers
 * (Decision / Evidence / Model), scenario lab move + reset, overflow and
 * touch-target audit. Read-only: every non-GET /api request is aborted, so
 * neither the engine re-run nor anything else can write.
 */
const OUT = 'artifacts/deal-intel'
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
  const root = document.querySelector('.ddx')
  if (!root) return null
  const r = root.getBoundingClientRect()
  const bad = [...root.querySelectorAll('*')].filter((el) => { const b = el.getBoundingClientRect(); return b.width > 0 && (b.right > window.innerWidth + 1 || b.left < -1) }).slice(0, 5).map((el) => `${el.className}`.slice(0, 60))
  return { docOverflow: document.documentElement.scrollWidth - window.innerWidth, rootWidth: Math.round(r.width), offenders: bad }
})
const scrollTo = (y) => page.evaluate((y) => {
  let el = document.querySelector('.ddx')
  while (el && el.parentElement) { el = el.parentElement; const s = getComputedStyle(el); if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight) { el.scrollTop = y; return el.scrollTop } }
  window.scrollTo(0, y); return window.scrollY
}, y)
const smallTargets = () => page.evaluate(() => [...document.querySelectorAll('.ddx button, .ddx input')].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 36 && !b.classList.contains('ddx-pin') }).map((b) => `${b.className}:${Math.round(b.getBoundingClientRect().height)}`).slice(0, 8))

const TK = process.argv.find((a) => a.startsWith("--tk="))?.slice(5); await page.goto(`http://localhost:5173/deal-intelligence?property_id=${PID}${TK ? `&thread_key=${encodeURIComponent(TK)}` : ""}`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.ddx-hero', { timeout: 90000 }).catch(() => {})
await page.waitForTimeout(2500)
await scrollTo(0)
const R = { hero: await page.locator('.ddx-hero').count(), pins: await page.locator('.ddx-pin').count(), risks: await page.locator('.ddx-risk').count(), overflow: await overflow() }
const heroTop = await page.evaluate(() => document.querySelector('.ddx-hero')?.getBoundingClientRect().top ?? null)
await page.evaluate(() => document.querySelector('.ddx-hero')?.scrollIntoView({ block: 'start' }))
await page.waitForTimeout(900)
await shot('01-hero')
await page.evaluate(() => document.querySelector('.ddx-verdict')?.scrollIntoView({ block: 'start' }))
await page.waitForTimeout(700); await shot('02-verdict')
await page.evaluate(() => document.querySelector('[data-dd-card="offer"]')?.scrollIntoView({ block: 'start' }))
await page.waitForTimeout(700); await shot('03-offer')
if (!QUICK) {
  await page.locator('.ddx-layers__tab', { hasText: 'Evidence' }).evaluate((e) => e.click()); await page.waitForTimeout(900)
  await page.evaluate(() => document.querySelector('.ddx-layers')?.scrollIntoView({ block: 'start' }))
  await page.waitForTimeout(600); await shot('04-evidence')
  R.evidenceOverflow = await overflow()
  // open collapsed evidence cards
  for (const id of ['debt', 'history', 'buyers', 'trend']) await page.locator(`[data-dd-card="${id}"] .ddx-card__head`).evaluate((e) => e.getAttribute('aria-expanded') === 'false' && e.click()).catch(() => {})
  await page.waitForTimeout(600)
  await page.evaluate(() => document.querySelector('[data-dd-card="facts"]')?.scrollIntoView({ block: 'start' }))
  await page.waitForTimeout(600); await shot('05-facts')
  await page.evaluate(() => document.querySelector('[data-dd-card="debt"]')?.scrollIntoView({ block: 'start' }))
  await page.waitForTimeout(600); await shot('06-debt')
  await page.evaluate(() => document.querySelector('[data-dd-card="history"]')?.scrollIntoView({ block: 'start' }))
  await page.waitForTimeout(600); await shot('07-history')
  R.evidenceOverflow2 = await overflow()
  await page.locator('.ddx-layers__tab', { hasText: 'Model' }).evaluate((e) => e.click()); await page.waitForTimeout(900)
  await page.evaluate(() => document.querySelector('.ddx-layers')?.scrollIntoView({ block: 'start' }))
  await page.waitForTimeout(600); await shot('08-model')
  const base = await page.locator('.ddx-compare tr.is-key td').nth(1).innerText().catch(() => null)
  const slider = page.locator('.ddx-lever input').nth(1)
  if (await slider.count()) {
    await slider.evaluate((el) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, String(Number(el.max) * 0.8)); el.dispatchEvent(new Event('input', { bubbles: true })) })
    await page.waitForTimeout(500); await shot('09-scenario')
    R.scenario = { base, moved: await page.locator('.ddx-compare tr.is-key td').nth(1).innerText().catch(() => null) }
    await page.locator('.ddx-lab__foot .ddx-btn').evaluate((e) => e.click()); await page.waitForTimeout(400)
    R.scenario.reset = await page.locator('.ddx-compare tr.is-key td').nth(1).innerText().catch(() => null)
  }
  for (const id of ['sens', 'method']) await page.locator(`[data-dd-card="${id}"] .ddx-card__head`).evaluate((e) => e.getAttribute('aria-expanded') === 'false' && e.click()).catch(() => {})
  await page.waitForTimeout(500)
  await page.evaluate(() => document.querySelector('[data-dd-card="sens"]')?.scrollIntoView({ block: 'start' }))
  await page.waitForTimeout(600); await shot('10-sensitivity')
  await page.evaluate(() => document.querySelector('[data-dd-card="method"]')?.scrollIntoView({ block: 'start' }))
  await page.waitForTimeout(600); await shot('11-method')
  R.modelOverflow = await overflow()
}
R.smallTargets = await smallTargets()
R.heroTop = heroTop
await browser.close().catch(() => {})
console.log(JSON.stringify({ ...R, blocked, errors: errors.slice(0, 6) }))
