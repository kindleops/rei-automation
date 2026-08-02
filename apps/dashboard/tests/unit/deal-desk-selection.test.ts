/**
 * N.1 — canonical selection state machine.
 *
 * Covers DD-017 (bucket switch must not tear the selection down) and DD-018 (one
 * writable selection source, everything else derived).
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveCanonicalThreadReference } from '../../src/domain/inbox/canonical-thread-reference.ts'
import {
  dealDeskSelectionReducer,
  initialDealDeskSelectionState,
  isBucketTransitionPending,
  selectionKeyOf,
  shouldRenderGlobalEmptyWorkspace,
  type DealDeskSelectionCandidate,
  type DealDeskSelectionState,
} from '../../src/domain/inbox/deal-desk-selection.ts'

const candidate = (
  id: string,
  phone: string,
  extra: Partial<DealDeskSelectionCandidate> = {},
): DealDeskSelectionCandidate => {
  const reference = resolveCanonicalThreadReference({ id, canonicalE164: phone })
  assert.ok(reference, `fixture ${id} must resolve`)
  return { reference, propertyId: `prop-${id}`, prospectId: null, ownerId: null, ...extra }
}

const A = candidate('thread-a', '+19015550001')
const B = candidate('thread-b', '+19015550002')
const C = candidate('thread-c', '+19015550003')

const run = (
  state: DealDeskSelectionState,
  ...actions: Parameters<typeof dealDeskSelectionReducer>[1][]
): DealDeskSelectionState => actions.reduce(dealDeskSelectionReducer, state)

// ── one writable source, monotonic version ───────────────────────────────────

test('selecting a thread creates one stable identity with a version', () => {
  const state = run(initialDealDeskSelectionState('priority'), {
    type: 'SELECT_THREAD',
    candidate: A,
  })
  assert.equal(selectionKeyOf(state), 'thread-a')
  assert.equal(state.selection?.threadId, 'thread-a')
  assert.equal(state.selection?.canonicalPhone, '+19015550001')
  assert.equal(state.selection?.propertyId, 'prop-thread-a')
  assert.equal(state.selection?.prospectId, null, 'missing identities stay explicit null')
  assert.equal(state.selection?.selectionVersion, 1)
  assert.equal(state.origin, 'user')
  assert.equal(state.hasEverSelected, true)
})

test('selectionVersion increments only when the selected thread actually changes', () => {
  let state = run(initialDealDeskSelectionState(), { type: 'SELECT_THREAD', candidate: A })
  assert.equal(state.selection?.selectionVersion, 1)

  state = run(state, { type: 'SELECT_THREAD', candidate: B })
  assert.equal(state.selection?.selectionVersion, 2)

  // Re-selecting the same thread must not invalidate in-flight hydration.
  state = run(state, { type: 'SELECT_THREAD', candidate: B })
  assert.equal(state.selection?.selectionVersion, 2)
  assert.equal(state.lastReconcileReason, 'reselect_same_thread')
})

test('a refreshed row object with the same identity preserves the selection version', () => {
  let state = run(initialDealDeskSelectionState(), { type: 'SELECT_THREAD', candidate: A })
  const refreshedA = candidate('thread-a', '+19015550001', { propertyId: 'prop-thread-a' })
  state = run(state, { type: 'ROWS_PATCHED', rows: [refreshedA, B] })
  assert.equal(selectionKeyOf(state), 'thread-a')
  assert.equal(state.selection?.selectionVersion, 1)
})

// ── bucket switching must not tear down (DD-017) ─────────────────────────────

test('BUCKET_REQUESTED never clears the selection', () => {
  let state = run(initialDealDeskSelectionState('priority'), {
    type: 'SELECT_THREAD',
    candidate: A,
  })
  state = run(state, { type: 'BUCKET_REQUESTED', bucket: 'new_replies' })

  assert.equal(selectionKeyOf(state), 'thread-a', 'workspace stays renderable during the request')
  assert.equal(state.listStatus, 'loading')
  assert.equal(isBucketTransitionPending(state), true)
  assert.equal(shouldRenderGlobalEmptyWorkspace(state), false, 'no transient global blank')
})

test('a bucket switch preserves the selection when the thread is in the new bucket', () => {
  let state = run(
    initialDealDeskSelectionState('priority'),
    { type: 'SELECT_THREAD', candidate: A },
    { type: 'BUCKET_REQUESTED', bucket: 'new_replies' },
    { type: 'LIST_RESOLVED', bucket: 'new_replies', rows: [B, A, C] },
  )
  assert.equal(selectionKeyOf(state), 'thread-a')
  assert.equal(state.selection?.selectionVersion, 1, 'identity unchanged ⇒ version unchanged')
  assert.equal(state.activeBucket, 'new_replies')
  assert.equal(state.lastReconcileReason, 'preserved_selection')
  assert.equal(state.selectionOutOfView, false)
  state = state
})

test('a bucket switch auto-selects the first eligible thread exactly once', () => {
  let state = run(
    initialDealDeskSelectionState('priority'),
    { type: 'SELECT_THREAD', candidate: A },
    { type: 'BUCKET_REQUESTED', bucket: 'cold' },
    { type: 'LIST_RESOLVED', bucket: 'cold', rows: [B, C] },
  )
  assert.equal(selectionKeyOf(state), 'thread-b')
  assert.equal(state.origin, 'auto')
  assert.equal(state.lastReconcileReason, 'auto_selected_first_eligible')

  // A second list resolution for the same bucket must not re-select.
  state = run(state, { type: 'SELECT_THREAD', candidate: C })
  state = run(state, { type: 'LIST_RESOLVED', bucket: 'cold', rows: [B, C] })
  assert.equal(selectionKeyOf(state), 'thread-c', 'the operator choice survives')
})

test('auto-select does not fire twice for one bucket transition', () => {
  const state = run(
    initialDealDeskSelectionState('priority'),
    { type: 'BUCKET_REQUESTED', bucket: 'cold' },
    { type: 'LIST_RESOLVED', bucket: 'cold', rows: [B, C] },
    { type: 'CLEAR_SELECTION', reason: 'test' },
    { type: 'LIST_RESOLVED', bucket: 'cold', rows: [B, C] },
  )
  assert.equal(state.selection, null, 'no second auto-select after an explicit clear')
  assert.equal(state.lastReconcileReason, 'refresh_no_selection_no_auto_select')
})

test('re-entering a bucket is a fresh transition and may auto-select again', () => {
  const state = run(
    initialDealDeskSelectionState('priority'),
    { type: 'BUCKET_REQUESTED', bucket: 'cold' },
    { type: 'LIST_RESOLVED', bucket: 'cold', rows: [B, C] },
    { type: 'CLEAR_SELECTION', reason: 'operator_closed_thread' },
    { type: 'BUCKET_REQUESTED', bucket: 'cold' },
    { type: 'LIST_RESOLVED', bucket: 'cold', rows: [B, C] },
  )
  assert.equal(selectionKeyOf(state), 'thread-b')
  assert.equal(state.lastReconcileReason, 'auto_selected_first_eligible')
})

test('an empty bucket becomes an intentional empty state only after the result lands', () => {
  let state = run(
    initialDealDeskSelectionState('priority'),
    { type: 'SELECT_THREAD', candidate: A },
    { type: 'BUCKET_REQUESTED', bucket: 'dead' },
  )
  assert.equal(selectionKeyOf(state), 'thread-a', 'still rendering while unconfirmed')
  assert.equal(state.emptyBucketConfirmed, false)

  state = run(state, { type: 'LIST_RESOLVED', bucket: 'dead', rows: [] })
  assert.equal(state.selection, null)
  assert.equal(state.emptyBucketConfirmed, true)
  assert.equal(state.lastReconcileReason, 'bucket_empty_confirmed')
})

test('a failed list request keeps the previously hydrated selection', () => {
  const state = run(
    initialDealDeskSelectionState('priority'),
    { type: 'SELECT_THREAD', candidate: A },
    { type: 'BUCKET_REQUESTED', bucket: 'cold' },
    { type: 'LIST_FAILED', bucket: 'cold' },
  )
  assert.equal(selectionKeyOf(state), 'thread-a')
  assert.equal(state.listStatus, 'error')
  assert.equal(state.activeBucket, 'priority', 'a failed bucket is not adopted')
})

// ── refresh / poll / realtime may never re-select ────────────────────────────

test('a same-bucket refresh keeps the selection and flags it out of view', () => {
  const state = run(
    initialDealDeskSelectionState('priority'),
    { type: 'SELECT_THREAD', candidate: A },
    { type: 'LIST_RESOLVED', bucket: 'priority', rows: [B, C] },
  )
  assert.equal(selectionKeyOf(state), 'thread-a', 'a category move is not an unavailability proof')
  assert.equal(state.selectionOutOfView, true)
  assert.equal(state.lastReconcileReason, 'selection_out_of_view')
})

test('an empty same-bucket refresh does not clear an explicit selection', () => {
  const state = run(
    initialDealDeskSelectionState('priority'),
    { type: 'SELECT_THREAD', candidate: A },
    { type: 'LIST_RESOLVED', bucket: 'priority', rows: [] },
  )
  assert.equal(selectionKeyOf(state), 'thread-a')
  assert.equal(state.lastReconcileReason, 'empty_refresh_selection_retained')
})

test('ROWS_PATCHED never changes which thread is selected', () => {
  const state = run(
    initialDealDeskSelectionState(),
    { type: 'SELECT_THREAD', candidate: A },
    { type: 'ROWS_PATCHED', rows: [B, C] },
    { type: 'ROWS_PATCHED', rows: [C] },
  )
  assert.equal(selectionKeyOf(state), 'thread-a')
})

test('ROWS_PATCHED refreshes derived identities without a new selection', () => {
  const enrichedA = candidate('thread-a', '+19015550001', {
    propertyId: 'prop-thread-a',
    prospectId: 'prospect-77',
  })
  const state = run(
    initialDealDeskSelectionState(),
    { type: 'SELECT_THREAD', candidate: A },
    { type: 'ROWS_PATCHED', rows: [enrichedA] },
  )
  assert.equal(state.selection?.prospectId, 'prospect-77')
  assert.equal(state.selection?.selectionVersion, 1)
  assert.equal(state.lastReconcileReason, 'row_patched_identity_preserved')
})

test('ROWS_PATCHED with an unchanged row returns the identical state object', () => {
  const selected = run(initialDealDeskSelectionState(), { type: 'SELECT_THREAD', candidate: A })
  const patched = dealDeskSelectionReducer(selected, { type: 'ROWS_PATCHED', rows: [A] })
  assert.equal(patched, selected, 'no re-render churn when nothing changed')
})

// ── global empty workspace ───────────────────────────────────────────────────

test('the global empty workspace renders only before any selection has ever existed', () => {
  const fresh = initialDealDeskSelectionState()
  assert.equal(shouldRenderGlobalEmptyWorkspace(fresh), true)

  const afterSelect = run(fresh, { type: 'SELECT_THREAD', candidate: A })
  assert.equal(shouldRenderGlobalEmptyWorkspace(afterSelect), false)

  const afterClear = run(afterSelect, { type: 'CLEAR_SELECTION', reason: 'test' })
  assert.equal(
    shouldRenderGlobalEmptyWorkspace(afterClear),
    false,
    'an explicit clear shows the no-selection affordance, not the first-run blank',
  )
})

test('the inbox bucket is explicit and separate from thread identity', () => {
  const state = run(
    initialDealDeskSelectionState('priority'),
    { type: 'SELECT_THREAD', candidate: A },
  )
  assert.equal(state.selection?.inboxBucket, 'priority')
  assert.equal(state.selection?.threadId, 'thread-a')
  assert.notEqual(state.selection?.inboxBucket, state.selection?.threadId)
})
