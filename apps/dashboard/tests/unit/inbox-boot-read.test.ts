import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyInboxCountsFetchResult,
  classifyInboxBackendFailure,
  planInboxMountFetches,
  resolveInboxLiveDataMode,
  resolveThreadFetchCommit,
} from '../../src/domain/inbox/inbox-boot-read.ts'

test('mount plan fetches category counts immediately', () => {
  const plan = planInboxMountFetches()
  assert.equal(plan.fetchCountsImmediately, true)
  assert.equal(plan.fetchThreads, true)
})

test('counts fetch does not require successful thread load', () => {
  const applied = applyInboxCountsFetchResult({
    ok: true,
    status: 200,
    payload: {
      counts: {
        all_messages: 120,
        priority: 4,
        new_replies: 9,
      },
    },
  })
  assert.equal(applied.ok, true)
  assert.equal(applied.counts?.all_messages, 120)
  assert.equal(applied.counts?.priority, 4)
})

test('thread fetch failure path still classifies counts fetch auth errors', () => {
  const applied = applyInboxCountsFetchResult({
    ok: false,
    status: 401,
    payload: { error: 'missing_ops_dashboard_secret_token' },
    isDev: false,
  })
  assert.equal(applied.ok, false)
  assert.match(String(applied.warning ?? ''), /authentication failed/i)
})

test('degraded empty thread response is not live', () => {
  const mode = resolveInboxLiveDataMode({
    threadCount: 0,
    degraded: true,
    fallbackUsed: true,
    apiDataMode: 'stale_snapshot',
  })
  assert.notEqual(mode, 'live')
})

test('timeout empty response returns degraded_timeout', () => {
  const mode = resolveInboxLiveDataMode({
    threadCount: 0,
    degraded: true,
    apiDataMode: 'timeout_preserved',
    errorCode: 'live_inbox_timeout',
  })
  assert.equal(mode, 'degraded_timeout')
})

test('prior cached rows are preserved when degraded response arrives', () => {
  const action = resolveThreadFetchCommit({
    dataMode: 'fallback_error',
    incomingThreadCount: 0,
    currentRowCount: 12,
  })
  assert.equal(action, 'preserve_cache')
})

test('401 becomes auth_error not live', () => {
  const failure = classifyInboxBackendFailure({
    status: 401,
    error: 'missing_ops_dashboard_secret_token',
    isDev: false,
  })
  assert.equal(failure.dataMode, 'auth_error')
  assert.equal(failure.diagnosticCode, 'auth_error')
})

test('local backend unreachable becomes backend_unavailable with dev hint', () => {
  const failure = classifyInboxBackendFailure({
    status: 502,
    error: 'BACKEND_UNAVAILABLE',
    message: 'Backend unreachable at http://localhost:3000/api/cockpit/inbox/live',
    isDev: true,
  })
  assert.equal(failure.dataMode, 'backend_unavailable')
  assert.match(failure.message, /npm run dev:all/i)
})

test('successful production-like response commits live rows and counts', () => {
  const mode = resolveInboxLiveDataMode({
    threadCount: 25,
    degraded: false,
    fallbackUsed: false,
    apiDataMode: null,
  })
  assert.equal(mode, 'live')

  const counts = applyInboxCountsFetchResult({
    ok: true,
    status: 200,
    payload: { counts: { all_messages: 9097, priority: 154 } },
  })
  assert.equal(counts.ok, true)
  assert.equal(counts.counts?.all_messages, 9097)
})

test('counts can render when threads are temporarily unavailable', () => {
  const threadMode = resolveInboxLiveDataMode({
    threadCount: 0,
    degraded: true,
    apiDataMode: 'timeout_preserved',
  })
  assert.notEqual(threadMode, 'live')

  const counts = applyInboxCountsFetchResult({
    ok: true,
    status: 200,
    payload: { counts: { all_messages: 500, new_replies: 12 } },
  })
  assert.equal(counts.ok, true)
  assert.equal(counts.counts?.new_replies, 12)
})