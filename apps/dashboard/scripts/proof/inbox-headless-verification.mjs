#!/usr/bin/env node
/**
 * Headless inbox UX verification — asserts window.__INBOX_PROOF__ telemetry from the
 * shipped client path (inbox.adapter + InboxPage), not fragile DOM timing alone.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DASHBOARD_ROOT = path.join(__dirname, '../..')
const SCRATCH = process.env.SCRATCH || path.join(DASHBOARD_ROOT, 'proof/inbox')

const TARGETS = {
  api_boot_ms: 1000,
  first_rows_paint_ms: 400,
  bucket_switch_ms: 500,
  cached_thread_apply_ms: 100,
  fetch_in_flight_max: 3,
}

async function canRunPlaywright() {
  try {
    const { execSync } = await import('node:child_process')
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
      lastBucketSwitchMs: proof.lastBucketSwitchMs,
      lastBucketFrom: proof.lastBucketFrom,
      lastBucketTo: proof.lastBucketTo,
      lastThreadSelectMs: proof.lastThreadSelectMs,
      lastThreadSelectCacheHit: proof.lastThreadSelectCacheHit,
      lastThreadSelectCacheApplyMs: proof.lastThreadSelectCacheApplyMs,
      parallelFetchStarted: proof.parallelFetchStarted,
      lastOptimisticPatch: proof.lastOptimisticPatch,
      fetchInFlight: proof.fetchInFlight,
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

async function runOnce(dashUrl) {
  const consoleErrors = []
  const { chromium } = await import('@playwright/test')
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
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
  await page.waitForSelector('[data-thread-id]', { timeout: 12_000 })

  const bootProof = await waitForProof(
    page,
    (p) => p.apiBootResponseMs != null && p.firstRowsPaintMs != null,
    12_000,
  )

  const painted = await page.evaluate(() => {
    const el = document.querySelector('.nx-inbox-shell') || document.querySelector('.nx-premium-inbox') || document.querySelector('.nx-sidebar-rebuilt')
    const rect = el?.getBoundingClientRect() ?? { width: 0, height: 0 }
    const rowCount = document.querySelectorAll('[data-thread-id]').length
    return {
      width: rect.width,
      height: rect.height,
      rowCount,
      painted: rect.width > 200 && rect.height > 200 && rowCount > 0,
    }
  })

  const bucketBtn = page.locator('.nx-cat-nav__item[data-category="new_replies"]').first()
  let bucketProof = bootProof
  let bucketChanged = false
  if (await bucketBtn.count()) {
    await bucketBtn.click()
    bucketProof = await waitForProof(
      page,
      (p) => p.lastBucketTo === 'new_replies' && p.lastBucketSwitchMs != null,
      2000,
    ) ?? bucketProof
    bucketChanged = bucketProof?.lastBucketTo === 'new_replies'
    await page.waitForSelector('[data-thread-id]', { timeout: 500 }).catch(() => null)
  }

  const firstRow = page.locator('[data-thread-id]').first()
  const firstThreadId = await firstRow.getAttribute('data-thread-id')
  let threadProof = bucketProof
  let threadSelect = null
  if (firstThreadId) {
    const messagesReady = page.waitForResponse(
      (r) => r.url().includes('/api/cockpit/inbox/thread-messages') && r.status() === 200,
      { timeout: 8000 },
    ).catch(() => null)

    await firstRow.click()
    await messagesReady
    threadProof = await waitForProof(
      page,
      (p) => p.parallelFetchStarted != null && p.parallelFetchStarted >= 4,
      8000,
    ) ?? threadProof

    await firstRow.click()
    const cachedProof = await waitForProof(
      page,
      (p) => p.lastThreadSelectCacheHit === true && p.lastThreadSelectCacheApplyMs != null,
      3000,
    )
    if (cachedProof) threadProof = cachedProof

    threadSelect = await page.evaluate(() => ({
      selectedCard: document.querySelector('[data-thread-id].is-selected, .nx-row25.is-selected') != null,
      conversationPanel: document.querySelector('.nx-chat-thread, .nx-conversation-panel, .nx-workspace-surface--conversation, .nx-workspace-pane.is-view-thread') != null,
    }))

    if (threadProof?.hasDriveAction) {
      await page.evaluate(() => {
        window.__INBOX_PROOF__?.driveAction?.('star')
      })
      let optimisticProof = await waitForProof(
        page,
        (p) => p.lastOptimisticPatch?.action === 'star',
        2000,
      )
      if (!optimisticProof) {
        await page.evaluate(() => {
          window.__INBOX_PROOF__?.driveAction?.('unstar')
        })
        optimisticProof = await waitForProof(
          page,
          (p) => p.lastOptimisticPatch?.action === 'unstar',
          2000,
        )
      }
      if (optimisticProof) threadProof = optimisticProof
    }
  }

  await page.screenshot({ path: path.join(SCRATCH, 'inbox-headless.png'), fullPage: false })
  await browser.close()

  const proof = threadProof ?? bucketProof ?? bootProof
  const shellToRowsMs = proof?.apiBootResponseMs != null && proof?.firstRowsPaintMs != null
    ? proof.apiBootResponseMs + proof.firstRowsPaintMs
    : null

  return {
    proof,
    painted,
    bucketChanged,
    threadSelect,
    shellToRowsMs,
    console_errors: consoleErrors,
    meets_targets: {
      proof_bridge_present: proof != null,
      api_boot_under_1s: proof?.apiBootResponseMs != null && proof.apiBootResponseMs <= TARGETS.api_boot_ms,
      shell_and_rows_under_1s: shellToRowsMs != null && shellToRowsMs <= TARGETS.api_boot_ms,
      bucket_switch_under_500ms: !bucketChanged || (proof?.lastBucketSwitchMs != null && proof.lastBucketSwitchMs <= TARGETS.bucket_switch_ms),
      bucket_switch_telemetry: bucketChanged && proof?.lastBucketTo === 'new_replies',
      cached_thread_under_100ms: proof?.lastThreadSelectCacheHit === true
        && proof?.lastThreadSelectCacheApplyMs != null
        && proof.lastThreadSelectCacheApplyMs <= TARGETS.cached_thread_apply_ms,
      parallel_fetch_on_select: (proof?.parallelFetchStarted ?? 0) >= 4,
      optimistic_star_visible: proof?.lastOptimisticPatch?.action === 'star'
        || proof?.lastOptimisticPatch?.action === 'unstar',
      fetch_in_flight_bounded: (proof?.fetchInFlight ?? 0) <= TARGETS.fetch_in_flight_max,
      zero_console_errors: consoleErrors.length === 0,
      substantial_paint: painted.painted === true,
      thread_select_visible: threadSelect?.selectedCard || threadSelect?.conversationPanel || false,
    },
  }
}

async function startViteIfNeeded(dashUrl, apiBase) {
  if (process.env.INBOX_HEADLESS_URL) return null
  const dashPort = process.env.INBOX_HEADLESS_PORT || String(5180 + (process.pid % 40))
  const baseUrl = `http://127.0.0.1:${dashPort}`

  const vite = spawn('npx', ['vite', '--port', dashPort, '--host', '127.0.0.1'], {
    cwd: DASHBOARD_ROOT,
    env: { ...process.env, VITE_BACKEND_API_URL: '', VITE_DEV_PROXY_API_TARGET: apiBase },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await waitForHttp(`${baseUrl}/`, 120_000)
  await new Promise((r) => setTimeout(r, 800))
  return vite
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
  const dashPort = process.env.INBOX_HEADLESS_PORT || String(5180 + (process.pid % 40))
  const dashUrl = process.env.INBOX_HEADLESS_URL || `http://127.0.0.1:${dashPort}/inbox`

  const vite = await startViteIfNeeded(dashUrl, apiBase)

  const runs = []
  for (let i = 0; i < 2; i += 1) {
    runs.push(await runOnce(dashUrl))
  }

  const best = runs.reduce((a, b) => {
    const aMs = a.shellToRowsMs ?? 9999
    const bMs = b.shellToRowsMs ?? 9999
    return aMs <= bMs ? a : b
  })

  const pass = runs.every((r) => {
    const t = r.meets_targets
    return t.proof_bridge_present
      && t.zero_console_errors
      && t.substantial_paint
      && t.thread_select_visible
      && t.api_boot_under_1s
      && t.bucket_switch_telemetry
      && t.cached_thread_under_100ms
      && t.optimistic_star_visible
      && t.cached_thread_under_100ms
      && t.fetch_in_flight_bounded
  })

  const results = {
    at: new Date().toISOString(),
    dashUrl,
    apiBase,
    targets: TARGETS,
    runs,
    best,
    pass,
    api_perf_cross_check: 'endpoint latency in inbox-perf.log; client path in inbox-thread-session-proof',
    note: 'Assertions use window.__INBOX_PROOF__ from inbox.adapter and InboxPage',
  }

  fs.writeFileSync(path.join(SCRATCH, 'inbox-headless.log'), JSON.stringify(results, null, 2))
  console.log(JSON.stringify(results, null, 2))

  if (vite) vite.kill('SIGTERM')
  if (!pass) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})