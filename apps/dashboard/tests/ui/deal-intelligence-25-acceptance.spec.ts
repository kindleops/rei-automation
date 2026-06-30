import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const SCREENSHOT_DIR = path.resolve('test-results/screenshots/deal-intelligence-25-acceptance')
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true })

const TULSA_SEARCH = '4693 N Boston'
const THEMES = ['light', 'dark', 'red_ops'] as const

async function waitForInboxLive(page: Page) {
  await page.waitForResponse(
    (response) => response.url().includes('/api/cockpit/inbox/live') && response.status() === 200,
    { timeout: 60000 },
  )
  await expect(page.getByRole('button', { name: /Inbox could not load/i })).toHaveCount(0, { timeout: 30000 })
  await expect(page.locator('.nx-workspace-split-grid')).toBeVisible({ timeout: 30000 })
}

async function assertDealDeskWorkspace(page: Page) {
  await expect(page.getByTitle(/Workspace: Deal Desk/i)).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.nx-intelligence-panel')).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.nx-workspace-pane.is-view-thread')).toHaveCount(0)
  const widths = await page.evaluate(() => {
    const grid = document.querySelector('.nx-workspace-split-grid') as HTMLElement | null
    const conversation = document.querySelector('.nx-workspace-pane.is-view-sms_thread') as HTMLElement | null
    const intelligence = document.querySelector('.nx-workspace-pane.is-view-deal_intelligence') as HTMLElement | null
    if (!grid || !conversation || !intelligence) return null
    const total = grid.getBoundingClientRect().width
    return {
      conversation: conversation.getBoundingClientRect().width / total,
      intelligence: intelligence.getBoundingClientRect().width / total,
    }
  })
  expect(widths).not.toBeNull()
  expect(widths!.conversation).toBeGreaterThan(0.68)
  expect(widths!.conversation).toBeLessThan(0.82)
  expect(widths!.intelligence).toBeGreaterThan(0.18)
  expect(widths!.intelligence).toBeLessThan(0.32)
}

async function selectTulsaThread(page: Page) {
  const topSearch = page.getByRole('textbox', { name: /Search sellers, buyers, addresses, locations, conversations/i })
  await topSearch.fill(TULSA_SEARCH)
  await page.waitForTimeout(1500)
  const result = page.getByRole('button', { name: /4693 N Boston/i }).first()
  await expect(result).toBeVisible({ timeout: 45000 })
  await result.click()
  await expect(page.locator('.nx-deal-compact-shell')).toBeVisible({ timeout: 90000 })
}

async function setTheme(page: Page, theme: (typeof THEMES)[number]) {
  await page.evaluate((nextTheme) => {
    document.documentElement.setAttribute('data-nexus-theme', nextTheme)
    localStorage.setItem('nexus-theme', nextTheme)
  }, theme)
}

async function screenshot(page: Page, name: string) {
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`), fullPage: false })
}

async function verifyTulsa25Panel(page: Page) {
  const shell = page.locator('.nx-deal-compact-shell')
  await expect(shell).toBeVisible({ timeout: 20000 })

  await expect(shell).toContainText(/4693 N Boston/i)
  await expect(shell).toContainText(/Tulsa/i)
  await expect(shell).toContainText(/SFR/i)
  await expect(shell).toContainText(/\$97/)
  await expect(shell).toContainText(/Property Snapshot/i)
  await expect(shell).toContainText(/Baseline Property Intelligence/i)
  await expect(shell).toContainText(/Acquisition Decision Engine/i)
  await expect(shell).toContainText(/71/)
  await expect(shell).toContainText(/Tax Delinquent|High Equity|Absentee/i)

  const bodyText = await shell.innerText()
  expect(bodyText).not.toMatch(/Attempted: ZIP/i)
  expect(bodyText).not.toMatch(/Census enrichment not loaded/i)

  const panelWidth = await page.evaluate(() => {
    const shellEl = document.querySelector('.nx-deal-compact-shell') as HTMLElement | null
    const scroll = document.querySelector('.nx-intelligence-panel.is-layout-compact .nx-intel-scroll-body') as HTMLElement | null
    if (!shellEl || !scroll) return 0
    return shellEl.getBoundingClientRect().width / scroll.getBoundingClientRect().width
  })
  expect(panelWidth).toBeGreaterThan(0.92)

  const media = page.locator('.nx-di25-media__surface')
  await expect(media).toBeVisible()
  const hasMedia = await page.evaluate(() => {
    const surface = document.querySelector('.nx-di25-media__surface')
    if (!surface) return false
    const iframe = surface.querySelector('iframe')
    const img = surface.querySelector('img')
    return Boolean(iframe?.src || img?.src)
  })
  expect(hasMedia, 'Street View or stored image should render').toBe(true)
}

test.describe('Deal Intelligence 25% acceptance', () => {
  test('Tulsa SFR + themes', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('nx.inbox.deal-desk-layout-version', 'v3')
      localStorage.removeItem('nx.inbox.workspace-views-by-key')
      localStorage.removeItem('nx.inbox.workspace-width-overrides')
    })
    await page.goto('/inbox', { waitUntil: 'domcontentloaded' })
    await expect(page.locator('#nx-inbox-root')).toBeVisible({ timeout: 30000 })
    await waitForInboxLive(page)
    await assertDealDeskWorkspace(page)
    await selectTulsaThread(page)
    await verifyTulsa25Panel(page)
    await screenshot(page, 'tulsa-sfr-dark-default')

    for (const theme of THEMES) {
      await setTheme(page, theme)
      await page.waitForTimeout(400)
      await verifyTulsa25Panel(page)
      await screenshot(page, `tulsa-sfr-25-${theme}`)
    }
  })
})