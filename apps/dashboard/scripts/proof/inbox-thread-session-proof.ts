/**
 * Thread-select orchestrator proof — exercises the shipped client path (no React).
 * Run: npx tsx scripts/proof/inbox-thread-session-proof.ts
 * Appends client-path section to SCRATCH/inbox-perf.log
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { InboxWorkflowThread } from '../../src/lib/data/inboxWorkflowData'
import type { ThreadMessage } from '../../src/lib/data/inboxData'
import {
  buildIsStillSelected,
  executeThreadSelectFetches,
  planThreadSelect,
} from '../../src/domain/inbox/thread-select-orchestrator'
import {
  buildOptimisticThreadPatch,
  mergeOptimisticPatches,
} from '../../src/domain/inbox/optimistic-thread-patch'
import { resetInboxProofForTests } from '../../src/domain/inbox/inbox-proof-bridge'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SCRATCH = process.env.SCRATCH || path.join(__dirname, '../../proof/inbox')

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

const thread: InboxWorkflowThread = {
  id: 'thread-1',
  threadKey: 'ct:prospect:1|property:2|owner:mo_1|phone:+15551234567',
  propertyId: '2',
  prospectId: '1',
  masterOwnerId: 'mo_1',
  canonicalE164: '+15551234567',
  conversationStage: 'consider_selling',
  inboxStatus: 'new_reply',
  isStarred: false,
} as InboxWorkflowThread

const cachedMessage: ThreadMessage = {
  id: 'm1',
  direction: 'inbound',
  body: 'Yes',
  createdAt: '2026-06-28T00:00:00.000Z',
  timelineAt: '2026-06-28T00:00:00.000Z',
} as ThreadMessage

async function main() {
  resetInboxProofForTests()
  const results: Record<string, unknown> = {}

  console.log('\n── Thread select orchestrator proof ──')

  await test('planThreadSelect cache hit apply < 100ms', () => {
    const cacheKey = thread.threadKey!
    const started = performance.now()
    const plan = planThreadSelect({
      thread,
      selectedKey: cacheKey,
      conversationThreadId: cacheKey,
      messageRefetchKey: 0,
      messageCache: { [cacheKey]: [cachedMessage] },
    })
    const applyMs = performance.now() - started
    assert(Boolean(plan), 'plan required')
    assert(plan!.telemetry.cacheHit, 'cache hit expected')
    assert(plan!.immediate.selectedMessages.length === 1, 'immediate messages expected')
    assert(applyMs < 100, `cache apply ${applyMs}ms must be < 100ms`)
    results.cache_hit_apply_ms = Math.round(applyMs * 1000) / 1000
    results.planned_parallel_count = plan!.telemetry.plannedParallelCount
  })

  await test('executeThreadSelectFetches fans out parallel fetches', async () => {
    const cacheKey = thread.threadKey!
    const plan = planThreadSelect({
      thread,
      selectedKey: cacheKey,
      messageRefetchKey: 0,
      messageCache: {},
    })!
    const started: string[] = []
    const controller = new AbortController()
    const outcome = await executeThreadSelectFetches(
      plan,
      {
        messages: async () => {
          started.push('messages')
          await new Promise((r) => setTimeout(r, 5))
          return { kind: 'messages', messages: [cachedMessage], hasMore: false }
        },
        hydration: async () => {
          started.push('hydration')
          await new Promise((r) => setTimeout(r, 5))
          return { kind: 'hydration', messages: [], hasMore: false }
        },
        dossier: async () => {
          started.push('dossier')
          await new Promise((r) => setTimeout(r, 5))
          return { kind: 'dossier', dealContext: null }
        },
        thread_context: async () => {
          started.push('thread_context')
          await new Promise((r) => setTimeout(r, 5))
          return { kind: 'thread_context', context: null }
        },
      },
      () => true,
      controller.signal,
      {
        onMessages: () => {},
        onHydration: () => {},
        onDossier: () => {},
        onThreadContext: () => {},
      },
    )
    assert(outcome.parallelStarted === 4, `parallelStarted=${outcome.parallelStarted}`)
    assert(started.length === 4, `started=${started.join(',')}`)
    results.parallel_started = outcome.parallelStarted
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
      {
        messages: async () => ({ kind: 'messages', messages: [cachedMessage], hasMore: false }),
        hydration: async () => ({ kind: 'hydration', messages: [], hasMore: false }),
        dossier: async () => ({ kind: 'dossier' }),
        thread_context: async () => ({ kind: 'thread_context', context: null }),
      },
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

  await test('optimistic patches visible for all required actions', () => {
    const actions: Array<{ action: Parameters<typeof buildOptimisticThreadPatch>[0]; key: string; check: (t: InboxWorkflowThread) => boolean }> = [
      { action: 'star', key: 'star', check: (t) => t.isStarred === true },
      { action: 'pin', key: 'pin', check: (t) => t.isPinned === true },
      { action: 'snooze', key: 'snooze', check: (t) => t.inboxStatus === 'waiting' },
      { action: { type: 'stage', stage: 'consider_selling' }, key: 'stage', check: (t) => t.conversationStage === 'consider_selling' },
      { action: { type: 'status', status: 'waiting' }, key: 'status', check: (t) => t.inboxStatus === 'waiting' },
      { action: 'archive', key: 'archive', check: (t) => t.isArchived === true },
    ]
    const applied: Record<string, boolean> = {}
    for (const item of actions) {
      const patch = buildOptimisticThreadPatch(item.action, thread)
      const merged = mergeOptimisticPatches([thread], { [thread.id]: patch })
      applied[item.key] = item.check(merged[0])
      assert(applied[item.key], `${item.key} patch must merge`)
    }
    results.optimistic_actions = applied
  })

  await test('planThreadSelect mirrors handleSelect cache-first entry', () => {
    const cacheKey = thread.threadKey!
    const handleSelectPlan = planThreadSelect({
      thread,
      selectedKey: cacheKey,
      conversationThreadId: cacheKey,
      messageRefetchKey: 0,
      messageCache: { [cacheKey]: [cachedMessage] },
    })
    assert(handleSelectPlan?.telemetry.cacheHit === true, 'handleSelect cache hit')
    assert(handleSelectPlan?.immediate.selectedMessages.length === 1, 'immediate messages from cache')
    assert(handleSelectPlan?.fetches.length === 4, 'parallel fetch plan')
    results.handle_select_cache_hit = handleSelectPlan?.telemetry.cacheHit
    results.handle_select_parallel_count = handleSelectPlan?.fetches.length
  })

  const summary = {
    at: new Date().toISOString(),
    passed,
    failed,
    client_path: results,
    meets_targets: {
      cache_hit_under_100ms: Number(results.cache_hit_apply_ms) < 100,
      parallel_fetch_count_4: results.parallel_started === 4,
      stale_selection_rejected: Number(results.stale_reject_count) >= 1,
      optimistic_actions_all: results.optimistic_actions != null
        && Object.values(results.optimistic_actions as Record<string, boolean>).every(Boolean),
      handle_select_cache_hit: results.handle_select_cache_hit === true,
      handle_select_parallel_count_4: results.handle_select_parallel_count === 4,
    },
  }

  fs.mkdirSync(SCRATCH, { recursive: true })
  const section = `\n## client-path (inbox-thread-session-proof)\n${JSON.stringify(summary, null, 2)}\n`
  const perfLog = path.join(SCRATCH, 'inbox-perf.log')
  fs.appendFileSync(perfLog, section)
  console.log(`\n── Results: ${passed} passed, ${failed} failed ──`)
  console.log(JSON.stringify(summary, null, 2))
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})