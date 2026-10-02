import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * R8.2 MAP INTELLIGENCE capture (READ ONLY): boundary overlay (state + ZIP),
 * the legend beside the open Layers inspector, the sold-comps / investor lens
 * dates, and Radar timings.
 *
 * Guard: every non-GET to /api or Supabase is aborted EXCEPT POST
 * /rest/v1/rpc/get_map_* — the Map's read RPCs (all STABLE, read-only;
 * PostgREST calls functions with POST). Nothing else is clicked than the map's
 * own rail and the Layers switches for boundaries.
 *
 *   node scripts/proof/desktop/r82-map-intel-capture.mjs --out=/tmp/x --theme=dark
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/r82-map-intel'))
const THEME = arg('theme', 'dark')
const [W, H] = arg('size', '1440x900').split('x').map(Number)
await fs.mkdir(OUT, { recursive: true })
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: W, height: H } })
await ctx.addInitScript((t) => {
  try {
    localStorage.removeItem('nexus.desktop.split')
    localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
    const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
    localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t }))
    const lp = JSON.parse(localStorage.getItem('nexus.map.mobileLens') || '{}')
    localStorage.setItem('nexus.map.mobileLens', JSON.stringify({ ...lp, lens: 'radar', boundaryState: true, boundaryZip: true, legendCollapsed: false }))
  } catch { /* ignore */ }
}, THEME)
const page = await ctx.newPage()
const errors = []
const timings = []
const starts = new Map()
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
page.on('request', (r) => { if (/rpc\/get_map_lens_points|map\/boundaries/.test(r.url())) starts.set(r, Date.now()) })
page.on('requestfinished', async (r) => {
  const t0 = starts.get(r)
  if (t0 == null) return
  let note = ''
  try {
    const u = new URL(r.url())
    if (u.pathname.endsWith('get_map_lens_points')) note = String(r.postData() || '').slice(0, 160)
    else note = u.search.slice(0, 120)
    const res = await r.response()
    const body = await res?.json().catch(() => null)
    const n = Array.isArray(body) ? body.length : body?.data?.features?.length ?? (body?.available === false ? `unavailable:${body.reason}` : '')
    timings.push(`${Date.now() - t0}ms ${res?.status()} ${u.pathname.split('/').pop()} n=${n} ${note}`)
  } catch { /* ignore */ }
})
const isReadRpc = (u, method) => method === 'POST' && /\/rest\/v1\/rpc\/get_map_/.test(u.pathname)
await page.route('**/*', (r) => {
  const req = r.request(); const u = new URL(req.url())
  if ((u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)) && !['GET', 'HEAD', 'OPTIONS'].includes(req.method()) && !isReadRpc(u, req.method())) return r.abort()
  return r.continue()
})
const dog = setTimeout(async () => { console.log('WATCHDOG'); await browser.close().catch(() => {}); process.exit(2) }, 420_000)
const wait = (ms) => page.waitForTimeout(ms)
const shot = async (n) => { await page.screenshot({ path: path.join(OUT, `map-${THEME}-${W}-${n}.png`) }); console.log('shot', n) }
const jump = async (c, z) => { await page.evaluate(([cc, zz]) => window.__nxMap?.jumpTo({ center: cc, zoom: zz, pitch: 0, bearing: 0 }), [c, z]); await wait(8000) }
const legendText = () => page.evaluate(() => document.querySelector('.mxd-legend')?.innerText?.replace(/\s+/g, ' ').slice(0, 400) || null)

await page.goto(`${BASE}/map`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.addStyleTag({ content: '[data-testid="dev-runtime-banner"]{display:none!important}' }).catch(() => {})
await page.waitForSelector('canvas.maplibregl-canvas', { timeout: 90000 })
await page.waitForFunction(() => Boolean(window.__nxMap), null, { timeout: 60000 }).catch(() => console.log('note: no __nxMap'))
await jump([-93.6, 45.6], 6.2) // Minnesota: Radar ambient + state lines
await wait(20000) // Radar's first read is the slow one before the fix
await shot('radar-state-lines')
console.log('LEGEND radar', await legendText())
await jump([-93.265, 44.978], 11.6) // Minneapolis: ZIP outlines + codes
await shot('zip-outlines')
console.log('LEGEND zip', await legendText())
await page.click('.mxd-rail [data-map-control="layers"]').catch((e) => console.log('note: no layers', e.message.slice(0, 80)))
await wait(1800)
await shot('layers-open-legend')
const bounds = await page.evaluate(() => [...document.querySelectorAll('[data-map-inspector="layers"] .mxd-sensors__group')].map((g) => g.innerText.replace(/\s+/g, ' ')).filter((t) => /Boundaries/.test(t)).join(' | '))
console.log('LAYERS boundaries', bounds)
const geom = await page.evaluate(() => {
  const r = (s) => document.querySelector(s)?.getBoundingClientRect()
  const a = r('[data-map-inspector="layers"]'); const b = r('.mxd-legend')
  const op = getComputedStyle(document.querySelector('.mxd-cards') || document.body).opacity
  return { inspector: a && [Math.round(a.left), Math.round(a.right)], legend: b && [Math.round(b.left), Math.round(b.right), Math.round(b.top)], cardsOpacity: op, overlap: Boolean(a && b && b.left < a.right && b.right > a.left) }
})
console.log('LEGEND vs LAYERS', JSON.stringify(geom))
await page.keyboard.press('Escape'); await wait(600)
console.log('TIMINGS\n' + timings.join('\n'))
console.log('ERRORS', JSON.stringify(errors.slice(0, 10)))
clearTimeout(dog)
await browser.close()
