import { test, expect } from '@playwright/test'

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5173'

test.describe('Comp Intelligence map-first workspace', () => {
  test('map canvas mounts and stays visible across intel tabs', async ({ page }) => {
    await page.goto(`${BASE}/comp-intelligence`, { waitUntil: 'domcontentloaded' })

    const workspace = page.locator('[data-comp-intelligence="true"]')
    await expect(workspace).toBeVisible({ timeout: 20000 })

    const mapCanvas = workspace.locator('.ci-map-canvas')
    const mapOrState = mapCanvas.or(workspace.locator('.ci-map-no-coords-wrap'))

    await expect(mapOrState.first()).toBeVisible({ timeout: 20000 })

    const box = await mapOrState.first().boundingBox()
    expect(box?.width ?? 0).toBeGreaterThan(120)
    expect(box?.height ?? 0).toBeGreaterThan(120)

    for (const tab of ['Decision', 'Transaction Evidence', 'Valuation Universes']) {
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
    await page.waitForTimeout(1500)
    expect(errors.filter((e) => !/favicon|404|Failed to load resource/i.test(e))).toHaveLength(0)
  })
})