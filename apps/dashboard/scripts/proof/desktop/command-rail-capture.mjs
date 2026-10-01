import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * COMMAND RAIL capture (READ ONLY). Non-GET to /api or Supabase is aborted.
 * Captures the rail pinned, collapsed, hover-expanded, a hover peek and the
 * machine plane, plus transient states replayed from SAMPLE events through the
 * DEV-only __lcRail seam (never present in production builds).
 *
 *   node scripts/proof/desktop/command-rail-capture.mjs --themes=dark --out=/tmp/rail
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/command-rail'))
const THEMES = arg('themes', 'dark').split(',')
const [W, H] = arg('size', '1440x900').split('x').map(Number)
const ROUTE = arg('route', '/pipeline')
await fs.mkdir(OUT, { recursive: true })
const browser = await chromium.launch()
for (const theme of THEMES) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H } })
  await ctx.addInitScript((t) => {
    try {
      localStorage.removeItem('nexus.desktop.split')
      localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
      const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
      localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t }))
      const p = JSON.parse(localStorage.getItem('nexus.desktop.shell') || '{}')
      localStorage.setItem('nexus.desktop.shell', JSON.stringify({ ...p, collapsed: false, closedGroups: [] }))
    } catch { /* ignore */ }
  }, theme)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
  await page.route('**/*', (r) => { const req = r.request(); const u = new URL(req.url()); if ((u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)) && !['GET', 'HEAD', 'OPTIONS'].includes(req.method())) return r.abort(); return r.continue() })
  const watchdog = setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 300_000)
  await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('.cr', { timeout: 90000 })
  // wait for the first telemetry read (local API can be slow on a cold cache)
  await page.waitForFunction(() => document.querySelector('.cr .crt__count'), null, { timeout: 120000 }).catch(() => console.log('note: no counts yet'))
  await page.waitForTimeout(1200)
  const shot = (name, clip) => page.screenshot({ path: path.join(OUT, `${theme}-${name}.png`), ...(clip ? { clip } : {}) })
  const railClip = { x: 0, y: 0, width: 300, height: H }
  await shot('pinned', railClip)
  await shot('pinned-full')
  // hover peek on Inbox
  await page.locator('.cr-row', { hasText: 'Inbox' }).first().hover()
  await page.waitForTimeout(900)
  await shot('peek', { x: 0, y: 0, width: 560, height: H })
  await page.mouse.move(W - 200, H / 2)
  // transients (sample events through the DEV seam)
  const now = Date.now()
  const ev = (id, app, kind, transient, priority, extra = {}) => ({ id: `qa:${id}:${now}`, app, kind, transient, priority, occurred_at: new Date(now).toISOString(), text: extra.text || kind, ...extra })
  await page.evaluate((events) => window.__lcRail?.ingest(events), [
    ev('1', '/inbox', 'auto_reply_started', 'typing', 2, { text: 'Seller reply received — automation handling' }),
    ev('2', '/pipeline', 'stage_advanced', 'stage', 3, { display: 'S2→S3', text: 'S2 → S3 · Asking price provided' }),
    ev('3', '/queue', 'dispatch', 'processing', 4, { text: 'Dispatching' }),
  ])
  await page.waitForTimeout(450)
  await shot('transients-1', railClip)
  await page.evaluate((events) => window.__lcRail?.ingest(events), [
    ev('4', '/campaign-command', 'campaign_refill', 'refill', 4, { display: '+100', value: 100, text: 'Refill · 100 scheduled' }),
    ev('5', '/workflow-studio', 'workflow_trace', 'trace', 5, { text: 'Workflow event consumed' }),
  ])
  await page.waitForTimeout(1500)
  await shot('transients-2', railClip)
  await page.waitForTimeout(2600)
  await shot('transients-3', railClip)
  // machine plane
  await page.locator('.cr-dock').click()
  await page.waitForTimeout(700)
  await shot('machine', { x: 0, y: 0, width: 700, height: H })
  await page.keyboard.press('Escape')
  // collapsed rail + hover expansion
  await page.keyboard.press('Meta+\\')
  await page.waitForTimeout(800)
  await page.mouse.move(W - 200, H / 2)
  await page.waitForTimeout(500)
  await shot('rail', railClip)
  await shot('rail-full')
  await page.locator('.cr').hover({ position: { x: 30, y: 300 } })
  await page.waitForTimeout(900)
  await shot('rail-hover', { x: 0, y: 0, width: 420, height: H })
  clearTimeout(watchdog)
  console.log(JSON.stringify({ theme, errors: errors.slice(0, 5) }))
  await ctx.close()
}
await browser.close()
