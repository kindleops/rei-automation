import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * MAP DESKTOP 2.0 proof — LOAD-SAFE and READ-ONLY.
 *
 * The local dev API talks to the PRODUCTION database, so this harness is strict:
 *   · every /api call is blocked EXCEPT the Map's own GET reads (property tiles
 *     and dot tiles, the market aggregates, the world clock / zones);
 *   · every direct Supabase request is blocked (REST, RPC, auth, storage) and
 *     every Supabase websocket (realtime) is closed — the app shell would
 *     otherwise poll Inbox counts;
 *   · every non-GET request, to any origin, is aborted;
 *   · if ANY request is in flight for more than 10 s, the run stops at once.
 * Run captures ONE AT A TIME (never in parallel). Nothing here clicks a send
 * control: the only map clicks are on property pins and the rail/legend tools.
 *
 *   node scripts/proof/desktop/map-desktop-2-capture.mjs --width=1440 --height=900 --theme=dark
 *   node scripts/proof/desktop/map-desktop-2-capture.mjs --width=1440 --height=900 --theme=dark --split=Pipeline --states=rest,layers
 *   node scripts/proof/desktop/map-desktop-2-capture.mjs --width=390 --height=844 --phone --states=rest
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const flag = (n) => process.argv.includes(`--${n}`)
const BASE = arg('base', 'http://localhost:5173')
const W = Number(arg('width', 1440)); const H = Number(arg('height', 900)); const SCALE = Number(arg('scale', 1))
const THEME = arg('theme', 'dark')
const PHONE = flag('phone')
const OUT = path.resolve(arg('out', 'artifacts/map-desktop-2'))
const CENTER = arg('center', '-93.265,44.978').split(',').filter(Boolean).map(Number)
const ZOOM = Number(arg('zoom', 12))
const STATES = arg('states', 'rest,layers,filters,live,appearance,colorby,card').split(',')
const SPLIT = arg('split', '')
const LIVE_ON = flag('live-on')
/** Stricter still: no property or dot tiles at all (chrome over the basemap + market aggregates). */
const NO_TILES = flag('no-tiles')
/** Zero database traffic: every /api call blocked (the chrome over the basemap, with its honest empty states). */
const NO_DB = flag('no-db')
const TAG = arg('tag', `${PHONE ? 'phone' : THEME}-${W}x${H}${SPLIT ? '-split' : ''}`)
const WATCHDOG_MS = 10_000

// ── the allowlist: the Map's own GET reads, nothing else ─────────────────────
const MAP_GET = [
  /^\/api\/internal\/dashboard\/ops\/map\/tiles\/\d+\/\d+\/\d+$/, // property tiles + ?dots=1 dot tiles
  /^\/api\/internal\/dashboard\/ops\/map$/, // market aggregates / clusters (GET)
  /^\/api\/cockpit\/map\/world(\/zones)?$/, // local time, contact window, zone clocks
]

await fs.mkdir(OUT, { recursive: true })
const browser = await chromium.launch()
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: SCALE,
  ...(PHONE ? { isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' } : {}),
})
await ctx.addInitScript(([t, liveOn]) => {
  localStorage.removeItem('nexus.desktop.split'); localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
  const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}'); localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t }))
  localStorage.setItem('nexus.map.mobileActivity', JSON.stringify({ on: Boolean(liveOn), scope: 'all', window: 'today' }))
}, [THEME, LIVE_ON])

const blocked = new Map(); const allowed = new Map(); const errors = []
const note = (m, k) => m.set(k, (m.get(k) || 0) + 1)
let stopped = null
const inflight = new Map()

// Supabase realtime (websockets): closed before they open.
await ctx.routeWebSocket(/supabase\.co/, (ws) => { note(blocked, 'WS supabase realtime'); ws.close() })
await ctx.route('**/*', (route) => {
  const req = route.request(); const m = req.method(); const u = new URL(req.url())
  if (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS') { note(blocked, `${m} ${u.host}${u.pathname}`); return route.abort() }
  if (/supabase\.co$/.test(u.hostname)) { note(blocked, `GET supabase ${u.pathname.split('/').slice(0, 4).join('/')}`); return route.abort() }
  if (u.pathname.startsWith('/api/')) {
    if (NO_DB) { note(blocked, `GET ${u.pathname.replace(/\/\d+\/\d+\/\d+$/, '/{z}/{x}/{y}')} (--no-db)`); return route.abort() }
    if (NO_TILES && /\/ops\/map\/tiles\//.test(u.pathname)) { note(blocked, 'GET tiles (--no-tiles)'); return route.abort() }
    if (MAP_GET.some((re) => re.test(u.pathname))) { note(allowed, `GET ${u.pathname.replace(/\/\d+\/\d+\/\d+$/, '/{z}/{x}/{y}')}${u.searchParams.get('dots') ? '?dots=1' : ''}`); return route.continue() }
    note(blocked, `GET ${u.pathname}`); return route.abort()
  }
  return route.continue()
})

const page = await ctx.newPage()
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
page.on('request', (r) => inflight.set(r, Date.now()))
page.on('requestfinished', (r) => inflight.delete(r))
page.on('requestfailed', (r) => inflight.delete(r))
const stop = (why) => {
  if (stopped) return
  stopped = why
  console.error(`STOPPED: ${why}`)
  console.log(JSON.stringify({ stopped: why, allowed: Object.fromEntries(allowed), blocked: Object.fromEntries(blocked) }, null, 1))
  // exit first: the browser dies with the process, and no pending step gets to run on
  process.exit(2)
}
const watchdog = setInterval(() => {
  const now = Date.now()
  for (const [r, t] of inflight) {
    if (now - t > WATCHDOG_MS) { stop(`request in flight > ${WATCHDOG_MS / 1000}s: ${r.method()} ${r.url().slice(0, 160)}`); return }
  }
}, 250)

const wait = (ms) => page.waitForTimeout(ms)
const shot = async (name) => { await page.screenshot({ path: `${OUT}/${TAG}-${name}.png` }); console.log('shot', `${TAG}-${name}`) }
// Raw pointer clicks at an element's centre. Never on anything that sends.
const tap = async (sel) => {
  if (/send|ownership|retry|confirm-draft|draft/i.test(sel)) throw new Error(`refusing to click a write control: ${sel}`)
  const c = await page.waitForFunction((q) => { const el = document.querySelector(q); if (!el) return null; const b = el.getBoundingClientRect(); return b.width ? [b.left + b.width / 2, b.top + b.height / 2] : null }, sel, { timeout: 20000 }).then((h) => h.jsonValue())
  await page.mouse.move(c[0], c[1]); await page.mouse.click(c[0], c[1])
}
const esc = async () => { await page.keyboard.press('Escape'); await wait(600) }

await page.goto(`${BASE}/map`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForSelector(PHONE ? 'canvas.maplibregl-canvas' : '.dsk-pane__body canvas', { timeout: 60000 })
// The dev runtime banner (a local-dev diagnostic that the blocked shell GETs trigger) covers the pane's
// bottom edge — the legend and the zoom capsule. Hidden in captures only; it is not Map UI.
await page.addStyleTag({ content: '[data-testid="dev-runtime-banner"]{display:none!important}' })
if (SPLIT && !PHONE) {
  // one app per comma: Map + 1 = 50%, Map + 3 = 25%
  for (const label of SPLIT.split(',').filter(Boolean)) {
    const item = page.locator('.dsk-side__item', { hasText: label }).first()
    await item.hover(); await wait(300)
    await item.locator('.dsk-side__split').click()
    await wait(3000)
  }
  console.log('panes', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.dsk-pane')].map((p) => Math.round(p.getBoundingClientRect().width)))))
}
await page.waitForFunction(() => Boolean(window.__nxMap), null, { timeout: 45000 })
if (CENTER.length === 2) await page.evaluate(([c, z]) => window.__nxMap.jumpTo({ center: c, zoom: z }), [CENTER, ZOOM])
// the pins at this camera (the lens pill counts them) — bounded
await page.waitForFunction((phone) => /\d[\d,]* in view/.test(document.querySelector(phone ? '.mx-context' : '.mxd-lens__sub')?.textContent || ''), PHONE, { timeout: 40000 }).catch(() => {})
await wait(2500)

if (STATES.includes('rest')) await shot('rest')

if (!PHONE) {
  if (STATES.includes('layers')) {
    await tap('[data-map-control="layers"]'); await wait(1100); await shot('layers')
    // the lower groups: Live world (cameras disabled, with its reason) and Operations
    await page.evaluate(() => { const b = document.querySelector('.mxd-layers .mxd-insp__body'); if (b) b.scrollTop = b.scrollHeight })
    await wait(500); await shot('layers-lower')
    await esc()
  }
  if (STATES.includes('filters')) {
    await tap('[data-map-control="filters"]'); await wait(1400); await shot('filters')
    // a draft (client-only): the count call is a POST, so the harness blocks it — the inspector must say so
    await page.evaluate(() => { const b = [...document.querySelectorAll('.mxd-filters [role="radio"]')].find((x) => x.textContent?.trim() === 'Uncontacted'); b?.click() })
    await wait(2200); await shot('filters-draft')
    // one group open: its fields (ranges need no option reads)
    await page.evaluate(() => { const h = [...document.querySelectorAll('.mxd-filters .mxd-group__head')].find((x) => x.textContent?.includes('Financials')); h?.click() })
    await wait(900); await shot('filters-group')
    await tap('[data-map-sheet-close]'); await wait(700)
  }
  if (STATES.includes('live')) { await tap('[data-map-control="activity"]'); await wait(1600); await shot('live'); await esc() }
  if (STATES.includes('appearance')) { await tap('[data-map-control="appearance"]'); await wait(900); await shot('appearance'); await esc() }
  if (STATES.includes('colorby')) { await tap('[data-map-control="color-by"]'); await wait(900); await shot('colorby'); await esc() }
  if (STATES.includes('card')) {
    // the property tile pin nearest the middle of the free map (never under the chrome)
    const findPin = () => page.evaluate(() => {
      const m = window.__nxMap; const canvas = m.getCanvas().getBoundingClientRect()
      const layers = ['prop-tiles-hit'].filter((id) => m.getLayer(id)); if (!layers.length) return null
      let best = null
      for (const f of m.queryRenderedFeatures({ layers })) {
        if (f.geometry?.type !== 'Point' || !f.properties?.property_id) continue
        const p = m.project(f.geometry.coordinates); const x = canvas.left + p.x; const y = canvas.top + p.y
        // clear of the chrome: beside the stack on a wide pane, below it on a narrow one
        const wide = canvas.width > 900
        if (wide ? (p.x < 480 || p.y < 160 || p.x > canvas.width - 480 || p.y > canvas.height - 160) : (p.x < 90 || p.y < 280 || p.x > canvas.width - 70 || p.y > canvas.height - 170)) continue
        if (!document.elementFromPoint(x, y)?.classList?.contains('maplibregl-canvas')) continue
        const d = Math.hypot(p.x - canvas.width / 2, p.y - canvas.height / 2)
        if (!best || d < best.d) best = { d, x, y, id: f.properties.property_id }
      }
      return best
    })
    let pt = null
    for (let i = 0; i < 12 && !pt; i += 1) { pt = await findPin(); if (!pt) await wait(1500) }
    console.log('pin', JSON.stringify(pt))
    if (pt) {
      const state = () => page.evaluate(() => document.querySelector('.smcd')?.getAttribute('data-desk-state') ?? null)
      // where the SAME property is now (the camera may settle after a selection)
      const locate = () => page.evaluate((id) => {
        const m = window.__nxMap; const canvas = m.getCanvas().getBoundingClientRect()
        const f = m.queryRenderedFeatures({ layers: ['prop-tiles-hit'] }).find((x) => String(x.properties?.property_id) === String(id))
        if (!f) return null
        const p = m.project(f.geometry.coordinates)
        const x = canvas.left + p.x; const y = canvas.top + p.y
        const top = document.elementFromPoint(x, y)
        return { x, y, onCanvas: Boolean(top?.classList?.contains('maplibregl-canvas')), under: top?.className?.toString?.().slice(0, 60) ?? null }
      }, pt.id)
      await page.evaluate(() => {
        window.__nxClicks = []
        const m = window.__nxMap
        for (const id of ['prop-tiles-hit', 'command-pin-core-raw', 'seller-pins-hit', 'prop-univ-marker-hit']) {
          if (!m.getLayer(id)) continue
          m.on('click', id, (e) => window.__nxClicks.push({ layer: id, pid: e.features?.[0]?.properties?.property_id ?? null }))
        }
        m.on('click', (e) => window.__nxClicks.push({ layer: 'map', handled: Boolean(e._clickHandled) }))
      })
      await page.mouse.move(40, H - 40); await wait(200)
      await page.mouse.click(pt.x, pt.y); await wait(2200)
      const first = await state(); await shot('card-first-click')
      let second = null; let third = null
      let at = await locate(); console.log('after first', JSON.stringify(at))
      if (STATES.includes('debug-expand')) {
        const r = await page.evaluate(async () => {
          const before = document.querySelector('.smcd')?.getAttribute('data-desk-state')
          window.dispatchEvent(new CustomEvent('nexus:smcd-expand', { detail: { propertyId: null } }))
          await new Promise((res) => setTimeout(res, 1500))
          return { before, after: document.querySelector('.smcd')?.getAttribute('data-desk-state') }
        })
        console.log('manual expand', JSON.stringify(r))
      }
      if (at?.onCanvas) {
        await page.evaluate(() => {
          window.__nxStates = []
          window.__nxEvents = []
          const t0 = performance.now()
          for (const n of ['nexus:smcd-expand', 'nexus:smcd-presence']) window.addEventListener(n, (e) => window.__nxEvents.push({ t: Math.round(performance.now() - t0), n, d: JSON.stringify(e.detail) }))
          const tick = () => { const st = document.querySelector('.smcd')?.getAttribute('data-desk-state') ?? null; const last = window.__nxStates[window.__nxStates.length - 1]; if (!last || last.st !== st) window.__nxStates.push({ t: Math.round(performance.now() - t0), st }); if (performance.now() - t0 < 4000) requestAnimationFrame(tick) }
          requestAnimationFrame(tick)
        })
        const cards = () => page.evaluate(() => ({
          cards: [...document.querySelectorAll('.smcd')].map((el) => ({ state: el.getAttribute('data-desk-state'), anchor: el.getAttribute('data-anchor'), label: el.getAttribute('aria-label')?.slice(0, 60) })),
          maps: document.querySelectorAll('.maplibregl-canvas').length,
          hosts: document.querySelectorAll('.mx-overlay-host').length,
          icm: document.querySelectorAll('.nx-icm').length,
          last: window.__nxDeskClick ?? null,
        }))
        console.log('before second', JSON.stringify(await cards()))
        await page.mouse.click(at.x, at.y); await wait(300)
        console.log('second +300ms', JSON.stringify(await cards()))
        await wait(2100); second = await state(); await shot('card-second-click')
        console.log('second +2.4s', JSON.stringify(await cards()))
        console.log('state trail after second click', JSON.stringify(await page.evaluate(() => ({ states: window.__nxStates, events: window.__nxEvents }))))
      }
      at = await locate(); console.log('after second', JSON.stringify(at), JSON.stringify(await page.evaluate(() => ({ clicks: window.__nxClicks, last: window.__nxDeskClick ?? null }))))
      if (at?.onCanvas) { await page.mouse.click(at.x, at.y); await wait(1600); third = await state(); await shot('card-third-click') }
      console.log('card states', JSON.stringify({ first, second, third }), JSON.stringify(await page.evaluate(() => ({ subject: window.__nexusSubject ?? null, lastDeskClick: window.__nxDeskClick ?? null }))))
    }
  }
}

clearInterval(watchdog)
const info = await page.evaluate((phone) => ({
  pill: document.querySelector(phone ? '.mx-context' : '.mxd-lens')?.textContent?.trim() || null,
  world: document.querySelector('.nxw-chip')?.textContent?.trim() || null,
  zoom: window.__nxMap?.getZoom?.().toFixed(2),
  deskChrome: Boolean(document.querySelector('.mxd-rail')),
  phoneChrome: Boolean(document.querySelector('.mx-stack')),
}), PHONE)
console.log(JSON.stringify({ info, errors: errors.slice(0, 6), allowed: Object.fromEntries(allowed), blocked: Object.fromEntries(blocked) }, null, 1))
await browser.close()
