import { test, expect } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'

const OUT = path.resolve('test-results/pipeline-recovery-screenshots')

type NexusTheme = 'dark' | 'light' | 'red_ops'

function shot(page: import('@playwright/test').Page, name: string) {
  return page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false })
}

async function setTheme(page: import('@playwright/test').Page, theme: NexusTheme) {
  await page.evaluate((t) => {
    document.documentElement.setAttribute('data-nexus-theme', t)
  }, theme)
}

async function waitForPipelineBoard(page: import('@playwright/test').Page) {
  await page.locator('.plv-card, .plv-board-empty, .plv--error').first().waitFor({ state: 'attached', timeout: 120000 })
  const err = page.locator('.plv--error')
  if (await err.count()) {
    const retry = page.locator('.plv--error button:has-text("Retry")')
    if (await retry.count()) {
      await retry.click()
      await page.waitForTimeout(2000)
    } else {
      const text = (await err.textContent()) || ''
      throw new Error(`Pipeline error state: ${text}`)
    }
  }
  const card = page.locator('.plv-card').first()
  await card.waitFor({ state: 'attached', timeout: 120000 })
  await card.scrollIntoViewIfNeeded()
  await page.waitForTimeout(800)
}

async function openPipeline100(page: import('@playwright/test').Page) {
  await page.goto('/pipeline')
  await waitForPipelineBoard(page)
}

async function openWorkspaceMenu(page: import('@playwright/test').Page) {
  await page.locator('.nx-topbar-workspace-compact').click({ force: true })
}

async function openPipelineInboxSplit(
  page: import('@playwright/test').Page,
  pipelineWidth: '25' | '50' | '75',
) {
  const calendarWidth = String(100 - Number(pipelineWidth))
  await page.goto('/inbox')
  await page.waitForSelector('.nx-topbar-workspace-compact', { timeout: 120000 })

  await openWorkspaceMenu(page)
  await page.locator('.nx-workspace-submenu-item:has-text("Pipeline Flow")').first().click({ force: true })
  await page.waitForTimeout(1200)

  if (pipelineWidth !== '75') {
    await openWorkspaceMenu(page)
    await page.locator('.nx-workspace-menu-item:has-text("Views")').click({ force: true })
    await page.locator('.nx-wsv-row').filter({ hasText: 'Pipeline' }).first()
      .locator(`.nx-wsv-pill:has-text("${pipelineWidth}%")`).click({ force: true })
    await page.locator('.nx-wsv-row').filter({ hasText: 'Calendar' }).first()
      .locator(`.nx-wsv-pill:has-text("${calendarWidth}%")`).click({ force: true })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1200)
  }

  const pipelineRoot = page.locator('.plv').first()
  await pipelineRoot.waitFor({ state: 'attached', timeout: 120000 })
  await pipelineRoot.scrollIntoViewIfNeeded()
  await waitForPipelineBoard(page)
}

async function setGroupBy(page: import('@playwright/test').Page, label: string) {
  await page.locator('.plv-view-selector__trigger').first().click()
  await page.locator(`.plv-view-selector__option:has-text("${label}")`).first().click()
  await page.waitForTimeout(600)
}

test.describe.configure({ timeout: 180_000 })

test.describe('Pipeline recovery visual proof', () => {
  test.beforeAll(() => {
    fs.mkdirSync(OUT, { recursive: true })
  })

  test('100% board themes and grouping', async ({ page }) => {
    await page.setViewportSize({ width: 1720, height: 1080 })
    await openPipeline100(page)

    await setTheme(page, 'light')
    await setGroupBy(page, 'Stage')
    await shot(page, '100-stage-light')

    const emptyLane = page.locator('.plv-lane').filter({ has: page.locator('.plv-empty-lane') }).first()
    await expect(emptyLane).toBeVisible({ timeout: 5000 }).catch(() => {})

    await setTheme(page, 'dark')
    await setGroupBy(page, 'Status')
    await shot(page, '100-status-dark')

    await setTheme(page, 'red_ops')
    await setGroupBy(page, 'Temperature')
    await shot(page, '100-temperature-red-ops')

    const card = page.locator('.plv-card').first()
    await card.click()
    await page.waitForSelector('.plv-command-panel', { timeout: 10000 })
    await shot(page, '100-inspector-expanded')

    const collapse = page.locator('.plv-command-panel__collapse')
    if (await collapse.count()) {
      await collapse.click()
      await page.waitForTimeout(400)
      await shot(page, '100-inspector-collapsed')
      const expand = page.locator('.plv-command-panel__expand')
      if (await expand.count()) await expand.click()
    }

    await page.locator('button:has-text("Customize Cards")').click()
    await page.waitForSelector('.plv-card-designer', { timeout: 10000 })
    await setTheme(page, 'light')
    await shot(page, '100-card-studio-light')
    await setTheme(page, 'dark')
    await shot(page, '100-card-studio-dark')
    await page.locator('.plv-card-designer__close').click()

    const lanes = page.locator('.plv-lane')
    const laneCount = await lanes.count()
    if (laneCount >= 2) {
      const dest = lanes.nth(Math.min(2, laneCount - 1))
      await page.locator('.plv-card').first().dragTo(dest, { targetPosition: { x: 40, y: 80 } })
      await page.waitForTimeout(500)
      await shot(page, '100-drag-active')
    }

    await setTheme(page, 'light')
    await shot(page, '100-universal-context-light')
  })

  test('75% split with inspector', async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 900 })
    await openPipelineInboxSplit(page, '75')

    const card = page.locator('.plv-card').first()
    await card.click()
    await page.waitForTimeout(500)

    await setTheme(page, 'dark')
    await shot(page, '75-board-inspector-collapsed')

    const collapse = page.locator('.plv-command-panel__collapse')
    if (await collapse.count()) {
      await collapse.click()
      await page.waitForTimeout(400)
    }
    await shot(page, '75-board-collapsed-inspector')

    if (await collapse.count()) await collapse.click()
    await shot(page, '75-rail-overlay')

    const lanes = page.locator('.plv-lane')
    if (await lanes.count() >= 2) {
      await page.locator('.plv-card').first().dragTo(lanes.nth(1))
      await page.waitForTimeout(400)
      await shot(page, '75-drag-between-columns')
    }
  })

  test('50% overlay inspector', async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 900 })
    await openPipelineInboxSplit(page, '50')

    await setTheme(page, 'dark')
    await shot(page, '50-horizontal-board')

    const card = page.locator('.plv-card').first()
    await card.click()
    await page.waitForSelector('.plv-drawer--overlay, .plv-command-panel', { timeout: 10000 })
    await shot(page, '50-inspector-overlay')

    const close = page.locator('.plv-command-panel__close').first()
    if (await close.count()) {
      await close.click()
      await page.waitForTimeout(400)
      await shot(page, '50-inspector-closed')
      await card.click()
    }

    const customize = page.locator('button:has-text("Customize Cards")')
    if (await customize.count()) {
      await customize.click()
      await page.waitForSelector('.plv-card-designer', { timeout: 10000 })
      await shot(page, '50-card-studio')
      await page.locator('.plv-card-designer__close').click()
    }
  })

  test('25% rail and bottom sheet', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await openPipelineInboxSplit(page, '25')

    await setTheme(page, 'light')
    await shot(page, '25-column-selector-light')
    await page.locator('.plv-stage-chip').first().click()
    await page.waitForTimeout(400)
    await shot(page, '25-active-column-list')

    const card = page.locator('.plv-card').first()
    await card.click()
    await page.waitForSelector('.plv-context-dock', { timeout: 10000 })
    await setTheme(page, 'dark')
    await shot(page, '25-bottom-sheet-dark')

    await page.locator('.plv-context-dock__close').click()
    await page.waitForTimeout(400)
    await shot(page, '25-bottom-sheet-closed')

    await setTheme(page, 'red_ops')
    await shot(page, '25-red-ops')
  })

  test('scope counts and no open-in farm', async ({ page }) => {
    await page.setViewportSize({ width: 1720, height: 1080 })
    await openPipeline100(page)

    const scopeBar = page.locator('.plv-scope-bar__counts')
    await expect(scopeBar).toBeVisible()
    const counts = (await scopeBar.textContent()) || ''
    expect(counts).toMatch(/total opportunities/i)

    await expect(page.locator('text=Open In')).toHaveCount(0)
    await expect(page.locator('.plv-universal-nav')).toHaveCount(0)

    const lanes = page.locator('.plv-lane')
    expect(await lanes.count()).toBeGreaterThan(3)
  })
})