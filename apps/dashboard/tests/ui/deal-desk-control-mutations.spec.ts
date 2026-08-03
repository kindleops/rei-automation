/**
 * N.2 — Deal Desk control mutation runtime verification.
 *
 * Runs against a locally previewed build with **every network route intercepted and served
 * from synthetic fixtures**. No production credentials, no live Supabase, no live backend,
 * no outbound message. The `lead-state/patch` handler records every request body and lets a
 * scenario decide the response, so rollback, refusal and rapid-write behaviour can be
 * exercised in a real browser without touching operator data.
 *
 * Evidence (redacted request/response pairs, console errors, remount counters) is written
 * to `proof/deal-desk-control-mutations/`.
 *
 * Run with:
 *   npx playwright test tests/ui/deal-desk-control-mutations.spec.ts
 */

import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page, type Route } from '@playwright/test'

const OUT_DIR = path.resolve('proof/deal-desk-control-mutations')
fs.mkdirSync(OUT_DIR, { recursive: true })

interface ProofCounters {
  selectionKey: string | null
  selectionVersion: number
  requestsByResource: Record<string, number>
  staleRejections: number
  mounts: Record<string, number>
  globalEmptyWorkspace: boolean
}

// ── fixtures ─────────────────────────────────────────────────────────────────

interface ThreadFixture {
  id: string
  thread_key: string
  canonical_e164: string | null
  lifecycle_stage: string
  operational_status: string
  lead_temperature: string
  automation_state: string
  automation_status?: string
  is_read: boolean
  is_suppressed?: boolean
  disposition?: string
  [key: string]: unknown
}

const makeThread = (n: number, overrides: Partial<ThreadFixture> = {}): ThreadFixture => ({
  id: `t${n}`,
  thread_key: `+1901555${String(1000 + n)}`,
  canonical_e164: `+1901555${String(1000 + n)}`,
  property_id: `prop-${n}`,
  prospect_id: `prospect-${n}`,
  master_owner_id: `owner-${n}`,
  seller_name: `Fixture Seller ${n}`,
  property_address_full: `${n}00 Fixture Street`,
  latest_message_body: `Fixture inbound message ${n}`,
  latest_message_at: `2026-08-0${(n % 8) + 1}T12:00:00.000Z`,
  inbox_bucket: 'priority',
  unread_count: 1,
  is_read: false,
  lifecycle_stage: 'offer_interest',
  operational_status: 'new_reply',
  lead_temperature: 'cold',
  automation_state: 'running',
  ...overrides,
})

/**
 * t1 — a normal writable thread.
 * t2 — suppressed and paused: a resume must be refused.
 * t3 — closed (terminal): a resume must be refused.
 * t4 — a stored `mf_suppressed` stage: must display verbatim, never as S1.
 * t5 — no dialable phone at all: no writable canonical route.
 */
const THREADS: ThreadFixture[] = [
  makeThread(1),
  makeThread(2, { automation_state: 'paused', is_suppressed: true, automation_status: 'suppressed' }),
  makeThread(3, { automation_state: 'paused', lifecycle_stage: 'closed' }),
  makeThread(4, { lifecycle_stage: 'mf_suppressed' }),
  makeThread(5, {
    canonical_e164: null,
    thread_key: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    seller_phone: null,
    best_phone: null,
    phone: null,
  }),
]
const threadById = new Map(THREADS.map((t) => [t.id, t]))

const BUCKETS: Record<string, string[]> = {
  all_conversations: THREADS.map((t) => t.id),
  priority: THREADS.map((t) => t.id),
}

// ── mutation recorder ────────────────────────────────────────────────────────

interface RecordedPatch {
  threadKey: string
  patch: Record<string, unknown>
  meta: Record<string, unknown>
  responded: unknown
}

const recorded: RecordedPatch[] = []

/** Per-scenario control over how the stubbed server answers a patch. */
const patchBehaviour: {
  mode: 'echo' | 'fail' | 'blocked' | 'coerce'
  coerceTo?: Record<string, unknown>
  reason?: string
  delayMs?: number
  perCallDelayMs?: number[]
} = { mode: 'echo' }

const routeDelays: Record<string, number> = {}

/** Proof that the PostgREST stub actually intercepted, rather than the app silently
 *  falling through to the SPA index.html. */
let postgrestHits = 0

/** Mask any E.164 number so recorded evidence carries no dialable seller phone. */
const maskPhones = (value: string): string =>
  value.replace(/\+?1?\d{10,11}/g, (m) => `${m.slice(0, 2)}${'*'.repeat(Math.max(0, m.length - 6))}${m.slice(-4)}`)

const redact = (value: unknown): unknown =>
  JSON.parse(maskPhones(JSON.stringify(value ?? null)))

const jsonRoute = async (route: Route, body: unknown, delayMs = 0) => {
  const effectiveDelay = Math.max(delayMs, routeDelays.all ?? 0)
  if (effectiveDelay > 0) await new Promise((resolve) => setTimeout(resolve, effectiveDelay))
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
}

const STUB_USER = {
  id: '00000000-0000-4000-8000-000000000001',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'fixture@localhost.invalid',
  app_metadata: {},
  user_metadata: {},
  created_at: '2026-01-01T00:00:00.000Z',
}
const STUB_SESSION = {
  access_token: 'fixture-access-token',
  refresh_token: 'fixture-refresh-token',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: STUB_USER,
}

async function installFixtures(page: Page) {
  await page.addInitScript((session) => {
    ;(window as Window & { __DEAL_DESK_PROOF_ENABLED__?: boolean }).__DEAL_DESK_PROOF_ENABLED__ = true
    try {
      window.localStorage.setItem(
        'sb-127-auth-token',
        JSON.stringify({ currentSession: session, expiresAt: session.expires_at }),
      )
    } catch { /* route handlers below still cover it */ }
  }, STUB_SESSION)

  // Broad blocks first — Playwright matches handlers in reverse registration order.
  await page.route('**://*.supabase.co/**', (route) => route.abort())
  await page.route('**://*.textgrid.com/**', (route) => route.abort())
  await page.route('**://*.vercel.app/**', (route) => route.abort())

  const TRANSPARENT_GIF = Buffer.from(
    'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64',
  )
  await page.route('**://maps.googleapis.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/gif', body: TRANSPARENT_GIF }))
  await page.route('**://maps.gstatic.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/gif', body: TRANSPARENT_GIF }))
  await page.route('**://*.google.com/maps/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>stub</title>' }))

  await page.route('**/_supabase_stub/auth/v1/user**', (route) => jsonRoute(route, STUB_USER))
  await page.route('**/_supabase_stub/auth/v1/token**', (route) => jsonRoute(route, STUB_SESSION))
  await page.route('**/_supabase_stub/auth/v1/**', (route) =>
    jsonRoute(route, { data: { session: STUB_SESSION, user: STUB_USER } }))
  await page.route('**/_supabase_stub/realtime/**', (route) => route.abort())

  await page.route('**/api/cockpit/**', (route) => jsonRoute(route, { ok: true, data: null }))
  await page.route('**/api/internal/**', (route) => jsonRoute(route, { ok: true, data: null }))

  await page.route('**/api/cockpit/inbox/live**', async (route) => {
    const url = new URL(route.request().url())
    const view = url.searchParams.get('view') || 'all_conversations'
    const ids = BUCKETS[view] ?? BUCKETS.all_conversations
    await jsonRoute(route, {
      ok: true,
      threads: ids.map((id) => ({ ...threadById.get(id)!, inbox_bucket: view })),
      total_count: ids.length,
      has_more: false,
      next_cursor: null,
      data_mode: 'live',
    }, routeDelays.live ?? 0)
  })

  await page.route('**/api/cockpit/inbox/counts**', (route) =>
    jsonRoute(route, {
      ok: true,
      counts: Object.fromEntries(Object.entries(BUCKETS).map(([k, v]) => [k, v.length])),
    }))

  await page.route('**/api/cockpit/inbox/thread-messages**', async (route) => {
    const url = new URL(route.request().url())
    const key = url.searchParams.get('thread_key') || url.searchParams.get('threadKey') || 'unknown'
    await jsonRoute(route, {
      ok: true,
      messages: [
        { id: `${key}-m1`, direction: 'inbound', body: 'Fixture inbound', created_at: '2026-08-01T10:00:00.000Z' },
      ],
      pagination: { has_more: false },
    }, routeDelays.messages ?? 0)
  })

  await page.route('**/api/cockpit/inbox/thread-hydration**', (route) =>
    jsonRoute(route, { ok: true, messages: [], pagination: { has_more: false }, deal_context: null, intelligence: null }))
  await page.route('**/api/cockpit/inbox/thread-dossier**', (route) =>
    jsonRoute(route, { ok: true, data: { property_id: 'prop-1' } }))
  await page.route('**/api/internal/inbox/thread-context**', (route) =>
    jsonRoute(route, { ok: true, context: null }))
  await page.route('**/api/cockpit/inbox/property-participants**', (route) =>
    jsonRoute(route, { ok: true, participants: [], next_eligible_contact: null }))

  /**
   * Every PostgREST read.
   *
   * Registered LAST (Playwright checks handlers in reverse registration order, so last
   * wins) and matched by PREDICATE: the glob form did not match these URLs, whose query
   * strings contain `select=*`. Unmatched, they fell through to the SPA fallback and
   * `supabase.from(...)` received index.html, so every consumer logged a JSON parse error.
   */
  await page.route(
    (url) => url.pathname.includes('/rest/v1/'),
    (route) => {
      postgrestHits += 1
      return jsonRoute(route, [])
    },
  )

  // ── the mutation endpoint under test ───────────────────────────────────────
  await page.route('**/api/cockpit/lead-state/patch**', async (route) => {
    const raw = route.request().postData() ?? '{}'
    const body = JSON.parse(raw) as { thread_key?: string; patch?: Record<string, unknown> } & Record<string, unknown>
    const patch = body.patch ?? {}
    const { thread_key: _tk, patch: _p, ...meta } = body

    const index = recorded.length
    const delay = patchBehaviour.perCallDelayMs?.[index] ?? patchBehaviour.delayMs ?? 0
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))

    let status = 200
    let response: unknown
    switch (patchBehaviour.mode) {
      case 'fail':
        status = 400
        response = { ok: false, reason: patchBehaviour.reason ?? 'server_error', thread_key: body.thread_key }
        break
      case 'blocked':
        response = { ok: true, blocked: true, reason: patchBehaviour.reason ?? 'no_allowed_patch_fields' }
        break
      case 'coerce':
        response = { ok: true, action: 'patch_universal_lead_state', row: { ...patch, ...patchBehaviour.coerceTo } }
        break
      case 'echo':
      default:
        response = { ok: true, action: 'patch_universal_lead_state', row: { ...patch } }
        break
    }

    /**
     * The fixture store is STATEFUL on success.
     *
     * Without this the list route keeps returning the pre-mutation row, so the control's
     * authoritative value never catches up — and a later rollback would appear to restore
     * a value two writes old. Persisting here makes `serverValue` behave the way a real
     * refresh does, which is what the rollback assertions actually depend on.
     */
    if (status === 200 && (patchBehaviour.mode === 'echo' || patchBehaviour.mode === 'coerce')) {
      const persisted = (response as { row?: Record<string, unknown> }).row ?? {}
      const target = THREADS.find((t) => t.thread_key === body.thread_key)
      if (target) Object.assign(target, persisted)
    }

    recorded.push({
      threadKey: String(body.thread_key ?? ''),
      patch,
      meta: meta as Record<string, unknown>,
      responded: response,
    })
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(response) })
  })
}

// ── helpers ──────────────────────────────────────────────────────────────────

const readProof = (page: Page) =>
  page.evaluate(() => (window as Window & { __DEAL_DESK_PROOF__?: ProofCounters }).__DEAL_DESK_PROOF__ ?? null)

const threadRows = (page: Page) =>
  page.locator('[data-thread-id], .nx-thread-card-rebuilt, .nx-thread-row')

const bar = (page: Page) => page.getByTestId('thread-state-bar')
const ctrl = (page: Page, id: string) => page.getByTestId(id)

/**
 * Select a fixture thread by its seller name.
 *
 * NOT by `data-thread-id`: that attribute carries the canonical SELECTION key
 * (`ct:prospect:…|property:…|phone:…`), not the fixture's `id`. Positional selection is
 * equally wrong — the list is ordered by latest message, so index 0 is whichever fixture
 * has the newest timestamp, which is how the first run of this spec silently drove every
 * assertion against the deliberately-unwritable thread.
 */
const selectThread = async (page: Page, n: number) => {
  const row = threadRows(page).filter({ hasText: `Fixture Seller ${n}` }).first()
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.click()
  await page.waitForTimeout(500)
}

const chooseOption = async (page: Page, controlId: string, optionName: RegExp) => {
  await ctrl(page, controlId).click()
  const menu = page.locator('.nx-conv-dropdown-portal')
  await expect(menu).toBeVisible({ timeout: 5_000 })
  await menu.getByRole('option', { name: optionName }).first().click()
}

const valueOf = (page: Page, controlId: string) => ctrl(page, controlId).getAttribute('data-value')

/**
 * Reload the workspace and reselect a thread, so the next assertion measures the value the
 * (fixture) database actually holds rather than the confirmed overlay standing in for it.
 *
 * A focus-triggered poll is not enough: `backendClient` caches GETs per path+query for a
 * TTL, so an immediate refetch of the inbox list can be served from that cache and the
 * authoritative row never changes. A reload clears it, and it doubles as proof that the
 * write survived a full round trip.
 */
const reloadAndSelect = async (page: Page, n: number) => {
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(threadRows(page).first()).toBeVisible({ timeout: 30_000 })
  await selectThread(page, n)
  await expect(bar(page)).toBeVisible({ timeout: 15_000 })
}

// ── the scenario ─────────────────────────────────────────────────────────────

test.describe('Deal Desk canonical control mutations (fixture-backed)', () => {
  test.setTimeout(240_000)

  /**
   * Service workers are BLOCKED for this run.
   *
   * `src/main.tsx` registers one in production builds, and a request served through a
   * service worker bypasses `page.route` entirely — the PostgREST reads were reaching the
   * real network path and getting the SPA fallback back, which is both a broken fixture
   * and a genuine isolation hole in a spec that claims nothing escapes.
   */
  test.use({ serviceWorkers: 'block' })

  test.beforeEach(async ({ page }) => {
    recorded.length = 0
    postgrestHits = 0
    patchBehaviour.mode = 'echo'
    delete patchBehaviour.coerceTo
    delete patchBehaviour.reason
    delete patchBehaviour.delayMs
    delete patchBehaviour.perCallDelayMs
    Object.keys(routeDelays).forEach((k) => delete routeDelays[k])
    await installFixtures(page)
  })

  test('every canonical control writes, rolls back, refuses and reconciles correctly', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    const evidence: Array<Record<string, unknown>> = []
    const capture = (step: string, extra: Record<string, unknown> = {}) => {
      evidence.push({
        step,
        requests: recorded.map((r) => ({
          thread_key: maskPhones(r.threadKey),
          patch: redact(r.patch),
          response: redact(r.responded),
        })),
        ...extra,
      })
      recorded.length = 0
    }

    await page.goto('/inbox', { waitUntil: 'domcontentloaded' })
    await expect(threadRows(page).first()).toBeVisible({ timeout: 30_000 })
    await selectThread(page, 1)
    await expect(bar(page)).toBeVisible({ timeout: 15_000 })

    const mountsAtStart = (await readProof(page))?.mounts ?? {}

    // ── 1. stage change succeeds ───────────────────────────────────────────
    await chooseOption(page, 'control-lifecycle-stage', /Asking Price/i)
    await page.getByRole('button', { name: /change stage only/i }).click()
    await expect.poll(() => valueOf(page, 'control-lifecycle-stage')).toBe('asking_price')
    expect(recorded.length, 'exactly one request per operator action').toBe(1)
    expect(recorded[0]!.patch).toEqual({ lifecycle_stage: 'asking_price' })
    capture('1_stage_success')

    // Reload so the rollback below is measured against the value the fixture database
    // actually holds. This also proves the write survived a full round trip.
    await reloadAndSelect(page, 1)
    await expect.poll(() => valueOf(page, 'control-lifecycle-stage')).toBe('asking_price')
    recorded.length = 0

    // ── 2. forced stage failure rolls back ─────────────────────────────────
    patchBehaviour.mode = 'fail'
    patchBehaviour.reason = 'manual_stage_lock_blocked_stage_write'
    await chooseOption(page, 'control-lifecycle-stage', /Property Condition/i)
    await page.getByRole('button', { name: /change stage only/i }).click()
    await expect(page.getByTestId('control-lifecycle-stage-error')).toBeVisible({ timeout: 10_000 })
    await expect.poll(() => valueOf(page, 'control-lifecycle-stage')).toBe('asking_price')
    const stageError = await page.getByTestId('control-lifecycle-stage-error').textContent()
    expect(stageError ?? '', 'operator text must be localised, never the raw diagnostic')
      .toMatch(/manual stage lock/i)
    expect(stageError ?? '').not.toMatch(/https?:|\+1\d{10}/)
    capture('2_stage_failure_rollback', { rolledBackTo: 'asking_price', operatorMessage: stageError })

    // ── 3-4. status success then forced failure ────────────────────────────
    patchBehaviour.mode = 'echo'
    await chooseOption(page, 'control-operational-status', /Waiting/i)
    await expect.poll(() => valueOf(page, 'control-operational-status')).toBe('waiting_on_seller')
    expect(recorded[0]!.patch, 'a status change writes only its own field')
      .toEqual({ operational_status: 'waiting_on_seller' })
    capture('3_status_success')
    await reloadAndSelect(page, 1)
    await expect.poll(() => valueOf(page, 'control-operational-status')).toBe('waiting_on_seller')
    recorded.length = 0

    patchBehaviour.mode = 'fail'
    patchBehaviour.reason = 'server_error'
    await chooseOption(page, 'control-operational-status', /Needs Review/i)
    await expect(page.getByTestId('control-operational-status-error')).toBeVisible({ timeout: 10_000 })
    await expect.poll(() => valueOf(page, 'control-operational-status')).toBe('waiting_on_seller')
    capture('4_status_failure_rollback')

    // ── 5-6. three rapid temperature changes; only the last persists ───────
    patchBehaviour.mode = 'echo'
    patchBehaviour.perCallDelayMs = [900, 600, 100]
    await chooseOption(page, 'control-lead-temperature', /Cold/i)
    await chooseOption(page, 'control-lead-temperature', /Warm/i)
    await chooseOption(page, 'control-lead-temperature', /Hot/i)
    await page.waitForTimeout(2_500)
    delete patchBehaviour.perCallDelayMs
    await expect.poll(() => valueOf(page, 'control-lead-temperature')).toBe('hot')
    const tempWrites = recorded.map((r) => r.patch.lead_temperature)
    expect(tempWrites, 'the operator issued three writes').toEqual(['cold', 'warm', 'hot'])
    capture('5_6_temperature_rapid_last_wins', { finalValue: 'hot', writes: tempWrites })

    // ── 7-9. pause, resume, manual control ─────────────────────────────────
    await chooseOption(page, 'control-automation-mode', /Paused/i)
    await expect.poll(() => valueOf(page, 'control-automation-mode')).toBe('paused')
    expect(recorded[0]!.patch).toEqual({ automation_state: 'paused' })
    capture('7_automation_pause')

    await chooseOption(page, 'control-automation-mode', /Autopilot On/i)
    await expect.poll(() => valueOf(page, 'control-automation-mode')).toBe('active')
    expect(recorded[0]!.patch, 'active serialises to the persisted value running')
      .toEqual({ automation_state: 'running' })
    capture('8_automation_resume')

    await chooseOption(page, 'control-automation-mode', /Manual Only/i)
    await expect.poll(() => valueOf(page, 'control-automation-mode')).toBe('human_controlled')
    expect(recorded[0]!.patch).toEqual({ automation_state: 'manual', manual_stage_lock: true })
    capture('9_automation_manual_control')

    // ── 10. system-only modes are not offered ──────────────────────────────
    await ctrl(page, 'control-automation-mode').click()
    const modeMenu = page.locator('.nx-conv-dropdown-portal')
    await expect(modeMenu).toBeVisible()
    const modeLabels = (await modeMenu.getByRole('option').allTextContents()).map((t) => t.replace('✓', '').trim())
    expect(modeLabels).toEqual(['Autopilot On', 'Paused', 'Manual Only'])
    await page.keyboard.press('Escape')
    capture('10_system_only_modes_absent', { offered: modeLabels })

    // ── 11. resume on a suppressed record is refused ───────────────────────
    await selectThread(page, 2)
    await expect.poll(() => valueOf(page, 'control-automation-mode')).toBe('paused')
    await chooseOption(page, 'control-automation-mode', /Autopilot On/i)
    await expect(page.getByTestId('control-automation-mode-error')).toBeVisible({ timeout: 10_000 })
    const suppressedMessage = await page.getByTestId('control-automation-mode-error').textContent()
    expect(suppressedMessage ?? '').toMatch(/suppressed/i)
    expect(recorded.length, 'no doomed request may be emitted').toBe(0)
    await expect.poll(() => valueOf(page, 'control-automation-mode')).toBe('paused')
    capture('11a_resume_suppressed_refused', { operatorMessage: suppressedMessage })

    await selectThread(page, 3)
    await chooseOption(page, 'control-automation-mode', /Autopilot On/i)
    await expect(page.getByTestId('control-automation-mode-error')).toBeVisible({ timeout: 10_000 })
    const terminalMessage = await page.getByTestId('control-automation-mode-error').textContent()
    expect(terminalMessage ?? '').toMatch(/closed/i)
    expect(recorded.length).toBe(0)
    capture('11b_resume_terminal_refused', { operatorMessage: terminalMessage })

    // ── unsupported legacy stage value is shown verbatim ───────────────────
    await selectThread(page, 4)
    await expect.poll(() => valueOf(page, 'control-lifecycle-stage')).toBe('mf_suppressed')
    const legacyLabel = await ctrl(page, 'control-lifecycle-stage').textContent()
    expect(legacyLabel ?? '').toMatch(/Unsupported: mf_suppressed/)
    expect(legacyLabel ?? '', 'a suppression value must never render as a lifecycle stage')
      .not.toMatch(/Ownership/i)
    capture('11c_unsupported_legacy_stage', { rendered: legacyLabel })

    // ── 12-13. mark read then unread ───────────────────────────────────────
    await selectThread(page, 1)
    const readToggle = page.getByTestId('control-read-state')
    const startedAs = await readToggle.getAttribute('data-value')
    await readToggle.click()
    await expect.poll(() => readToggle.getAttribute('data-value')).toBe(startedAs === 'read' ? 'unread' : 'read')
    expect(recorded[0]!.patch).toEqual({ is_read: startedAs !== 'read' })
    capture('12_mark_read')

    await readToggle.click()
    await expect.poll(() => readToggle.getAttribute('data-value')).toBe(startedAs)
    expect(recorded[0]!.patch).toEqual({ is_read: startedAs === 'read' })
    capture('13_mark_unread')

    // ── 14. a thread with no writable canonical route ──────────────────────
    await selectThread(page, 5)
    await expect(page.getByTestId('thread-state-unsupported')).toBeVisible({ timeout: 10_000 })
    const unsupportedToggle = page.getByTestId('control-read-state')
    await expect(unsupportedToggle).toBeDisabled()
    expect(recorded.length, 'no request for an unwritable thread').toBe(0)
    capture('14_unsupported_thread')

    // ── 15. switch threads during a pending mutation ───────────────────────
    await selectThread(page, 1)
    patchBehaviour.delayMs = 1_500
    await chooseOption(page, 'control-lead-temperature', /Warm/i)
    await selectThread(page, 2)
    await page.waitForTimeout(2_500)
    delete patchBehaviour.delayMs
    const afterSwitch = await valueOf(page, 'control-lead-temperature')
    expect(afterSwitch, "the previous thread's response must not land on this one").toBe('cold')
    capture('15_thread_switch_during_pending', { threadTwoTemperature: afterSwitch })

    // ── 16-17. polling / realtime reconciliation during a pending mutation ──
    await selectThread(page, 1)
    patchBehaviour.delayMs = 2_000
    await chooseOption(page, 'control-lead-temperature', /Hot/i)
    // Force a list refresh (the polling path) while the write is in flight.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await page.waitForTimeout(700)
    const duringPoll = await valueOf(page, 'control-lead-temperature')
    expect(duringPoll, 'a background refresh cannot overwrite a pending operator write').toBe('hot')
    await page.waitForTimeout(2_500)
    delete patchBehaviour.delayMs
    await expect.poll(() => valueOf(page, 'control-lead-temperature')).toBe('hot')
    capture('16_17_poll_during_pending', { duringPoll })

    // ── 18. read-only mirrors agree ────────────────────────────────────────
    const mirrors = page.getByTestId('thread-state-mirror')
    if (await mirrors.count() > 0) {
      const mirrorStage = await mirrors.first().getByTestId('mirror-stage').getAttribute('data-value')
      expect(mirrorStage, 'a mirror renders the same handle as the bar')
        .toBe(await valueOf(page, 'control-lifecycle-stage'))
      capture('18_mirrors_agree', { mirrorStage })
    } else {
      capture('18_mirrors_agree', { note: 'no mirror rendered in this layout' })
    }

    // ── 19-22. no duplicates, no premature success, no errors, no remounts ─
    patchBehaviour.mode = 'echo'
    await chooseOption(page, 'control-operational-status', /Snoozed/i)
    await page.waitForTimeout(1_200)
    expect(recorded.length, 'one operator action produces exactly one request').toBe(1)
    capture('19_no_duplicate_requests')

    // A 200 carrying `blocked: true` wrote nothing. It must read as a failure and roll
    // back to whatever the client currently holds as authoritative — captured here rather
    // than hard-coded, because the fixture list has not refreshed since the last write.
    const statusBeforeBlocked = await valueOf(page, 'control-operational-status')
    patchBehaviour.mode = 'blocked'
    patchBehaviour.reason = 'no_allowed_patch_fields'
    await chooseOption(page, 'control-operational-status', /Paused/i)
    await expect(page.getByTestId('control-operational-status-error')).toBeVisible({ timeout: 10_000 })
    await expect.poll(() => valueOf(page, 'control-operational-status')).toBe(statusBeforeBlocked)
    expect(statusBeforeBlocked, 'the attempted value must not survive').not.toBe('paused')
    capture('20_no_premature_success', {
      note: 'HTTP 200 + blocked:true is reported as a failure and rolled back',
    })

    const mountsAtEnd = (await readProof(page))?.mounts ?? {}
    const remountDeltas = Object.fromEntries(
      Object.keys({ ...mountsAtStart, ...mountsAtEnd }).map((k) => [
        k, (mountsAtEnd[k] ?? 0) - (mountsAtStart[k] ?? 0),
      ]),
    )

    const relevantConsoleErrors = consoleErrors.filter((text) =>
      !/favicon|ERR_CONNECTION|net::|Failed to load resource/i.test(text))

    fs.writeFileSync(
      path.join(OUT_DIR, 'evidence.json'),
      JSON.stringify({
        capturedAt: new Date().toISOString(),
        note: 'Fixture-backed. Every phone number is masked. No production data was read or written.',
        steps: evidence,
        remountDeltas,
        consoleErrors: relevantConsoleErrors,
      }, null, 2),
    )

    // Isolation proof: the PostgREST stub must have actually intercepted. A count of zero
    // would mean the reads escaped `page.route` (as they did while the service worker was
    // active) and this run's isolation claim would be false.
    expect(postgrestHits, 'the PostgREST stub must have intercepted').toBeGreaterThan(0)
    expect(relevantConsoleErrors, 'no console errors during the control scenario').toEqual([])
    // The workspace and the panels must not remount as a side effect of a mutation. Some
    // remounts are expected from the four intentional THREAD SWITCHES in this scenario.
    expect(remountDeltas.workspace ?? 0, 'the workspace must not remount').toBe(0)
  })
})
