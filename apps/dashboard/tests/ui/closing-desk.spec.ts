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
    // A real external comm leaves localhost. Vite dev serves app source modules
    // (e.g. /src/lib/data/textgridRouting.ts) by URL on the dev host — those are
    // module loads, not provider calls, so we only flag off-host provider hits.
    if (!isLocal && FORBIDDEN_HOSTS.test(url)) forbidden.push(`${req.method()} ${url}`)
    // Closing Desk foundation is read-only: only GET/OPTIONS to our own API.
    if (MUTATING_METHODS.has(req.method()) && /\/api\//.test(url)) mutations.push(`${req.method()} ${url}`)
  })

  await page.goto(opts.demo ? '/closing-desk?demo=1' : '/closing-desk')
  await page.locator('.closing-desk-view').waitFor({ state: 'attached', timeout: 120_000 })
  // Wait until the loading skeleton resolves to board/table/empty.
  await page
    .locator('[data-testid="cd-board"], [data-testid="cd-table"], [data-testid="cd-empty"]')
    .first()
    .waitFor({ state: 'attached', timeout: 60_000 })

  return { consoleErrors, forbidden, mutations }
}

test('Closing Desk loads with header metrics and a deal surface', async ({ page }) => {
  const { forbidden, mutations } = await gotoClosingDesk(page)

  await expect(page.locator('.cd-header h1')).toHaveText(/Closing Desk/)
  await expect(page.locator('[data-testid="cd-metrics"] .cd-metric')).toHaveCount(9)
  // Every metric declares a named source (no hardcoded metrics).
  await expect(page.locator('[data-testid="cd-metrics"] .cd-metric__source').first()).toContainText('src:')

  await shot(page, 'closing-desk-board')

  // Read-only invariants.
  expect(forbidden, `external comm/mutation requests: ${forbidden.join(', ')}`).toHaveLength(0)
  expect(mutations, `mutating API requests: ${mutations.join(', ')}`).toHaveLength(0)
})

test('Board ↔ Table switch and filters work', async ({ page }) => {
  // Demo mode guarantees labeled fixture cases so the surface is deterministic.
  await gotoClosingDesk(page, { demo: true })
  await expect(page.locator('[data-testid="cd-demo-banner"]')).toBeVisible()
  await expect(page.locator('[data-testid="cd-card"]').first()).toBeVisible()

  await page.getByRole('tab', { name: 'Table' }).click()
  await expect(page.locator('[data-testid="cd-table"]')).toBeVisible()
  await page.getByRole('tab', { name: 'Board' }).click()
  await expect(page.locator('[data-testid="cd-board"]')).toBeVisible()

  // Search filter narrows results.
  await page.getByLabel('Search closing cases').fill('zzz-no-such-case')
  await expect(page.locator('[data-testid="cd-empty"]')).toBeVisible()
  await page.getByLabel('Search closing cases').fill('')
})

test('Case workspace opens and renders milestones, issues, financials, health reasoning', async ({ page }) => {
  await gotoClosingDesk(page, { demo: true })
  await expect(page.locator('[data-testid="cd-card"]').first()).toBeVisible()

  await page.locator('[data-testid="cd-card"]').first().click()
  const drawer = page.locator('.cd-drawer')
  await expect(drawer).toBeVisible()

  await expect(page.locator('[data-testid="cd-next-action"]')).toBeVisible()
  await expect(drawer.getByText('Closing Milestones', { exact: false })).toBeVisible()
  await expect(drawer.getByText('Issues & Curative', { exact: false })).toBeVisible()
  await expect(drawer.getByText('Financials & Expected Revenue', { exact: false })).toBeVisible()
  await expect(drawer.getByText(/Closing Health — Why/)).toBeVisible()
  await expect(drawer.getByText('Closing Copilot — Read Only', { exact: false })).toBeVisible()

  // Copilot execution must be disabled in the read-only foundation.
  const execButtons = drawer.locator('.cd-proposed button')
  const n = await execButtons.count()
  for (let i = 0; i < n; i++) await expect(execButtons.nth(i)).toBeDisabled()

  await shot(page, 'closing-desk-workspace')
  await page.locator('.cd-drawer__close').click()
  await expect(drawer).toBeHidden()
})

test('Renders in light + dark and on a mobile viewport without console errors', async ({ page }) => {
  const { consoleErrors } = await gotoClosingDesk(page)

  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-nexus-theme', t), theme)
    await page.waitForTimeout(250)
    await shot(page, `closing-desk-${theme}`)
  }

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(250)
  await expect(page.locator('.closing-desk-view')).toBeVisible()
  await shot(page, 'closing-desk-mobile')

  expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toHaveLength(0)
})
