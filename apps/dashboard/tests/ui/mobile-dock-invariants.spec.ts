import { expect, test } from '@playwright/test'

/**
 * THE MOBILE DOCK INTERACTION CONTRACT.
 *
 * The dock is a three-phase grab shelf, and the phases are a product decision rather
 * than an implementation detail:
 *
 *   collapsed  a thin line. NO application icons at all.
 *   docked     the pinned apps, wrapping onto as many rows as they need.
 *   expanded   the full catalogue, with drag-in and drag-out.
 *
 * A permanent icon rail was built into the collapsed phase once and had to be reverted.
 * These tests exist so that cannot happen silently again — and critically, the
 * collapsed assertion counts BUTTONS rather than measuring height. A short dock that
 * nonetheless renders four icons would pass a height check and still be the exact
 * regression this guards against.
 */

const MOBILE = { width: 390, height: 844 }

const APP_BUTTON = '.nx-pinned-app-dock__app, .nx-pinned-app-dock__rail-app'
const DOCK = '.nx-pinned-app-dock'
const HANDLE = '.nx-pinned-app-dock__handle'
const TRACK_APP = '.nx-pinned-app-dock__track .nx-pinned-app-dock__app'
const CATALOG_APP = '.nx-pinned-app-dock__sheet .nx-pinned-app-dock__app'

test.use({ viewport: MOBILE, isMobile: true, hasTouch: true })

test.beforeEach(async ({ page }) => {
  await page.goto('/inbox')
  await page.waitForSelector(DOCK, { timeout: 60_000 })
  // The dock mounts with the shell, well before inbox data settles.
  await page.waitForTimeout(1500)
})

test('collapsed dock renders ZERO app buttons', async ({ page }) => {
  await expect(page.locator(`${DOCK}.is-collapsed`)).toHaveCount(1)

  /**
   * Visibility is tested the way the OPERATOR experiences it, not by reading styles
   * off the button.
   *
   * The pinned track and the catalogue stay mounted while collapsed — the dock
   * animates them open by relaxing a max-height — so every app button still reports a
   * non-zero bounding box and `opacity: 1` of its own. A naive style check counts
   * fifteen "visible" buttons in a dock the operator sees none of.
   *
   * So: walk the ancestors for display/visibility/opacity, honour any ancestor that
   * clips with overflow, and finally confirm the button is genuinely the thing painted
   * at its own centre. That is a check a future icon rail cannot slip past.
   */
  const visibleAppButtons = await page.locator(APP_BUTTON).evaluateAll((nodes) =>
    nodes.filter((node) => {
      const rect = node.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return false
      if (rect.bottom <= 0 || rect.top >= window.innerHeight) return false

      for (let el: Element | null = node; el; el = el.parentElement) {
        const style = getComputedStyle(el)
        if (style.display === 'none' || style.visibility === 'hidden') return false
        if (Number.parseFloat(style.opacity) === 0) return false
        if (el !== node && style.overflow !== 'visible') {
          const clip = el.getBoundingClientRect()
          const intersects = rect.bottom > clip.top + 0.5
            && rect.top < clip.bottom - 0.5
            && rect.right > clip.left + 0.5
            && rect.left < clip.right - 0.5
          if (!intersects) return false
        }
      }

      const painted = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      )
      return Boolean(painted && (node === painted || node.contains(painted) || painted.contains(node)))
    }).length,
  )
  expect(visibleAppButtons).toBe(0)
})

test('collapsed dock is a thin shelf with a full-size touch target', async ({ page }) => {
  const glass = await page.locator('.nx-pinned-app-dock__glass').boundingBox()
  expect(glass).not.toBeNull()
  // A shelf, not a bar. Generous upper bound so tuning the paint does not fail this.
  expect(glass!.height).toBeLessThanOrEqual(28)

  // The PAINT may be thin; the TARGET may not. 44px is the accessibility floor, and it
  // is met by extending the handle invisibly above the shelf rather than by growing it.
  const handle = await page.locator(HANDLE).boundingBox()
  expect(handle).not.toBeNull()
  expect(handle!.height).toBeGreaterThanOrEqual(44)

  // And it must sit against the bottom edge, inside the safe area.
  const viewport = page.viewportSize()!
  expect(glass!.y + glass!.height).toBeGreaterThan(viewport.height - 24)
})

test('content is never hidden behind the collapsed dock', async ({ page }) => {
  const reserved = await page.evaluate(() => {
    const shell = document.querySelector('.nx-premium-inbox, .nx-fullscreen-app-shell')
    if (!shell) return null
    return getComputedStyle(shell).paddingBottom
  })
  expect(reserved).not.toBeNull()
  expect(parseFloat(reserved as string)).toBeGreaterThan(0)
})

test('tapping the handle reveals the pinned apps, wrapping without horizontal scroll', async ({ page }) => {
  await page.click(HANDLE)
  await page.waitForTimeout(600)

  await expect(page.locator(`${DOCK}.is-docked`)).toHaveCount(1)

  const pinned = page.locator(TRACK_APP)
  const count = await pinned.count()
  expect(count).toBeGreaterThan(0)

  // Wrapping, not a hidden horizontal scroller. The prior single-row flex track kept
  // pins five and beyond off the right edge with no affordance saying so.
  const geometry = await page.locator('.nx-pinned-app-dock__track').evaluate((track) => ({
    scrollWidth: track.scrollWidth,
    clientWidth: track.clientWidth,
  }))
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1)

  // Every pinned app is actually on screen.
  const fullyVisible = await pinned.evaluateAll((nodes) =>
    nodes.filter((node) => {
      const r = node.getBoundingClientRect()
      return r.left >= -1 && r.right <= window.innerWidth + 1 && r.top >= 0 && r.bottom <= window.innerHeight + 1
    }).length,
  )
  expect(fullyVisible).toBe(count)
})

test('expanding reveals the full catalogue with drag-in and drag-out affordances', async ({ page }) => {
  await page.click(HANDLE)
  await page.waitForTimeout(500)
  await page.click('.nx-pinned-app-dock__customize')
  await page.waitForTimeout(700)

  await expect(page.locator(`${DOCK}.is-expanded`)).toHaveCount(1)
  await expect(page.locator(CATALOG_APP).first()).toBeVisible()
  await expect(page.locator('.nx-pinned-app-dock__unpin-zone')).toBeVisible()
  await expect(page.locator('.nx-pinned-app-dock__drop-slot')).toBeVisible()

  // Every application the registry exposes has to be reachable from here: the pinned
  // track plus the catalogue must together cover the dockable set. Properties, Entity
  // Graph, Comp Intelligence and Buyer Match were unreachable on mobile before.
  const labels = await page.locator(APP_BUTTON).evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('aria-label')).filter(Boolean) as string[],
  )
  for (const required of ['Properties', 'Entity Graph', 'Comp Intelligence', 'Buyer Match']) {
    expect(labels).toContain(required)
  }
})

test('pinned order is preserved across a reload', async ({ page }) => {
  await page.click(HANDLE)
  await page.waitForTimeout(500)
  const before = await page.locator(TRACK_APP).evaluateAll((n) => n.map((x) => x.getAttribute('aria-label')))

  await page.reload()
  await page.waitForSelector(DOCK, { timeout: 60_000 })
  await page.waitForTimeout(1500)
  await page.click(HANDLE)
  await page.waitForTimeout(500)

  const after = await page.locator(TRACK_APP).evaluateAll((n) => n.map((x) => x.getAttribute('aria-label')))
  expect(after).toEqual(before)
})
