import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'

const SCREENSHOT_DIR = path.resolve('test-results/screenshots')
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true })

const viewOption = (page: Page, label: string) =>
  page.locator('.nx-topbar-view-option').filter({ has: page.locator('strong', { hasText: label }) }).first()

const compactRoot = '.nx-deal-compact-shell'
const mediumRoot = '.nx-deal-medium-shell'
const expandedRoot = '.nx-deal-command-dossier'

async function openViewMenu(page: Page) {
  const button = page.locator('.nx-topbar-view-button')
  await button.click()
  await expect(page.locator('.nx-topbar-view-popover')).toBeVisible()
}

async function closeViewMenu(page: Page) {
  await page.keyboard.press('Escape')
  await page.locator('body').click({ position: { x: 20, y: 20 } })
}

async function setToggle(page: Page, label: string, enabled: boolean) {
  const option = viewOption(page, label)
  const toggle = option.locator('.nx-topbar-view-toggle')
  await expect(toggle).toBeVisible()
  const isOn = ((await toggle.textContent()) || '').trim().toLowerCase() === 'on'
  if (isOn !== enabled) {
    await toggle.click()
    await expect(toggle).toHaveText(enabled ? 'On' : 'Off')
  }
}

async function focusView(page: Page, label: string) {
  const option = viewOption(page, label)
  await option.locator('.nx-topbar-view-option__main').click()
}

async function setViewWidth(page: Page, label: string, width: '25%' | '50%' | '75%' | '100%') {
  const option = viewOption(page, label)
  const pill = option.locator('.nx-topbar-width-pill', { hasText: width })
  await expect(pill).toBeVisible()
  await pill.click()
}

async function configureDealWidth(page: Page, width: '25%' | '50%' | '75%') {
  await openViewMenu(page)
  await setToggle(page, 'Deal Intelligence', true)
  await setToggle(page, 'Inbox Thread View', true)
  await setToggle(page, 'SMS Thread View', false)
  await setToggle(page, 'List View', false)
  await setToggle(page, 'Command Map View', false)
  await focusView(page, 'Deal Intelligence')
  await setViewWidth(page, 'Deal Intelligence', width)
  await closeViewMenu(page)
}

async function configureDealFull(page: Page) {
  await openViewMenu(page)
  await setToggle(page, 'Deal Intelligence', true)
  await setToggle(page, 'List View', true)
  await setToggle(page, 'Inbox Thread View', false)
  await setToggle(page, 'SMS Thread View', false)
  await setToggle(page, 'Command Map View', false)
  await focusView(page, 'Deal Intelligence')
  await setToggle(page, 'List View', false)
  await closeViewMenu(page)
}

async function expectNoHorizontalOverflow(page: Page, selector: string) {
  const overflow = await page.locator(selector).evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }))
  expect(overflow.scrollWidth, `${selector} has horizontal overflow`).toBeLessThanOrEqual(overflow.clientWidth + 4)
}

async function screenshot(page: Page, name: string) {
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, `${name}.png`),
    fullPage: true,
  })
}

async function expectMediaHealthy(locator: Locator, minHeight: number, minWidth: number) {
  await expect(locator).toBeVisible()
  const box = await locator.boundingBox()
  expect(box, 'media area missing box').not.toBeNull()
  expect(box!.height, 'media too small').toBeGreaterThanOrEqual(minHeight)
  expect(box!.width, 'media too narrow').toBeGreaterThanOrEqual(minWidth)
}

async function ensureThreadSelected(page: Page) {
  const loading = page.locator('.nx-intelligence-panel .nx-inbox-loading-state')
  if (await loading.isVisible().catch(() => false)) {
    const firstThread = page.locator('.nx-thread-card').first()
    await expect(firstThread).toBeVisible()
    await firstThread.click()
  }
  await expect(page.locator('.nx-intelligence-panel .nx-inbox-loading-state')).toHaveCount(0)
}

async function verifyCompact(page: Page) {
  const pane = page.locator('.nx-workspace-pane.is-view-deal_intelligence.is-width-25')
  await expect(pane).toBeVisible()
  await expect(page.locator(compactRoot)).toBeVisible()
  await expect(page.locator('.nx-deal-compact-summary')).toBeVisible()
  await expect(page.locator('.nx-property-hero-shell').first()).toBeVisible()
  await expectMediaHealthy(page.locator('.nx-property-hero__media').first(), 220, 220)
  await expectNoHorizontalOverflow(page, '.nx-workspace-pane.is-view-deal_intelligence.is-width-25')
  await screenshot(page, 'deal-intelligence-25')
}

async function verifyMedium(page: Page) {
  const pane = page.locator('.nx-workspace-pane.is-view-deal_intelligence.is-width-50')
  await expect(pane).toBeVisible()
  await expect(page.locator(mediumRoot)).toBeVisible()
  await expect(page.locator('.nx-deal-medium-header')).toBeVisible()
  await expect(page.locator('.nx-property-hero-shell').first()).toBeVisible()
  await expectMediaHealthy(page.locator('.nx-property-hero__media').first(), 280, 320)
  await expectNoHorizontalOverflow(page, '.nx-workspace-pane.is-view-deal_intelligence.is-width-50')
  await screenshot(page, 'deal-intelligence-50')
}

async function verifyExpanded(page: Page) {
  const pane = page.locator('.nx-workspace-pane.is-view-deal_intelligence.is-width-75')
  await expect(pane).toBeVisible()
  await expect(page.locator(expandedRoot)).toBeVisible()
  await expect(page.locator('.nx-command-header-strip')).toBeVisible()
  await expect(page.locator('.nx-property-hero__full-toggle')).toBeVisible()
  await expectMediaHealthy(page.locator('.nx-property-hero__full-stage').first(), 360, 620)
  const dock = page.locator('.nx-command-action-dock')
  await expect(dock).toBeVisible()
  const overlap = await page.evaluate(() => {
    const dockEl = document.querySelector('.nx-command-action-dock')
    const sellerGrid = document.querySelector('.nx-deal-command-dossier__seller-grid')
    if (!dockEl || !sellerGrid) return false
    const dockRect = dockEl.getBoundingClientRect()
    const sellerRect = sellerGrid.getBoundingClientRect()
    return sellerRect.bottom > dockRect.top && sellerRect.top < dockRect.bottom
  })
  expect(overlap, 'expanded dock overlaps seller grid').toBe(false)
  await expectNoHorizontalOverflow(page, '.nx-workspace-pane.is-view-deal_intelligence.is-width-75')
  await screenshot(page, 'deal-intelligence-75')
}

async function verifyFull(page: Page) {
  await expect(page.locator('.nx-deal-intelligence-fullscreen')).toBeVisible()
  await expect(page.locator(expandedRoot)).toBeVisible()
  await expect(page.locator('.nx-command-header-strip')).toBeVisible()
  await expect(page.locator('.nx-property-hero__full-toggle')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Split' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Street' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Aerial' })).toBeVisible()
  await expectMediaHealthy(page.locator('.nx-property-hero__full-stage').first(), 420, 900)
  await expectNoHorizontalOverflow(page, '.nx-deal-intelligence-fullscreen')
  await screenshot(page, 'deal-intelligence-100')
}

test.describe('Deal Intelligence UI proof', () => {
  test('verifies 25/50/75/100 deal intelligence layouts', async ({ page }) => {
    await page.goto('/inbox', { waitUntil: 'networkidle' })
    await expect(page.locator('#nx-inbox-root')).toBeVisible()
    await expect(page.locator('.nx-intelligence-panel')).toBeVisible()
    await ensureThreadSelected(page)

    await configureDealWidth(page, '25%')
    await ensureThreadSelected(page)
    await verifyCompact(page)

    await configureDealWidth(page, '50%')
    await ensureThreadSelected(page)
    await verifyMedium(page)

    await configureDealWidth(page, '75%')
    await ensureThreadSelected(page)
    await verifyExpanded(page)

    await configureDealFull(page)
    await verifyFull(page)
  })
})
