/**
 * Canonical Deal Desk control mutation overlay.
 *
 * One server-derived value per field, one scoped optimistic overlay per conversation,
 * strict validation before write, authoritative readback after write, real rollback, and
 * per-field last-write-wins stale-response protection. Polling/realtime values remain the
 * fallback truth and cannot overwrite a pending overlay.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
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
  | { kind: 'pending'; optimisticValue: T; mutationId: string }
  | { kind: 'confirmed'; persistedValue: T }
  | { kind: 'failed'; error: { kind: MutationErrorKind; message: string; code?: string } }

const UNSUPPORTED_MESSAGE =
  'This conversation has no writable canonical phone route, so its state cannot be saved.'

const overlayKey = (scope: string, field: string): string => `${scope}::${field}`

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
    setOverlay(key, { kind: 'pending', optimisticValue: resolution.value, mutationId })

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
      setOverlay(key, {
        kind: 'failed',
        error: {
          kind: transportFailed ? 'network' : 'server_error',
          message: result.errorMessage || 'The change could not be saved.',
          code,
        },
      })
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
      setOverlay(key, {
        kind: 'failed',
        error: {
          kind: 'malformed_response',
          message: 'Saved, but the server did not confirm the new value. Reload to see the current state.',
        },
      })
      return
    }

    setOverlay(key, { kind: 'confirmed', persistedValue: persisted })
  }, [options, reference?.source, scope, setOverlay, tracker, unsupported, writable])

  useEffect(() => {
    const caughtUp: string[] = []
    for (const spec of specs) {
      const key = overlayKey(scope, spec.field)
      const overlay = overlays[key]
      if (overlay?.kind === 'confirmed' && overlay.persistedValue === spec.serverValue) caughtUp.push(key)
    }
    if (!caughtUp.length) return
    const timer = window.setTimeout(() => {
      setOverlays((current) => {
        const next = { ...current }
        let changed = false
        for (const key of caughtUp) {
          if (next[key]?.kind === 'confirmed') {
            delete next[key]
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
      const overlay = overlays[key]
      out[spec.field] = {
        value: overlay?.kind === 'pending'
          ? overlay.optimisticValue
          : overlay?.kind === 'confirmed'
            ? overlay.persistedValue
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
