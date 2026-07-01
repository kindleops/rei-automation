import { test, expect } from '@playwright/test'
import { MAP_VISUAL_PRESET_OPTIONS } from '../../src/views/map/map-visual-presets'
import {
  MAP_DIAGNOSTICS_DEBUG_KEY,
  MAP_VERIFICATION_MODE_KEY,
} from '../../src/views/map/map-property-diagnostics-debug'
import { MAP_VISUAL_PRESET_STORAGE_KEY } from '../../src/views/map/map-visual-presets'
import {
  assertNoDuplicateMarkers,
  assertNoInvariantViolations,
  enableMapVerification,
  flyMap,
  MAP_BASE,
  readDiagnostics,
  waitForMapIdle,
} from './map-verification-helpers'

const THEME_CYCLE = ['satellite', 'red_ops', 'matrix', 'light_street', 'dark_ops', 'blueprint', 'satellite'] as const
const PROOF_CENTER: [number, number] = [-118.35, 34.08]

for (const preset of MAP_VISUAL_PRESET_OPTIONS) {
  test(`theme ${preset.id} preserves sprites and layers`, async ({ page }) => {
    await enableMapVerification(page, preset.id)
    await page.goto(`${MAP_BASE}/map?mapDiagnostics=1`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('.nx-icm__canvas').first()).toBeVisible({ timeout: 60000 })
    await page.waitForFunction(() => Boolean((window as unknown as { __nexusCommandMap?: unknown }).__nexusCommandMap), null, { timeout: 60000 })

    await flyMap(page, 12, PROOF_CENTER)
    await waitForMapIdle(page, 5000)

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
  test.setTimeout(360_000)
  await enableMapVerification(page)

  for (const themeId of THEME_CYCLE) {
    await page.addInitScript(([presetKey, verificationKey, debugKey, preset]) => {
      window.localStorage.setItem(presetKey, preset)
      window.localStorage.setItem(verificationKey, '1')
      window.localStorage.setItem(debugKey, '1')
    }, [MAP_VISUAL_PRESET_STORAGE_KEY, MAP_VERIFICATION_MODE_KEY, MAP_DIAGNOSTICS_DEBUG_KEY, themeId] as const)

    await page.goto(`${MAP_BASE}/map?mapDiagnostics=1`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('.nx-icm__canvas').first()).toBeVisible({ timeout: 60000 })
    await page.waitForFunction(() => Boolean((window as unknown as { __nexusCommandMap?: unknown }).__nexusCommandMap), null, { timeout: 60000 })
    await flyMap(page, 11, PROOF_CENTER)
    await waitForMapIdle(page, 4000)
    await assertNoInvariantViolations(page)
    await assertNoDuplicateMarkers(page)
  }

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