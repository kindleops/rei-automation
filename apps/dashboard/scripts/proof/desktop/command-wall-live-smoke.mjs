import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * COMMAND WALL short LIVE smoke (≤ 10 min, ONE display) against a LOCAL API that
 * reads production. The local API must run with COMMAND_WALL_STORE=memory so
 * pairing/heartbeat write only process memory — never production.
 * Measures the wall's real request rate per minute and response times.
 *
 *   CW_OPS_SECRET=… node scripts/proof/desktop/command-wall-live-smoke.mjs --base=http://localhost:5199 --api=http://localhost:3099 --minutes=8 --out=<dir>
 * (the secret is read from the environment and never printed)
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5199')
const API = arg('api', 'http://localhost:3099')
const MINUTES = Math.min(10, Number(arg('minutes', '8')))
const OUT = path.resolve(arg('out', '/tmp/cw-live'))
const SECRET = process.env.CW_OPS_SECRET || ''
await fs.mkdir(OUT, { recursive: true })
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] })
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, serviceWorkers: 'block' })
// read-only guard: only the wall's own routes may leave the page; Supabase is blocked
await ctx.route(/supabase\.co/, (r) => r.abort())
await ctx.route((u) => u.pathname.startsWith('/api/') && !u.pathname.startsWith('/api/wall/'), (r) => r.abort())
const page = await ctx.newPage()
const reqs = []
page.on('requestfinished', async (r) => {
  const u = new URL(r.url())
  if (!u.pathname.startsWith('/api/wall/')) return
  const t = r.timing()
  const res = await r.response().catch(() => null)
  reqs.push({ at: Date.now(), ep: u.pathname.replace('/api/wall/', ''), status: res?.status() ?? 0, ms: Math.round(t.responseEnd - t.requestStart) })
})
const watchdog = setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, (MINUTES + 4) * 60_000)
await page.goto(`${BASE}/wall`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
await page.waitForSelector('.cw-pair__code span:not(.cw-pair__wait)', { timeout: 120_000 })
const code = (await page.locator('.cw-pair__code').innerText()).replace(/[^A-Z0-9]/g, '')
const claim = await fetch(`${API}/api/cockpit/wall/displays`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ops-dashboard-secret': SECRET }, body: JSON.stringify({ code, name: 'Live smoke TV', preset: 'national_command', theme: 'dark', privacy_mode: 'privacy' }) })
console.log('claim', claim.status, (await claim.json()).display?.status)
await page.waitForSelector('.cw-stage', { timeout: 60_000 })
const t0 = Date.now()
await page.waitForTimeout(90_000)
await page.screenshot({ path: path.join(OUT, 'live-national-1920x1080-dark.png') })
await page.waitForTimeout(Math.max(0, MINUTES * 60_000 - (Date.now() - t0)))
const after = reqs.filter((r) => r.at >= t0)
const mins = (Date.now() - t0) / 60_000
const by = {}
for (const r of after) { const b = (by[r.ep] ||= { n: 0, ms: [], statuses: {} }); b.n += 1; b.ms.push(r.ms); b.statuses[r.status] = (b.statuses[r.status] || 0) + 1 }
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
const summary = { minutes: Math.round(mins * 10) / 10, requests_per_min: Math.round((after.length / mins) * 10) / 10, by_endpoint: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, { per_min: Math.round((v.n / mins) * 10) / 10, median_ms: med(v.ms), max_ms: Math.max(...v.ms), statuses: v.statuses }])), debug: await page.evaluate(() => window.__lcWall?.debug?.() ?? null) }
await fs.writeFile(path.join(OUT, 'live-smoke.json'), JSON.stringify(summary, null, 2))
console.log('LIVE', JSON.stringify(summary))
clearTimeout(watchdog)
await browser.close()
