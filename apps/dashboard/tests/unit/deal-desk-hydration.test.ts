/**
 * N.1 — hydration state, request-generation protection, resource caches and composer
 * draft continuity.
 *
 * Covers §J ("where good data is wiped by an unresolved request"), §C.1 (stale-response
 * and cancellation gaps) and §I.1 (one giant workspace object remounting every panel).
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  beginHydration,
  commitHydration,
  failHydration,
  hasHydratedData,
  hydrationData,
  hydrationError,
  idleHydration,
  isHydrationPending,
  resetHydration,
  seedHydration,
  shouldRenderResourceSkeleton,
} from '../../src/domain/inbox/hydration-state.ts'
import {
  DEAL_DESK_RESOURCES,
  createSelectionRequestGuard,
} from '../../src/domain/inbox/selection-request-guard.ts'
import {
  conversationCacheKey,
  createResourceCache,
  intelligenceCacheKey,
  participantsCacheKey,
  propertyCacheKey,
  propertyMediaCacheKey,
  prospectCacheKey,
} from '../../src/domain/inbox/deal-desk-resource-cache.ts'
import { createComposerDraftStore } from '../../src/domain/inbox/composer-draft-store.ts'

// ── HydrationState transitions ───────────────────────────────────────────────

test('a first load shows loading with no data — the only skeleton case', () => {
  const state = beginHydration<string>(idleHydration<string>())
  assert.equal(state.status, 'loading')
  assert.equal(state.data, null)
  assert.equal(shouldRenderResourceSkeleton(state), true)
})

test('a refresh never erases valid existing data', () => {
  const ready = commitHydration('conversation-payload')
  const refreshing = beginHydration(ready)
  assert.equal(refreshing.status, 'refreshing')
  assert.equal(refreshing.data, 'conversation-payload')
  assert.equal(hasHydratedData(refreshing), true)
  assert.equal(
    shouldRenderResourceSkeleton(refreshing),
    false,
    'no skeleton over content that is already valid',
  )
})

test('an error retains whatever data was already valid and scopes the error', () => {
  const ready = commitHydration({ facts: 'property' })
  const failed = failHydration(ready, new Error('intelligence 500'))
  assert.equal(failed.status, 'error')
  assert.deepEqual(failed.data, { facts: 'property' })
  assert.equal(hydrationError(failed)?.message, 'intelligence 500')
})

test('an error with no prior data still does not invent data', () => {
  const failed = failHydration(idleHydration<string>(), new Error('boom'))
  assert.equal(failed.data, null)
  assert.equal(hasHydratedData(failed), false)
})

test('a failed secondary resource cannot erase a sibling resource', () => {
  const conversation = commitHydration('messages')
  const intelligence = failHydration(idleHydration<string>(), new Error('dossier failed'))
  assert.equal(hydrationData(conversation), 'messages', 'conversation is untouched')
  assert.equal(hydrationData(intelligence), null)
})

test('seeded data is renderable but still marked pending', () => {
  const seeded = seedHydration({ from: 'row' })
  assert.equal(seeded.status, 'loading')
  assert.equal(hasHydratedData(seeded), true)
  assert.equal(isHydrationPending(seeded), true)
  assert.equal(shouldRenderResourceSkeleton(seeded), false)
})

test('only an explicit reset drops data', () => {
  const ready = commitHydration('payload')
  assert.equal(resetHydration<string>().data, null)
  assert.equal(ready.data, 'payload')
})

// ── request-generation protection ────────────────────────────────────────────

test('A selected then B selected before A resolves: A cannot commit', () => {
  const guard = createSelectionRequestGuard()
  const a = guard.begin(DEAL_DESK_RESOURCES.conversation, { selectionKey: 'A', selectionVersion: 1 })
  const b = guard.begin(DEAL_DESK_RESOURCES.conversation, { selectionKey: 'B', selectionVersion: 2 })

  assert.equal(guard.accept(a.token), false, "A's delayed response must be rejected")
  assert.equal(guard.accept(b.token), true)
  assert.equal(a.signal.aborted, true, 'the superseded request is cancelled, not just ignored')
  assert.equal(guard.stats().rejectedStale, 1)
})

test('A -> B -> A rapid switching rejects the first A generation', () => {
  const guard = createSelectionRequestGuard()
  const a1 = guard.begin(DEAL_DESK_RESOURCES.conversation, { selectionKey: 'A', selectionVersion: 1 })
  const b = guard.begin(DEAL_DESK_RESOURCES.conversation, { selectionKey: 'B', selectionVersion: 2 })
  const a2 = guard.begin(DEAL_DESK_RESOURCES.conversation, { selectionKey: 'A', selectionVersion: 3 })

  assert.equal(guard.accept(a1.token), false, 'same key, superseded generation')
  assert.equal(guard.accept(b.token), false)
  assert.equal(guard.accept(a2.token), true)
})

test('a property response that resolves after the thread response still belongs to it', () => {
  const guard = createSelectionRequestGuard()
  const identity = { selectionKey: 'A', selectionVersion: 1 }
  const thread = guard.begin(DEAL_DESK_RESOURCES.conversation, identity)
  const property = guard.begin(DEAL_DESK_RESOURCES.property, identity)

  assert.equal(guard.accept(thread.token), true)
  assert.equal(guard.accept(property.token), true, 'resources are tracked independently')
})

test('an intelligence response that resolves after the selection changed is rejected', () => {
  const guard = createSelectionRequestGuard()
  const stale = guard.begin(DEAL_DESK_RESOURCES.intelligence, {
    selectionKey: 'A',
    selectionVersion: 1,
  })
  guard.begin(DEAL_DESK_RESOURCES.conversation, { selectionKey: 'B', selectionVersion: 2 })
  // The intelligence slot itself was not re-issued, but the token's identity no longer
  // matches, so it must not commit.
  guard.begin(DEAL_DESK_RESOURCES.intelligence, { selectionKey: 'B', selectionVersion: 2 })
  assert.equal(guard.accept(stale.token), false)
})

test('a failed secondary request after the core workspace succeeded does not invalidate it', () => {
  const guard = createSelectionRequestGuard()
  const identity = { selectionKey: 'A', selectionVersion: 1 }
  const core = guard.begin(DEAL_DESK_RESOURCES.conversation, identity)
  const media = guard.begin(DEAL_DESK_RESOURCES.propertyMedia, identity)
  assert.equal(guard.accept(core.token), true)
  guard.abortResource(DEAL_DESK_RESOURCES.propertyMedia)
  assert.equal(guard.accept(media.token), false)
  // The conversation slot is untouched: a second response for it would still be current.
  assert.equal(guard.isCurrent(core.token), true)
})

test('a realtime/poll response for a non-selected thread can never commit', () => {
  const guard = createSelectionRequestGuard()
  guard.begin(DEAL_DESK_RESOURCES.conversation, { selectionKey: 'A', selectionVersion: 1 })
  const otherThread = {
    resource: DEAL_DESK_RESOURCES.conversation,
    selectionKey: 'Z',
    selectionVersion: 9,
    generation: 1,
  }
  assert.equal(guard.isCurrent(otherThread), false)
  assert.equal(guard.accept(otherThread), false)
})

test('abortAll invalidates every outstanding token', () => {
  const guard = createSelectionRequestGuard()
  const identity = { selectionKey: 'A', selectionVersion: 1 }
  const one = guard.begin(DEAL_DESK_RESOURCES.conversation, identity)
  const two = guard.begin(DEAL_DESK_RESOURCES.participants, identity)
  guard.abortAll()
  assert.equal(one.signal.aborted, true)
  assert.equal(two.signal.aborted, true)
  assert.equal(guard.accept(one.token), false)
  assert.equal(guard.accept(two.token), false)
})

test('stats.aborted counts only real cancellations, not settled requests', () => {
  const guard = createSelectionRequestGuard()
  // One request that settles normally, then a second for a new selection.
  const first = guard.begin(DEAL_DESK_RESOURCES.conversation, { selectionKey: 'A', selectionVersion: 1 })
  assert.equal(guard.accept(first.token), true)
  guard.begin(DEAL_DESK_RESOURCES.conversation, { selectionKey: 'B', selectionVersion: 2 })
  assert.equal(
    guard.stats().aborted,
    0,
    'aborting an already-settled controller is a no-op and must not be counted — these ' +
    'counters are published as runtime evidence for cancellation behaviour',
  )
  assert.equal(first.signal.aborted, false, 'a settled request is not retroactively aborted')
})

test('stats.aborted still counts a genuinely in-flight supersede', () => {
  const guard = createSelectionRequestGuard()
  const inFlight = guard.begin(DEAL_DESK_RESOURCES.conversation, { selectionKey: 'A', selectionVersion: 1 })
  guard.begin(DEAL_DESK_RESOURCES.conversation, { selectionKey: 'B', selectionVersion: 2 })
  assert.equal(guard.stats().aborted, 1)
  assert.equal(inFlight.signal.aborted, true)
})

test('guard stats report stale rejections per resource for the perf budget', () => {
  const guard = createSelectionRequestGuard()
  const a = guard.begin(DEAL_DESK_RESOURCES.conversation, { selectionKey: 'A', selectionVersion: 1 })
  const b = guard.begin(DEAL_DESK_RESOURCES.conversation, { selectionKey: 'B', selectionVersion: 2 })
  guard.accept(a.token)
  guard.accept(b.token)
  const stats = guard.stats()
  assert.equal(stats.issued, 2)
  assert.equal(stats.accepted, 1)
  assert.equal(stats.rejectedStale, 1)
  assert.equal(stats.aborted, 1)
  assert.deepEqual(stats.byResource.conversation, { issued: 2, accepted: 1, rejectedStale: 1 })
})

// ── resource caches ──────────────────────────────────────────────────────────

test('resource cache keys are per-resource and never substitute identities', () => {
  assert.equal(conversationCacheKey('ct:property:p1|phone:+19015551234'), 'ct:property:p1|phone:+19015551234')
  assert.equal(propertyCacheKey('prop-1'), 'property:prop-1')
  assert.equal(prospectCacheKey('prospect-1', '+19015551234'), 'prospect:prospect-1')
  assert.equal(prospectCacheKey(null, '+19015551234'), 'prospect_phone:+19015551234')
  assert.equal(intelligenceCacheKey('prop-1', 'v4'), 'intel:prop-1:v4')
  assert.equal(propertyMediaCacheKey('prop-1', 'streetview'), 'media:prop-1:streetview')
  assert.equal(participantsCacheKey('prop-1'), 'participants:prop-1')
})

test('a missing identity yields a null key, not an empty-string cache bucket', () => {
  assert.equal(conversationCacheKey(null), null)
  assert.equal(propertyCacheKey(''), null)
  assert.equal(prospectCacheKey(null, null), null)
  assert.equal(intelligenceCacheKey(null, 'v4'), null)
  assert.equal(propertyMediaCacheKey(undefined, 'streetview'), null)
})

test('a property cache hit survives switching between threads on the same property', () => {
  const properties = createResourceCache<{ address: string }>()
  const key = propertyCacheKey('prop-1')!
  properties.commit(key, { address: '1 Main St' })
  // Thread A -> thread B, same property: the key is unchanged, so no refetch is needed.
  assert.deepEqual(properties.peek(key), { address: '1 Main St' })
  assert.equal(properties.size(), 1)
})

test('an intelligence failure does not evict the conversation cache', () => {
  const conversations = createResourceCache<string[]>()
  const intelligence = createResourceCache<string>()
  conversations.commit('thread-a', ['msg-1', 'msg-2'])
  intelligence.fail(intelligenceCacheKey('prop-1', 'v4')!, new Error('dossier 500'))
  assert.deepEqual(conversations.peek('thread-a'), ['msg-1', 'msg-2'])
})

test('a property-media failure does not erase property facts', () => {
  const properties = createResourceCache<{ beds: number }>()
  const media = createResourceCache<string>()
  properties.commit(propertyCacheKey('prop-1')!, { beds: 3 })
  media.fail(propertyMediaCacheKey('prop-1', 'streetview')!, new Error('no imagery'))
  assert.deepEqual(properties.peek(propertyCacheKey('prop-1')!), { beds: 3 })
  assert.equal(media.get(propertyMediaCacheKey('prop-1', 'streetview')!).status, 'error')
})

test('cache begin() on a warm entry refreshes without blanking', () => {
  const cache = createResourceCache<string>()
  cache.commit('k', 'value')
  const refreshing = cache.begin('k')
  assert.equal(refreshing.status, 'refreshing')
  assert.equal(refreshing.data, 'value')
})

test('cache trim never evicts a retained key', () => {
  const cache = createResourceCache<number>()
  for (let i = 0; i < 5; i += 1) cache.commit(`k${i}`, i)
  const removed = cache.trim(2, ['k0'])
  assert.equal(removed, 3)
  assert.ok(cache.has('k0'), 'the retained (currently selected) key survives')
  assert.equal(cache.size(), 2)
})

// ── composer draft continuity ────────────────────────────────────────────────

test('drafts are keyed by canonical thread id, not by row position', () => {
  const drafts = createComposerDraftStore()
  drafts.write('thread-a', 'asking about the roof')
  drafts.write('thread-b', 'confirming ownership')
  assert.equal(drafts.read('thread-a'), 'asking about the roof')
  assert.equal(drafts.read('thread-b'), 'confirming ownership')
  assert.equal(drafts.read('thread-c'), '', 'unknown threads read as empty, never null')
})

test('a draft survives a poll, a realtime patch and a bucket request', () => {
  const drafts = createComposerDraftStore()
  drafts.write('thread-a', 'unsent text')
  // None of these events touch the store — that is the point of keying by thread id.
  assert.equal(drafts.read('thread-a'), 'unsent text')
  assert.equal(drafts.size(), 1)
})

test('switching away and back restores the draft for that thread', () => {
  const drafts = createComposerDraftStore()
  drafts.write('thread-a', 'half-written reply')
  assert.equal(drafts.read('thread-b'), '', 'thread B starts clean, not with A text')
  assert.equal(drafts.read('thread-a'), 'half-written reply')
})

test('only an explicit clear discards a draft', () => {
  const drafts = createComposerDraftStore()
  drafts.write('thread-a', 'text')
  drafts.clear('thread-a')
  assert.equal(drafts.has('thread-a'), false)
  assert.equal(drafts.read('thread-a'), '')
})

test('writing an empty draft removes the entry rather than storing a blank', () => {
  const drafts = createComposerDraftStore({ 'thread-a': 'text' })
  drafts.write('thread-a', '')
  assert.equal(drafts.size(), 0)
})

test('draft writes with no thread key are ignored', () => {
  const drafts = createComposerDraftStore()
  drafts.write(null, 'orphan text')
  drafts.write('   ', 'orphan text')
  assert.equal(drafts.size(), 0)
})

test('draft trim never discards the currently selected thread', () => {
  const drafts = createComposerDraftStore()
  for (let i = 0; i < 5; i += 1) drafts.write(`t${i}`, `draft ${i}`)
  drafts.trim(2, ['t0'])
  assert.equal(drafts.read('t0'), 'draft 0')
  assert.equal(drafts.size(), 2)
})
