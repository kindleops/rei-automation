import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * R8.3 MAP DYNAMIC DAY/NIGHT capture (READ ONLY).
 *
 * The sun is pinned to a fixed instant with the DEV-only `?sun_at=` override
 * (world/sun-clock.ts — shifts the sun only, ignored in production builds):
 * 2026-10-03 23:30Z = 19:30 EDT (New York after sunset) / 16:30 PDT (Los
 * Angeles in daylight). Captures national, metro and street zoom on both
 * sides, the Appearance popover and the legend, and measures the main-thread
 * cost of the minute update (forced via visibilitychange → apply()).
 *
 * Guard: every non-GET to /api or Supabase is aborted EXCEPT POST
 * /rest/v1/rpc/get_map_* (the Map's STABLE read RPCs). Nothing is clicked but
 * the Map's own rail, the Appearance tiles/segments and Escape. Never Ownership Check.
 *
 *   node scripts/proof/desktop/r83-map-daynight-capture.mjs --out=/tmp/x --theme=dark --style=dark_ops
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/r83-map-daynight'))
const THEME = arg('theme', 'dark')
const STYLE = arg('style', THEME === 'light' ? 'light_street' : 'dark_ops')
const SUN_AT = arg('at', '2026-10-03T23:30:00Z')
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
    localStorage.setItem('nexus.map.mobileLens', JSON.stringify({ ...lp, lens: 'radar', legendCollapsed: false }))
    const lv = JSON.parse(localStorage.getItem('nexus.map.living') || '{}')
    localStorage.setItem('nexus.map.living', JSON.stringify({ ...lv, enabled: true, daylight: true, sun: 'dynamic' }))
  } catch { /* ignore */ }
}, THEME)
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
const isReadRpc = (u, method) => method === 'POST' && /\/rest\/v1\/rpc\/get_map_/.test(u.pathname)
await page.route('**/*', (r) => {
  const req = r.request(); const u = new URL(req.url())
  if ((u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)) && !['GET', 'HEAD', 'OPTIONS'].includes(req.method()) && !isReadRpc(u, req.method())) return r.abort()
  return r.continue()
})
const dog = setTimeout(async () => { console.log('WATCHDOG'); await browser.close().catch(() => {}); process.exit(2) }, 600_000)
const wait = (ms) => page.waitForTimeout(ms)
const shot = async (n) => { await page.screenshot({ path: path.join(OUT, `${THEME}-${STYLE}-${n}.png`) }); console.log('shot', n) }
const jump = async (c, z, ms = 7000) => { await page.evaluate(([cc, zz]) => window.__nxMap?.jumpTo({ center: cc, zoom: zz, pitch: 0, bearing: 0 }), [c, z]); await wait(ms) }

await page.goto(`${BASE}/map?sun_at=${encodeURIComponent(SUN_AT)}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.addStyleTag({ content: '[data-testid="dev-runtime-banner"]{display:none!important}' }).catch(() => {})
await page.waitForSelector('canvas.maplibregl-canvas', { timeout: 90000 })
await page.waitForFunction(() => Boolean(window.__nxMap), null, { timeout: 60000 }).catch(() => console.log('note: no __nxMap'))
await wait(4000)

// map style for this theme (Appearance tile — a local view choice)
await page.click('.mxd-rail [data-map-control="appearance"]').catch((e) => console.log('note: no appearance', e.message.slice(0, 80)))
await wait(900)
await page.click(`.mxd-appearance [data-theme-id="${STYLE}"]`).catch((e) => console.log('note: no style tile', e.message.slice(0, 80)))
await wait(4000)
await jump([-96, 38.5], 3.7, 9000)
await shot('appearance-popover')
console.log('APPEARANCE', await page.evaluate(() => document.querySelector('.mxd-appearance')?.innerText?.replace(/\s+/g, ' ').slice(0, 420)))
await page.keyboard.press('Escape'); await wait(700)

// national: East dark, West light
await jump([-96, 38.5], 3.7, 9000)
await shot('national')
console.log('LEGEND', await page.evaluate(() => document.querySelector('.mxd-legend')?.innerText?.replace(/\s+/g, ' ').slice(0, 300)))
await jump([-100, 25], 1.6, 6000)
await shot('world')
// metro
await jump([-73.98, 40.73], 10.2); await shot('metro-east-newyork')
await jump([-118.3, 34.05], 10.2); await shot('metro-west-losangeles')
await jump([-87.65, 41.88], 9.4); await shot('metro-terminator-chicago')
// street
await jump([-73.985, 40.748], 15.2); await shot('street-east-newyork')
await jump([-96.80, 32.78], 15.2); await shot('street-west-dallas')

// frame cost of the minute update
const perf = await page.evaluate(async () => {
  const frames = async (ms, poke) => {
    const deltas = []
    let last = performance.now()
    let pokes = 0
    let lastPoke = last
    const syncCosts = []
    const end = last + ms
    await new Promise((resolve) => {
      const step = (t) => {
        deltas.push(t - last); last = t
        if (poke && t - lastPoke > 500) {
          lastPoke = t
          const s = performance.now()
          document.dispatchEvent(new Event('visibilitychange'))
          syncCosts.push(performance.now() - s); pokes++
        }
        if (t < end) requestAnimationFrame(step); else resolve()
      }
      requestAnimationFrame(step)
    })
    deltas.sort((a, b) => a - b)
    const q = (p) => deltas[Math.min(deltas.length - 1, Math.floor(p * deltas.length))]
    return { frames: deltas.length, p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), max: +deltas[deltas.length - 1].toFixed(2), pokes, syncMs: syncCosts.map((x) => +x.toFixed(2)) }
  }
  window.__nxMap?.jumpTo({ center: [-96, 38.5], zoom: 3.7 })
  await new Promise((r) => setTimeout(r, 4000))
  const baseline = await frames(6000, false)
  const updating = await frames(6000, true)
  return { baseline, updating, lastTick: window.__nxSunCost ?? null }
})
console.log('PERF', JSON.stringify(perf))
console.log('ERRORS', JSON.stringify(errors.slice(0, 10)))
clearTimeout(dog)
await browser.close()
