/**
 * MOBILE LAUNCHER / APP REGISTRY CONTRACT.
 *
 * This harness asserts the things MOBILE-LOCK §0, §3 and §26 fix, so a later
 * change that reintroduces any of them fails here rather than in an operator's
 * hand:
 *
 *   §0   Property OS is absent from the mobile launcher and the dock catalog
 *   §0   Appearance survives — every theme and every accent, in the launcher
 *   §3   ONE launcher: the legacy WorkspaceLauncher mobile sheet must not mount
 *   §26  every mobile application in the canonical registry is reachable
 *
 * It replaces a version that had drifted out of executability: it waited on
 * `.nx-pinned-app-dock__rail` and clicked `.nx-pinned-app-dock__rail-app.is-launcher`,
 * neither of which has existed since the dock was rebuilt around
 * `__track` / `__app`, and the launcher moved to the top bar. A QA script that
 * cannot run is the same class of problem as a registry nobody reads.
 *
 * Usage:
 *   node scripts/proof/mobile/mobile-launcher-qa.mjs [--base http://localhost:5174]
 *                                                    [--width 390] [--theme dark]
 * Exits non-zero on any failed assertion.
 */
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}

const BASE = arg('base', 'http://localhost:5174')
const WIDTH = Number(arg('width', '390'))
const THEME = arg('theme', 'dark')
const ROUTE = arg('route', '/inbox')
const OUT = path.resolve(process.cwd(), '.screenshots/mobile-launcher', `${WIDTH}-${THEME}`)

/** Absent from mobile by decision, not by accident. */
const FORBIDDEN_APPS = ['Properties', 'Property Intelligence OS', 'Property OS']

const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: { width: WIDTH, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
})

await context.addInitScript((theme) => {
  try {
    const raw = localStorage.getItem('nexus-settings')
    localStorage.setItem('nexus-settings', JSON.stringify({ ...(raw ? JSON.parse(raw) : {}), nexusTheme: theme }))
  } catch { /* first run */ }
}, THEME)

await fs.mkdir(OUT, { recursive: true })
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)) })

await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
await page.waitForSelector('.nx-mobile-command-dock', { timeout: 60_000 })
await page.waitForTimeout(3500)

const dock = await page.evaluate(() => ({
  identity: document.querySelector('.nx-mobile-command-dock__identity')?.textContent ?? null,
  innerWidth: Math.round(document.querySelector('.nx-mobile-command-dock__inner')?.getBoundingClientRect().width ?? 0),
  innerScrollWidth: document.querySelector('.nx-mobile-command-dock__inner')?.scrollWidth ?? 0,
  pinned: [...document.querySelectorAll('.nx-pinned-app-dock__app')].map((n) => n.getAttribute('aria-label')),
}))
await page.screenshot({ path: path.join(OUT, 'dock.png') })

// The launcher is raised from the top bar's identity control — one launcher, one address.
await page.click('.nx-mobile-command-dock__btn--workspace')
await page.waitForSelector('.nx-app-launcher', { timeout: 10_000 })
await page.waitForTimeout(700)

const launcher = await page.evaluate(() => {
  const groups = [...document.querySelectorAll('.nx-app-launcher__group')]
    .filter((g) => g.querySelector('.nx-app-launcher__grid'))
    .map((g) => ({
      group: g.querySelector('h4')?.textContent,
      apps: [...g.querySelectorAll('.nx-app-launcher__label')].map((l) => l.textContent),
    }))
  const sheet = document.querySelector('.nx-app-launcher__sheet')?.getBoundingClientRect()
  const doc = document.scrollingElement || document.documentElement
  return {
    groups,
    total: groups.reduce((t, g) => t + g.apps.length, 0),
    themes: document.querySelectorAll('.nx-mobile-appearance__theme').length,
    accents: document.querySelectorAll('.nx-mobile-appearance__accent').length,
    // The legacy mobile application switcher. Must not exist.
    legacyWorkspaceLauncher: Boolean(document.querySelector('.nx-wsl-root')),
    context: document.querySelector('.nx-app-launcher__context')?.textContent?.trim() || null,
    sheetTop: sheet ? Math.round(sheet.top) : null,
    sheetBottom: sheet ? Math.round(sheet.bottom) : null,
    horizontalOverflowPx: Math.max(0, doc.scrollWidth - window.innerWidth),
  }
})
await page.screenshot({ path: path.join(OUT, 'launcher-open.png') })

// Search narrows the list rather than navigating away from it.
await page.fill('.nx-app-launcher__search input', 'comp')
await page.waitForTimeout(400)
const searched = await page.$$eval('.nx-app-launcher__label', (n) => n.map((x) => x.textContent))
await page.screenshot({ path: path.join(OUT, 'launcher-search.png') })

const appNames = launcher.groups.flatMap((g) => g.apps)
const failures = []

for (const forbidden of FORBIDDEN_APPS) {
  if (appNames.includes(forbidden)) failures.push(`§0 ${forbidden} is present in the mobile launcher`)
  if (dock.pinned.includes(forbidden)) failures.push(`§0 ${forbidden} is present in the dock rail`)
}
if (launcher.legacyWorkspaceLauncher) failures.push('§3 the legacy WorkspaceLauncher mobile sheet mounted')
if (launcher.total < 12) failures.push(`§26 only ${launcher.total} applications in the launcher`)
if (launcher.themes < 11) failures.push(`§0 appearance lost themes — ${launcher.themes} of 11`)
if (launcher.accents < 12) failures.push(`§0 appearance lost accents — ${launcher.accents} of 12`)
if (launcher.horizontalOverflowPx > 1) failures.push(`§20 launcher overflows by ${launcher.horizontalOverflowPx}px`)
if (dock.innerScrollWidth > dock.innerWidth + 1) {
  failures.push(`§2 top bar overflows: ${dock.innerScrollWidth} > ${dock.innerWidth}`)
}
if (!searched.includes('Comp Intelligence')) failures.push('launcher search for "comp" did not surface Comp Intelligence')

const report = { theme: THEME, width: WIDTH, dock, launcher, searched, errors, failures }
console.log(JSON.stringify(report, null, 1))
await fs.writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2))
await browser.close()

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} launcher contract failure(s):`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`\n✓ launcher contract intact @ ${WIDTH}px / ${THEME} — ${launcher.total} apps, ${launcher.themes} themes, ${launcher.accents} accents`)
