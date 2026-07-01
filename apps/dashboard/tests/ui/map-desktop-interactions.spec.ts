import { test, expect } from '@playwright/test'
import { MAP_ASSET_PROOF_MANIFEST } from '../../src/views/map/map-asset-proof-manifest'
import {
  assertNoDuplicateMarkers,
  assertNoInvariantViolations,
  assertPropertyIconVisible,
  enableMapVerification,
  flyMap,
  openMap,
  waitForMapIdle,
} from './map-verification-helpers'

const SINGLE_FAMILY = MAP_ASSET_PROOF_MANIFEST.find((e) => e.markerKey === 'single_family')!

const clickPropertyPin = async (
  page: import('@playwright/test').Page,
  propertyId: string,
  longitude: number,
  latitude: number,
) => {
  const point = await page.evaluate(({ propertyId, longitude, latitude }) => {
    const map = (window as unknown as {
      __nexusCommandMap?: {
        project: (coords: [number, number]) => { x: number; y: number }
        queryRenderedFeatures: (
          point: { x: number; y: number },
          options?: { layers?: string[] },
        ) => Array<{ properties?: Record<string, unknown> }>
      }
    }).__nexusCommandMap
    if (!map) return null

    const layers = ['prop-tiles-hit', 'prop-tiles-icon', 'prop-tiles-glass', 'prop-tiles-ring']
    const projected = map.project([longitude, latitude])
    const rendered = map.queryRenderedFeatures(projected, { layers })
    const hit = rendered.find((f) => String(f.properties?.property_id ?? '') === propertyId)
    if (hit) return { x: projected.x, y: projected.y }

    for (const dx of [-12, 0, 12]) {
      for (const dy of [-12, 0, 12]) {
        const probe = { x: projected.x + dx, y: projected.y + dy }
        const nearby = map.queryRenderedFeatures(probe, { layers })
        if (nearby.some((f) => String(f.properties?.property_id ?? '') === propertyId)) {
          return probe
        }
      }
    }
    return { x: projected.x, y: projected.y }
  }, { propertyId, longitude, latitude })

  expect(point).not.toBeNull()
  const canvas = page.locator('.nx-icm__canvas').first()
  await canvas.click({ position: point!, force: true })
}

test.describe('Map desktop seller card interactions', () => {
  test.beforeEach(async ({ page }) => {
    await enableMapVerification(page)
    await openMap(page)
  })

  test('hover peek, click focus, message SMS flip, back restores property card', async ({ page }) => {
    await flyMap(page, 14, [SINGLE_FAMILY.longitude, SINGLE_FAMILY.latitude])
    await waitForMapIdle(page, 8000)
    await assertPropertyIconVisible(
      page,
      SINGLE_FAMILY.propertyId,
      SINGLE_FAMILY.longitude,
      SINGLE_FAMILY.latitude,
    )
    await assertNoInvariantViolations(page)
    await assertNoDuplicateMarkers(page)

    const cameraBefore = await page.evaluate(() => {
      const map = (window as unknown as {
        __nexusCommandMap?: { getCenter: () => { lng: number; lat: number }; getZoom: () => number }
      }).__nexusCommandMap
      if (!map) return null
      const center = map.getCenter()
      return { lng: center.lng, lat: center.lat, zoom: map.getZoom() }
    })

    const hoverPoint = await page.evaluate(({ longitude, latitude }) => {
      const map = (window as unknown as {
        __nexusCommandMap?: { project: (coords: [number, number]) => { x: number; y: number } }
      }).__nexusCommandMap
      if (!map) return null
      return map.project([longitude, latitude])
    }, { longitude: SINGLE_FAMILY.longitude, latitude: SINGLE_FAMILY.latitude })

    const canvas = page.locator('.nx-icm__canvas').first()
    const box = await canvas.boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.move(box!.x + hoverPoint!.x, box!.y + hoverPoint!.y, { steps: 8 })
    await page.waitForTimeout(1200)

    const peekCard = page.locator('.smc-shell.is-peek').first()
    await expect(peekCard).toBeVisible({ timeout: 15000 })

    await clickPropertyPin(page, SINGLE_FAMILY.propertyId, SINGLE_FAMILY.longitude, SINGLE_FAMILY.latitude)
    await expect(page.locator('.smc-shell.is-focus, .smc-shell.is-peek').first()).toBeVisible({ timeout: 10000 })

    await page.locator('.smc-action--message').first().click()
    await expect(page.locator('.smc-shell.is-conversation, .smc-flip.is-flipped').first()).toBeVisible({ timeout: 10000 })
    await expect(page.locator('.smc-conversation, .smc-flip__back--sms').first()).toBeVisible()

    await page.getByRole('button', { name: 'Back to property card' }).click()
    await expect(page.locator('.smc-shell.is-focus').first()).toBeVisible({ timeout: 10000 })
    await expect(page.locator('.smc-flip.is-flipped')).toHaveCount(0)

    const cameraAfter = await page.evaluate(() => {
      const map = (window as unknown as {
        __nexusCommandMap?: { getCenter: () => { lng: number; lat: number }; getZoom: () => number }
      }).__nexusCommandMap
      if (!map) return null
      const center = map.getCenter()
      return { lng: center.lng, lat: center.lat, zoom: map.getZoom() }
    })

    expect(cameraAfter?.zoom).toBeCloseTo(cameraBefore!.zoom, 1)
    expect(cameraAfter?.lng).toBeCloseTo(cameraBefore!.lng, 2)
    expect(cameraAfter?.lat).toBeCloseTo(cameraBefore!.lat, 2)

    await page.screenshot({
      path: 'proof/map-diagnostics/desktop-seller-card-interaction.png',
      fullPage: false,
    })
  })
})