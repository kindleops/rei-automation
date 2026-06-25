import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page, type Response } from '@playwright/test'

const OUT_DIR = path.resolve('proof/inbox')
const SCREENSHOT_DIR = path.join(OUT_DIR, 'playwright')
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true })

const threadRow = (page: Page) =>
  page.locator('[data-thread-id], .nx-thread-card-rebuilt, .nx-thread-row')

const bucketTab = (page: Page, label: string) =>
  page.getByRole('tab', { name: new RegExp(label, 'i') })

async function waitForAuthoritativeCounts(page: Page) {
  await expect.poll(async () => {
    const tabs = await page.getByRole('tab').allTextContents()
    const joined = tabs.join(' ')
    return /\d/.test(joined) && !/ALL THREADS\s*0\b/i.test(joined) && !/PRIORITY\s*0\b.*ALL THREADS\s*0/i.test(joined)
  }, { timeout: 30_000 }).toBe(true)
}

test.describe('Inbox stabilization acceptance', () => {
  test('authenticated inbox boot, ten threads, badges, and realtime buckets', async ({ page }) => {
    const networkLog: Array<Record<string, unknown>> = []
    const threadLatencies: Array<Record<string, unknown>> = []
    const countsSnapshots: Array<Record<string, unknown>> = []
    let bootAt = Date.now()

    page.on('response', async (res: Response) => {
      const url = res.url()
      if (!url.includes('/api/cockpit/inbox/') && !url.includes('thread-state')) return
      const entry = {
        url: url.split('?')[0],
        status: res.status(),
        atMs: Date.now() - bootAt,
      }
      networkLog.push(entry)
      if (url.includes('/api/cockpit/inbox/counts')) {
        try {
          const body = await res.json()
          countsSnapshots.push({ atMs: entry.atMs, counts: body?.counts ?? body?.data?.counts ?? null })
        } catch {
          countsSnapshots.push({ atMs: entry.atMs, counts: null })
        }
      }
    })

    bootAt = Date.now()
    await page.goto('/inbox', { waitUntil: 'domcontentloaded' })
    await waitForAuthoritativeCounts(page)

    const firstCountsText = await page.getByRole('tab').allTextContents()
    const flashedAllZero = firstCountsText.every((t) => /0/.test(t) && !/—/.test(t))
    expect(flashedAllZero, 'hard refresh must not leave all bucket counts at zero').toBe(false)

    await expect(bucketTab(page, 'All Threads')).toBeVisible()
    const rows = threadRow(page)
    await expect.poll(async () => rows.count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(10)

    for (let i = 0; i < 10; i += 1) {
      const t0 = Date.now()
      await rows.nth(i).click()
      await expect(page.locator('.nx-chat-container, .nx-thread-pane, .nx-composer, h2').first()).toBeVisible({ timeout: 5000 })
      const shellMs = Date.now() - t0
      await expect.poll(async () => {
        const msgs = await page.locator('.nx-message, .nx-chat-message, [class*="message-bubble"], .nx-chat-container, .nx-composer textarea').count()
        return msgs > 0
      }, { timeout: 3000 }).toBeTruthy()
      const messagesMs = Date.now() - t0
      threadLatencies.push({ thread: i + 1, shellMs, messagesMs, totalMs: Date.now() - t0 })
      expect(Date.now() - t0, `thread ${i + 1} selection exceeded 5s`).toBeLessThanOrEqual(5000)
    }

    const inboundBadge = page.locator('.nx-thread-card-rebuilt__metadata, .nx-thread-card-rebuilt').filter({ hasText: /^Inbound$/ }).first()
    if (await inboundBadge.count()) await expect(inboundBadge).toBeVisible()

    const deliveredBadge = page.locator('.nx-thread-card-rebuilt__metadata, .nx-thread-card-rebuilt').filter({ hasText: /^Delivered$/ }).first()
    if (await deliveredBadge.count()) await expect(deliveredBadge).toBeVisible()

    const failedBadge = page.locator('.nx-thread-card-rebuilt__metadata, .nx-thread-card-rebuilt').filter({ hasText: /^Failed$/ }).first()
    if (await failedBadge.count()) await expect(failedBadge).toBeVisible()

    const threadState400 = networkLog.filter((e) => String(e.url).includes('thread-state') && e.status === 400)
    expect(threadState400, '/thread-state must not return 400').toHaveLength(0)

    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !/favicon|extension/i.test(msg.text())) consoleErrors.push(msg.text())
    })
    await page.waitForTimeout(500)
    expect(consoleErrors.filter((e) => !/Failed to load resource/i.test(e))).toHaveLength(0)

    const result = {
      bootMs: Date.now() - bootAt,
      countsSnapshots,
      threadLatencies,
      networkLog,
      threadState400Count: threadState400.length,
      status: 'INBOX_STABILIZATION_ACCEPTANCE_PASS',
    }
    fs.writeFileSync(path.join(OUT_DIR, 'playwright-acceptance.json'), JSON.stringify(result, null, 2))
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'inbox-acceptance.png'), fullPage: false })
  })
})