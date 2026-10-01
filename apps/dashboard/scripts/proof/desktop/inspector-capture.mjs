import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * UNIVERSAL INSPECTOR capture (READ ONLY): every non-GET to /api or Supabase is
 * aborted. Opens the inspector through the DEV hook for real production ids.
 *   node scripts/proof/desktop/inspector-capture.mjs --out=/tmp/insp --refs='property:273312064,seller:+16122756497'
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/inspector'))
const THEME = arg('theme', 'dark')
const REFS = arg('refs', '').split(',').filter(Boolean).map((s) => { const i = s.indexOf(':'); return { type: s.slice(0, i), id: s.slice(i + 1) } })
await fs.mkdir(OUT, { recursive: true })
const watchdog = setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 480_000)
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await ctx.addInitScript((t) => { try { const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}'); localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t })) } catch { /* ignore */ } }, THEME)
const page = await ctx.newPage()
const errors = []
const blocked = []
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
await page.route('**/*', (r) => { const req = r.request(); const u = new URL(req.url()); if ((u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)) && !['GET', 'HEAD', 'OPTIONS'].includes(req.method())) { blocked.push(`${req.method()} ${u.pathname}`); return r.abort() } return r.continue() })
await page.goto(`${BASE}/inbox`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForSelector('.cd-machine', { timeout: 120000 })
await page.waitForTimeout(1500)
const results = []
for (const ref of REFS) {
  await page.evaluate((r) => window.__lcInspect(r, { replace: true }), ref)
  const t0 = Date.now()
  await page.waitForTimeout(400)
  // done = no loading skeleton left in the plane (the crossfade can briefly keep the previous object's facts)
  await page.waitForFunction(() => { const p = document.querySelector('.uinsp'); return p && !p.querySelector('.lc-skeleton') }, null, { timeout: 150000 }).catch(() => {})
  await page.waitForTimeout(700)
  const text = await page.locator('.uinsp').innerText().catch(() => '')
  results.push({ ref, ms: Date.now() - t0, raw_codes: (text.match(/\b[a-z]+_[a-z_]+\b/g) || []).slice(0, 8), undefinedText: /undefined|NaN|\[object/.test(text) })
  await page.screenshot({ path: path.join(OUT, `${THEME}-inspector-${ref.type}.png`) })
}
clearTimeout(watchdog)
console.log(JSON.stringify({ results, errors: errors.slice(0, 8), blocked }, null, 1))
await browser.close()
