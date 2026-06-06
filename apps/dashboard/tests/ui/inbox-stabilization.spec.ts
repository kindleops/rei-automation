/**
 * /inbox UI Stabilization smoke test
 * ----------------------------------------------------------------------------
 * Replaces the stale selectors in deal-intelligence.spec.ts. Verifies the
 * theme system (dark / light / red_ops), accent palette propagation, the
 * workspace menu, and the 25/50/75/Full width controls — WITHOUT requiring
 * live Supabase data (the shell, menu and tokens render with zero threads).
 *
 * Row/message/deal-intelligence assertions are SOFT: they only run when the
 * environment actually returns inbox rows, so the spec passes in a no-data
 * sandbox and gives real coverage when pointed at a seeded backend.
 *
 * Screenshots land in test-results/screenshots for visual confirmation.
 */
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const SHOT_DIR = path.resolve('test-results/screenshots')
fs.mkdirSync(SHOT_DIR, { recursive: true })

type ThemeId = 'dark' | 'light' | 'red_ops'

// Deterministic, data-independent expectations sourced from the canonical sheets:
//   nexus-theme-tokens.css (--surface-0) and nx-ui-foundation-final.css (--nx-accent)
const SURFACE_0: Record<ThemeId, string> = {
  light: '#ffffff',
  dark: '#020617',
  red_ops: '#070000',
}
const ACCENT_HEX: Record<string, string> = {
  cyan: '#06b6d4',
  emerald: '#10b981',
  violet: '#7c3aed',
  blue: '#2563eb',
}

async function applyAppearance(page: Page, theme: ThemeId, accent: string) {
  // applyThemeToDOM() reads `nexus-settings` from localStorage at module load,
  // before React mounts, so it must be set via an init script + fresh nav.
  await page.addInitScript(
    ([t, a]) => {
      localStorage.setItem('nexus-settings', JSON.stringify({ nexusTheme: t, accentPalette: a }))
    },
    [theme, accent] as const,
  )
  await page.goto('/inbox')
  await expect(page.locator('.nx-premium-inbox')).toBeVisible({ timeout: 20_000 })
}

function attachConsoleGuard(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') {
      const t = m.text()
      // Ignore expected network/data noise in a no-backend sandbox.
      if (/Failed to load resource|net::ERR|supabase|401|403|fetch/i.test(t)) return
      errors.push(`console.error: ${t}`)
    }
  })
  return errors
}

const norm = (c: string) => c.replace(/\s+/g, '').toLowerCase()

// Browsers serialize `#ffffff` → `#fff`; canonicalize 3-digit hex to 6-digit.
const canonHex = (c: string) => {
  const v = norm(c)
  const m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v)
  return m ? `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}` : v
}

test.describe('/inbox stabilization', () => {
  for (const theme of ['dark', 'light', 'red_ops'] as ThemeId[]) {
    test(`theme "${theme}" renders the correct surface tokens`, async ({ page }) => {
      const errors = attachConsoleGuard(page)
      await applyAppearance(page, theme, 'cyan')

      const attr = await page.evaluate(() => document.documentElement.getAttribute('data-nexus-theme'))
      expect(attr).toBe(theme)

      const surface0 = canonHex(
        await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--surface-0')),
      )
      expect(surface0).toBe(SURFACE_0[theme])

      // Light mode must NOT paint the inbox shell with a dark background (bug #1).
      const shellBg = await page.evaluate(() => {
        const el = document.querySelector('.nx-premium-inbox') as HTMLElement | null
        return el ? getComputedStyle(el).backgroundColor : ''
      })
      const m = shellBg.match(/\d+/g)?.map(Number) ?? []
      if (theme === 'light' && m.length >= 3) {
        const lum = 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]
        expect(lum, `light shell bg should be bright, got ${shellBg}`).toBeGreaterThan(180)
      }

      await page.screenshot({ path: path.join(SHOT_DIR, `inbox-theme-${theme}.png`), fullPage: false })
      expect(errors, errors.join('\n')).toEqual([])
    })
  }

  test('accent palette propagates to --nx-accent across themes', async ({ page }) => {
    for (const [accent, hex] of Object.entries(ACCENT_HEX)) {
      await applyAppearance(page, 'dark', accent)
      const accentAttr = await page.evaluate(() => document.documentElement.getAttribute('data-nexus-accent'))
      expect(accentAttr).toBe(accent)
      const v = canonHex(
        await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--nx-accent')),
      )
      expect(v, `accent ${accent}`).toBe(hex)
      // mirror token must follow
      const nexusV = canonHex(
        await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--nexus-accent')),
      )
      expect(nexusV, `mirror --nexus-accent for ${accent}`).toBe(hex)
    }
  })

  test('workspace menu opens and 25/50/75/Full width pills are clickable', async ({ page }) => {
    const errors = attachConsoleGuard(page)
    await applyAppearance(page, 'dark', 'cyan')

    // Open the workspace menu (liquid-glass popover).
    await page.locator('.nx-topbar-view-button.nx-topbar-workspace-compact').click()
    const menu = page.locator('.nx-topbar-workspace-menu')
    await expect(menu).toBeVisible()

    // No invisible overlay should block the menu (bug #8): it must be hit-testable.
    await expect(menu).toHaveCSS('pointer-events', 'auto')

    // Navigate to the Views submenu.
    await menu.locator('.nx-workspace-menu-item', { hasText: 'Views' }).click()
    const viewRows = menu.locator('.nx-workspace-submenu-item--view')
    await expect(viewRows.first()).toBeVisible()
    expect(await viewRows.count()).toBeGreaterThan(3)

    // Focus the row's toggle to reveal its width pills (:focus-within is sticky —
    // it survives clicking each pill, which keeps focus inside the row).
    const row = viewRows.first()
    await row.locator('.nx-workspace-submenu-item__select').focus()
    await expect(row.locator('.nx-workspace-view-widths')).toBeVisible()
    for (const label of ['Full', '75%', '50%', '25%']) {
      const pill = row.locator('.nx-topbar-width-pill', { hasText: new RegExp(`^${label}$`) })
      await expect(pill).toBeVisible()
      await pill.click()
      await expect(pill).toHaveClass(/is-active/)
    }

    await page.screenshot({ path: path.join(SHOT_DIR, 'inbox-workspace-menu.png') })
    expect(errors, errors.join('\n')).toEqual([])
  })

  test('width selection drives the workspace split grid to valid flex-basis (~100% total)', async ({ page }) => {
    await applyAppearance(page, 'dark', 'cyan')
    await page.locator('.nx-topbar-view-button.nx-topbar-workspace-compact').click()
    const menu = page.locator('.nx-topbar-workspace-menu')
    await menu.locator('.nx-workspace-menu-item', { hasText: 'Views' }).click()
    const row = menu.locator('.nx-workspace-submenu-item--view').first()
    await row.locator('.nx-workspace-submenu-item__select').focus()
    await expect(row.locator('.nx-workspace-view-widths')).toBeVisible()
    await row.locator('.nx-topbar-width-pill', { hasText: /^50%$/ }).click()
    await page.keyboard.press('Escape')

    const grid = page.locator('.nx-workspace-split-grid')
    await expect(grid).toBeVisible()
    const panes = grid.locator('.nx-workspace-pane')
    const count = await panes.count()
    expect(count).toBeGreaterThan(0)

    // Sum of pane widths must fill the grid (no slivers / no >100% overflow → bugs #6/#7).
    const { gridW, sum } = await grid.evaluate((g) => {
      const gw = (g as HTMLElement).getBoundingClientRect().width
      const ps = Array.from(g.querySelectorAll('.nx-workspace-pane')) as HTMLElement[]
      const s = ps.reduce((acc, p) => acc + p.getBoundingClientRect().width, 0)
      return { gridW: gw, sum: s }
    })
    expect(Math.abs(sum - gridW) / gridW, 'panes should fill ~100% of the grid').toBeLessThan(0.04)
  })

  test('SOFT: when rows exist, selecting one hydrates deal intelligence without stuck loading', async ({ page }) => {
    await applyAppearance(page, 'light', 'cyan')
    const rows = page.locator('.nx-row25, .nx-thread-card-rebuilt')
    // Give the list a moment to hydrate from the backend (if any).
    await page.waitForTimeout(2500)
    const n = await rows.count()
    if (n === 0) {
      test.info().annotations.push({ type: 'note', text: 'No inbox rows in this environment — row/message/deal checks skipped.' })
      return
    }
    await rows.first().click()
    // Deal Intelligence must not be stuck in a loading skeleton.
    await expect(page.locator('.nx-intelligence-panel .nx-inbox-loading-state')).toHaveCount(0, { timeout: 10_000 })
    // In light mode the conversation pane must not be a black box (bug #4).
    const chat = page.locator('.nx-chat-container').first()
    if (await chat.count()) {
      const bg = await chat.evaluate((el) => getComputedStyle(el).backgroundColor)
      const m = bg.match(/\d+/g)?.map(Number) ?? []
      if (m.length >= 3) {
        const lum = 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]
        expect(lum, `light conversation pane should not be a dark box, got ${bg}`).toBeGreaterThan(120)
      }
    }
    await page.screenshot({ path: path.join(SHOT_DIR, 'inbox-light-conversation.png') })
  })
})
