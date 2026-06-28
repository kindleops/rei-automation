#!/usr/bin/env node
/**
 * Client-path proof — verifies real parallel thread-select network requests and cached re-open timing.
 * Complements endpoint-only inbox-perf-verification.mjs with shipped InboxPage behavior.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DASHBOARD_ROOT = path.join(__dirname, '../..')
const SCRATCH = process.env.SCRATCH || path.join(DASHBOARD_ROOT, 'proof/inbox')

const TARGETS = {
  cached_thread_apply_ms: 100,
  parallel_fetch_min: 4,
  parallel_network_min: 3,
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

async function startPreview(apiBase) {
  if (process.env.INBOX_HEADLESS_URL) return { preview: null, dashUrl: process.env.INBOX_HEADLESS_URL }

  const dashPort = process.env.INBOX_CLIENT_PATH_PORT || String(5280 + (process.pid % 40))
  const baseUrl = `http://127.0.0.1:${dashPort}`
  const dashUrl = `${baseUrl}/inbox`
  const env = { ...process.env, VITE_BACKEND_API_URL: '', VITE_DEV_PROXY_API_TARGET: apiBase }

  if (process.env.INBOX_HEADLESS_SKIP_BUILD !== '1') {
    execSync('npx vite build', { cwd: DASHBOARD_ROOT, stdio: 'inherit', env: { ...env, VITE_BACKEND_API_URL: '' } })
  }

  const preview = spawn('npx', ['vite', 'preview', '--port', dashPort, '--host', '127.0.0.1'], {
    cwd: DASHBOARD_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await waitForHttp(`${baseUrl}/`, 120_000)
  return { preview, dashUrl }
}

async function runClientPathProof(dashUrl) {
  const { chromium } = await import('@playwright/test')
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

  await page.goto(dashUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForSelector('[data-thread-id]', { timeout: 12_000 })

  const firstRow = page.locator('[data-thread-id]').first()
  const parallelKinds = new Set()
  const parallelWaits = [
    page.waitForResponse((r) => r.url().includes('/api/cockpit/inbox/thread-messages') && r.status() === 200, { timeout: 10_000 }).then(() => parallelKinds.add('thread-messages')).catch(() => null),
    page.waitForResponse((r) => r.url().includes('/api/cockpit/inbox/thread-hydration') && r.status() === 200, { timeout: 10_000 }).then(() => parallelKinds.add('thread-hydration')).catch(() => null),
    page.waitForResponse((r) => r.url().includes('/api/cockpit/deal-intelligence/thread/') && r.status() === 200, { timeout: 10_000 }).then(() => parallelKinds.add('deal-intelligence')).catch(() => null),
    page.waitForResponse((r) => r.url().includes('/api/cockpit/inbox/thread-context') && r.status() === 200, { timeout: 10_000 }).then(() => parallelKinds.add('thread-context')).catch(() => null),
  ]

  const uncachedStarted = performance.now()
  await firstRow.click()
  await Promise.all(parallelWaits)
  const uncachedMs = Math.round(performance.now() - uncachedStarted)

  const uncachedProof = await page.evaluate(() => window.__INBOX_PROOF__)

  await firstRow.click()
  const cachedProof = await page.waitForFunction(() => {
    const proof = window.__INBOX_PROOF__
    return proof?.lastThreadSelectCacheHit === true && proof?.lastThreadSelectCacheApplyMs != null
      ? proof
      : null
  }, null, { timeout: 3000 }).then((h) => h.jsonValue()).catch(() => null)

  await browser.close()

  const maxParallel = uncachedProof?.maxParallelFetchStarted ?? uncachedProof?.parallelFetchStarted ?? 0
  const cachedApplyMs = cachedProof?.lastThreadSelectCacheApplyMs ?? null

  return {
    uncachedMs,
    parallelKinds: [...parallelKinds],
    maxParallelFetchStarted: maxParallel,
    dossierParallelStarted: uncachedProof?.dossierParallelStarted === true,
    cachedApplyMs,
    cachedCacheHit: cachedProof?.lastThreadSelectCacheHit === true,
    meets_targets: {
      parallel_network_kinds: parallelKinds.size >= TARGETS.parallel_network_min,
      parallel_fetch_telemetry: maxParallel >= TARGETS.parallel_fetch_min,
      dossier_parallel: uncachedProof?.dossierParallelStarted === true,
      cached_thread_under_100ms: cachedProof?.lastThreadSelectCacheHit === true
        && cachedApplyMs != null
        && cachedApplyMs <= TARGETS.cached_thread_apply_ms,
    },
  }
}

async function main() {
  fs.mkdirSync(SCRATCH, { recursive: true })
  const apiBase = process.env.BENCHMARK_API_BASE || 'http://localhost:3000'
  const { preview, dashUrl } = await startPreview(apiBase)
  const result = await runClientPathProof(dashUrl)
  const pass = Object.values(result.meets_targets).every(Boolean)

  const payload = {
    at: new Date().toISOString(),
    dashUrl,
    apiBase,
    targets: TARGETS,
    result,
    pass,
    note: 'Real handleSelect + thread-select effect via production preview; not seeded cache simulation',
  }

  fs.writeFileSync(path.join(SCRATCH, 'inbox-client-path.log'), JSON.stringify(payload, null, 2))
  console.log(JSON.stringify(payload, null, 2))

  if (preview) preview.kill('SIGTERM')
  if (!pass) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})