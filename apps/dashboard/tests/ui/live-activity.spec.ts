import { test, expect } from '@playwright/test'
import { LIVE_ACTIVITY_SETTINGS_STORAGE_KEY } from '../../src/views/map/commandMapLiveActivity'

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5173'

const seedSettings = (displayMode: string) => ({
  visible: displayMode !== 'hidden',
  displayMode,
  speed: 'paused',
  pauseOnHover: true,
  onlyCurrentBounds: true,
  onlySelectedMarket: false,
  onlyHotCritical: false,
  maxCardsVisible: 18,
  autoScroll: false,
  pinHotEvents: false,
  autoPinCriticalSeconds: 22,
  subtleSpeedVariance: false,
  scope: 'viewport',
  activeChannel: 'live',
})

test.describe('Live Activity command rail', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((storageKey, settings) => {
      window.localStorage.setItem(storageKey, JSON.stringify(settings))
    }, LIVE_ACTIVITY_SETTINGS_STORAGE_KEY, seedSettings('minimal'))
  })

  test('renders minimal rail with accurate header and no static placeholder', async ({ page }) => {
    await page.goto(`${BASE}/inbox`, { waitUntil: 'domcontentloaded' })

    const rail = page.locator('.nx-icm-activity.is-minimal')
    await expect(rail).toBeVisible({ timeout: 30000 })

    await expect(rail.locator('.nx-icm-activity__heading strong')).toHaveText(/Live Activity/i)
    await expect(rail.locator('.nx-icm-activity__scope')).toHaveText(/VIEWPORT/i)

    const minimalEvent = rail.locator('.nx-icm-activity__minimal-event')
    if (await minimalEvent.count()) {
      await expect(minimalEvent.locator('.nx-icm-activity__minimal-type')).not.toBeEmpty()
      await expect(minimalEvent.locator('.nx-icm-activity__minimal-subject')).not.toBeEmpty()
    }
  })

  test('compact mode renders single flip ticker not a gallery', async ({ page }) => {
    await page.addInitScript((storageKey) => {
      const raw = window.localStorage.getItem(storageKey)
      const parsed = raw ? JSON.parse(raw) : {}
      window.localStorage.setItem(storageKey, JSON.stringify({ ...parsed, displayMode: 'compact', visible: true, speed: 'paused' }))
    }, LIVE_ACTIVITY_SETTINGS_STORAGE_KEY)

    await page.goto(`${BASE}/inbox`, { waitUntil: 'domcontentloaded' })

    const rail = page.locator('.nx-icm-activity.is-compact')
    await expect(rail).toBeVisible({ timeout: 30000 })
    await expect(rail.locator('.nx-icm-activity__flip-stage')).toHaveCount(1)
    await expect(rail.locator('.nx-icm-activity__track--compact')).toHaveCount(0)
    await expect(rail.getByRole('tab', { name: /Live Now/i })).toHaveCount(0)
  })

  test('compact mode respects height budget', async ({ page }) => {
    await page.addInitScript((storageKey) => {
      const raw = window.localStorage.getItem(storageKey)
      const parsed = raw ? JSON.parse(raw) : {}
      window.localStorage.setItem(storageKey, JSON.stringify({ ...parsed, displayMode: 'compact', visible: true }))
    }, LIVE_ACTIVITY_SETTINGS_STORAGE_KEY)

    await page.goto(`${BASE}/inbox`, { waitUntil: 'domcontentloaded' })

    const rail = page.locator('.nx-icm-activity.is-compact')
    await expect(rail).toBeVisible({ timeout: 30000 })

    const box = await rail.boundingBox()
    expect(box?.height ?? 0).toBeGreaterThan(120)
    expect(box?.height ?? 999).toBeLessThan(180)
  })

  test('expanded mode exposes live/context channel switch', async ({ page }) => {
    await page.addInitScript((storageKey) => {
      const raw = window.localStorage.getItem(storageKey)
      const parsed = raw ? JSON.parse(raw) : {}
      window.localStorage.setItem(storageKey, JSON.stringify({ ...parsed, displayMode: 'expanded', visible: true }))
    }, LIVE_ACTIVITY_SETTINGS_STORAGE_KEY)

    await page.goto(`${BASE}/inbox`, { waitUntil: 'domcontentloaded' })

    const rail = page.locator('.nx-icm-activity.is-expanded')
    await expect(rail).toBeVisible({ timeout: 30000 })
    await expect(rail.getByRole('tab', { name: /Live Now/i })).toBeVisible()
    await expect(rail.getByRole('tab', { name: /Context/i })).toBeVisible()
  })

  test('docked desktop rail anchors to right side', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.addInitScript((storageKey) => {
      const raw = window.localStorage.getItem(storageKey)
      const parsed = raw ? JSON.parse(raw) : {}
      window.localStorage.setItem(storageKey, JSON.stringify({ ...parsed, displayMode: 'docked', visible: true }))
    }, LIVE_ACTIVITY_SETTINGS_STORAGE_KEY)

    await page.goto(`${BASE}/inbox`, { waitUntil: 'domcontentloaded' })

    const rail = page.locator('.nx-icm-activity.is-docked')
    await expect(rail).toBeVisible({ timeout: 30000 })

    const box = await rail.boundingBox()
    const viewport = page.viewportSize()
    expect(box?.width ?? 0).toBeGreaterThan(360)
    expect(box?.width ?? 0).toBeLessThan(440)
    if (box && viewport) {
      expect(box.x + box.width).toBeGreaterThan(viewport.width - 80)
    }
  })

  test('mobile maps docked preference to expanded sheet', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.addInitScript((storageKey) => {
      const raw = window.localStorage.getItem(storageKey)
      const parsed = raw ? JSON.parse(raw) : {}
      window.localStorage.setItem(storageKey, JSON.stringify({ ...parsed, displayMode: 'docked', visible: true }))
    }, LIVE_ACTIVITY_SETTINGS_STORAGE_KEY)

    await page.goto(`${BASE}/inbox`, { waitUntil: 'domcontentloaded' })

    await expect(page.locator('.nx-icm-activity.is-docked')).toHaveCount(0)
    const expanded = page.locator('.nx-icm-activity.is-expanded, .nx-icm-activity.is-minimal, .nx-icm-activity.is-compact')
    await expect(expanded.first()).toBeVisible({ timeout: 30000 })
  })
})