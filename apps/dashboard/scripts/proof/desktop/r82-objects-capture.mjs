import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * SYSTEM REFINEMENT 8.2 — universal object navigation + cinematic map focus
 * (READ ONLY). Every non-GET to /api or Supabase is aborted; nothing is
 * clicked that writes (no Send / Ownership Check / Launch).
 *
 *   node scripts/proof/desktop/r82-objects-capture.mjs --out=/tmp/r82 [--themes=dark,light]
 *
 * Real production-shaped data through the local API (GET only). The subject is
 * a real property (3635 Emerson Ave N, Minneapolis — property 273312064).
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/r82'))
const THEMES = arg('themes', 'dark,light').split(',')
const PID = arg('pid', '273312064')
await fs.mkdir(OUT, { recursive: true })
const log = { blockedWrites: [], errors: [], notes: [] }
const flush = () => fs.writeFile(path.join(OUT, 'log.json'), JSON.stringify(log, null, 2))
const watchdog = setTimeout(async () => { console.log('WATCHDOG'); await fs.writeFile(path.join(OUT, 'log.json'), JSON.stringify(log, null, 2)); process.exit(2) }, 600_000)
const browser = await chromium.launch()

async function open(theme, w, h) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } })
  await ctx.addInitScript((t) => {
    try {
      const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
      localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t }))
      sessionStorage.removeItem('lc.workspace.session.v1')
    } catch { /* ignore */ }
  }, theme)
  const page = await ctx.newPage()
  page.on('pageerror', (e) => log.errors.push(`${theme}: ${String(e.message).slice(0, 200)}`))
  await page.route('**/*', (r) => {
    const req = r.request()
    const u = new URL(req.url())
    if ((u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)) && !['GET', 'HEAD', 'OPTIONS'].includes(req.method())) { log.blockedWrites.push(`${req.method()} ${u.pathname}`); return r.abort() }
    return r.continue()
  })
  return { ctx, page }
}
const shot = (page, name, clip) => page.screenshot({ path: path.join(OUT, `${name}.png`), ...(clip ? { clip } : {}) })
const mapReady = (page) => page.waitForFunction(() => { const m = window.__nxMap; return Boolean(m && m.isStyleLoaded && m.isStyleLoaded()) }, null, { timeout: 120000 })
const cam = (page) => page.evaluate(() => { const m = window.__nxMap; if (!m) return null; const c = m.getCenter(); return { lng: +c.lng.toFixed(4), lat: +c.lat.toFixed(4), z: +m.getZoom().toFixed(2) } })

for (const theme of THEMES) {
  const { ctx, page } = await open(theme, 1440, 900)
  // 1 · Comps on the subject
  await page.goto(`${BASE}/comp-intelligence?property_id=${PID}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('.ciw-strip:not(.is-skeleton)', { timeout: 120000 }).catch(() => log.notes.push('comps strip not ready'))
  await page.waitForTimeout(2500)
  if (theme === THEMES[0]) await shot(page, `${theme}-1440-01-comps`)

  // 2 · Show on Map from Comps → the Map opens BESIDE; Comps stays
  await page.getByRole('button', { name: 'Open the subject and set in Map' }).click()
  await mapReady(page).catch(() => log.notes.push('map not ready'))
  await page.waitForTimeout(7000)
  await shot(page, `${theme}-1440-02-comps-show-on-map-beside`)
  log.notes.push({ theme, afterShowOnMap: await cam(page), panes: await page.evaluate(() => [...document.querySelectorAll('[data-ws-pane]')].length) })

  // 3 · the cinematic fly-to: start from the national view, then Show on Map for the property
  await page.evaluate(() => { window.__nxMap?.jumpTo({ center: [-98.5, 39.5], zoom: 3.6 }) })
  await page.waitForTimeout(1800)
  // a real frame sequence: the compositor's own frames via CDP screencast (a
  // full-page screenshot is slower than the flight itself)
  const frames = []
  const cdp = await ctx.newCDPSession(page)
  const t0 = Date.now()
  cdp.on('Page.screencastFrame', async (f) => {
    frames.push({ t: Date.now() - t0, data: f.data })
    await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
  })
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 72, everyNthFrame: 1, maxWidth: 1440, maxHeight: 900 })
  await page.waitForTimeout(150)
  await page.evaluate((pid) => {
    window.__r82t = performance.now()
    window.dispatchEvent(new CustomEvent('nexus:map-property-focus', { detail: { seq: Date.now() + 100000, propertyId: pid, label: '3635 Emerson Ave N', threadKey: null, lat: null, lng: null, source: 'capture', at: Date.now() } }))
  }, PID)
  const camTrack = []
  for (let i = 0; i < 16; i += 1) { camTrack.push({ t: Date.now() - t0, cam: await cam(page) }); await page.waitForTimeout(90) }
  await cdp.send('Page.stopScreencast')
  // keep ~10 evenly spaced frames of the sequence
  const step = Math.max(1, Math.floor(frames.length / 10))
  const kept = frames.filter((_, i) => i % step === 0).slice(0, 12)
  if (theme === THEMES[0]) for (const [i, f] of kept.entries()) await fs.writeFile(path.join(OUT, `${theme}-1440-03-flyto-seq${String(i).padStart(2, '0')}-${f.t}ms.jpg`), Buffer.from(f.data, 'base64'))
  log.notes.push({ theme, flyto: { framesCaptured: frames.length, kept: kept.map((f) => f.t), camTrack } })
  await flush()
  await page.waitForTimeout(1500)
  await shot(page, `${theme}-1440-04-landed-preview`)
  log.notes.push({ theme, frames, landed: await cam(page) })

  if (theme === THEMES[0]) {
    // 4 · drag interrupt: a fly is stopped by the operator's drag
    await page.evaluate(() => { window.__nxMap?.jumpTo({ center: [-98.5, 39.5], zoom: 3.6 }) })
    await page.waitForTimeout(1200)
    await page.evaluate((pid) => window.dispatchEvent(new CustomEvent('nexus:map-property-focus', { detail: { seq: Date.now() + 200000, propertyId: pid, label: null, threadKey: null, lat: null, lng: null, source: 'capture', at: Date.now() } })), PID)
    await page.waitForTimeout(220)
    const box = await page.locator('.nx-icm__canvas').first().boundingBox()
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2 + 40, { steps: 6 }); await page.mouse.up()
    }
    await page.waitForTimeout(1600)
    log.notes.push({ dragInterrupt: await cam(page), note: 'zoom should be far below 15.6 — the operator took the camera' })
    await shot(page, `${theme}-1440-05-drag-interrupt`)

    // 5 · F re-frames the selection
    await page.locator('.nx-icm__canvas').first().click({ position: { x: 20, y: 20 } }).catch(() => {})
    await page.evaluate((pid) => window.dispatchEvent(new CustomEvent('nexus:map-property-focus', { detail: { seq: Date.now() + 300000, propertyId: pid, label: null, threadKey: null, lat: null, lng: null, source: 'capture', at: Date.now() } })), PID)
    await page.waitForTimeout(2500)

    // 6 · Universal Inspector over the Map: shift-click a comp row; the legend + zoom step out from under it
    const row = page.locator('[data-comp-row]').first()
    if (await row.count()) {
      await row.click({ modifiers: ['Shift'] })
      await page.waitForSelector('.lc-insp.uinsp', { timeout: 20000 }).catch(() => log.notes.push('inspector did not open'))
      await page.waitForTimeout(2200)
      log.notes.push({ occlusion: await page.evaluate(() => { const r = document.querySelector('.mx.is-desk'); return r ? { occluded: r.hasAttribute('data-occluded'), px: r.style.getPropertyValue('--mxd-occlude-right') } : null }) })
      await shot(page, `${theme}-1440-06-inspector-legend-clear`)
      await page.keyboard.press('Escape')
      await page.waitForTimeout(400)
      // 7 · the canonical object menu on a comp row
      await row.click({ button: 'right' })
      await page.waitForTimeout(600)
      await shot(page, `${theme}-1440-07-object-menu`)
      await page.keyboard.press('Escape')
    } else log.notes.push('no comp rows')

    // 8 · missing location: honest unavailable
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('nexus:map-property-focus', { detail: { seq: Date.now() + 400000, propertyId: 'r82-no-such-property', label: 'Unknown parcel', threadKey: null, lat: null, lng: null, source: 'capture', at: Date.now() } })))
    await page.waitForTimeout(5500)
    await shot(page, `${theme}-1440-08-unavailable`)
  }
  await ctx.close()
}

// 9 · ultrawide (49") — the Map alone, focused on the property (no full pin re-render in flight)
{
  const { ctx, page } = await open('dark', 5120, 1440)
  await page.goto(`${BASE}/map`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await mapReady(page).catch(() => log.notes.push('ultrawide map not ready'))
  await page.waitForTimeout(6000)
  const renders = await page.evaluate(async (pid) => {
    // count React commits on the map subtree during the flight via a mutation proxy:
    // DOM mutations inside the map pane while the camera travels
    const host = document.querySelector('.nx-icm') || document.body
    let mutations = 0
    const mo = new MutationObserver((l) => { mutations += l.length })
    mo.observe(host, { subtree: true, childList: true, attributes: true })
    window.__nxMap?.jumpTo({ center: [-98.5, 39.5], zoom: 3.6 })
    await new Promise((r) => setTimeout(r, 1200))
    mutations = 0
    window.dispatchEvent(new CustomEvent('nexus:map-property-focus', { detail: { seq: Date.now() + 500000, propertyId: pid, label: null, threadKey: null, lat: null, lng: null, source: 'capture', at: Date.now() } }))
    await new Promise((r) => setTimeout(r, 2600))
    mo.disconnect()
    return mutations
  }, PID)
  await page.waitForTimeout(800)
  await shot(page, 'dark-5120-09-ultrawide-focus')
  log.notes.push({ ultrawide: await cam(page), domMutationsDuringFlight: renders })
  await ctx.close()
}

await browser.close()
clearTimeout(watchdog)
await fs.writeFile(path.join(OUT, 'log.json'), JSON.stringify(log, null, 2))
console.log(JSON.stringify(log, null, 2).slice(0, 4000))
