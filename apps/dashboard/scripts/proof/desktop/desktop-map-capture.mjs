import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * DESKTOP MAP proof (READ ONLY: non-GET /api aborted — the seller card's live
 * SMS action can never fire from here). Frames a real market, then walks the
 * chrome states: resting, layers, live activity, a selected property.
 *   node scripts/proof/desktop/desktop-map-capture.mjs --width=1440 --height=900 --theme=dark
 *   node scripts/proof/desktop/desktop-map-capture.mjs --center=-93.27,44.98 --zoom=11.5 --states=rest,layers
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const W = Number(arg('width', 1440)); const H = Number(arg('height', 900)); const SCALE = Number(arg('scale', 1))
const THEME = arg('theme', 'dark')
const OUT = path.resolve(arg('out', 'artifacts/desktop-map'))
const CENTER = arg('center', '').split(',').filter(Boolean).map(Number)
const ZOOM = Number(arg('zoom', 11))
const STATES = arg('states', 'rest,layers,activity,card').split(',')
const TAG = arg('tag', `${THEME}-${W}x${H}`)
await fs.mkdir(OUT, { recursive: true })
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: SCALE })
await ctx.addInitScript((t) => {
  localStorage.removeItem('nexus.desktop.split'); localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
  const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}'); localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t }))
}, THEME)
const page = await ctx.newPage()
const errors = []; const blocked = []
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
await page.route('**/api/**', (r) => { const m = r.request().method(); if (['GET', 'OPTIONS', 'HEAD'].includes(m)) return r.continue(); blocked.push(`${m} ${new URL(r.request().url()).pathname}`); return r.abort() })
await page.goto(`${BASE}/map`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForSelector('.dsk-pane__body canvas', { timeout: 90000 })
await page.waitForFunction(() => Boolean(window.__nxMap), null, { timeout: 60000 })
// let the operator's pins arrive (the map frames them itself) — bounded
await page.waitForFunction(() => /in view/.test(document.querySelector('.mx-context')?.textContent || ''), null, { timeout: 60000 }).catch(() => {})
if (CENTER.length === 2) {
  await page.evaluate(([c, z]) => window.__nxMap.jumpTo({ center: c, zoom: z }), [CENTER, ZOOM])
}
await page.waitForTimeout(6000)
const shot = async (name) => { await page.screenshot({ path: `${OUT}/${TAG}-${name}.png` }); console.log('shot', name) }
const esc = async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(700) }
if (STATES.includes('rest')) await shot('rest')
if (STATES.includes('layers')) {
  await page.click('[data-map-control="layers"]'); await page.waitForTimeout(1400); await shot('layers'); await esc()
}
if (STATES.includes('activity')) {
  await page.click('[data-map-control="activity"]'); await page.waitForTimeout(2500); await shot('activity-peek')
  await page.click('[data-map-control="activity"]'); await page.waitForTimeout(1400); await shot('activity-sheet'); await esc()
  await page.click('[data-map-control="activity"]').catch(() => {}); await page.waitForTimeout(400); await esc()
}
if (STATES.includes('card')) {
  // click the property marker nearest the middle of the pane
  const pt = await page.evaluate(() => {
    const m = window.__nxMap
    const canvas = m.getCanvas().getBoundingClientRect()
    const feats = m.queryRenderedFeatures().filter((f) => f.geometry?.type === 'Point' && /pin|seller|marker|property|dot/i.test(f.layer?.id || ''))
    const cx = canvas.width / 2; const cy = canvas.height / 2
    let best = null
    for (const f of feats) {
      const p = m.project(f.geometry.coordinates)
      const d = Math.hypot(p.x - cx, p.y - cy)
      if (p.x > 80 && p.y > 160 && p.x < canvas.width - 90 && p.y < canvas.height - 120 && (!best || d < best.d)) best = { d, x: canvas.left + p.x, y: canvas.top + p.y, layer: f.layer.id }
    }
    return best
  })
  console.log('pin', JSON.stringify(pt))
  if (pt) { await page.mouse.click(pt.x, pt.y); await page.waitForTimeout(4500); await shot('card') }
}
const info = await page.evaluate(() => ({
  context: document.querySelector('.mx-context')?.textContent?.trim() || null,
  zoom: window.__nxMap?.getZoom?.().toFixed(2),
  center: window.__nxMap?.getCenter?.().toArray().map((v) => v.toFixed(3)),
}))
console.log(JSON.stringify({ info, errors: errors.slice(0, 5), blocked }))
await browser.close()
