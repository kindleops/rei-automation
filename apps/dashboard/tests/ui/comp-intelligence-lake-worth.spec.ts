import { test, expect } from '@playwright/test'

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5175'
const LAKE_WORTH_PROPERTY_ID = '234334277'

test.describe('Comp Intelligence Lake Worth recovery', () => {
  test('recovers comps and renders property cards for 1021 S N St', async ({ page }) => {
    await page.goto(`${BASE}/comp-intelligence?property_id=${LAKE_WORTH_PROPERTY_ID}`, {
      waitUntil: 'domcontentloaded',
    })

    const workspace = page.locator('[data-comp-intelligence="true"]')
    await expect(workspace).toBeVisible({ timeout: 30000 })

    await expect(workspace).toHaveAttribute('data-evidence-count', /[1-9]/, { timeout: 45000 })
    await expect(workspace).toHaveAttribute('data-mapped-count', /[1-9]/, { timeout: 45000 })

    const mapCanvas = workspace.locator('.ci-map-canvas')
    await expect(mapCanvas).toBeVisible({ timeout: 20000 })

    await expect(workspace.locator('.ci-subject-header--property')).toBeVisible()
    await expect(workspace.locator('.ci-property-comp-card').first()).toBeVisible({ timeout: 20000 })

    const pins = workspace.locator('.ci-comp-pin')
    await expect(pins.first()).toBeVisible({ timeout: 30000 })
    expect(await pins.count()).toBeGreaterThan(0)

    await workspace.locator('.ci-property-comp-card').first().click({ timeout: 10000 })
    await expect(workspace.locator('.ci-comparison-table')).toBeVisible()

    await page.screenshot({ path: 'proof/comp-intelligence-lake-worth-recovered.png', fullPage: true })
  })
})