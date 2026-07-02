import { test, expect } from '@playwright/test'
import { MAP_VISUAL_PRESET_OPTIONS } from '../../src/views/map/map-visual-presets'
import {
  MAP_DIAGNOSTICS_DEBUG_KEY,
  MAP_VERIFICATION_MODE_KEY,
} from '../../src/views/map/map-property-diagnostics-debug'
import { MAP_VISUAL_PRESET_STORAGE_KEY } from '../../src/views/map/map-visual-presets'
import {
  assertMapCanvasFillsContainer,
  assertNoDuplicateMarkers,
  assertNoInvariantViolations,
  enableMapVerification,
  flyMap,
  MAP_BASE,
  openMap,
  readDiagnostics,
  switchThemeInApp,
  waitForMapIdle,
} from './map-verification-helpers'

// Covers raster ↔ vector swaps and paint-only presets without full page reloads.
const THEME_CYCLE = ['satellite', 'red_ops', 'light_street', 'terrain', 'matrix', 'satellite'] as const
const PROOF_CENTER: [number, number] = [-118.35, 34.08]

for (const preset of MAP_VISUAL_PRESET_OPTIONS) {
  test(`theme ${preset.id} preserves sprites and layers`, async ({ page }) => {
    await enableMapVerification(page, preset.id)
    await page.goto(`${MAP_BASE}/map?mapDiagnostics=1`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('.nx-icm__canvas').first()).toBeVisible({ timeout: 60000 })
    await page.waitForFunction(() => Boolean((window as unknown as { __nexusCommandMap?: unknown }).__nexusCommandMap), null, { timeout: 60000 })

    await flyMap(page, 12, PROOF_CENTER)
    await waitForMapIdle(page, 5000)
    await assertMapCanvasFillsContainer(page)

    const diag = await readDiagnostics(page)
    expect(diag).toMatch(/tile_backed[\s\S]*true/i)

    const spriteCount = await page.evaluate(() => {
      const map = (window as unknown as { __nexusCommandMap?: { listImages?: () => string[]; style?: { sprite?: string } } }).__nexusCommandMap
      if (!map?.listImages) return 0
      return map.listImages().filter((id) => id.startsWith('nexus-pin-')).length
    })
    expect(spriteCount).toBeGreaterThan(8)

    await assertNoInvariantViolations(page)
    await assertNoDuplicateMarkers(page)

    await page.screenshot({
      path: `proof/map-themes/${preset.id}-desktop.png`,
      fullPage: false,
    })
  })
}

test('repeated theme switching returns to stable satellite state', async ({ page }) => {
  test.setTimeout(240_000)
  await enableMapVerification(page, 'satellite')
  await openMap(page)
  await flyMap(page, 11, PROOF_CENTER)
  await waitForMapIdle(page, 2500)
  await assertMapCanvasFillsContainer(page)

  for (const themeId of THEME_CYCLE.slice(1)) {
    await switchThemeInApp(page, themeId)
    await assertNoInvariantViolations(page)
    await assertNoDuplicateMarkers(page)
  }

  await flyMap(page, 11, PROOF_CENTER)
  await waitForMapIdle(page, 2500)
  await assertMapCanvasFillsContainer(page)

  const camera = await page.evaluate(() => {
    const map = (window as unknown as { __nexusCommandMap?: { getCenter: () => { lng: number; lat: number }; getZoom: () => number } }).__nexusCommandMap
    if (!map) return null
    const center = map.getCenter()
    return { lng: center.lng, lat: center.lat, zoom: map.getZoom() }
  })
  expect(camera?.zoom ?? 0).toBeGreaterThan(10)
  expect(Math.abs((camera?.lng ?? 0) - PROOF_CENTER[0])).toBeLessThan(0.05)
  expect(Math.abs((camera?.lat ?? 0) - PROOF_CENTER[1])).toBeLessThan(0.05)

  const diag = await readDiagnostics(page)
  expect(diag).toMatch(/tile_backed[\s\S]*true/i)
  await page.screenshot({ path: 'proof/map-themes/theme-cycle-final-satellite-desktop.png', fullPage: false })
})