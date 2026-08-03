/**
 * The single canonical operator writer for Deal Desk thread state.
 *
 * Every control that changes lifecycle stage, operational status, lead temperature,
 * automation mode or read state goes through this hook — including the ones rendered in
 * Deal Intelligence, the conversation header and the intelligence panel, which consume it
 * through `DealDeskControlsContext` rather than owning a second mutation path.
 *
 * What this hook composes:
 *   - N.1 identity        `resolveDealDeskWritableThreadKey` — a UUID or `ct:…` composite
 *                         is never sent to the server's `/^\+1\d{10}$/` guard.
 *   - N.2 vocabularies    strict per-dimension resolvers; no silent coercion.
 *   - N.2 state machine   optimistic apply, real rollback, per-field serialization,
 *                         authoritative confirmation (`useCanonicalControlMutation`).
 *   - N.2 automation      `automation_state` as the write target, never `automation_status`,
 *                         never the hydrated view's COALESCE of the two.
 *
 * Reconciliation is derivation: the authoritative value is always the thread row, and this
 * hook only holds an in-flight overlay on top of it. Polling, realtime patches and list
 * refreshes therefore reconcile for free and can never overwrite a pending operator write.
 */

import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import {
  readAutomationValue,
  readBackControlValue,
  readManualStageLock,
  readReadStateValue,
  readStageValue,
  readStatusValue,
  readTemperatureValue,
  resolveReadStateForWrite,
  type DealDeskControlField,
  type ReadStateCode,
  type ResolvedControlValue,
} from '../../domain/inbox/deal-desk-control-contract'
import type { ThreadIdentityInput } from '../../domain/inbox/canonical-thread-reference'
import {
  resolveDealDeskThreadReference,
  resolveDealDeskWritableThreadKey,
} from '../../domain/inbox/deal-desk-thread-reference'
import {
  evaluateAutomationResume,
  readQueueStatusFromThread,
  resolveOperatorAutomationModeForControl,
  type AutomationModeCode,
} from '../../domain/lead-state/automation-persistence-contract'
import {
  resolveLeadTemperatureForWrite,
  resolveLifecycleStageForWrite,
  resolveOperationalStatusForWrite,
} from '../../domain/lead-state/canonical-control-vocabularies'
import {
  persistDealDeskControlField,
  type DealDeskControlTelemetry,
} from './persistDealDeskControlField'
import type {
  LeadTemperatureCode,
  LifecycleStageCode,
  OperationalStatusCode,
} from '../../domain/lead-state/universal-lead-state-registry'
import {
  useCanonicalControlMutations,
  type CanonicalControlHandle,
  type CanonicalControlMutationResult,
  type CanonicalControlSpec,
  type ControlCommitOutcome,
} from './useCanonicalControlMutation'

export interface DealDeskControlsOptions {
  /** Called after a confirmed write so the caller can refresh the authoritative row. */
  onPersisted?: (threadKey: string, field: DealDeskControlField) => void
  /** Structured, phone-masked telemetry sink. Defaults to a dev-only console line. */
  onTelemetry?: (event: DealDeskControlTelemetry) => void
}

export interface DealDeskControls {
  /** Null when the record carries no usable identity at all. */
  threadReference: ReturnType<typeof resolveDealDeskThreadReference>
  /** True when this thread has no server-writable canonical phone route. */
  unsupported: boolean
  unsupportedReason: string | null

  stage: CanonicalControlHandle<LifecycleStageCode> & { current: ResolvedControlValue<LifecycleStageCode> }
  status: CanonicalControlHandle<OperationalStatusCode> & { current: ResolvedControlValue<OperationalStatusCode> }
  temperature: CanonicalControlHandle<LeadTemperatureCode> & { current: ResolvedControlValue<LeadTemperatureCode> }
  automation: CanonicalControlHandle<AutomationModeCode> & { current: ResolvedControlValue<AutomationModeCode> }
  read: CanonicalControlHandle<ReadStateCode> & { current: ResolvedControlValue<ReadStateCode> }

  /** `manual_stage_lock` — a lock concept, deliberately not inferred from automation mode. */
  manualStageLock: boolean
  /** `automation_status` verbatim — queue/execution information, display only. */
  queueStatus: string | null
  /** Why a resume would be refused, or null when it is allowed. */
  resumeBlockedReason: string | null

  /** Convenience wrappers. Each is the same single write as the matching `commit`. */
  pauseAutomation: () => Promise<ControlCommitOutcome>
  resumeAutomation: () => Promise<ControlCommitOutcome>
  takeManualControl: () => Promise<ControlCommitOutcome>
  markRead: () => Promise<ControlCommitOutcome>
  markUnread: () => Promise<ControlCommitOutcome>

  anyPending: boolean
}

const UNSUPPORTED_MESSAGE =
  'This conversation has no writable canonical phone route, so its state cannot be saved.'

export function useDealDeskThreadControls(
  thread: ThreadIdentityInput,
  options: DealDeskControlsOptions = {},
): DealDeskControls {
  const { onPersisted, onTelemetry } = options

  const threadReference = useMemo(() => resolveDealDeskThreadReference(thread), [thread])
  const writable = useMemo(() => resolveDealDeskWritableThreadKey(thread), [thread])
  const unsupported = !writable?.ok

  // Read through a ref inside callbacks so a mutation stays bound to the thread it started
  // on: `thread` changing mid-flight must not redirect an in-flight write, and must not
  // re-create `persist` in a way that invalidates the per-field serialization.
  // Assigned in a layout effect, never during render (N.1 §I.1).
  const threadRef = useRef(thread)
  useLayoutEffect(() => { threadRef.current = thread }, [thread])

  /**
   * The write is bound to the thread the operator acted on, read from a ref at call time.
   * A selection change while the request is in flight therefore cannot redirect it, and
   * the `onPersisted` callback still names the original conversation.
   */
  const persistField = useCallback(
    async (field: DealDeskControlField, canonicalValue: string): Promise<CanonicalControlMutationResult> => {
      const currentThread = threadRef.current
      const route = resolveDealDeskWritableThreadKey(currentThread)
      const result = await persistDealDeskControlField(currentThread, field, canonicalValue, { onTelemetry })
      if (result.ok && route?.ok) onPersisted?.(route.threadKey, field)
      return result
    },
    [onPersisted, onTelemetry],
  )

  const stageCurrent = useMemo(() => readStageValue(thread), [thread])
  const statusCurrent = useMemo(() => readStatusValue(thread), [thread])
  const temperatureCurrent = useMemo(() => readTemperatureValue(thread), [thread])
  const automationCurrent = useMemo(() => readAutomationValue(thread), [thread])
  const readCurrent = useMemo(() => readReadStateValue(thread), [thread])

  /**
   * `serverValue` is the canonical value when there is one, and the RAW stored value when
   * there is not. Falling back to a canonical default here is exactly the DD-002 defect —
   * the control must show `mf_suppressed`, not `S1 Ownership Check`.
   */
  const specs = useMemo<ReadonlyArray<CanonicalControlSpec<string>>>(() => [
    {
      field: 'lifecycle_stage',
      serverValue: stageCurrent.canonical ?? stageCurrent.raw,
      resolve: resolveLifecycleStageForWrite,
      persist: (value: string) => persistField('lifecycle_stage', value),
      readBack: (row) => readBackControlValue('lifecycle_stage', row),
    },
    {
      field: 'operational_status',
      serverValue: statusCurrent.canonical ?? statusCurrent.raw,
      resolve: resolveOperationalStatusForWrite,
      persist: (value: string) => persistField('operational_status', value),
      readBack: (row) => readBackControlValue('operational_status', row),
    },
    {
      field: 'lead_temperature',
      serverValue: temperatureCurrent.canonical ?? temperatureCurrent.raw,
      resolve: resolveLeadTemperatureForWrite,
      persist: (value: string) => persistField('lead_temperature', value),
      readBack: (row) => readBackControlValue('lead_temperature', row),
    },
    {
      field: 'automation_state',
      serverValue: automationCurrent.canonical ?? automationCurrent.raw,
      resolve: resolveOperatorAutomationModeForControl,
      persist: (value: string) => persistField('automation_state', value),
      readBack: (row) => readBackControlValue('automation_state', row),
    },
    {
      field: 'is_read',
      serverValue: readCurrent.canonical ?? 'unread',
      resolve: resolveReadStateForWrite,
      persist: (value: string) => persistField('is_read', value),
      readBack: (row) => readBackControlValue('is_read', row),
    },
  ], [
    automationCurrent, persistField, readCurrent,
    stageCurrent, statusCurrent, temperatureCurrent,
  ])

  const handles = useCanonicalControlMutations<string>(thread, specs)

  const manualStageLock = useMemo(() => readManualStageLock(thread), [thread])
  const queueStatus = useMemo(() => readQueueStatusFromThread(thread), [thread])
  const resumeEligibility = useMemo(() => evaluateAutomationResume(thread), [thread])

  const automationHandle = handles.automation_state
  const readHandle = handles.is_read

  const pauseAutomation = useCallback(() => automationHandle.commit('paused'), [automationHandle])
  const resumeAutomation = useCallback(() => automationHandle.commit('active'), [automationHandle])
  const takeManualControl = useCallback(() => automationHandle.commit('human_controlled'), [automationHandle])
  const markRead = useCallback(() => readHandle.commit('read'), [readHandle])
  const markUnread = useCallback(() => readHandle.commit('unread'), [readHandle])

  return useMemo(() => ({
    threadReference,
    unsupported,
    unsupportedReason: unsupported ? UNSUPPORTED_MESSAGE : null,
    stage: { ...(handles.lifecycle_stage as CanonicalControlHandle<LifecycleStageCode>), current: stageCurrent },
    status: { ...(handles.operational_status as CanonicalControlHandle<OperationalStatusCode>), current: statusCurrent },
    temperature: { ...(handles.lead_temperature as CanonicalControlHandle<LeadTemperatureCode>), current: temperatureCurrent },
    automation: { ...(automationHandle as CanonicalControlHandle<AutomationModeCode>), current: automationCurrent },
    read: { ...(readHandle as CanonicalControlHandle<ReadStateCode>), current: readCurrent },
    manualStageLock,
    queueStatus,
    resumeBlockedReason: resumeEligibility.allowed ? null : (resumeEligibility.message ?? null),
    pauseAutomation,
    resumeAutomation,
    takeManualControl,
    markRead,
    markUnread,
    anyPending: Object.values(handles).some((handle) => handle.pending),
  }), [
    automationCurrent, automationHandle, handles, manualStageLock, markRead, markUnread,
    pauseAutomation, queueStatus, readCurrent, readHandle, resumeAutomation,
    resumeEligibility, stageCurrent, statusCurrent, takeManualControl, temperatureCurrent,
    threadReference, unsupported,
  ])
}
