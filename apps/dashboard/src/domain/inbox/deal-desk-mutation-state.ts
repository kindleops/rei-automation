/**
 * Deal Desk mutation state machine — optimistic apply with real rollback.
 *
 * Audit background (docs/audits/DEAL_DESK_FRONTEND_RUNTIME_AUDIT.md):
 *   DD-004 — `handleWorkflowMutation` returns on `!result.ok` without touching
 *   `optimisticPatches` (`InboxPage.tsx:3167-3170`); `optimisticPatches` is never cleared
 *   anywhere in the file; `mergeOptimisticPatches` re-applies it every render. A failed
 *   write therefore persists visually until page reload, under a green
 *   "Action completed successfully" toast.
 *   The audit's own fix note asks for `revertOptimisticPatch` — it does not exist.
 *
 * This module is that mechanism. Invariants, each covered by a test:
 *
 *   1. The **previous authoritative** value is captured before the optimistic value is
 *      applied, and is what a rollback restores — never a previous *optimistic* value.
 *   2. A mutation is `confirmed` only from a response the caller has already validated,
 *      and confirmation adopts the **server's** value, not the requested one.
 *   3. A failure restores the previous authoritative value and clears the pending patch.
 *   4. A response for a superseded mutation on the same field is ignored entirely.
 *   5. No pending patch can outlive its mutation: every terminal transition clears it.
 *
 * Pure and dependency-free — testable under `node --test`.
 */

export type MutationErrorKind =
  | 'invalid_value'
  | 'unsupported_legacy_value'
  | 'missing_writable_route'
  | 'thread_not_found'
  | 'conflict'
  | 'automation_locked'
  | 'permission_denied'
  | 'network'
  | 'malformed_response'
  | 'server_error'

export interface MutationError {
  kind: MutationErrorKind
  /** Operator-facing, localised, free of internal identifiers. */
  message: string
  /** Machine-readable server reason, for telemetry. Never rendered raw. */
  code?: string
}

export type MutationState<T> =
  | { status: 'idle'; value: T }
  | { status: 'pending'; previousValue: T; optimisticValue: T; mutationId: string }
  | { status: 'confirmed'; value: T }
  | { status: 'failed'; value: T; attemptedValue: T; error: MutationError }

/** The value a control should render, whatever the mutation status. */
export const displayedValue = <T>(state: MutationState<T>): T => {
  switch (state.status) {
    case 'pending': return state.optimisticValue
    case 'idle':
    case 'confirmed':
    case 'failed': return state.value
  }
}

export const isPending = <T>(state: MutationState<T>): boolean => state.status === 'pending'

/** The value a rollback would restore. Null when nothing is in flight. */
export const rollbackTargetOf = <T>(state: MutationState<T>): T | null =>
  state.status === 'pending' ? state.previousValue : null

export const idleMutation = <T>(value: T): MutationState<T> => ({ status: 'idle', value })

/**
 * Begin an optimistic mutation.
 *
 * The previous authoritative value is taken from the *displayed* value only when nothing
 * is pending. If a mutation is already in flight, the existing `previousValue` is carried
 * forward, so a rollback after two rapid changes restores the value the server last
 * confirmed — not the first optimistic guess. This is the bug in `ThreadStateBar`'s
 * `useOptimisticField`, which reassigns `previousRef.current = value` on every commit.
 */
export const beginMutation = <T>(
  state: MutationState<T>,
  optimisticValue: T,
  mutationId: string,
): MutationState<T> => ({
  status: 'pending',
  previousValue: state.status === 'pending' ? state.previousValue : displayedValue(state),
  optimisticValue,
  mutationId,
})

/**
 * Confirm from the authoritative server value.
 *
 * `serverValue` must come from the mutation response, already validated by the caller.
 * The optimistic value is discarded — if the server persisted something different
 * (a guard, a coercion, a concurrent change), the server wins and the operator sees it.
 */
export const confirmMutation = <T>(
  state: MutationState<T>,
  mutationId: string,
  serverValue: T,
): MutationState<T> => {
  // A response for a superseded mutation must not commit.
  if (state.status === 'pending' && state.mutationId !== mutationId) return state
  return { status: 'confirmed', value: serverValue }
}

/**
 * Roll back to the previous authoritative value and clear the pending patch.
 * This is `revertOptimisticPatch`.
 */
export const failMutation = <T>(
  state: MutationState<T>,
  mutationId: string,
  error: MutationError,
): MutationState<T> => {
  if (state.status !== 'pending') {
    // Nothing optimistic to revert; record the failure against the current value.
    return { status: 'failed', value: displayedValue(state), attemptedValue: displayedValue(state), error }
  }
  if (state.mutationId !== mutationId) return state
  return {
    status: 'failed',
    value: state.previousValue,      // ← the rollback
    attemptedValue: state.optimisticValue,
    error,
  }
}

/**
 * Reconcile an externally-sourced value (poll, realtime, list refresh).
 *
 * A pending mutation is **never** overwritten — the operator's in-flight intent outranks a
 * background refresh. This is the "polling cannot overwrite a pending mutation" rule.
 */
export const reconcileExternalValue = <T>(
  state: MutationState<T>,
  externalValue: T,
): MutationState<T> => {
  if (state.status === 'pending') return state
  if (state.status === 'failed') {
    // Keep the error visible, but adopt the authoritative value underneath it.
    return externalValue === state.value ? state : { ...state, value: externalValue }
  }
  return displayedValue(state) === externalValue ? state : { status: 'confirmed', value: externalValue }
}

/** Clear a failure once the operator acknowledges it or retries. */
export const clearMutationError = <T>(state: MutationState<T>): MutationState<T> =>
  state.status === 'failed' ? { status: 'idle', value: state.value } : state

// ── per-field serialization ──────────────────────────────────────────────────

/**
 * Rapid-write policy: **last write wins, older responses are refused.**
 *
 * Chosen over queueing because operator intent is a *state* not a *sequence* — clicking
 * cold → warm → hot means "hot", and replaying cold and warm against the server first is
 * both slower and visibly wrong. Chosen over compare-and-set because the server contract
 * has no revision token today (see the N.2 schema contract).
 *
 * Each field tracks its own generation, so a slow stage write cannot refuse a fast
 * temperature write.
 */
export interface FieldMutationTracker {
  /** Issue an id for a new mutation on `field`, superseding any in flight. */
  begin(field: string): string
  /** May a response for `mutationId` commit? */
  isCurrent(field: string, mutationId: string): boolean
  /** Mark settled so late duplicates cannot commit twice. */
  settle(field: string, mutationId: string): boolean
  stats(): { issued: number; superseded: number; committed: number; refused: number }
}

export function createFieldMutationTracker(
  idFactory: (field: string, seq: number) => string = (field, seq) => `${field}#${seq}`,
): FieldMutationTracker {
  const current = new Map<string, string>()
  const settled = new Set<string>()
  let seq = 0
  const stats = { issued: 0, superseded: 0, committed: 0, refused: 0 }

  return {
    begin(field) {
      seq += 1
      if (current.has(field)) stats.superseded += 1
      const id = idFactory(field, seq)
      current.set(field, id)
      stats.issued += 1
      return id
    },
    isCurrent(field, mutationId) {
      return current.get(field) === mutationId && !settled.has(mutationId)
    },
    settle(field, mutationId) {
      if (current.get(field) !== mutationId || settled.has(mutationId)) {
        stats.refused += 1
        return false
      }
      settled.add(mutationId)
      current.delete(field)
      stats.committed += 1
      return true
    },
    stats: () => ({ ...stats }),
  }
}
