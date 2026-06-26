import { test, expect } from '@playwright/test'

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5173'

test.describe('Comp Intelligence property-first workspace', () => {
  test('map canvas mounts with subject card and comp list', async ({ page }) => {
    await page.goto(`${BASE}/comp-intelligence?property_id=234334277`, { waitUntil: 'domcontentloaded' })

    const workspace = page.locator('[data-comp-intelligence="true"]')
    await expect(workspace).toBeVisible({ timeout: 20000 })

    const mapCanvas = workspace.locator('.ci-map-canvas')
    const mapOrState = mapCanvas.or(workspace.locator('.ci-map-no-coords-wrap'))

    await expect(mapOrState.first()).toBeVisible({ timeout: 20000 })

    await expect(workspace.locator('.ci-subject-header--property')).toBeVisible({ timeout: 20000 })
    await expect(workspace.getByRole('tab', { name: /^Comps$/i })).toBeVisible()

    const box = await mapOrState.first().boundingBox()
    expect(box?.width ?? 0).toBeGreaterThan(120)
    expect(box?.height ?? 0).toBeGreaterThan(120)

    const errors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text())
    })
    await page.waitForTimeout(2000)
    expect(errors.filter((e) => !/favicon|404|Failed to load resource|Inbox live load failed/i.test(e))).toHaveLength(0)
  })

  test('does not expose raw diagnostic enum text in primary UI', async ({ page }) => {
    await page.goto(`${BASE}/comp-intelligence?property_id=234334277`, { waitUntil: 'domcontentloaded' })
    const workspace = page.locator('[data-comp-intelligence="true"]')
    await expect(workspace).toBeVisible({ timeout: 20000 })
    await page.waitForTimeout(2500)

    const text = await workspace.innerText()
    expect(text).not.toMatch(/DEGRADED_COMP/)
    expect(text).not.toMatch(/direct_rpc/)
    expect(text).not.toMatch(/\bESS\b/)
    expect(text).not.toMatch(/V3_DISABLED/)
  })
})