import { test, expect } from '@playwright/test'
import {
  assertNoDuplicateMarkers,
  assertNoInvariantViolations,
  enableMapVerification,
  flyMap,
  openMap,
  waitForMapIdle,
} from './map-verification-helpers'

const ZOOM_SAMPLES = [4, 7, 9, 10, 12, 14, 16]

test.describe('Map render invariants', () => {
  test.beforeEach(async ({ page }) => {
    await enableMapVerification(page)
    await openMap(page)
  })

  for (const zoom of ZOOM_SAMPLES) {
    test(`no halo/cluster invariant violations at zoom ${zoom}`, async ({ page }) => {
      await flyMap(page, zoom, zoom < 8 ? [-98, 39] : [-118.35, 34.08])
      await waitForMapIdle(page, zoom >= 9 && zoom < 11 ? 12_000 : zoom >= 9 ? 10_000 : 6000)
      await assertNoInvariantViolations(page)
      await assertNoDuplicateMarkers(page)

      const blank = await page.evaluate((z) => {
        const diag = (window as unknown as { __nexusMapDiagnostics?: Record<string, number | boolean> }).__nexusMapDiagnostics
        if (!diag) return false
        const icons = Number(diag.renderedIndividualIcons ?? 0)
        const clusters = Number(diag.renderedClusters ?? 0)
        const aggregate = Number(diag.aggregateTotal ?? 0)
        const represented = Number(diag.representedPropertyTotal ?? diag.representedFeatures ?? 0)
        const uniqueTile = Number(diag.uniqueTilePropertyIds ?? 0)
        const clusteredTotal = Number(diag.clusteredPropertyTotal ?? 0)
        if (z < 9) return aggregate > 0 || represented > 0 || clusters > 0 || clusteredTotal > 0
        return icons > 0 || represented > 0 || uniqueTile > 0 || clusteredTotal > 0
      }, zoom)
      expect(blank).toBe(true)
    })
  }

  test('seller pins remain enrichment-only (no duplicate universe)', async ({ page }) => {
    await flyMap(page, 12, [-118.35, 34.08])
    await waitForMapIdle(page, 5000)

    const sellerLayerVisible = await page.evaluate(() => {
      const map = (window as unknown as { __nexusCommandMap?: { getLayoutProperty: (layer: string, prop: string) => string; getLayer: (id: string) => unknown } }).__nexusCommandMap
      if (!map?.getLayer('seller-pins-icon')) return false
      return map.getLayoutProperty('seller-pins-icon', 'visibility') === 'visible'
    })
    expect(sellerLayerVisible).toBe(false)
    await assertNoDuplicateMarkers(page)
  })
})