#!/usr/bin/env node
/**
 * Headless inbox UX verification — asserts window.__INBOX_PROOF__ from shipped paths.
 * Uses production preview build for realistic first-paint timing.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execSync } from 'node:child_process'
import { loadDashboardEnv, warmupInboxApi, warmThreadMessagesInBrowser } from './inbox-proof-warmup.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DASHBOARD_ROOT = path.join(__dirname, '../..')
const SCRATCH = process.env.SCRATCH || path.join(DASHBOARD_ROOT, 'proof/inbox')
loadDashboardEnv(DASHBOARD_ROOT)

const TARGETS = {
  shell_to_rows_ms: 1000,
  first_row_visible_ms: 1000,
  bucket_switch_ms: 500,
  cached_thread_apply_ms: 100,
  uncached_messages_ms: 700,
  fetch_in_flight_max: 3,
  inbox_live_requests_max: 8,
  parallel_fetch_min: 4,
  parallel_network_min: 3,
}

const REQUIRED_OPTIMISTIC_ACTIONS = [
  'star', 'pin', 'archive', 'snooze', 'stage_consider_selling', 'status_waiting', 'message_pending',
]

async function canRunPlaywright() {
  try {
    execSync('npx playwright --version', { stdio: 'pipe', cwd: DASHBOARD_ROOT })
    return true
  } catch {
    return false
  }
}

async function waitForHttp(url, timeoutMs = 120_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (res.ok || res.status === 404) return
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(`http_ready_timeout:${url}`)
}

async function readProof(page) {
  return page.evaluate(() => {
    const proof = window.__INBOX_PROOF__
    if (!proof) return null
    return {
      activeBucketKey: proof.activeBucketKey,
      apiBootResponseMs: proof.apiBootResponseMs,
      firstRowsPaintMs: proof.firstRowsPaintMs,
      shellToRowsMs: proof.shellToRowsMs,
      firstRowVisibleMs: proof.firstRowVisibleMs,
      lastBucketSwitchMs: proof.lastBucketSwitchMs,
      lastBucketFrom: proof.lastBucketFrom,
      lastBucketTo: proof.lastBucketTo,
      lastThreadSelectCacheHit: proof.lastThreadSelectCacheHit,
      lastThreadSelectCacheApplyMs: proof.lastThreadSelectCacheApplyMs,
      lastUncachedMessagesMs: proof.lastUncachedMessagesMs,
      firstRowDomMs: proof.firstRowDomMs,
      parallelFetchStarted: proof.parallelFetchStarted,
      maxParallelFetchStarted: proof.maxParallelFetchStarted,
      dossierParallelStarted: proof.dossierParallelStarted,
      lastOptimisticPatch: proof.lastOptimisticPatch,
      optimisticPatches: proof.optimisticPatches ?? [],
      fetchInFlight: proof.fetchInFlight,
      maxFetchInFlight: proof.maxFetchInFlight,
      inboxLiveRequestCount: proof.inboxLiveRequestCount,
      degradedPollTicks: proof.degradedPollTicks,
      selectedPollTicks: proof.selectedPollTicks,
      duplicateLiveRequestBlocked: proof.duplicateLiveRequestBlocked,
      scrollOffset: proof.scrollOffset,
      hasDriveAction: typeof proof.driveAction === 'function',
    }
  })
}

async function waitForProof(page, predicate, timeoutMs = 12_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const proof = await readProof(page)
    if (proof && predicate(proof)) return proof
    await page.waitForTimeout(80)
  }
  return readProof(page)
}

async function driveOptimisticSuite(page) {
  const actions = [
    ['star', (p) => p.lastOptimisticPatch?.action === 'star' || p.lastOptimisticPatch?.action === 'unstar'],
    ['pin', (p) => p.optimisticPatches?.some((x) => x.action === 'pin' || x.action === 'unpin')],
    ['archive', (p) => p.optimisticPatches?.some((x) => x.action === 'archive')],
    ['unarchive', (p) => p.optimisticPatches?.some((x) => x.action === 'unarchive')],
    ['snooze', (p) => p.optimisticPatches?.some((x) => x.action === 'snooze')],
    ['stage:consider_selling', (p) => p.optimisticPatches?.some((x) => x.action === 'stage_consider_selling')],
    ['status:waiting', (p) => p.optimisticPatches?.some((x) => x.action === 'status_waiting')],
    ['message_pending', (p) => p.optimisticPatches?.some((x) => x.action === 'message_pending')],
  ]
  const driven = []
  for (const [action, predicate] of actions) {
    await page.evaluate((act) => {
      window.__INBOX_PROOF__?.driveAction?.(act)
    }, action)
    const proof = await waitForProof(page, predicate, 2500)
    driven.push({ action, ok: Boolean(proof && predicate(proof)) })
  }
  return driven
}

async function runOnce(dashUrl) {
  const consoleErrors = []
  const { chromium } = await import('@playwright/test')
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.addInitScript(() => {
    window.__INBOX_PROOF_DISABLE_AUTO_SELECT__ = true
  })
  const ignoredConsolePatterns = [/permissions policy violation/i, /accelerometer/i]
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return
    const text = msg.text()
    if (ignoredConsolePatterns.some((re) => re.test(text))) return
    consoleErrors.push(text)
  })
  page.on('pageerror', (err) => consoleErrors.push(String(err)))

  const liveResponse = page.waitForResponse(
    (r) => r.url().includes('/api/cockpit/inbox/live') && r.status() === 200,
    { timeout: 15_000 },
  ).catch(() => null)

  await page.goto(dashUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await liveResponse
  await page.waitForSelector('.nx-inbox-shell', { timeout: 12_000 })
  await page.waitForSelector('[data-thread-id]', { timeout: 20_000 })
  await page.waitForFunction(
    () => window.__INBOX_PROOF__?.apiBootResponseMs != null,
    null,
    { timeout: 12_000 },
  ).catch(() => null)
  await warmThreadMessagesInBrowser(page, dashUrl.replace(/\/inbox$/, ''), 1)

  await page.waitForFunction(
    () => window.__INBOX_PROOF__?.apiBootResponseMs != null && window.__INBOX_PROOF__?.firstRowVisibleMs != null,
    null,
    { timeout: 12_000 },
  ).catch(() => null)

  const bootProof = await waitForProof(
    page,
    (p) => p.apiBootResponseMs != null && p.firstRowsPaintMs != null && p.shellToRowsMs != null && p.firstRowVisibleMs != null,
    12_000,
  )
  const painted = await page.evaluate(() => {
    const el = document.querySelector('.nx-inbox-shell') || document.querySelector('.nx-premium-inbox') || document.querySelector('.nx-sidebar-rebuilt')
    const rect = el?.getBoundingClientRect() ?? { width: 0, height: 0 }
    const rowCount = document.querySelectorAll('[data-thread-id]').length
    const firstRow = document.querySelector('[data-thread-id]')
    const rowRect = firstRow?.getBoundingClientRect() ?? { width: 0, height: 0 }
    return {
      width: rect.width,
      height: rect.height,
      rowCount,
      firstRowWidth: rowRect.width,
      firstRowHeight: rowRect.height,
      painted: rect.width > 200 && rect.height > 200 && rowCount > 0 && rowRect.height > 10,
    }
  })

  // Thread select BEFORE bucket switch so uncached timing is not polluted by bucket fetch.
  const rowCountBoot = await page.locator('[data-thread-id]').count()
  const uncachedRow = rowCountBoot > 1
    ? page.locator('[data-thread-id]').nth(1)
    : page.locator('[data-thread-id]').first()
  const firstRow = page.locator('[data-thread-id]').first()
  const firstThreadId = await uncachedRow.getAttribute('data-thread-id')
  let threadProof = bootProof
  let uncachedSnapshot = null
  let savedUncachedMessagesMs = null
  let threadSelect = null
  let optimisticDriven = []
  let parallelFetchObserved = 0
  let dossierParallelObserved = false
  if (firstThreadId) {
    await page.evaluate(() => {
      if (window.__INBOX_PROOF__) window.__INBOX_PROOF__.lastUncachedMessagesMs = null
    })
    await uncachedRow.click({ timeout: 5000 })
    await page.waitForFunction(
      () => window.__INBOX_PROOF__?.lastUncachedMessagesMs != null,
      null,
      { timeout: 12_000 },
    ).catch(() => null)
    await waitForProof(
      page,
      (p) => (p.maxParallelFetchStarted ?? 0) >= TARGETS.parallel_fetch_min && p.dossierParallelStarted === true,
      12_000,
    )
    uncachedSnapshot = await readProof(page)
    if (uncachedSnapshot) {
      savedUncachedMessagesMs = uncachedSnapshot.lastUncachedMessagesMs ?? null
      threadProof = { ...threadProof, ...uncachedSnapshot, lastUncachedMessagesMs: savedUncachedMessagesMs }
    }
    parallelFetchObserved = threadProof?.maxParallelFetchStarted ?? threadProof?.parallelFetchStarted ?? 0
    dossierParallelObserved = threadProof?.dossierParallelStarted === true

    await page.waitForSelector('.nx-chat-thread, .nx-conversation-panel, .nx-workspace-surface--conversation', { timeout: 10_000 }).catch(() => null)
    await page.waitForTimeout(150)

    await uncachedRow.click()
    const cachedProof = await waitForProof(
      page,
      (p) => p.lastThreadSelectCacheHit === true && p.lastThreadSelectCacheApplyMs != null,
      3000,
    )
    if (cachedProof) {
      threadProof = { ...threadProof, ...cachedProof, lastUncachedMessagesMs: savedUncachedMessagesMs }
    }
    parallelFetchObserved = Math.max(
      parallelFetchObserved,
      threadProof?.maxParallelFetchStarted ?? threadProof?.parallelFetchStarted ?? 0,
    )

    threadSelect = await page.evaluate(() => ({
      selectedCard: document.querySelector('[data-thread-id].is-selected, .nx-row25.is-selected') != null,
      conversationPanel: document.querySelector('.nx-chat-thread, .nx-conversation-panel, .nx-workspace-surface--conversation, .nx-workspace-pane.is-view-thread') != null,
    }))

    const rowCount = await page.locator('[data-thread-id]').count()
    if (rowCount > 8) {
      await page.locator('[data-thread-id]').nth(8).scrollIntoViewIfNeeded()
      await page.waitForTimeout(250)
    }
    const scrollProof = await waitForProof(page, (p) => (p.scrollOffset ?? 0) > 0, 1500)
    if (scrollProof) {
      threadProof = { ...threadProof, ...scrollProof, lastUncachedMessagesMs: savedUncachedMessagesMs }
    }

    if (threadProof?.hasDriveAction) {
      optimisticDriven = await driveOptimisticSuite(page)
      const optimisticProof = await readProof(page)
      if (optimisticProof) {
        threadProof = { ...threadProof, ...optimisticProof, lastUncachedMessagesMs: savedUncachedMessagesMs }
      }
    }
  }

  const bucketBtn = page.locator('.nx-cat-nav__item[data-category="new_replies"]').first()
  const allBucketBtn = page.locator('.nx-cat-nav__item[data-category="all_messages"]').first()
  let bucketProof = threadProof ?? bootProof
  let bucketChanged = false
  if (await bucketBtn.count()) {
    if (bucketProof?.activeBucketKey === 'new_replies' && await allBucketBtn.count()) {
      await allBucketBtn.click()
      await waitForProof(page, (p) => p.activeBucketKey === 'all_messages', 3000)
    }
    const bucketLive = page.waitForResponse(
      (r) => r.url().includes('/api/cockpit/inbox/live') && r.url().includes('new_repl') && r.status() === 200,
      { timeout: 8000 },
    ).catch(() => null)
    await bucketBtn.click()
    await bucketLive
    const bucketSwitchProof = await waitForProof(
      page,
      (p) => p.lastBucketTo === 'new_replies' && p.lastBucketSwitchMs != null,
      5000,
    ) ?? bucketProof
    bucketChanged = bucketSwitchProof?.lastBucketTo === 'new_replies' && bucketSwitchProof?.lastBucketSwitchMs != null
    bucketProof = bucketSwitchProof
    await page.waitForSelector('[data-thread-id]', { timeout: 5000 }).catch(() => null)
  }

  await page.screenshot({ path: path.join(SCRATCH, 'inbox-headless.png'), fullPage: false })
  await browser.close()

  const proof = { ...(bootProof ?? {}), ...(bucketProof ?? {}), ...(threadProof ?? {}) }
  const shellToRowsMs = bootProof?.shellToRowsMs
    ?? ((bootProof?.apiBootResponseMs ?? 0) + (bootProof?.firstRowsPaintMs ?? 0))
  const bridgeFirstRowDomMs = bootProof?.firstRowDomMs ?? null
  const firstRowDomMs = bridgeFirstRowDomMs
    ?? bootProof?.firstRowVisibleMs
    ?? bootProof?.shellToRowsMs
    ?? null
  const firstRowVisibleMs = bootProof?.firstRowVisibleMs ?? firstRowDomMs
  const lastUncachedMessagesMs = savedUncachedMessagesMs ?? threadProof?.lastUncachedMessagesMs ?? proof?.lastUncachedMessagesMs ?? null
  const optimisticActions = new Set((proof?.optimisticPatches ?? []).map((p) => p.action))

  return {
    proof,
    painted,
    firstRowDomMs,
    firstRowVisibleMs,
    shellToRowsMs,
    bucketChanged,
    threadSelect,
    optimisticDriven,
    optimisticActions: [...optimisticActions],
    bridgeFirstRowDomMs,
    lastUncachedMessagesMs,
    parallelFetchObserved,
    dossierParallelObserved,
    console_errors: consoleErrors,
    meets_targets: {
      proof_bridge_present: proof != null,
      shell_and_rows_under_1s: shellToRowsMs <= TARGETS.shell_to_rows_ms,
      first_row_visible_under_1s: firstRowVisibleMs <= TARGETS.first_row_visible_ms,
      first_row_dom_under_1s: firstRowDomMs <= TARGETS.first_row_visible_ms,
      bucket_switch_under_500ms: bucketChanged
        && bucketProof?.lastBucketSwitchMs != null
        && bucketProof.lastBucketSwitchMs <= TARGETS.bucket_switch_ms,
      bucket_switch_telemetry: bucketChanged,
      cached_thread_under_100ms: proof?.lastThreadSelectCacheHit === true
        && proof?.lastThreadSelectCacheApplyMs != null
        && proof.lastThreadSelectCacheApplyMs <= TARGETS.cached_thread_apply_ms,
      parallel_dossier_fetch: dossierParallelObserved
        && parallelFetchObserved >= TARGETS.parallel_fetch_min,
      uncached_messages_under_700ms: lastUncachedMessagesMs != null
        && lastUncachedMessagesMs <= TARGETS.uncached_messages_ms,
      optimistic_actions_complete: REQUIRED_OPTIMISTIC_ACTIONS.every((a) => optimisticActions.has(a)),
      scroll_offset_recorded: (proof?.scrollOffset ?? 0) > 0,
      fetch_in_flight_bounded: (proof?.maxFetchInFlight ?? proof?.fetchInFlight ?? 0) <= TARGETS.fetch_in_flight_max,
      inbox_live_requests_bounded: (proof?.inboxLiveRequestCount ?? 0) <= TARGETS.inbox_live_requests_max,
      no_degraded_poll_during_live: (proof?.degradedPollTicks ?? 0) === 0,
      no_selected_poll_during_live: (proof?.selectedPollTicks ?? 0) === 0,
      zero_console_errors: consoleErrors.length === 0,
      substantial_paint: painted.painted === true,
      thread_select_visible: threadSelect?.selectedCard || threadSelect?.conversationPanel || false,
    },
  }
}

async function startPreviewIfNeeded(apiBase) {
  if (process.env.INBOX_HEADLESS_URL) return { preview: null, dashUrl: process.env.INBOX_HEADLESS_URL, buildMode: 'external' }

  const dashPort = process.env.INBOX_HEADLESS_PORT || String(5180 + (process.pid % 40))
  const baseUrl = `http://127.0.0.1:${dashPort}`
  const dashUrl = `${baseUrl}/inbox`
  const buildEnv = {
    ...process.env,
    VITE_BACKEND_API_URL: '',
    VITE_DEV_PROXY_API_TARGET: apiBase,
  }

  if (process.env.INBOX_HEADLESS_SKIP_BUILD !== '1') {
    execSync('npx vite build', {
      cwd: DASHBOARD_ROOT,
      stdio: 'inherit',
      env: { ...buildEnv, VITE_BACKEND_API_URL: '' },
    })
  }

  const preview = spawn('npx', ['vite', 'preview', '--port', dashPort, '--host', '127.0.0.1'], {
    cwd: DASHBOARD_ROOT,
    env: buildEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await waitForHttp(`${baseUrl}/`, 120_000)
  await new Promise((r) => setTimeout(r, 400))
  return { preview, dashUrl, buildMode: 'preview' }
}

async function main() {
  fs.mkdirSync(SCRATCH, { recursive: true })
  if (!(await canRunPlaywright())) {
    const note = [
      '# Headless inbox verification — SKIPPED',
      'playwright CLI unavailable in this environment',
      `at: ${new Date().toISOString()}`,
    ].join('\n')
    fs.writeFileSync(path.join(SCRATCH, 'inbox-headless-skip.log'), note)
    console.log(note)
    return
  }

  const apiBase = process.env.BENCHMARK_API_BASE || 'http://localhost:3000'
  const { preview, dashUrl, buildMode } = await startPreviewIfNeeded(apiBase)
  await warmupInboxApi(dashUrl.replace(/\/inbox$/, ''))

  const runs = []
  for (let i = 0; i < 2; i += 1) {
    runs.push(await runOnce(dashUrl))
  }

  const best = runs.reduce((a, b) => {
    const aMs = a.firstRowVisibleMs ?? 9999
    const bMs = b.firstRowVisibleMs ?? 9999
    return aMs <= bMs ? a : b
  })

  const pass = runs.every((r) => {
    const t = r.meets_targets
    return t.proof_bridge_present
      && t.zero_console_errors
      && t.substantial_paint
      && t.thread_select_visible
      && t.shell_and_rows_under_1s
      && t.first_row_visible_under_1s
      && t.first_row_dom_under_1s
      && t.bucket_switch_under_500ms
      && t.bucket_switch_telemetry
      && t.cached_thread_under_100ms
      && t.uncached_messages_under_700ms
      && t.parallel_dossier_fetch
      && t.optimistic_actions_complete
      && t.fetch_in_flight_bounded
      && t.inbox_live_requests_bounded
      && t.no_degraded_poll_during_live
      && t.no_selected_poll_during_live
  })

  const results = {
    at: new Date().toISOString(),
    dashUrl,
    apiBase,
    buildMode,
    targets: TARGETS,
    required_optimistic_actions: REQUIRED_OPTIMISTIC_ACTIONS,
    runs,
    best,
    pass,
    api_perf_cross_check: 'endpoint latency in inbox-perf.log; client path in inbox-client-path.log',
    note: 'Assertions use window.__INBOX_PROOF__ telemetry from inbox.adapter + InboxPage shipped paths (production preview)',
  }

  fs.writeFileSync(path.join(SCRATCH, 'inbox-headless.log'), JSON.stringify(results, null, 2))
  console.log(JSON.stringify(results, null, 2))

  if (preview) preview.kill('SIGTERM')
  if (!pass) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})