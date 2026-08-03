/**
 * One canonical operational control = one mutation, validated, reversible, reconciled.
 *
 * Replaces `ThreadStateBar`'s local `useOptimisticField`, which had four defects:
 *   1. `previousRef.current = value` was reassigned on *every* commit, so a rollback
 *      after two rapid changes restored an optimistic value the server never held.
 *   2. Success kept the *requested* value; the server's authoritative row was discarded
 *      (`persist` returned only `{ ok }`).
 *   3. No validation — an unmappable legacy value was sent and silently coerced
 *      server-side (DD-002).
 *   4. No serialization — two rapid writes to the same field raced, and the loser could
 *      land last.
 *
 * Identity comes from the N.1 canonical contract, so a UUID or composite key is never
 * sent to the server's `/^\+1\d{10}$/` guard, and a thread with no writable route is
 * refused locally with an explicit reason instead of firing a doomed request (DD-003).
 *
 * **Reconciliation is derivation, not synchronisation.** The authoritative value is
 * always `spec.serverValue`; this hook stores only the *in-flight overlay*. A poll,
 * realtime patch or list refresh therefore reconciles for free — with no effect, and with
 * no possibility of erasing a pending change, because the overlay wins while it exists.
 */

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  resolveDealDeskThreadReference,
  resolveDealDeskWritableThreadKey,
} from '../../domain/inbox/deal-desk-thread-reference'
import type { ThreadIdentityInput } from '../../domain/inbox/canonical-thread-reference'
import { createFieldMutationTracker, type MutationErrorKind } from '../../domain/inbox/deal-desk-mutation-state'
import {
  describeVocabularyRejection,
  type VocabularyResolution,
} from '../../domain/lead-state/canonical-control-vocabularies'

export interface CanonicalControlMutationResult {
  ok: boolean
  /** The server's authoritative row, when it returned one. */
  row?: Record<string, unknown> | null
  errorMessage?: string | null
  errorCode?: string | null
}

export interface CanonicalControlSpec<T extends string> {
  /** Canonical DB/API field name, e.g. `lifecycle_stage`. Also the serialization key. */
  field: string
  /** Authoritative value from the current thread row. Always the fallback truth. */
  serverValue: T
  /** Strict resolver — must refuse unknown values rather than coerce them. */
  resolve: (value: unknown) => VocabularyResolution<T>
  /** Issues the request. Should return the server's authoritative row. */
  persist: (canonicalValue: T) => Promise<CanonicalControlMutationResult>
  /** Reads this field back out of the server's authoritative row. */
  readBack: (row: Record<string, unknown> | null | undefined) => T | null
}

export interface ControlCommitOutcome {
  ok: boolean
  /** Operator-facing reason when `ok` is false. Never a raw error or identifier. */
  errorMessage: string | null
  /** Machine-readable reason, for telemetry. */
  errorCode: string | null
  /** True when a newer write on the same field superseded this one. */
  superseded: boolean
}

export interface CanonicalControlHandle<T extends string> {
  /** What the control should render. */
  value: T
  pending: boolean
  failed: boolean
  /** Operator-facing reason, or null. Never a raw error or internal identifier. */
  errorMessage: string | null
  /** True when this thread has no server-writable route — the control is unsupported. */
  unsupported: boolean
  unsupportedReason: string | null
  /** Resolves once the write has settled. `ok` is false for a refusal or a rollback. */
  commit: (next: T) => Promise<ControlCommitOutcome>
  dismissError: () => void
}

/**
 * Per-field overlay. Absent means "show the authoritative value".
 *
 * `confirmed` exists because dropping the overlay the instant the server confirms would
 * fall back to `spec.serverValue`, which still holds the *pre-mutation* value until the
 * caller re-reads the row — so the control would visibly revert and then jump forward.
 * The confirmed overlay holds the persisted value until `serverValue` catches up.
 */
type Overlay<T> =
  | { kind: 'pending'; optimisticValue: T; mutationId: string; rollbackValue?: T; serverValueAtStart: T }
  | { kind: 'confirmed'; persistedValue: T }
  | {
      kind: 'failed'
      error: { kind: MutationErrorKind; message: string; code?: string }
      rollbackValue?: T
      serverValueAtStart?: T
    }

/**
 * The value a rollback restores: the last value the SERVER confirmed, if this control has
 * confirmed one since the caller's row was last refreshed, otherwise the authoritative
 * row itself.
 *
 * Without the first branch, a successful write followed by a failed one displayed the
 * pre-success row value — the operator saw `waiting_on_seller` while the database held
 * `snoozed`, because the confirmed overlay was discarded along with the failed attempt.
 * A rollback must undo the FAILED write, not the successful one before it.
 */
const rollbackValueOf = <T>(existing: Overlay<T> | undefined): T | undefined => {
  if (!existing) return undefined
  if (existing.kind === 'confirmed') return existing.persistedValue
  return existing.rollbackValue
}

/**
 * A rollback target only stands in for an authoritative row that has not caught up yet.
 * The moment that row CHANGES — whether it catches up or moves on to something else
 * entirely — the row is newer information and wins. Without this the target would mask
 * every later server-side change to the field.
 */
const rollbackStillApplies = <T>(overlay: Extract<Overlay<T>, { kind: 'failed' }>, serverValue: T): boolean =>
  overlay.rollbackValue !== undefined && overlay.serverValueAtStart === serverValue

const UNSUPPORTED_MESSAGE =
  'This conversation has no writable canonical phone route, so its state cannot be saved.'

export function useCanonicalControlMutations<T extends string>(
  thread: ThreadIdentityInput,
  specs: ReadonlyArray<CanonicalControlSpec<T>>,
): Record<string, CanonicalControlHandle<T>> {
  const writable = useMemo(() => resolveDealDeskWritableThreadKey(thread), [thread])
  const unsupported = !writable?.ok
  const unsupportedReason = unsupported ? UNSUPPORTED_MESSAGE : null

  const [tracker] = useState(() => createFieldMutationTracker())
  const [overlays, setOverlays] = useState<Record<string, Overlay<T> | undefined>>({})

  /**
   * Overlays and in-flight writes are scoped to ONE conversation.
   *
   * Without this, selecting a different thread while an overlay exists would apply the
   * previous conversation's pending/confirmed/failed value to the new one — the operator
   * would see thread B wearing thread A's optimistic state — and a late response for A
   * would commit against B.
   *
   * Two mechanisms, both required:
   *   1. On an identity change the overlays are dropped, so the new thread renders purely
   *      from its own row. Done during render (the sanctioned "adjust state when a prop
   *      changes" pattern) so no frame is ever painted with the wrong thread's overlay.
   *   2. Every mutation captures the identity it began on and refuses to commit if the
   *      selection has moved on. Replacing the tracker instead would NOT work: `commit`
   *      captures its tracker at `begin()` and would settle against that same object.
   */
  const identity = useMemo(() => resolveDealDeskThreadReference(thread)?.selectionKey ?? null, [thread])
  const [renderedIdentity, setRenderedIdentity] = useState(identity)
  if (renderedIdentity !== identity) {
    setRenderedIdentity(identity)
    setOverlays((current) => (Object.keys(current).length === 0 ? current : {}))
  }

  // Read only inside async callbacks, never during render.
  const identityRef = useRef(identity)
  useLayoutEffect(() => { identityRef.current = identity }, [identity])

  const setOverlay = useCallback((field: string, next: Overlay<T> | undefined) => {
    setOverlays((current) => {
      if (current[field] === next) return current
      const updated = { ...current }
      if (next === undefined) delete updated[field]
      else updated[field] = next
      return updated
    })
  }, [])

  /** Set an overlay from the one currently in place — used where the rollback target
   *  must be carried forward across a transition. */
  const updateOverlay = useCallback(
    (field: string, next: (existing: Overlay<T> | undefined) => Overlay<T>) => {
      setOverlays((current) => ({ ...current, [field]: next(current[field]) }))
    },
    [],
  )

  /**
   * The spec is passed in rather than looked up, so this callback depends only on stable
   * values. Callers rebuild `specs` every render; reading them through a ref would be a
   * render-phase ref write, which is unsafe under concurrent rendering.
   */
  const commit = useCallback(
    async (spec: CanonicalControlSpec<T>, next: T): Promise<ControlCommitOutcome> => {
      const field = spec.field

      // 1. Refuse locally when there is no writable route — no doomed request (DD-003).
      if (unsupported) {
        setOverlay(field, { kind: 'failed', error: { kind: 'missing_writable_route', message: UNSUPPORTED_MESSAGE } })
        return { ok: false, errorMessage: UNSUPPORTED_MESSAGE, errorCode: 'missing_writable_route', superseded: false }
      }

      // 2. Validate before applying anything optimistically (DD-002).
      const resolution = spec.resolve(next)
      if (!resolution.ok) {
        const message = describeVocabularyRejection(resolution)
        setOverlay(field, {
          kind: 'failed',
          error: {
            kind: resolution.reason === 'unmapped_legacy' ? 'unsupported_legacy_value' : 'invalid_value',
            message,
          },
        })
        return { ok: false, errorMessage: message, errorCode: resolution.reason, superseded: false }
      }

      // 3. Serialize per field; the newest write wins.
      const boundIdentity = identityRef.current
      const mutationId = tracker.begin(field)
      updateOverlay(field, (existing) => ({
        kind: 'pending',
        optimisticValue: resolution.value,
        mutationId,
        rollbackValue: rollbackValueOf(existing),
        serverValueAtStart: spec.serverValue,
      }))

      let result: CanonicalControlMutationResult
      let transportFailed = false
      try {
        result = await spec.persist(resolution.value)
      } catch {
        transportFailed = true
        result = { ok: false, errorMessage: 'The change could not be sent. Check your connection and retry.' }
      }

      // 4. A superseded response may not commit, in either direction — neither because a
      //    newer write on the same field replaced it, nor because the operator moved to a
      //    different conversation while it was in flight.
      if (identityRef.current !== boundIdentity) {
        tracker.settle(field, mutationId)
        return { ok: false, errorMessage: null, errorCode: 'thread_changed', superseded: true }
      }
      if (!tracker.settle(field, mutationId)) {
        return { ok: false, errorMessage: null, errorCode: 'superseded', superseded: true }
      }

      if (!result.ok) {
        // Dropping the pending value IS the rollback. The control falls back to the last
        // value the SERVER confirmed if this control confirmed one that the caller's row
        // has not caught up to yet, and otherwise to the authoritative row itself.
        const message = result.errorMessage || 'The change could not be saved.'
        updateOverlay(field, (existing) => ({
          kind: 'failed',
          error: {
            // A thrown request is a transport failure, not a server rejection.
            kind: transportFailed ? 'network' : 'server_error',
            message,
            // Machine-readable code retained for telemetry; never rendered.
            code: result.errorCode ?? undefined,
          },
          rollbackValue: rollbackValueOf(existing),
          serverValueAtStart: existing?.kind === 'pending' ? existing.serverValueAtStart : undefined,
        }))
        return { ok: false, errorMessage: message, errorCode: result.errorCode ?? null, superseded: false }
      }

      // 5. Confirm from the AUTHORITATIVE row, never the requested value. A response that
      //    cannot confirm the field is a contract failure and is surfaced, not papered
      //    over with the optimistic value.
      const persisted = spec.readBack(result.row)
      if (persisted == null) {
        const message = 'Saved, but the server did not confirm the new value. Reload to see the current state.'
        updateOverlay(field, (existing) => ({
          kind: 'failed',
          error: { kind: 'malformed_response', message },
          rollbackValue: rollbackValueOf(existing),
          serverValueAtStart: existing?.kind === 'pending' ? existing.serverValueAtStart : undefined,
        }))
        return { ok: false, errorMessage: message, errorCode: 'malformed_response', superseded: false }
      }
      // Hold the persisted value until the caller's refetch makes `serverValue` match it.
      setOverlay(field, { kind: 'confirmed', persistedValue: persisted })
      return { ok: true, errorMessage: null, errorCode: null, superseded: false }
    },
    [setOverlay, tracker, unsupported, updateOverlay],
  )

  return useMemo(() => {
    const out: Record<string, CanonicalControlHandle<T>> = {}
    for (const spec of specs) {
      let overlay = overlays[spec.field]
      // A confirmed overlay retires itself once the authoritative value catches up, so it
      // can never mask a later server-side change. A failed overlay's rollback target
      // retires the same way.
      if (overlay?.kind === 'confirmed' && overlay.persistedValue === spec.serverValue) {
        overlay = undefined
      } else if (overlay?.kind === 'failed' && !rollbackStillApplies(overlay, spec.serverValue)) {
        overlay = { kind: 'failed', error: overlay.error }
      }
      out[spec.field] = {
        // Derived, not synchronised: an overlay wins while it exists, otherwise the
        // authoritative server value shows through automatically.
        value: overlay?.kind === 'pending'
          ? overlay.optimisticValue
          : overlay?.kind === 'confirmed'
            ? overlay.persistedValue
            // A rollback restores the last server-confirmed value when there is one.
            : overlay?.kind === 'failed'
              ? overlay.rollbackValue ?? spec.serverValue
              : spec.serverValue,
        pending: overlay?.kind === 'pending',
        failed: overlay?.kind === 'failed',
        errorMessage: overlay?.kind === 'failed' ? overlay.error.message : null,
        unsupported,
        unsupportedReason,
        commit: (next: T) => commit(spec, next),
        dismissError: () => setOverlay(spec.field, undefined),
      }
    }
    return out
  }, [commit, overlays, setOverlay, specs, unsupported, unsupportedReason])
}
