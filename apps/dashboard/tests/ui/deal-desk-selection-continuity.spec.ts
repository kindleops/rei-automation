/**
 * N.1 — Deal Desk selection & hydration runtime verification.
 *
 * Runs against a locally previewed build with **every inbox API route intercepted and
 * served from synthetic fixtures**. No production credentials, no live Supabase, no
 * outbound message of any kind. The fixtures exist so the selection/hydration contract
 * can be exercised in a real browser without touching operator data.
 *
 * Assertions read `window.__DEAL_DESK_PROOF__`, published by
 * `src/domain/inbox/deal-desk-runtime-proof.ts`.
 *
 * Run with:
 *   npx playwright test tests/ui/deal-desk-selection-continuity.spec.ts
 */

import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page, type Route } from '@playwright/test'

const OUT_DIR = path.resolve('proof/deal-desk-selection')
fs.mkdirSync(OUT_DIR, { recursive: true })

interface ProofCounters {
  selectionKey: string | null
  selectionVersion: number
  selectionCommits: number
  requestsByResource: Record<string, number>
  staleRejections: number
  abortedRequests: number
  mounts: Record<string, number>
  bucketTransitionPending: boolean
  globalEmptyWorkspace: boolean
  lastReconcileReason: string | null
}

// ── synthetic fixtures ───────────────────────────────────────────────────────

const BUCKETS: Record<string, string[]> = {
  all_conversations: ['t1', 't2', 't3', 't4', 't5', 't6'],
  priority: ['t1', 't2', 't3'],
  new_replies: ['t3', 't4'],
  needs_review: ['t5'],
  follow_up: ['t1', 't6'],
}

const makeThread = (n: number) => ({
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
  unread_count: n % 2,
  is_read: n % 2 === 0,
  lifecycle_stage: 'ownership_confirmation',
  operational_status: 'active',
})

const ALL_THREADS = [1, 2, 3, 4, 5, 6].map(makeThread)
const threadById = new Map(ALL_THREADS.map((t) => [t.id, t]))

/** Delays applied to specific routes, so a stale response can be forced. */
const routeDelays: Record<string, number> = {}

const jsonRoute = async (route: Route, body: unknown, delayMs = 0) => {
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

async function installFixtures(page: Page) {
  await page.addInitScript(() => {
    ;(window as Window & { __DEAL_DESK_PROOF_ENABLED__?: boolean }).__DEAL_DESK_PROOF_ENABLED__ = true
    // Auto-select is left ON: it is part of what this spec verifies.
  })

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
        { id: `${key}-m1`, direction: 'inbound', body: `Inbound for ${key}`, created_at: '2026-08-01T10:00:00.000Z' },
        { id: `${key}-m2`, direction: 'outbound', body: `Outbound for ${key}`, created_at: '2026-08-01T11:00:00.000Z', delivery_status: 'delivered' },
      ],
      pagination: { has_more: false },
    }, routeDelays.messages ?? 0)
  })

  await page.route('**/api/cockpit/inbox/thread-hydration**', (route) =>
    jsonRoute(route, { ok: true, messages: [], pagination: { has_more: false }, deal_context: null, intelligence: null }))

  await page.route('**/api/cockpit/inbox/thread-dossier**', (route) =>
    jsonRoute(route, { ok: true, data: { property_id: 'prop-1' } }, routeDelays.dossier ?? 0))

  await page.route('**/api/internal/inbox/thread-context**', (route) =>
    jsonRoute(route, { ok: true, context: null }))

  await page.route('**/api/cockpit/inbox/property-participants**', (route) =>
    jsonRoute(route, { ok: true, participants: [], next_eligible_contact: null }, routeDelays.participants ?? 0))

  // Deal Intelligence: fails on purpose in one scenario.
  await page.route('**/valuation-snapshot**', (route) =>
    routeDelays.intelligenceFails
      ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"ok":false}' })
      : jsonRoute(route, { ok: true, data: {} }, routeDelays.intelligence ?? 0))

  // Anything else under the cockpit API returns an empty OK so nothing 404-storms.
  await page.route('**/api/cockpit/**', (route) => jsonRoute(route, { ok: true, data: null }))

  // Hard stop: no request may leave for Supabase or a message provider.
  await page.route('**://*.supabase.co/**', (route) => route.abort())
  await page.route('**://*.textgrid.com/**', (route) => route.abort())
}

const readProof = (page: Page) =>
  page.evaluate(() => (window as Window & { __DEAL_DESK_PROOF__?: ProofCounters }).__DEAL_DESK_PROOF__ ?? null)

const threadRows = (page: Page) =>
  page.locator('[data-thread-id], .nx-thread-card-rebuilt, .nx-thread-row')

test.describe('Deal Desk selection and hydration continuity (fixture-backed)', () => {
  test.beforeEach(async ({ page }) => {
    Object.keys(routeDelays).forEach((k) => delete routeDelays[k])
    await installFixtures(page)
  })

  test('rapid selection, bucket switching, refresh and draft continuity', async ({ page }) => {
    const consoleErrors: string[] = []
    const failedRequests: string[] = []
    const requestLog: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('requestfailed', (req) => failedRequests.push(`${req.method()} ${req.url().split('?')[0]}`))
    page.on('request', (req) => {
      const url = req.url()
      if (url.includes('/api/')) requestLog.push(url.split('?')[0])
    })

    await page.goto('/inbox', { waitUntil: 'domcontentloaded' })
    await expect(threadRows(page).first()).toBeVisible({ timeout: 30_000 })

    // ── 1-3. select five distinct threads quickly; only the last stays active ──
    const rows = threadRows(page)
    const rowCount = Math.min(await rows.count(), 5)
    expect(rowCount, 'fixture list must render at least 3 rows').toBeGreaterThanOrEqual(3)

    routeDelays.messages = 400 // force responses to overlap the next click
    for (let i = 0; i < rowCount; i += 1) {
      await rows.nth(i).click()
      await page.waitForTimeout(40)
    }
    await page.waitForTimeout(1200)
    delete routeDelays.messages

    const afterRapid = await readProof(page)
    expect(afterRapid, 'proof counters must be published').not.toBeNull()
    const lastRowKey = await rows.nth(rowCount - 1).getAttribute('data-thread-id')
    if (lastRowKey) {
      expect(afterRapid!.selectionKey, 'only the latest selected thread stays active').toBe(lastRowKey)
    }
    expect(
      afterRapid!.staleRejections,
      'overlapping responses must be rejected, not committed',
    ).toBeGreaterThan(0)

    const remountsAfterSelection = { ...afterRapid!.mounts }

    // ── 4-5. three bucket switches, no transient global empty state ────────────
    const blankSamples: boolean[] = []
    const sampler = setInterval(() => { /* placeholder — sampling happens below */ }, 1_000_000)
    clearInterval(sampler)

    for (const label of ['New Replies', 'Needs Review', 'Follow']) {
      const tab = page.getByRole('tab', { name: new RegExp(label, 'i') }).first()
      if (await tab.count() === 0) continue
      routeDelays.live = 350
      await tab.click()
      // Sample the workspace state repeatedly *during* the list request.
      for (let i = 0; i < 6; i += 1) {
        await page.waitForTimeout(60)
        const p = await readProof(page)
        if (p) blankSamples.push(p.globalEmptyWorkspace)
      }
      delete routeDelays.live
      await page.waitForTimeout(600)
    }

    expect(
      blankSamples.some(Boolean),
      'center/right panels must never flash the global empty state during a bucket transition',
    ).toBe(false)

    // ── 6-7. list refresh keeps the selection stable ──────────────────────────
    const beforeRefresh = await readProof(page)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await page.waitForTimeout(1500)
    const afterRefresh = await readProof(page)
    expect(afterRefresh!.selectionKey, 'a list refresh must not move the selection').toBe(beforeRefresh!.selectionKey)
    expect(afterRefresh!.selectionVersion).toBe(beforeRefresh!.selectionVersion)

    // ── 8-9. a delayed Intelligence response cannot overwrite the current property ──
    routeDelays.intelligence = 1200
    const rowsNow = threadRows(page)
    if (await rowsNow.count() >= 2) {
      await rowsNow.nth(0).click()
      await page.waitForTimeout(80)
      await rowsNow.nth(1).click()   // switch away while intelligence is still in flight
      await page.waitForTimeout(1800)
      const afterDelayed = await readProof(page)
      const expectedKey = await rowsNow.nth(1).getAttribute('data-thread-id')
      if (expectedKey) {
        expect(afterDelayed!.selectionKey, 'a late Intelligence response must not re-point the workspace').toBe(expectedKey)
      }
    }
    delete routeDelays.intelligence

    // ── 10. composer draft survives a list refresh ────────────────────────────
    const composer = page.locator('textarea, [contenteditable="true"]').first()
    let draftPreserved: boolean | null = null
    if (await composer.count() > 0) {
      await composer.click()
      await composer.fill('N1 fixture draft — must survive a refresh')
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      await page.waitForTimeout(1500)
      draftPreserved = (await composer.inputValue().catch(() => '')) === 'N1 fixture draft — must survive a refresh'
      expect(draftPreserved, 'unsent composer text must survive a list refresh').toBe(true)
    }

    // ── 11. record the evidence ───────────────────────────────────────────────
    const finalProof = await readProof(page)
    const evidence = {
      capturedAt: new Date().toISOString(),
      mode: 'fixture-backed (no production credentials, no live data, no sends)',
      selection: {
        finalKey: finalProof!.selectionKey,
        selectionVersion: finalProof!.selectionVersion,
        selectionCommits: finalProof!.selectionCommits,
        lastReconcileReason: finalProof!.lastReconcileReason,
      },
      requestsByResource: finalProof!.requestsByResource,
      staleRejections: finalProof!.staleRejections,
      abortedRequests: finalProof!.abortedRequests,
      mounts: finalProof!.mounts,
      remountsAfterSelectionPhase: remountsAfterSelection,
      globalEmptyWorkspaceSamplesDuringBucketSwitch: blankSamples,
      draftPreservedAcrossRefresh: draftPreserved,
      consoleErrors,
      failedRequests,
      duplicateApiRequests: Object.entries(
        requestLog.reduce<Record<string, number>>((acc, url) => {
          acc[url] = (acc[url] ?? 0) + 1
          return acc
        }, {}),
      ).filter(([, count]) => count > 1),
    }
    fs.writeFileSync(path.join(OUT_DIR, 'runtime-evidence.json'), JSON.stringify(evidence, null, 2))
    await page.screenshot({ path: path.join(OUT_DIR, 'deal-desk-after.png'), fullPage: false })

    // The workspace must never have been remounted by a bucket or filter change.
    expect(finalProof!.mounts.workspace, 'the workspace must mount exactly once').toBe(1)
  })
})
