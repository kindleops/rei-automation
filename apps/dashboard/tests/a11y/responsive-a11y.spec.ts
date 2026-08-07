/**
 * Lane G — responsive + accessibility merge gate.
 * Constitution §15 (responsive) · §16 (accessibility) · §17 (budgets).
 *
 *   npm run gate:a11y                      # default route set, 4 viewports
 *   LC_A11Y_ROUTES=all npm run gate:a11y   # all 16 routes
 *   LC_BASE_URL=http://127.0.0.1:5188 npm run gate:a11y
 *
 * The suite asserts against a RUNNING preview/dev server; it never starts one,
 * because the operator's API and dashboard are long-lived shared processes.
 */
import { expect, test, type Page } from '@playwright/test'
import { runLcAudit, type LcAuditResult } from './lc-audit'
import { partitionGaps, SHELL_PROBE, STRICT } from './known-gaps'
import {
  ALLOWED_BREAKPOINT_VALUES,
  LC_BAND_MIN,
  resolveBand,
} from '../../src/modules/mobile/breakpoints'

/**
 * Overflow/type viewports mirror the capture harness. NOTE: its "tablet" is
 * 1024px wide, which by §15 is the FIRST lg width, not md — the md band ends at
 * 1023. Both are exercised: 1024 here, and 820 (iPad Air portrait, a real md
 * width) in the touch-target suite below.
 */
const VIEWPORTS = {
  desktop: { width: 1728, height: 1080 },
  laptop: { width: 1440, height: 900 },
  tablet: { width: 1024, height: 768 },
  mobile: { width: 390, height: 844 },
} as const
type ViewportName = keyof typeof VIEWPORTS

/** §15.3 is a *touch* requirement, so it is asserted on touch-shaped bands. */
const TOUCH_VIEWPORTS = {
  'md-tablet': { width: 820, height: 1180 },
  'xs-phone': { width: 390, height: 844 },
} as const

const ALL_ROUTES = [
  '/inbox',
  '/conversation',
  '/deal-intelligence',
  '/properties',
  '/comp-intelligence',
  '/buyer-match',
  '/queue',
  '/pipeline',
  '/calendar',
  '/map',
  '/analytics',
  '/closing-desk',
  '/campaign-command',
  '/email-command',
  '/workflow-studio',
  '/entity-graph',
]

/** Representative default: one route per layout family, plus the two worst offenders. */
const DEFAULT_ROUTES = ['/inbox', '/queue', '/calendar', '/analytics', '/pipeline', '/deal-intelligence']

const routes =
  process.env.LC_A11Y_ROUTES === 'all'
    ? ALL_ROUTES
    : process.env.LC_A11Y_ROUTES
      ? process.env.LC_A11Y_ROUTES.split(',').map((r) => r.trim())
      : DEFAULT_ROUTES

/** Routes whose product surface is a full-bleed map/canvas that owns its own gestures. */
const CANVAS_ROUTES = new Set(['/map'])

async function settle(page: Page, route: string) {
  await page.goto(route, { waitUntil: 'domcontentloaded' })
  // The dev tree is large; wait for React to mount real content rather than a timer.
  await page
    .waitForFunction(() => document.querySelectorAll('#root *').length > 200, null, {
      timeout: 90_000,
      polling: 250,
    })
    .catch(() => undefined)
  await page.waitForTimeout(2500)
}

async function audit(page: Page): Promise<LcAuditResult> {
  return page.evaluate(runLcAudit)
}

const fmt = (rows: unknown[], n = 8) =>
  JSON.stringify(rows.slice(0, n), null, 1)

test.describe('§15 responsive', () => {
  for (const route of routes) {
    for (const [name, viewport] of Object.entries(VIEWPORTS) as [ViewportName, { width: number; height: number }][]) {
      test(`${route} @ ${name} — no horizontal overflow, 11px type floor`, async ({ page }) => {
        await page.setViewportSize(viewport)
        await settle(page, route)
        const a = await audit(page)

        // R15.2 — zero horizontal overflow at every breakpoint.
        expect(
          a.documentOverflowPx,
          `${route} @${name}: document scrolls horizontally by ${a.documentOverflowPx}px`,
        ).toBeLessThanOrEqual(1)

        expect(
          a.overflowers,
          `${route} @${name}: ${a.overflowers.length} elements extend past the viewport\n${fmt(a.overflowers)}`,
        ).toHaveLength(0)

        // §2.1 / §17 — zero sub-11px text elements.
        const tiny = partitionGaps(a.tiny)
        if (tiny.deferred.length) {
          test.info().annotations.push({
            type: 'deferred (other lane)',
            description: `${tiny.deferred.length} sub-11px elements: ${fmt(tiny.deferred, 4)}`,
          })
        }
        expect(
          tiny.failures,
          `${route} @${name}: ${tiny.failures.length} sub-11px text elements\n${fmt(tiny.failures)}`,
        ).toHaveLength(0)
      })
    }
  }

  for (const route of routes) {
    for (const [name, viewport] of Object.entries(TOUCH_VIEWPORTS)) {
      test(`${route} @ ${name} — 44px touch targets`, async ({ page }) => {
        test.skip(CANVAS_ROUTES.has(route), 'full-bleed map canvas owns its own controls')
        await page.setViewportSize(viewport)
        await settle(page, route)
        const a = await audit(page)

        // R15.3 — 44×44 minimum on touch-shaped viewports.
        expect(
          a.smallTargets,
          `${route} @${name}: ${a.smallTargets.length} sub-44px touch targets\n${fmt(a.smallTargets, 12)}`,
        ).toHaveLength(0)
      })
    }
  }
})

test.describe('§16 accessibility', () => {
  for (const route of routes) {
    test(`${route} — landmarks, names, headings`, async ({ page }) => {
      await page.setViewportSize(VIEWPORTS.laptop)
      await settle(page, route)
      const a = await audit(page)
      const shell = await page.evaluate(SHELL_PROBE)

      // R16.6 / R16.5 — landmarks, the skip link and the single <h1> are owned
      // by Lane A's shell. Enforced the moment that shell is present; reported
      // (not failed) on a branch that predates it. See known-gaps.ts.
      const shellPresent = shell.main && shell.rail && shell.skipLink
      if (shellPresent || STRICT) {
        expect(a.landmarks.main, `${route}: no <main>/role="main"`).toBeGreaterThanOrEqual(1)
        expect(a.landmarks.navigation, `${route}: no <nav>/role="navigation"`).toBeGreaterThanOrEqual(1)
        expect(a.landmarks.banner, `${route}: no <header>/role="banner"`).toBeGreaterThanOrEqual(1)
        expect(a.h1Count, `${route}: ${a.h1Count} <h1> elements`).toBe(1)
        expect(shell.skipLink, `${route}: no skip link`).toBe(true)
      } else {
        test.info().annotations.push({
          type: 'deferred (Lane A shell)',
          description:
            `landmarks main=${a.landmarks.main} nav=${a.landmarks.navigation} ` +
            `banner=${a.landmarks.banner} h1=${a.h1Count} skipLink=${shell.skipLink} — ` +
            'shell primitives land with ui/lane-a-shell; enforced once integrated.',
        })
      }

      // R16.4 — every control has an accessible name.
      expect(
        a.unnamedButtons,
        `${route}: ${a.unnamedButtons.length} buttons without an accessible name\n${fmt(a.unnamedButtons, 12)}`,
      ).toHaveLength(0)
      // §16 — every dialog is named.
      const unnamedDialogs = a.dialogs.filter((d) => !d.named)
      expect(unnamedDialogs, `${route}: unnamed dialogs\n${fmt(unnamedDialogs)}`).toHaveLength(0)
    })

    test(`${route} — contrast (primary theme: dark + cyan)`, async ({ page }) => {
      await page.setViewportSize(VIEWPORTS.laptop)
      await settle(page, route)
      const a = await audit(page)

      // R16.1 — body ≥4.5:1, large text and UI boundaries ≥3:1.
      const contrast = partitionGaps(a.contrastFailures)
      if (contrast.deferred.length) {
        test.info().annotations.push({
          type: 'deferred (other lane)',
          description: `${contrast.deferred.length} contrast failures: ${fmt(contrast.deferred, 4)}`,
        })
      }
      expect(
        contrast.failures,
        `${route}: ${contrast.failures.length} text nodes below the required ratio` +
          `${STRICT ? ' (STRICT)' : ''}\n${fmt(contrast.failures, 12)}`,
      ).toHaveLength(0)
    })
  }

  test('R16.9 — prefers-reduced-motion suppresses animation globally', async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: 'reduce', viewport: VIEWPORTS.laptop })
    const page = await context.newPage()
    await settle(page, '/queue')
    const a = await audit(page)
    expect(
      a.animatedAfterReducedMotion,
      `${a.animatedAfterReducedMotion} elements still animate/transition under prefers-reduced-motion`,
    ).toBe(0)
    await context.close()
  })

  test('R16.2 — keyboard focus stays visible while tabbing', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.laptop)
    await settle(page, '/queue')

    const unfocused: string[] = []
    const stops: string[] = []
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab')
      const state = await page.evaluate(() => {
        const el = document.activeElement
        if (!el || el === document.body) return { lost: true, selector: 'body', ring: false }
        const cs = getComputedStyle(el)
        const width = parseFloat(cs.outlineWidth) || 0
        // R16.2 requires a real ring: 2px. A border colour delta is not one.
        const ring = cs.outlineStyle !== 'none' && width >= 2
        const cls = typeof el.className === 'string' ? el.className.split(/\s+/).slice(0, 2).join('.') : ''
        return { lost: false, selector: `${el.tagName.toLowerCase()}.${cls}`, ring }
      })
      stops.push(state.lost ? 'body' : state.selector)
      if (!state.lost && !state.ring) unfocused.push(state.selector)
    }

    /**
     * R16.3 — focus is never LOST. Chromium parks on <body> for exactly one
     * stop when the tab ring wraps past the last focusable element (it is
     * handing focus to browser chrome), then returns to the first control.
     * Measured on /analytics: 7 focusables ⇒ `body` at tab 9, 18, 27, each
     * followed immediately by a real element. That is a document wrap, not a
     * defect. Only CONSECUTIVE body stops mean focus is genuinely stuck.
     */
    const stuck = stops.findIndex((s, i) => s === 'body' && stops[i + 1] === 'body')
    expect(stuck, `focus stuck on <body> from tab ${stuck + 1}:\n${fmt(stops, 25)}`).toBe(-1)

    expect(unfocused, `elements focused with no visible indicator:\n${fmt(unfocused, 10)}`).toHaveLength(0)
  })
})

test.describe('§15.1 breakpoint contract', () => {
  test('JS bands and CSS media queries agree at every boundary', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.laptop)
    await settle(page, '/queue')

    // The exact widths where CSS and JS previously disagreed.
    const probes = [479, 480, 767, LC_BAND_MIN.md, 1023, LC_BAND_MIN.lg, 1439, LC_BAND_MIN.xl]
    for (const width of probes) {
      await page.setViewportSize({ width, height: 900 })
      const css = await page.evaluate(() => ({
        xs: matchMedia('(max-width: 479.98px)').matches,
        sm: matchMedia('(max-width: 767.98px)').matches,
        md: matchMedia('(max-width: 1023.98px)').matches,
        lg: matchMedia('(max-width: 1439.98px)').matches,
        xlUp: matchMedia('(min-width: 1440px)').matches,
        width: innerWidth,
      }))
      const band = resolveBand(css.width)
      expect(css.xs, `@${css.width}: CSS xs vs JS ${band}`).toBe(band === 'xs')
      expect(css.sm, `@${css.width}: CSS sm-down vs JS ${band}`).toBe(band === 'xs' || band === 'sm')
      expect(css.md, `@${css.width}: CSS md-down vs JS ${band}`).toBe(band !== 'lg' && band !== 'xl')
      expect(css.lg, `@${css.width}: CSS lg-down vs JS ${band}`).toBe(band !== 'xl')
      expect(css.xlUp, `@${css.width}: CSS xl-up vs JS ${band}`).toBe(band === 'xl')
    }
  })

  test('the allowed breakpoint set is exactly the five §15 bands', () => {
    expect([...ALLOWED_BREAKPOINT_VALUES].sort((a, b) => a - b)).toEqual([
      479.98, 480, 767.98, 768, 1023.98, 1024, 1439.98, 1440,
    ])
  })
})
