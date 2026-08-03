/**
 * The one function that turns an operator's canonical field choice into a request.
 *
 * Both writers use it:
 *   - `useDealDeskThreadControls` (the state bar and every surface sharing its handles),
 *     which wraps it in the optimistic/rollback state machine;
 *   - `useCanonicalThreadWriter` (thread rows, context menus, quick actions), which has no
 *     control to roll back and so calls it directly.
 *
 * Because both go through here, they cannot disagree about the vocabulary, the request
 * body, the resume guard, the thread key, or what counts as success. A second
 * *serialization* owner would still be a defect, which is why the writer hook routes
 * through the context's handles whenever the target is the open conversation.
 */

import {
  buildControlWritePayload,
  describeServerRefusal,
  type DealDeskControlField,
} from '../../domain/inbox/deal-desk-control-contract'
import {
  describeThreadReference,
  type ThreadIdentityInput,
} from '../../domain/inbox/canonical-thread-reference'
import {
  resolveDealDeskThreadReference,
  resolveDealDeskWritableThreadKey,
} from '../../domain/inbox/deal-desk-thread-reference'
import {
  evaluateAutomationResume,
  isResumeTransition,
  resolveOperatorAutomationModeForControl,
} from '../../domain/lead-state/automation-persistence-contract'
import { patchLeadStateFromView } from '../../domain/lead-state/persistUniversalLeadState'
import type { CanonicalControlMutationResult } from './useCanonicalControlMutation'

export const DEAL_DESK_SOURCE_VIEW = 'deal_desk'

export const UNSUPPORTED_ROUTE_MESSAGE =
  'This conversation has no writable canonical phone route, so its state cannot be saved.'

export interface DealDeskControlTelemetry {
  event: 'control_write_refused' | 'control_write_failed' | 'control_write_confirmed'
  field: DealDeskControlField
  /** Machine-readable reason. Never an operator-facing string. */
  reason: string
  /**
   * Phone-masked thread diagnostic (`key=… source=… phone=+1*****1234 writable=…`).
   * `describeThreadReference` masks every embedded number, including one inside a
   * composite selection key, so no telemetry line can carry a dialable seller number.
   */
  thread: string
}

const isDev = (): boolean => {
  try {
    return Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV)
  } catch {
    return false
  }
}

export const defaultControlTelemetry = (event: DealDeskControlTelemetry): void => {
  // Dev console only, and only the masked diagnostic. No seller name, no full phone
  // number, no message body — a telemetry line must be safe to ship to a log sink.
  if (isDev()) console.info('[DealDeskControl]', event)
}

/**
 * Interpret one lead-state response.
 *
 * Two shapes must both count as failure, and only one of them is an HTTP error:
 *   - transport / 4xx / 5xx → `ok: false`;
 *   - HTTP 200 with `{ ok: true, blocked: true, reason }` → the server accepted the
 *     request and wrote nothing, because a guard dropped every field. Reporting that as
 *     success is how a stage-lock refusal used to render as "Action completed
 *     successfully" under a green toast.
 *
 * `errorMessage` is always localised from the reason CODE. The transport's own message is
 * never forwarded: it embeds the request URL, and the thread key in that URL is the
 * seller's phone number.
 */
export const interpretLeadStateResponse = (result: {
  ok: boolean
  errorCode?: string | null
  data?: unknown
}): CanonicalControlMutationResult => {
  if (!result.ok) {
    const code = result.errorCode ?? null
    return { ok: false, row: null, errorMessage: describeServerRefusal(code), errorCode: code }
  }
  const body = (result.data ?? {}) as Record<string, unknown>
  if (body.blocked === true) {
    const code = typeof body.reason === 'string' ? body.reason : null
    return { ok: false, row: null, errorMessage: describeServerRefusal(code), errorCode: code }
  }
  const row = (body.row ?? null) as Record<string, unknown> | null
  return { ok: true, row }
}

export interface PersistControlFieldOptions {
  onTelemetry?: (event: DealDeskControlTelemetry) => void
}

/**
 * Validate, guard, serialize and send one canonical field write.
 *
 * Refuses locally — with no request emitted — when:
 *   - the thread has no server-writable canonical phone route (DD-003);
 *   - the value has no serializable form for this field;
 *   - the write is a resume on a suppressed or terminal record.
 */
export const persistDealDeskControlField = async (
  thread: ThreadIdentityInput,
  field: DealDeskControlField,
  canonicalValue: string,
  options: PersistControlFieldOptions = {},
): Promise<CanonicalControlMutationResult> => {
  const emit = options.onTelemetry ?? defaultControlTelemetry
  const diagnostic = describeThreadReference(resolveDealDeskThreadReference(thread))
  const route = resolveDealDeskWritableThreadKey(thread)

  if (!route?.ok) {
    emit({ event: 'control_write_refused', field, reason: route?.reason ?? 'no_thread_reference', thread: diagnostic })
    return { ok: false, row: null, errorMessage: UNSUPPORTED_ROUTE_MESSAGE, errorCode: 'missing_writable_route' }
  }

  if (field === 'automation_state') {
    const resolved = resolveOperatorAutomationModeForControl(canonicalValue)
    if (resolved.ok && isResumeTransition(resolved.value)) {
      const eligibility = evaluateAutomationResume(thread)
      if (!eligibility.allowed) {
        emit({ event: 'control_write_refused', field, reason: eligibility.reason ?? 'resume_blocked', thread: diagnostic })
        return {
          ok: false,
          row: null,
          errorMessage: eligibility.message ?? 'Automation cannot be resumed for this conversation.',
          errorCode: eligibility.reason ?? 'resume_blocked',
        }
      }
    }
  }

  const payload = buildControlWritePayload(field, canonicalValue)
  if (!payload) {
    emit({ event: 'control_write_refused', field, reason: 'unserializable_value', thread: diagnostic })
    return { ok: false, row: null, errorMessage: 'That value cannot be saved.', errorCode: 'unserializable_value' }
  }

  const result = await patchLeadStateFromView(
    DEAL_DESK_SOURCE_VIEW,
    route.threadKey,
    payload.patch,
    payload.meta,
  )
  const interpreted = interpretLeadStateResponse(result)
  emit({
    event: interpreted.ok ? 'control_write_confirmed' : 'control_write_failed',
    field,
    reason: interpreted.ok ? 'ok' : (interpreted.errorCode ?? 'unknown'),
    thread: diagnostic,
  })
  return interpreted
}
