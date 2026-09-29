import { chromium } from 'playwright'
/**
 * Email Command (mobile) proof. ?demo=1 = the real read model over scenario
 * rows; plus the LIVE state (production has no email yet). Overflow / tap
 * size / scroll-owner audit. Read-only: every non-GET /api request is aborted.
 *   node scripts/proof/mobile/email-command-capture.mjs --theme=dark --w=390
 */
const OUT = 'artifacts/email'
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
const audit = (root) => page.evaluate((rootSel) => {
  const root = document.querySelector(rootSel)
  if (!root) return null
  const bad = [...root.querySelectorAll('*')].filter((el) => { if (el.closest('.em2-chips, .em2-actionbar, .em2-html, .em2-liquid')) return false; const b = el.getBoundingClientRect(); return b.width > 0 && (b.right > innerWidth + 1 || b.left < -1) }).slice(0, 5).map((el) => `${el.className}`.slice(0, 40))
  const small = [...root.querySelectorAll('button')].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 28 }).map((b) => `${b.className}:${Math.round(b.getBoundingClientRect().height)}`).slice(0, 6)
  return { doc: document.documentElement.scrollWidth - innerWidth, offenders: bad, small }
}, root)
const openThread = (text) => page.evaluate((t) => { const c = [...document.querySelectorAll('.em2-row')].find((x) => x.textContent.includes(t)); c?.click(); return Boolean(c) }, text)
const back = () => page.evaluate(() => document.querySelector('.em2-room__bar .em2-icon')?.click())

const R = {}
await page.goto('http://localhost:5173/email-command?demo=1', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.em2-row, .em2-state', { timeout: 240000 }).catch(() => {})
await page.waitForTimeout(1200)
await shot('01-home')
R.head = await page.locator('.em2-head').innerText().catch(() => null)
R.rows = await page.locator('.em2-row').count()
R.audit = await audit('.em2')
if (!QUICK) {
  await page.evaluate(() => document.querySelector('.em2')?.scrollTo(0, 700)); await page.waitForTimeout(400); await shot('02-home-scrolled')
  await page.evaluate(() => document.querySelector('.em2')?.scrollTo(0, 0))
  R.open1 = await openThread('Summit Title'); await page.waitForSelector('.em2-room .em2-hero', { timeout: 20000 }).catch(() => {}); await page.waitForTimeout(900)
  await page.evaluate(() => document.querySelector('.em2-room__scroll')?.scrollTo(0, 0)); await page.waitForTimeout(300)
  await shot('03-room-needs-you'); R.roomNeeds = await page.locator('.em2-hero').innerText().catch(() => null); R.roomAudit = await audit('.em2-room')
  await page.evaluate(() => { const r = document.querySelector('.em2-room__scroll'); r?.scrollTo(0, r.scrollHeight) }); await page.waitForTimeout(300); await shot('04-room-needs-you-thread')
  await back(); await page.waitForTimeout(500)
  R.open2 = await openThread('West Title'); await page.waitForTimeout(1000); await page.evaluate(() => document.querySelector('.em2-room__scroll')?.scrollTo(0, 0)); await shot('05-room-system-handling')
  await page.evaluate(() => [...document.querySelectorAll('.em2-auto .em2-link')][0]?.click()); await page.waitForTimeout(500); await shot('06-why-sheet')
  await page.evaluate(() => document.querySelector('.em2-sheet__close')?.click()); await page.waitForTimeout(300)
  await back(); await page.waitForTimeout(500)
  R.open3 = await openThread('David Larson'); await page.waitForTimeout(1000); await page.evaluate(() => document.querySelector('.em2-room__scroll')?.scrollTo(0, 0)); await shot('07-room-seller')
  R.roomSeller = await page.locator('.em2-hero').innerText().catch(() => null)
  await page.evaluate(() => { const r = document.querySelector('.em2-room__scroll'); r?.scrollTo(0, r.scrollHeight) }); await page.waitForTimeout(300); await shot('08-room-seller-thread')
  await page.evaluate(() => document.querySelector('.em2-telbtn')?.click()); await page.waitForTimeout(700); await shot('09-message-sheet')
  R.sheet = await page.locator('.em2-sheet').innerText().catch(() => null)
  await page.evaluate(() => document.querySelector('.em2-sheet__close')?.click()); await page.waitForTimeout(300)
  await back(); await page.waitForTimeout(500)
  await page.goto('http://localhost:5173/email-command', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.em2-state, .em2-row, .em2-calm', { timeout: 120000 }).catch(() => {})
  await page.waitForTimeout(1500); await shot('10-live')
  R.live = (await page.locator('.em2').innerText().catch(() => null))?.slice(0, 400)
}
console.log(JSON.stringify({ ...R, blocked, errors: errors.slice(0, 6) }))
await browser.close()
