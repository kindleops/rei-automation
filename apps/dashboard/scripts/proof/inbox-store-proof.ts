/**
 * Inbox store proof tests — pure reducer, no React, no network.
 * Run: npx tsx scripts/proof/inbox-store-proof.ts
 */

import {
  inboxReducer,
  EMPTY_INBOX_STORE_STATE,
  emptyBucket,
  type InboxStoreState,
  type InboxStoreAction,
} from '../../src/modules/inbox/inbox-store.ts'

// ── Helpers ──────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✅ ${name}`)
    passed++
  } catch (err) {
    console.error(`  ❌ ${name}`)
    console.error(`     ${(err as Error).message}`)
    failed++
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(`${message}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
}

function dispatch(state: InboxStoreState, action: InboxStoreAction): InboxStoreState {
  return inboxReducer(state, action)
}

const row = (threadKey: string, extra?: Record<string, unknown>) => ({ threadKey, id: threadKey, inbox_bucket: threadKey, ...extra })

// ── Test 1: Stale bucket fetch response is ignored ────────────────────────────

console.log('\n── Test 1: Stale bucket fetch ──')

test('BUCKET_FETCH_DONE with wrong requestId is ignored', () => {
  let s = { ...EMPTY_INBOX_STORE_STATE }
  s = dispatch(s, { type: 'BUCKET_FETCH_START', bucketKey: 'priority', requestId: 'req-1' })
  // A second fetch starts before the first completes — req-2 is the latest
  s = dispatch(s, { type: 'BUCKET_FETCH_START', bucketKey: 'priority', requestId: 'req-2' })
  // req-1 response arrives late — must be ignored
  s = dispatch(s, { type: 'BUCKET_FETCH_DONE', bucketKey: 'priority', requestId: 'req-1', rows: [row('stale')], cursor: null, hasMore: false })
  assertEqual(s.buckets.priority?.rows.length ?? 0, 0, 'stale rows should not commit')
})

test('BUCKET_FETCH_DONE with correct requestId commits rows', () => {
  let s = { ...EMPTY_INBOX_STORE_STATE }
  s = dispatch(s, { type: 'BUCKET_FETCH_START', bucketKey: 'priority', requestId: 'req-1' })
  s = dispatch(s, { type: 'BUCKET_FETCH_DONE', bucketKey: 'priority', requestId: 'req-1', rows: [row('t1'), row('t2')], cursor: null, hasMore: false })
  assertEqual(s.buckets.priority?.rows.length, 2, 'fresh rows should commit')
})

// ── Test 2: Switching buckets never shows stale rows ─────────────────────────

console.log('\n── Test 2: Bucket switching isolation ──')

test('new_replies → all → new_replies: stale all rows never appear in new_replies', () => {
  let s = { ...EMPTY_INBOX_STORE_STATE, activeBucketKey: 'new_replies' as string }

  // Load initial new_replies rows
  s = dispatch(s, { type: 'BUCKET_FETCH_START', bucketKey: 'new_replies', requestId: 'nr-1' })
  s = dispatch(s, { type: 'BUCKET_FETCH_DONE', bucketKey: 'new_replies', requestId: 'nr-1', rows: [row('reply-A')], cursor: null, hasMore: false })

  // Switch to all
  s = dispatch(s, { type: 'SWITCH_BUCKET', bucketKey: 'all' })
  s = dispatch(s, { type: 'BUCKET_FETCH_START', bucketKey: 'all', requestId: 'all-1' })
  s = dispatch(s, { type: 'BUCKET_FETCH_DONE', bucketKey: 'all', requestId: 'all-1', rows: [row('reply-A'), row('cold-B'), row('dead-C')], cursor: null, hasMore: false })

  // Switch back to new_replies — new request
  s = dispatch(s, { type: 'SWITCH_BUCKET', bucketKey: 'new_replies' })
  s = dispatch(s, { type: 'BUCKET_FETCH_START', bucketKey: 'new_replies', requestId: 'nr-2' })
  s = dispatch(s, { type: 'BUCKET_FETCH_DONE', bucketKey: 'new_replies', requestId: 'nr-2', rows: [row('reply-A'), row('reply-D')], cursor: null, hasMore: false })

  // Active bucket is new_replies
  assertEqual(s.activeBucketKey, 'new_replies', 'active bucket must be new_replies')
  assertEqual(s.buckets['new_replies']?.rows.length, 2, 'new_replies must have 2 rows')
  // all rows did not bleed into new_replies
  const nrKeys = (s.buckets['new_replies']?.rows as Record<string, unknown>[]).map((r) => r.threadKey)
  assert(!nrKeys.includes('cold-B'), 'cold-B must not appear in new_replies')
  assert(!nrKeys.includes('dead-C'), 'dead-C must not appear in new_replies')
})

test('stale new_replies response after switching to all is discarded', () => {
  let s = { ...EMPTY_INBOX_STORE_STATE, activeBucketKey: 'new_replies' as string }
  s = dispatch(s, { type: 'BUCKET_FETCH_START', bucketKey: 'new_replies', requestId: 'nr-1' })
  // Switch to all before nr-1 completes
  s = dispatch(s, { type: 'SWITCH_BUCKET', bucketKey: 'all' })
  s = dispatch(s, { type: 'BUCKET_FETCH_START', bucketKey: 'new_replies', requestId: 'nr-2' }) // new req for nr
  // nr-1 arrives late
  s = dispatch(s, { type: 'BUCKET_FETCH_DONE', bucketKey: 'new_replies', requestId: 'nr-1', rows: [row('stale')], cursor: null, hasMore: false })
  assertEqual(s.buckets['new_replies']?.rows.length ?? 0, 0, 'stale nr-1 response must be ignored')
})

// ── Test 3: Thread messages cannot cross-contaminate ─────────────────────────

console.log('\n── Test 3: Thread message isolation ──')

test('opening Thread B then A: B messages do not appear in A', () => {
  let s = { ...EMPTY_INBOX_STORE_STATE }

  // Open Thread A
  s = dispatch(s, { type: 'SELECT_THREAD', threadKey: 'thread-A' })
  s = dispatch(s, { type: 'MESSAGES_FETCH_START', threadKey: 'thread-A', requestId: 'a-1' })

  // User clicks Thread B before A loads
  s = dispatch(s, { type: 'SELECT_THREAD', threadKey: 'thread-B' })
  s = dispatch(s, { type: 'MESSAGES_FETCH_START', threadKey: 'thread-B', requestId: 'b-1' })

  // B's messages arrive
  s = dispatch(s, { type: 'MESSAGES_FETCH_DONE', threadKey: 'thread-B', requestId: 'b-1', messages: [{ id: 'msg-B1', threadKey: 'thread-B' }] })

  // A's messages arrive (stale — user already moved to B)
  s = dispatch(s, { type: 'MESSAGES_FETCH_DONE', threadKey: 'thread-A', requestId: 'a-1', messages: [{ id: 'msg-A1', threadKey: 'thread-A' }] })

  // Verify: A has its own messages, B has its own
  assertEqual(s.messagesByThreadKey['thread-A']?.messages.length, 1, 'thread-A must have 1 message')
  assertEqual(s.messagesByThreadKey['thread-B']?.messages.length, 1, 'thread-B must have 1 message')
  assert(
    (s.messagesByThreadKey['thread-A']?.messages[0] as Record<string, unknown>)?.id === 'msg-A1',
    'thread-A must contain msg-A1, not msg-B1',
  )
  assertEqual(s.selectedThreadKey, 'thread-B', 'selected thread is B')
})

test('stale message response is ignored', () => {
  let s = { ...EMPTY_INBOX_STORE_STATE }
  s = dispatch(s, { type: 'SELECT_THREAD', threadKey: 'thread-A' })
  s = dispatch(s, { type: 'MESSAGES_FETCH_START', threadKey: 'thread-A', requestId: 'm-1' })
  // Second fetch starts (user re-clicked)
  s = dispatch(s, { type: 'MESSAGES_FETCH_START', threadKey: 'thread-A', requestId: 'm-2' })
  // m-1 arrives late
  s = dispatch(s, { type: 'MESSAGES_FETCH_DONE', threadKey: 'thread-A', requestId: 'm-1', messages: [{ id: 'stale' }] })
  assertEqual(s.messagesByThreadKey['thread-A']?.messages.length ?? 0, 0, 'stale m-1 must be ignored, messages stay empty')
})

test('Thread A → B → A: second A open gets A messages, not B messages', () => {
  let s = { ...EMPTY_INBOX_STORE_STATE }
  // Open A
  s = dispatch(s, { type: 'SELECT_THREAD', threadKey: 'thread-A' })
  s = dispatch(s, { type: 'MESSAGES_FETCH_START', threadKey: 'thread-A', requestId: 'a-1' })
  s = dispatch(s, { type: 'MESSAGES_FETCH_DONE', threadKey: 'thread-A', requestId: 'a-1', messages: [{ id: 'A-msg' }] })
  // Open B
  s = dispatch(s, { type: 'SELECT_THREAD', threadKey: 'thread-B' })
  s = dispatch(s, { type: 'MESSAGES_FETCH_START', threadKey: 'thread-B', requestId: 'b-1' })
  s = dispatch(s, { type: 'MESSAGES_FETCH_DONE', threadKey: 'thread-B', requestId: 'b-1', messages: [{ id: 'B-msg' }] })
  // Open A again
  s = dispatch(s, { type: 'SELECT_THREAD', threadKey: 'thread-A' })
  s = dispatch(s, { type: 'MESSAGES_FETCH_START', threadKey: 'thread-A', requestId: 'a-2' })
  s = dispatch(s, { type: 'MESSAGES_FETCH_DONE', threadKey: 'thread-A', requestId: 'a-2', messages: [{ id: 'A-msg' }, { id: 'A-msg2' }] })
  // A must have A's messages
  const aMessages = s.messagesByThreadKey['thread-A']?.messages as Record<string, unknown>[]
  assert(aMessages.every((m) => String(m.id).startsWith('A-')), 'thread-A must only have A messages')
  assertEqual(aMessages.length, 2, 'thread-A must have 2 messages')
})

// ── Test 4: Realtime patch updates only the matching thread ──────────────────

console.log('\n── Test 4: Realtime patch isolation ──')

test('REALTIME_PATCH_THREAD updates only the matching thread row', () => {
  let s = { ...EMPTY_INBOX_STORE_STATE }
  // Two buckets with rows
  s = dispatch(s, { type: 'BUCKET_FETCH_START', bucketKey: 'priority', requestId: 'p-1' })
  s = dispatch(s, { type: 'BUCKET_FETCH_DONE', bucketKey: 'priority', requestId: 'p-1', rows: [row('t-hot'), row('t-warm')], cursor: null, hasMore: false })
  s = dispatch(s, { type: 'BUCKET_FETCH_START', bucketKey: 'new_replies', requestId: 'nr-1' })
  s = dispatch(s, { type: 'BUCKET_FETCH_DONE', bucketKey: 'new_replies', requestId: 'nr-1', rows: [row('t-reply')], cursor: null, hasMore: false })

  // Realtime event for t-hot
  s = dispatch(s, { type: 'REALTIME_PATCH_THREAD', threadKey: 't-hot', patch: { preview: 'new preview' } })

  // Only t-hot is patched
  const pRows = s.buckets['priority']?.rows as Record<string, unknown>[]
  assertEqual((pRows.find((r) => r.threadKey === 't-hot') as Record<string, unknown>)?.preview as string, 'new preview', 't-hot preview must update')
  assert((pRows.find((r) => r.threadKey === 't-warm') as Record<string, unknown>)?.preview !== 'new preview', 't-warm must not be patched')
  // new_replies untouched
  const nrRows = s.buckets['new_replies']?.rows as Record<string, unknown>[]
  assert((nrRows[0] as Record<string, unknown>)?.preview !== 'new preview', 'new_replies rows must not be patched')
})

test('REALTIME_PATCH_THREAD with unknown threadKey changes nothing', () => {
  let s = { ...EMPTY_INBOX_STORE_STATE }
  s = dispatch(s, { type: 'BUCKET_FETCH_START', bucketKey: 'priority', requestId: 'p-1' })
  s = dispatch(s, { type: 'BUCKET_FETCH_DONE', bucketKey: 'priority', requestId: 'p-1', rows: [row('t-known')], cursor: null, hasMore: false })
  const before = s.buckets['priority']?.rows[0]
  s = dispatch(s, { type: 'REALTIME_PATCH_THREAD', threadKey: 't-unknown', patch: { preview: 'injected' } })
  assert(s.buckets['priority']?.rows[0] === before, 'no row must change when threadKey is unknown')
})

// ── Test 5: KPI fetch failure does not touch inbox rows ──────────────────────

console.log('\n── Test 5: KPI / counts isolation ──')

test('SET_VIEW_COUNTS does not change bucket rows', () => {
  let s = { ...EMPTY_INBOX_STORE_STATE }
  s = dispatch(s, { type: 'BUCKET_FETCH_START', bucketKey: 'priority', requestId: 'p-1' })
  s = dispatch(s, { type: 'BUCKET_FETCH_DONE', bucketKey: 'priority', requestId: 'p-1', rows: [row('t1')], cursor: null, hasMore: false })
  const rowsBefore = s.buckets['priority']?.rows

  // KPI update
  s = dispatch(s, { type: 'SET_VIEW_COUNTS', counts: { priority: 42, new_replies: 7 } })

  assert(s.buckets['priority']?.rows === rowsBefore, 'bucket rows must not change on SET_VIEW_COUNTS')
  assertEqual(s.viewCounts.priority, 42, 'viewCounts.priority must be 42')
  assertEqual(s.viewCounts.new_replies, 7, 'viewCounts.new_replies must be 7')
})

test('BUCKET_FETCH_ERROR keeps existing rows, only sets error field', () => {
  let s = { ...EMPTY_INBOX_STORE_STATE }
  s = dispatch(s, { type: 'BUCKET_FETCH_START', bucketKey: 'priority', requestId: 'p-1' })
  s = dispatch(s, { type: 'BUCKET_FETCH_DONE', bucketKey: 'priority', requestId: 'p-1', rows: [row('t1')], cursor: null, hasMore: false })
  const goodRows = s.buckets['priority']?.rows

  // New fetch errors out
  s = dispatch(s, { type: 'BUCKET_FETCH_START', bucketKey: 'priority', requestId: 'p-2' })
  s = dispatch(s, { type: 'BUCKET_FETCH_ERROR', bucketKey: 'priority', requestId: 'p-2', error: 'timeout' })

  assert(s.buckets['priority']?.rows === goodRows, 'rows must survive a fetch error')
  assertEqual(s.buckets['priority']?.error, 'timeout', 'error field must be set')
})

// ── Test 6: SWITCH_BUCKET never leaks other bucket rows ──────────────────────

console.log('\n── Test 6: SWITCH_BUCKET isolation ──')

test('active bucket key changes; other buckets are untouched', () => {
  let s = { ...EMPTY_INBOX_STORE_STATE, activeBucketKey: 'priority' as string }
  s = dispatch(s, { type: 'BUCKET_FETCH_START', bucketKey: 'priority', requestId: 'p-1' })
  s = dispatch(s, { type: 'BUCKET_FETCH_DONE', bucketKey: 'priority', requestId: 'p-1', rows: [row('hot')], cursor: null, hasMore: false })
  const priorityRows = s.buckets['priority']?.rows

  s = dispatch(s, { type: 'SWITCH_BUCKET', bucketKey: 'new_replies' })

  assertEqual(s.activeBucketKey, 'new_replies', 'active bucket must be new_replies')
  // priority bucket untouched
  assert(s.buckets['priority']?.rows === priorityRows, 'priority rows must be unchanged after switch')
  // new_replies starts empty (not loaded yet)
  assertEqual(s.buckets['new_replies']?.rows.length ?? 0, 0, 'new_replies must start empty')
})

// ── Test 7: Canonical bucket alias mapping ────────────────────────────────────
// These aliases must never appear as bucket keys inside the store — only canonical keys.
// This is a documentation/contract proof: canonical keys the reducer accepts.

console.log('\n── Test 7: Canonical bucket key contract ──')

const CANONICAL_BUCKETS = ['all_messages', 'new_replies', 'priority', 'needs_review', 'follow_up', 'cold', 'suppressed', 'dead'] as const

test('BUCKET_FETCH_DONE with each canonical key commits rows', () => {
  for (const key of CANONICAL_BUCKETS) {
    let s = { ...EMPTY_INBOX_STORE_STATE }
    s = dispatch(s, { type: 'BUCKET_FETCH_START', bucketKey: key, requestId: `req-${key}` })
    s = dispatch(s, { type: 'BUCKET_FETCH_DONE', bucketKey: key, requestId: `req-${key}`, rows: [row(`thread-${key}`)], cursor: null, hasMore: false })
    assert(s.buckets[key]?.rows.length === 1, `canonical bucket "${key}" must accept rows`)
  }
})

test('alias keys are independent from canonical keys (no alias bleeding)', () => {
  let s = { ...EMPTY_INBOX_STORE_STATE }
  // Load canonical 'new_replies'
  s = dispatch(s, { type: 'BUCKET_FETCH_START', bucketKey: 'new_replies', requestId: 'nr-1' })
  s = dispatch(s, { type: 'BUCKET_FETCH_DONE', bucketKey: 'new_replies', requestId: 'nr-1', rows: [row('reply-row')], cursor: null, hasMore: false })
  // A response arriving under a legacy alias key ('needs_reply') must not pollute 'new_replies'
  s = dispatch(s, { type: 'BUCKET_FETCH_START', bucketKey: 'needs_reply', requestId: 'alias-1' })
  s = dispatch(s, { type: 'BUCKET_FETCH_DONE', bucketKey: 'needs_reply', requestId: 'alias-1', rows: [row('alias-row')], cursor: null, hasMore: false })
  // 'new_replies' must still contain only the canonical rows
  assertEqual(s.buckets['new_replies']?.rows.length, 1, 'new_replies must not be affected by alias bucket')
  assert((s.buckets['new_replies']?.rows[0] as Record<string, unknown>)?.threadKey === 'reply-row', 'new_replies row must be the original canonical row')
})

// ── Test 8: Thread key normalization contract ─────────────────────────────────
// The reducer compares rows by threadKey || id. Both must work as identifiers.

console.log('\n── Test 8: Thread key identity (threadKey vs id) ──')

test('REALTIME_PATCH_THREAD matches row by id when threadKey is absent', () => {
  let s = { ...EMPTY_INBOX_STORE_STATE }
  // Row stored with only `id`, no `threadKey`
  s = dispatch(s, { type: 'BUCKET_FETCH_START', bucketKey: 'priority', requestId: 'p-1' })
  s = dispatch(s, { type: 'BUCKET_FETCH_DONE', bucketKey: 'priority', requestId: 'p-1', rows: [{ id: 'row-by-id', inbox_bucket: 'priority' }], cursor: null, hasMore: false })
  s = dispatch(s, { type: 'REALTIME_PATCH_THREAD', threadKey: 'row-by-id', patch: { preview: 'patched' } })
  const pRows = s.buckets['priority']?.rows as Record<string, unknown>[]
  assertEqual(pRows[0]?.preview as string, 'patched', 'row must be patchable by id when threadKey is absent')
})

test('REALTIME_PATCH_THREAD matches row by threadKey when id differs', () => {
  let s = { ...EMPTY_INBOX_STORE_STATE }
  s = dispatch(s, { type: 'BUCKET_FETCH_START', bucketKey: 'new_replies', requestId: 'nr-1' })
  s = dispatch(s, { type: 'BUCKET_FETCH_DONE', bucketKey: 'new_replies', requestId: 'nr-1', rows: [{ id: 'internal-id', threadKey: 'phone:+16125550101', inbox_bucket: 'new_replies' }], cursor: null, hasMore: false })
  s = dispatch(s, { type: 'REALTIME_PATCH_THREAD', threadKey: 'phone:+16125550101', patch: { preview: 'new message' } })
  const nrRows = s.buckets['new_replies']?.rows as Record<string, unknown>[]
  assertEqual(nrRows[0]?.preview as string, 'new message', 'row must be patchable by threadKey even when id is different')
})

// ── Test 9: Map pins cannot create synthetic inbox rows ───────────────────────
// The reducer's inbox rows only come from BUCKET_FETCH_DONE/BUCKET_APPEND_ROWS.
// No other action inserts rows into buckets.

console.log('\n── Test 9: No synthetic row injection ──')

test('REALTIME_PATCH_THREAD with a new threadKey does not insert a row', () => {
  let s = { ...EMPTY_INBOX_STORE_STATE }
  s = dispatch(s, { type: 'BUCKET_FETCH_START', bucketKey: 'priority', requestId: 'p-1' })
  s = dispatch(s, { type: 'BUCKET_FETCH_DONE', bucketKey: 'priority', requestId: 'p-1', rows: [row('existing')], cursor: null, hasMore: false })
  const countBefore = s.buckets['priority']?.rows.length ?? 0
  // Realtime event for a thread that has never been loaded
  s = dispatch(s, { type: 'REALTIME_PATCH_THREAD', threadKey: 'map-pin-synthetic', patch: { preview: 'injected' } })
  assertEqual(s.buckets['priority']?.rows.length, countBefore, 'REALTIME_PATCH_THREAD must not insert new rows')
  // No bucket should contain the synthetic row
  for (const bucket of Object.values(s.buckets)) {
    const bucketSlice = bucket as import('../../src/modules/inbox/inbox-store.ts').BucketSlice
    const synthetic = (bucketSlice.rows as Record<string, unknown>[]).find(r => r.threadKey === 'map-pin-synthetic' || r.id === 'map-pin-synthetic')
    assert(!synthetic, `synthetic map pin row must not appear in any bucket`)
  }
})

test('SELECT_THREAD does not insert a row into any bucket', () => {
  let s = { ...EMPTY_INBOX_STORE_STATE }
  s = dispatch(s, { type: 'BUCKET_FETCH_START', bucketKey: 'priority', requestId: 'p-1' })
  s = dispatch(s, { type: 'BUCKET_FETCH_DONE', bucketKey: 'priority', requestId: 'p-1', rows: [], cursor: null, hasMore: false })
  s = dispatch(s, { type: 'SELECT_THREAD', threadKey: 'any-thread-key' })
  assertEqual(s.buckets['priority']?.rows.length, 0, 'SELECT_THREAD must not insert rows into any bucket')
  assertEqual(s.selectedThreadKey, 'any-thread-key', 'selectedThreadKey must be set')
})

// ── Test 10: Abort / superseded request safety ───────────────────────────────
// Simulates what happens when runLoad aborts the previous controller and fires a
// new request. The stale request must NEVER commit rows or fallback_error.

console.log('\n── Test 10: Abort / superseded request safety ──')

test('request A aborted by request B: A completion does not overwrite B rows', () => {
  let s = { ...EMPTY_INBOX_STORE_STATE }
  // Request A starts
  s = dispatch(s, { type: 'BUCKET_FETCH_START', bucketKey: 'all_messages', requestId: 'A' })
  // Request B supersedes A — BUCKET_FETCH_START advances lastRequestId to B
  s = dispatch(s, { type: 'BUCKET_FETCH_START', bucketKey: 'all_messages', requestId: 'B' })
  // B succeeds first with real rows
  s = dispatch(s, { type: 'BUCKET_FETCH_DONE', bucketKey: 'all_messages', requestId: 'B', rows: [row('thread-1'), row('thread-2')], cursor: null, hasMore: false })
  const goodRows = s.buckets['all_messages']?.rows
  // A eventually resolves (because withTimeout didn't cancel the network request) with empty fallback
  s = dispatch(s, { type: 'BUCKET_FETCH_DONE', bucketKey: 'all_messages', requestId: 'A', rows: [], cursor: null, hasMore: false })
  assert(s.buckets['all_messages']?.rows === goodRows, 'stale A response must not overwrite B rows')
  assertEqual(s.buckets['all_messages']?.rows.length, 2, 'B rows must be intact')
})

test('request A aborted by B: A error does not set error state', () => {
  let s = { ...EMPTY_INBOX_STORE_STATE }
  s = dispatch(s, { type: 'BUCKET_FETCH_START', bucketKey: 'needs_review', requestId: 'A' })
  s = dispatch(s, { type: 'BUCKET_FETCH_START', bucketKey: 'needs_review', requestId: 'B' })
  s = dispatch(s, { type: 'BUCKET_FETCH_DONE', bucketKey: 'needs_review', requestId: 'B', rows: [row('r1')], cursor: null, hasMore: false })
  // Stale A errors out (e.g. 10s timeout fired before withTimeout abort fix)
  s = dispatch(s, { type: 'BUCKET_FETCH_ERROR', bucketKey: 'needs_review', requestId: 'A', error: 'timed out' })
  assertEqual(s.buckets['needs_review']?.error, null, 'stale A error must not set error state')
  assertEqual(s.buckets['needs_review']?.rows.length, 1, 'B rows must be intact')
})

test('StrictMode double mount: first mount aborted, second mount commits correctly', () => {
  let s = { ...EMPTY_INBOX_STORE_STATE }
  // Mount 1: starts all_messages
  s = dispatch(s, { type: 'BUCKET_FETCH_START', bucketKey: 'all_messages', requestId: 'mount1-req' })
  // StrictMode cleanup fires before mount1-req resolves: mount 2 supersedes
  s = dispatch(s, { type: 'BUCKET_FETCH_START', bucketKey: 'all_messages', requestId: 'mount2-req' })
  // Mount 1's response arrives (ghost): must be discarded
  s = dispatch(s, { type: 'BUCKET_FETCH_DONE', bucketKey: 'all_messages', requestId: 'mount1-req', rows: [], cursor: null, hasMore: false })
  assertEqual(s.buckets['all_messages']?.rows.length ?? 0, 0, 'loading state preserved — mount1 ghost discarded')
  assert(s.buckets['all_messages']?.loading === true, 'still loading — mount2 request is active')
  // Mount 2's response: should commit
  s = dispatch(s, { type: 'BUCKET_FETCH_DONE', bucketKey: 'all_messages', requestId: 'mount2-req', rows: [row('live-t1'), row('live-t2'), row('live-t3')], cursor: null, hasMore: false })
  assertEqual(s.buckets['all_messages']?.rows.length, 3, 'mount2 rows must commit successfully')
  assertEqual(s.buckets['all_messages']?.loading, false, 'loading must be false after mount2 success')
  assertEqual(s.buckets['all_messages']?.error, null, 'no error after clean mount2 success')
})

test('initial activeBucketKey is all_messages (not priority)', () => {
  assertEqual(EMPTY_INBOX_STORE_STATE.activeBucketKey, 'all_messages', 'initial activeBucketKey must be all_messages to align with InboxPage viewFilter')
})

test('aborted request preserves previous good rows (error does not clear bucket)', () => {
  let s = { ...EMPTY_INBOX_STORE_STATE }
  // First successful load
  s = dispatch(s, { type: 'BUCKET_FETCH_START', bucketKey: 'priority', requestId: 'req-1' })
  s = dispatch(s, { type: 'BUCKET_FETCH_DONE', bucketKey: 'priority', requestId: 'req-1', rows: [row('good-1'), row('good-2')], cursor: null, hasMore: false })
  const savedRows = s.buckets['priority']?.rows
  // Second fetch starts
  s = dispatch(s, { type: 'BUCKET_FETCH_START', bucketKey: 'priority', requestId: 'req-2' })
  // req-2 errors (e.g. real backend timeout)
  s = dispatch(s, { type: 'BUCKET_FETCH_ERROR', bucketKey: 'priority', requestId: 'req-2', error: 'Live Inbox request timed out' })
  // Rows must be preserved
  assert(s.buckets['priority']?.rows === savedRows, 'rows must survive a fetch error — never cleared')
  assertEqual(s.buckets['priority']?.rows.length, 2, 'original 2 rows must still be present')
  assertEqual(s.buckets['priority']?.error, 'Live Inbox request timed out', 'error field is set for UI banner')
})

// ── Test 11: Counts enrichment failure must not poison live rows ─────────────
// Simulates the scenario where /live succeeds but the background counts
// fetch (fetchDealContextCounts) times out or errors. The model must commit
// with dataMode: 'live', real rows, and fallback counts from the /live response.

console.log('\n── Test 11: Counts enrichment failure safety ──')

test('rows commit even when counts enrichment fails (counts timeout = live counts used)', () => {
  // This tests the reducer: rows dispatched with good requestId commit regardless
  // of whether a separate counts update was dispatched.
  let s = { ...EMPTY_INBOX_STORE_STATE }
  s = dispatch(s, { type: 'BUCKET_FETCH_START', bucketKey: 'all_messages', requestId: 'r1' })
  // Rows arrive from live endpoint — no counts dispatch yet (counts timed out)
  s = dispatch(s, { type: 'BUCKET_FETCH_DONE', bucketKey: 'all_messages', requestId: 'r1', rows: [row('t1'), row('t2'), row('t3')], cursor: null, hasMore: true })
  assertEqual(s.buckets['all_messages']?.rows.length, 3, 'rows must commit even without counts')
  assertEqual(s.buckets['all_messages']?.loading, false, 'loading must be false')
  assertEqual(s.buckets['all_messages']?.error, null, 'no error — counts timeout is not a row error')
})

test('SET_VIEW_COUNTS enriches counts after rows are committed (delayed counts)', () => {
  let s = { ...EMPTY_INBOX_STORE_STATE }
  s = dispatch(s, { type: 'BUCKET_FETCH_START', bucketKey: 'all_messages', requestId: 'r1' })
  s = dispatch(s, { type: 'BUCKET_FETCH_DONE', bucketKey: 'all_messages', requestId: 'r1', rows: [row('t1')], cursor: null, hasMore: false })
  // Rows committed with live-embedded counts: all_messages = 50 (from viewCounts)
  s = dispatch(s, { type: 'SET_VIEW_COUNTS', counts: { all_messages: 50, priority: 3, new_replies: 7 } })
  assertEqual(s.viewCounts.all_messages, 50, 'all_messages count must reflect enriched value')
  assertEqual(s.viewCounts.priority, 3, 'priority count must be set')
  // Rows are untouched
  assertEqual(s.buckets['all_messages']?.rows.length, 1, 'rows must not change when counts are enriched')
})

test('counts enrichment failure does not set BUCKET_FETCH_ERROR', () => {
  // Counts failure is silent — it never triggers BUCKET_FETCH_ERROR.
  // The error from the counts endpoint must not propagate to the bucket state.
  let s = { ...EMPTY_INBOX_STORE_STATE }
  s = dispatch(s, { type: 'BUCKET_FETCH_START', bucketKey: 'all_messages', requestId: 'r1' })
  s = dispatch(s, { type: 'BUCKET_FETCH_DONE', bucketKey: 'all_messages', requestId: 'r1', rows: [row('t1'), row('t2')], cursor: null, hasMore: false })
  const rowsBefore = s.buckets['all_messages']?.rows
  // No BUCKET_FETCH_ERROR dispatched (counts failure is handled internally in fetchInboxModel)
  assertEqual(s.buckets['all_messages']?.error, null, 'no error on bucket when only counts fail')
  assert(s.buckets['all_messages']?.rows === rowsBefore, 'rows must be preserved')
})

test('zero-state is never created by counts failure alone', () => {
  // If rows succeeded and counts failed, the bucket must have rows and loading=false.
  let s = { ...EMPTY_INBOX_STORE_STATE }
  s = dispatch(s, { type: 'BUCKET_FETCH_START', bucketKey: 'needs_review', requestId: 'nr1' })
  s = dispatch(s, { type: 'BUCKET_FETCH_DONE', bucketKey: 'needs_review', requestId: 'nr1', rows: [row('r1'), row('r2'), row('r3')], cursor: null, hasMore: false })
  // Simulate: counts fetch timed out, fallback counts used (all 0)
  s = dispatch(s, { type: 'SET_VIEW_COUNTS', counts: { needs_review: 0, all_messages: 0 } })
  // Rows must be intact — zero counts don't mean zero rows
  assertEqual(s.buckets['needs_review']?.rows.length, 3, 'rows must not be cleared when counts are zero')
  assertEqual(s.viewCounts.needs_review, 0, 'counts can be zero without affecting rows')
})

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n── Results: ${passed} passed, ${failed} failed ──\n`)
if (failed > 0) process.exit(1)
