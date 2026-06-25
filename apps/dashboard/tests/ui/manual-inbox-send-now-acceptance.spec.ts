import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'

const OUT_DIR = path.resolve('proof/inbox')
fs.mkdirSync(OUT_DIR, { recursive: true })

const threadRow = (page: import('@playwright/test').Page) =>
  page.locator('[data-thread-id], .nx-thread-card-rebuilt, .nx-thread-row')

test.describe('Manual inbox send now schema fix', () => {
  test('authenticated manual send succeeds without queue_insert_failure', async ({ page }) => {
    const proofSessionId = `ui-manual-send-${Date.now()}`
    const messageBody = `UI schema proof ${proofSessionId.slice(-8)}`
    let sendNowResponse: Record<string, unknown> | null = null

    page.on('response', async (res) => {
      if (!res.url().includes('/api/cockpit/inbox/send-now')) return
      try {
        sendNowResponse = await res.json()
      } catch {
        sendNowResponse = { parse_error: true, status: res.status() }
      }
    })

    await page.goto('/inbox', { waitUntil: 'domcontentloaded' })
    await expect.poll(async () => threadRow(page).count(), { timeout: 30_000 }).toBeGreaterThan(0)

    await threadRow(page).first().click()
    await expect(page.locator('.nx-composer-dock__input-wrap textarea, .nx-composer textarea').first()).toBeVisible({
      timeout: 10_000,
    })

    const composer = page.locator('.nx-composer-dock__input-wrap textarea, .nx-composer textarea').first()
    await composer.fill(messageBody)
    await page.locator('.nx-send-button').click()

    await expect.poll(async () => sendNowResponse !== null, { timeout: 30_000 }).toBe(true)

    expect(sendNowResponse?.ok, JSON.stringify(sendNowResponse)).toBe(true)
    expect(String(sendNowResponse?.reason || sendNowResponse?.error || '').toLowerCase()).not.toBe(
      'queue_insert_failure'
    )
    expect(sendNowResponse?.queue_row_id || sendNowResponse?.queue_audit_id).toBeTruthy()
    expect(sendNowResponse?.provider_message_id || sendNowResponse?.provider_message_sid).toBeTruthy()

    await expect
      .poll(async () => {
        const outbound = page.locator('.nx-message, .nx-chat-message, [class*="message-bubble"]').filter({
          hasText: messageBody,
        })
        return outbound.count()
      }, { timeout: 20_000 })
      .toBeGreaterThan(0)

    const statusBadge = page
      .locator('.nx-thread-card-rebuilt__metadata, .nx-message, .nx-chat-message')
      .filter({ hasText: /Sent|Delivered/i })
      .first()
    if (await statusBadge.count()) {
      await expect(statusBadge).toBeVisible()
    }

    const result = {
      status: 'MANUAL_INBOX_SEND_NOW_UI_PASS',
      proofSessionId,
      sendNowResponse,
    }
    fs.writeFileSync(path.join(OUT_DIR, 'manual-send-now-ui-proof.json'), JSON.stringify(result, null, 2))
  })
})