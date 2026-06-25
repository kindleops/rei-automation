import { test, expect, type Page } from '@playwright/test'
import path from 'node:path'

const OUT = path.resolve('test-results/closing-desk-screenshots')
const shot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false })

/** Patterns that would indicate an unauthorized external comm / mutation. */
const FORBIDDEN_HOSTS = /textgrid|docusign|signpro|podio\.com\/.*\/(items|push)/i
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

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
    try {
      host = new URL(url).hostname
    } catch {
      /* ignore */
    }
    const isLocal = host === '127.0.0.1' || host === 'localhost'
    if (!isLocal && FORBIDDEN_HOSTS.test(url)) forbidden.push(`${req.method()} ${url}`)
    if (MUTATING_METHODS.has(req.method()) && /\/api\//.test(url)) mutations.push(`${req.method()} ${url}`)
  })

  await page.goto(opts.demo ? '/closing-desk?demo=1' : '/closing-desk')
  await page.locator('.closing-desk-view').waitFor({ state: 'attached', timeout: 120_000 })
  await page
    .locator('[data-testid="cd-board"], [data-testid="cd-table"], [data-testid="cd-loading"]')
    .first()
    .waitFor({ state: 'attached', timeout: 60_000 })
  await page.locator('[data-testid="cd-loading"]').waitFor({ state: 'detached', timeout: 60_000 }).catch(() => {})

  return { consoleErrors, forbidden, mutations }
}

test('Real route: empty pipeline, command card, no duplicate eyebrow, no fixtures', async ({ page }) => {
  const { forbidden, mutations } = await gotoClosingDesk(page)

  await expect(page.locator('.cd-header h1')).toHaveText(/Closing Desk/)
  await expect(page.locator('.cd-header__eyebrow')).toHaveCount(1)
  await expect(page.locator('.cd-header__eyebrow')).toHaveText(/POST-CONTRACT COMMAND/)
  await expect(page.locator('.cd-header__eyebrow')).not.toContainText(/CLOSING DESK.*OSING DESK/)

  await expect(page.locator('[data-testid="cd-demo-banner"]')).toHaveCount(0)
  await expect(page.locator('[data-testid="cd-command-card"]')).toBeVisible()
  await expect(page.locator('[data-testid="cd-board"]')).toBeVisible()
  await expect(page.locator('[data-testid="cd-lane-contract_intake"]')).toBeVisible()
  await expect(page.locator('[data-testid="cd-lane-closed"]')).toBeVisible()
  await expect(page.locator('[data-testid="cd-card"]')).toHaveCount(0)

  await expect(page.locator('[data-testid="cd-metrics"] .cd-metric--primary')).toHaveCount(5)
  await expect(page.locator('[data-testid="cd-metrics"] .cd-metric--compact')).toHaveCount(4)

  await shot(page, 'closing-desk-empty-desktop')

  expect(forbidden, `external comm/mutation requests: ${forbidden.join(', ')}`).toHaveLength(0)
  expect(mutations, `mutating API requests: ${mutations.join(', ')}`).toHaveLength(0)
})

test('Demo mode: labeled fixtures, populated board, unmistakable DEMO banner', async ({ page }) => {
  await gotoClosingDesk(page, { demo: true })

  await expect(page.locator('[data-testid="cd-demo-banner"]')).toBeVisible()
  await expect(page.locator('[data-testid="cd-command-card"]')).toHaveCount(0)
  await expect(page.locator('[data-testid="cd-card"]').first()).toBeVisible()

  await shot(page, 'closing-desk-demo-board')
})

test('Board ↔ Table switch, filters, and keyboard focus', async ({ page }) => {
  await gotoClosingDesk(page, { demo: true })

  await page.getByRole('tab', { name: 'Table' }).click()
  await expect(page.locator('[data-testid="cd-table"]')).toBeVisible()
  await page.getByRole('tab', { name: 'Board' }).click()
  await expect(page.locator('[data-testid="cd-board"]')).toBeVisible()

  await page.getByLabel('Search closing cases').fill('zzz-no-such-case')
  await expect(page.locator('[data-testid="cd-filter-empty"]')).toBeVisible()
  await page.getByLabel('Search closing cases').fill('')

  await page.getByRole('tab', { name: 'Board' }).focus()
  await expect(page.getByRole('tab', { name: 'Board' })).toBeFocused()
})

test('Case workspace opens with milestones, issues, financials, read-only copilot', async ({ page }) => {
  await gotoClosingDesk(page, { demo: true })
  await page.locator('[data-testid="cd-card"]').first().click()
  const drawer = page.locator('.cd-drawer')
  await expect(drawer).toBeVisible()

  await expect(page.locator('[data-testid="cd-next-action"]')).toBeVisible()
  await expect(drawer.getByText('Closing Milestones', { exact: false })).toBeVisible()
  await expect(drawer.getByText(/Closing Health — Why/)).toBeVisible()
  await expect(drawer.getByText('Closing Copilot — Read Only', { exact: false })).toBeVisible()

  const execButtons = drawer.locator('.cd-proposed button')
  const n = await execButtons.count()
  for (let i = 0; i < n; i++) await expect(execButtons.nth(i)).toBeDisabled()

  await shot(page, 'closing-desk-workspace')
  await page.locator('.cd-drawer__close').click()
})

test('Light + dark themes and mobile layout without console errors', async ({ page }) => {
  const { consoleErrors } = await gotoClosingDesk(page)

  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-nexus-theme', t), theme)
    await page.waitForTimeout(250)
    await shot(page, `closing-desk-${theme}`)
  }

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(250)
  await expect(page.locator('.closing-desk-view')).toBeVisible()
  await expect(page.locator('[data-testid="cd-board"]')).toBeVisible()
  await shot(page, 'closing-desk-mobile')

  expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toHaveLength(0)
})

test('Degraded diagnostics panel visible on real empty route', async ({ page }) => {
  await gotoClosingDesk(page)
  await expect(page.locator('[data-testid="cd-diagnostics-panel"]')).toBeVisible()
  await expect(page.locator('[data-testid="cd-lifecycle-reqs"]')).toBeVisible()
})