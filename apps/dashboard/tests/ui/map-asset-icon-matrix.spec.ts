import { test, expect } from '@playwright/test'
import { MAP_ASSET_PROOF_MANIFEST } from '../../src/views/map/map-asset-proof-manifest'
import {
  assertNoDuplicateMarkers,
  assertNoInvariantViolations,
  assertPropertyIconVisible,
  enableMapVerification,
  flyMap,
  openMap,
  readDiagnostics,
  waitForMapIdle,
} from './map-verification-helpers'

test.describe('Map asset icon proof matrix', () => {
  test.beforeEach(async ({ page }) => {
    await enableMapVerification(page)
    await openMap(page)
  })

  for (const entry of MAP_ASSET_PROOF_MANIFEST) {
    test(`renders ${entry.markerKey} sprite (${entry.screenshotSlug})`, async ({ page }) => {
      test.skip(!entry.productionBacked, entry.note ?? 'No production property sample')

      await flyMap(page, 14, [entry.longitude, entry.latitude])
      await waitForMapIdle(page, 8000)
      await assertPropertyIconVisible(page, entry.propertyId, entry.longitude, entry.latitude)
      await assertNoInvariantViolations(page)
      await assertNoDuplicateMarkers(page)

      const diag = await readDiagnostics(page)
      expect(diag).toMatch(/tile_backed[\s\S]*true/i)

      await page.screenshot({
        path: `proof/map-assets/${entry.screenshotSlug}-desktop.png`,
        fullPage: false,
      })
    })
  }

  test('office sprite registered (zero production office properties)', async ({ page }) => {
    const office = MAP_ASSET_PROOF_MANIFEST.find((e) => e.markerKey === 'office')
    expect(office?.sprite).toBe('nexus-pin-office')

    const hasSprite = await page.evaluate(() => {
      const map = (window as unknown as { __nexusCommandMap?: { hasImage: (id: string) => boolean } }).__nexusCommandMap
      return map?.hasImage('nexus-pin-office') ?? false
    })
    expect(hasSprite).toBe(true)
  })
})