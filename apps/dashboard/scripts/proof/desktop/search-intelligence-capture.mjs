import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * SEARCH INTELLIGENCE OS capture (READ ONLY). Prepared, NOT yet run.
 *
 * Every non-GET to /api or Supabase is aborted (same guard as
 * command-rail-capture.mjs). Search Intelligence itself makes no API call:
 * it loads its planning snapshots as static chunks plus public map tiles
 * (CARTO, NASA GIBS). The surrounding shell may issue GETs against the local
 * API, which reads production; nothing writes.
 *
 * Scenes (brief §39): 1 portfolio home · 2 Prominent planning globe ·
 * 3 Prominent architecture · 4 Offerr keyword universe · 5 Reivesti page
 * architecture (+ page inspector) · 6 opportunities · 7 launch command ·
 * 8 zero-data / pre-launch (LeadCommand site) · 9 ultrawide command wall ·
 * 10 property switcher.
 *
 *   node /Users/ryankindle/.claude/jobs/c39b0175/tmp/with-lock.mjs capture \
 *     node scripts/proof/desktop/search-intelligence-capture.mjs \
 *       --out=/Users/ryankindle/.claude/jobs/c39b0175/tmp/search-intelligence/qa \
 *       --sizes=1440x900,1920x1080,3840x1600,5120x1440 --themes=dark,light
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/search-intelligence'))
const THEMES = arg('themes', 'dark').split(',')
const SIZES = arg('sizes', '1440x900,1920x1080,3840x1600,5120x1440').split(',').map((s) => s.split('x').map(Number))
const ONLY = arg('only', '')
const R = '/search-intelligence'

const SCENES = [
  { id: '01-portfolio-home', url: `${R}`, wait: 4500 },
  { id: '02-prominent-planning-globe', url: `${R}?v=globe&p=prominent`, wait: 6000 },
  { id: '03-prominent-architecture', url: `${R}?v=architecture&p=prominent`, wait: 1800 },
  { id: '04-offerr-keyword-universe', url: `${R}?v=keywords&p=offerr`, wait: 1200 },
  { id: '05-reivesti-page-architecture', url: `${R}?v=architecture&p=reivesti&o=page:rv:metro-austin`, wait: 2000 },
  { id: '06-opportunities', url: `${R}?v=opportunities`, wait: 1200 },
  { id: '07-launch-command', url: `${R}?v=launch`, wait: 1200 },
  { id: '08-zero-data-prelaunch', url: `${R}?p=leadcommand`, wait: 4500 },
  { id: '09-ultrawide-command-wall', url: `${R}?p=prominent&o=geography:us-ga`, wait: 6500, minWidth: 3800 },
  { id: '10-property-switcher', url: `${R}?v=pages&p=reivesti`, wait: 1500, clipTop: 140 },
  // supporting states
  { id: '11-geography-drill-miami', url: `${R}?v=geography&p=prominent&o=geography:us-fl-miami-dade-county`, wait: 1800 },
  { id: '12-globe-live-mode-unavailable', url: `${R}?v=globe`, wait: 5000, action: async (page) => { await page.locator('.si-globe-panel__mode button', { hasText: 'Impressions' }).first().click().catch(() => {}); await page.waitForTimeout(600) } },
  { id: '13-connections', url: `${R}?v=connections`, wait: 1000 },
]

await fs.mkdir(OUT, { recursive: true })
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-webgl', '--ignore-gpu-blocklist'] })
const report = []
for (const theme of THEMES) for (const [W, H] of SIZES) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: W >= 3800 ? 1 : 2 })
  await ctx.addInitScript((t) => {
    try {
      localStorage.removeItem('nexus.desktop.split')
      localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
      const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
      localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t }))
    } catch { /* ignore */ }
  }, theme)
  const page = await ctx.newPage()
  const errors = []
  const blocked = []
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
  await page.route('**/*', (r) => {
    const req = r.request()
    const u = new URL(req.url())
    if ((u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)) && !['GET', 'HEAD', 'OPTIONS'].includes(req.method())) { blocked.push(`${req.method()} ${u.pathname}`); return r.abort() }
    return r.continue()
  })
  const watchdog = setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 600_000)
  for (const s of SCENES) {
    if (ONLY && !ONLY.split(',').includes(s.id)) continue
    if (s.minWidth && W < s.minWidth) continue
    await page.goto(`${BASE}${s.url}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
    await page.waitForSelector('.si-main', { timeout: 90000 }).catch(() => errors.push(`${s.id}: no .si-main`))
    await page.waitForTimeout(s.wait)
    if (s.action) await s.action(page)
    const file = path.join(OUT, `${theme}-${W}x${H}-${s.id}.png`)
    await page.screenshot({ path: file, ...(s.clipTop ? { clip: { x: 0, y: 0, width: W, height: s.clipTop + 200 } } : {}) })
    report.push(file)
  }
  clearTimeout(watchdog)
  console.log(JSON.stringify({ theme, size: `${W}x${H}`, errors: errors.slice(0, 6), blocked: blocked.slice(0, 6) }))
  await ctx.close()
}
await browser.close()
console.log(JSON.stringify({ shots: report.length, out: OUT }))
