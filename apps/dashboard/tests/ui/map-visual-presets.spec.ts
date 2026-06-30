import { test, expect } from '@playwright/test'
import {
  MAP_VISUAL_PRESET_OPTIONS,
  MAP_VISUAL_PRESET_STORAGE_KEY,
} from '../../src/views/map/map-visual-presets'

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5173'

const PRESET_IDS = MAP_VISUAL_PRESET_OPTIONS.map((preset) => preset.id)

test.describe('Map visual presets', () => {
  for (const presetId of PRESET_IDS) {
    test(`renders ${presetId} without style-load errors`, async ({ page }) => {
      const errors: string[] = []
      page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(msg.text())
      })

      await page.addInitScript((storageKey, id) => {
        window.localStorage.setItem(storageKey, id)
      }, MAP_VISUAL_PRESET_STORAGE_KEY, presetId)

      await page.goto(`${BASE}/inbox`, { waitUntil: 'domcontentloaded' })

      const mapRoot = page.locator('.nx-icm').first()
      await expect(mapRoot).toBeVisible({ timeout: 30000 })

      await page.waitForTimeout(2500)

      const ignored = /favicon|404|Failed to load resource|Inbox live load failed|webgl/i
      expect(errors.filter((entry) => !ignored.test(entry))).toHaveLength(0)

      await page.screenshot({
        path: `proof/map-presets/${presetId}-desktop.png`,
        fullPage: false,
      })
    })
  }
})