import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * LIVING MAP — capture matrix (READ ONLY: every non-GET /api call aborted).
 *
 *   national   country zoom: sunset line, day/night bands, zone clocks, chip
 *   city       Minneapolis z11: place · local time · contact window chip
 *   popover    the chip's context popover
 *   tilted     downtown Minneapolis z16, pitched: real building volumes
 *   settings   Layers → Appearance → Living Map block
 *   off        Living Map disabled: the map as before (no world layers)
 *
 *   node scripts/proof/mobile/map-living-capture.mjs --theme=dark --width=390
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const THEME = arg('theme', 'dark')
const MAP_THEME = arg('map', '')
const DESKTOP = process.argv.includes('--desktop')
const WIDTH = Number(arg('width', DESKTOP ? 1440 : 390))
const SIZES = { 375: 812, 390: 844, 393: 852, 430: 932 }
const OUT = path.resolve(arg('out', 'artifacts/map-living'))
await fs.mkdir(OUT, { recursive: true })

const browser = await chromium.launch()
const ctx = await browser.newContext(DESKTOP
  ? { viewport: { width: WIDTH, height: 900 }, deviceScaleFactor: 1, timezoneId: 'America/Chicago' }
  : { viewport: { width: WIDTH, height: SIZES[WIDTH] ?? 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId: 'America/Chicago' })
await ctx.addInitScript(([t]) => {
  const cur = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
  localStorage.setItem('nexus-settings', JSON.stringify({ ...cur, nexusTheme: t }))
  localStorage.setItem('nx.map.verification.mode', '1') // exposes __nexusSetMapTheme
}, [THEME])
const page = await ctx.newPage()
const errors = []; const blocked = []
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
await page.route('**/api/**', (r) => { const m = r.request().method(); if (['GET', 'OPTIONS'].includes(m)) return r.continue(); blocked.push(`${m} ${new URL(r.request().url()).pathname}`); return r.abort() })
const tag = `${DESKTOP ? 'desktop-' : ''}${THEME}${MAP_THEME ? `-${MAP_THEME}` : ''}-${WIDTH}`
const shot = async (name) => { await page.screenshot({ path: `${OUT}/${tag}-${name}.png` }); console.log('shot', name) }
const idle = (ms = 1500) => page.evaluate((ms) => new Promise((resolve) => {
  const m = window.__nxMap
  if (!m) return setTimeout(resolve, ms)
  let done = false
  const finish = () => { if (!done) { done = true; setTimeout(resolve, ms) } }
  if (m.loaded() && !m.isMoving()) finish()
  m.once('idle', finish)
  setTimeout(finish, 15000)
}), ms)
const jump = (o) => page.evaluate((o) => window.__nxMap?.jumpTo(o), o)
const audit = () => page.evaluate(() => ({
  overflowX: document.documentElement.scrollWidth - innerWidth,
  chip: document.querySelector('.nxw-chip')?.textContent || null,
  zones: document.querySelectorAll('.nxw-zone').length,
  layers: (window.__nxMap?.getStyle()?.layers || []).map((l) => l.id).filter((i) => i.startsWith('nx-world')),
  buildingsVisible: (() => { const m = window.__nxMap; try { return m?.getLayer('nx-world-bld') ? m.getLayoutProperty('nx-world-bld', 'visibility') : 'absent' } catch { return 'err' } })(),
  renderedBuildings: (() => { const m = window.__nxMap; try { return m?.getLayer('nx-world-bld') ? m.queryRenderedFeatures({ layers: ['nx-world-bld'] }).length : 0 } catch { return -1 } })(),
}))

const R = {}
await page.goto(`${BASE}/map`, { waitUntil: 'domcontentloaded', timeout: 180000 })
await page.waitForFunction(() => Boolean(window.__nxMap), undefined, { timeout: 120000 }).catch(() => {})
await page.waitForSelector('.nxw-chip', { timeout: 60000 }).catch(() => {})
if (MAP_THEME) { await page.evaluate((id) => window.__nexusSetMapTheme?.(id), MAP_THEME); await page.waitForTimeout(2500); await idle(1500) }
await jump({ center: [-95.5, 38.2], zoom: 2.35, pitch: 0, bearing: 0 })
await idle(3000)
await page.waitForFunction(() => document.querySelectorAll('.nxw-zone').length > 0, undefined, { timeout: 30000 }).catch(() => {})
await shot('01-national'); R.national = await audit()

await jump({ center: [-93.27, 44.98], zoom: 11, pitch: 0, bearing: 0 })
await idle(2500)
await page.waitForFunction(() => /CT/.test(document.querySelector('.nxw-chip')?.textContent || ''), undefined, { timeout: 30000 }).catch(() => {})
await shot('02-city'); R.city = await audit()
await page.locator('.nxw-chip').click().catch(() => {})
await page.waitForTimeout(700)
await shot('03-popover'); R.popover = (await page.locator('.nxw-pop').innerText().catch(() => '')).replace(/\n+/g, ' | ')
await page.locator('.nxw-chip').click().catch(() => {})

if (DESKTOP) {
  R.errors = errors; R.blocked = blocked
  R.chipBox = await page.evaluate(() => { const r = document.querySelector('.nxw')?.getBoundingClientRect(); return r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null })
  await fs.writeFile(`${OUT}/${tag}-results.json`, JSON.stringify(R, null, 2))
  console.log(JSON.stringify(R, null, 1))
  await browser.close()
  process.exit(0)
}
// Tilt through the operator's own control, then descend into downtown.
await page.locator('[data-map-control="layers"]').click()
await page.waitForTimeout(500)
await page.locator('.mx-seg__tab', { hasText: 'Appearance' }).click()
await page.waitForTimeout(500)
await page.locator('.mx-block h3', { hasText: 'Living Map' }).scrollIntoViewIfNeeded().catch(() => {})
await page.waitForTimeout(400)
await shot('04-settings'); R.settings = (await page.locator('.mx-block', { hasText: 'Living Map' }).first().innerText().catch(() => '')).replace(/\n+/g, ' | ').slice(0, 400)
await page.locator('.mx-seg__tab', { hasText: 'Tilted' }).click().catch(() => {})
await page.waitForTimeout(400)
await page.locator('[data-map-sheet-close]').first().click().catch(() => {})
await page.waitForTimeout(600)
await jump({ center: [-93.2715, 44.9765], zoom: 16, pitch: 58, bearing: -18 })
await idle(4000)
await shot('05-tilted-downtown'); R.tilted = await audit()

// Master switch off: the map exactly as before — no world layers, no chip.
await page.evaluate(() => { localStorage.setItem('nexus.map.living', JSON.stringify({ enabled: false, daylight: true, localTime: true, buildings: true, zones: true })); window.dispatchEvent(new CustomEvent('nexus:living-map')) })
await jump({ center: [-93.27, 44.98], zoom: 11, pitch: 0, bearing: 0 })
await idle(2500)
await shot('06-off'); R.off = await audit()
await page.evaluate(() => { localStorage.removeItem('nexus.map.living'); window.dispatchEvent(new CustomEvent('nexus:living-map')) })

R.errors = errors; R.blocked = blocked
await fs.writeFile(`${OUT}/${tag}-results.json`, JSON.stringify(R, null, 2))
console.log(JSON.stringify(R, null, 1))
await browser.close()
