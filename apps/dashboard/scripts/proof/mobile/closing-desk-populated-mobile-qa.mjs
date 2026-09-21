/**
 * CLOSING DESK — POPULATED MOBILE COMPOSITION PROOF.
 *
 * THE GAP THIS CLOSES. `closing-desk-mobile-qa.mjs` measures the LIVE route,
 * and production currently holds zero active closings (one case exists and it
 * is the voided $4,100 rent-as-contract-price record, correctly excluded by
 * the cases route). So every cell it measures is an EMPTY desk. The board, the
 * deal cards, the case workspace and the drill-in — everything a layout defect
 * could hide in — never render, and a green run says nothing about them.
 *
 * This drives the same surface with the synthetic fixture set (?demo=1), whose
 * only legitimate use is exactly this: exercising composition without
 * inventing production data. The live route is separately asserted to contain
 * none of it.
 *
 * WHAT IT MEASURES, and why each one:
 *   - horizontal overflow, per §14: at 375 nothing may scroll sideways.
 *   - dock collision: the global dock is fixed, so content that ends beneath
 *     it is content the operator cannot reach. Measured as real geometry
 *     against `.nx-pinned-app-dock`, not as a CSS assumption.
 *   - nested scrollers, per §15: one primary vertical scroll. Any element
 *     other than the document scrolling vertically is reported with its
 *     selector rather than silently tolerated.
 *   - touch targets, per §23: interactive controls under ~44px.
 *
 * READ ONLY. Fixtures are client-side; no closing case is created, read or
 * mutated, and no backend write path is exercised.
 */
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.replace(`--${name}=`, '') : fallback
}
const list = (raw, fb) => (raw ? String(raw).split(',').map((v) => v.trim()).filter(Boolean) : fb)

const BASE = arg('base', 'http://localhost:5174')
const WIDTHS = list(arg('width'), ['375', '390', '393', '430']).map(Number)
const THEMES = list(arg('theme'), ['dark', 'light', 'red-ops', 'true-black'])
const TOUCH_MIN = 40 // practical floor; 44 is the target, 40 the hard failure line

const OUT = path.resolve('artifacts/closing-desk-populated')
await fs.mkdir(OUT, { recursive: true })

const findings = []
const check = (cell, label, ok, detail = '') => {
  if (!ok) findings.push({ cell, label, detail })
  return ok
}

const probe = (rootSel = '.closing-desk-view') => {
  const doc = document.documentElement
  const body = document.body

  const overflow = Math.max(0, Math.round(doc.scrollWidth - doc.clientWidth))

  const dock = document.querySelector('.nx-pinned-app-dock')
  const dockTop = dock ? Math.round(dock.getBoundingClientRect().top) : null

  // Elements that scroll vertically on their own. The document is allowed to;
  // nothing else is, unless it is a sheet/modal (which may scroll internally).
  const nested = []
  for (const el of Array.from(document.querySelectorAll(rootSel + ' *'))) {
    const cs = getComputedStyle(el)
    const scrolls = /(auto|scroll)/.test(cs.overflowY)
    if (!scrolls) continue
    if (el.scrollHeight <= el.clientHeight + 4) continue
    if (el.closest('[role="dialog"], .nx-sheet, .cd-diagnostics, [data-sheet], .cd-dossier-overlay')) continue
    const cls = String(el.className || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.')
    nested.push(`${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}`)
  }

  // Interactive controls that are too small to hit reliably.
  const small = []
  for (const el of Array.from(document.querySelectorAll(rootSel + ' button, ' + rootSel + ' a[href], ' + rootSel + ' [role="button"]'))) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue // hidden
    if (r.height < 40 || r.width < 40) {
      const label = (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 28)
      small.push(`${Math.round(r.width)}x${Math.round(r.height)}:${label}`)
    }
  }

  // Content that ends underneath the fixed dock is unreachable content.
  let belowDock = 0
  if (dock) {
    const dt = dock.getBoundingClientRect().top
    for (const el of Array.from(document.querySelectorAll(rootSel + ' button, ' + rootSel + ' a[href]'))) {
      const r = el.getBoundingClientRect()
      if (r.height === 0) continue
      // Only count elements currently in the viewport band.
      if (r.top < window.innerHeight && r.bottom > dt && r.top < dt + 4) belowDock += 1
    }
  }

  const cards = document.querySelectorAll('[data-testid="cd-deal-card"], .cd-deal-card').length
  const wider = Array.from(document.querySelectorAll(rootSel + ' *'))
    .filter((el) => el.getBoundingClientRect().width > doc.clientWidth + 1).length

  return {
    overflow,
    dockTop,
    nested: Array.from(new Set(nested)).slice(0, 6),
    small: Array.from(new Set(small)).slice(0, 6),
    belowDock,
    cards,
    wider,
    bodyScrollable: body.scrollHeight > body.clientHeight,
    demoBanner: !!document.querySelector('[data-testid="cd-env-demo"]'),
  }
}

const browser = await chromium.launch()
let cells = 0

for (const width of WIDTHS) {
  for (const theme of THEMES) {
    const cell = `${width}-${theme}`
    const ctx = await browser.newContext({
      viewport: { width, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    })
    const page = await ctx.newPage()
    try {
      await page.addInitScript((t) => {
        try { localStorage.setItem('nexus.theme', t) } catch { /* ignore */ }
      }, theme)

      await page.goto(`${BASE}/closing-desk?demo=1`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
      await page.waitForSelector('.closing-desk-view', { timeout: 60_000 })
      await page.waitForTimeout(900)

      const p = await page.evaluate(probe)

      check(cell, '§3 fixture route is badged as synthetic', p.demoBanner, 'no demo banner on ?demo=1')
      check(cell, 'populated — deal cards rendered', p.cards > 0, `cards=${p.cards}`)
      check(cell, '§14 no horizontal overflow', p.overflow === 0, `overflow=${p.overflow}px`)
      check(cell, '§14 no element wider than viewport', p.wider === 0, `${p.wider} element(s)`)
      check(cell, '§15 one primary vertical scroll', p.nested.length === 0, p.nested.join(', '))
      check(cell, '§14 no control trapped under the dock', p.belowDock === 0, `${p.belowDock} control(s)`)
      check(cell, `§23 touch targets >= ${TOUCH_MIN}px`, p.small.length === 0, p.small.join(', '))

      await page.screenshot({ path: path.join(OUT, `${cell}-top.png`) })
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await page.waitForTimeout(400)
      const bottom = await page.evaluate(probe)
      check(cell, '§14 no overflow at scroll bottom', bottom.overflow === 0, `overflow=${bottom.overflow}px`)
      check(cell, '§14 nothing trapped under dock at bottom', bottom.belowDock === 0, `${bottom.belowDock} control(s)`)
      await page.screenshot({ path: path.join(OUT, `${cell}-bottom.png`) })

      // ── drill-in: the dossier is the densest surface on the phone ──────
      // The board is a scroll-snap lane strip, which confuses auto-scroll;
      // place the card deterministically before clicking.
      await page.evaluate(() => {
        const c = document.querySelector('[data-testid="cd-card"]')
        if (c) c.scrollIntoView({ block: 'center', behavior: 'instant' })
      })
      await page.waitForTimeout(400)
      await page.locator('[data-testid="cd-card"]').first().click({ timeout: 30_000 })
      await page.waitForSelector('[data-testid="cd-dossier"]', { timeout: 30_000 })
      await page.waitForTimeout(700)
      const d = await page.evaluate(probe, '.cd-dossier')
      check(cell, 'dossier — blocker surfaced', await page.locator('[data-testid="cd-primary-blocker"], [data-testid="cd-next-action"]').count() > 0, 'no blocker or next action')
      check(cell, '§14 dossier no horizontal overflow', d.overflow === 0, `overflow=${d.overflow}px`)
      check(cell, '§14 dossier no element wider than viewport', d.wider === 0, `${d.wider} element(s)`)
      check(cell, `§23 dossier touch targets >= ${TOUCH_MIN}px`, d.small.length === 0, d.small.join(', '))
      await page.screenshot({ path: path.join(OUT, `${cell}-dossier.png`) })
      console.log(`${cell}  dossier overflow=${d.overflow} wider=${d.wider} small=${d.small.length}`)
      await page.keyboard.press('Escape').catch(() => {})
      await page.waitForTimeout(300)

      console.log(`${cell}  cards=${p.cards} overflow=${p.overflow} nested=${p.nested.length} small=${p.small.length} underDock=${p.belowDock}/${bottom.belowDock} dockTop=${p.dockTop}`)
      cells += 1
    } catch (error) {
      findings.push({ cell, label: 'cell failed', detail: String(error?.message || error).slice(0, 160) })
    } finally {
      await ctx.close()
    }
  }
}

await browser.close()

console.log('─'.repeat(72))
if (findings.length === 0) {
  console.log(`PASS — ${cells} cells, 0 findings`)
} else {
  console.log(`FAIL — ${findings.length} finding(s)`)
  for (const f of findings) console.log(`  [${f.cell}] ${f.label}\n      ${f.detail}`)
  process.exitCode = 1
}
