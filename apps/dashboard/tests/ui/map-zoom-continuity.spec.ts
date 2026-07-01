import { test, expect } from '@playwright/test'
import { enableMapVerification, flyMap, openMap, readWindowDiagnostics, waitForMapIdle } from './map-verification-helpers'

const ZOOM_SAMPLES = [3, 5.5, 7, 8.5, 9, 10.5, 11.5, 12.5, 13.5, 15, 18]

test.describe('Map zoom continuity', () => {
  test.beforeEach(async ({ page }) => {
    await enableMapVerification(page)
    await openMap(page)
  })

  for (const zoom of ZOOM_SAMPLES) {
    test(`no blank representation at zoom ${zoom}`, async ({ page }) => {
      const center: [number, number] = zoom < 8 ? [-98, 39] : [-118.35, 34.08]
      await flyMap(page, zoom, center)
      await waitForMapIdle(page, zoom >= 9 && zoom < 11 ? 10_000 : zoom >= 9 ? 6000 : 3500)

      const diag = await readWindowDiagnostics(page)
      expect(diag).not.toBeNull()
      const snapshot = {
        zoom: Number(diag?.zoom ?? 0),
        sourceMode: String(diag?.sourceMode ?? ''),
        aggregateTotal: Number(diag?.aggregateTotal ?? 0),
        clusteredPropertyTotal: Number(diag?.clusteredPropertyTotal ?? 0),
        renderedIndividualIcons: Number(diag?.renderedIndividualIcons ?? 0),
        renderedHalos: Number(diag?.renderedHalos ?? 0),
        tileBacked: Boolean(diag?.tileBacked),
        representedPropertyTotal: Number(diag?.representedPropertyTotal ?? diag?.representedFeatures ?? 0),
      }

      expect(snapshot.zoom).toBeGreaterThan(0)

      if (zoom < 6) {
        expect(snapshot.aggregateTotal > 0 || snapshot.representedPropertyTotal > 0).toBe(true)
        expect(snapshot.tileBacked).toBe(false)
      } else if (zoom < 9) {
        expect(snapshot.representedPropertyTotal > 0 || snapshot.clusteredPropertyTotal > 0).toBe(true)
      } else {
        expect(snapshot.tileBacked).toBe(true)
        expect(snapshot.renderedIndividualIcons > 0 || snapshot.representedPropertyTotal > 0).toBe(true)
      }
    })
  }
})