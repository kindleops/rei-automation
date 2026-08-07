/**
 * Canonical Deal Desk control mutation overlay.
 *
 * One server-derived value per field, one scoped optimistic overlay per conversation,
 * strict validation before write, authoritative readback after write, real rollback, and
 * per-field last-write-wins stale-response protection. Polling/realtime values remain the
 * fallback truth and cannot overwrite a pending overlay.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

export type CanonicalControlValue = string | boolean

export interface CanonicalControlMutationResult {
  ok: boolean
  row?: Record<string, unknown> | null
  errorMessage?: string | null
  errorCode?: string | null
}

export interface CanonicalControlSpec<T extends CanonicalControlValue = CanonicalControlValue> {
  field: string
  serverValue: T
  resolve: (value: unknown) => VocabularyResolution<T>
  /** Optional operator/business preflight. Server enforcement remains authoritative. */
  preflight?: (canonicalValue: T) => string | null
  persist: (canonicalValue: T) => Promise<CanonicalControlMutationResult>
  readBack: (row: Record<string, unknown> | null | undefined) => T | null
}

export interface CanonicalControlHandle<T extends CanonicalControlValue = CanonicalControlValue> {
  value: T
  pending: boolean
  failed: boolean
  errorMessage: string | null
  unsupported: boolean
  unsupportedReason: string | null
  commit: (next: T) => Promise<void>
  dismissError: () => void
}

export interface CanonicalControlTelemetryEvent {
  event: 'unsupported_thread_control' | 'control_mutation_failed'
  field: string
  reason: string
  errorCode?: string
  /** Opaque selection source only; never a phone, seller name, or message body. */
  selectionSource: string | null
}

export interface CanonicalControlMutationOptions {
  onTelemetry?: (event: CanonicalControlTelemetryEvent) => void
}

type Overlay<T extends CanonicalControlValue> =
  | { kind: 'pending'; optimisticValue: T; mutationId: string; rollbackValue?: T; serverValueAtStart: T }
  | { kind: 'confirmed'; persistedValue: T }
  | {
      kind: 'failed'
      error: { kind: MutationErrorKind; message: string; code?: string }
      rollbackValue?: T
      serverValueAtStart?: T
    }

/**
 * The value a rollback restores.
 *
 * The last value the SERVER confirmed, when this control has confirmed one that the
 * caller's row has not caught up to yet; otherwise the authoritative row itself.
 *
 * Without the first branch, a successful write followed by a failed one displayed the
 * PRE-SUCCESS row value — the operator saw a value the database no longer held, because
 * the confirmed overlay was discarded along with the failed attempt. A rollback must undo
 * the failed write, not the successful one before it.
 */
const rollbackValueOf = <T extends CanonicalControlValue>(
  existing: Overlay<T> | undefined,
  lastConfirmed: T | undefined,
): T | undefined => {
  if (existing?.kind === 'confirmed') return existing.persistedValue
  if (existing?.rollbackValue !== undefined) return existing.rollbackValue
  // The confirmed overlay retires as soon as the authoritative row agrees with it, so by
  // the time a LATER write fails it may be gone — and a stale list read can then flip the
  // row back to its pre-write value. Remembering the last confirmed value per field keeps
  // the rollback target correct across that window.
  return lastConfirmed
}

/**
 * A rollback target stands in for an authoritative row that has not caught up yet, and
 * retires the moment the row DOES catch up.
 *
 * It deliberately does not retire on any other change to the row. `onRefetch` re-reads the
 * inbox list through `backendClient`'s GET cache, so a refresh issued right after a
 * confirmed write can be served a pre-write body — the row flips back to its old value
 * while the database holds the new one. Retiring on "the row changed at all" let that
 * stale read win and the control displayed a value the server no longer held.
 *
 * The target came from the server's own authoritative response, so while it disagrees with
 * the row it is the better information. The read-path caching that makes this necessary is
 * an N.3 concern.
 */
const rollbackStillApplies = <T extends CanonicalControlValue>(
  overlay: Extract<Overlay<T>, { kind: 'failed' }>,
  serverValue: T,
): boolean => overlay.rollbackValue !== undefined && overlay.rollbackValue !== serverValue

const UNSUPPORTED_MESSAGE =
  'This conversation has no writable canonical phone route, so its state cannot be saved.'

const overlayKey = (scope: string, field: string): string => `${scope}::${field}`

const DEFAULT_FAILURE_MESSAGE = 'The change could not be saved.'

/**
 * Server reason code → operator-facing message.
 *
 * Two things must never reach the operator, and both used to:
 *   - the raw reason CODE (`automation_resume_blocked_suppressed`), an internal identifier;
 *   - `BackendClientError.message`, which embeds the request URL — and the thread key in
 *     that URL is the seller's phone number.
 * Only the code crosses this boundary, and only as a lookup key.
 */
const SERVER_REASON_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  automation_resume_blocked_suppressed:
    'This conversation is suppressed. Automation cannot be resumed until suppression is lifted.',
  automation_resume_blocked_archived:
    'This conversation is archived. Restore it before resuming automation.',
  automation_resume_blocked_closed:
    'This lead is closed. Move it out of the closed stage before resuming automation.',
  automation_resume_blocked_contactability:
    'This contact is not reachable. Automation cannot be resumed until contactability is restored.',
  manual_stage_lock_blocked_stage_write:
    'A manual stage lock is active on this lead, so the stage was not changed.',
  invalid_canonical_thread_key:
    'This conversation has no writable canonical phone route, so its state cannot be saved.',
  no_allowed_patch_fields:
    'The server did not accept this value, so nothing was saved.',
})

/** Execution-status refusals are generated per status, so they are matched by prefix. */
const EXECUTION_BLOCK_PREFIX = 'automation_resume_blocked_execution_'

/**
 * Localised, identifier-free explanation for a control failure.
 *
 * The table lookup is an own-property check, not `MAP[key]`. A bare index reaches the
 * prototype chain — `Object.freeze` does not detach `Object.prototype` — so a code of
 * `constructor` would return the `Object` **function** typed as a string and render it into
 * the error surface. Same defect class as the alias lookup in the control vocabularies.
 */
/**
 * May a server-supplied string be shown to an operator verbatim?
 *
 * Conservative by construction: this is the fallback for text this codebase did NOT
 * author, and the thing it must never leak is contact data. The previous version
 * enumerated only `https?://` and a US `+1` E.164 number, so a non-US number
 * (`+447700900123`), a bare thread key (`9015551234`) or a formatted US number
 * (`+1 (901) 555-1234`) went straight through.
 *
 * Rejected: any URL or scheme-less host, the transport's `(body: …)` preview, a bare
 * identifier, and ANY run of seven or more digits once phone separators are removed —
 * seven because that is the length of a local subscriber number.
 */
const isOperatorSafeMessage = (message: string): boolean => {
  if (!message) return false
  // A bare snake_case / kebab-case token is an identifier, not a sentence.
  if (/^[a-z0-9_-]+$/i.test(message)) return false
  if (message.includes('://')) return false
  if (message.includes('(body:')) return false
  // Scheme-less host, e.g. `api.example.com/api/...`.
  if (/\b[a-z0-9-]+(\.[a-z0-9-]+){1,}\.[a-z]{2,}\b/i.test(message)) return false
  // Digit runs, ignoring the characters a phone number is normally punctuated with.
  if (/\d{7,}/.test(message.replace(/[\s().+-]/g, ''))) return false
  return true
}

export const describeControlFailure = (
  reasonCode: string | null | undefined,
  fallbackMessage?: string | null,
): string => {
  const key = String(reasonCode ?? '').trim().toLowerCase()
  if (key) {
    if (Object.prototype.hasOwnProperty.call(SERVER_REASON_MESSAGES, key)) {
      const message = SERVER_REASON_MESSAGES[key]
      if (typeof message === 'string') return message
    }
    if (key.startsWith(EXECUTION_BLOCK_PREFIX)) {
      return 'Automation cannot be resumed while this conversation is in a terminal execution state.'
    }
  }
  const fallback = String(fallbackMessage ?? '').trim()
  return isOperatorSafeMessage(fallback) ? fallback : DEFAULT_FAILURE_MESSAGE
}



export function useCanonicalControlMutations<T extends CanonicalControlValue>(
  thread: ThreadIdentityInput,
  specs: ReadonlyArray<CanonicalControlSpec<T>>,
  options: CanonicalControlMutationOptions = {},
): Record<string, CanonicalControlHandle<T>> {
  const reference = useMemo(() => resolveDealDeskThreadReference(thread), [thread])
  const writable = useMemo(() => resolveDealDeskWritableThreadKey(thread), [thread])
  const scope = reference?.selectionKey || 'unresolved-thread'
  const unsupported = !writable?.ok
  const unsupportedReason = unsupported ? UNSUPPORTED_MESSAGE : null

  const [tracker] = useState(() => createFieldMutationTracker())
  const [overlays, setOverlays] = useState<Record<string, Overlay<T> | undefined>>({})

  /**
   * Last value the server confirmed for each field, per conversation.
   *
   * A ref, not state: it never affects rendering on its own — it only supplies the
   * rollback target when a failure happens after the confirmed overlay has retired.
   * Keyed by the same scoped overlay key, so it cannot leak across conversations.
   */
  const lastConfirmedRef = useRef<Record<string, T | undefined>>({})

  /** Set an overlay from the one currently in place, so the rollback target survives a
   *  transition. */
  const updateOverlay = useCallback(
    (key: string, next: (existing: Overlay<T> | undefined) => Overlay<T>) => {
      setOverlays((current) => ({ ...current, [key]: next(current[key]) }))
    },
    [],
  )

  const setOverlay = useCallback((key: string, next: Overlay<T> | undefined) => {
    setOverlays((current) => {
      if (current[key] === next) return current
      const updated = { ...current }
      if (next === undefined) delete updated[key]
      else updated[key] = next
      return updated
    })
  }, [])

  const commit = useCallback(async (spec: CanonicalControlSpec<T>, next: T) => {
    const field = spec.field
    const key = overlayKey(scope, field)

    if (unsupported) {
      setOverlay(key, { kind: 'failed', error: { kind: 'missing_writable_route', message: UNSUPPORTED_MESSAGE } })
      options.onTelemetry?.({
        event: 'unsupported_thread_control',
        field,
        reason: writable && !writable.ok ? writable.reason : 'no_canonical_route',
        selectionSource: reference?.source || null,
      })
      return
    }

    const resolution = spec.resolve(next)
    if (!resolution.ok) {
      setOverlay(key, {
        kind: 'failed',
        error: {
          kind: resolution.reason === 'unmapped_legacy' ? 'unsupported_legacy_value' : 'invalid_value',
          message: describeVocabularyRejection(resolution),
        },
      })
      return
    }

    const preflightFailure = spec.preflight?.(resolution.value) || null
    if (preflightFailure) {
      setOverlay(key, { kind: 'failed', error: { kind: 'invalid_value', message: preflightFailure } })
      return
    }

    const mutationId = tracker.begin(key)
    updateOverlay(key, (existing) => ({
      kind: 'pending',
      optimisticValue: resolution.value,
      mutationId,
      rollbackValue: rollbackValueOf(existing, lastConfirmedRef.current[key]),
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

    if (!tracker.settle(key, mutationId)) return

    if (!result.ok) {
      const code = result.errorCode ?? undefined
      updateOverlay(key, (existing) => ({
        kind: 'failed',
        error: {
          kind: transportFailed ? 'network' : 'server_error',
          message: describeControlFailure(code, result.errorMessage),
          code,
        },
        rollbackValue: rollbackValueOf(existing, lastConfirmedRef.current[key]),
        serverValueAtStart: existing?.kind === 'pending' ? existing.serverValueAtStart : undefined,
      }))
      options.onTelemetry?.({
        event: 'control_mutation_failed',
        field,
        reason: transportFailed ? 'network' : 'server_rejection',
        errorCode: code,
        selectionSource: reference?.source || null,
      })
      return
    }

    const persisted = spec.readBack(result.row)
    if (persisted == null) {
      updateOverlay(key, (existing) => ({
        kind: 'failed',
        error: {
          kind: 'malformed_response',
          message: 'Saved, but the server did not confirm the new value. Reload to see the current state.',
        },
        rollbackValue: rollbackValueOf(existing, lastConfirmedRef.current[key]),
        serverValueAtStart: existing?.kind === 'pending' ? existing.serverValueAtStart : undefined,
      }))
      return
    }

    lastConfirmedRef.current[key] = persisted
    setOverlay(key, { kind: 'confirmed', persistedValue: persisted })
  }, [options, reference?.source, scope, setOverlay, tracker, unsupported, updateOverlay, writable])

  /**
   * Retire overlays whose purpose the authoritative row has taken over.
   *
   * Two cases, and both must be retired IN STATE rather than only for a render:
   *   - a `confirmed` overlay once the row carries the value it confirmed;
   *   - a failed overlay's `rollbackValue` once the row carries that value.
   *
   * Stripping the rollback target for the current render only left it in state, so when
   * the row later moved to a THIRD value the guard passed again and the retired target
   * revived — masking a genuine server-side change with a stale value. The remembered
   * last-confirmed value is dropped at the same moment, for the same reason.
   */
  useEffect(() => {
    const retireConfirmed: string[] = []
    const retireRollback: string[] = []
    for (const spec of specs) {
      const key = overlayKey(scope, spec.field)
      const overlay = overlays[key]
      if (overlay?.kind === 'confirmed' && overlay.persistedValue === spec.serverValue) {
        retireConfirmed.push(key)
      }
      if (overlay?.kind === 'failed' && overlay.rollbackValue !== undefined
        && overlay.rollbackValue === spec.serverValue) {
        retireRollback.push(key)
      }
      if (lastConfirmedRef.current[key] !== undefined && lastConfirmedRef.current[key] === spec.serverValue) {
        delete lastConfirmedRef.current[key]
      }
    }
    if (!retireConfirmed.length && !retireRollback.length) return
    const timer = window.setTimeout(() => {
      setOverlays((current) => {
        const next = { ...current }
        let changed = false
        for (const key of retireConfirmed) {
          if (next[key]?.kind === 'confirmed') {
            delete next[key]
            changed = true
          }
        }
        for (const key of retireRollback) {
          const overlay = next[key]
          if (overlay?.kind === 'failed' && overlay.rollbackValue !== undefined) {
            next[key] = { kind: 'failed', error: overlay.error }
            changed = true
          }
        }
        return changed ? next : current
      })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [overlays, scope, specs])

  return useMemo(() => {
    const out: Record<string, CanonicalControlHandle<T>> = {}
    for (const spec of specs) {
      const key = overlayKey(scope, spec.field)
      let overlay = overlays[key]
      // A rollback target retires as soon as the authoritative row changes, so it can
      // never mask a later server-side change.
      if (overlay?.kind === 'failed' && !rollbackStillApplies(overlay, spec.serverValue)) {
        overlay = { kind: 'failed', error: overlay.error }
      }
      out[spec.field] = {
        value: overlay?.kind === 'pending'
          ? overlay.optimisticValue
          : overlay?.kind === 'confirmed'
            ? overlay.persistedValue
            : overlay?.kind === 'failed'
              ? overlay.rollbackValue ?? spec.serverValue
              : spec.serverValue,
        pending: overlay?.kind === 'pending',
        failed: overlay?.kind === 'failed',
        errorMessage: overlay?.kind === 'failed' ? overlay.error.message : null,
        unsupported,
        unsupportedReason,
        commit: (next: T) => commit(spec, next),
        dismissError: () => setOverlay(key, undefined),
      }
    }
    return out
  }, [commit, overlays, scope, setOverlay, specs, unsupported, unsupportedReason])
}
