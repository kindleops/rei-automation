import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * MAP + LIVE ACTIVITY — mobile capture matrix.
 *
 * READ ONLY. Every non-GET API call is aborted (the seller card's primary
 * action can SEND an ownership-check SMS — it is never tapped here, and the
 * route guard would abort it anyway).
 *
 * Pins are tapped the way an operator taps them: a rendered pin feature is
 * found through the dev-only map handle (window.__nxMap), projected to a
 * screen point, and tapped there.
 *
 *   node scripts/proof/mobile/map-elite-capture.mjs --label=before --width=390 --theme=dark
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const LABEL = arg('label', 'after')
const SIZES = { 375: 812, 390: 844, 393: 852, 430: 932 }
const WIDTHS = arg('width', '375,390,393,430').split(',').map(Number)
const THEMES = arg('theme', 'dark,light,true_black,red_ops').split(',')
const ONLY = arg('states', '') ? new Set(arg('states', '').split(',')) : null
const OUT = path.resolve(arg('out', `artifacts/map-elite/${LABEL}`))
await fs.mkdir(OUT, { recursive: true })

const PIN_LAYERS = ['command-pin-core-raw', 'command-pin-icon-raw', 'command-pin-core-clustered', 'command-pin-icon-clustered', 'prop-tiles-hit', 'prop-tiles-icon']
const CLUSTER_LAYERS = ['command-pin-cluster-core', 'seller-pins-cluster', 'command-pin-cluster']

const waitIdle = (page, ms = 1200) => page.evaluate((ms) => new Promise((resolve) => {
  const m = window.__nxMap
  if (!m) return setTimeout(resolve, ms)
  let done = false
  const finish = () => { if (!done) { done = true; setTimeout(resolve, ms) } }
  if (m.loaded() && !m.isMoving()) finish()
  m.once('idle', finish)
  setTimeout(finish, 12000)
}), ms)

const pinPoint = (page, layers) => page.evaluate((layers) => {
  const m = window.__nxMap
  if (!m) return null
  const present = layers.filter((l) => m.getLayer(l))
  if (!present.length) return null
  const feats = m.queryRenderedFeatures({ layers: present })
  const canvas = m.getCanvas().getBoundingClientRect()
  const H = window.innerHeight
  for (const f of feats) {
    const g = f.geometry
    if (!g || g.type !== 'Point') continue
    const p = m.project(g.coordinates)
    const x = canvas.left + p.x, y = canvas.top + p.y
    // inside the map, clear of the top chrome and the bottom dock
    if (x > 60 && x < window.innerWidth - 90 && y > 230 && y < H * 0.5) return { x, y, layer: f.layer.id }
  }
  return null
}, layers)

const results = []
const browser = await chromium.launch()
for (const width of WIDTHS) {
  for (const theme of THEMES) {
    const cell = `${width}-${theme}`
    const ctx = await browser.newContext({ viewport: { width, height: SIZES[width] ?? 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
    await ctx.addInitScript((t) => {
      try {
        const cur = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
        localStorage.setItem('nexus-settings', JSON.stringify({ ...cur, nexusTheme: t }))
      } catch {}
    }, theme)
    const page = await ctx.newPage()
    let writes = 0
    await page.route('**/api/**', (r) => (['GET', 'OPTIONS'].includes(r.request().method()) ? r.continue() : (writes++, r.abort())))
    const errs = []; page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 120)))
    const done = []; const missed = []
    const want = (s) => !ONLY || ONLY.has(s)
    const shot = async (s) => { await page.screenshot({ path: `${OUT}/${cell}-${s}.png` }); done.push(s) }
    const step = async (s, fn) => { if (!want(s)) return; try { await fn() } catch (e) { missed.push(`${s}: ${String(e.message).split('\n')[0].slice(0, 90)}`) } }
    const closeSheets = async () => {
      await page.keyboard.press('Escape').catch(() => {})
      for (const sel of ['[data-map-sheet-close]', '.nx-icm__controls-close', '.nx-ifm-modal [aria-label="Close"]', '.nx-ifm-modal__close']) {
        const c = page.locator(sel).first()
        if (await c.count() && await c.isVisible().catch(() => false)) await c.tap().catch(() => {})
      }
      await page.waitForTimeout(500)
    }

    await page.goto(`${BASE}/map`, { waitUntil: 'domcontentloaded', timeout: 180000 })
    await page.addStyleTag({ content: ':root{--nx-mobile-safe-bottom:34px !important}' })
    await page.waitForSelector('canvas.maplibregl-canvas', { timeout: 120000 })
    await page.waitForFunction(() => Boolean(window.__nxMap), undefined, { timeout: 60000 }).catch(() => {})
    await page.waitForTimeout(6000); await waitIdle(page, 1500)

    await step('default', () => shot('default'))

    await step('dense', async () => {
      await page.evaluate(() => window.__nxMap?.jumpTo({ center: [-95.40, 29.74], zoom: 11.2 }))
      await page.waitForFunction(() => { const m = window.__nxMap; return m && m.getLayer('prop-tiles-hit') && m.queryRenderedFeatures({ layers: ['prop-tiles-hit'] }).length > 20 }, undefined, { timeout: 30000, polling: 500 }).catch(() => {})
      await waitIdle(page, 1500)
      await shot('dense')
    })

    await step('selected', async () => {
      let pt = await pinPoint(page, PIN_LAYERS)
      if (!pt) {
        await page.evaluate(() => window.__nxMap?.jumpTo({ center: [-95.40, 29.74], zoom: 12 }))
        await page.waitForFunction(() => { const m = window.__nxMap; return m && m.getLayer('prop-tiles-hit') && m.queryRenderedFeatures({ layers: ['prop-tiles-hit'] }).length > 5 }, undefined, { timeout: 30000, polling: 500 }).catch(() => {})
        await waitIdle(page, 1500); pt = await pinPoint(page, PIN_LAYERS)
      }
      if (!pt) throw new Error('no rendered pin to tap')
      await page.touchscreen.tap(pt.x, pt.y)
      await page.waitForTimeout(2500)
      await shot('selected')
      // expand the card the way an operator would: tap it / drag its handle up
      const expand = page.locator('[data-map-card-expand], .smc-body--peek, .nx-mobile-bottom-sheet__handle').first()
      if (await expand.count()) { await expand.tap().catch(() => {}); await page.waitForTimeout(1500) }
      if (want('selected-expanded')) await shot('selected-expanded')
      await closeSheets()
    })

    await step('modes', async () => {
      const t = page.locator('[data-map-control="mode"]').first()
      if (!(await t.count())) throw new Error('no mode control')
      await t.tap(); await page.waitForTimeout(900); await shot('modes')
      const tab = page.locator('.mx-seg__tab', { hasText: 'Appearance' }).first()
      if (await tab.count()) { await tab.tap(); await page.waitForTimeout(500); await shot('appearance') }
      await closeSheets()
    })

    await step('controls', async () => {
      const t = page.locator('[data-map-control="layers"], .nx-icm__mode-tab:not(.nx-icm__mode-tab--filters)').first()
      await t.tap(); await page.waitForTimeout(900); await shot('controls'); await closeSheets()
    })

    await step('filters', async () => {
      const t = page.locator('[data-map-control="filters"], .nx-icm__mode-tab--filters').first()
      await t.tap(); await page.waitForTimeout(1500); await shot('filters'); await closeSheets()
    })

    await step('activity', async () => {
      await page.evaluate(() => window.__nxMap?.jumpTo({ center: [-96, 37.5], zoom: 3.6 }))
      await waitIdle(page, 1500)
      const t = page.locator('[data-map-control="activity"], .nx-icm-activity').first()
      if (!(await t.count())) throw new Error('no activity control')
      const on = await t.getAttribute('aria-pressed')
      if (on !== 'true') { await t.tap().catch(() => {}); await page.waitForTimeout(1800) }
      await shot('activity')
      const peek = page.locator('[data-map-control="activity-feed"]').first()
      if (await peek.count()) {
        await peek.tap(); await page.waitForTimeout(900); await shot('activity-feed')
        const row = page.locator('[data-activity-row]').first()
        if (await row.count()) { await row.tap(); await page.waitForTimeout(900); await shot('activity-event') }
      }
      await closeSheets()
    })

    const geo = await page.evaluate(() => {
      const doc = document.documentElement
      const dock = document.querySelector('.nx-pinned-app-dock__glass')?.getBoundingClientRect()
      const obscured = []
      for (const n of document.querySelectorAll('.nx-icm button, .nx-icm [role="button"], [data-map-control]')) {
        const r = n.getBoundingClientRect()
        if (r.width < 6 || r.height < 6 || r.bottom <= 0 || r.top >= innerHeight) continue
        const cs = getComputedStyle(n); if (cs.visibility === 'hidden' || cs.pointerEvents === 'none' || Number(cs.opacity) === 0) continue
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        if (hit && hit !== n && !n.contains(hit) && !hit.contains(n)) obscured.push((n.getAttribute('aria-label') || n.textContent || '').trim().slice(0, 24))
      }
      return { overflowX: doc.scrollWidth - doc.clientWidth, dockTop: dock ? Math.round(dock.top) : null, obscured: obscured.slice(0, 8) }
    })
    results.push({ cell, done, missed, writes, errs: errs.slice(0, 4), geo })
    console.log(cell, 'shots', done.length, 'missed', missed.length ? missed : '-', 'overflowX', geo.overflowX, 'obscured', geo.obscured.length ? geo.obscured : '-', 'writes', writes)
    await ctx.close()
  }
}
await browser.close()
await fs.writeFile(`${OUT}/results.json`, JSON.stringify(results, null, 1))
