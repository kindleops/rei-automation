import { chromium } from 'playwright'
/**
 * Workflow Studio (mobile observatory) proof over REAL runtime data (read-only:
 * every non-GET /api request is aborted). Overflow / tap / scroll audit.
 *   node scripts/proof/mobile/workflow-observatory-capture.mjs --theme=dark --w=390
 */
const OUT = 'artifacts/workflow'
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const THEME = arg('theme', 'dark')
const W = Number(arg('w', 390))
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: W, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId: 'America/Chicago' })
await ctx.addInitScript((t) => { const cur = JSON.parse(localStorage.getItem('nexus-settings') || '{}'); localStorage.setItem('nexus-settings', JSON.stringify({ ...cur, nexusTheme: t })) }, THEME)
const page = await ctx.newPage()
const errors = []; const blocked = []
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
await page.route('**/api/**', (r) => { const m = r.request().method(); if (['GET', 'OPTIONS'].includes(m)) return r.continue(); blocked.push(`${m} ${new URL(r.request().url()).pathname}`); return r.abort() })
const tag = `${THEME}-${W}`
const shot = async (name) => { await page.screenshot({ path: `${OUT}/${tag}-${name}.png` }); console.log('shot', name) }
const audit = (root) => page.evaluate((sel) => {
  const r = document.querySelector(sel); if (!r) return null
  const bad = [...r.querySelectorAll('*')].filter((el) => { if (el.closest('.wf3-chips, .wf3-field')) return false; const b = el.getBoundingClientRect(); return b.width > 0 && (b.right > innerWidth + 1 || b.left < -1) }).slice(0, 5).map((el) => `${el.className}`.slice(0, 40))
  return { doc: document.documentElement.scrollWidth - innerWidth, offenders: bad }
}, root)
const R = {}
await page.goto('http://localhost:5173/workflow-studio', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.wf3-card, .wf3-state', { timeout: 240000 }).catch(() => {})
await page.waitForTimeout(1500)
await shot('01-home'); R.head = await page.locator('.wf3-head').innerText().catch(() => null); R.audit = await audit('.wf3')
await page.evaluate(() => document.querySelector('.wf3')?.scrollTo(0, 800)); await page.waitForTimeout(400); await shot('02-home-scrolled')
await page.evaluate(() => document.querySelector('.wf3')?.scrollTo(0, 0))
await page.evaluate(() => document.querySelector('.wf3-card[data-wf="seller_inbound"]')?.click())
await page.waitForSelector('.wf3-room .wf3-outline', { timeout: 60000 }).catch(() => {}); await page.waitForTimeout(900)
await shot('03-workflow'); R.wfAudit = await audit('.wf3-room')
await page.evaluate(() => document.querySelector('.wf3-room__scroll')?.scrollTo(0, 900)); await page.waitForTimeout(400); await shot('04-workflow-steps')
await page.evaluate(() => { const r = document.querySelector('.wf3-room__scroll'); r?.scrollTo(0, r.scrollHeight) }); await page.waitForTimeout(400); await shot('05-workflow-runs')
R.runs = await page.locator('.wf3-run').count()
await page.evaluate(() => document.querySelector('.wf3-run')?.click())
await page.waitForSelector('[data-testid="run-room"] .wf3-why', { timeout: 60000 }).catch(() => {}); await page.waitForTimeout(900)
await shot('06-run'); R.run = (await page.locator('[data-testid="run-room"] .wf3-title').innerText().catch(() => null))?.slice(0, 300)
await page.evaluate(() => { const rs = document.querySelectorAll('.wf3-room__scroll'); const r = rs[rs.length - 1]; r?.scrollTo(0, r.scrollHeight) }); await page.waitForTimeout(400); await shot('07-run-path')
R.runAudit = await audit('[data-testid="run-room"]')
console.log(JSON.stringify({ ...R, blocked, errors: errors.slice(0, 5) }))
await browser.close()
