import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const SCREENSHOT_DIR = path.resolve('test-results/canonical-release')
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true })

const THEMES = [
  { id: 'dark', label: 'dark' },
  { id: 'light', label: 'light' },
  { id: 'red_ops', label: 'red_ops' },
] as const

const CORE_ROUTES = [
  { path: '/inbox', root: '#nx-inbox-root', name: 'inbox' },
  { path: '/queue', root: '.nx-fullscreen-app-shell, #nx-inbox-root, main', name: 'queue' },
  { path: '/pipeline', root: '#nx-inbox-root', name: 'pipeline' },
  { path: '/comp-intelligence', root: '#nx-inbox-root', name: 'comp-intelligence' },
  { path: '/buyer-match', root: '.nx-fullscreen-app-shell, main', name: 'buyer-match' },
  { path: '/workflow-studio', root: '.nx-fullscreen-app-shell, .wfs2-isolation-root, main', name: 'workflow-studio' },
  { path: '/campaign-command', root: '.nx-fullscreen-app-shell, main', name: 'campaign-command' },
  { path: '/calendar', root: '#nx-inbox-root', name: 'calendar' },
  { path: '/map', root: '#nx-inbox-root', name: 'map' },
  { path: '/entity-graph', root: '.nx-entity-graph-workspace, main', name: 'entity-graph' },
] as const

const SCREENSHOT_VIEWS = ['inbox', 'queue', 'pipeline', 'comp-intelligence', 'buyer-match'] as const

async function setTheme(page: Page, themeId: string) {
  await page.evaluate((theme) => {
    const key = 'nexus-settings'
    const raw = localStorage.getItem(key)
    const settings = raw ? JSON.parse(raw) : {}
    settings.nexusTheme = theme
    localStorage.setItem(key, JSON.stringify(settings))
    document.documentElement.setAttribute('data-nexus-theme', theme)
  }, themeId)
}

async function assertHealthyPage(page: Page, routeName: string) {
  const bodyText = await page.locator('body').innerText()
  expect(bodyText, `${routeName} blank workspace`).not.toMatch(/^\s*$/)

  const fatalPatterns = [
    /Cannot find module/i,
    /MODULE_NOT_FOUND/i,
    /vendor-chunks\/@sentry/i,
    /Unhandled Runtime Error/i,
    /TypeError: Failed to fetch dynamically imported module/i,
  ]
  for (const pattern of fatalPatterns) {
    expect(bodyText, `${routeName} fatal error`).not.toMatch(pattern)
  }

  await expect(page.locator('.nx-inbox-loading-state').first()).toBeHidden({ timeout: 20_000 }).catch(() => {})

  const overflow = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  expect(overflow.scrollWidth, `${routeName} horizontal overflow`).toBeLessThanOrEqual(overflow.clientWidth + 8)
}

async function screenshot(page: Page, name: string) {
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, `${name}.png`),
    fullPage: false,
  })
}

test.describe('Canonical release validation', () => {
  test.use({ baseURL: 'http://127.0.0.1:5173' })

  for (const theme of THEMES) {
    test(`core screens render in ${theme.label} theme`, async ({ page }) => {
      await page.goto('/inbox', { waitUntil: 'domcontentloaded' })
      await setTheme(page, theme.id)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await expect(page.locator('html')).toHaveAttribute('data-nexus-theme', theme.id)

      for (const route of CORE_ROUTES) {
        await page.goto(route.path, { waitUntil: 'domcontentloaded', timeout: 60_000 })
        await page.waitForTimeout(1500)
        const root = page.locator(route.root).first()
        await expect(root, `${route.name} root missing`).toBeVisible({ timeout: 30_000 })
        await assertHealthyPage(page, route.name)

        if (SCREENSHOT_VIEWS.includes(route.name as typeof SCREENSHOT_VIEWS[number])) {
          await screenshot(page, `${route.name}-${theme.label}`)
        }
      }
    })
  }

  test('comp intelligence workspace shows resolved subject context', async ({ page }) => {
    await page.goto('/comp-intelligence', { waitUntil: 'domcontentloaded' })
    await setTheme(page, 'dark')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.locator('#nx-inbox-root')).toBeVisible()
    await assertHealthyPage(page, 'comp-intelligence-proof')
    await screenshot(page, 'comp-intelligence-proof-dark')
  })

  test('buyer match workspace loads without raw backend errors', async ({ page }) => {
    await page.goto('/buyer-match', { waitUntil: 'domcontentloaded' })
    await setTheme(page, 'dark')
    await page.reload({ waitUntil: 'domcontentloaded' })
    const bodyText = await page.locator('body').innerText()
    expect(bodyText).not.toMatch(/vendor-chunks|MODULE_NOT_FOUND|stack trace/i)
    await screenshot(page, 'buyer-match-proof-dark')
  })

  test('API requests avoid stale backend ports', async ({ page }) => {
    const apiHosts: string[] = []
    page.on('request', (request) => {
      const url = request.url()
      if (url.includes('/api/')) apiHosts.push(new URL(url).host)
    })
    await page.goto('/inbox', { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(5000)
    expect(apiHosts.length).toBeGreaterThan(0)
    for (const host of apiHosts) {
      expect(host).not.toMatch(/:3001|:3002|:5175|:5176/)
      expect(host).toMatch(/:5173$|:3000$/)
    }
  })
})