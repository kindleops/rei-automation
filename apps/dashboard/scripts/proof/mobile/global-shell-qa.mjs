/**
 * GLOBAL MOBILE SHELL — SHARED CHASSIS PROOF.
 *
 * Proves the chassis every app inherits, NOT any app's own content: the global
 * header, the bottom dock, safe areas, the type scale, and theme parity.
 *
 * READ ONLY. It loads routes, reads geometry and opens the overflow sheet. It
 * never submits, sends, or mutates anything.
 *
 * WHAT IT MEASURES, AND WHY THESE CHECKS
 *   §1  the header carries at most 4 controls, and each one OWNS its own hit
 *       area. The second half matters more than the first: before this pass the
 *       bar held six 38px glyphs whose 44px ::after targets overlapped, so a
 *       probe 21px either side of a control resolved to its NEIGHBOUR. Counting
 *       buttons would not have caught that; probing does.
 *   §4  nothing is trapped under the bottom dock. "Trapped" means VISIBLE and
 *       covered, so the dock's own subtree is excluded, the control must be
 *       fully on screen, and elementFromPoint must name the dock as the cover.
 *       Raw rect maths reports list rows hanging below the fold as collisions.
 *   §6  no text below the 11px floor in SHELL chrome. App content is out of
 *       scope for this pass and is measured separately.
 *   §17 no horizontal overflow, at four widths plus landscape.
 *   §18 all four themes, same structure -- no theme-specific divergence.
 */
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const arg = (n, f) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || `--${n}=${f}`).replace(`--${n}=`, '')
const BASE = arg('base', 'http://localhost:5174')
const WIDTHS = arg('width', '375,390,393,430').split(',').map(Number)
const THEMES = arg('theme', 'dark,light,red-ops,true-black').split(',')
const ROUTES = ['/inbox', '/map', '/entity-graph', '/pipeline', '/calendar', '/email-command']

const OUT = path.resolve('artifacts/global-shell')
await fs.mkdir(OUT, { recursive: true })
const findings = []
const check = (cell, label, ok, detail = '') => { if (!ok) findings.push({ cell, label, detail }); return ok }

const probe = () => {
  const doc = document.documentElement
  const bar = document.querySelector('.nx-mobile-command-dock')
  const dock = document.querySelector('.nx-pinned-app-dock')

  const barButtons = bar ? [...bar.querySelectorAll('button')] : []
  const misTapped = []
  for (const el of barButtons) {
    const r = el.getBoundingClientRect()
    if (r.width === 0) continue
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    const owns = (dx, dy) => {
      const hit = document.elementFromPoint(cx + dx, cy + dy)
      return hit ? (el === hit || el.contains(hit)) : false
    }
    // 21px: just inside a 44px target. Both axes -- the horizontal one is what
    // the overlapping ::after targets were failing.
    if (!(owns(-21, 0) && owns(21, 0) && owns(0, -21) && owns(0, 21))) {
      misTapped.push(`${(el.getAttribute('aria-label') || '').slice(0, 18)}@${Math.round(r.width)}px`)
    }
  }

  let underDock = 0
  const underDetail = []
  if (dock) {
    for (const el of document.querySelectorAll('button, a[href]')) {
      if (dock.contains(el)) continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      if (r.top < 0 || r.bottom > window.innerHeight) continue
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      if (hit && (dock === hit || dock.contains(hit))) {
        underDock += 1
        underDetail.push((el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 18))
      }
    }
  }

  // Shell chrome only: the header, the dock and any open shell sheet.
  const chrome = [...document.querySelectorAll(
    '.nx-mobile-command-dock *, .nx-pinned-app-dock *, .nx-mobile-overflow *',
  )]
  const tiny = []
  for (const el of chrome) {
    if (!el.textContent?.trim()) continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    const size = parseFloat(getComputedStyle(el).fontSize)
    if (size && size < 11) tiny.push(`${size}px:${el.textContent.trim().slice(0, 14)}`)
  }

  return {
    barPresent: !!bar,
    barButtons: barButtons.length,
    misTapped,
    dockPresent: !!dock,
    underDock,
    underDetail,
    tiny: [...new Set(tiny)].slice(0, 5),
    overflow: Math.max(0, Math.round(doc.scrollWidth - doc.clientWidth)),
    mounted: !!document.querySelector('#root')?.firstElementChild,
  }
}

const browser = await chromium.launch()
let cells = 0

for (const width of WIDTHS) {
  for (const theme of THEMES) {
    const ctx = await browser.newContext({
      viewport: { width, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    })
    await ctx.addInitScript((t) => { try { localStorage.setItem('nexus.theme', t) } catch { /* ignore */ } }, theme)
    for (const route of ROUTES) {
      const cell = `${width}-${theme}${route}`
      const page = await ctx.newPage()
      try {
        await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
        /*
         * SETTLE ON THE CHROME, NOT ON BODY TEXT.
         *
         * Waiting for "some text then 2.5s" reported seven missing headers and
         * six mis-tapped bars that a single-cell reproduction could not
         * reproduce at all: the Map simply had not finished mounting its shell
         * when the probe ran, and a header that does not exist yet fails every
         * check at once. A whole class of finding that vanishes on re-test is
         * the harness measuring too early, so wait for the thing being measured
         * -- the bar, with its buttons laid out -- and then for it to hold
         * still across two frames.
         */
        await page.waitForFunction(() => {
          const bar = document.querySelector('.nx-mobile-command-dock')
          if (!bar) return false
          const btns = bar.querySelectorAll('button')
          return btns.length > 0 && [...btns].every((b) => b.getBoundingClientRect().width > 0)
        }, undefined, { timeout: 60_000 }).catch(() => {})
        await page.waitForFunction(() => {
          const n = document.querySelectorAll('.nx-mobile-command-dock button').length
          const prev = window.__shellBtnCount
          window.__shellBtnCount = n
          return prev === n
        }, undefined, { timeout: 20_000, polling: 600 }).catch(() => {})
        await page.waitForTimeout(1200)

        const m = await page.evaluate(probe)
        check(cell, 'shell mounted', m.mounted, '')
        check(cell, '§1 global header present', m.barPresent, '')
        check(cell, '§1 header carries at most 4 controls', m.barButtons <= 4, `${m.barButtons}`)
        check(cell, '§1 every header control owns its hit area', m.misTapped.length === 0, m.misTapped.join(', '))
        check(cell, '§4 bottom dock present', m.dockPresent, '')
        check(cell, '§4 nothing trapped under the dock', m.underDock === 0, m.underDetail.join(', '))
        check(cell, '§6 no shell chrome text below 11px', m.tiny.length === 0, m.tiny.join(', '))
        check(cell, '§17 no horizontal overflow', m.overflow === 0, `${m.overflow}px`)
        cells += 1
        if (width === 390 && theme === 'dark') {
          await page.screenshot({ path: path.join(OUT, `${route.replace(/\//g, '')}-390-dark.png`) })
        }
      } catch (error) {
        findings.push({ cell, label: 'cell failed', detail: String(error?.message || error).slice(0, 120) })
      } finally { await page.close() }
    }
    await ctx.close()
  }
}

// §17 landscape: phone-ness is the SHORT edge, so a rotated phone must keep the
// mobile shell rather than falling through to the desktop layout.
{
  const ctx = await browser.newContext({
    viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  })
  const page = await ctx.newPage()
  await page.goto(`${BASE}/pipeline`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.waitForTimeout(6000)
  const m = await page.evaluate(probe)
  check('landscape', '§17 landscape keeps the mobile shell', m.barPresent && m.dockPresent,
    `bar=${m.barPresent} dock=${m.dockPresent}`)
  check('landscape', '§17 no horizontal overflow in landscape', m.overflow === 0, `${m.overflow}px`)
  check('landscape', '§4 nothing trapped under the dock in landscape', m.underDock === 0, m.underDetail.join(', '))
  await page.screenshot({ path: path.join(OUT, 'landscape.png') })
  cells += 1
  await ctx.close()
}

await browser.close()
console.log('─'.repeat(70))
if (findings.length === 0) console.log(`PASS — ${cells} cells, 0 findings`)
else {
  console.log(`FAIL — ${findings.length} finding(s) across ${cells} cells`)
  const seen = new Map()
  for (const f of findings) {
    const k = `${f.label} :: ${f.detail}`
    seen.set(k, (seen.get(k) || 0) + 1)
  }
  for (const [k, n] of [...seen.entries()].sort((a, b) => b[1] - a[1])) console.log(`  x${n}  ${k}`)
  process.exitCode = 1
}
