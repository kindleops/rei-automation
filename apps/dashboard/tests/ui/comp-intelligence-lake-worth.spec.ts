import { test, expect } from '@playwright/test'
import {
  installCompIntelligenceFixtures,
  LAKE_WORTH_PROPERTY_ID,
} from './fixtures/comp-intelligence-fixtures'

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5173'

test.describe('Comp Intelligence Lake Worth recovery', () => {
  test('recovers comps and renders map markers for 1021 S N St', async ({ page }) => {
    await installCompIntelligenceFixtures(page)
    await page.goto(`${BASE}/comp-intelligence?property_id=${LAKE_WORTH_PROPERTY_ID}`, {
      waitUntil: 'domcontentloaded',
    })

    const workspace = page.locator('[data-comp-intelligence="true"]')
    await expect(workspace).toBeVisible({ timeout: 30000 })

    await expect(workspace).toHaveAttribute('data-evidence-count', /[1-9]/, { timeout: 30000 })
    await expect(workspace).toHaveAttribute('data-mapped-count', /[1-9]/, { timeout: 30000 })

    const mapCanvas = workspace.locator('.ci-map-canvas')
    await expect(mapCanvas).toBeVisible({ timeout: 20000 })

    const box = await mapCanvas.boundingBox()
    expect(box?.width ?? 0).toBeGreaterThan(120)
    expect(box?.height ?? 0).toBeGreaterThan(120)

    const cards = workspace.locator('.ci-evidence-card')
    await expect(cards.first()).toBeVisible({ timeout: 20000 })
    expect(await cards.count()).toBeGreaterThan(0)

    await workspace.getByRole('tab', { name: /Comps/i }).click()
    await expect(mapCanvas).toBeVisible()
  })
})