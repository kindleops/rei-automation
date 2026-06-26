import { test, expect } from '@playwright/test'

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5173'
const LAKE_WORTH_PROPERTY_ID = '234334277'

test.describe('Comp Intelligence Lake Worth recovery', () => {
  test('recovers comps and renders map markers for 1021 S N St', async ({ page }) => {
    await page.goto(`${BASE}/comp-intelligence?property_id=${LAKE_WORTH_PROPERTY_ID}`, {
      waitUntil: 'domcontentloaded',
    })

    const workspace = page.locator('[data-comp-intelligence="true"]')
    await expect(workspace).toBeVisible({ timeout: 30000 })

    await expect(workspace).toHaveAttribute('data-evidence-count', /[1-9]/, { timeout: 45000 })
    await expect(workspace).toHaveAttribute('data-mapped-count', /[1-9]/, { timeout: 45000 })

    const mapCanvas = workspace.locator('.ci-map-canvas')
    await expect(mapCanvas).toBeVisible({ timeout: 20000 })

    const box = await mapCanvas.boundingBox()
    expect(box?.width ?? 0).toBeGreaterThan(200)
    expect(box?.height ?? 0).toBeGreaterThan(200)

    const pins = workspace.locator('.ci-comp-pin')
    await expect(pins).toHaveCount(2, { timeout: 30000 })

    const cards = workspace.locator('.ci-evidence-card')
    await expect(cards.first()).toBeVisible({ timeout: 20000 })
    expect(await cards.count()).toBeGreaterThan(0)

    await expect(workspace.locator('.ci-status-bar')).toContainText(/EVIDENCE RECOVERED/i)

    await workspace.getByRole('tab', { name: /Comps/i }).click()
    await expect(mapCanvas).toBeVisible()

    await workspace.locator('.ci-evidence-card').first().click({ timeout: 10000 })
    await page.screenshot({ path: 'proof/comp-intelligence-lake-worth-recovered.png', fullPage: true })
  })
})