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

async function waitForCalendar(page: import('@playwright/test').Page) {
  await page.goto('/calendar')
  await page.waitForSelector('.nx-cal__command-bar', { timeout: 30000 })
  await page.waitForTimeout(1200)
}

test.describe('Calendar Nexus visual proof', () => {
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

    await setTheme(page, 'dark')
    await page.click('.nx-cal__view-tab:has-text("Week")')
    await page.waitForTimeout(600)
    await shot(page, '100-week-dark')

    await page.click('.nx-cal__view-tab:has-text("Day")')
    await page.waitForTimeout(600)
    await shot(page, '100-day-dark')

    await page.click('.nx-cal__view-tab:has-text("Agenda")')
    await page.waitForTimeout(600)
    await shot(page, '100-agenda-dark')

    await page.click('.nx-cal__view-tab:has-text("Timeline")')
    await page.waitForTimeout(600)
    await shot(page, '100-timeline-dark')

    await page.click('.nx-cal__view-tab:has-text("Month")')
    await page.click('button:has-text("Layers")')
    await page.waitForTimeout(400)
    await shot(page, '100-layers-popover')

    await page.keyboard.press('Escape')
    await page.click('.nx-cal__date-picker-trigger')
    await page.waitForTimeout(400)
    await shot(page, '100-date-picker')

    await page.keyboard.press('Escape')
    await page.click('button:has-text("New Event")')
    await page.waitForTimeout(400)
    await shot(page, '100-new-event-modal')
    await page.locator('.nx-cal__modal-backdrop').click({ position: { x: 10, y: 10 } })
    await page.waitForTimeout(300)

    const monthCells = await page.locator('.nx-cal__month-grid.is-true-month .nx-cal__month-cell').count()
    expect(monthCells).toBeGreaterThanOrEqual(35)

    await page.click('.nx-cal__view-tab:has-text("Week")')
    await page.waitForTimeout(400)
    const weekHeadersAfter = await page.locator('.nx-cal__week-col-head').count()
    expect(weekHeadersAfter).toBe(7)

    const hourLabels = await page.locator('.nx-cal__week-hour-label').count()
    expect(hourLabels).toBeGreaterThanOrEqual(10)

    const eventChip = page.locator('.nx-cal__month-event, .nx-cal__week-event, .nx-cal__agenda-row').first()
    if (await eventChip.count()) {
      await eventChip.click()
      await page.waitForTimeout(400)
      await shot(page, '100-event-drawer')
      await page.locator('.nx-cal__event-backdrop').click({ position: { x: 8, y: 8 } })
    }
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
  })

  test('50% width screenshots', async ({ page }) => {
    await page.setViewportSize({ width: 860, height: 900 })
    await waitForCalendar(page)
    await setTheme(page, 'dark')
    await shot(page, '50-month-dark')
    await page.click('.nx-cal__view-tab:has-text("Week")')
    await page.waitForTimeout(500)
    await shot(page, '50-week-dark')
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
      await page.keyboard.press('Escape')
    }

    await page.click('button:has-text("New Event")')
    await page.waitForTimeout(400)
    await shot(page, '25-new-event-modal')

    const mobileEvent = page.locator('.nx-cal__agenda-row').first()
    if (await mobileEvent.count()) {
      await page.locator('.nx-cal__modal-backdrop').click({ position: { x: 5, y: 5 } }).catch(() => {})
      await page.waitForTimeout(200)
      await mobileEvent.click()
      await page.waitForTimeout(400)
      await shot(page, '25-event-bottom-sheet')
    }
  })

  test('refresh state clears', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 })
    await waitForCalendar(page)

    await page.getByTestId('calendar-refresh').click()
    await page.waitForTimeout(400)

    const updatingBadges = await page.locator('.nx-cal__live-pill:has-text("Updating")').count()
    expect(updatingBadges).toBeLessThanOrEqual(1)

    await expect(page.locator('.nx-cal__live-pill')).not.toContainText('Updating', { timeout: 15000 })
    const statusText = await page.locator('.nx-cal__live-pill').textContent()
    expect(statusText?.match(/Live|Updated|Error/) ).toBeTruthy()
  })
})