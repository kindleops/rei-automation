import { chromium } from 'playwright'
import fs from 'node:fs/promises'
/**
 * Map v4: pins toggle + tappable dots, pins over heat, comp taps (point +
 * cluster list), event card, filters glass. READ ONLY: every non-GET /api call
 * is aborted; no action button that could queue or send is ever tapped.
 */
const OUT = 'artifacts/map-v4'
await fs.mkdir(OUT, { recursive: true })
const THEME = process.argv.find((a) => a.startsWith('--theme='))?.slice(8) ?? 'dark'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
await ctx.addInitScript((t) => {
  const cur = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
  localStorage.setItem('nexus-settings', JSON.stringify({ ...cur, nexusTheme: t, liquidGlass: { preset: 'crystal', blur: 22, transparency: 62, sheen: 95 } }))
  // First load only: later steps change these and reload.
  if (!sessionStorage.getItem('v4-seeded')) {
    sessionStorage.setItem('v4-seeded', '1')
    localStorage.setItem('nexus.map.mobileLens', JSON.stringify({ lens: 'radar', mapKey: false, comps: false, pins: true, everyProperty: true }))
    localStorage.setItem('nexus.map.mobileActivity', JSON.stringify({ on: true, scope: 'all', window: 'all' }))
  }
}, THEME)
const page = await ctx.newPage()
let writes = 0
const blocked = []
await page.route('**/api/**', (r) => (['GET', 'OPTIONS'].includes(r.request().method()) ? r.continue() : (writes++, blocked.push(`${r.request().method()} ${r.request().url().replace(/^https?:\/\/[^/]+/, '').slice(0, 90)}`), r.abort())))
const errs = []; page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 120) + ' @ ' + String(e.stack || '').split('\n').slice(1, 6).join(' | ').slice(0, 600)))
await page.goto('http://localhost:5173/map', { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => Boolean(window.__nxMap), undefined, { timeout: 90000 })
await page.waitForTimeout(4000)
const report = {}
const settle = (ms = 4500) => page.waitForTimeout(ms)
const jump = (c, z) => page.evaluate(([c, z]) => window.__nxMap.jumpTo({ center: c, zoom: z }), [c, z])
const pointOn = (layers) => page.evaluate((layers) => {
  const m = window.__nxMap
  const present = layers.filter((l) => m.getLayer(l))
  const r = m.getCanvas().getBoundingClientRect()
  for (const f of m.queryRenderedFeatures({ layers: present })) {
    const p = m.project(f.geometry.coordinates)
    if (p.y > 260 && p.y < 520 && p.x > 40 && p.x < 320) return { x: r.left + p.x, y: r.top + p.y, props: f.properties }
  }
  return null
}, layers)

// 1 · dots at metro zoom → tap one → property preview
await jump([-95.4, 29.8], 10)
await page.waitForFunction(() => { const m = window.__nxMap; return m.getLayer('nx-dots-hit') && m.queryRenderedFeatures({ layers: ['nx-dots-hit'] }).some((f) => f.properties?.property_id) }, undefined, { timeout: 40000, polling: 500 }).catch(() => {})
await page.screenshot({ path: `${OUT}/${THEME}-1-dots.png` })
const dot = await page.evaluate(() => {
  const m = window.__nxMap
  if (!m.getLayer('nx-dots-hit')) return null
  const r = m.getCanvas().getBoundingClientRect()
  for (const f of m.queryRenderedFeatures({ layers: ['nx-dots-hit'] })) {
    if (!f.properties?.property_id) continue
    const p = m.project(f.geometry.coordinates)
    if (p.y > 260 && p.y < 520 && p.x > 40 && p.x < 320) return { x: r.left + p.x, y: r.top + p.y }
  }
  return null
})
report.dot = dot
if (dot) {
  await page.touchscreen.tap(dot.x, dot.y)
  await settle(3500)
  report.dotOpened = await page.evaluate(() => document.querySelectorAll('[class*="smc-"]').length)
  await page.screenshot({ path: `${OUT}/${THEME}-2-dot-preview.png` })
}

// 2 · pins over a heat lens
await page.evaluate(() => { localStorage.setItem('nexus.map.mobileLens', JSON.stringify({ lens: 'equity', mapKey: true, comps: false, pins: true, everyProperty: true })) })
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => Boolean(window.__nxMap), undefined, { timeout: 90000 })
await settle(3000)
await jump([-95.4, 29.75], 12.5)
await settle(6000)
await page.screenshot({ path: `${OUT}/${THEME}-3-pins-over-heat.png` })

// 3 · comps: a single sale and a small cluster
await page.evaluate(() => { localStorage.setItem('nexus.map.mobileLens', JSON.stringify({ lens: 'radar', mapKey: false, comps: true, pins: true, everyProperty: false })) })
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => Boolean(window.__nxMap), undefined, { timeout: 90000 })
await settle(3000)
await jump([-95.43, 29.85], 13.5)
await page.waitForFunction(() => { const m = window.__nxMap; return m.getLayer('nx-comps-point') && m.queryRenderedFeatures({ layers: ['nx-comps-point'] }).length > 0 }, undefined, { timeout: 30000, polling: 500 }).catch(() => {})
const comp = await pointOn(['nx-comps-point'])
report.comp = Boolean(comp)
if (comp) {
  await page.touchscreen.tap(comp.x, comp.y)
  await settle(3000)
  report.compCard = await page.locator('[data-map-card="comp"]').count()
  await page.screenshot({ path: `${OUT}/${THEME}-4-comp-tap.png` })
  await page.locator('.mx-comp__close').tap().catch(() => {})
}
await jump([-95.43, 29.85], 10.2)
await settle(5000)
const cl = await page.evaluate(() => {
  const m = window.__nxMap
  const r = m.getCanvas().getBoundingClientRect()
  for (const f of m.queryRenderedFeatures({ layers: ['nx-comps-cluster'] })) {
    const n = Number(f.properties?.n)
    if (n < 2 || n > 60) continue
    const p = m.project(f.geometry.coordinates)
    if (p.y > 260 && p.y < 560 && p.x > 40 && p.x < 320) return { x: r.left + p.x, y: r.top + p.y, n }
  }
  return null
})
report.cluster = cl
if (cl) {
  await page.touchscreen.tap(cl.x, cl.y)
  await settle(2500)
  report.clusterRows = await page.locator('[data-comp-row]').count()
  await page.screenshot({ path: `${OUT}/${THEME}-5-comp-cluster-list.png` })
  await page.locator('[data-map-sheet-close]').first().tap().catch(() => {})
}

// 4 · Live Activity event card (first feed row)
await page.locator('[data-map-control="activity-feed"]').tap().catch(() => {})
await settle(1500)
const row = page.locator('[data-activity-row]').first()
if (await row.count()) {
  await row.tap()
  await settle(2500)
  report.eventCard = await page.locator('[data-map-card="event"]').textContent().catch(() => null)
  await page.screenshot({ path: `${OUT}/${THEME}-6-event-card.png` })
  await page.locator('[data-map-card="event"] [data-map-sheet-close]').tap().catch(() => {})
}

// 5 · filters panel in Crystal glass
await page.locator('[data-map-control="filters"]').tap()
await settle(2000)
await page.screenshot({ path: `${OUT}/${THEME}-7-filters-glass.png` })
report.filtersGlass = await page.evaluate(() => {
  const el = document.querySelector('.nx-ifm-modal')
  return el ? getComputedStyle(el).backdropFilter || getComputedStyle(el).webkitBackdropFilter : null
})
console.log(JSON.stringify({ report: { ...report, eventCard: report.eventCard?.slice(0, 260) }, writes, blocked, errs }, null, 1))
await browser.close()
