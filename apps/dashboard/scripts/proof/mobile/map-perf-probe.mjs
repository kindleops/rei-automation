import { chromium } from 'playwright'
/**
 * Map performance probe (read-only; non-GET /api aborted). Measures, on a
 * phone viewport: time to map idle, network payload by kind, request count,
 * JS heap, and rAF frame rate during a scripted pan + zoom. Headless Chromium
 * renders WebGL in software, so absolute FPS is pessimistic — use it to
 * compare builds / settings, not as an iPhone number.
 *   node scripts/proof/mobile/map-perf-probe.mjs --label=baseline [--living=1]
 */
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const LABEL = arg('label', 'run')
const browser = await chromium.launch({ args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader'] })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
if (arg('living')) await ctx.addInitScript((v) => { try { const cur = JSON.parse(localStorage.getItem('nexus.map.living') || '{}'); localStorage.setItem('nexus.map.living', JSON.stringify({ ...cur, ...JSON.parse(v) })) } catch { /* */ } }, arg('living'))
const page = await ctx.newPage()
const bytes = {}; let requests = 0
page.on('response', async (r) => {
  requests++
  const u = r.url(); const kind = u.includes('cartocdn') ? (u.includes('.mvt') ? 'carto_mvt' : 'carto_other') : u.includes('elevation-tiles') ? 'terrain' : u.includes('/tiles/') ? 'property_tiles' : u.includes('/api/') ? 'api' : u.includes('arcgisonline') ? 'esri' : 'app'
  try { const len = Number(r.headers()['content-length']) || (await r.body()).length; bytes[kind] = (bytes[kind] || 0) + len } catch { /* */ }
})
await page.route('**/api/**', (r) => (['GET', 'OPTIONS'].includes(r.request().method()) ? r.continue() : r.abort()))
const t0 = Date.now()
await page.goto('http://localhost:5173/map', { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => { const c = document.querySelector('canvas.maplibregl-canvas'); return Boolean(c) }, null, { timeout: 120000 })
await page.waitForTimeout(6000)
const loadMs = Date.now() - t0
const fps = await page.evaluate(async () => {
  const canvas = document.querySelector('canvas.maplibregl-canvas')
  const r = canvas.getBoundingClientRect()
  const frames = []; let last = performance.now(); let raf = 0; let run = true
  const tick = (t) => { frames.push(t - last); last = t; if (run) raf = requestAnimationFrame(tick) }
  raf = requestAnimationFrame(tick)
  const fire = (type, x, y) => canvas.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, buttons: 1 }))
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2
  for (let pass = 0; pass < 3; pass++) {
    fire('mousedown', cx, cy)
    for (let i = 0; i < 30; i++) { fire('mousemove', cx - i * 6, cy - i * 3); await new Promise((res) => setTimeout(res, 16)) }
    fire('mouseup', cx - 180, cy - 90)
    await new Promise((res) => setTimeout(res, 300))
  }
  for (let i = 0; i < 6; i++) { canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, clientX: cx, clientY: cy, deltaY: i < 3 ? -240 : 240 })); await new Promise((res) => setTimeout(res, 220)) }
  await new Promise((res) => setTimeout(res, 800))
  run = false; cancelAnimationFrame(raf)
  const ms = frames.slice(2).sort((a, b) => a - b)
  const avg = ms.reduce((a, b) => a + b, 0) / ms.length
  return { frames: ms.length, avg_fps: Math.round(1000 / avg), p95_frame_ms: Math.round(ms[Math.floor(ms.length * 0.95)]), worst_ms: Math.round(ms[ms.length - 1]) }
})
const heap = await page.evaluate(() => (performance).memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null)
const kb = Object.fromEntries(Object.entries(bytes).map(([k, v]) => [k, Math.round(v / 1024)]))
console.log(JSON.stringify({ label: LABEL, load_to_idle_ms: loadMs, requests, payload_kb: kb, heap_mb: heap, ...fps }))
await browser.close()
