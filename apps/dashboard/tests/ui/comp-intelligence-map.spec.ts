import { test, expect } from '@playwright/test'
import {
  installCompIntelligenceFixtures,
  LAKE_WORTH_PROPERTY_ID,
  setNexusTheme,
} from './fixtures/comp-intelligence-fixtures'

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5173'

async function openWorkspace(page: import('@playwright/test').Page, viewport?: { width: number; height: number }) {
  if (viewport) await page.setViewportSize(viewport)
  await installCompIntelligenceFixtures(page)
  await page.goto(`${BASE}/comp-intelligence?property_id=${LAKE_WORTH_PROPERTY_ID}`, {
    waitUntil: 'domcontentloaded',
  })
  const workspace = page.locator('[data-comp-intelligence="true"]')
  await expect(workspace).toBeVisible({ timeout: 30000 })
  return workspace
}

test.describe('Comp Intelligence map-first workspace', () => {
  test('desktop: map canvas and intel tabs stay visible with fixture payload', async ({ page }) => {
    const workspace = await openWorkspace(page)

    const mapCanvas = workspace.locator('.ci-map-canvas')
    const mapOrState = mapCanvas.or(workspace.locator('.ci-map-no-coords-wrap'))
    await expect(mapOrState.first()).toBeVisible({ timeout: 20000 })

    const box = await mapOrState.first().boundingBox()
    expect(box?.width ?? 0).toBeGreaterThan(120)
    expect(box?.height ?? 0).toBeGreaterThan(120)

    await workspace.getByRole('tab', { name: /Comps/i }).click()
    await expect(
      workspace.locator('.ci-evidence-card, .ci-status-bar, .ci-overview-hero').first(),
    ).toBeVisible({ timeout: 30000 })

    for (const tab of ['Overview', 'Comps', 'Strategies']) {
      const tabBtn = workspace.getByRole('tab', { name: new RegExp(tab, 'i') })
      if (await tabBtn.isVisible().catch(() => false)) {
        await tabBtn.click()
        await expect(mapOrState.first()).toBeVisible()
      }
    }

    const errors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text())
    })
    await page.waitForTimeout(1000)
    expect(errors.filter((e) => !/favicon|404|Failed to load resource|Inbox live load failed/i.test(e))).toHaveLength(0)
  })

  test('light and dark themes render workspace without console errors', async ({ page }) => {
    const workspace = await openWorkspace(page)
    const errors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text())
    })

    for (const theme of ['dark', 'light'] as const) {
      await setNexusTheme(page, theme)
      await expect(workspace).toBeVisible()
      await expect(workspace.locator('.ci-map-canvas').or(workspace.locator('.ci-map-no-coords-wrap')).first()).toBeVisible()
    }

    expect(errors.filter((e) => !/favicon|404|Failed to load resource|Inbox live load failed/i.test(e))).toHaveLength(0)
  })

  test('mobile: map or truthful no-coordinate state remains visible', async ({ page }) => {
    const workspace = await openWorkspace(page, { width: 390, height: 844 })
    const mapOrState = workspace.locator('.ci-map-canvas').or(workspace.locator('.ci-map-no-coords-wrap'))
    await expect(mapOrState.first()).toBeVisible({ timeout: 20000 })
    await expect(workspace.locator('.ci-status-bar, .ci-overview-hero, .ci-evidence-card').first()).toBeVisible()
  })
})