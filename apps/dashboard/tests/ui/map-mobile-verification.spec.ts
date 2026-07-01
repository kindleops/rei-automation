import { test, expect, devices } from '@playwright/test'
import {
  assertNoDuplicateMarkers,
  assertNoInvariantViolations,
  enableMapVerification,
  flyMap,
  MAP_BASE,
  waitForMapIdle,
} from './map-verification-helpers'

const MOBILE_VIEWPORTS = [
  { name: 'iphone-14', ...devices['iPhone 14'] },
  { name: 'pixel-7', ...devices['Pixel 7'] },
] as const

for (const device of MOBILE_VIEWPORTS) {
  test.describe(`Mobile map verification (${device.name})`, () => {
    test.use({
      viewport: device.viewport,
      userAgent: device.userAgent,
      isMobile: device.isMobile,
      hasTouch: device.hasTouch,
    })

    test('national and dense neighborhood representation', async ({ page }) => {
      test.setTimeout(240_000)
      await enableMapVerification(page)
      await page.goto(`${MAP_BASE}/map?mapDiagnostics=1`, { waitUntil: 'domcontentloaded' })
      await expect(page.locator('.nx-icm__canvas').first()).toBeVisible({ timeout: 60000 })
      await page.waitForFunction(() => Boolean((window as unknown as { __nexusCommandMap?: unknown }).__nexusCommandMap), null, { timeout: 60000 })

      await flyMap(page, 4, [-98, 39])
      await waitForMapIdle(page, 4000)
      await page.screenshot({ path: `proof/map-mobile/${device.name}-national.png`, fullPage: false })

      await flyMap(page, 7.5, [-96.8, 32.8])
      await waitForMapIdle(page, 4000)
      await page.screenshot({ path: `proof/map-mobile/${device.name}-metro.png`, fullPage: false })

      await flyMap(page, 12, [-118.35, 34.08])
      await waitForMapIdle(page, 8000)
      await assertNoInvariantViolations(page)
      await assertNoDuplicateMarkers(page)
      await page.screenshot({ path: `proof/map-mobile/${device.name}-la-dense.png`, fullPage: false })

      await flyMap(page, 14, [-77.966748, 35.645544])
      await waitForMapIdle(page, 5000)
      await page.screenshot({ path: `proof/map-mobile/${device.name}-single-family.png`, fullPage: false })
    })
  })
}