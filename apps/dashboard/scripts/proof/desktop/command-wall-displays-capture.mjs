import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * Settings → Displays capture (READ ONLY, MOCKED). Every /api request is
 * aborted except GET /api/cockpit/wall/displays, which is answered from a
 * fixture; non-GET is aborted too, so nothing can write. Supabase is blocked.
 *
 *   node scripts/proof/desktop/command-wall-displays-capture.mjs --base=http://localhost:5199 --out=<dir> [--themes=dark,true_black]
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5199')
const OUT = path.resolve(arg('out', '/tmp/cw-displays'))
const THEMES = arg('themes', 'dark,true_black').split(',')
const SIZES = arg('sizes', '1920x1080').split(',').map((s) => s.split('x').map(Number))
await fs.mkdir(OUT, { recursive: true })
const now = Date.now()
const iso = (ms) => new Date(now - ms).toISOString()
const cfg = (o) => ({ preset: 'national_command', theme: 'dark', privacy_mode: 'privacy', oled_protection: 'low', camera_mode: 'static', audio: 'off', show_feed: true, overnight_low_light: false, rotation: { enabled: false, steps: [] }, layers: null, watched_markets: [], map_view: null, ...o })
const DISPLAYS = [
  { id: 'cwd_living', name: 'Living Room TV', status: 'active', connection: 'online', paired_at: iso(3 * 864e5), paired_by: 'operator', last_seen_at: iso(4_000), revoked_at: null, token_expires_at: iso(-177 * 864e5), config: cfg({ rotation: { enabled: true, steps: [{ preset: 'national_command', minutes: 4 }, { preset: 'acquisition_pulse', minutes: 3 }, { preset: 'market_intelligence', minutes: 3 }, { preset: 'campaign_operations', minutes: 2 }] }, privacy_mode: 'operations' }), config_version: 6, view_command: null, client: { build: 'CwUzU7uM', browser: 'tizen', width: 1920, height: 1080, dpr: 1, render_mode: 'lite', connection: 'live', uptime_s: 61_200, errors: 0, reconnects: 2 } },
  { id: 'cwd_bedroom', name: 'Bedroom', status: 'active', connection: 'offline', paired_at: iso(2 * 864e5), paired_by: 'operator', last_seen_at: iso(7 * 3600_000), revoked_at: null, token_expires_at: iso(-178 * 864e5), config: cfg({ preset: 'acquisition_pulse', theme: 'true_black', oled_protection: 'high', overnight_low_light: true, watched_markets: ['minneapolis-mn', 'dallas-tx', 'houston-tx', 'tampa-fl'] }), config_version: 3, view_command: null, client: { build: 'CwUzU7uM', browser: 'chromium', width: 3840, height: 2160, dpr: 1, render_mode: 'full', connection: 'live', uptime_s: 28_800, errors: 0, reconnects: 0 } },
]
const browser = await chromium.launch()
for (const theme of THEMES) {
  for (const [W, H] of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, serviceWorkers: 'block' })
    await ctx.addInitScript((t) => { try { const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}'); localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t })) } catch { /* */ } }, theme)
    await ctx.route(/supabase\.co/, (r) => r.abort())
    await ctx.route((url) => url.pathname.startsWith('/api/'), (route) => {
      const req = route.request()
      const u = new URL(req.url())
      if (req.method() === 'GET' && u.pathname === '/api/cockpit/wall/displays') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, displays: DISPLAYS, store: 'memory' }) })
      return route.abort()
    })
    const page = await ctx.newPage()
    const watchdog = setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 240_000)
    await page.goto(`${BASE}/settings?section=displays`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.waitForSelector('.cwm-card', { timeout: 120_000 })
    await page.waitForTimeout(1500)
    await page.screenshot({ path: path.join(OUT, `10-display-management-${W}x${H}-${theme}.png`) })
    // the pairing form state
    await page.getByRole('button', { name: 'Add display' }).click()
    await page.locator('.cwm-code').fill('KXRM-4827')
    await page.waitForTimeout(500)
    await page.screenshot({ path: path.join(OUT, `10-display-management-pair-${W}x${H}-${theme}.png`) })
    clearTimeout(watchdog)
    await ctx.close()
    console.log('displays', theme, `${W}x${H}`)
  }
}
await browser.close()
