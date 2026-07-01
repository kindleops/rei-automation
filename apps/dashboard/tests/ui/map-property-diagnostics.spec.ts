import { test, expect } from '@playwright/test'
import {
  enableMapVerification,
  flyMap,
  openMap,
  readDiagnostics,
  waitForMapIdle,
} from './map-verification-helpers'

const ZOOM_PRESETS = [
  { name: 'national', zoom: 4, center: [-98, 39] as [number, number] },
  { name: 'metro', zoom: 7.5, center: [-96.8, 32.8] as [number, number] },
  { name: 'city', zoom: 10, center: [-118.25, 34.05] as [number, number] },
  { name: 'neighborhood', zoom: 12, center: [-118.35, 34.08] as [number, number] },
  { name: 'street', zoom: 14.5, center: [-118.36, 34.082] as [number, number] },
]

test.describe('Map property diagnostics and tile source', () => {
  test.beforeEach(async ({ page }) => {
    await enableMapVerification(page)
    await openMap(page)
  })

  for (const preset of ZOOM_PRESETS) {
    test(`diagnostics at ${preset.name} zoom`, async ({ page }) => {
      await flyMap(page, preset.zoom, preset.center)
      await waitForMapIdle(page, preset.zoom >= 9 ? 5000 : 4000)

      const diagnostics = await readDiagnostics(page)
      expect(diagnostics).toMatch(/zoom/i)
      expect(diagnostics).toMatch(/represented_property_total|represented_features/i)
      if (preset.zoom >= 9) {
        expect(diagnostics).toMatch(/tile_backed[\s\S]*true/i)
        expect(diagnostics).toMatch(/clipped[\s\S]*false/i)
      }

      await page.screenshot({
        path: `proof/map-diagnostics/${preset.name}-desktop.png`,
        fullPage: false,
      })
    })
  }
})