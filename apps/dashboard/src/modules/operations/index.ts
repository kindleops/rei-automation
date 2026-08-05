/**
 * Operations Center — public surface.
 *
 * This is the mount contract Lane A consumes for the two global top-rail slots
 * ("Operational Intelligence" and "Live Activity"). Everything a host needs is
 * exported here; nothing else in `modules/operations/**` is intended for
 * outside use.
 *
 * Mounting from the rail
 * ----------------------
 *   const triggerRef = useRef<HTMLButtonElement>(null)
 *   const { status, attentionCount, unreadCount } = useOperationsSummary()
 *
 *   <button ref={triggerRef} onClick={() => setOpen(o => !o)}
 *           aria-expanded={open} aria-haspopup="dialog"
 *           title={`Operations — ${status.label}`}>
 *     <OperationsRailBadge status={status} count={attentionCount} />
 *   </button>
 *
 *   <OperationsCenter
 *     open={open}
 *     onClose={() => setOpen(false)}
 *     initialSection="attention"        // or "activity" for the pulse slot
 *     anchorTop={58}
 *     routePath={routePath}
 *     returnFocusRef={triggerRef}
 *   />
 *
 * The panel portals itself and handles Esc, outside-click, route change, and
 * focus return. The host owns only the trigger and the open flag.
 */

export { OperationsCenter, OPERATIONS_SECTIONS } from './OperationsCenter'
export type { OperationsCenterProps, OperationsSection } from './OperationsCenter'

export { OperationsRailBadge } from './OperationsRailBadge'
export type { OperationsRailBadgeProps } from './OperationsRailBadge'

export { useOperationsSummary } from './useOperationsSummary'
export type { OperationsSummary } from './useOperationsSummary'

export { useOperationsActivity } from './useOperationsActivity'
export type { OperationsActivityState } from './useOperationsActivity'

export {
  resolveSendingStatus,
  describeExecutionMode,
  normalizeHealthStatus,
  toLegacyBadgeStatus,
  humanizeBlockerCode,
  DEGRADE_THRESHOLDS,
} from './ops-status'
export type {
  SendingStatus,
  SendingState,
  StatusTone,
  OpsReason,
  QueueExecutionMode,
  ExecutionModeDescription,
  HealthInput,
  ControlInput,
} from './ops-status'

export {
  humanizeNotificationTitle,
  humanizeEventType,
  humanizeQueueStatus,
  humanizeEntityName,
  humanizeActionType,
  humanizeMetricKey,
  formatPhoneForDisplay,
  isPhoneLike,
  isUuid,
  toastSeverityToDomain,
  domainSeverityToToast,
} from './ops-humanize'

export { startSessionEventBridge, useSessionEvents } from './session-event-bridge'
export type { SessionEvent } from './session-event-bridge'
