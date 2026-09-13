/**
 * MOBILE SHELL QA HARNESS.
 *
 * Chrome's window cannot be shrunk below ~860 CSS px on macOS, so the extension
 * driven browser can never reach the 390px acceptance viewport. Playwright can,
 * so every mobile-width claim in this program is measured here rather than eyeballed.
 *
 * Usage:
 *   node scripts/proof/mobile/mobile-shell-qa.mjs --label before [--width 390] [--theme dark]
 *
 * Writes screenshots to .screenshots/mobile-qa/<label>/ and prints one JSON line
 * per route with the geometry facts that the acceptance criteria are written against.
 */
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}

const BASE = arg('base', 'http://localhost:5174')
const LABEL = arg('label', 'run')
const WIDTH = Number(arg('width', '390'))
const HEIGHT = Number(arg('height', '844'))
const THEME = arg('theme', 'dark')
const ONLY = arg('only', '')

const ROUTES = [
  ['inbox', '/inbox'],
  ['pipeline', '/pipeline'],
  ['map', '/map'],
  ['entity-graph', '/entity-graph'],
  ['queue', '/queue'],
  ['campaign-command', '/campaign-command'],
  ['email-command', '/email-command'],
  ['workflow-studio', '/workflow-studio'],
  ['closing-desk', '/closing-desk'],
  ['analytics', '/analytics'],
  ['buyer-match', '/buyer-match'],
  ['comp-intelligence', '/comp-intelligence'],
  ['properties', '/properties'],
  ['deal-intelligence', '/deal-intelligence'],
  ['calendar', '/calendar'],
  ['conversation', '/conversation'],
]

const OUT = path.resolve(process.cwd(), '.screenshots/mobile-qa', LABEL, `${WIDTH}-${THEME}`)

/** Runs in the page. Returns the geometry facts the acceptance criteria are written against. */
const PROBE = () => {
  const rect = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return {
      top: Math.round(r.top), bottom: Math.round(r.bottom),
      left: Math.round(r.left), right: Math.round(r.right),
      w: Math.round(r.width), h: Math.round(r.height),
      display: cs.display, visibility: cs.visibility, position: cs.position,
    }
  }
  const doc = document.scrollingElement || document.documentElement
  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    htmlClass: document.documentElement.className,
    isMobileLayout: document.documentElement.classList.contains('is-mobile-layout'),
    theme: document.documentElement.getAttribute('data-nexus-theme')
      || document.documentElement.getAttribute('data-theme'),
    // Horizontal overflow is an outright failure at any mobile width.
    scrollWidth: doc.scrollWidth,
    horizontalOverflowPx: Math.max(0, doc.scrollWidth - window.innerWidth),
    // The widest element that actually exceeds the viewport, so a failure is actionable.
    widestOverflowingSelector: (() => {
      let worst = null
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect()
        if (r.width === 0) continue
        const over = Math.round(r.right - window.innerWidth)
        if (over > 1 && (!worst || over > worst.over)) {
          worst = {
            over,
            sel: `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${
              el.classList.length ? '.' + [...el.classList].slice(0, 3).join('.') : ''
            }`,
          }
        }
      }
      return worst
    })(),
    bottomDock: rect('.nx-pinned-app-dock'),
    bottomDockGlass: rect('.nx-pinned-app-dock__glass'),
    topDock: rect('.nx-mobile-command-dock'),
    appLauncher: rect('.nx-app-launcher'),
    safeAreaTokens: (() => {
      const cs = getComputedStyle(document.documentElement)
      const pick = (n) => cs.getPropertyValue(n).trim() || null
      return {
        safeTop: pick('--nx-mobile-safe-top'),
        safeBottom: pick('--nx-mobile-safe-bottom'),
        chromeTop: pick('--nx-mobile-chrome-top'),
        chromeBottom: pick('--nx-mobile-chrome-bottom'),
      }
    })(),
    bodyTextHead: document.body.innerText.replace(/\s+/g, ' ').slice(0, 160),
  }
}

const run = async () => {
  await fs.mkdir(OUT, { recursive: true })
  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    // 390x844 with a notch: the dock contract is written against a real inset.
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  })

  // Theme is an operator setting in localStorage; set it before the app boots.
  await context.addInitScript((theme) => {
    try {
      const raw = localStorage.getItem('nexus:settings')
      const parsed = raw ? JSON.parse(raw) : {}
      localStorage.setItem('nexus:settings', JSON.stringify({ ...parsed, nexusTheme: theme }))
    } catch { /* first run has no settings yet */ }
  }, THEME)

  const results = []
  const routes = ONLY ? ROUTES.filter(([id]) => ONLY.split(',').includes(id)) : ROUTES

  for (const [id, route] of routes) {
    const page = await context.newPage()
    const errors = []
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)) })
    page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 200)}`))

    let probe = null
    let failure = null
    try {
      await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
      // The shell mounts well before data settles; wait for the shell, not the network.
      await page.waitForSelector('#root > *', { timeout: 60_000 })
      // Then wait for the TOP BAR specifically. A fixed delay under-reported four
      // inbox-backed routes as chrome-less when the dev API was busy recompiling —
      // the routes were simply still mounting. The dock is never the slow one, so
      // waiting on the top bar is what makes the report trustworthy.
      await page
        .waitForSelector('.nx-mobile-command-dock, .nx-topbar', { timeout: 45_000 })
        .catch(() => { /* recorded as topDock:null below, which is the finding */ })
      await page.waitForTimeout(2500)
      probe = await page.evaluate(PROBE)
      await page.screenshot({ path: path.join(OUT, `${id}.png`), fullPage: false })
    } catch (error) {
      failure = String(error?.message || error).slice(0, 300)
    }

    results.push({ id, route, failure, errors: errors.slice(0, 4), ...probe })
    console.log(JSON.stringify({ id, route, failure, errorCount: errors.length, ...probe }))
    await page.close()
  }

  await fs.writeFile(path.join(OUT, 'report.json'), JSON.stringify(results, null, 2))
  await browser.close()

  const overflow = results.filter((r) => (r.horizontalOverflowPx || 0) > 1)
  const broken = results.filter((r) => r.failure)
  console.log(`\n== ${LABEL} @ ${WIDTH}px / ${THEME} ==`)
  console.log(`routes: ${results.length}  failed: ${broken.length}  horizontal-overflow: ${overflow.length}`)
  for (const r of overflow) console.log(`  OVERFLOW ${r.id}: +${r.horizontalOverflowPx}px via ${r.widestOverflowingSelector?.sel}`)
  for (const r of broken) console.log(`  FAILED   ${r.id}: ${r.failure}`)
  console.log(`screenshots: ${OUT}`)
}

run().catch((error) => { console.error(error); process.exit(1) })
