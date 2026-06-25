import { test, expect, type Page } from '@playwright/test'
import path from 'node:path'

const OUT = path.resolve('test-results/closing-desk-screenshots')
const shot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false })

const FORBIDDEN_HOSTS = /textgrid|docusign|signpro|podio\.com\/.*\/(items|push)/i
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const DEMO_CASE_COUNT = 4

async function gotoClosingDesk(page: Page, opts: { demo?: boolean } = {}) {
  const consoleErrors: string[] = []
  const forbidden: string[] = []
  const mutations: string[] = []

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('request', (req) => {
    const url = req.url()
    let host = ''
    try { host = new URL(url).hostname } catch { /* ignore */ }
    const isLocal = host === '127.0.0.1' || host === 'localhost'
    if (!isLocal && FORBIDDEN_HOSTS.test(url)) forbidden.push(`${req.method()} ${url}`)
    if (MUTATING_METHODS.has(req.method()) && /\/api\//.test(url)) mutations.push(`${req.method()} ${url}`)
  })

  await page.goto(opts.demo ? '/closing-desk?demo=1' : '/closing-desk')
  await page.locator('.closing-desk-view').waitFor({ state: 'attached', timeout: 120_000 })
  await page.locator('[data-testid="cd-board"], [data-testid="cd-table"], [data-testid="cd-loading"]').first().waitFor({ state: 'attached', timeout: 60_000 })
  await page.locator('[data-testid="cd-loading"]').waitFor({ state: 'detached', timeout: 60_000 }).catch(() => {})

  return { consoleErrors, forbidden, mutations }
}

async function boardCardCount(page: Page) {
  return page.locator('[data-testid="cd-card"]').count()
}

async function sumLaneCounts(page: Page) {
  const counts = await page.locator('[data-testid^="cd-lane-count-"]').allTextContents()
  return counts.reduce((sum, t) => sum + Number.parseInt(t.trim(), 10), 0)
}

test('Real zero-state: pipeline, no fixtures, command card, diagnostics drawer', async ({ page }) => {
  const { forbidden, mutations } = await gotoClosingDesk(page)

  await expect(page.locator('[data-testid="cd-command-header"]')).toBeVisible()
  await expect(page.locator('.cd-command-header__eyebrow')).toHaveText(/CLOSING OPERATIONS/)
  await expect(page.locator('[data-testid="cd-env-demo"]')).toHaveCount(0)
  await expect(page.locator('[data-testid="cd-command-card"]')).toBeVisible()
  await expect(page.locator('[data-testid="cd-card"]')).toHaveCount(0)

  const boardCards = await boardCardCount(page)
  const laneSum = await sumLaneCounts(page)
  expect(boardCards).toBe(0)
  expect(laneSum).toBe(0)

  await page.locator('[data-testid="cd-diagnostics-btn"]').click()
  await expect(page.locator('[data-testid="cd-diagnostics-panel"]')).toBeVisible()
  await page.locator('[data-testid="cd-diagnostics-panel"] .cd-diag-panel__close').click()

  await shot(page, 'closing-desk-zero-desktop')

  expect(forbidden).toHaveLength(0)
  expect(mutations).toHaveLength(0)
})

test('Demo: every fixture case visible on board and table with reconciled counts', async ({ page }) => {
  await gotoClosingDesk(page, { demo: true })

  await expect(page.locator('[data-testid="cd-env-demo"]')).toBeVisible()
  await expect(page.locator('[data-testid="cd-command-card"]')).toHaveCount(0)

  const boardCards = await boardCardCount(page)
  const laneSum = await sumLaneCounts(page)
  expect(boardCards).toBe(DEMO_CASE_COUNT)
  expect(laneSum).toBe(DEMO_CASE_COUNT)

  const verifyBoard = await page.locator('.closing-desk-view').getAttribute('data-verify-board')
  const verifyTable = await page.locator('.closing-desk-view').getAttribute('data-verify-table')
  expect(Number(verifyBoard)).toBe(DEMO_CASE_COUNT)
  expect(Number(verifyTable)).toBe(DEMO_CASE_COUNT)

  await shot(page, 'closing-desk-demo-board')

  await page.getByRole('tab', { name: 'Table' }).click()
  await expect(page.locator('[data-testid="cd-table-row"]')).toHaveCount(DEMO_CASE_COUNT)
  await shot(page, 'closing-desk-demo-table')
})

test('Filters reconcile board and table counts', async ({ page }) => {
  await gotoClosingDesk(page, { demo: true })

  await page.getByLabel('Search closing cases').fill('Memphis')
  await expect(page.locator('[data-testid="cd-card"]')).toHaveCount(1)
  expect(await sumLaneCounts(page)).toBe(1)

  await page.getByRole('tab', { name: 'Table' }).click()
  await expect(page.locator('[data-testid="cd-table-row"]')).toHaveCount(1)

  await page.getByLabel('Search closing cases').fill('')
  await page.getByRole('tab', { name: 'Board' }).click()
  await expect(page.locator('[data-testid="cd-card"]')).toHaveCount(DEMO_CASE_COUNT)
})

test('Case dossier opens from board and table with same selection', async ({ page }) => {
  await gotoClosingDesk(page, { demo: true })

  const firstCard = page.locator('[data-testid="cd-card"]').first()
  const caseId = await firstCard.getAttribute('data-case-id')
  await firstCard.click()
  await expect(page.locator('[data-testid="cd-dossier"]')).toBeVisible()
  await expect(page.locator('[data-testid="cd-next-action"]')).toBeVisible()
  await expect(page.locator('[data-testid="cd-copilot-compact"]')).toBeVisible()

  const execButtons = page.locator('.cd-proposed button')
  for (let i = 0, n = await execButtons.count(); i < n; i++) await expect(execButtons.nth(i)).toBeDisabled()

  await shot(page, 'closing-desk-workspace')
  await page.locator('.cd-dossier__close').click()

  await page.getByRole('tab', { name: 'Table' }).click()
  await page.locator(`[data-testid="cd-table-row"][data-case-id="${caseId}"]`).click()
  await expect(page.locator('[data-testid="cd-dossier"]')).toBeVisible()
  await page.locator('.cd-dossier__close').click()
})

test('Keyboard focus on view mode tabs', async ({ page }) => {
  await gotoClosingDesk(page, { demo: true })
  await page.getByRole('tab', { name: 'Board' }).focus()
  await expect(page.getByRole('tab', { name: 'Board' })).toBeFocused()
})

test('Light, dark, tablet, mobile without console errors', async ({ page }) => {
  const { consoleErrors } = await gotoClosingDesk(page, { demo: true })
  await page.getByRole('tab', { name: 'Board' }).click()

  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-nexus-theme', t), theme)
    await page.waitForTimeout(200)
    await shot(page, `closing-desk-${theme}`)
  }

  await page.setViewportSize({ width: 820, height: 1024 })
  await page.waitForTimeout(200)
  await expect(page.locator('[data-testid="cd-board"]')).toBeVisible()

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(200)
  await expect(page.locator('.closing-desk-view')).toBeVisible()
  await shot(page, 'closing-desk-mobile')

  expect(consoleErrors, consoleErrors.join(' | ')).toHaveLength(0)
})