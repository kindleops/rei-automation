#!/usr/bin/env node
/**
 * QUEUE / OUTBOUND MOBILE — §12/§13/§14 quick lock.
 *
 * Narrow on purpose. Queue was already substantially complete, so this verifies
 * the launch-critical path and the Street View rule, not a new architecture.
 *
 * The Street View assertion here is the DETAIL half of the corrected rule: the
 * Queue LIST must make no automatic request, and the SELECTED item sheet must
 * still be able to show its one property. A harness that only checked "0 Maps"
 * would pass a build that had stripped the sheet too.
 */
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d }
const BASE = arg('base', 'http://localhost:5174')
const WIDTHS = arg('width') ? [Number(arg('width'))] : [375, 390, 430]
const THEMES = arg('theme') ? [arg('theme')] : ['dark', 'light']
const OUT = path.resolve(process.cwd(), '.screenshots/queue-mobile')
await fs.mkdir(OUT, { recursive: true })

const setTheme = (t) => {
  try {
    const raw = localStorage.getItem('nexus-settings')
    localStorage.setItem('nexus-settings', JSON.stringify({ ...(raw ? JSON.parse(raw) : {}), nexusTheme: t }))
  } catch { /* first run */ }
}

const runCell = async (browser, width, theme) => {
  const findings = []
  const check = (n, ok, d) => { if (!ok) findings.push({ n, d }); return ok }
  const context = await browser.newContext({
    viewport: { width, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
  })
  await context.addInitScript(setTheme, theme)

  const listMaps = []
  const consoleErrors = []
  const page = await context.newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 150)) })
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 150)}`))
  let watchingList = true
  page.on('request', (r) => {
    if (!watchingList) return
    const u = r.url()
    if (/maps\.googleapis\.com|streetview|maps\/embed\/v1|maps\/api\/js/.test(u)) listMaps.push(u.slice(0, 90))
  })

  const t0 = Date.now()
  await page.goto(`${BASE}/queue`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.waitForFunction(() => document.querySelectorAll('.qm-row__body').length > 0,
    undefined, { timeout: 90_000 }).catch(() => {})
  const loadMs = Date.now() - t0
  await page.waitForTimeout(2500)

  const p = await page.evaluate(() => ({
    rows: document.querySelectorAll('.qm-row__body').length,
    overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
    theme: document.documentElement.getAttribute('data-nexus-theme'),
    kpis: [...document.querySelectorAll('.nx-kpi-orb, [class*="qm-health"] button')].length,
    header: document.querySelector('.qm-head')?.innerText?.replace(/\s+/g, ' ').trim().slice(0, 90) ?? null,
    bottomDock: (() => { const e = document.querySelector('.nx-pinned-app-dock'); return e ? Math.round(e.getBoundingClientRect().top) : null })(),
    lastRowBottom: (() => { const r = [...document.querySelectorAll('.qm-row__body')]; return r.length ? Math.round(r[r.length - 1].getBoundingClientRect().bottom) : null })(),
    // top control reachable at its own centre, not just present
    topReachable: (() => {
      const el = document.querySelector('button[aria-label="Refresh queue"]')
      if (!el) return { present: false }
      const b = el.getBoundingClientRect()
      const hit = document.elementFromPoint(Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2))
      return { present: true, reachable: !!(hit && (hit === el || el.contains(hit))) }
    })(),
  }))

  check('rows render', p.rows > 0, `${p.rows}`)
  check('no horizontal overflow', p.overflow === 0, `${p.overflow}px`)
  check('theme applied', p.theme === theme, `${p.theme}`)
  check('status filters reachable', p.kpis > 0, `${p.kpis} kpi controls`)
  check('top control reachable at its own centre',
    p.topReachable.present && p.topReachable.reachable !== false, JSON.stringify(p.topReachable))
  check('Queue LIST makes no automatic Street View request', listMaps.length === 0,
    `${listMaps.length}: ${listMaps.slice(0, 2).join(' | ')}`)
  await page.screenshot({ path: path.join(OUT, `${width}-${theme}-list.png`) })

  // ── §12 search, run BEFORE any detail sheet is opened. The first version
  // ran it after opening a row, and the sheet covered the filter control so the
  // click never landed — the same sequencing mistake as the Workflow Studio
  // harness. Search operates on the list, so it belongs with the list.
  //
  // Reached through the mobile filter menu (`filtersOpen`),
  // which hosts the only queue search input; the header's magnifier is the
  // UNIVERSAL search, not this one. Asserted functionally: a term that matches
  // fewer rows must actually narrow the list.
  const beforeSearch = await page.evaluate(() => document.querySelectorAll('.qm-row__body').length)
  const filterBtn = page.locator('button[aria-label="All rows"], .qm-bar__filters').first()
  let searchResult = null
  if (await filterBtn.count()) {
    await filterBtn.click({ timeout: 12_000 }).catch(() => {})
    await page.waitForTimeout(2500)
    const input = page.locator('input[type="search"]').first()
    if (await input.count()) {
      await input.fill('zzzznomatchqueue')
      await page.waitForTimeout(2500)
      const narrowed = await page.evaluate(() => document.querySelectorAll('.qm-row__body').length)
      await input.fill('')
      await page.waitForTimeout(2000)
      const restored = await page.evaluate(() => document.querySelectorAll('.qm-row__body').length)
      searchResult = { beforeSearch, narrowed, restored }
      check('search narrows the list on a non-matching term', narrowed < beforeSearch || narrowed === 0,
        `${beforeSearch} -> ${narrowed}`)
      check('clearing search restores the list', restored === beforeSearch,
        `${narrowed} -> ${restored}, expected ${beforeSearch}`)
    } else {
      check('queue search input is reachable on mobile', false, 'no input[type=search] in the filter menu')
    }
    await page.keyboard.press('Escape').catch(() => {})
    await page.waitForTimeout(1200)
  } else {
    check('the mobile filter control is present', false, 'no filters button')
  }


  // ── §12 detail: open one row, and the sheet may load its one property.
  watchingList = false
  const detailMaps = []
  page.on('request', (r) => {
    const u = r.url()
    if (/maps\.googleapis\.com|streetview|maps\/embed\/v1/.test(u)) detailMaps.push(u.slice(0, 90))
  })
  const row = page.locator('.qm-row__body').first()
  let detail = null
  if (await row.count()) {
    await row.click({ timeout: 15_000 }).catch(() => {})
    await page.waitForTimeout(7000)
    detail = await page.evaluate(() => {
      const sheet = document.querySelector('.qms-sheet')
      const t = sheet?.innerText ?? ''
      return {
        open: Boolean(sheet),
        hasHeroImage: Boolean(sheet?.querySelector('img')),
        chars: t.length,
        mentionsAddress: /\d+\s+\w+/.test(t),
        overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
        text: t.replace(/\s+/g, ' ').slice(0, 130),
      }
    })
    check('row opens a detail sheet', detail.open, 'no .qms-sheet')
    check('detail shows the seller/property/message', detail.chars > 80, `${detail.chars} chars`)
    check('detail does not break layout', detail.overflow === 0, `${detail.overflow}px`)
    // The corrected rule: imagery is ALLOWED here. Assert the surface can show
    // it, not that it never asks.
    check('selected-item Street View is intact (image or request)',
      detail.hasHeroImage || detailMaps.length > 0,
      `img=${detail.hasHeroImage} mapsRequests=${detailMaps.length}`)
    await page.screenshot({ path: path.join(OUT, `${width}-${theme}-detail.png`) })
  } else {
    check('a row was available to open', false, 'no rows')
  }

  // Dock clearance is a property of the list SCROLLED TO ITS END, not of the
  // document. Measuring the last row in place reported y=2107 against a dock at
  // 824 — that row was simply below the fold, which is what a scrolling list
  // does. Scroll first, then ask whether the final row is actually reachable.
  const clearance = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.qm-row__body')]
    if (!rows.length) return null
    rows[rows.length - 1].scrollIntoView({ block: 'end' })
    return new Promise((resolve) => setTimeout(() => {
      const last = rows[rows.length - 1].getBoundingClientRect()
      const dock = document.querySelector('.nx-pinned-app-dock')?.getBoundingClientRect() ?? null
      resolve({
        lastBottom: Math.round(last.bottom),
        dockTop: dock ? Math.round(dock.top) : null,
        viewport: window.innerHeight,
      })
    }, 900))
  })
  if (clearance?.dockTop) {
    check('the final row clears the bottom dock once scrolled to the end',
      clearance.lastBottom <= clearance.dockTop + 2,
      `last row bottom ${clearance.lastBottom} vs dock top ${clearance.dockTop}`)
  }
  const real = consoleErrors.filter((e) => !/favicon|ResizeObserver/i.test(e))
  check('no console errors', real.length === 0, real.slice(0, 2).join(' | '))

  await context.close()
  return { cell: `${width}-${theme}`, loadMs, rows: p.rows, detail, searchResult, listMaps, detailMaps, findings }
}

const browser = await chromium.launch()
const results = []
try {
  for (const w of WIDTHS) for (const t of THEMES) {
    const r = await runCell(browser, w, t)
    results.push(r)
    console.log(`${r.cell.padEnd(12)} ${(r.findings.length ? `FAIL (${r.findings.length})` : 'PASS').padEnd(10)} load ${r.loadMs}ms  rows ${r.rows}  listMaps ${r.listMaps.length}  detailImg ${r.detail?.hasHeroImage}`)
    for (const f of r.findings) console.log(`   ✗ ${f.n}: ${f.d}`)
  }
} finally { await browser.close() }

const total = results.reduce((n, r) => n + r.findings.length, 0)
console.log('')
console.log(`QUEUE MATRIX ${results.filter((r) => !r.findings.length).length}/${results.length} cells clean, ${total} finding(s)`)
const slowest = Math.max(...results.map((r) => r.loadMs))
console.log(`slowest initial load: ${slowest}ms`)
await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify(results, null, 2))
if (total > 0) process.exit(1)
