/**
 * Deal Desk control ownership, shared across surfaces — context and consumer hooks.
 *
 * Split from the provider component so this module exports no components: a file that
 * mixes components with hooks/constants breaks Fast Refresh (`react-refresh/only-export-components`).
 *
 * The provider is the ONE place `useDealDeskThreadControls` is instantiated for the
 * selected conversation. Every other surface — the conversation state bar, Deal
 * Intelligence, the intelligence panel, thread rows — reads the same handles out of this
 * context instead of instantiating a second mutation path.
 *
 * That is what makes "one logical mutation owner per field" enforceable rather than
 * aspirational: a second owner would need its own `useDealDeskThreadControls` call, and
 * `tests/unit/deal-desk-writer-ownership.test.ts` fails the build if one appears.
 *
 * A consumer that names a *different* thread than the provider's gets `null` and must
 * render a read-only mirror. It must never fall back to writing on its own.
 */

import { createContext, useCallback, useContext, useMemo } from 'react'
import { dealDeskThreadMatchesRef } from '../../domain/inbox/deal-desk-thread-reference'
import type { ThreadIdentityInput } from '../../domain/inbox/canonical-thread-reference'
import type { DealDeskControlField } from '../../domain/inbox/deal-desk-control-contract'
import { persistDealDeskControlField } from './persistDealDeskControlField'
import type { ControlCommitOutcome } from './useCanonicalControlMutation'
import type { DealDeskControls } from './useDealDeskThreadControls'

export interface DealDeskControlsContextValue {
  controls: DealDeskControls
  /** The thread the controls are bound to. */
  thread: ThreadIdentityInput
}

export const DealDeskControlsContext = createContext<DealDeskControlsContextValue | null>(null)

/**
 * The canonical controls for the currently selected conversation, or null when there is
 * no provider.
 */
export const useDealDeskControls = (): DealDeskControls | null =>
  useContext(DealDeskControlsContext)?.controls ?? null

/**
 * The canonical controls **for a specific thread**.
 *
 * Returns null when the provider is bound to a different conversation, so a panel showing
 * a stale or secondary thread renders a read-only mirror rather than writing to the wrong
 * record. Identity is compared through the N.1 canonical reference, not by string equality
 * on `threadKey`, so a composite key and a bare phone for the same conversation match.
 */
export const useDealDeskControlsForThread = (
  ref: unknown,
): DealDeskControls | null => {
  const context = useContext(DealDeskControlsContext)
  return useMemo(() => {
    if (!context) return null
    if (ref === undefined || ref === null || ref === '') return null
    if (typeof ref === 'string') {
      return dealDeskThreadMatchesRef(context.thread, ref) ? context.controls : null
    }
    // A thread-shaped record: compare both directions so either side may carry the
    // richer identity (one may have only a row id, the other only a composite key).
    const other = ref as Record<string, unknown>
    const otherKey = String(other.threadKey ?? other.thread_key ?? other.id ?? '').trim()
    return otherKey && dealDeskThreadMatchesRef(context.thread, otherKey) ? context.controls : null
  }, [context, ref])
}

const HANDLE_BY_FIELD = {
  lifecycle_stage: 'stage',
  operational_status: 'status',
  lead_temperature: 'temperature',
  automation_state: 'automation',
  is_read: 'read',
} as const satisfies Record<DealDeskControlField, keyof DealDeskControls>

/**
 * Write a canonical field for ANY thread — a list row, a context menu, a keyboard action.
 *
 * When the target is the conversation the provider is bound to, the write goes through
 * that conversation's control handle, so it shares the open thread's serialization,
 * optimistic overlay and rollback. A row action and the state bar therefore cannot race
 * on the same field.
 *
 * When the target is a different thread, there is no control to roll back and no overlay
 * to keep consistent, so the write goes straight through the shared writer — the same
 * vocabulary, guards and request body, minus the UI state machine.
 */
export const useCanonicalThreadWriter = (): (
  thread: ThreadIdentityInput,
  field: DealDeskControlField,
  value: string,
) => Promise<ControlCommitOutcome> => {
  const context = useContext(DealDeskControlsContext)
  return useCallback(async (thread, field, value) => {
    const record = (thread ?? {}) as Record<string, unknown>
    const key = String(record.threadKey ?? record.thread_key ?? record.id ?? '').trim()
    if (context && key && dealDeskThreadMatchesRef(context.thread, key)) {
      const handle = context.controls[HANDLE_BY_FIELD[field]] as {
        commit: (next: string) => Promise<ControlCommitOutcome>
      }
      return handle.commit(value)
    }
    const result = await persistDealDeskControlField(thread, field, value)
    return {
      ok: result.ok,
      errorMessage: result.errorMessage ?? null,
      errorCode: result.errorCode ?? null,
      superseded: false,
    }
  }, [context])
}
