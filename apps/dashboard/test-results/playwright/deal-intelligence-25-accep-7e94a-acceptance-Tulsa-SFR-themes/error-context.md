# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: deal-intelligence-25-acceptance.spec.ts >> Deal Intelligence 25% acceptance >> Tulsa SFR + themes
- Location: tests/ui/deal-intelligence-25-acceptance.spec.ts:78:3

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByRole('button', { name: /4693 N Boston/i }).first()
Expected: visible
Timeout: 45000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 45000ms
  - waiting for getByRole('button', { name: /4693 N Boston/i }).first()

```

```yaml
- text: Inbox
- main:
  - text: NEXUS
  - strong: Dashboard
  - text: 7.4%
  - 'button "Workspace: Deal Desk"':
    - strong
  - button "Queue Processor · Warning"
  - textbox "Search Inbox sellers, buyers, properties, conversations, and markets":
    - /placeholder: Search sellers, buyers, addresses, locations, conversations...
  - text: CMD+K
  - button "Tasks"
  - button "Activity"
  - button "Notifications"
  - button "RK"
  - complementary:
    - textbox "Search inbox threads":
      - /placeholder: Search operator inbox...
      - text: 4693 N Boston
    - button
    - button "Advanced filters"
    - button "Clear filters"
    - tablist "Inbox categories":
      - tab "Priority 0"
      - tab "New Replies 0"
      - tab "Needs Review 0"
      - tab "Waiting 0"
      - tab "All Messages 0" [selected]
    - button "Inbox could not load. Retry."
    - button "+ Save Current Filter"
    - button "Manage Lists"
    - button "Inbox could not load. Retry."
  - main:
    - paragraph: Select a thread to open the conversation.
    - checkbox "Operator Polish" [disabled]
    - text: Operator Polish
    - button "Open templates and quick actions" [disabled]
    - textbox "Select a thread to compose" [disabled]
    - button "Translate draft" [disabled]
    - button "Schedule message" [disabled]
    - button "Talk to type" [disabled]
    - button "Send message" [disabled]
  - complementary:
    - paragraph: Select a thread to view intelligence
- button "NEXUS Copilot": Standing by
```

# Test source

```ts
  1  | import fs from 'node:fs'
  2  | import path from 'node:path'
  3  | import { expect, test, type Page } from '@playwright/test'
  4  | 
  5  | const SCREENSHOT_DIR = path.resolve('test-results/screenshots/deal-intelligence-25-acceptance')
  6  | fs.mkdirSync(SCREENSHOT_DIR, { recursive: true })
  7  | 
  8  | const TULSA_SEARCH = '4693 N Boston'
  9  | const THEMES = ['light', 'dark', 'red_ops'] as const
  10 | 
  11 | async function activateDealDeskWorkspace(page: Page) {
  12 |   await page.getByTitle(/Workspace: Deal Desk/i).click()
  13 |   await page.getByRole('button', { name: 'Pinned Workspaces' }).click()
  14 |   await page.getByRole('button', { name: 'Deal Desk Inbox ·' }).click()
  15 |   await expect(page.locator('.nx-intelligence-panel')).toBeVisible({ timeout: 30000 })
  16 | }
  17 | 
  18 | async function selectTulsaThread(page: Page) {
  19 |   const sidebarSearch = page.getByRole('textbox', { name: /Search inbox threads/i })
  20 |   await sidebarSearch.fill(TULSA_SEARCH)
  21 |   await page.waitForTimeout(1500)
  22 |   const thread = page.getByRole('button', { name: /4693 N Boston/i }).first()
> 23 |   await expect(thread).toBeVisible({ timeout: 45000 })
     |                        ^ Error: expect(locator).toBeVisible() failed
  24 |   await thread.click()
  25 |   await expect(page.locator('.nx-deal-compact-shell')).toBeVisible({ timeout: 90000 })
  26 | }
  27 | 
  28 | async function setTheme(page: Page, theme: (typeof THEMES)[number]) {
  29 |   await page.evaluate((nextTheme) => {
  30 |     document.documentElement.setAttribute('data-nexus-theme', nextTheme)
  31 |     localStorage.setItem('nexus-theme', nextTheme)
  32 |   }, theme)
  33 | }
  34 | 
  35 | async function screenshot(page: Page, name: string) {
  36 |   await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`), fullPage: false })
  37 | }
  38 | 
  39 | async function verifyTulsa25Panel(page: Page) {
  40 |   const shell = page.locator('.nx-deal-compact-shell')
  41 |   await expect(shell).toBeVisible({ timeout: 20000 })
  42 | 
  43 |   await expect(shell).toContainText(/4693 N Boston/i)
  44 |   await expect(shell).toContainText(/Tulsa/i)
  45 |   await expect(shell).toContainText(/SFR/i)
  46 |   await expect(shell).toContainText(/\$97/)
  47 |   await expect(shell).toContainText(/Property Snapshot/i)
  48 |   await expect(shell).toContainText(/Baseline Property Intelligence/i)
  49 |   await expect(shell).toContainText(/Acquisition Decision Engine/i)
  50 |   await expect(shell).toContainText(/71/)
  51 |   await expect(shell).toContainText(/Tax Delinquent|High Equity|Absentee/i)
  52 | 
  53 |   const bodyText = await shell.innerText()
  54 |   expect(bodyText).not.toMatch(/Attempted: ZIP/i)
  55 |   expect(bodyText).not.toMatch(/Census enrichment not loaded/i)
  56 | 
  57 |   const panelWidth = await page.evaluate(() => {
  58 |     const shellEl = document.querySelector('.nx-deal-compact-shell') as HTMLElement | null
  59 |     const scroll = document.querySelector('.nx-intelligence-panel.is-layout-compact .nx-intel-scroll-body') as HTMLElement | null
  60 |     if (!shellEl || !scroll) return 0
  61 |     return shellEl.getBoundingClientRect().width / scroll.getBoundingClientRect().width
  62 |   })
  63 |   expect(panelWidth).toBeGreaterThan(0.92)
  64 | 
  65 |   const media = page.locator('.nx-di25-media__surface')
  66 |   await expect(media).toBeVisible()
  67 |   const hasMedia = await page.evaluate(() => {
  68 |     const surface = document.querySelector('.nx-di25-media__surface')
  69 |     if (!surface) return false
  70 |     const iframe = surface.querySelector('iframe')
  71 |     const img = surface.querySelector('img')
  72 |     return Boolean(iframe?.src || img?.src)
  73 |   })
  74 |   expect(hasMedia, 'Street View or stored image should render').toBe(true)
  75 | }
  76 | 
  77 | test.describe('Deal Intelligence 25% acceptance', () => {
  78 |   test('Tulsa SFR + themes', async ({ page }) => {
  79 |     await page.goto('/inbox', { waitUntil: 'networkidle' })
  80 |     await expect(page.locator('#nx-inbox-root')).toBeVisible({ timeout: 30000 })
  81 | 
  82 |     await activateDealDeskWorkspace(page)
  83 |     await selectTulsaThread(page)
  84 |     await verifyTulsa25Panel(page)
  85 |     await screenshot(page, 'tulsa-sfr-dark-default')
  86 | 
  87 |     for (const theme of THEMES) {
  88 |       await setTheme(page, theme)
  89 |       await page.waitForTimeout(400)
  90 |       await verifyTulsa25Panel(page)
  91 |       await screenshot(page, `tulsa-sfr-25-${theme}`)
  92 |     }
  93 |   })
  94 | })
```