/**
 * LIVE ACTIVITY — POPULATED FEED PROOF.
 *
 * THE GAP THIS CLOSES. Live Activity is not a route; it is a Map overlay, and
 * on a phone it is collapsed behind a peek row and scoped to VIEWPORT. So a
 * fresh mobile load shows a truthful "0 in flow — pan the map or change scope"
 * and nothing else. Every earlier check therefore measured the EMPTY state and
 * said nothing about the feed itself: not the rows, not the severity
 * treatment, not whether a populated deck overflows or hides under the dock.
 *
 * This drives it to a populated state the way an operator would — open the
 * peek, open settings, widen scope from `viewport` to `global` — and measures
 * the deck with events actually in it.
 *
 * WHAT IT MEASURES:
 *   - the feed populates at global scope, with rows carrying real text
 *   - no horizontal overflow, with the deck open and full (§14)
 *   - no control trapped under the global dock (§14)
 *   - touch targets on event rows and deck controls (§30)
 *   - no fabricated-data tells in the rendered feed (§3)
 *   - the empty state remains truthful when scope genuinely has nothing (§10)
 *
 * READ ONLY. It opens the deck, changes a client-side display scope, and
 * reads. It never opens an event's action, never navigates into a deal, and
 * never mutates anything.
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
const TOUCH_MIN = 32

const OUT = path.resolve('artifacts/live-activity-populated')
await fs.mkdir(OUT, { recursive: true })

const findings = []
const check = (cell, label, ok, detail = '') => {
  if (!ok) findings.push({ cell, label, detail })
  return ok
}

/** Markers that would betray synthetic seed data reaching a live surface. */
const FAKE_TELLS = ['Demo ', 'Sample ', 'Lorem', 'Test Seller', 'John Doe', 'TC — Demo', 'DEMO DATA']

const probeDeck = (touchMin) => {
  const doc = document.documentElement
  const deck = document.querySelector('.nx-icm-activity')
  if (!deck) return { present: false }

  const dock = document.querySelector('.nx-pinned-app-dock')
  const dockTop = dock ? dock.getBoundingClientRect().top : null

  const cards = Array.from(deck.querySelectorAll('.nx-icm-activity__timeline-grid > *'))
  const rowTexts = cards.slice(0, 5).map((c) => (c.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80))

  const small = []
  for (const el of Array.from(deck.querySelectorAll('button, a[href], [role="button"], [role="tab"]'))) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    if (r.height < touchMin || r.width < touchMin) {
      small.push(`${Math.round(r.width)}x${Math.round(r.height)}:${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 20)}`)
    }
  }

  const deckRect = deck.getBoundingClientRect()

  /*
   * "Trapped under the dock" means VISIBLE and covered. The timeline is a
   * scroller — its content runs thousands of pixels past the deck's box — so
   * counting raw rects flagged two buttons on a card that was simply scrolled
   * out of view and clipped. getBoundingClientRect reports a real position for
   * clipped content, which is how that looked like a dock collision for three
   * rounds of chasing. An element only counts if it is inside the deck's own
   * visible box AND overlaps the dock.
   */
  let underDock = 0
  const underDockDetail = []
  if (dockTop !== null) {
    for (const el of Array.from(deck.querySelectorAll('button, a[href]'))) {
      const r = el.getBoundingClientRect()
      if (r.height === 0) continue
      const visibleInDeck = r.top >= deckRect.top - 1 && r.bottom <= deckRect.bottom + 1
      if (!visibleInDeck) continue
      if (r.bottom > dockTop && r.top < dockTop + 4) {
        underDock += 1
        underDockDetail.push(`${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 18)}@${Math.round(r.top)}-${Math.round(r.bottom)}`)
      }
    }
  }

  const text = (deck.innerText || '').replace(/\s+/g, ' ')
  return {
    present: true,
    overflow: Math.max(0, Math.round(doc.scrollWidth - doc.clientWidth)),
    rows: cards.length,
    rowTexts,
    small: Array.from(new Set(small)).slice(0, 5),
    underDock,
    underDockDetail,
    dockTop: dockTop === null ? null : Math.round(dockTop),
    deckBox: `${Math.round(deckRect.top)}-${Math.round(deckRect.bottom)}`,
    text: text.slice(0, 200),
    emptyShown: /No live operating events|No contextual intelligence/.test(text),
    wider: Array.from(deck.querySelectorAll('*'))
      .filter((el) => el.getBoundingClientRect().width > doc.clientWidth + 1).length,
  }
}

const browser = await chromium.launch()
let cells = 0

for (const width of WIDTHS) {
  for (const theme of THEMES) {
    const cell = `${width}-${theme}`
    const ctx = await browser.newContext({
      viewport: { width, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    })
    const page = await ctx.newPage()
    const pageErrors = []
    page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 120)))

    try {
      await page.addInitScript((t) => { try { localStorage.setItem('nexus.theme', t) } catch { /* ignore */ } }, theme)
      await page.goto(`${BASE}/map`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
      await page.waitForTimeout(9000)

      // ── open the collapsed deck ─────────────────────────────────────────
      const peek = page.locator('.nx-icm-activity__peek-row').first()
      check(cell, 'the collapsed deck is reachable', await peek.count() > 0, 'no peek row')
      if (await peek.count() > 0) {
        await peek.click({ timeout: 20_000 }).catch(() => {})
        await page.waitForTimeout(2000)
      }

      const collapsedState = await page.evaluate(probeDeck, TOUCH_MIN)
      check(cell, 'the deck opens', collapsedState.present === true, 'deck absent after peek')

      // An empty viewport scope must explain itself rather than show nothing.
      if (collapsedState.present && collapsedState.rows === 0) {
        check(cell, '§10 an empty scope states why it is empty',
          collapsedState.emptyShown === true, collapsedState.text)
      }

      // ── widen scope to global so the feed can populate ──────────────────
      const settingsBtn = page.locator('[aria-label="Settings"]').first()
      check(cell, 'the scope settings are reachable', await settingsBtn.count() > 0, 'no settings control')
      if (await settingsBtn.count() > 0) {
        await settingsBtn.click({ timeout: 20_000 }).catch(() => {})
        await page.waitForTimeout(1200)
        const globalChip = page.locator('.nx-icm-activity-settings__chip', { hasText: /^global$/ }).first()
        check(cell, 'a global scope exists', await globalChip.count() > 0, 'no global scope chip')
        if (await globalChip.count() > 0) {
          await globalChip.click({ timeout: 15_000 }).catch(() => {})
          await page.waitForTimeout(1200)
        }
        await page.locator('[aria-label="Close settings"]').first().click({ timeout: 10_000 }).catch(() => {})
        await page.waitForSelector('.nx-icm-activity-sheet', { state: 'detached', timeout: 10_000 }).catch(() => {})
        /*
         * Wait for the feed to actually recompute, not a fixed guess. Changing
         * scope re-runs the engine over a wider set, and a 2.5s sleep was long
         * enough on the dev server and short enough on the production build to
         * report "0 in flow" over a feed that was about to render 18 rows.
         */
        await page.waitForFunction(
          () => document.querySelectorAll('.nx-icm-activity__timeline-grid > *').length > 0,
          undefined, { timeout: 15_000 },
        ).catch(() => {})
        await page.waitForTimeout(600)
      }

      const populated = await page.evaluate(probeDeck, TOUCH_MIN)
      await page.screenshot({ path: path.join(OUT, `${cell}-populated.png`) })

      // THE POINT OF THE PROOF: a feed with events actually in it.
      check(cell, 'POPULATED — the feed carries events at global scope',
        populated.rows > 0, `rows=${populated.rows} text="${populated.text}"`)
      if (populated.rows > 0) {
        check(cell, 'event rows carry real text',
          populated.rowTexts.every((t) => t.length > 8), JSON.stringify(populated.rowTexts.slice(0, 2)))
        check(cell, '§3 no fabricated-data tells in the feed',
          !FAKE_TELLS.some((t) => populated.text.includes(t)), populated.text)
      }
      check(cell, '§14 no horizontal overflow with the deck populated',
        populated.overflow === 0, `${populated.overflow}px`)
      check(cell, '§14 nothing in the deck is wider than the viewport',
        populated.wider === 0, `${populated.wider} element(s)`)
      check(cell, '§14 no deck control trapped under the dock',
        populated.underDock === 0,
        `${populated.underDock} control(s): ${populated.underDockDetail.join(', ')} | dockTop=${populated.dockTop} deck=${populated.deckBox}`)
      check(cell, `§30 deck touch targets >= ${TOUCH_MIN}px`,
        populated.small.length === 0, populated.small.join(', '))
      check(cell, 'no page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))

      console.log(`${cell}  rows=${populated.rows} overflow=${populated.overflow} wider=${populated.wider} small=${populated.small.length} underDock=${populated.underDock} err=${pageErrors.length}`)
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
