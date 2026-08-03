/**
 * N.1 — integration coverage for Deal Desk selection + hydration continuity.
 *
 * These drive the *same* modules InboxPage runs (`dealDeskSelectionReducer`,
 * `createSelectionRequestGuard`, the resource caches, the draft store) through the
 * scenarios the lane must guarantee, without a DOM. The repository has no jsdom /
 * React Testing Library dependency, so component-level assertions are expressed against
 * the state machine that owns the behaviour rather than against rendered markup;
 * browser-level confirmation is in `tests/ui/deal-desk-selection-continuity.spec.ts`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveCanonicalThreadReference } from '../../src/domain/inbox/canonical-thread-reference.ts'
import {
  dealDeskSelectionReducer,
  initialDealDeskSelectionState,
  selectionKeyOf,
  shouldRenderGlobalEmptyWorkspace,
  type DealDeskSelectionAction,
  type DealDeskSelectionCandidate,
  type DealDeskSelectionState,
} from '../../src/domain/inbox/deal-desk-selection.ts'
import {
  DEAL_DESK_RESOURCES,
  createSelectionRequestGuard,
} from '../../src/domain/inbox/selection-request-guard.ts'
import {
  conversationCacheKey,
  createResourceCache,
  intelligenceCacheKey,
  propertyCacheKey,
  propertyMediaCacheKey,
} from '../../src/domain/inbox/deal-desk-resource-cache.ts'
import { createComposerDraftStore } from '../../src/domain/inbox/composer-draft-store.ts'
import { hasHydratedData, hydrationData } from '../../src/domain/inbox/hydration-state.ts'

// ── harness ──────────────────────────────────────────────────────────────────

const row = (id: string, phone: string, propertyId: string): DealDeskSelectionCandidate => {
  const reference = resolveCanonicalThreadReference({ id, canonicalE164: phone, propertyId })
  assert.ok(reference)
  return { reference, propertyId, prospectId: null, ownerId: null }
}

const A = row('thread-a', '+19015550001', 'prop-1')
const B = row('thread-b', '+19015550002', 'prop-2')
const C = row('thread-c', '+19015550003', 'prop-1')

/** A minimal stand-in for the workspace: selection + guard + per-resource caches. */
function createWorkspace(initialBucket = 'priority') {
  let state: DealDeskSelectionState = initialDealDeskSelectionState(initialBucket)
  const guard = createSelectionRequestGuard()
  const conversations = createResourceCache<string[]>()
  const properties = createResourceCache<{ address: string }>()
  const intelligence = createResourceCache<{ score: number }>()
  const media = createResourceCache<{ url: string }>()
  const drafts = createComposerDraftStore()

  const dispatch = (action: DealDeskSelectionAction) => {
    state = dealDeskSelectionReducer(state, action)
    return state
  }

  const identity = () => {
    const key = selectionKeyOf(state)
    assert.ok(key, 'identity() requires a selection')
    return { selectionKey: key, selectionVersion: state.selection!.selectionVersion }
  }

  return {
    get state() { return state },
    dispatch,
    identity,
    guard,
    conversations,
    properties,
    intelligence,
    media,
    drafts,
    select: (candidate: DealDeskSelectionCandidate) =>
      dispatch({ type: 'SELECT_THREAD', candidate }),
  }
}

// ── 1. one selection identity feeds every panel ──────────────────────────────

test('selecting a thread drives every panel from one selection identity', () => {
  const ws = createWorkspace()
  ws.select(A)

  const id = ws.identity()
  const conversationKey = conversationCacheKey(id.selectionKey)
  const propertyKey = propertyCacheKey(ws.state.selection!.propertyId)
  const intelKey = intelligenceCacheKey(ws.state.selection!.propertyId, 'v4')
  const mediaKey = propertyMediaCacheKey(ws.state.selection!.propertyId, 'streetview')

  // Every panel derives its key from the same selection, and each key is distinct.
  assert.equal(conversationKey, 'thread-a')
  assert.equal(propertyKey, 'property:prop-1')
  assert.equal(intelKey, 'intel:prop-1:v4')
  assert.equal(mediaKey, 'media:prop-1:streetview')

  // One selection, four resource slots, one generation each.
  for (const resource of [
    DEAL_DESK_RESOURCES.conversation,
    DEAL_DESK_RESOURCES.property,
    DEAL_DESK_RESOURCES.intelligence,
    DEAL_DESK_RESOURCES.propertyMedia,
  ]) {
    ws.guard.begin(resource, id)
  }
  assert.equal(ws.guard.stats().issued, 4, 'one selection ⇒ exactly one request per resource')
})

// ── 2. A -> B: A's delayed response cannot overwrite B ───────────────────────

test("switching A -> B: A's delayed response cannot overwrite B", () => {
  const ws = createWorkspace()
  ws.select(A)
  const aToken = ws.guard.begin(DEAL_DESK_RESOURCES.conversation, ws.identity()).token

  ws.select(B)
  const bToken = ws.guard.begin(DEAL_DESK_RESOURCES.conversation, ws.identity()).token

  // B resolves first and commits.
  assert.equal(ws.guard.accept(bToken), true)
  ws.conversations.commit(conversationCacheKey(selectionKeyOf(ws.state))!, ['b-msg'])

  // A resolves late and is refused.
  assert.equal(ws.guard.accept(aToken), false)
  assert.deepEqual(ws.conversations.peek('thread-b'), ['b-msg'])
  assert.equal(ws.conversations.peek('thread-a'), null, "A's payload never landed")
  assert.equal(selectionKeyOf(ws.state), 'thread-b')
})

test('A -> B -> A rapid switching keeps only the newest generation', () => {
  const ws = createWorkspace()
  ws.select(A)
  const a1 = ws.guard.begin(DEAL_DESK_RESOURCES.conversation, ws.identity()).token
  ws.select(B)
  const b1 = ws.guard.begin(DEAL_DESK_RESOURCES.conversation, ws.identity()).token
  ws.select(A)
  const a2 = ws.guard.begin(DEAL_DESK_RESOURCES.conversation, ws.identity()).token

  assert.equal(ws.guard.accept(a1), false, 'first A is a superseded generation')
  assert.equal(ws.guard.accept(b1), false)
  assert.equal(ws.guard.accept(a2), true)
  assert.equal(ws.guard.stats().rejectedStale, 2)
})

test('five rapid selections leave exactly one active selection', () => {
  const ws = createWorkspace()
  const rows = [A, B, C, A, B]
  const tokens = rows.map((candidate) => {
    ws.select(candidate)
    return ws.guard.begin(DEAL_DESK_RESOURCES.conversation, ws.identity()).token
  })
  const accepted = tokens.filter((token) => ws.guard.accept(token))
  assert.equal(accepted.length, 1, 'only the latest selection may commit')
  assert.equal(selectionKeyOf(ws.state), 'thread-b')
})

// ── 3 & 4. bucket switching never shows a transient global blank ─────────────

test('switching buckets never shows a transient global blank state', () => {
  const ws = createWorkspace('priority')
  ws.select(A)
  ws.conversations.commit('thread-a', ['a-msg'])
  ws.properties.commit(propertyCacheKey('prop-1')!, { address: '1 Main St' })

  ws.dispatch({ type: 'BUCKET_REQUESTED', bucket: 'new_replies' })
  // Mid-transition: still a selection, still hydrated data, no global blank.
  assert.equal(shouldRenderGlobalEmptyWorkspace(ws.state), false)
  assert.equal(selectionKeyOf(ws.state), 'thread-a')
  assert.deepEqual(ws.conversations.peek('thread-a'), ['a-msg'])
  assert.deepEqual(ws.properties.peek(propertyCacheKey('prop-1')!), { address: '1 Main St' })

  ws.dispatch({ type: 'LIST_RESOLVED', bucket: 'new_replies', rows: [B, C] })
  assert.equal(shouldRenderGlobalEmptyWorkspace(ws.state), false)
  assert.equal(selectionKeyOf(ws.state), 'thread-b', 'auto-selected the first eligible row')
})

test('three consecutive bucket switches never blank the workspace', () => {
  const ws = createWorkspace('priority')
  ws.select(A)
  const blanks: boolean[] = []
  for (const [bucket, rows] of [
    ['new_replies', [B]],
    ['needs_review', [C]],
    ['follow_up', [A, B]],
  ] as const) {
    ws.dispatch({ type: 'BUCKET_REQUESTED', bucket })
    blanks.push(shouldRenderGlobalEmptyWorkspace(ws.state))
    ws.dispatch({ type: 'LIST_RESOLVED', bucket, rows: [...rows] })
    blanks.push(shouldRenderGlobalEmptyWorkspace(ws.state))
  }
  assert.deepEqual(blanks, [false, false, false, false, false, false])
})

test('existing workspace data stay visible while the next selection loads', () => {
  const ws = createWorkspace()
  ws.select(A)
  ws.conversations.commit('thread-a', ['a-msg'])

  // Refreshing thread A: `begin` moves to `refreshing`, data retained.
  const refreshing = ws.conversations.begin('thread-a')
  assert.equal(refreshing.status, 'refreshing')
  assert.deepEqual(hydrationData(refreshing), ['a-msg'])
  assert.equal(hasHydratedData(refreshing), true)
})

// ── 5 & 6. a failed panel cannot erase a sibling panel ───────────────────────

test('a failed Deal Intelligence request does not erase the conversation', () => {
  const ws = createWorkspace()
  ws.select(A)
  ws.conversations.commit('thread-a', ['a-msg-1', 'a-msg-2'])
  ws.intelligence.fail(intelligenceCacheKey('prop-1', 'v4')!, new Error('dossier 500'))

  assert.deepEqual(ws.conversations.peek('thread-a'), ['a-msg-1', 'a-msg-2'])
  assert.equal(ws.intelligence.get(intelligenceCacheKey('prop-1', 'v4')!).status, 'error')
  assert.equal(selectionKeyOf(ws.state), 'thread-a', 'the selection survives too')
})

test('a failed property-media request does not erase property facts', () => {
  const ws = createWorkspace()
  ws.select(A)
  ws.properties.commit(propertyCacheKey('prop-1')!, { address: '1 Main St' })
  ws.media.fail(propertyMediaCacheKey('prop-1', 'streetview')!, new Error('no imagery'))

  assert.deepEqual(ws.properties.peek(propertyCacheKey('prop-1')!), { address: '1 Main St' })
  assert.equal(ws.media.get(propertyMediaCacheKey('prop-1', 'streetview')!).status, 'error')
})

test('a prospect lookup failure does not erase the selected thread', () => {
  const ws = createWorkspace()
  ws.select(A)
  ws.conversations.commit('thread-a', ['a-msg'])
  const prospects = createResourceCache<{ name: string }>()
  prospects.fail('prospect:missing', new Error('404'))
  assert.equal(selectionKeyOf(ws.state), 'thread-a')
  assert.deepEqual(ws.conversations.peek('thread-a'), ['a-msg'])
})

// ── 7 & 8. polling and realtime cannot replace an explicit selection ─────────

test('polling cannot replace an explicit user selection', () => {
  const ws = createWorkspace()
  ws.select(A)
  // Three poll cycles, each returning a list that no longer contains A.
  for (let i = 0; i < 3; i += 1) {
    ws.dispatch({ type: 'ROWS_PATCHED', rows: [B, C] })
  }
  assert.equal(selectionKeyOf(ws.state), 'thread-a')
})

test('a realtime event for another thread does not replace the selection', () => {
  const ws = createWorkspace()
  ws.select(A)
  const token = ws.guard.begin(DEAL_DESK_RESOURCES.conversation, ws.identity()).token

  ws.dispatch({ type: 'ROWS_PATCHED', rows: [B] })
  assert.equal(selectionKeyOf(ws.state), 'thread-a')
  assert.equal(
    ws.guard.isCurrent(token),
    true,
    'a realtime patch for another thread must not invalidate in-flight hydration',
  )
})

test('a bucket-list response arriving after a selection change cannot re-select', () => {
  const ws = createWorkspace('priority')
  ws.dispatch({ type: 'BUCKET_REQUESTED', bucket: 'cold' })
  ws.select(C) // the operator clicks a row before the list lands
  ws.dispatch({ type: 'LIST_RESOLVED', bucket: 'cold', rows: [A, B] })
  assert.equal(selectionKeyOf(ws.state), 'thread-c', 'the explicit click wins')
})

// ── 9. refreshed row objects preserve selection ──────────────────────────────

test('a refreshed row object with the same canonical id preserves the selection', () => {
  const ws = createWorkspace()
  ws.select(A)
  const version = ws.state.selection!.selectionVersion
  const token = ws.guard.begin(DEAL_DESK_RESOURCES.conversation, ws.identity()).token

  // A brand-new object for the same conversation (what a 15s poll produces).
  const refreshedA = row('thread-a', '+19015550001', 'prop-1')
  assert.notEqual(refreshedA, A, 'fixture is a distinct object reference')
  ws.dispatch({ type: 'ROWS_PATCHED', rows: [refreshedA, B] })

  assert.equal(selectionKeyOf(ws.state), 'thread-a')
  assert.equal(ws.state.selection!.selectionVersion, version, 'no new generation')
  assert.equal(ws.guard.isCurrent(token), true, 'in-flight hydration is not invalidated')
})

// ── 10. composer draft continuity ────────────────────────────────────────────

test('a composer draft survives poll, realtime, bucket request and intelligence refresh', () => {
  const ws = createWorkspace('priority')
  ws.select(A)
  ws.drafts.write(selectionKeyOf(ws.state), 'Is the roof original?')

  ws.dispatch({ type: 'ROWS_PATCHED', rows: [A, B] })                      // poll
  ws.dispatch({ type: 'ROWS_PATCHED', rows: [A] })                         // realtime patch
  ws.dispatch({ type: 'BUCKET_REQUESTED', bucket: 'new_replies' })         // bucket request
  ws.intelligence.begin(intelligenceCacheKey('prop-1', 'v4')!)             // intelligence refresh
  ws.intelligence.fail(intelligenceCacheKey('prop-1', 'v4')!, new Error('500'))

  assert.equal(ws.drafts.read('thread-a'), 'Is the roof original?')
})

test('switching threads restores each thread own draft and never leaks text', () => {
  const ws = createWorkspace()
  ws.select(A)
  ws.drafts.write(selectionKeyOf(ws.state), 'draft for A')

  ws.select(B)
  assert.equal(ws.drafts.read(selectionKeyOf(ws.state)), '', 'B starts clean')
  ws.drafts.write(selectionKeyOf(ws.state), 'draft for B')

  ws.select(A)
  assert.equal(ws.drafts.read(selectionKeyOf(ws.state)), 'draft for A', 'A draft restored')
  assert.equal(ws.drafts.read('thread-b'), 'draft for B', 'B draft still held')
})

test('nothing in the selection or hydration path discards a draft', () => {
  const ws = createWorkspace('priority')
  ws.select(A)
  ws.drafts.write('thread-a', 'unsent')
  ws.dispatch({ type: 'BUCKET_REQUESTED', bucket: 'dead' })
  ws.dispatch({ type: 'LIST_RESOLVED', bucket: 'dead', rows: [] }) // selection cleared
  assert.equal(ws.state.selection, null)
  assert.equal(ws.drafts.read('thread-a'), 'unsent', 'a cleared selection does not send or discard')
})

// ── 11 & 12. no ambiguous mutation identifier reaches the server ─────────────

test('no code path can produce `threadKey || id` as a mutation identifier', async () => {
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const root = fileURLToPath(new URL('../../src/', import.meta.url))
  const files = [
    'lib/data/inboxWorkflowData.ts',
    'modules/inbox/InboxPage.tsx',
    'domain/inbox/resolveCanonicalThreadStateKey.ts',
  ]
  for (const file of files) {
    const source = await readFile(root + file, 'utf8')
    // Strip comments so the documented history of the defect does not fail its own test.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
      .join('\n')
    assert.equal(
      /thread\.threadKey\s*\|\|\s*thread\.id/.test(code),
      false,
      `${file} still derives a thread key with the ambiguous \`threadKey || id\` fallback`,
    )
  }
})

test('a thread with no writable phone yields no server write key at all', () => {
  // The server validator must never receive a UUID or a composite key from Deal Desk.
  const uuidOnly = resolveCanonicalThreadReference({ id: '550e8400-e29b-41d4-a716-446655440000' })
  assert.ok(uuidOnly)
  assert.equal(uuidOnly.writable, false)
  assert.equal(uuidOnly.canonicalE164, null)

  const compositeOnly = resolveCanonicalThreadReference({
    id: 'x',
    threadKey: 'ct:property:prop-9|owner:o-1',
  })
  assert.ok(compositeOnly)
  assert.equal(compositeOnly.writable, false)
  assert.equal(compositeOnly.canonicalE164, null)
})

// ── performance guardrails ───────────────────────────────────────────────────

test('one selection issues one request per resource, with no duplicates', () => {
  const ws = createWorkspace()
  ws.select(A)
  const id = ws.identity()
  for (const resource of Object.values(DEAL_DESK_RESOURCES)) ws.guard.begin(resource, id)
  const stats = ws.guard.stats()
  assert.equal(stats.issued, Object.values(DEAL_DESK_RESOURCES).length)
  for (const perResource of Object.values(stats.byResource)) {
    assert.equal(perResource.issued, 1, 'no duplicate request for any resource')
  }
})

test('rapid switching reports its stale rejections rather than hiding them', () => {
  const ws = createWorkspace()
  const tokens = [A, B, C, A, B].map((candidate) => {
    ws.select(candidate)
    return ws.guard.begin(DEAL_DESK_RESOURCES.conversation, ws.identity()).token
  })
  tokens.forEach((token) => ws.guard.accept(token))
  const stats = ws.guard.stats()
  assert.equal(stats.issued, 5)
  assert.equal(stats.accepted, 1)
  assert.equal(stats.rejectedStale, 4)
  assert.equal(stats.aborted, 4, 'superseded requests are cancelled, not merely discarded')
})
