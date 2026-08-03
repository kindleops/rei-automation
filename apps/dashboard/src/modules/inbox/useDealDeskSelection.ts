/**
 * The one writable source of truth for the Deal Desk selection.
 *
 * Replaces the eight representations catalogued in DD-018:
 *   `selectedId`, `selectedThreadKey`, `layoutState.selectedThreadId`,
 *   `activeContext.threadKey`, `previewContext.threadKey`, `selectedThreadFallbackRef`,
 *   `universalEntityContext`, `inbox-store.selectedThreadKey`.
 *
 * After this hook: the reducer in `deal-desk-selection.ts` is the only writable source.
 * `selectedId` / `selectedThreadKey` are *derived read-only* projections kept for the
 * component's existing call sites. `activeContext` / `previewContext` /
 * `universalEntityContext` remain as *routing* context (which entity the workspace is
 * pointed at) but no longer independently decide which thread is selected — they anchor
 * through `selectFromExternalContext`.
 *
 * The hook also owns:
 *   - the request-generation guard every selection-triggered fetch binds to,
 *   - the last-known thread object per selection key, so the previously hydrated
 *     workspace stays renderable while the next list request is in flight (DD-017).
 */

import { useCallback, useEffect, useMemo, useReducer, useState } from 'react'
import {
  dealDeskSelectionReducer,
  initialDealDeskSelectionState,
  isBucketTransitionPending,
  selectionKeyOf,
  shouldRenderGlobalEmptyWorkspace,
  type DealDeskSelection,
  type DealDeskSelectionOrigin,
  type DealDeskSelectionState,
} from '../../domain/inbox/deal-desk-selection'
import {
  toSelectionCandidate,
  toSelectionCandidates,
} from '../../domain/inbox/deal-desk-selection-adapter'
import { resolveDealDeskThreadReference } from '../../domain/inbox/deal-desk-thread-reference'
import {
  createSelectionRequestGuard,
  type SelectionRequestGuard,
} from '../../domain/inbox/selection-request-guard'
import type { CanonicalThreadReference } from '../../domain/inbox/canonical-thread-reference'

/** Accepts declared interfaces (`InboxWorkflowThread`) as well as loose records. */
type ThreadLike = object

/** How many previously visited threads stay renderable after leaving them. */
const REMEMBERED_THREAD_LIMIT = 50

export interface DealDeskSelectionApi<TThread extends ThreadLike> {
  state: DealDeskSelectionState
  selection: DealDeskSelection | null
  selectionKey: string | null
  selectionVersion: number
  threadReference: CanonicalThreadReference | null
  /** Derived, read-only. Kept for existing call sites — never assign to it. */
  selectedId: string | null
  /** Derived, read-only. Kept for existing call sites — never assign to it. */
  selectedThreadKey: string | null
  selectionOutOfView: boolean
  /** Only true when no valid selection has ever existed (§J / requirement 6). */
  showGlobalEmptyWorkspace: boolean
  bucketTransitionPending: boolean
  activeBucket: string
  guard: SelectionRequestGuard

  selectThread(thread: TThread, options?: { origin?: DealDeskSelectionOrigin; bucket?: string | null }): boolean
  selectFromExternalContext(thread: TThread): boolean
  clearSelection(reason: string): void
  requestBucket(bucket: string): void
  reconcileList(bucket: string, rows: readonly TThread[]): void
  listFailed(bucket: string): void
  patchRows(rows: readonly TThread[]): void

  /** Keep a thread object renderable by selection key. */
  rememberThread(thread: TThread | null | undefined): void
  /** Last-known object for a selection key — the anti-blank fallback. */
  resolveRememberedThread(key: string | null | undefined): TThread | null
}

export function useDealDeskSelection<TThread extends ThreadLike>(
  initialBucket = 'all_messages',
): DealDeskSelectionApi<TThread> {
  const [state, dispatch] = useReducer(
    dealDeskSelectionReducer,
    initialBucket,
    initialDealDeskSelectionState,
  )

  // Lazily-created singletons. `useState` rather than `useRef` because both are read
  // during render (the guard is handed to callers, the remembered map backs the
  // anti-blank fallback), and reading a ref during render is unsafe under concurrent
  // rendering. Neither value is ever replaced, so no re-render is ever triggered.
  const [guard] = useState<SelectionRequestGuard>(createSelectionRequestGuard)
  // Last-known thread object per selection key. This is what keeps the center and right
  // panels rendering the previous conversation while a new bucket list is in flight.
  const [remembered] = useState<Map<string, TThread>>(() => new Map())

  /**
   * Cancel every selection-bound request when the workspace unmounts.
   * `clearSelection` was the only path that aborted, so after an unmount the in-flight
   * hydration kept running and late responses could still reach consumer state setters.
   */
  useEffect(() => () => { guard.abortAll() }, [guard])

  const rememberThread = useCallback((thread: TThread | null | undefined) => {
    if (!thread) return
    const reference = resolveDealDeskThreadReference(thread)
    if (!reference) return
    // Re-inserting gives the Map recency ordering, so the trim below drops the
    // least-recently-visited conversation rather than an arbitrary one.
    remembered.delete(reference.selectionKey)
    remembered.set(reference.selectionKey, thread)
    if (remembered.size > REMEMBERED_THREAD_LIMIT) {
      const oldest = remembered.keys().next()
      if (!oldest.done) remembered.delete(oldest.value)
    }
  }, [remembered])

  const resolveRememberedThread = useCallback((key: string | null | undefined): TThread | null => {
    const normalized = String(key ?? '').trim()
    if (!normalized) return null
    return remembered.get(normalized) ?? null
  }, [remembered])

  const selectThread = useCallback(
    (
      thread: TThread,
      options?: { origin?: DealDeskSelectionOrigin; bucket?: string | null },
    ): boolean => {
      const candidate = toSelectionCandidate(thread, options?.bucket ?? null)
      if (!candidate) return false
      rememberThread(thread)
      dispatch({ type: 'SELECT_THREAD', candidate, origin: options?.origin ?? 'user' })
      return true
    },
    [dispatch, rememberThread],
  )

  const selectFromExternalContext = useCallback(
    (thread: TThread): boolean => selectThread(thread, { origin: 'external_context' }),
    [selectThread],
  )

  const clearSelection = useCallback(
    (reason: string) => {
      // An explicit clear is the only path that may drop hydrated data, so it is also the
      // only path that aborts every in-flight selection request.
      guard.abortAll()
      dispatch({ type: 'CLEAR_SELECTION', reason })
    },
    [dispatch, guard],
  )

  const requestBucket = useCallback(
    (bucket: string) => {
      dispatch({ type: 'BUCKET_REQUESTED', bucket })
    },
    [dispatch],
  )

  const reconcileList = useCallback(
    (bucket: string, rows: readonly TThread[]) => {
      for (const row of rows) rememberThread(row)
      dispatch({ type: 'LIST_RESOLVED', bucket, rows: toSelectionCandidates(rows) })
    },
    [dispatch, rememberThread],
  )

  const listFailed = useCallback(
    (bucket: string) => {
      dispatch({ type: 'LIST_FAILED', bucket })
    },
    [dispatch],
  )

  const patchRows = useCallback(
    (rows: readonly TThread[]) => {
      for (const row of rows) rememberThread(row)
      dispatch({ type: 'ROWS_PATCHED', rows: toSelectionCandidates(rows) })
    },
    [dispatch, rememberThread],
  )

  const selection = state.selection
  const selectionKey = selectionKeyOf(state)

  return useMemo<DealDeskSelectionApi<TThread>>(
    () => ({
      state,
      selection,
      selectionKey,
      selectionVersion: selection?.selectionVersion ?? 0,
      threadReference: selection?.threadReference ?? null,
      selectedId: selection?.threadId ?? null,
      selectedThreadKey: selectionKey,
      selectionOutOfView: state.selectionOutOfView,
      showGlobalEmptyWorkspace: shouldRenderGlobalEmptyWorkspace(state),
      bucketTransitionPending: isBucketTransitionPending(state),
      activeBucket: state.activeBucket,
      guard,
      selectThread,
      selectFromExternalContext,
      clearSelection,
      requestBucket,
      reconcileList,
      listFailed,
      patchRows,
      rememberThread,
      resolveRememberedThread,
    }),
    [
      clearSelection,
      guard,
      listFailed,
      patchRows,
      reconcileList,
      rememberThread,
      requestBucket,
      resolveRememberedThread,
      selectFromExternalContext,
      selectThread,
      selection,
      selectionKey,
      state,
    ],
  )
}
