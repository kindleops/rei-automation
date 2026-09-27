import { chromium } from 'playwright'
import fs from 'node:fs/promises'
/**
 * Map v5: pins in Atlanta + pins toggle, seller card peek → detail → full,
 * Look Around exit, close / tap-away clears the star, modes (none, radar,
 * execution, areas), comps lens without the legacy comp card, and the
 * Live Activity → exact conversation deep link.
 * READ ONLY: every non-GET /api call is aborted; no send/primary button is tapped.
 */
const OUT = 'artifacts/map-v5'
await fs.mkdir(OUT, { recursive: true })
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
await ctx.addInitScript(() => {
  if (!sessionStorage.getItem('v5-seeded')) {
    sessionStorage.setItem('v5-seeded', '1')
    localStorage.setItem('nexus.map.mobileLens', JSON.stringify({ lens: 'none', mapKey: false, comps: false, pins: true, everyProperty: true }))
    localStorage.setItem('nexus.map.mobileActivity', JSON.stringify({ on: true, scope: 'all', window: 'all' }))
  }
})
const page = await ctx.newPage()
let writes = 0
const blocked = []
await page.route('**/api/**', (r) => (['GET', 'OPTIONS'].includes(r.request().method()) ? r.continue() : (writes++, blocked.push(`${r.request().method()} ${r.request().url().replace(/^https?:\/\/[^/]+/, '').slice(0, 90)}`), r.abort())))
const errs = []; page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)))
const tileStatus = {}
page.on('response', (r) => { const u = r.url(); if (u.includes('/map/tiles/')) { const k = u.includes('dots=1') ? 'dots' : 'tiles'; tileStatus[`${k}:${r.status()}`] = (tileStatus[`${k}:${r.status()}`] || 0) + 1 } })
const boot = async () => { await page.waitForFunction(() => Boolean(window.__nxMap), undefined, { timeout: 90000 }); await page.waitForTimeout(3500) }
await page.goto('http://localhost:5173/map', { waitUntil: 'domcontentloaded' })
await boot()
const R = {}
const settle = (ms = 4000) => page.waitForTimeout(ms)
const jump = (c, z) => page.evaluate(([c, z]) => window.__nxMap.jumpTo({ center: c, zoom: z }), [c, z])
const count = (layers) => page.evaluate((layers) => { const m = window.__nxMap; const p = layers.filter((l) => m.getLayer(l)); return p.length ? m.queryRenderedFeatures({ layers: p }).length : -1 }, layers)
const star = () => page.evaluate(() => { const s = window.__nxMap.getSource('command-selected-star'); return s?._data?.features?.length ?? s?.serialize?.().data?.features?.length ?? null })
const setLens = async (prefs) => { await page.evaluate((p) => localStorage.setItem('nexus.map.mobileLens', JSON.stringify(p)), prefs); await page.reload({ waitUntil: 'domcontentloaded' }); await boot() }

// 1 · Atlanta metro: dots + pins
await jump([-84.39, 33.75], 10.5); await settle(7000)
R.atlDots = await count(['nx-dots-core'])
await page.screenshot({ path: `${OUT}/1-atlanta-z10.png` })
await jump([-84.39, 33.75], 12.5); await settle(7000)
R.atlPinsZ125 = await count(['prop-tiles-hit'])
await page.screenshot({ path: `${OUT}/2-atlanta-z12.png` })

// 2 · tap a pin → peek
const pin = await page.evaluate(() => {
  const m = window.__nxMap; const r = m.getCanvas().getBoundingClientRect()
  for (const f of m.queryRenderedFeatures({ layers: ['prop-tiles-hit'].filter((l) => m.getLayer(l)) })) {
    const p = m.project(f.geometry.coordinates)
    if (p.y > 250 && p.y < 420 && p.x > 60 && p.x < 330) return { x: r.left + p.x, y: r.top + p.y }
  }
  return null
})
R.pin = Boolean(pin)
if (pin) {
  await page.touchscreen.tap(pin.x, pin.y); await settle(3500)
  R.peek = await page.locator('.smc-shell.is-peek').count()
  R.peekActs = await page.locator('[data-seller-action]').evaluateAll((els) => els.map((e) => e.textContent?.trim()))
  R.starOpen = await star()
  await page.screenshot({ path: `${OUT}/3-peek.png` })
  // chips overlap check
  R.chipOverlap = await page.evaluate(() => {
    const chips = [...document.querySelectorAll('.smc-mpeek__chip')].map((e) => e.getBoundingClientRect())
    const look = document.querySelector('.smc-mpeek__look')?.getBoundingClientRect()
    const over = document.querySelector('.smc-mpeek__over')?.getBoundingClientRect()
    const hit = (a, b) => a && b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
    return chips.some((c) => hit(c, look) || hit(c, over))
  })
  // Details (not the send button)
  await page.locator('[data-seller-action="details"]').tap(); await settle(1800)
  R.focus = await page.locator('.smc-shell.is-focus').count()
  await page.screenshot({ path: `${OUT}/4-detail.png` })
  await page.locator('.smc-shell.is-focus .smc-body--dossier-scroll').tap({ position: { x: 30, y: 10 } }).catch(() => {}); await settle(1500)
  R.sheetH = await page.evaluate(() => document.querySelector('.smc-mobile-bottom-sheet')?.getBoundingClientRect().height)
  await page.screenshot({ path: `${OUT}/5-full.png` })
  R.footer = await page.locator('.smc-actions button').evaluateAll((els) => els.map((e) => e.textContent?.trim()))
}

// 3 · close → star gone; reopen + tap-away
if (pin) {
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))); await settle(1500)
  R.afterEsc = { cards: await page.locator('.smc-shell').count(), star: await star() }
  await page.touchscreen.tap(pin.x, pin.y); await settle(3000)
  R.reopen = await page.locator('.smc-shell').count()
  const empty = await page.evaluate(() => {
    const m = window.__nxMap; const r = m.getCanvas().getBoundingClientRect()
    const layers = m.getStyle().layers.map((l) => l.id).filter((id) => /^(prop-|seller-|command-|nx-dots|nx-comps|nx-mx|map-agg)/.test(id))
    for (let y = 330; y < 480; y += 18) for (let x = 40; x < 300; x += 18) {
      if (!m.queryRenderedFeatures([[x - 16, y - 16], [x + 16, y + 16]], { layers }).length) return { x: r.left + x, y: r.top + y }
    }
    return null
  })
  R.emptyPoint = empty
  if (empty) await page.touchscreen.tap(empty.x, empty.y); await settle(2000)
  R.afterTapAway = { cards: await page.locator('.smc-shell').count(), star: await star() }
  await page.screenshot({ path: `${OUT}/6-after-tapaway.png` })
}

// 4 · pins toggle off
await setLens({ lens: 'none', pins: false, everyProperty: true, mapKey: false })
await jump([-84.39, 33.75], 12.5); await settle(6000)
R.pinsOffVisible = await page.evaluate(() => { const m = window.__nxMap; return m.getStyle().layers.filter((l) => /^(prop-tiles-|prop-univ-|seller-pins-|command-pin-)/.test(l.id) && m.getLayoutProperty(l.id, 'visibility') !== 'none').map((l) => l.id) })
await page.screenshot({ path: `${OUT}/7-pins-off.png` })

// 5 · modes
for (const [lens, style, c, z, name] of [
  ['radar', 'surface', [-84.39, 33.75], 9.5, '8-radar'],
  ['execution', 'surface', [-90, 36], 4, '9-execution'],
  ['territory', 'areas', [-84.39, 33.75], 9.5, '10-territory-areas'],
  ['equity', 'areas', [-96, 38], 3.6, '11-equity-areas-natl'],
  ['distress', 'areas', [-84.39, 33.75], 8, '12-distress-areas'],
  ['investor_price', 'surface', [-84.39, 33.75], 11, '13-investor-price'],
]) {
  await setLens({ lens, lensStyle: style, pins: true, everyProperty: true, mapKey: true })
  await jump(c, z); await settle(8000)
  R[name] = { areas: await count(['nx-lens-area-fill']), field: await count(['nx-lens-field']), heat: await page.evaluate(() => window.__nxMap.getLayer('nx-lens-heat') ? window.__nxMap.getLayoutProperty('nx-lens-heat', 'visibility') : null), err: await page.locator('.mx-legend').textContent().catch(() => null) }
  await page.screenshot({ path: `${OUT}/${name}.png` })
}
R.legacyCompsCard = await page.locator('.nx-sold-comp-card, [class*="sold-comp-card"]').count()

// 6 · Live Activity → Open conversation → Inbox thread
await setLens({ lens: 'none', pins: true, everyProperty: true, mapKey: false })
await page.locator('[data-map-control="activity-feed"]').tap().catch(() => {}); await settle(1500)
const rows = page.locator('[data-activity-row]')
R.feedRows = await rows.count()
for (let i = 0; i < Math.min(8, R.feedRows); i++) {
  await rows.nth(i).tap(); await settle(2000)
  const conv = page.locator('[data-evt-action="conversation"]')
  if (await conv.count()) {
    R.evtSeller = (await page.locator('.mx-evt__title strong').textContent().catch(() => ''))?.trim()
    await conv.tap(); await settle(9000)
    R.inboxUrl = page.url().replace(/^https?:\/\/[^/]+/, '')
    R.threadOpen = await page.evaluate(() => ({
      name: document.querySelector('[class*="thread-header"] [class*="name"], .nx-conv-header__name, [data-thread-header-name]')?.textContent?.trim() ?? null,
      hasComposer: Boolean(document.querySelector('.nx-composer, [class*="composer"]')),
      threadOpenClass: Boolean(document.querySelector('.m-thread-open')),
      text: document.body.innerText.slice(0, 400),
    }))
    await page.screenshot({ path: `${OUT}/14-conversation.png` })
    break
  }
  await page.locator('[data-map-card="event"] [data-map-sheet-close]').tap().catch(() => {})
  await page.locator('[data-map-control="activity-feed"]').tap().catch(() => {}); await settle(800)
}
console.log(JSON.stringify({ R, tileStatus, writes, blocked: blocked.slice(0, 12), errs: errs.slice(0, 8) }, null, 1))
await browser.close()
