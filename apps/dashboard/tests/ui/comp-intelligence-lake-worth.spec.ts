import { test, expect } from '@playwright/test'
import {
  installCompIntelligenceFixtures,
  LAKE_WORTH_PROPERTY_ID,
  setNexusTheme,
  waitForRecoveredEvidence,
} from './fixtures/comp-intelligence-fixtures'

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5173'

test.describe('Comp Intelligence Lake Worth recovery', () => {
  test('recovers comps and renders map markers for 1021 S N St', async ({ page }) => {
    await installCompIntelligenceFixtures(page)
    await page.goto(`${BASE}/comp-intelligence?property_id=${LAKE_WORTH_PROPERTY_ID}`, {
      waitUntil: 'domcontentloaded',
    })

    const workspace = await waitForRecoveredEvidence(page)
    await expect(workspace.locator('.ci-status-bar')).toContainText(/V3 DECISION UNAVAILABLE/i)

    const mapCanvas = workspace.locator('.ci-map-canvas')
    const mapOrState = mapCanvas.or(workspace.locator('.ci-map-no-coords-wrap'))
    await expect(mapOrState.first()).toBeVisible({ timeout: 20000 })

    const cards = workspace.locator('.ci-evidence-card')
    await workspace.getByRole('tab', { name: /Comps/i }).click()
    await expect(cards.first()).toBeVisible({ timeout: 20000 })
    expect(await cards.count()).toBeGreaterThanOrEqual(2)

    const errors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text())
    })
    await page.waitForTimeout(800)
    expect(errors.filter((e) => !/favicon|404|Failed to load resource|Inbox live load failed/i.test(e))).toHaveLength(0)
  })

  test('light and dark themes keep recovered evidence visible', async ({ page }) => {
    await installCompIntelligenceFixtures(page)
    await page.goto(`${BASE}/comp-intelligence?property_id=${LAKE_WORTH_PROPERTY_ID}`, {
      waitUntil: 'domcontentloaded',
    })
    const workspace = await waitForRecoveredEvidence(page)
    for (const theme of ['dark', 'light'] as const) {
      await setNexusTheme(page, theme)
      await expect(workspace.locator('.ci-status-bar')).toContainText(/EVIDENCE RECOVERED/i)
      await expect(workspace.locator('.ci-map-canvas').or(workspace.locator('.ci-map-no-coords-wrap')).first()).toBeVisible()
    }
  })

  test('mobile viewport shows map and degraded evidence cards', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await installCompIntelligenceFixtures(page)
    await page.goto(`${BASE}/comp-intelligence?property_id=${LAKE_WORTH_PROPERTY_ID}`, {
      waitUntil: 'domcontentloaded',
    })
    const workspace = await waitForRecoveredEvidence(page)
    await expect(workspace.locator('.ci-map-canvas').or(workspace.locator('.ci-map-no-coords-wrap')).first()).toBeVisible()
    await expect(workspace.locator('.ci-evidence-card, .ci-overview-hero').first()).toBeVisible()
  })
})