import { expect, test, type Page } from '@playwright/test'

/**
 * THE MOBILE HOME CONTRACT.
 *
 * Home is the landing surface on a phone and an orchestration layer over every other
 * app, so these assertions pin the two things that make it trustworthy:
 *
 *   1. It is where a phone lands, inside the ordinary mobile shell.
 *   2. It never turns a failed read into a reassuring number. With every source
 *      down, each module says it is unavailable and the engine is not "operational".
 *
 * The API is stubbed at the network layer. The payloads below are TEST FIXTURES that
 * exercise rendering; nothing here ships in the product.
 */

const MOBILE = { width: 390, height: 844 }
test.use({ viewport: MOBILE, isMobile: true, hasTouch: true })

const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString()

const FIXTURES: Record<string, unknown> = {
  '/api/cockpit/inbox/live': {
    ok: true,
    threads: [
      { id: 'th-1', thread_key: 'th-1', property_id: 'p-1', owner_display_name: 'Marcus Hale', property_address_full: '4127 Ridgecrest Dr, Tulsa, OK', latest_message_body: 'If you can close in 3 weeks I would take 185.', latest_message_at: iso(4), latest_message_direction: 'inbound', status: 'unread', unread_count: 1, is_hot_lead: true, priority: 'urgent' },
      { id: 'th-2', thread_key: 'th-2', property_id: 'p-2', owner_display_name: 'Elena Park', property_address_full: '88 Juniper Ln, Dallas, TX', latest_message_body: 'Yes it is still available, what are you thinking?', latest_message_at: iso(22), latest_message_direction: 'inbound', status: 'unread', unread_count: 1 },
      { id: 'th-3', thread_key: 'th-3', property_id: 'p-3', owner_display_name: 'Tom Reyes', property_address_full: '901 W 5th St, Austin, TX', latest_message_body: 'Send me the offer in writing.', latest_message_at: iso(64), latest_message_direction: 'inbound', status: 'read' },
    ],
    counts: { new_replies: 17, priority: 5, needs_attention: 9 },
    mapPins: [
      { thread_key: 'th-1', latitude: 36.154, longitude: -95.993 },
      { thread_key: 'th-2', latitude: 32.777, longitude: -96.797 },
      { thread_key: 'th-3', latitude: 30.267, longitude: -97.743 },
      { thread_key: 'th-4', latitude: 35.149, longitude: -90.049 },
      { thread_key: 'th-5', latitude: 61.2, longitude: -149.9 },
    ],
    pagination: { cursor: null, nextCursor: null, hasMore: false, limit: 6 },
  },
  '/api/cockpit/queue/processor-health': {
    ok: true,
    status: 'warning',
    counts: { queued: 212, pending: 14, approval: 6, scheduled: 340, processing: 3, sentToday: 1284, deliveredToday: 1231, failedToday: 7, lagActive: 0, staleActive: 0 },
    latestSentAt: iso(1),
  },
  '/api/cockpit/ops/metrics': {
    ok: true,
    diagnostics: {
      sent_count: 1284, delivered_count: 1231, failed_count: 7, received_count: 98, reply_rate: 7.6, delivery_rate: 95.9,
      sender_performance: Array.from({ length: 12 }, (_, i) => ({ sender: `+1555000${i}`, sent_count: 100 - i })),
    },
  },
  '/api/cockpit/campaigns': {
    ok: true,
    campaigns: [
      { id: 'c-1', campaign_name: 'Tulsa absentee · wave 3', status: 'active', market_label: 'Tulsa, OK', total_targets: 2400, ready_targets: 610, sent_count: 1520, delivered_count: 1461, reply_count: 94, health_status: 'healthy' },
      { id: 'c-2', campaign_name: 'DFW tired landlords', status: 'active', market_label: 'Dallas, TX', total_targets: 1800, ready_targets: 0, sent_count: 1790, delivered_count: 1702, reply_count: 71, health_status: 'caution' },
      { id: 'c-3', campaign_name: 'Austin probate', status: 'paused', market_label: 'Austin, TX', total_targets: 600, ready_targets: 240, sent_count: 120, delivered_count: 118, reply_count: 9, health_status: 'healthy' },
    ],
  },
  '/api/cockpit/pipeline/counts': {
    ok: true,
    data: {
      active_opportunities: 342, offer_ready: 18, negotiating: 18, contract_sent: 4, under_contract: 3, closing: 2, follow_ups_due: 11, blocked: 2,
      by_acquisition_stage: { ownership_confirmation: 140, offer_interest: 82, asking_price: 51, property_condition: 38, offer: 18, formal_contract: 4, disposition: 1, under_contract: 3, prepared_to_close: 2, closed: 30 },
    },
  },
  '/api/cockpit/closing-desk/cases': { ok: true, data: [], total: 0 },
  '/api/cockpit/metrics/war-room': {
    ok: true,
    market_leaderboard: [
      { market: 'Dallas, TX', state: 'TX', sent: 4200, replied: 310, positive: 41, replyRate: 7.4 },
      { market: 'Tulsa, OK', state: 'OK', sent: 3100, replied: 250, positive: 33, replyRate: 8.1 },
      { market: 'Austin, TX', state: 'TX', sent: 1900, replied: 120, positive: 12, replyRate: 6.3 },
      { market: 'Memphis, TN', state: 'TN', sent: 1200, replied: 70, positive: 5, replyRate: 5.8 },
    ],
  },
  '/api/cockpit/calendar/events': {
    ok: true,
    events: [
      { event_id: 'e-1', event_type: 'seller_follow_up', tone: 'amber', title: 'Follow up with Marcus Hale', seller_name: 'Marcus Hale', property_address: '4127 Ridgecrest Dr', start_timestamp: iso(-90), thread_key: 'th-1', hot: true },
      { event_id: 'e-2', event_type: 'offer_follow_up', tone: 'purple', title: 'Offer response due', seller_name: 'Elena Park', property_address: '88 Juniper Ln', start_timestamp: iso(-240) },
      { event_id: 'e-3', event_type: 'manual_call', tone: 'blue', title: 'Call title company', seller_name: 'Unresolved event', start_timestamp: iso(120) },
      { event_id: 'e-4', event_type: 'contract_signature_deadline', tone: 'red', title: 'Signature deadline', seller_name: 'Tom Reyes', start_timestamp: iso(-60 * 26) },
      ...Array.from({ length: 12 }, (_, i) => ({ event_id: `s-${i}`, event_type: 'scheduled_sms', tone: 'cyan', title: 'Scheduled SMS', start_timestamp: iso(-30 - i) })),
      { event_id: 'h-1', event_type: 'sms_delivered', tone: 'green', title: 'Delivered', start_timestamp: iso(10) },
    ],
  },
  '/api/cockpit/notifications': {
    ok: true,
    notifications: [
      { id: 'n-1', domain: 'numbers', severity: 'warning', type: 'number_degraded', title: 'Sender +1 918 555 0142 degraded', body: 'Delivery fell to 71% over the last hour', status: 'unread', createdAt: iso(12), actions: [] },
      { id: 'n-2', domain: 'campaigns', severity: 'positive', type: 'campaign_resumed', title: 'Campaign resumed', body: 'Tulsa absentee · wave 3 is sending again', status: 'read', createdAt: iso(35), actions: [] },
    ],
    unreadCount: 1,
    total: 2,
  },
}

async function stubApi(page: Page, mode: 'live' | 'down') {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    if (mode === 'down') {
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'unavailable' }) })
    }
    const body = FIXTURES[url.pathname]
    if (!body) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'not_stubbed' }) })
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
}

test('a phone lands on Home inside the mobile shell', async ({ page }) => {
  await stubApi(page, 'live')
  await page.goto('/')
  await expect(page).toHaveURL(/\/home$/)
  await expect(page.locator('.nx-home-hello__title')).toContainText(/Good (morning|afternoon|evening)/)
  await expect(page.locator('.nx-mobile-command-dock')).toHaveCount(1)
  await expect(page.locator('.nx-pinned-app-dock')).toHaveCount(1)

  const focus = page.locator('section[aria-label="Focus"]')
  await expect(focus.locator('.nx-home-focus__item').first()).toBeVisible()
  await expect(page.locator('section[aria-label="Automation"]')).toContainText('Running with issues')
  await expect(page.locator('section[aria-label="Pipeline"] .nx-home-stage')).toHaveCount(5)

  // The map is the real Census outline (thousands of dots, not a sketch), with
  // live sparks only where coordinates were given in the lower 48.
  await expect(page.locator('.nx-home-usmap__base circle')).toHaveCount(2907)
  await expect(page.locator('.nx-home-spark')).toHaveCount(4)

  // The calendar lists work, rolls scheduled sends into one line, and never
  // lists a delivered SMS as something to do.
  const calendar = page.locator('section[aria-label="Calendar"]')
  await expect(calendar.locator('.nx-home-day')).toHaveCount(7)
  await expect(calendar).toContainText('12 messages scheduled', { timeout: 15_000 })
  await expect(calendar).not.toContainText('Delivered')
  await expect(calendar).not.toContainText('Unresolved')

  // Nothing on Home may scroll the page sideways at phone width.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)

  // The glass must survive the production CSS minifier on Chromium: a standard
  // declaration placed before its -webkit- twin is collapsed to the prefix only.
  const glass = await page.locator('section[aria-label="Inbox"]').evaluate((node) => getComputedStyle(node).backdropFilter)
  expect(glass).toContain('blur')

  // Let the entrance choreography land before capturing.
  await page.waitForTimeout(2500)
  await page.screenshot({ path: 'test-results/mobile-home/home-top.png' })
  await page.locator('.nx-home__scroll').evaluate((node) => node.scrollTo(0, node.scrollHeight / 2))
  await page.waitForTimeout(700)
  await page.screenshot({ path: 'test-results/mobile-home/home-middle.png' })
  await page.locator('.nx-home__scroll').evaluate((node) => node.scrollTo(0, node.scrollHeight))
  await page.waitForTimeout(700)
  await page.screenshot({ path: 'test-results/mobile-home/home-bottom.png' })
})

test('a failed read is unavailable, never a reassuring zero', async ({ page }) => {
  await stubApi(page, 'down')
  await page.goto('/home')
  await expect(page.locator('.nx-home-hello__title')).toBeVisible()
  await expect(page.locator('section[aria-label="Automation"]')).toContainText('Engine status unavailable', { timeout: 20_000 })
  await expect(page.locator('section[aria-label="Automation"]')).not.toContainText('operational')
  await expect(page.locator('section[aria-label="Pipeline"]')).toContainText('Pipeline unavailable')
  await expect(page.locator('section[aria-label="Deals"]')).toContainText('unavailable')
  await expect(page.locator('section[aria-label="Calendar"]')).toContainText('Calendar unavailable', { timeout: 20_000 })
  await expect(page.locator('section[aria-label="Focus"]')).not.toContainText("You're clear")
  await page.waitForTimeout(1500)
  await page.screenshot({ path: 'test-results/mobile-home/home-down.png' })
})

test('customize hides a module and the choice persists', async ({ page }) => {
  await stubApi(page, 'live')
  await page.goto('/home')
  await page.getByRole('button', { name: 'Customize Home' }).click()
  await page.getByRole('switch', { name: 'Market signals visible' }).click()
  await page.screenshot({ path: 'test-results/mobile-home/home-customize.png' })
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.locator('section[aria-label="Market signals"]')).toHaveCount(0)
  await page.reload()
  await expect(page.locator('.nx-home-hello__title')).toBeVisible()
  await expect(page.locator('section[aria-label="Market signals"]')).toHaveCount(0)
})

test('the launcher offers Home and never Property Intelligence OS', async ({ page }) => {
  await stubApi(page, 'live')
  await page.goto('/home')
  await page.getByRole('button', { name: 'Home — open applications' }).click()
  const launcher = page.getByRole('dialog', { name: 'Applications' })
  await expect(launcher).toBeVisible()
  await expect(launcher.getByRole('button', { name: /^Home/ })).toBeVisible()
  await expect(launcher.getByRole('button', { name: /^Properties/ })).toHaveCount(0)
})
