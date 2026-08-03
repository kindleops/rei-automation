/**
 * N.2 canonical control runtime verification.
 *
 * Every network dependency is intercepted. The state mutation route below is an in-memory
 * authoritative row store, not production Supabase or the live API. The fixture records
 * redacted request/response evidence so the browser proof can be audited without exposing
 * seller data or full phone numbers.
 */
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page, type Route } from '@playwright/test'

const OUT_DIR = path.resolve('proof/deal-desk-n2')
fs.mkdirSync(OUT_DIR, { recursive: true })

type Row = Record<string, unknown> & { id: string; thread_key: string }
type PatchRecord = { request: Record<string, unknown>; response: Record<string, unknown>; status: number }

const rows: Row[] = [
  {
    id: 'n2-normal', thread_key: '+19015551001', canonical_e164: '+19015551001',
    property_id: 'prop-normal', prospect_id: 'prospect-normal', master_owner_id: 'owner-normal',
    seller_name: 'Fixture Seller Normal', property_address_full: '100 Fixture Street',
    latest_message_body: 'Synthetic fixture message', latest_message_at: '2026-08-03T12:00:00.000Z',
    inbox_bucket: 'all_conversations', unread_count: 1, is_read: false, is_archived: false,
    lifecycle_stage: 'ownership_confirmation', operational_status: 'not_contacted', lead_temperature: 'cold',
    automation_state: 'running', autopilot_mode: 'running', automation_status: 'waiting', queue_status: 'waiting',
    manual_stage_lock: false, is_suppressed: false, contactability_status: 'contactable',
  },
  {
    id: 'n2-suppressed', thread_key: '+19015551002', canonical_e164: '+19015551002',
    property_id: 'prop-suppressed', prospect_id: 'prospect-suppressed', master_owner_id: 'owner-suppressed',
    seller_name: 'Fixture Seller Suppressed', property_address_full: '200 Fixture Street',
    latest_message_body: 'Synthetic suppressed fixture', latest_message_at: '2026-08-03T12:01:00.000Z',
    inbox_bucket: 'all_conversations', unread_count: 0, is_read: true, is_archived: false,
    lifecycle_stage: 'offer_interest', operational_status: 'paused', lead_temperature: 'warm',
    automation_state: 'paused', autopilot_mode: 'paused', automation_status: 'suppressed', queue_status: 'suppressed',
    manual_stage_lock: true, is_suppressed: true, contactability_status: 'suppressed',
  },
  {
    id: 'n2-terminal', thread_key: '+19015551003', canonical_e164: '+19015551003',
    property_id: 'prop-terminal', prospect_id: 'prospect-terminal', master_owner_id: 'owner-terminal',
    seller_name: 'Fixture Seller Terminal', property_address_full: '300 Fixture Street',
    latest_message_body: 'Synthetic terminal fixture', latest_message_at: '2026-08-03T12:02:00.000Z',
    inbox_bucket: 'all_conversations', unread_count: 0, is_read: true, is_archived: false,
    lifecycle_stage: 'offer', operational_status: 'paused', lead_temperature: 'hot',
    automation_state: 'paused', autopilot_mode: 'paused', automation_status: 'completed', queue_status: 'completed',
    manual_stage_lock: false, is_suppressed: false, contactability_status: 'contactable',
  },
  {
    id: 'n2-unwritable', thread_key: 'ct:prospect:unwritable|property:prop-unwritable',
    conversation_thread_id: 'ct:prospect:unwritable|property:prop-unwritable',
    canonical_e164: null, property_id: 'prop-unwritable', prospect_id: 'prospect-unwritable',
    master_owner_id: 'owner-unwritable', seller_name: 'Fixture Seller Unwritable',
    property_address_full: '400 Fixture Street', latest_message_body: 'Synthetic no-route fixture',
    latest_message_at: '2026-08-03T12:03:00.000Z', inbox_bucket: 'all_conversations', unread_count: 1,
    is_read: false, is_archived: false, lifecycle_stage: 'ownership_confirmation',
    operational_status: 'not_contacted', lead_temperature: 'unscored', automation_state: 'manual',
    autopilot_mode: 'manual', automation_status: 'manual_review', queue_status: 'manual_review',
    manual_stage_lock: false, is_suppressed: false, contactability_status: 'contactable',
  },
]

const state = new Map(rows.map((row) => [row.thread_key, { ...row }]))
const scenario: {
  failField: string | null
  delays: Record<string, number>
  authoritativeOverride: Record<string, unknown>
  patchLog: PatchRecord[]
} = { failField: null, delays: {}, authoritativeOverride: {}, patchLog: [] }

const reset = () => {
  state.clear()
  for (const row of rows) state.set(row.thread_key, { ...row })
  scenario.failField = null
  scenario.delays = {}
  scenario.authoritativeOverride = {}
  scenario.patchLog = []
}

const json = async (route: Route, body: unknown, status = 200, delay = 0) => {
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

const STUB_USER = {
  id: '00000000-0000-4000-8000-000000000002', aud: 'authenticated', role: 'authenticated',
  email: 'n2-fixture@localhost.invalid', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00.000Z',
}
const STUB_SESSION = {
  access_token: 'n2-fixture-access-token', refresh_token: 'n2-fixture-refresh-token', token_type: 'bearer',
  expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: STUB_USER,
}

async function installFixtures(page: Page) {
  await page.addInitScript((session) => {
    ;(window as Window & { __DEAL_DESK_PROOF_ENABLED__?: boolean }).__DEAL_DESK_PROOF_ENABLED__ = true
    try {
      window.localStorage.setItem('sb-127-auth-token', JSON.stringify({ currentSession: session, expiresAt: session.expires_at }))
    } catch { /* route stubs still cover auth */ }
  }, STUB_SESSION)

  // Broad local-only guards are registered first; Playwright routes resolve newest first.
  await page.route('**://*.supabase.co/**', (route) => route.abort())
  await page.route('**://*.textgrid.com/**', (route) => route.abort())
  await page.route('**://*.vercel.app/**', (route) => route.abort())
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
  await page.route('**://maps.googleapis.com/**', (route) => route.fulfill({ status: 200, contentType: 'image/gif', body: gif }))
  await page.route('**://maps.gstatic.com/**', (route) => route.fulfill({ status: 200, contentType: 'image/gif', body: gif }))
  await page.route('**://*.google.com/maps/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>stub</title>' }))

  await page.route('**/_supabase_stub/auth/v1/user**', (route) => json(route, STUB_USER))
  await page.route('**/_supabase_stub/auth/v1/token**', (route) => json(route, STUB_SESSION))
  await page.route('**/_supabase_stub/auth/v1/**', (route) => json(route, { data: { session: STUB_SESSION, user: STUB_USER } }))
  await page.route('**/_supabase_stub/realtime/**', (route) => route.abort())
  await page.route('**/_supabase_stub/rest/**', (route) => json(route, []))

  await page.route('**/api/cockpit/**', (route) => json(route, { ok: true, data: null }))
  await page.route('**/api/internal/**', (route) => json(route, { ok: true, data: null }))

  await page.route('**/api/cockpit/inbox/live**', (route) => json(route, {
    ok: true,
    threads: [...state.values()],
    total_count: state.size,
    has_more: false,
    next_cursor: null,
    data_mode: 'fixture',
  }))
  await page.route('**/api/cockpit/inbox/counts**', (route) => json(route, { ok: true, counts: { all_conversations: state.size } }))
  await page.route('**/api/cockpit/inbox/thread-messages**', (route) => json(route, {
    ok: true,
    messages: [{ id: 'fixture-message', direction: 'inbound', body: 'Synthetic fixture message', created_at: '2026-08-03T12:00:00.000Z' }],
    pagination: { has_more: false },
  }))
  await page.route('**/api/cockpit/inbox/thread-hydration**', (route) => json(route, { ok: true, messages: [], pagination: { has_more: false }, deal_context: null, intelligence: null }))
  await page.route('**/api/cockpit/inbox/thread-dossier**', (route) => json(route, { ok: true, data: { property_id: 'fixture-property' } }))
  await page.route('**/api/internal/inbox/thread-context**', (route) => json(route, { ok: true, context: null }))
  await page.route('**/api/cockpit/inbox/property-participants**', (route) => json(route, { ok: true, participants: [], next_eligible_contact: null }))
  await page.route('**/valuation-snapshot**', (route) => json(route, { ok: true, data: {} }))

  await page.route('**/api/cockpit/lead-state/patch**', async (route) => {
    const request = JSON.parse(route.request().postData() || '{}') as Record<string, unknown>
    const threadKey = String(request.thread_key || '')
    const patch = (request.patch && typeof request.patch === 'object' ? request.patch : {}) as Record<string, unknown>
    const previous = { ...(state.get(threadKey) || {}) }
    const field = Object.keys(patch)[0] || 'unknown'
    const redactedRequest = { thread: threadKey ? `…${threadKey.slice(-4)}` : 'missing', patch: { ...patch } }

    if (scenario.failField && Object.hasOwn(patch, scenario.failField)) {
      const response = { ok: false, error: 'N2_FIXTURE_FAILURE', message: `Forced ${scenario.failField} failure`, upstream: { previous } }
      scenario.patchLog.push({ request: redactedRequest, response, status: 500 })
      return json(route, response, 500, 250)
    }

    // Apply immediately, then delay the response. Rapid requests therefore persist in
    // operator order while responses may arrive in reverse order.
    const next = { ...previous, ...patch, ...scenario.authoritativeOverride }
    if (Object.hasOwn(patch, 'automation_state')) next.autopilot_mode = patch.automation_state
    state.set(threadKey, next as Row)
    const response = { ok: true, threadKey, errorMessage: null, row: next }
    scenario.patchLog.push({ request: redactedRequest, response: { ok: true, row: { ...next, thread_key: `…${threadKey.slice(-4)}` } }, status: 200 })
    return json(route, response, 200, scenario.delays[`${field}:${String(patch[field])}`] || scenario.delays[field] || 0)
  })
}

const rowsLocator = (page: Page) => page.locator('[data-thread-id], .nx-thread-card-rebuilt, .nx-thread-row')
const bar = (page: Page) => page.locator('[data-canonical-thread-state-bar]')
const controlButton = (page: Page, field: string) => bar(page).locator(`[data-canonical-field="${field}"] button`).first()

async function choose(page: Page, field: string, option: string) {
  await controlButton(page, field).click()
  const listbox = page.getByRole('listbox').last()
  await expect(listbox).toBeVisible()
  await listbox.getByRole('option', { name: new RegExp(option, 'i') }).click()
}

async function chooseStage(page: Page, option: string) {
  await choose(page, 'lifecycle_stage', option)
  await expect(page.getByRole('dialog', { name: /Confirm Stage Change/i })).toBeVisible()
  await page.getByRole('button', { name: 'Change Stage Only' }).click()
}

async function selectRow(page: Page, index: number) {
  const rowsUi = rowsLocator(page)
  await expect(rowsUi.nth(index)).toBeVisible()
  await rowsUi.nth(index).click()
  await expect(bar(page)).toBeVisible()
}

function patchCount(field: string): number {
  return scenario.patchLog.filter((entry) => Object.hasOwn((entry.request.patch || {}) as object, field)).length
}

test.describe('N.2 canonical Deal Desk controls (isolated fixture)', () => {
  test.setTimeout(240_000)

  test.beforeEach(async ({ page }) => {
    reset()
    await installFixtures(page)
    await page.goto('/inbox', { waitUntil: 'domcontentloaded' })
    await expect(rowsLocator(page).first()).toBeVisible({ timeout: 30_000 })
    await selectRow(page, 0)
  })

  test('success, authoritative reconciliation, rollback, rapid writes, polling and mirrors', async ({ page }) => {
    const consoleErrors: string[] = []
    const failedRequests: string[] = []
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
    page.on('requestfailed', (request) => failedRequests.push(`${request.method()} ${new URL(request.url()).pathname}`))

    // Stage success and authoritative response.
    await chooseStage(page, 'S2 Interest Probe')
    await expect(controlButton(page, 'lifecycle_stage')).toContainText('S2 Interest Probe')
    expect(patchCount('lifecycle_stage')).toBe(1)

    // Stage failure rolls visibly back.
    scenario.failField = 'lifecycle_stage'
    await chooseStage(page, 'S3 Asking Price')
    await expect(controlButton(page, 'lifecycle_stage')).toContainText('S2 Interest Probe')
    await expect(bar(page).getByRole('alert')).toContainText('Forced lifecycle_stage failure')
    expect(patchCount('lifecycle_stage')).toBe(2)
    scenario.failField = null

    // Status success where the authoritative row intentionally differs from the request.
    scenario.authoritativeOverride = { operational_status: 'waiting_on_seller' }
    await choose(page, 'operational_status', 'Active Communication')
    await expect(controlButton(page, 'operational_status')).toContainText('Waiting on Seller')
    expect(patchCount('operational_status')).toBe(1)
    scenario.authoritativeOverride = {}

    // Status failure rolls back.
    scenario.failField = 'operational_status'
    await choose(page, 'operational_status', 'Follow-Up Due')
    await expect(controlButton(page, 'operational_status')).toContainText('Waiting on Seller')
    scenario.failField = null

    // Rapid cold -> warm -> hot with reverse response order. The final operator choice wins.
    scenario.delays = {
      'lead_temperature:cold': 700,
      'lead_temperature:warm': 450,
      'lead_temperature:hot': 100,
    }
    await choose(page, 'lead_temperature', 'Cold')
    await choose(page, 'lead_temperature', 'Warm')
    await choose(page, 'lead_temperature', 'Hot')
    await expect(controlButton(page, 'lead_temperature')).toContainText('Hot')
    await page.waitForTimeout(900)
    await expect(controlButton(page, 'lead_temperature')).toContainText('Hot')
    expect(state.get('+19015551001')?.lead_temperature).toBe('hot')
    expect(patchCount('lead_temperature')).toBe(3)
    scenario.delays = {}

    // Failure rollback for temperature.
    scenario.failField = 'lead_temperature'
    await choose(page, 'lead_temperature', 'Warm')
    await expect(controlButton(page, 'lead_temperature')).toContainText('Hot')
    scenario.failField = null

    // Pause, resume, and human control all write automation_state only.
    await choose(page, 'automation_state', 'Paused')
    await expect(controlButton(page, 'automation_state')).toContainText('Paused')
    await choose(page, 'automation_state', 'Active')
    await expect(controlButton(page, 'automation_state')).toContainText('Active')
    await choose(page, 'automation_state', 'Human Controlled')
    await expect(controlButton(page, 'automation_state')).toContainText('Human Controlled')
    const automationWrites = scenario.patchLog.filter((entry) => Object.hasOwn((entry.request.patch || {}) as object, 'automation_state'))
    expect(automationWrites.map((entry) => (entry.request.patch as Record<string, unknown>).automation_state)).toEqual(['paused', 'running', 'manual'])
    expect(automationWrites.every((entry) => !Object.hasOwn((entry.request.patch || {}) as object, 'automation_status'))).toBe(true)

    // System-only states are not exposed to the operator.
    await controlButton(page, 'automation_state').click()
    const automationList = page.getByRole('listbox').last()
    await expect(automationList).not.toContainText(/review_required|disabled|completed/i)
    await page.keyboard.press('Escape')

    // Read/unread and manual lock both reconcile from the authoritative row.
    await bar(page).getByRole('button', { name: /Mark read/i }).click()
    await expect(bar(page).getByRole('button', { name: /Mark unread/i })).toBeVisible()
    await bar(page).getByRole('button', { name: /Mark unread/i }).click()
    await expect(bar(page).getByRole('button', { name: /Mark read/i })).toBeVisible()
    await bar(page).getByRole('button', { name: /Lock stage/i }).click()
    await expect(bar(page).getByRole('button', { name: /Stage locked/i })).toBeVisible()

    // Polling/external reconciliation during a pending mutation cannot overwrite the overlay.
    scenario.delays = { operational_status: 900 }
    const statusPromise = choose(page, 'operational_status', 'Needs Review')
    await page.waitForTimeout(80)
    await expect(controlButton(page, 'operational_status')).toContainText('Needs Review')
    const current = state.get('+19015551001')!
    state.set('+19015551001', { ...current, operational_status: 'not_contacted' } as Row)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await page.waitForTimeout(250)
    await expect(controlButton(page, 'operational_status')).toContainText('Needs Review')
    await statusPromise
    await page.waitForTimeout(800)
    await expect(controlButton(page, 'operational_status')).toContainText('Needs Review')
    scenario.delays = {}

    // Read-only mirrors agree and redirect focus rather than issuing a mutation.
    const beforeMirror = scenario.patchLog.length
    const mirror = page.locator('[data-state-mirror="deal-intelligence"]').getByRole('button', { name: /Status:/i }).first()
    if (await mirror.count()) {
      await mirror.click()
      expect(scenario.patchLog.length).toBe(beforeMirror)
      await expect(controlButton(page, 'operational_status')).toBeFocused()
    }

    const proof = await page.evaluate(() => (window as Window & { __DEAL_DESK_PROOF__?: Record<string, unknown> }).__DEAL_DESK_PROOF__ || null)
    expect((proof?.mounts as Record<string, number> | undefined)?.workspace ?? 1).toBe(1)
    expect(consoleErrors).toEqual([])
    expect(failedRequests.filter((entry) => !entry.includes('/_supabase_stub/realtime/'))).toEqual([])

    const evidence = {
      capturedAt: new Date().toISOString(),
      mode: 'fixture-only; all external write paths blocked',
      requests: scenario.patchLog.map((entry) => ({ request: entry.request, status: entry.status, response: entry.response })),
      finalRow: { ...state.get('+19015551001'), thread_key: '…1001', seller_name: '[redacted]' },
      consoleErrors,
      failedRequests,
      proof,
    }
    fs.writeFileSync(path.join(OUT_DIR, 'runtime-evidence.json'), JSON.stringify(evidence, null, 2))
    await page.screenshot({ path: path.join(OUT_DIR, 'canonical-controls.png'), fullPage: false })
  })

  test('suppressed/terminal resume and unsupported routes reject without invalid requests', async ({ page }) => {
    // Suppressed row: Active is available as an operator intent but explicitly rejected.
    await selectRow(page, 1)
    const beforeSuppressed = scenario.patchLog.length
    await choose(page, 'automation_state', 'Active')
    await expect(bar(page).getByRole('alert')).toContainText(/cannot resume/i)
    expect(scenario.patchLog.length).toBe(beforeSuppressed)
    await expect(controlButton(page, 'automation_state')).toContainText('Paused')

    // Terminal execution row: same explicit rejection, no success and no request.
    await selectRow(page, 2)
    const beforeTerminal = scenario.patchLog.length
    await choose(page, 'automation_state', 'Active')
    await expect(bar(page).getByRole('alert')).toContainText(/completed/i)
    expect(scenario.patchLog.length).toBe(beforeTerminal)
    await expect(controlButton(page, 'automation_state')).toContainText('Paused')

    // Missing writable canonical route: client blocks before the server and logs no PII.
    await selectRow(page, 3)
    await expect(bar(page).getByRole('alert')).toContainText(/no writable canonical phone route/i)
    const beforeUnsupported = scenario.patchLog.length
    await choose(page, 'operational_status', 'Needs Review')
    await expect(bar(page).getByRole('alert')).toContainText(/no writable canonical phone route/i)
    expect(scenario.patchLog.length).toBe(beforeUnsupported)

    // Switching threads during a pending mutation keeps the request attached to its origin.
    await selectRow(page, 0)
    scenario.delays = { lifecycle_stage: 900 }
    await controlButton(page, 'lifecycle_stage').click()
    await page.getByRole('listbox').last().getByRole('option', { name: /S4 Property Condition/i }).click()
    await page.getByRole('button', { name: 'Change Stage Only' }).click()
    await page.waitForTimeout(80)
    await selectRow(page, 1)
    await page.waitForTimeout(1000)
    const originWrite = scenario.patchLog.find((entry) => (entry.request.patch as Record<string, unknown>).lifecycle_stage === 'property_condition')
    expect(originWrite?.request.thread).toBe('…1001')
    await expect(controlButton(page, 'lifecycle_stage')).toContainText('S2 Interest Probe')
  })
})
