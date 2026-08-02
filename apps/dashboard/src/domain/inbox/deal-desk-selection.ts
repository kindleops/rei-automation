/**
 * Canonical Deal Desk selection model and reducer.
 *
 * Audit background (docs/audits/DEAL_DESK_FRONTEND_RUNTIME_AUDIT.md):
 *   DD-018 — the selected thread has **eight** writable representations (`selectedId`,
 *   `selectedThreadKey`, `layoutState.selectedThreadId`, `activeContext.threadKey`,
 *   `previewContext.threadKey`, `selectedThreadFallbackRef`, `universalEntityContext`,
 *   `inbox-store.selectedThreadKey`).
 *   DD-017 — every bucket switch calls `setSelectedId(null)` (`InboxPage.tsx:1518-1520`),
 *   which fires the hydration effect's null branch and wipes the center and right panels
 *   before an auto-select effect picks another row and re-hydrates.
 *
 * This module is the one writable source of truth for *what the operator selected*. It
 * holds references, never duplicated entities: hydrated data lives in the resource caches
 * (`deal-desk-resource-cache.ts`) keyed by the identities recorded here.
 *
 * Pure and dependency-free so the full transition table is testable under `node --test`.
 */

import {
  isSameCanonicalThread,
  type CanonicalThreadReference,
} from './canonical-thread-reference'

/** How the current selection came to be. Drives which refreshes may override it. */
export type DealDeskSelectionOrigin =
  | 'user'              // explicit row click / participant switch
  | 'auto'              // first-eligible auto-select after a bucket transition
  | 'external_context'  // deep link, entity graph, pipeline hand-off

export interface DealDeskSelection {
  /** Opaque row identity from the canonical reference. Never phone-validated. */
  threadId: string
  /** The full canonical reference — the only thread identity panels may consume. */
  threadReference: CanonicalThreadReference
  propertyId: string | null
  prospectId: string | null
  ownerId: string | null
  canonicalPhone: string | null
  /** Bucket the thread was selected from. Explicit, and separate from thread identity. */
  inboxBucket: string
  /**
   * Monotonic generation. Increments **only** when the selected conversation identity
   * changes — never on a data refresh. Every hydration request is bound to this value.
   */
  selectionVersion: number
}

export type DealDeskListStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface DealDeskSelectionState {
  selection: DealDeskSelection | null
  origin: DealDeskSelectionOrigin | null
  /** Bucket whose rows are currently displayed. */
  activeBucket: string
  /** Bucket whose list request is in flight; null when no transition is pending. */
  requestedBucket: string | null
  listStatus: DealDeskListStatus
  /**
   * True when the selected conversation is no longer present in the active list but its
   * hydrated data is still valid and displayed. Drives a "not in this view" affordance
   * instead of a teardown.
   */
  selectionOutOfView: boolean
  /** Buckets already auto-selected into — enforces "exactly once" per transition. */
  autoSelectedBuckets: readonly string[]
  /**
   * `version` at the moment the pending bucket transition started. If the version has
   * moved on by the time the list resolves, the operator selected something during the
   * request and auto-select must stand down.
   */
  transitionStartVersion: number | null
  /** True once any selection has ever been made. Gates the global blank workspace. */
  hasEverSelected: boolean
  /** True when a list resolved empty for the active bucket — an *intentional* empty state. */
  emptyBucketConfirmed: boolean
  /** Monotonic counter backing `selection.selectionVersion`. */
  version: number
  /** Diagnostic breadcrumb for the last reconciliation decision. */
  lastReconcileReason: string | null
}

/** Minimal thread shape the reducer needs. Callers project rows into this. */
export interface DealDeskSelectionCandidate {
  reference: CanonicalThreadReference
  propertyId?: string | null
  prospectId?: string | null
  ownerId?: string | null
  inboxBucket?: string | null
}

export type DealDeskSelectionAction =
  /** Explicit operator selection. Always wins; always bumps the version. */
  | { type: 'SELECT_THREAD'; candidate: DealDeskSelectionCandidate; origin?: DealDeskSelectionOrigin }
  /** Operator or navigation explicitly dropped the selection. */
  | { type: 'CLEAR_SELECTION'; reason: string }
  /** A bucket/filter transition started. Does NOT touch the selection. */
  | { type: 'BUCKET_REQUESTED'; bucket: string }
  /** A list request resolved. Reconciles selection against the new rows. */
  | { type: 'LIST_RESOLVED'; bucket: string; rows: readonly DealDeskSelectionCandidate[] }
  /** A list request failed. Keeps the selection and the previously hydrated workspace. */
  | { type: 'LIST_FAILED'; bucket: string }
  /**
   * A same-bucket data refresh (poll, realtime patch, count refresh, pagination append).
   * May update the selection's derived references, may never change which thread is selected.
   */
  | { type: 'ROWS_PATCHED'; rows: readonly DealDeskSelectionCandidate[] }

export const initialDealDeskSelectionState = (
  activeBucket = 'all_messages',
): DealDeskSelectionState => ({
  selection: null,
  origin: null,
  activeBucket,
  requestedBucket: null,
  listStatus: 'idle',
  selectionOutOfView: false,
  autoSelectedBuckets: [],
  transitionStartVersion: null,
  hasEverSelected: false,
  emptyBucketConfirmed: false,
  version: 0,
  lastReconcileReason: null,
})

const buildSelection = (
  candidate: DealDeskSelectionCandidate,
  bucket: string,
  selectionVersion: number,
): DealDeskSelection => ({
  threadId: candidate.reference.threadId,
  threadReference: candidate.reference,
  propertyId: candidate.propertyId ?? null,
  prospectId: candidate.prospectId ?? null,
  ownerId: candidate.ownerId ?? null,
  canonicalPhone: candidate.reference.canonicalE164,
  inboxBucket: candidate.inboxBucket ?? bucket,
  selectionVersion,
})

/**
 * Refresh a selection's *derived* fields from a newer row without changing identity.
 * `selectionVersion` is deliberately preserved so in-flight hydration is not invalidated
 * by a row object simply gaining a new reference.
 */
const reconcileSelectionData = (
  selection: DealDeskSelection,
  candidate: DealDeskSelectionCandidate,
): DealDeskSelection => {
  const next: DealDeskSelection = {
    ...selection,
    threadReference: candidate.reference,
    propertyId: candidate.propertyId ?? selection.propertyId,
    prospectId: candidate.prospectId ?? selection.prospectId,
    ownerId: candidate.ownerId ?? selection.ownerId,
    canonicalPhone: candidate.reference.canonicalE164 ?? selection.canonicalPhone,
    inboxBucket: candidate.inboxBucket ?? selection.inboxBucket,
  }
  const unchanged =
    next.threadReference.selectionKey === selection.threadReference.selectionKey &&
    next.threadReference.canonicalE164 === selection.threadReference.canonicalE164 &&
    next.threadReference.writable === selection.threadReference.writable &&
    next.propertyId === selection.propertyId &&
    next.prospectId === selection.prospectId &&
    next.ownerId === selection.ownerId &&
    next.inboxBucket === selection.inboxBucket
  return unchanged ? selection : next
}

const findMatchingRow = (
  rows: readonly DealDeskSelectionCandidate[],
  selection: DealDeskSelection | null,
): DealDeskSelectionCandidate | null => {
  if (!selection) return null
  for (const row of rows) {
    if (isSameCanonicalThread(row.reference, selection.threadReference)) return row
  }
  return null
}

const withAutoSelectedBucket = (
  buckets: readonly string[],
  bucket: string,
): readonly string[] => (buckets.includes(bucket) ? buckets : [...buckets, bucket])

export function dealDeskSelectionReducer(
  state: DealDeskSelectionState,
  action: DealDeskSelectionAction,
): DealDeskSelectionState {
  switch (action.type) {
    /**
     * Explicit selection. This is the only action that may set a *different* thread on
     * operator intent, and the only one (with auto-select) that bumps the version.
     */
    case 'SELECT_THREAD': {
      const origin = action.origin ?? 'user'
      const bucket = action.candidate.inboxBucket ?? state.requestedBucket ?? state.activeBucket
      if (
        state.selection &&
        isSameCanonicalThread(action.candidate.reference, state.selection.threadReference)
      ) {
        // Re-selecting the current thread must not invalidate in-flight hydration.
        return {
          ...state,
          selection: reconcileSelectionData(state.selection, action.candidate),
          origin,
          selectionOutOfView: false,
          hasEverSelected: true,
          lastReconcileReason: 'reselect_same_thread',
        }
      }
      const version = state.version + 1
      return {
        ...state,
        selection: buildSelection(action.candidate, bucket, version),
        origin,
        selectionOutOfView: false,
        hasEverSelected: true,
        emptyBucketConfirmed: false,
        version,
        lastReconcileReason: `select_${origin}`,
      }
    }

    case 'CLEAR_SELECTION': {
      if (!state.selection) {
        return { ...state, lastReconcileReason: `clear_noop:${action.reason}` }
      }
      return {
        ...state,
        selection: null,
        origin: null,
        selectionOutOfView: false,
        version: state.version + 1,
        lastReconcileReason: `clear:${action.reason}`,
      }
    }

    /**
     * DD-017 fix. A bucket transition marks the *list* as loading and records the target
     * bucket. It deliberately does not touch `selection`, so the center and right panels
     * keep rendering the previously hydrated workspace while the new list is in flight.
     */
    case 'BUCKET_REQUESTED': {
      return {
        ...state,
        requestedBucket: action.bucket,
        listStatus: 'loading',
        emptyBucketConfirmed: false,
        // Re-entering a bucket is a fresh transition: allow one auto-select again.
        autoSelectedBuckets: state.autoSelectedBuckets.filter((b) => b !== action.bucket),
        transitionStartVersion: state.version,
        lastReconcileReason: `bucket_requested:${action.bucket}`,
      }
    }

    case 'LIST_FAILED': {
      return {
        ...state,
        // The bucket is not adopted on failure — the operator keeps looking at what worked.
        requestedBucket: null,
        transitionStartVersion: null,
        listStatus: 'error',
        lastReconcileReason: `list_failed:${action.bucket}`,
      }
    }

    /**
     * The list for `action.bucket` resolved. Reconciliation policy, in order:
     *   1. selected thread present in the new rows  → preserve it (identity + version)
     *   2. bucket transition, selection absent      → auto-select first eligible, once
     *   3. bucket transition, rows empty            → confirmed empty state, clear selection
     *   4. same-bucket refresh, selection absent    → keep selection, flag it out-of-view
     */
    case 'LIST_RESOLVED': {
      const isTransition = state.requestedBucket !== null && state.requestedBucket === action.bucket
      const activeBucket = isTransition ? action.bucket : state.activeBucket
      /**
       * The operator selected a row while this bucket's list was still in flight. Their
       * click is newer information than the response, so auto-select stands down —
       * "no category response may overwrite a valid user selection".
       */
      const selectedDuringTransition =
        isTransition &&
        state.transitionStartVersion !== null &&
        state.version > state.transitionStartVersion &&
        state.origin === 'user'
      const base: DealDeskSelectionState = {
        ...state,
        activeBucket,
        requestedBucket: isTransition ? null : state.requestedBucket,
        transitionStartVersion: isTransition ? null : state.transitionStartVersion,
        listStatus: 'ready',
      }

      const match = findMatchingRow(action.rows, state.selection)
      if (match && state.selection) {
        return {
          ...base,
          selection: reconcileSelectionData(state.selection, match),
          selectionOutOfView: false,
          emptyBucketConfirmed: false,
          lastReconcileReason: 'preserved_selection',
        }
      }

      if (selectedDuringTransition) {
        return {
          ...base,
          selectionOutOfView: true,
          lastReconcileReason: 'user_selected_during_transition',
        }
      }

      if (action.rows.length === 0) {
        if (!isTransition) {
          // A same-bucket refresh that returned nothing is not proof the thread is gone.
          return {
            ...base,
            selectionOutOfView: Boolean(state.selection),
            lastReconcileReason: 'empty_refresh_selection_retained',
          }
        }
        return {
          ...base,
          selection: null,
          origin: null,
          selectionOutOfView: false,
          emptyBucketConfirmed: true,
          version: state.selection ? state.version + 1 : state.version,
          lastReconcileReason: 'bucket_empty_confirmed',
        }
      }

      if (isTransition) {
        if (base.autoSelectedBuckets.includes(activeBucket)) {
          // Already auto-selected into this bucket once; do not select again.
          return {
            ...base,
            selectionOutOfView: Boolean(state.selection),
            lastReconcileReason: 'auto_select_already_used',
          }
        }
        const first = action.rows[0]
        const version = state.version + 1
        return {
          ...base,
          selection: buildSelection(first, activeBucket, version),
          origin: 'auto',
          selectionOutOfView: false,
          emptyBucketConfirmed: false,
          autoSelectedBuckets: withAutoSelectedBucket(base.autoSelectedBuckets, activeBucket),
          hasEverSelected: true,
          version,
          lastReconcileReason: 'auto_selected_first_eligible',
        }
      }

      // Same-bucket refresh and the selected row is absent. Documented successor policy:
      // keep the operator's selection and its hydrated workspace, and flag it as
      // out-of-view. A row moving category is not proof the conversation is unavailable,
      // and silently advancing would swap the workspace out from under an operator who
      // may be mid-draft. A refresh is explicitly NOT a licence to auto-select — only a
      // bucket transition is.
      if (!state.selection) {
        return { ...base, lastReconcileReason: 'refresh_no_selection_no_auto_select' }
      }
      return {
        ...base,
        selectionOutOfView: true,
        lastReconcileReason: 'selection_out_of_view',
      }
    }

    /**
     * Poll / realtime / pagination-append. Never changes which thread is selected; only
     * refreshes the selected thread's derived references from the newer row object.
     */
    case 'ROWS_PATCHED': {
      if (!state.selection) return state
      const match = findMatchingRow(action.rows, state.selection)
      if (!match) return state
      const selection = reconcileSelectionData(state.selection, match)
      if (selection === state.selection) return state
      return {
        ...state,
        selection,
        selectionOutOfView: false,
        lastReconcileReason: 'row_patched_identity_preserved',
      }
    }

    default:
      return state
  }
}

/** The one selection key every panel, cache and effect derives from. */
export const selectionKeyOf = (state: DealDeskSelectionState): string | null =>
  state.selection?.threadReference.selectionKey ?? null

/**
 * True only when the workspace has never held a valid selection. This is the *only*
 * condition under which the global blank workspace may render (§J / requirement 6).
 */
export const shouldRenderGlobalEmptyWorkspace = (state: DealDeskSelectionState): boolean =>
  !state.selection && !state.hasEverSelected

/** True when a bucket transition is in flight — list-local loading, not a global blank. */
export const isBucketTransitionPending = (state: DealDeskSelectionState): boolean =>
  state.requestedBucket !== null && state.listStatus === 'loading'
