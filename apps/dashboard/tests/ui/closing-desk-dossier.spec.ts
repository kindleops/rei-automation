import { test, expect, type Page } from '@playwright/test'
import path from 'node:path'
import { DOSSIER_SECTIONS } from '../../src/views/closing-desk/components/ClosingCaseWorkspace'

const OUT = path.resolve('test-results/closing-desk-screenshots')
const shot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false })

const RAW_ENUM_RE = /\b(on_track|fully_executed|assignment_signed|issues_open|not_scheduled|prop-demo-|owner-demo-|buyer-demo-)\b/

async function openDossier(page: Page) {
  await page.goto('/closing-desk?demo=1')
  await page.locator('.closing-desk-view').waitFor({ state: 'attached', timeout: 120_000 })
  await page.locator('[data-testid="cd-loading"]').waitFor({ state: 'detached', timeout: 60_000 }).catch(() => {})
  await page.locator('[data-testid="cd-card"]').first().click()
  await expect(page.locator('[data-testid="cd-dossier"]')).toBeVisible()
}

async function selectSection(page: Page, id: string) {
  const isMobile = (page.viewportSize()?.width ?? 1280) < 721
  if (isMobile) {
    await page.locator('[data-testid="cd-dossier-section-select"]').selectOption(id)
  } else {
    await page.locator(`[data-testid="cd-dossier-tab-${id}"]`).click()
  }
}

test('Dossier: fact rows separate labels from values', async ({ page }) => {
  await openDossier(page)
  const rows = page.locator('[data-testid="cd-fact-row"]')
  await expect(rows.first()).toBeVisible()
  const count = await rows.count()
  expect(count).toBeGreaterThan(3)
  for (let i = 0; i < Math.min(count, 8); i++) {
    const row = rows.nth(i)
    const label = (await row.locator('.cd-fact-row__label').innerText()).trim()
    const value = (await row.locator('.cd-fact-row__value').innerText()).trim()
    expect(label.length).toBeGreaterThan(0)
    expect(value.length).toBeGreaterThan(0)
    expect(value.startsWith(label), `concatenated label/value: "${label}" + "${value}"`).toBe(false)
  }
})

test('Dossier: no raw enums in operator panel; IDs only in source details', async ({ page }) => {
  await openDossier(page)
  const panelText = await page.locator('[data-testid="cd-dossier-panel"]').innerText()
  expect(RAW_ENUM_RE.test(panelText)).toBe(false)
  expect(panelText).toContain('On Track')

  await selectSection(page, 'audit')
  const auditText = await page.locator('[data-testid="cd-dossier-panel"]').innerText()
  expect(auditText).not.toMatch(/prop-demo-1/)
  await page.locator('[data-testid="cd-source-details"] button').click()
  await expect(page.locator('[data-testid="cd-source-details"] code').first()).toBeVisible()
})

test('Dossier: all 12 sections accessible with domain content', async ({ page }) => {
  await openDossier(page)
  expect(DOSSIER_SECTIONS).toHaveLength(12)

  for (const section of DOSSIER_SECTIONS) {
    await selectSection(page, section.id)
    await expect(page.locator('[data-testid="cd-dossier-panel"]')).toBeVisible()
    const panel = page.locator('[data-testid="cd-dossier-panel"]')
    await expect(panel.getByRole('heading').first()).toBeVisible()
  }

  await selectSection(page, 'milestones')
  await expect(page.locator('[data-testid="cd-milestone-timeline"]')).toBeVisible()

  await selectSection(page, 'issues')
  const issueCards = page.locator('[data-testid="cd-issue-card"]')
  if (await issueCards.count()) {
    await expect(issueCards.first().locator('.cd-fact-row__label').first()).toBeVisible()
  }
})

test('Dossier: copilot compact — not duplicated on every tab', async ({ page }) => {
  await openDossier(page)
  await expect(page.locator('[data-testid="cd-copilot-compact"]')).toBeVisible()
  await expect(page.locator('[data-testid="cd-copilot-full"]')).toHaveCount(1)

  await selectSection(page, 'contract')
  await expect(page.locator('[data-testid="cd-copilot-full"]')).toHaveCount(0)

  await selectSection(page, 'overview')
  await expect(page.locator('[data-testid="cd-copilot-full"]')).toHaveCount(1)
})

test('Dossier: missing closing date shows Not Scheduled', async ({ page }) => {
  await openDossier(page)
  await expect(page.locator('.cd-dossier__countdown')).toContainText('Not Scheduled')
})

test('Dossier: keyboard navigation between sections', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openDossier(page)
  const firstTab = page.locator('[data-testid="cd-dossier-tab-overview"]')
  await firstTab.focus()
  await page.keyboard.press('ArrowDown')
  await expect(page.locator('[data-testid="cd-dossier-tab-contract"]')).toHaveAttribute('aria-selected', 'true')
})

test('Dossier screenshots: sections, mobile, dark mode', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })

  await page.setViewportSize({ width: 1280, height: 900 })
  await openDossier(page)

  const sections = ['overview', 'contract', 'parties', 'buyer', 'title', 'milestones', 'issues'] as const
  for (const id of sections) {
    await selectSection(page, id)
    await page.waitForTimeout(150)
    await shot(page, `dossier-${id}`)
  }

  await page.evaluate(() => document.documentElement.setAttribute('data-nexus-theme', 'dark'))
  await selectSection(page, 'overview')
  await shot(page, 'dossier-dark-overview')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(200)
  await shot(page, 'dossier-mobile')

  expect(consoleErrors, consoleErrors.join(' | ')).toHaveLength(0)
})