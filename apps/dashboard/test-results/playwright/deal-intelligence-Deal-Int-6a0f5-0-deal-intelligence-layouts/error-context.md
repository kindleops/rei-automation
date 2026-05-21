# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: deal-intelligence.spec.ts >> Deal Intelligence UI proof >> verifies 25/50/75/100 deal intelligence layouts
- Location: tests/ui/deal-intelligence.spec.ts:154:3

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('.nx-deal-compact-shell')
Expected: visible
Timeout: 10000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 10000ms
  - waiting for locator('.nx-deal-compact-shell')

```

```yaml
- text: Inbox
- main:
  - text: NEXUS
  - strong: Inbox
  - text: Reply Rate
  - strong: 0.0%
  - button "View 2 Views Active":
    - text: View
    - strong: 2 Views Active
  - textbox "Search threads, sellers, addresses, or commands":
    - /placeholder: Search threads, sellers, addresses, or commands...
  - text: ⌘K
  - button "LIVE"
  - button "Off Warning"
  - button "Enable light mode"
  - button "Activity Log"
  - button "1"
  - button "RK"
  - main:
    - complementary:
      - paragraph: Select a thread to view intelligence
    - paragraph: Select a thread to view the conversation.
    - button "Attach file" [disabled]
    - textbox "Select a thread to compose" [disabled]
    - button "Talk to type" [disabled]
    - button "Send message" [disabled]
- button "NEXUS Copilot": Standing by
```

# Test source

```ts
  1   | import fs from 'node:fs'
  2   | import path from 'node:path'
  3   | import { expect, test, type Locator, type Page } from '@playwright/test'
  4   | 
  5   | const SCREENSHOT_DIR = path.resolve('test-results/screenshots')
  6   | fs.mkdirSync(SCREENSHOT_DIR, { recursive: true })
  7   | 
  8   | const viewOption = (page: Page, label: string) =>
  9   |   page.locator('.nx-topbar-view-option').filter({ has: page.locator('strong', { hasText: label }) }).first()
  10  | 
  11  | const compactRoot = '.nx-deal-compact-shell'
  12  | const mediumRoot = '.nx-deal-medium-shell'
  13  | const expandedRoot = '.nx-deal-command-dossier'
  14  | 
  15  | async function openViewMenu(page: Page) {
  16  |   const button = page.locator('.nx-topbar-view-button')
  17  |   await button.click()
  18  |   await expect(page.locator('.nx-topbar-view-popover')).toBeVisible()
  19  | }
  20  | 
  21  | async function closeViewMenu(page: Page) {
  22  |   await page.keyboard.press('Escape')
  23  |   await page.locator('body').click({ position: { x: 20, y: 20 } })
  24  | }
  25  | 
  26  | async function setToggle(page: Page, label: string, enabled: boolean) {
  27  |   const option = viewOption(page, label)
  28  |   const toggle = option.locator('.nx-topbar-view-toggle')
  29  |   await expect(toggle).toBeVisible()
  30  |   const isOn = ((await toggle.textContent()) || '').trim().toLowerCase() === 'on'
  31  |   if (isOn !== enabled) {
  32  |     await toggle.click()
  33  |     await expect(toggle).toHaveText(enabled ? 'On' : 'Off')
  34  |   }
  35  | }
  36  | 
  37  | async function focusView(page: Page, label: string) {
  38  |   const option = viewOption(page, label)
  39  |   await option.locator('.nx-topbar-view-option__main').click()
  40  | }
  41  | 
  42  | async function setViewWidth(page: Page, label: string, width: '25%' | '50%' | '75%' | '100%') {
  43  |   const option = viewOption(page, label)
  44  |   const pill = option.locator('.nx-topbar-width-pill', { hasText: width })
  45  |   await expect(pill).toBeVisible()
  46  |   await pill.click()
  47  | }
  48  | 
  49  | async function configureDealWidth(page: Page, width: '25%' | '50%' | '75%') {
  50  |   await openViewMenu(page)
  51  |   await setToggle(page, 'Deal Intelligence', true)
  52  |   await setToggle(page, 'Inbox Thread View', true)
  53  |   await setToggle(page, 'SMS Thread View', false)
  54  |   await setToggle(page, 'List View', false)
  55  |   await setToggle(page, 'Command Map View', false)
  56  |   await focusView(page, 'Deal Intelligence')
  57  |   await setViewWidth(page, 'Deal Intelligence', width)
  58  |   await closeViewMenu(page)
  59  | }
  60  | 
  61  | async function configureDealFull(page: Page) {
  62  |   await openViewMenu(page)
  63  |   await setToggle(page, 'Deal Intelligence', true)
  64  |   await setToggle(page, 'List View', true)
  65  |   await setToggle(page, 'Inbox Thread View', false)
  66  |   await setToggle(page, 'SMS Thread View', false)
  67  |   await setToggle(page, 'Command Map View', false)
  68  |   await focusView(page, 'Deal Intelligence')
  69  |   await setToggle(page, 'List View', false)
  70  |   await closeViewMenu(page)
  71  | }
  72  | 
  73  | async function expectNoHorizontalOverflow(page: Page, selector: string) {
  74  |   const overflow = await page.locator(selector).evaluate((element) => ({
  75  |     clientWidth: element.clientWidth,
  76  |     scrollWidth: element.scrollWidth,
  77  |   }))
  78  |   expect(overflow.scrollWidth, `${selector} has horizontal overflow`).toBeLessThanOrEqual(overflow.clientWidth + 4)
  79  | }
  80  | 
  81  | async function screenshot(page: Page, name: string) {
  82  |   await page.screenshot({
  83  |     path: path.join(SCREENSHOT_DIR, `${name}.png`),
  84  |     fullPage: true,
  85  |   })
  86  | }
  87  | 
  88  | async function expectMediaHealthy(locator: Locator, minHeight: number, minWidth: number) {
  89  |   await expect(locator).toBeVisible()
  90  |   const box = await locator.boundingBox()
  91  |   expect(box, 'media area missing box').not.toBeNull()
  92  |   expect(box!.height, 'media too small').toBeGreaterThanOrEqual(minHeight)
  93  |   expect(box!.width, 'media too narrow').toBeGreaterThanOrEqual(minWidth)
  94  | }
  95  | 
  96  | async function verifyCompact(page: Page) {
  97  |   const pane = page.locator('.nx-workspace-pane.is-view-deal_intelligence.is-width-25')
  98  |   await expect(pane).toBeVisible()
> 99  |   await expect(page.locator(compactRoot)).toBeVisible()
      |                                           ^ Error: expect(locator).toBeVisible() failed
  100 |   await expect(page.locator('.nx-deal-compact-summary')).toBeVisible()
  101 |   await expect(page.locator('.nx-property-hero-shell').first()).toBeVisible()
  102 |   await expectMediaHealthy(page.locator('.nx-property-hero__media').first(), 220, 220)
  103 |   await expectNoHorizontalOverflow(page, '.nx-workspace-pane.is-view-deal_intelligence.is-width-25')
  104 |   await screenshot(page, 'deal-intelligence-25')
  105 | }
  106 | 
  107 | async function verifyMedium(page: Page) {
  108 |   const pane = page.locator('.nx-workspace-pane.is-view-deal_intelligence.is-width-50')
  109 |   await expect(pane).toBeVisible()
  110 |   await expect(page.locator(mediumRoot)).toBeVisible()
  111 |   await expect(page.locator('.nx-deal-medium-header')).toBeVisible()
  112 |   await expect(page.locator('.nx-property-hero-shell').first()).toBeVisible()
  113 |   await expectMediaHealthy(page.locator('.nx-property-hero__media').first(), 280, 320)
  114 |   await expectNoHorizontalOverflow(page, '.nx-workspace-pane.is-view-deal_intelligence.is-width-50')
  115 |   await screenshot(page, 'deal-intelligence-50')
  116 | }
  117 | 
  118 | async function verifyExpanded(page: Page) {
  119 |   const pane = page.locator('.nx-workspace-pane.is-view-deal_intelligence.is-width-75')
  120 |   await expect(pane).toBeVisible()
  121 |   await expect(page.locator(expandedRoot)).toBeVisible()
  122 |   await expect(page.locator('.nx-command-header-strip')).toBeVisible()
  123 |   await expect(page.locator('.nx-property-hero__full-toggle')).toBeVisible()
  124 |   await expectMediaHealthy(page.locator('.nx-property-hero__full-stage').first(), 360, 620)
  125 |   const dock = page.locator('.nx-command-action-dock')
  126 |   await expect(dock).toBeVisible()
  127 |   const overlap = await page.evaluate(() => {
  128 |     const dockEl = document.querySelector('.nx-command-action-dock')
  129 |     const sellerGrid = document.querySelector('.nx-deal-command-dossier__seller-grid')
  130 |     if (!dockEl || !sellerGrid) return false
  131 |     const dockRect = dockEl.getBoundingClientRect()
  132 |     const sellerRect = sellerGrid.getBoundingClientRect()
  133 |     return sellerRect.bottom > dockRect.top && sellerRect.top < dockRect.bottom
  134 |   })
  135 |   expect(overlap, 'expanded dock overlaps seller grid').toBe(false)
  136 |   await expectNoHorizontalOverflow(page, '.nx-workspace-pane.is-view-deal_intelligence.is-width-75')
  137 |   await screenshot(page, 'deal-intelligence-75')
  138 | }
  139 | 
  140 | async function verifyFull(page: Page) {
  141 |   await expect(page.locator('.nx-deal-intelligence-fullscreen')).toBeVisible()
  142 |   await expect(page.locator(expandedRoot)).toBeVisible()
  143 |   await expect(page.locator('.nx-command-header-strip')).toBeVisible()
  144 |   await expect(page.locator('.nx-property-hero__full-toggle')).toBeVisible()
  145 |   await expect(page.getByRole('button', { name: 'Split' })).toBeVisible()
  146 |   await expect(page.getByRole('button', { name: 'Street' })).toBeVisible()
  147 |   await expect(page.getByRole('button', { name: 'Aerial' })).toBeVisible()
  148 |   await expectMediaHealthy(page.locator('.nx-property-hero__full-stage').first(), 420, 900)
  149 |   await expectNoHorizontalOverflow(page, '.nx-deal-intelligence-fullscreen')
  150 |   await screenshot(page, 'deal-intelligence-100')
  151 | }
  152 | 
  153 | test.describe('Deal Intelligence UI proof', () => {
  154 |   test('verifies 25/50/75/100 deal intelligence layouts', async ({ page }) => {
  155 |     await page.goto('/inbox', { waitUntil: 'networkidle' })
  156 |     await expect(page.locator('#nx-inbox-root')).toBeVisible()
  157 |     await expect(page.locator('.nx-intelligence-panel')).toBeVisible()
  158 | 
  159 |     await configureDealWidth(page, '25%')
  160 |     await verifyCompact(page)
  161 | 
  162 |     await configureDealWidth(page, '50%')
  163 |     await verifyMedium(page)
  164 | 
  165 |     await configureDealWidth(page, '75%')
  166 |     await verifyExpanded(page)
  167 | 
  168 |     await configureDealFull(page)
  169 |     await verifyFull(page)
  170 |   })
  171 | })
  172 | 
```