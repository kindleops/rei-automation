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
// wait for the pins at the new camera (the lens pill counts them), bounded
await page.waitForFunction(() => /\d[\d,]* in view/.test(document.querySelector('.mx-context')?.textContent || ''), null, { timeout: 45000 }).catch(() => {})
await page.waitForTimeout(3000)
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
  const findPin = () => page.evaluate(() => {
    const m = window.__nxMap
    const canvas = m.getCanvas().getBoundingClientRect()
    const layers = ['command-pin-icon-raw', 'command-pin-core-raw'].filter((id) => m.getLayer(id))
    const all = (layers.length ? m.queryRenderedFeatures({ layers }) : []).filter((f) => f.geometry?.type === 'Point')
    // a pin backed by a real conversation opens the seller card; bare inventory may not
    const withThread = all.filter((f) => f.properties?.conversation_id)
    const cx = canvas.width / 2; const cy = canvas.height / 2
    let best = null
    for (const f of [...withThread, ...all.filter((f) => !f.properties?.conversation_id && f.properties?.property_id)]) {
      if (best && !f.properties?.conversation_id && best.thread) break
      const p = m.project(f.geometry.coordinates)
      const d = Math.hypot(p.x - cx, p.y - cy)
      const x = canvas.left + p.x; const y = canvas.top + p.y
      const onTop = document.elementFromPoint(x, y)?.classList?.contains('maplibregl-canvas')
      if (onTop && p.x > 80 && p.y > 160 && p.x < canvas.width - 90 && p.y < canvas.height - 120 && (!best || (d < best.d && Boolean(f.properties?.conversation_id) === best.thread))) best = { d, x, y, layer: f.layer.id, thread: Boolean(f.properties?.conversation_id) }
    }
    return best
  })
  let pt = null
  for (let i = 0; i < 12 && !pt; i += 1) { pt = await findPin(); if (!pt) await page.waitForTimeout(2000) }
  console.log('pin', JSON.stringify(pt))
  if (pt) {
    await page.mouse.click(pt.x, pt.y)
    const opened = await page.waitForSelector('.smc-dock, .smc-shell', { timeout: 45000 }).then(() => true).catch(() => false)
    await page.waitForTimeout(opened ? 3500 : 500)
    console.log('card opened', opened)
    await shot('card')
    if (opened) {
      // detail (focus) state: click the peek body, not a control
      const peek = await page.$('.smc-dock.is-peek .smc-shell')
      if (peek) { await peek.click({ position: { x: 60, y: 40 } }).catch(() => {}); await page.waitForTimeout(3000); await shot('card-detail') }
    }
  }
}
const info = await page.evaluate(() => ({
  context: document.querySelector('.mx-context')?.textContent?.trim() || null,
  zoom: window.__nxMap?.getZoom?.().toFixed(2),
  center: window.__nxMap?.getCenter?.().toArray().map((v) => v.toFixed(3)),
}))
console.log(JSON.stringify({ info, errors: errors.slice(0, 5), blocked }))
await browser.close()
