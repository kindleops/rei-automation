import { chromium } from 'playwright'
/**
 * Workflow Studio (mobile) proof over REAL runtime data. Read-only: every
 * non-GET /api request is aborted except the pure /simulate preview.
 *   node scripts/proof/mobile/workflow-studio-capture.mjs --theme=dark --w=390
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
await page.route('**/api/**', (r) => { const m = r.request().method(); const u = new URL(r.request().url()).pathname; if (['GET', 'OPTIONS'].includes(m) || u.endsWith('/workflow-studio/simulate')) return r.continue(); blocked.push(`${m} ${u}`); return r.abort() })
const tag = `${THEME}-${W}`
const shot = async (name) => { await page.screenshot({ path: `${OUT}/${tag}-s-${name}.png` }); console.log('shot', name) }
const audit = (sel) => page.evaluate((s) => {
  const r = document.querySelector(s); if (!r) return null
  const bad = [...r.querySelectorAll('*')].filter((el) => { if (el.closest('.wfx-rail, .wfx-chips, .wfx-liquid')) return false; const b = el.getBoundingClientRect(); return b.width > 0 && (b.right > innerWidth + 1 || b.left < -1) }).slice(0, 5).map((el) => `${el.className}`.slice(0, 40))
  return { doc: document.documentElement.scrollWidth - innerWidth, offenders: bad }
}, sel)
const scrollTo = (sel, y) => page.evaluate(([s, v]) => document.querySelector(s)?.scrollTo(0, v), [sel, y])
const R = {}
await page.goto('http://localhost:5173/workflow-studio', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.wfx-body, .wfx-empty', { timeout: 240000 }).catch(() => {})
await page.waitForTimeout(2200)
await shot('01-overview'); R.hero = (await page.locator('.wfx-hero').innerText().catch(() => '')).replace(/\n+/g, ' | '); R.a1 = await audit('.wfx')
await scrollTo('.wfx', 620); await page.waitForTimeout(700); await shot('02-overview-live')
await scrollTo('.wfx', 1300); await page.waitForTimeout(700); await shot('03-overview-automations')
for (const t of ['workflows', 'leads', 'activity']) {
  await scrollTo('.wfx', 0); await page.waitForTimeout(200)
  await page.locator(`.wfx-seg [data-tab="${t}"]`).click(); await page.waitForTimeout(1300)
  await shot(`04-${t}`); R[`a_${t}`] = await audit('.wfx')
  await scrollTo('.wfx', 700); await page.waitForTimeout(600); await shot(`05-${t}-scrolled`)
}
R.leadRows = await page.evaluate(() => 0)
await scrollTo('.wfx', 0)
await page.locator('.wfx-seg [data-tab="workflows"]').click(); await page.waitForTimeout(900)
await page.locator('.wfx-row.is-studio').first().click().catch(() => {})
await page.waitForSelector('[data-testid="studio-workflow-room"] .wfx-roomhero', { timeout: 60000 }).catch(() => {}); await page.waitForTimeout(1200)
await shot('06-studio-workflow'); R.aRoom = await audit('[data-testid="studio-workflow-room"]')
await page.evaluate(() => document.querySelector('[data-testid="studio-workflow-room"] .wf3-room__scroll')?.scrollTo(0, 700)); await page.waitForTimeout(600); await shot('07-studio-workflow-leads')
await page.locator('[data-testid="studio-workflow-room"] .wfx-lead').first().click().catch(() => {})
await page.waitForSelector('[data-testid="studio-run-room"] .wfx-flow', { timeout: 60000 }).catch(() => {}); await page.waitForTimeout(1200)
await shot('08-studio-run'); R.aRun = await audit('[data-testid="studio-run-room"]')
await page.goto('http://localhost:5173/workflow-studio?create=1', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('[data-testid="studio-create"] .wfx-bp', { timeout: 240000 }).catch(() => {}); await page.waitForTimeout(1400)
await shot('09-create-pick'); R.aCreate = await audit('[data-testid="studio-create"]')
await page.locator('[data-testid="studio-create"] .wfx-bp').first().click(); await page.waitForTimeout(2600)
await shot('10-create-config')
await page.evaluate(() => document.querySelector('[data-testid="studio-create"] .wf3-room__scroll')?.scrollTo(0, 520)); await page.waitForTimeout(900); await shot('11-create-preview')
R.preview = (await page.locator('.wfx-sentence').innerText().catch(() => '')).slice(0, 200)
R.blocked = blocked; R.errors = errors
console.log(JSON.stringify(R, null, 1))
await browser.close()
