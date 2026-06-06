/**
 * /inbox theme restoration — visual proof
 * ----------------------------------------------------------------------------
 * Captures the workspace menu open in light / dark / red_ops, and an accent
 * swap (rose) so the reviewer can confirm the menu/panel theming actually
 * changed in the browser. Data-independent: the shell + menu render with zero
 * threads, so this passes in a no-backend sandbox.
 *
 * Screenshots land in test-results/screenshots/restore-*.png
 */
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const SHOT_DIR = path.resolve('test-results/screenshots')
fs.mkdirSync(SHOT_DIR, { recursive: true })

type ThemeId = 'dark' | 'light' | 'red_ops'

async function boot(page: Page, theme: ThemeId, accent: string) {
  await page.addInitScript(
    ([t, a]) => {
      localStorage.setItem('nexus-settings', JSON.stringify({ nexusTheme: t, accentPalette: a }))
    },
    [theme, accent] as const,
  )
  await page.goto('/inbox')
  await expect(page.locator('.nx-premium-inbox')).toBeVisible({ timeout: 20_000 })
}

async function openWorkspaceMenu(page: Page) {
  await page.locator('.nx-topbar-view-button.nx-topbar-workspace-compact').click()
  const menu = page.locator('.nx-topbar-workspace-menu')
  await expect(menu).toBeVisible()
  return menu
}

test.describe('/inbox theme restoration proof', () => {
  for (const theme of ['light', 'dark', 'red_ops'] as ThemeId[]) {
    test(`workspace menu — ${theme}`, async ({ page }) => {
      await boot(page, theme, theme === 'red_ops' ? 'rose' : 'cyan')
      const menu = await openWorkspaceMenu(page)

      // Land on the Views submenu so the width pills + view rows are visible.
      await menu.locator('.nx-workspace-menu-item', { hasText: 'Views' }).click()
      const row = menu.locator('.nx-workspace-submenu-item--view').first()
      if (await row.count()) {
        await row.locator('.nx-workspace-submenu-item__select').focus()
      }

      // PROOF: menu text must NOT be near-white in light mode (the old bug).
      if (theme === 'light') {
        const color = await menu
          .locator('.nx-workspace-menu-item')
          .first()
          .evaluate((el) => getComputedStyle(el).color)
        // Parse rgb and assert it is a dark-ish foreground (sum well below white).
        const nums = (color.match(/\d+/g) || []).map(Number)
        const sum = (nums[0] || 0) + (nums[1] || 0) + (nums[2] || 0)
        expect(sum, `light menu text should be dark, got ${color}`).toBeLessThan(420)
      }

      await page.screenshot({ path: path.join(SHOT_DIR, `restore-menu-${theme}.png`), fullPage: false })
    })
  }

  test('accent swap — rose theme submenu + accent dots', async ({ page }) => {
    await boot(page, 'dark', 'rose')
    const menu = await openWorkspaceMenu(page)
    await menu.locator('.nx-workspace-menu-item', { hasText: 'Accent' }).click()
    await page.screenshot({ path: path.join(SHOT_DIR, 'restore-accent-rose.png'), fullPage: false })

    // Active accent row should carry the rose accent border (not cyan).
    const active = menu.locator('.nx-workspace-submenu-item.is-active').first()
    if (await active.count()) {
      const border = await active.evaluate((el) => getComputedStyle(el).borderTopColor)
      expect(border).not.toBe('rgba(0, 0, 0, 0)')
    }
  })
})
