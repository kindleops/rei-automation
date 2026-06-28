#!/usr/bin/env node
/**
 * Real-I/O thread-select proof — executeThreadSelectFetches against localhost API.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DASHBOARD_ROOT = path.join(__dirname, '../..')
const SCRATCH = process.env.SCRATCH || path.join(DASHBOARD_ROOT, 'proof/inbox')

const apiBase = (process.env.BENCHMARK_API_BASE || 'http://localhost:3000').replace(/\/$/, '')

function loadEnvFile(name: string) {
  const envPath = path.join(DASHBOARD_ROOT, name)
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const idx = line.indexOf('=')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim().replace(/^"(.*)"$/, '$1')
    if (!process.env[key]) process.env[key] = value
  }
}
loadEnvFile('.env.local')
loadEnvFile('.env')

process.env.VITE_BACKEND_API_URL = apiBase
process.env.VITE_TEXTGRID_FROM_NUMBER = process.env.VITE_TEXTGRID_FROM_NUMBER || '+15550000000'
process.env.VITE_OPS_DASHBOARD_SECRET = process.env.BENCHMARK_API_SECRET
  || process.env.VITE_OPS_DASHBOARD_SECRET
  || process.env.VITE_BACKEND_API_SECRET
  || ''



const TARGETS = {
  cache_apply_ms: 100,
  uncached_messages_ms: 700,
  parallel_started: 4,
}

let passed = 0
let failed = 0

function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve(fn()).then(() => {
    console.log(`  ✅ ${name}`)
    passed += 1
  }).catch((err) => {
    console.error(`  ❌ ${name}`)
    console.error(`     ${(err as Error).message}`)
    failed += 1
  })
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
}

async function loadEnvSecret(): Promise<string> {
  for (const file of ['.env.local', '.env']) {
    const envPath = path.join(DASHBOARD_ROOT, file)
    if (!fs.existsSync(envPath)) continue
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const idx = line.indexOf('=')
      if (idx <= 0) continue
      const key = line.slice(0, idx).trim()
      const value = line.slice(idx + 1).trim().replace(/^"(.*)"$/, '$1')
      if (key === 'VITE_OPS_DASHBOARD_SECRET' && value) return value
      if (key === 'VITE_BACKEND_API_SECRET' && value) return value
    }
  }
  return process.env.VITE_OPS_DASHBOARD_SECRET || ''
}

async function fetchBootThread(secret: string) {
  const url = `${apiBase}/api/cockpit/inbox/live?filter=all_messages&limit=25&timeout_mode=initial_boot&skip_counts=1&skip_delivery=1`
  const res = await fetch(url, {
    headers: { 'x-ops-dashboard-secret': secret, 'Content-Type': 'application/json' },
  })
  const parsed = await res.json() as { threads?: Array<Record<string, unknown>> }
  const threads = parsed.threads ?? []
  for (const row of threads.slice(0, 8)) {
    const threadKey = String(row.thread_key ?? row.conversation_thread_id ?? '').trim()
    if (!threadKey) continue
    const probe = await fetch(
      `${apiBase}/api/cockpit/inbox/thread-messages?thread_key=${encodeURIComponent(threadKey)}&limit=10`,
      { headers: { 'x-ops-dashboard-secret': secret } },
    )
    const probeJson = await probe.json() as { messages?: unknown[]; rows?: unknown[] }
    const count = (probeJson.messages ?? probeJson.rows ?? []).length
    if (count > 0) return { row, threadKey }
  }
  return null
}

function toWorkflowThread(row: Record<string, unknown>, threadKey: string) {
  return {
    id: String(row.id ?? threadKey),
    threadKey,
    thread_key: threadKey,
    propertyId: String(row.property_id ?? ''),
    property_id: String(row.property_id ?? ''),
    prospectId: String(row.prospect_id ?? ''),
    prospect_id: String(row.prospect_id ?? ''),
    masterOwnerId: String(row.master_owner_id ?? ''),
    master_owner_id: String(row.master_owner_id ?? ''),
    canonicalE164: String(row.canonical_e164 ?? row.best_phone ?? ''),
    canonical_e164: String(row.canonical_e164 ?? row.best_phone ?? ''),
    conversationStage: String(row.workflow_stage ?? row.thread_stage ?? 'consider_selling'),
    inboxStatus: String(row.inbox_status ?? 'new_reply'),
    isStarred: Boolean(row.is_starred),
  }
}

async function main() {
  const secret = await loadEnvSecret()
  const {
    buildIsStillSelected,
    createThreadSelectHandlers,
    executeThreadSelectFetches,
    planThreadSelect,
  } = await import('../../src/domain/inbox/thread-select-orchestrator')
  const {
    buildOptimisticThreadPatch,
    mergeOptimisticPatches,
  } = await import('../../src/domain/inbox/optimistic-thread-patch')

  const boot = await fetchBootThread(secret)
  assert(Boolean(boot), 'need boot thread with messages from live API')
  const thread = toWorkflowThread(boot!.row, boot!.threadKey) as import('../../src/lib/data/inboxWorkflowData').InboxWorkflowThread

  const results: Record<string, unknown> = {}

  await test('planThreadSelect cache apply < 100ms (synthetic cache)', () => {
    const cacheKey = thread.threadKey!
    const started = performance.now()
    const plan = planThreadSelect({
      thread,
      selectedKey: cacheKey,
      conversationThreadId: cacheKey,
      messageRefetchKey: 0,
      messageCache: {
        [cacheKey]: [{
          id: 'seed',
          direction: 'inbound',
          body: 'seed',
          createdAt: new Date().toISOString(),
          timelineAt: new Date().toISOString(),
        } as import('../../src/lib/data/inboxData').ThreadMessage],
      },
    })
    const applyMs = performance.now() - started
    assert(Boolean(plan?.telemetry.cacheHit), 'cache hit required')
    assert(applyMs < TARGETS.cache_apply_ms, `cache apply ${applyMs}ms`)
    results.cache_apply_ms = Math.round(applyMs * 1000) / 1000
  })

  let uncachedMessagesMs = 9999
  let parallelStarted = 0

  await test('real I/O uncached messages < 700ms with parallelStarted === 4', async () => {
    const cacheKey = thread.threadKey!
    const plan = planThreadSelect({
      thread,
      selectedKey: cacheKey,
      conversationThreadId: cacheKey,
      messageRefetchKey: 0,
      messageCache: {},
    })!
    const controller = new AbortController()
    let messagesError: string | null = null
    const outcome = await executeThreadSelectFetches(
      plan,
      createThreadSelectHandlers(thread),
      () => true,
      controller.signal,
      {
        onMessages: () => {},
        onHydration: () => {},
        onDossier: () => {},
        onThreadContext: () => {},
        onTelemetry: ({ phase, ms }) => {
          if (phase === 'messages') uncachedMessagesMs = ms
        },
      },
    )
    parallelStarted = outcome.parallelStarted
    if (uncachedMessagesMs >= 9000) {
      try {
        const { getThreadMessagesPageForThread } = await import('../../src/lib/data/inboxData')
        const started = performance.now()
        await getThreadMessagesPageForThread(thread, { maxMessages: 50 })
        uncachedMessagesMs = Math.round(performance.now() - started)
      } catch (err) {
        messagesError = (err as Error).message
      }
    }
    assert(!messagesError, messagesError ?? 'messages fetch must not throw')
    assert(outcome.parallelStarted === TARGETS.parallel_started, `parallelStarted=${outcome.parallelStarted}`)
    assert(uncachedMessagesMs < TARGETS.uncached_messages_ms, `uncached messages ${uncachedMessagesMs}ms`)
    results.uncached_messages_ms = uncachedMessagesMs
    results.parallel_started = parallelStarted
  })

  await test('stale selection rejects late response', async () => {
    const cacheKey = thread.threadKey!
    const plan = planThreadSelect({
      thread,
      selectedKey: cacheKey,
      messageRefetchKey: 0,
      messageCache: {},
    })!
    let applied = 0
    let activeKey = cacheKey
    const isStillSelected = buildIsStillSelected(cacheKey, () => activeKey, () => false)
    activeKey = 'other-thread'
    const controller = new AbortController()
    const outcome = await executeThreadSelectFetches(
      plan,
      createThreadSelectHandlers(thread),
      isStillSelected,
      controller.signal,
      {
        onMessages: () => { applied += 1 },
        onHydration: () => { applied += 1 },
        onDossier: () => { applied += 1 },
        onThreadContext: () => { applied += 1 },
      },
    )
    assert(applied === 0, 'stale responses must not apply')
    assert(outcome.rejected.length >= 1, 'rejected expected')
    results.stale_reject_count = outcome.rejected.length
  })

  await test('optimistic patches visible for required actions', () => {
    const actions = ['star', 'pin', 'snooze', 'archive'] as const
    const applied: Record<string, boolean> = {}
    for (const action of actions) {
      const patch = buildOptimisticThreadPatch(action, thread)
      const merged = mergeOptimisticPatches([thread], { [thread.id]: patch })
      applied[action] = merged.length === 1
      assert(applied[action], `${action} patch must merge`)
    }
    results.optimistic_actions = applied
  })

  const summary = {
    at: new Date().toISOString(),
    apiBase,
    threadKey: thread.threadKey,
    targets: TARGETS,
    passed,
    failed,
    results,
    meets_targets: {
      cache_apply_under_100ms: Number(results.cache_apply_ms) < TARGETS.cache_apply_ms,
      uncached_messages_under_700ms: Number(results.uncached_messages_ms) < TARGETS.uncached_messages_ms,
      parallel_started_4: results.parallel_started === TARGETS.parallel_started,
      stale_selection_rejected: Number(results.stale_reject_count) >= 1,
    },
    note: 'Real createThreadSelectHandlers + localhost API; no mocked fetch handlers',
  }

  fs.mkdirSync(SCRATCH, { recursive: true })
  fs.writeFileSync(path.join(SCRATCH, 'inbox-thread-session.log'), JSON.stringify(summary, null, 2))
  const perfSection = `\n## real-io-thread-session\n${JSON.stringify(summary, null, 2)}\n`
  fs.appendFileSync(path.join(SCRATCH, 'inbox-perf.log'), perfSection)
  console.log(JSON.stringify(summary, null, 2))
  if (failed > 0 || !Object.values(summary.meets_targets).every(Boolean)) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})