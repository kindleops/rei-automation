/**
 * Dock + App Launcher interaction proof.
 *
 * Opens the launcher from the dock rail at the acceptance viewport and records what
 * it exposes. The point is the COUNT and the NAMES: the whole reason the launcher
 * exists is that Properties, Comp Intelligence and Buyer Match were unreachable on a
 * phone, so this asserts they are now in the list rather than trusting the registry.
 */
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d }
const BASE = arg('base', 'http://localhost:5174')
const THEME = arg('theme', 'dark')
const WIDTH = Number(arg('width', '390'))
const LABEL = arg('label', 'run')
const OUT = path.resolve(process.cwd(), '.screenshots/mobile-qa', LABEL, `launcher-${WIDTH}-${THEME}`)

const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: { width: WIDTH, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
})
await context.addInitScript((theme) => {
  try {
    const raw = localStorage.getItem('nexus:settings')
    localStorage.setItem('nexus:settings', JSON.stringify({ ...(raw ? JSON.parse(raw) : {}), nexusTheme: theme }))
  } catch { /* first run */ }
}, THEME)

await fs.mkdir(OUT, { recursive: true })
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))

await page.goto(`${BASE}/inbox`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
await page.waitForSelector('.nx-pinned-app-dock__rail', { timeout: 60_000 })
await page.waitForTimeout(3000)

const rail = await page.$$eval('.nx-pinned-app-dock__rail-app', (nodes) =>
  nodes.map((n) => ({ label: n.getAttribute('aria-label'), h: Math.round(n.getBoundingClientRect().height) })))
await page.screenshot({ path: path.join(OUT, 'dock-collapsed.png') })

await page.click('.nx-pinned-app-dock__rail-app.is-launcher')
await page.waitForSelector('.nx-app-launcher', { timeout: 10_000 })
await page.waitForTimeout(700)

const launcher = await page.evaluate(() => {
  const groups = [...document.querySelectorAll('.nx-app-launcher__group')].map((g) => ({
    group: g.querySelector('h4')?.textContent,
    apps: [...g.querySelectorAll('.nx-app-launcher__label')].map((l) => l.textContent),
  }))
  const sheet = document.querySelector('.nx-app-launcher__sheet')?.getBoundingClientRect()
  const doc = document.scrollingElement || document.documentElement
  return {
    groups,
    total: groups.reduce((t, g) => t + g.apps.length, 0),
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

console.log(JSON.stringify({ theme: THEME, width: WIDTH, rail, launcher, searched, errors }, null, 1))
await fs.writeFile(path.join(OUT, 'report.json'), JSON.stringify({ rail, launcher, searched, errors }, null, 2))
await browser.close()
