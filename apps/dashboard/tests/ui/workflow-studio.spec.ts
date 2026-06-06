import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const SCREENSHOT_DIR = path.resolve('test-results/screenshots')
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true })

// Land directly on the Workflow Studio workspace view by seeding the same
// localStorage keys InboxPage reads on boot (see InboxPage.tsx). A single valid
// view survives normalizeWorkspaceLayout, so the studio mounts full-bleed.
const seedStudioView = async (page: Page) => {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('nx.inbox.selected-workspace', 'deal_desk')
      window.localStorage.setItem(
        'nx.inbox.workspace-views-by-key',
        JSON.stringify({ deal_desk: ['workflow_studio'] }),
      )
      window.localStorage.setItem(
        'nx.inbox.workspace-width-overrides',
        JSON.stringify({ workflow_studio: '100' }),
      )
    } catch {
      /* ignore */
    }
  })
}

const gotoStudio = async (page: Page): Promise<string[]> => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await seedStudioView(page)
  await page.goto('/inbox')
  await expect(page.locator('.wfs')).toBeVisible({ timeout: 30_000 })
  // The dry-run preview blueprint renders 8 nodes even without a backend.
  await expect(page.locator('.wfs-canvas-node').first()).toBeVisible({ timeout: 30_000 })
  return pageErrors
}

const shot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(SCREENSHOT_DIR, `workflow-studio-${name}.png`), fullPage: false })

test('canvas renders with health engine and interactive minimap', async ({ page }) => {
  const errors = await gotoStudio(page)

  // Canvas is the hero: multiple nodes + animated edges present.
  expect(await page.locator('.wfs-canvas-node').count()).toBeGreaterThan(2)
  await expect(page.locator('.wfs-connection-group').first()).toBeVisible()

  // Health engine: numeric 0–100 score in the pill.
  const score = page.locator('.wfs-health-pill strong')
  await expect(score).toBeVisible()
  await expect(score).toHaveText(/^\d{1,3}$/)

  // Health popover expands with the check list.
  await page.locator('.wfs-health-pill').click()
  await expect(page.locator('.wfs-health-popover')).toBeVisible()
  expect(await page.locator('.wfs-health-popover li').count()).toBeGreaterThan(2)

  // Interactive minimap with a live viewport rectangle.
  await expect(page.locator('.wfs-minimap')).toBeVisible()
  await expect(page.locator('.wfs-minimap__viewport')).toBeVisible()

  await shot(page, 'dark-default')
  expect(errors, `unexpected runtime errors: ${errors.join(' | ')}`).toEqual([])
})

test('command palette opens via button and CMD+K, filters, and closes', async ({ page }) => {
  await gotoStudio(page)

  // Open via the toolbar trigger.
  await page.locator('.wfs-cmdk-trigger').click()
  const palette = page.locator('.wfs-cmdk')
  await expect(palette).toBeVisible()

  // Filtering narrows the list.
  await palette.locator('input').fill('fit graph')
  await expect(palette.locator('.wfs-cmdk__item', { hasText: 'Fit Graph' })).toBeVisible()

  await shot(page, 'command-palette')

  // Escape closes.
  await page.keyboard.press('Escape')
  await expect(palette).toBeHidden()

  // Re-open with the keyboard shortcut (CMD on mac, CTRL elsewhere).
  await page.keyboard.press('ControlOrMeta+KeyK')
  await expect(palette).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(palette).toBeHidden()
})

test('visual simulation animates node + edge traversal', async ({ page }) => {
  await gotoStudio(page)

  // Let the studio settle: the initial async load swaps the preview blueprint for
  // a real workflow, and switching workflows intentionally resets canvas state.
  // Running the sim before that swap would be cancelled mid-flight.
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(2_000)

  await page.locator('.wfs-sim-button').click()

  // A node lights up as the packet traverses the graph.
  await expect(page.locator('.wfs-canvas-node.is-sim-active')).toBeVisible({ timeout: 8_000 })
  await shot(page, 'simulation')

  // The run resolves into the WORKFLOW READY completion overlay.
  await expect(page.locator('.wfs-sim-complete')).toBeVisible({ timeout: 20_000 })
})

test('focus mode, inspector + rail collapse', async ({ page }) => {
  await gotoStudio(page)

  // Toggle focus via the command palette (also proves palette commands run).
  await page.locator('.wfs-cmdk-trigger').click()
  await page.locator('.wfs-cmdk input').fill('focus')
  await page.locator('.wfs-cmdk__item', { hasText: /Focus Mode/ }).first().click()

  await expect(page.locator('.wfs-builder--focus')).toBeVisible()
  await expect(page.locator('.wfs-focus-vignette')).toBeVisible()
  await shot(page, 'focus-mode')

  // Exit focus via the palette overlay (the top-bar button can sit under HUD toasts).
  await page.keyboard.press('ControlOrMeta+KeyK')
  await expect(page.locator('.wfs-cmdk')).toBeVisible()
  await page.locator('.wfs-cmdk input').fill('focus')
  await page.locator('.wfs-cmdk__item', { hasText: 'Exit Focus Mode' }).first().click()
  await expect(page.locator('.wfs-builder--focus')).toHaveCount(0)

  // Inspector collapse via palette.
  await page.locator('.wfs-cmdk-trigger').click()
  await page.locator('.wfs-cmdk input').fill('collapse inspector')
  await page.locator('.wfs-cmdk__item', { hasText: 'Collapse Inspector' }).first().click()
  await expect(page.locator('.wfs-builder.is-inspector-collapsed')).toBeVisible()

  // Rail collapse via its toggle.
  await page.locator('.wfs-rail-modebar button[title="Collapse rail"]').click()
  await expect(page.locator('.wfs-list.is-collapsed')).toBeVisible()
})

test('light theme keeps the studio legible', async ({ page }) => {
  await gotoStudio(page)
  await page.evaluate(() => document.documentElement.setAttribute('data-nexus-theme', 'light'))
  await expect(page.locator('.wfs-health-pill')).toBeVisible()
  await expect(page.locator('.wfs-canvas-node').first()).toBeVisible()
  await shot(page, 'light-theme')
})
