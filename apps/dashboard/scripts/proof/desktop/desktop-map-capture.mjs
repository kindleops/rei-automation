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
const SPLIT = arg('split', '')
const TAG = arg('tag', `${THEME}-${W}x${H}${SPLIT ? '-split' : ''}`)
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
// Supabase: reads only. Table writes are aborted; RPCs pass only when they are reads (get_/list_/search_/count_).
await page.route('**/rest/v1/**', (r) => {
  const m = r.request().method(); const u = new URL(r.request().url())
  if (['GET', 'OPTIONS', 'HEAD'].includes(m) || /\/rest\/v1\/rpc\/(get|list|search|count)_/.test(u.pathname)) return r.continue()
  blocked.push(`${m} ${u.pathname}`); return r.abort()
})
await page.goto(`${BASE}/map`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForSelector('.dsk-pane__body canvas', { timeout: 90000 })
if (SPLIT) {
  // open a second app beside the Map from the sidebar's split control → the Map pane is 50%
  const item = page.locator('.dsk-side__item', { hasText: SPLIT }).first()
  await item.hover(); await page.waitForTimeout(300)
  await item.locator('.dsk-side__split').click()
  await page.waitForTimeout(5000)
}
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
  /**
   * The property marker nearest the middle of the pane. Conversation-backed pins
   * first (they carry the richest card), then seller pins, then the property tiles
   * every pane shows — the old finder only looked at conversation pins, so a pane
   * showing tiles/seller pins found nothing and the card was never opened.
   */
  const findPin = () => page.evaluate(() => {
    const m = window.__nxMap
    const canvas = m.getCanvas().getBoundingClientRect()
    const families = [
      ['command-pin-core-raw', 'command-pin-icon-raw'],
      ['seller-pins-hit', 'seller-pins-core'],
      ['prop-tiles-hit'],
      ['prop-univ-marker-hit'],
    ]
    const cx = canvas.width * 0.42; const cy = canvas.height / 2
    for (const family of families) {
      const layers = family.filter((id) => m.getLayer(id))
      if (!layers.length) continue
      let feats = []
      try { feats = m.queryRenderedFeatures({ layers }).filter((f) => f.geometry?.type === 'Point' && (f.properties?.property_id || f.properties?.conversation_id)) } catch { continue }
      const threaded = (f) => Boolean(f.properties?.conversation_id || f.properties?.thread_key)
      let best = null
      for (const f of feats) {
        const p = m.project(f.geometry.coordinates)
        const x = canvas.left + p.x; const y = canvas.top + p.y
        const onTop = document.elementFromPoint(x, y)?.classList?.contains('maplibregl-canvas')
        if (!onTop || p.x < 120 || p.y < 170 || p.x > canvas.width - 520 || p.y > canvas.height - 150) continue
        const score = Math.hypot(p.x - cx, p.y - cy) - (threaded(f) ? 400 : 0)
        if (!best || score < best.score) best = { score, x, y, layer: f.layer.id, thread: threaded(f), id: f.properties?.property_id ?? null }
      }
      if (best) return best
    }
    return null
  })
  // Freeze the card's transitions mid-flight so a still frame can show the morph:
  // new Web Animations run at 2% speed while armed, then are pinned at a fraction.
  const armSlowMo = () => page.evaluate(() => {
    if (!window.__smcdPatched) {
      window.__smcdPatched = true
      const orig = Element.prototype.animate
      Element.prototype.animate = function (...args) { const a = orig.apply(this, args); if (window.__smcdSlow) a.playbackRate = 0.02; return a }
    }
    window.__smcdSlow = true
  })
  const freezeAt = (f) => page.evaluate((f) => {
    window.__smcdSlow = false
    let n = 0
    for (const a of document.getAnimations()) {
      const t = a.effect?.getTiming?.()
      const d = typeof t?.duration === 'number' ? t.duration : 0
      if (!d || d > 1000 || t.iterations === Infinity) continue
      a.pause(); a.currentTime = (t.delay || 0) + d * f; n += 1
    }
    return n
  }, f)
  const release = () => page.evaluate(() => { window.__smcdSlow = false; for (const a of document.getAnimations()) { a.playbackRate = 1; if (a.playState === 'paused') a.play() } })
  // Raw pointer clicks at an element's centre: Playwright's actionability waits
  // stall on headless software-WebGL frame pacing. Never used on send controls.
  const tap = async (sel) => {
    if (/primary-send|send/i.test(sel)) throw new Error(`refusing to click a send control: ${sel}`)
    const c = await page.waitForFunction((q) => { const el = document.querySelector(q); if (!el) return null; const b = el.getBoundingClientRect(); return b.width ? [b.left + b.width / 2, b.top + b.height / 2] : null }, sel, { timeout: 30000 }).then((h) => h.jsonValue())
    await page.mouse.move(c[0], c[1])
    await page.mouse.click(c[0], c[1])
  }
  const settle = async (sel, ms = 900) => { await page.waitForSelector(sel, { timeout: 30000 }).catch(() => {}); await page.waitForTimeout(ms) }
  // bounded wait for the record to hydrate (skeletons gone), then imagery
  const hydrated = () => page.waitForFunction(() => !document.querySelector('.smcd .smcd-skel'), null, { timeout: 40000 }).catch(() => {})
  const transition = async (name, click, sel, at = [0.3]) => {
    await armSlowMo()
    await click()
    await page.waitForTimeout(120)
    for (const f of at) { const n = await freezeAt(f); await shot(`${name}-${Math.round(f * 100)}`); console.log('frozen', name, f, n) }
    await release()
    await settle(sel)
  }

  let pt = null
  // property tiles arrive slowly under load (the tile RPC can take a minute): poll up to ~2.5 min
  for (let i = 0; i < 50 && !pt; i += 1) { pt = await findPin(); if (!pt) await page.waitForTimeout(3000) }
  console.log('pin', JSON.stringify(pt))
  if (pt) {
    // PREVIEW: hovering the pin opens the capsule beside it (a glance; the camera stays)
    // one step from a neutral spot, so the hover lands on THIS pin (MapLibre's
    // mouseenter is per layer, so the first pin crossed would otherwise win)
    await page.mouse.move(40, H - 40)
    await page.mouse.move(pt.x, pt.y)
    let preview = await page.waitForSelector('.smcd.is-preview', { timeout: 20000 }).then(() => true).catch(() => false)
    if (!preview) { await page.mouse.click(pt.x, pt.y); preview = false }
    await page.waitForTimeout(3500)
    await shot(preview ? 'card-preview' : 'card-direct')
    console.log('preview', preview)
    if (preview) {
      // click the capsule's body (its address) — "click again" → HALF
      await transition('transition-preview-to-half', () => tap('.smcd.is-preview .smcd-address'), '.smcd.is-half', [0.22, 0.55])
    }
    await hydrated(); await page.waitForTimeout(2500)
    await shot('card-half')
    await transition('transition-half-to-full', () => tap('.smcd [aria-label="Expand to full"]'), '.smcd.is-full', [0.35])
    await hydrated(); await page.waitForTimeout(2000)
    await shot('card-full-overview')
    for (const tab of ['activity', 'property', 'graph', 'campaigns', 'seller']) {
      await tap(`.smcd [data-tab="${tab}"]`)
      await page.waitForTimeout(tab === 'activity' ? 4000 : 1400)
      await page.evaluate(() => document.querySelector('.smcd .smcd-scroll')?.scrollTo({ top: document.querySelector('.smcd .smcd-tabs')?.offsetTop ?? 0 }))
      await page.waitForTimeout(500)
      await shot(`card-full-${tab}`)
      await page.evaluate(() => document.querySelector('.smcd .smcd-scroll')?.scrollTo({ top: 0 }))
    }
    // HALF remembers the last tab (Seller), collapse returns to the pinned capsule
    await transition('transition-full-to-half', () => tap('.smcd [aria-label="Restore to half"]'), '.smcd.is-half', [0.3])
    await shot('card-half-remembered-tab')
    await transition('transition-half-to-preview', () => tap('.smcd [aria-label="Collapse to preview"]'), '.smcd.is-preview', [0.3])
    await page.waitForTimeout(800)
    await shot('card-preview-pinned')
    console.log('desk', JSON.stringify(await page.evaluate(() => {
      const el = document.querySelector('.smcd'); const host = document.querySelector('.mx-overlay-host'); const mapEl = window.__nxMap?.getContainer()
      const r = (n) => { if (!n) return null; const b = n.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)] }
      return { state: el?.dataset.deskState, card: r(el), host: r(host), map: r(mapEl), padding: window.__nxMap?.getPadding?.() }
    })))
  }
}
const info = await page.evaluate(() => ({
  context: document.querySelector('.mx-context')?.textContent?.trim() || null,
  zoom: window.__nxMap?.getZoom?.().toFixed(2),
  center: window.__nxMap?.getCenter?.().toArray().map((v) => v.toFixed(3)),
}))
console.log(JSON.stringify({ info, errors: errors.slice(0, 5), blocked }))
await browser.close()
