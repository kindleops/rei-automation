/**
 * MOBILE MAP LAYOUT PROOF.
 *
 * The mobile Map stacks six independently-positioned fixed layers — global header,
 * map controls, the map itself, Live Activity, the selected-property sheet and the app
 * dock — and each one was positioned without reference to the others. This measures
 * the actual vertical bounds of every layer in every state the operator can reach, so
 * "they compete" is a number rather than an impression.
 *
 * Two failures are reported explicitly because they are the ones that cost the
 * operator an action rather than just looking untidy:
 *
 *   OBSCURED   actionable content (a button, a link, an input) whose centre is painted
 *              by a DIFFERENT fixed surface — i.e. the operator can see it and cannot
 *              press it.
 *   OVERFLOW   any horizontal document overflow.
 *
 * Usage:
 *   node scripts/proof/mobile/map-layout-qa.mjs --label before --width 390 --theme dark
 */
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d }
const BASE = arg('base', 'http://localhost:5174')
const LABEL = arg('label', 'run')
const WIDTH = Number(arg('width', '390'))
const HEIGHT = Number(arg('height', '844'))
const THEME = arg('theme', 'dark')
const OUT = path.resolve(process.cwd(), '.screenshots/map-layout', LABEL, `${WIDTH}-${THEME}`)

/** The layers that own vertical space, in paint order top to bottom. */
const LAYERS = {
  globalHeader: '.nx-mobile-command-dock',
  mapControls: '.nx-icm__toolbar',
  liveActivity: '.nx-icm-activity',
  propertySheet: '.smc-shell',
  dock: '.nx-pinned-app-dock__glass',
}

const PROBE = (layers) => {
  const rect = (selector) => {
    const el = document.querySelector(selector)
    if (!el) return null
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden') return null
    return {
      top: Math.round(r.top), bottom: Math.round(r.bottom),
      height: Math.round(r.height), width: Math.round(r.width),
      opacity: Number(cs.opacity),
    }
  }

  const bounds = {}
  for (const [name, selector] of Object.entries(layers)) bounds[name] = rect(selector)

  /**
   * Actionable content the operator can see but cannot press, because a different
   * fixed surface is painted at its centre. This is the measurement that matters —
   * two panels merely overlapping is fine if neither one's controls are buried.
   */
  const obscured = []
  const actionable = document.querySelectorAll(
    'button:not([disabled]), a[href], input:not([type=hidden]), [role="button"]:not([aria-disabled="true"])',
  )
  for (const node of actionable) {
    const r = node.getBoundingClientRect()
    if (r.width < 6 || r.height < 6) continue
    if (r.bottom <= 0 || r.top >= window.innerHeight) continue
    const cs = getComputedStyle(node)
    if (cs.visibility === 'hidden' || Number(cs.opacity) === 0 || cs.pointerEvents === 'none') continue

    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    if (cx < 0 || cx > window.innerWidth) continue
    const painted = document.elementFromPoint(cx, cy)
    if (!painted) continue
    if (node === painted || node.contains(painted) || painted.contains(node)) continue

    // A scrim/backdrop deliberately covering things is intent, not a defect.
    const paintedClass = String(painted.className || '')
    if (/backdrop|scrim|overlay-close/i.test(paintedClass)) continue

    // Clipped out of view by an ancestor (the dock keeps its panel and catalogue
    // mounted behind a max-height of 0). Those controls are not "obscured" — they are
    // closed, and counting them would drown the real findings.
    let clipped = false
    for (let el = node.parentElement; el; el = el.parentElement) {
      const cs = getComputedStyle(el)
      if (cs.overflow === 'visible') continue
      const box = el.getBoundingClientRect()
      if (r.bottom <= box.top + 0.5 || r.top >= box.bottom - 0.5
        || r.right <= box.left + 0.5 || r.left >= box.right - 0.5) { clipped = true; break }
    }
    if (clipped) continue

    // A transient overlay with its own backdrop (the open app dock) is covering things
    // ON PURPOSE. Only count what is buried during ordinary use.
    if (document.querySelector('.nx-pinned-app-dock__backdrop')) continue

    obscured.push({
      label: (node.getAttribute('aria-label') || node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
      own: String(node.className || '').slice(0, 46),
      coveredBy: paintedClass.slice(0, 46),
      at: [Math.round(cx), Math.round(cy)],
    })
  }

  const doc = document.scrollingElement || document.documentElement
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    bounds,
    // How much of the viewport the map itself actually gets.
    mapVisibleHeight: (() => {
      const canvas = document.querySelector('canvas.maplibregl-canvas')
      if (!canvas) return null
      const r = canvas.getBoundingClientRect()
      const topChrome = Math.max(0, (bounds.globalHeader?.bottom ?? 0), (bounds.mapControls?.bottom ?? 0))
      const bottomChrome = Math.min(
        bounds.propertySheet && bounds.propertySheet.opacity > 0 ? bounds.propertySheet.top : window.innerHeight,
        bounds.liveActivity ? bounds.liveActivity.top : window.innerHeight,
        bounds.dock ? bounds.dock.top : window.innerHeight,
      )
      return Math.max(0, Math.round(Math.min(bottomChrome, r.bottom) - Math.max(topChrome, r.top)))
    })(),
    horizontalOverflowPx: Math.max(0, doc.scrollWidth - window.innerWidth),
    obscured: obscured.slice(0, 12),
    obscuredCount: obscured.length,
  }
}

const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
})
await context.addInitScript((theme) => {
  try {
    const raw = localStorage.getItem('nexus-settings')
    localStorage.setItem('nexus-settings', JSON.stringify({ ...(raw ? JSON.parse(raw) : {}), nexusTheme: theme }))
  } catch { /* first run */ }
}, THEME)
await fs.mkdir(OUT, { recursive: true })

const page = await context.newPage()
const consoleErrors = []
page.on('pageerror', (e) => consoleErrors.push(String(e).slice(0, 160)))
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)) })

const capture = async (state) => {
  await page.waitForTimeout(1200)
  const probe = await page.evaluate(PROBE, LAYERS)
  await page.screenshot({ path: path.join(OUT, `${state}.png`) })
  return { state, ...probe }
}

const results = []

// ── no property selected ────────────────────────────────────────────────────
await page.goto(`${BASE}/map`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
await page.waitForSelector('canvas.maplibregl-canvas', { timeout: 60_000 })
await page.waitForTimeout(13_000)
results.push(await capture('01-no-selection'))

// ── property selected, via the Inbox so the subject is real ─────────────────
await page.goto(`${BASE}/inbox`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
await page.waitForSelector('.nx-row25', { timeout: 60_000 })
await page.waitForTimeout(5000)
await (await page.$$('.nx-row25'))[0].click()
await page.waitForTimeout(3500)
const subject = await page.evaluate(() => {
  try { return JSON.parse(sessionStorage.getItem('nexus:property-locator:v1') || 'null') } catch { return null }
})
await page.click('.nx-pinned-app-dock__handle')
await page.waitForTimeout(700)
await (await page.$('.nx-pinned-app-dock__track .nx-pinned-app-dock__app[aria-label="Map"]'))?.click()
await page.waitForTimeout(16_000)
results.push(await capture('02-property-selected'))

// ── dock docked / expanded over the selection ──────────────────────────────
await page.click('.nx-pinned-app-dock__handle')
await page.waitForTimeout(900)
results.push(await capture('03-dock-docked'))
const customize = await page.$('.nx-pinned-app-dock__customize')
if (customize) { await customize.click(); await page.waitForTimeout(900) }
results.push(await capture('04-dock-expanded'))
await page.click('.nx-pinned-app-dock__backdrop').catch(() => {})
await page.waitForTimeout(1200)

// ── the three sheet states ─────────────────────────────────────────────────
// Promoted by the sheet's own grab handle, which is the affordance the operator uses.
const promote = async () => {
  // Peek promotes by tapping the card (the operator's gesture); once in Detail the
  // grab handle cycles to Full.
  const peek = await page.$('.smc-shell.is-peek')
  if (peek) { await peek.click({ position: { x: 190, y: 60 } }).catch(() => {}); await page.waitForTimeout(1000); return }
  const handle = await page.$('.nx-mobile-bottom-sheet__handle')
  if (handle) { await handle.click({ force: true }).catch(() => {}); await page.waitForTimeout(1000) }
}
await promote()
results.push(await capture('05-sheet-detail'))
await promote()
results.push(await capture('06-sheet-full'))
await promote() // cycles back to peek
await page.waitForTimeout(600)

// ── live activity expanded ─────────────────────────────────────────────────
// In peek the whole row is the control; there is no separate toggle to find.
const activityToggle = await page.$('.nx-icm-activity__peek-row, .nx-icm-activity__controls button')
if (activityToggle) { await activityToggle.click().catch(() => {}); await page.waitForTimeout(1400) }
results.push(await capture('07-live-activity-expanded'))

const report = { label: LABEL, width: WIDTH, theme: THEME, subject, results, consoleErrors: [...new Set(consoleErrors)] }
await fs.writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2))

for (const r of results) {
  const b = r.bounds
  const fmt = (x) => x ? `${x.top}-${x.bottom}(${x.height}${x.opacity === 0 ? ',hidden' : ''})` : '—'
  console.log(
    `${r.state.padEnd(26)} hdr=${fmt(b.globalHeader).padEnd(18)} ctrl=${fmt(b.mapControls).padEnd(18)} ` +
    `act=${fmt(b.liveActivity).padEnd(20)} sheet=${fmt(b.propertySheet).padEnd(22)} dock=${fmt(b.dock).padEnd(18)} ` +
    `map=${String(r.mapVisibleHeight).padStart(4)}px ovf=${r.horizontalOverflowPx} obscured=${r.obscuredCount}`,
  )
  for (const o of r.obscured.slice(0, 4)) {
    console.log(`    ⚠ "${o.label}" (${o.own}) covered by ${o.coveredBy} @${o.at}`)
  }
}
console.log(`\nscreenshots: ${OUT}`)
await browser.close()
