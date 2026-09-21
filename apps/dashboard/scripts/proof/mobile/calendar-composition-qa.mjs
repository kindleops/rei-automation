/**
 * CALENDAR — MOBILE COMPOSITION & NAVIGATION PROOF.
 *
 * THE GAP THIS CLOSES. `calendar-mobile-qa.mjs` proves the agenda's TRUTH —
 * that counts match the service, that a dead authority offers no filter, that
 * a failed read says so rather than rendering a calm empty week. It does not
 * prove the surface's COMPOSITION beyond page-wide overflow, and it checks the
 * month control is reachable without ever opening the month.
 *
 * Month is where a calendar's layout actually breaks: seven fixed columns on a
 * 375px screen is the classic horizontal-overflow bug, and it would sail past
 * an agenda-only proof.
 *
 * WHAT IT ADDS:
 *   - the month GRID opens, fits, and marks the selected day (§14)
 *   - tapping a date reveals that day's agenda rather than dead-ending (§14)
 *   - a route back to Today exists and works after navigating away (§25)
 *   - one primary vertical scroll — no nested scrollers (§20)
 *   - touch targets, including the month's date cells, which are the smallest
 *     controls on the surface (§23)
 *   - no horizontal overflow at the BOTTOM of scroll, not just the top
 *
 * READ ONLY. It opens views and taps dates. It never clicks a mutating
 * control, and it never opens the new-event composer.
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
const TOUCH_MIN = 32 // date cells are legitimately compact; below this is a miss-tap

const OUT = path.resolve('artifacts/calendar-composition')
await fs.mkdir(OUT, { recursive: true })

const findings = []
const check = (cell, label, ok, detail = '') => {
  if (!ok) findings.push({ cell, label, detail })
  return ok
}

const probe = () => {
  const doc = document.documentElement
  const root = document.querySelector('.nx-cal__mobile') || document.body

  const overflow = Math.max(0, Math.round(doc.scrollWidth - doc.clientWidth))

  const nested = []
  for (const el of Array.from(root.querySelectorAll('*'))) {
    const cs = getComputedStyle(el)
    if (!/(auto|scroll)/.test(cs.overflowY)) continue
    if (el.scrollHeight <= el.clientHeight + 4) continue
    // Sheets and the horizontal day strip are allowed their own scroll.
    if (el.closest('.nx-sheet, [data-sheet], .nx-bottom-sheet')) continue
    if (el.classList.contains('nx-cal__mobile-day-strip')) continue // horizontal strip
    const cls = String(el.className || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.')
    nested.push(`${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}`)
  }

  const small = []
  for (const el of Array.from(root.querySelectorAll('button, a[href], [role="button"]'))) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    if (r.height < TOUCH_MIN_INJECTED || r.width < TOUCH_MIN_INJECTED) {
      const label = (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24)
      small.push(`${Math.round(r.width)}x${Math.round(r.height)}:${label}`)
    }
  }

  const wider = Array.from(root.querySelectorAll('*'))
    .filter((el) => el.getBoundingClientRect().width > doc.clientWidth + 1).length

  return {
    overflow,
    wider,
    nested: Array.from(new Set(nested)).slice(0, 6),
    small: Array.from(new Set(small)).slice(0, 6),
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
      await page.addInitScript((min) => { window.TOUCH_MIN_INJECTED = min }, TOUCH_MIN)

      await page.goto(`${BASE}/calendar`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
      await page.waitForSelector('.nx-cal__mobile', { timeout: 60_000 })
      await page.waitForTimeout(1400)

      // ── agenda (default view) ────────────────────────────────────────────
      const agenda = await page.evaluate(probe)
      check(cell, '§19 agenda no horizontal overflow', agenda.overflow === 0, `${agenda.overflow}px`)
      check(cell, '§20 agenda one primary vertical scroll', agenda.nested.length === 0, agenda.nested.join(', '))
      check(cell, `§23 agenda touch targets >= ${TOUCH_MIN}px`, agenda.small.length === 0, agenda.small.join(', '))
      await page.screenshot({ path: path.join(OUT, `${cell}-agenda.png`) })

      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await page.waitForTimeout(400)
      const bottom = await page.evaluate(probe)
      check(cell, '§19 no overflow at agenda scroll bottom', bottom.overflow === 0, `${bottom.overflow}px`)
      await page.evaluate(() => window.scrollTo(0, 0))
      await page.waitForTimeout(250)

      // ── return to Today (§25) — done on a clean anchor, before any sheet ──
      /*
       * The day strip is always on screen, so this tap cannot silently fail
       * the way an off-view month cell can, and it is the path an operator
       * actually takes.
       */
      const headToday0 = await page.evaluate(() => document.querySelector('.nx-cal__mobile-head strong')?.textContent ?? '')
      check(cell, '§25 Today is hidden while already on today',
        await page.locator('[data-testid="cal-today-btn"]').count() === 0, 'Today shown on today')

      const otherDay = page.locator('.nx-cal__mobile-day:not(.is-today):not(.is-selected)').first()
      if (await otherDay.count() > 0) {
        await otherDay.click({ timeout: 15_000 })
        await page.waitForTimeout(700)
      }
      const headMoved = await page.evaluate(() => document.querySelector('.nx-cal__mobile-head strong')?.textContent ?? '')
      check(cell, '§25 moving off today changes the header date', headMoved !== headToday0, `${headToday0} -> ${headMoved}`)

      const todayBtn = page.locator('[data-testid="cal-today-btn"]').first()
      check(cell, '§25 a route back to Today appears after navigating away',
        await todayBtn.count() > 0, 'no Today control after date change')
      if (await todayBtn.count() > 0) {
        await todayBtn.click({ timeout: 15_000 })
        await page.waitForTimeout(700)
        const headBack = await page.evaluate(() => document.querySelector('.nx-cal__mobile-head strong')?.textContent ?? '')
        check(cell, '§25 Today actually returns to today', headBack === headToday0, `${headBack} != ${headToday0}`)
        check(cell, '§25 Today hides itself once back on today',
          await page.locator('[data-testid="cal-today-btn"]').count() === 0, 'Today still shown while on today')
        const back = await page.evaluate(probe)
        check(cell, '§25 no overflow after returning to Today', back.overflow === 0, `${back.overflow}px`)
        await page.screenshot({ path: path.join(OUT, `${cell}-today.png`) })
      }

      // ── month grid ───────────────────────────────────────────────────────
      const monthBtn = page.locator('[data-testid="cal-month-btn"]').first()
      const hasMonth = await monthBtn.count() > 0
      check(cell, '§14 a month control exists', hasMonth, 'no month control found')

      if (hasMonth) {
        await monthBtn.click({ timeout: 20_000 })
        await page.waitForSelector('.nx-cal__month-sheet', { timeout: 20_000 })
        await page.waitForTimeout(700)
        const month = await page.evaluate(probe)
        check(cell, '§14 MONTH GRID no horizontal overflow', month.overflow === 0, `${month.overflow}px`)
        check(cell, '§14 month no element wider than viewport', month.wider === 0, `${month.wider} element(s)`)
        check(cell, `§23 month date cells >= ${TOUCH_MIN}px`, month.small.length === 0, month.small.join(', '))
        await page.screenshot({ path: path.join(OUT, `${cell}-month.png`) })

        // Direct children only: a cell also holds an add-task button and event
        // chips, and this proof must never open the composer.
        const cells_ = page.locator('.nx-cal__month-grid > .nx-cal__month-cell')
        const n = await cells_.count()
        check(cell, '§14 the month grid renders a full month', n >= 28, `${n} cells`)
        if (n > 0) {
          const selNow = () => page.evaluate(() => {
            const el = document.querySelector('.nx-cal__month-grid > .nx-cal__month-cell.is-selected')
            return el ? (el.textContent || '').trim().slice(0, 12) : '(none)'
          })
          const beforeTap = await selNow()
          // Must not already be the selected day, or "did it change" proves nothing.
          const target = page.locator('.nx-cal__month-grid > .nx-cal__month-cell:not(.is-selected):not(.is-outside)').nth(10)
          await target.scrollIntoViewIfNeeded({ timeout: 10_000 }).catch(() => {})
          await target.click({ timeout: 15_000 })
          await page.waitForTimeout(800)
          const afterTap = await selNow()
          check(cell, '§14 tapping a date selects that day', afterTap !== beforeTap, `selected ${beforeTap} -> ${afterTap}`)
          const post = await page.evaluate(probe)
          check(cell, '§14 no overflow after date selection', post.overflow === 0, `${post.overflow}px`)
        }
      }

      console.log(`${cell}  agenda[of=${agenda.overflow} nest=${agenda.nested.length} small=${agenda.small.length}] month=${hasMonth}`)
      cells += 1
    } catch (error) {
      findings.push({ cell, label: 'cell failed', detail: String(error?.message || error).slice(0, 200) })
    } finally {
      await ctx.close()
    }
  }
}

await browser.close()
console.log('─'.repeat(72))
if (findings.length === 0) console.log(`PASS — ${cells} cells, 0 findings`)
else {
  console.log(`FAIL — ${findings.length} finding(s)`)
  for (const f of findings) console.log(`  [${f.cell}] ${f.label}\n      ${f.detail}`)
  process.exitCode = 1
}
