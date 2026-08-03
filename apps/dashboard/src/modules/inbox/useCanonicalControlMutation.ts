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

import { useCallback, useMemo, useState } from 'react'
import { resolveDealDeskWritableThreadKey } from '../../domain/inbox/deal-desk-thread-reference'
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
  commit: (next: T) => Promise<void>
  dismissError: () => void
}

/** In-flight overlay for one field. Absent means "show the authoritative value". */
type Overlay<T> =
  | { kind: 'pending'; optimisticValue: T; mutationId: string }
  | { kind: 'failed'; error: { kind: MutationErrorKind; message: string } }

const UNSUPPORTED_MESSAGE =
  'This conversation has no writable canonical phone route, so its state cannot be saved.'

export function useCanonicalControlMutations<T extends string>(
  thread: unknown,
  specs: ReadonlyArray<CanonicalControlSpec<T>>,
): Record<string, CanonicalControlHandle<T>> {
  const writable = useMemo(() => resolveDealDeskWritableThreadKey(thread), [thread])
  const unsupported = !writable?.ok
  const unsupportedReason = unsupported ? UNSUPPORTED_MESSAGE : null

  const [tracker] = useState(() => createFieldMutationTracker())
  const [overlays, setOverlays] = useState<Record<string, Overlay<T> | undefined>>({})

  const setOverlay = useCallback((field: string, next: Overlay<T> | undefined) => {
    setOverlays((current) => {
      if (current[field] === next) return current
      const updated = { ...current }
      if (next === undefined) delete updated[field]
      else updated[field] = next
      return updated
    })
  }, [])

  /**
   * The spec is passed in rather than looked up, so this callback depends only on stable
   * values. Callers rebuild `specs` every render; reading them through a ref would be a
   * render-phase ref write, which is unsafe under concurrent rendering.
   */
  const commit = useCallback(
    async (spec: CanonicalControlSpec<T>, next: T) => {
      const field = spec.field

      // 1. Refuse locally when there is no writable route — no doomed request (DD-003).
      if (unsupported) {
        setOverlay(field, { kind: 'failed', error: { kind: 'missing_writable_route', message: UNSUPPORTED_MESSAGE } })
        return
      }

      // 2. Validate before applying anything optimistically (DD-002).
      const resolution = spec.resolve(next)
      if (!resolution.ok) {
        setOverlay(field, {
          kind: 'failed',
          error: {
            kind: resolution.reason === 'unmapped_legacy' ? 'unsupported_legacy_value' : 'invalid_value',
            message: describeVocabularyRejection(resolution),
          },
        })
        return
      }

      // 3. Serialize per field; the newest write wins.
      const mutationId = tracker.begin(field)
      setOverlay(field, { kind: 'pending', optimisticValue: resolution.value, mutationId })

      let result: CanonicalControlMutationResult
      try {
        result = await spec.persist(resolution.value)
      } catch {
        result = { ok: false, errorMessage: 'The change could not be sent. Check your connection and retry.' }
      }

      // 4. A superseded response may not commit, in either direction.
      if (!tracker.settle(field, mutationId)) return

      if (!result.ok) {
        // Dropping the pending overlay IS the rollback: the control falls back to the
        // authoritative `serverValue`, which is what the database still holds.
        setOverlay(field, {
          kind: 'failed',
          error: { kind: 'server_error', message: result.errorMessage || 'The change could not be saved.' },
        })
        return
      }

      // 5. Confirm from the AUTHORITATIVE row, never the requested value. A response that
      //    cannot confirm the field is a contract failure and is surfaced, not papered
      //    over with the optimistic value.
      const persisted = spec.readBack(result.row)
      if (persisted == null) {
        setOverlay(field, {
          kind: 'failed',
          error: {
            kind: 'malformed_response',
            message: 'Saved, but the server did not confirm the new value. Reload to see the current state.',
          },
        })
        return
      }
      // Clear the overlay. The caller re-reads the row, so `serverValue` becomes the
      // persisted value; until it does, showing the authoritative value is still correct.
      setOverlay(field, undefined)
    },
    [setOverlay, tracker, unsupported],
  )

  return useMemo(() => {
    const out: Record<string, CanonicalControlHandle<T>> = {}
    for (const spec of specs) {
      const overlay = overlays[spec.field]
      out[spec.field] = {
        // Derived, not synchronised: the overlay wins while in flight, otherwise the
        // authoritative server value shows through automatically.
        value: overlay?.kind === 'pending' ? overlay.optimisticValue : spec.serverValue,
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
