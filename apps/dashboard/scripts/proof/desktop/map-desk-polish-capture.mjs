import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * MAP DESK POLISH proof — LOAD-SAFE and READ-ONLY.
 *
 * The local dev API talks to the PRODUCTION database, so the harness is strict
 * (the Map Desktop 2.0 allowlist):
 *   · every /api call is blocked EXCEPT the Map's own GET reads (property and
 *     dot tiles, the market aggregates, the world clock / zones);
 *   · every direct Supabase request is blocked and every realtime websocket is
 *     closed; every non-GET request, to any origin, is aborted;
 *   · a request in flight for more than 60 s stops the run; the whole run is
 *     capped by a watchdog.
 * Nothing here clicks a write control: the only clicks are the map's own tools
 * (rail, legend, lens pill, zoom) and the shell's pane chrome. Run ONE AT A TIME
 * through the capture lock.
 *
 *   --mode=full    /map alone (the Map fills its pane)
 *   --mode=pane    /inbox, then Map dragged from the command rail onto the bottom
 *                  edge of the Inbox pane (a wide, short pane)
 *   --mode=quad    pane, then Deal Intelligence dragged onto the Map pane's right
 *                  edge (a small pane, ~half by half)
 *
 *   node scripts/proof/desktop/map-desk-polish-capture.mjs --theme=dark --size=1440x900 --mode=full --tag=after --out=/tmp/map
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const flag = (n) => process.argv.includes(`--${n}`)
const BASE = arg('base', 'http://localhost:5173')
const THEME = arg('theme', 'dark')
const [W, H] = arg('size', '1440x900').split('x').map(Number)
const MODE = arg('mode', 'full')
const OUT = path.resolve(arg('out', 'artifacts/map-desk-polish'))
const TAG = arg('tag', 'cap')
/** The map style per app theme (the operator's map preset is independent of the app theme). */
const NATURAL_STYLE = { dark: 'dark_ops', light: 'light_street', true_black: 'dark_ops', red_ops: 'red_ops' }
const STYLE = arg('map-style', NATURAL_STYLE[THEME] ?? 'dark_ops')
const NO_TILES = flag('no-tiles') || flag('lean')
/** Lean: the chrome and the basemap only — no tiles, no market aggregates (the world clock still reads). */
const LEAN = flag('lean')
const PROBE = flag('probe')
const DEFAULT_STATES = MODE === 'full' ? 'rest,metro,national,street,colorby,lens,appearance,search' : 'rest,metro,peek,search,resize'
const STATES = arg('states', DEFAULT_STATES).split(',')
const MSP = [-93.265, 44.978]
const INFLIGHT_MS = 60_000

const MAP_GET = [
  /^\/api\/internal\/dashboard\/ops\/map\/tiles\/\d+\/\d+\/\d+$/,
  /^\/api\/internal\/dashboard\/ops\/map$/,
  /^\/api\/cockpit\/map\/world(\/zones)?$/,
]

await fs.mkdir(OUT, { recursive: true })
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: W, height: H }, serviceWorkers: 'block' })
await ctx.addInitScript(([t, style]) => {
  try {
    if (!sessionStorage.getItem('__mdp_capture')) { sessionStorage.clear(); sessionStorage.setItem('__mdp_capture', '1') }
    localStorage.removeItem('nexus.desktop.split')
    localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
    const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
    localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t }))
    const p = JSON.parse(localStorage.getItem('nexus.desktop.shell') || '{}')
    localStorage.setItem('nexus.desktop.shell', JSON.stringify({ ...p, collapsed: false }))
    localStorage.setItem('nx.map.visual-preset', style)
    localStorage.setItem('nexus.map.mobileActivity', JSON.stringify({ on: false, scope: 'all', window: 'today' }))
  } catch { /* ignore */ }
}, [THEME, STYLE])

const blocked = new Map(); const allowed = new Map(); const errors = []
const note = (m, k) => m.set(k, (m.get(k) || 0) + 1)
await ctx.routeWebSocket(/supabase\.co/, (ws) => { note(blocked, 'WS supabase realtime'); ws.close() })
await ctx.route('**/*', (route) => {
  const req = route.request(); const m = req.method(); const u = new URL(req.url())
  if (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS') { note(blocked, `${m} ${u.host}${u.pathname}`); return route.abort() }
  if (/supabase\.co$/.test(u.hostname)) { note(blocked, `GET supabase ${u.pathname.split('/').slice(0, 4).join('/')}`); return route.abort() }
  if (u.pathname.startsWith('/api/')) {
    if (NO_TILES && /\/ops\/map\/tiles\//.test(u.pathname)) { note(blocked, 'GET tiles (--no-tiles)'); return route.abort() }
    if (LEAN && /\/ops\/map$/.test(u.pathname)) { note(blocked, 'GET market aggregates (--lean)'); return route.abort() }
    if (MAP_GET.some((re) => re.test(u.pathname))) { note(allowed, `GET ${u.pathname.replace(/\/\d+\/\d+\/\d+$/, '/{z}/{x}/{y}')}`); return route.continue() }
    note(blocked, `GET ${u.pathname}`); return route.abort()
  }
  return route.continue()
})

const page = await ctx.newPage()
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
const inflight = new Map()
page.on('request', (r) => inflight.set(r, Date.now()))
page.on('requestfinished', (r) => inflight.delete(r))
page.on('requestfailed', (r) => inflight.delete(r))
const finish = async (code) => {
  console.log(JSON.stringify({ errors: errors.slice(0, 6), allowed: Object.fromEntries(allowed), blocked: Object.fromEntries(blocked) }, null, 1))
  await browser.close().catch(() => {})
  process.exit(code)
}
const guard = setInterval(() => {
  const now = Date.now()
  for (const [r, t] of inflight) if (now - t > INFLIGHT_MS) { console.error(`STOPPED: in flight > ${INFLIGHT_MS / 1000}s: ${r.method()} ${r.url().slice(0, 140)}`); clearInterval(guard); void finish(2); return }
}, 250)
const dog = setTimeout(() => { console.error('WATCHDOG'); void finish(3) }, 420_000)

const wait = (ms) => page.waitForTimeout(ms)
const name = (state) => `${TAG}-${THEME}-${W}-${MODE}-${state}`
const shot = async (state) => { await page.screenshot({ path: path.join(OUT, `${name(state)}.png`) }); console.log('shot', name(state)) }
const mapShot = async (state) => {
  const r = await page.evaluate(() => { const c = window.__nxMap?.getContainer(); if (!c) return null; const b = c.getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height } })
  if (!r) return shot(state)
  await page.screenshot({ path: path.join(OUT, `${name(state)}-pane.png`), clip: r })
  console.log('shot', `${name(state)}-pane`)
}
/** Raw pointer clicks — refused on anything that could write. */
const tap = async (sel) => {
  if (/send|ownership|retry|confirm|draft|launch|activate|publish|approve/i.test(sel)) throw new Error(`refusing to click a write control: ${sel}`)
  const c = await page.waitForFunction((q) => { const el = document.querySelector(q); if (!el) return null; const b = el.getBoundingClientRect(); return b.width ? [b.left + b.width / 2, b.top + b.height / 2] : null }, sel, { timeout: 15000 }).then((h) => h.jsonValue())
  await page.mouse.move(c[0], c[1]); await page.mouse.click(c[0], c[1])
}
const esc = async () => { await page.keyboard.press('Escape'); await wait(500) }
const jump = async (center, zoom) => {
  await page.evaluate(([c, z]) => window.__nxMap.jumpTo({ center: c, zoom: z, pitch: 0, bearing: 0 }), [center, zoom])
  await page.waitForFunction(() => window.__nxMap?.loaded?.() !== false, null, { timeout: 15000 }).catch(() => {})
  await wait(3200)
}
const paneRect = (label) => page.evaluate((a) => {
  const panes = [...document.querySelectorAll('[data-ws-pane]')]
  const hit = panes.find((p) => p.getAttribute('aria-label') === a) ?? panes[0]
  const r = hit.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }
}, label)
async function dragRow(appId, to) {
  const b = await page.locator(`.cr-row[data-app="${appId}"]`).boundingBox()
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width / 2 + 30, b.y + b.height / 2 + 6, { steps: 4 })
  await page.mouse.move(to.x, to.y, { steps: 18 })
  await wait(350)
  await page.mouse.up()
  await wait(1200)
}

await page.goto(`${BASE}${MODE === 'full' ? '/map' : '/inbox'}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForSelector('[data-ws-pane]', { timeout: 120000 })
await page.addStyleTag({ content: '[data-testid="dev-runtime-banner"]{display:none!important}' })
if (MODE !== 'full') {
  await wait(4000)
  let r = await paneRect('Inbox')
  await dragRow('map', { x: r.x + r.w / 2, y: r.y + r.h - 30 })
  if (MODE === 'quad') {
    await page.waitForSelector('[data-ws-pane][aria-label="Map"]', { timeout: 30000 })
    r = await paneRect('Map')
    await dragRow('deal-intelligence', { x: r.x + r.w - 40, y: r.y + r.h / 2 })
  }
}
await page.waitForSelector('.dsk-pane__body canvas.maplibregl-canvas', { timeout: 90000 })
await page.waitForFunction(() => Boolean(window.__nxMap), null, { timeout: 60000 })
await wait(2500)
console.log('panes', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('[data-ws-pane]')].map((p) => ({ app: p.getAttribute('aria-label'), w: Math.round(p.getBoundingClientRect().width), h: Math.round(p.getBoundingClientRect().height) })))))

if (PROBE) {
  const chain = await page.evaluate(() => {
    const out = []
    let el = document.querySelector('.mxd-lens') || document.querySelector('.mxd-rail')
    while (el && el !== document.documentElement) {
      const s = getComputedStyle(el)
      const hits = []
      if (s.filter !== 'none') hits.push(`filter:${s.filter}`)
      if (Number(s.opacity) < 1) hits.push(`opacity:${s.opacity}`)
      if (s.maskImage && s.maskImage !== 'none') hits.push('mask')
      if (s.clipPath !== 'none') hits.push(`clip:${s.clipPath}`)
      if (s.backdropFilter && s.backdropFilter !== 'none') hits.push(`backdrop:${s.backdropFilter.slice(0, 40)}`)
      if (s.mixBlendMode !== 'normal') hits.push(`blend:${s.mixBlendMode}`)
      if (s.willChange !== 'auto') hits.push(`will-change:${s.willChange}`)
      if (s.contain !== 'none') hits.push(`contain:${s.contain}`)
      if (s.containerType !== 'normal') hits.push(`container:${s.containerType}`)
      if (s.isolation !== 'auto') hits.push('isolate')
      if (hits.length) out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 3).join('.')} :: ${hits.join(' | ')}`)
      el = el.parentElement
    }
    return out
  })
  console.log('backdrop chain\n' + chain.join('\n'))
}

if (STATES.includes('rest')) { await jump(MSP, 12); await page.waitForSelector('.mxd-worldslot .nxw-chip', { timeout: 30000 }).catch(() => console.log('note: no world pill (time unresolved)')); await shot('rest-z12'); if (MODE !== 'full') await mapShot('rest-z12') }
if (STATES.includes('metro')) { await jump(MSP, 8.6); await shot('metro-z8'); if (MODE !== 'full') await mapShot('metro-z8') }
if (STATES.includes('national')) { await jump([-96.5, 38.6], 4.3); await shot('national-z4') }
if (STATES.includes('street')) { await jump([-93.2713, 44.9765], 15.6); await shot('street-z15') }
if (STATES.includes('legend')) {
  await jump(MSP, 12)
  const toggle = await page.$('.mxd-legend [aria-expanded]:not([data-map-control])')
  if (toggle) { await toggle.click(); await wait(700); await shot('legend-toggled'); await toggle.click(); await wait(500) }
}
if (STATES.includes('colorby')) { await tap('[data-map-control="color-by"]'); await wait(900); await shot('colorby'); await esc() }
if (STATES.includes('lens')) { await tap('[data-map-control="mode"]'); await wait(900); await shot('lens-picker'); await esc() }
if (STATES.includes('layers')) { await tap('[data-map-control="layers"]'); await wait(1100); await shot('layers'); await esc() }
if (STATES.includes('appearance')) { await tap('[data-map-control="appearance"]'); await wait(900); await shot('appearance'); await esc() }
if (STATES.includes('peek')) {
  // compact: the legend chip opens the key above it; Escape folds it again
  await tap('[data-map-control="legend"]'); await wait(700); await shot('legend-peek'); await mapShot('legend-peek')
  await esc()
}
if (STATES.includes('resize')) {
  // pane resize must keep the camera and leave no stale canvas
  const probe = () => page.evaluate(() => {
    const m = window.__nxMap; const c = m.getCanvas(); const box = m.getContainer().getBoundingClientRect()
    return { center: m.getCenter().toArray().map((v) => +v.toFixed(4)), zoom: +m.getZoom().toFixed(2), canvas: [c.clientWidth, c.clientHeight], container: [Math.round(box.width), Math.round(box.height)] }
  })
  const pane = page.locator('[data-ws-pane][aria-label="Map"]')
  const before = await probe()
  await pane.locator('button[aria-label="Maximize pane"]').click().catch(() => {}); await wait(1600)
  const max = await probe(); await shot('maximized')
  await pane.locator('button[aria-label="Restore layout"]').click().catch(() => {}); await wait(1600)
  const after = await probe()
  console.log('resize', JSON.stringify({ before, max, after }))
}
if (STATES.includes('search')) { await tap('[data-map-control="search"]'); await wait(700); await shot('search-focus'); if (MODE !== 'full') await mapShot('search-focus'); await page.evaluate(() => document.activeElement?.blur?.()); await wait(500) }

clearInterval(guard); clearTimeout(dog)
const info = await page.evaluate(() => ({
  pill: document.querySelector('.mxd-lens')?.textContent?.trim() || null,
  world: document.querySelector('.nxw-chip')?.textContent?.trim() || null,
  zoom: window.__nxMap?.getZoom?.().toFixed(2),
}))
console.log(JSON.stringify(info))
await finish(0)
