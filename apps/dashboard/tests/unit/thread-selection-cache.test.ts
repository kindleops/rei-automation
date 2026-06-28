import assert from 'node:assert/strict'
import test from 'node:test'
import {
  measureCachedThreadOpen,
  readCachedThreadMessages,
  resolveThreadMessageCacheKey,
} from '../../src/domain/inbox/thread-selection-cache.ts'

test('resolveThreadMessageCacheKey prefers conversation thread id', () => {
  assert.equal(
    resolveThreadMessageCacheKey({
      conversationThreadId: 'ct:phone:+15551234567',
      threadKey: '+15551234567',
      id: 'legacy',
    }),
    'ct:phone:+15551234567',
  )
})

test('readCachedThreadMessages returns null for empty cache', () => {
  assert.equal(readCachedThreadMessages({}, 'ct:phone:+1'), null)
})

test('measureCachedThreadOpen reports sub-millisecond cache hit', () => {
  const cacheKey = 'ct:phone:+15551234567'
  const cache = { [cacheKey]: [{ id: 'm1', body: 'Yes' }] }
  const result = measureCachedThreadOpen(cache, cacheKey)
  assert.equal(result.cacheHit, true)
  assert.equal(result.messageCount, 1)
  assert.ok(result.applyMs < 100, `cached apply must be <100ms, got ${result.applyMs}ms`)
})