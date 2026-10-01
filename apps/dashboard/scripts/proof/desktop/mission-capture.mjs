import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * MISSIONS capture (READ ONLY — every non-GET to /api or Supabase aborted).
 * Run campaign: start from Campaign Command → reload (mission persists) → exit (prior workspace restored).
 * Work seller: open an Inbox row (publishes the subject) → ⌘K "work this seller" → exit.
 *   node scripts/proof/desktop/mission-capture.mjs --campaign=<uuid> --out=/tmp/missions
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/missions'))
const CAMPAIGN = arg('campaign', '')
await fs.mkdir(OUT, { recursive: true })
const watchdog = setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 540_000)
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
await ctx.addInitScript(() => { try { if (!sessionStorage.getItem('__mission_capture')) { sessionStorage.clear(); sessionStorage.setItem('__mission_capture', '1') } } catch { /* ignore */ } })
const page = await ctx.newPage()
const errors = []
const blocked = []
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
await page.route('**/*', (r) => { const req = r.request(); const u = new URL(req.url()); if ((u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)) && !['GET', 'HEAD', 'OPTIONS'].includes(req.method())) { blocked.push(`${req.method()} ${u.pathname}`); return r.abort() } return r.continue() })
const shot = (n) => page.screenshot({ path: path.join(OUT, `${n}.png`) })
const panes = () => page.evaluate(() => [...document.querySelectorAll('[data-ws-pane]')].map((p) => p.getAttribute('aria-label')))
const deck = async (q) => { await page.keyboard.press('Meta+k'); await page.waitForTimeout(500); await page.keyboard.type(q, { delay: 25 }); await page.waitForTimeout(1200); await page.keyboard.press('Enter'); await page.waitForTimeout(2500) }
const log = {}

// before: Analytics + Queue beside
await page.goto(`${BASE}/analytics`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForSelector('[data-ws-pane]', { timeout: 120000 })
await page.waitForTimeout(4000)
await deck('queue beside')
log.before = await panes()
await shot('01-before')

// run campaign mission
await page.goto(`${BASE}/campaign-command?campaign=${CAMPAIGN}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForSelector('[data-ws-pane]', { timeout: 120000 })
await page.waitForTimeout(6000)
await deck('run this campaign')
log.mission = await panes()
log.capsule = await page.locator('.cd-mission').count()
await page.waitForTimeout(5000)
await shot('02-run-campaign-mission')
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForSelector('[data-ws-pane]', { timeout: 120000 })
await page.waitForTimeout(6000)
log.afterReload = await panes()
log.capsuleAfterReload = await page.locator('.cd-mission').count()
await shot('03-after-reload')
await page.locator('.cd-mission').click()
await page.waitForTimeout(3000)
log.afterExit = await panes()
await shot('04-after-exit')

// work seller from the Inbox
await page.goto(`${BASE}/inbox`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForSelector('[data-ws-pane]', { timeout: 120000 })
await page.waitForTimeout(8000)
const row = page.locator('[data-ledger-row], .ixl-row, [role="row"]').nth(1)
await row.click({ timeout: 30000 }).catch(() => { log.rowClick = 'not found' })
await page.waitForTimeout(3000)
await deck('work this seller')
log.workSeller = await panes()
await page.waitForTimeout(8000)
await shot('05-work-seller')

clearTimeout(watchdog)
console.log(JSON.stringify({ log, errors: errors.slice(0, 8), blocked: [...new Set(blocked)] }, null, 1))
await browser.close()
