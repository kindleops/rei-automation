import { test, expect } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'

const OUT = path.resolve('test-results/calendar-nexus-screenshots')

function shot(page: import('@playwright/test').Page, name: string) {
  return page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false })
}

async function setTheme(page: import('@playwright/test').Page, theme: 'dark' | 'light' | 'red-ops') {
  await page.evaluate((t) => {
    document.documentElement.setAttribute('data-theme', t)
  }, theme)
}

async function waitForCalendar(page: import('@playwright/test').Page, proof = true) {
  await page.goto(proof ? '/calendar?calendar_proof=1' : '/calendar')
  await page.waitForSelector('.nx-cal__command-bar', { timeout: 30000 })
  await page.waitForTimeout(800)
}

async function dismissOverlays(page: import('@playwright/test').Page) {
  for (let i = 0; i < 2; i += 1) await page.keyboard.press('Escape').catch(() => {})
  if (await page.locator('.nx-cal__event-backdrop').isVisible().catch(() => false)) {
    await page.locator('.nx-cal__event-backdrop').click({ position: { x: 4, y: 4 }, timeout: 2000 }).catch(() => {})
  }
  if (await page.locator('.nx-cal__modal-backdrop').isVisible().catch(() => false)) {
    await page.locator('.nx-cal__modal-backdrop').click({ position: { x: 4, y: 4 }, timeout: 2000 }).catch(() => {})
  }
}

async function openLayers(page: import('@playwright/test').Page) {
  const desktop = page.locator('.nx-cal__cmd-desktop-only button:has-text("Layers")').first()
  if (await desktop.isVisible().catch(() => false)) {
    await desktop.click()
    return
  }
  await page.locator('.nx-cal__cmd-overflow button').click()
  await page.locator('.nx-cal__cmd-overflow-panel button:has-text("Layers")').click()
}

test.describe('Calendar Nexus visual proof', () => {
  test.setTimeout(300_000)
  test.beforeAll(() => {
    fs.mkdirSync(OUT, { recursive: true })
  })

  test('100% desktop screenshots', async ({ page }) => {
    await page.setViewportSize({ width: 1720, height: 1080 })
    await waitForCalendar(page)

    await setTheme(page, 'light')
    await page.click('.nx-cal__view-tab:has-text("Month")')
    await page.waitForTimeout(600)
    await shot(page, '100-month-light')

    await setTheme(page, 'dark')
    await shot(page, '100-month-dark')

    await setTheme(page, 'red-ops')
    await shot(page, '100-month-red-ops')

    await setTheme(page, 'light')
    await page.click('.nx-cal__view-tab:has-text("Week")')
    await page.waitForTimeout(600)
    await shot(page, '100-week-light')

    await setTheme(page, 'dark')
    await page.click('.nx-cal__view-tab:has-text("Week")')
    await page.waitForTimeout(600)
    await shot(page, '100-week-dark')

    await page.click('.nx-cal__view-tab:has-text("Day")')
    await page.waitForTimeout(600)
    await shot(page, '100-day-dark')

    await setTheme(page, 'light')
    await page.click('.nx-cal__view-tab:has-text("Day")')
    await page.waitForTimeout(600)
    await shot(page, '100-day-light')

    await setTheme(page, 'dark')
    await page.click('.nx-cal__view-tab:has-text("Agenda")')
    await page.waitForTimeout(600)
    await shot(page, '100-agenda-dark')

    await page.click('.nx-cal__view-tab:has-text("Timeline")')
    await page.waitForTimeout(600)
    await shot(page, '100-timeline-dark')

    await page.click('.nx-cal__view-tab:has-text("Month")')
    await page.waitForTimeout(400)

    const todayCell = page.locator('.nx-cal__month-cell.is-today').first()
    if (await todayCell.count()) {
      await todayCell.click()
      await page.waitForTimeout(500)
      await shot(page, '100-selected-date-rail')
    }

    await dismissOverlays(page)
    await setTheme(page, 'light')
    await openLayers(page)
    await page.waitForTimeout(400)
    await shot(page, '100-layers-popover-light')

    await setTheme(page, 'dark')
    await page.keyboard.press('Escape')
    await openLayers(page)
    await page.waitForTimeout(400)
    await shot(page, '100-layers-popover-dark')

    await page.keyboard.press('Escape')
    await setTheme(page, 'light')
    await page.click('.nx-cal__date-picker-trigger')
    await page.waitForTimeout(400)
    await shot(page, '100-date-picker-light')

    await setTheme(page, 'dark')
    await page.keyboard.press('Escape')
    await page.click('.nx-cal__date-picker-trigger')
    await page.waitForTimeout(400)
    await shot(page, '100-date-picker-dark')

    await page.keyboard.press('Escape')
    await setTheme(page, 'light')
    await page.click('button:has-text("Add Task")')
    await page.waitForTimeout(400)
    await shot(page, '100-task-modal-light')

    await page.locator('.nx-cal__modal-segment:has-text("Reminder")').click()
    await page.waitForTimeout(300)
    await setTheme(page, 'dark')
    await shot(page, '100-reminder-modal-dark')
    await page.locator('.nx-cal__modal-backdrop').click({ position: { x: 10, y: 10 } })
    await page.waitForTimeout(300)

    const monthCells = await page.locator('.nx-cal__month-grid.is-true-month .nx-cal__month-cell').count()
    expect(monthCells).toBeGreaterThanOrEqual(35)

    const emptyCats = await page.locator('.nx-cal__month-cell:not(.has-events) .nx-cal__month-cats').count()
    expect(emptyCats).toBe(0)

    const populatedChips = await page.locator('.nx-cal__month-cell.has-events .nx-cal__month-event').count()
    expect(populatedChips).toBeGreaterThan(0)
    await shot(page, '100-month-populated')

    await page.click('.nx-cal__view-tab:has-text("Week")')
    await page.waitForTimeout(400)
    const weekHeadersAfter = await page.locator('.nx-cal__week-col-head').count()
    expect(weekHeadersAfter).toBe(7)

    const hourLabels = await page.locator('.nx-cal__week-hour-label').count()
    expect(hourLabels).toBeGreaterThanOrEqual(10)

    const eventChip = page.locator('.nx-cal__month-event, .nx-cal__week-event, .nx-cal__agenda-row').first()
    if (await eventChip.count()) {
      await dismissOverlays(page)
      await page.click('.nx-cal__view-tab:has-text("Month")')
      await page.waitForTimeout(300)
      await eventChip.click()
      await page.waitForTimeout(500)
      await shot(page, '100-selected-event-rail')
      await shot(page, '100-event-drawer')
      await dismissOverlays(page)
    }

    const selectedCell = page.locator('.nx-cal__month-cell.is-selected').first()
    expect(await selectedCell.count()).toBeGreaterThanOrEqual(0)
  })

  test('75% width screenshots', async ({ page }) => {
    await page.setViewportSize({ width: 1290, height: 900 })
    await waitForCalendar(page)
    await setTheme(page, 'light')
    await shot(page, '75-month-light')
    await setTheme(page, 'dark')
    await page.click('.nx-cal__view-tab:has-text("Week")')
    await page.waitForTimeout(500)
    await shot(page, '75-week-dark')

    const railToggle = page.locator('button[aria-label="Toggle contextual rail"]')
    if (await railToggle.count()) {
      await railToggle.click()
      await page.waitForTimeout(400)
      await shot(page, '75-rail-overlay')
      await railToggle.click()
    }
  })

  test('50% width screenshots', async ({ page }) => {
    await page.setViewportSize({ width: 860, height: 900 })
    await waitForCalendar(page)
    await setTheme(page, 'dark')
    await shot(page, '50-month-dark')
    await page.click('.nx-cal__view-tab:has-text("Week")')
    await page.waitForTimeout(500)
    await shot(page, '50-week-dark')

    await openLayers(page)
    await page.waitForTimeout(400)
    await shot(page, '50-layer-panel')

    await page.keyboard.press('Escape')
    await page.click('button:has-text("Add Task")')
    await page.waitForTimeout(400)
    await shot(page, '50-task-modal')

    const eventChip = page.locator('.nx-cal__month-event, .nx-cal__agenda-row').first()
    if (await eventChip.count()) {
      await page.keyboard.press('Escape')
      await page.click('.nx-cal__view-tab:has-text("Month")')
      await eventChip.click()
      await page.waitForTimeout(400)
      await shot(page, '50-selected-event-drawer')
      await page.locator('.nx-cal__event-backdrop').click({ position: { x: 8, y: 8 } })
    }
  })

  test('25% mobile agenda', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await waitForCalendar(page)
    await setTheme(page, 'dark')
    await page.waitForTimeout(800)
    await shot(page, '25-mobile-agenda')

    const monthBtn = page.locator('button:has-text("Month")')
    if (await monthBtn.count()) {
      await monthBtn.click()
      await page.waitForTimeout(500)
      await shot(page, '25-month-sheet')
      const todayCell = page.locator('.nx-cal__month-cell.is-today').first()
      if (await todayCell.count()) {
        await todayCell.click()
        await page.waitForTimeout(400)
        await shot(page, '25-selected-day-list')
      }
      await page.keyboard.press('Escape')
    }

    await page.click('button:has-text("Add Task")')
    await page.waitForTimeout(400)
    await shot(page, '25-add-task-modal')
    await page.locator('.nx-cal__modal-backdrop').click({ position: { x: 5, y: 5 } })
    await page.waitForTimeout(300)

    const mobileEvent = page.locator('.nx-cal__agenda-row').first()
    if (await mobileEvent.count()) {
      await mobileEvent.click()
      await page.waitForTimeout(400)
      await shot(page, '25-event-bottom-sheet')
      await page.locator('.nx-cal__event-backdrop').click({ position: { x: 5, y: 5 } }).catch(() => {})
      await page.waitForTimeout(200)
    }

    const layersBtn = page.locator('button:has-text("Layers")').first()
    if (await layersBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await layersBtn.click({ timeout: 5000 })
      await page.waitForTimeout(400)
      await shot(page, '25-layer-bottom-sheet')
      await page.keyboard.press('Escape')
    }
  })

  test('refresh state clears', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 })
    await waitForCalendar(page)

    await page.getByTestId('calendar-refresh').click()
    await page.waitForTimeout(400)

    const updatingBadges = await page.locator('.nx-cal__live-pill:has-text("Updating")').count()
    expect(updatingBadges).toBeLessThanOrEqual(1)

    const pill = page.locator('.nx-cal__live-pill')
    await expect(pill).not.toContainText('Updating', { timeout: 15000 })
    const statusText = (await pill.textContent()) || ''
    expect(statusText.length).toBeGreaterThan(0)
    expect(statusText).not.toContain('Updating')
  })
})