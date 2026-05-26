import { type FC } from 'react'
import type { QueueCommandMode } from '../QueueCommandCenter'
import { emitNotification } from '../../../../shared/NotificationToast'

interface QueueActionsBarProps {
  mode: QueueCommandMode
  health: 'healthy' | 'warning' | 'critical' | 'unknown'
  actionLoading: string | null
  onModeChange: (mode: QueueCommandMode) => void
  onRunQueueNow: () => void
  onRetryFailed: () => void
  onReconcileDelivery: () => void
  onCancelStaleFollowUps: () => void
  onReprocessPaused: () => void
}

const isCritical = (health: string) => health === 'critical'

export const QueueActionsBar: FC<QueueActionsBarProps> = ({
  mode,
  health,
  actionLoading,
  onModeChange,
  onRunQueueNow,
  onRetryFailed,
  onReconcileDelivery,
  onCancelStaleFollowUps,
  onReprocessPaused,
}) => {
  const busy = actionLoading !== null
  const critical = isCritical(health)

  // TODO: wire onBackfillMessageEvents to backend API endpoint /api/queue/backfill-message-events
  const handleBackfill = () =>
    emitNotification({ title: 'Backfill Message Events', detail: 'TODO: wire to backend API', severity: 'warning', sound: 'notification' })

  // TODO: wire onWriteSuppressionFromFailures to backend API endpoint /api/queue/write-suppression
  const handleWriteSuppression = () =>
    emitNotification({ title: 'Write Suppression From Failures', detail: 'TODO: wire to backend API', severity: 'warning', sound: 'notification' })

  const actions: Array<{
    label: string
    key: string
    tone: 'primary' | 'secondary' | 'danger' | 'corrective'
    disabled?: boolean
    onClick: () => void
  }> = [
    {
      label: mode === 'paused' ? 'Resume Sender' : 'Pause Sender',
      key: 'toggle_mode',
      tone: mode === 'paused' ? 'corrective' : 'danger',
      onClick: () => onModeChange(mode === 'paused' ? 'automatic' : 'paused'),
    },
    {
      label: actionLoading === 'run_now' ? 'Starting…' : 'Run Queue Once',
      key: 'run_once',
      tone: 'primary',
      disabled: busy || (critical && mode === 'paused'),
      onClick: onRunQueueNow,
    },
    {
      label: actionLoading === 'retry_failed' ? 'Retrying…' : 'Retry Failed Safe',
      key: 'retry_failed',
      tone: 'corrective',
      disabled: busy,
      onClick: onRetryFailed,
    },
    {
      label: actionLoading === 'reconcile_delivery' ? 'Reconciling…' : 'Reconcile Delivery',
      key: 'reconcile',
      tone: 'corrective',
      disabled: busy,
      onClick: onReconcileDelivery,
    },
    {
      label: 'Backfill Message Events',
      key: 'backfill',
      tone: 'secondary',
      disabled: busy,
      onClick: handleBackfill,
    },
    {
      label: 'Write Suppression From Failures',
      key: 'write_suppression',
      tone: 'secondary',
      disabled: busy,
      onClick: handleWriteSuppression,
    },
    {
      label: actionLoading === 'reprocess_paused' ? 'Reprocessing…' : 'Reprocess Paused',
      key: 'reprocess',
      tone: 'secondary',
      disabled: busy || critical,
      onClick: onReprocessPaused,
    },
    {
      label: actionLoading === 'cancel_stale_followups' ? 'Clearing…' : 'Clear Stale Scheduled',
      key: 'clear_stale',
      tone: 'secondary',
      disabled: busy || critical,
      onClick: onCancelStaleFollowUps,
    },
  ]

  return (
    <div className="sqd-actions-bar">
      <span className="sqd-actions-bar__label">Queue Actions</span>
      <div className="sqd-actions-bar__pills">
        {actions.map(action => (
          <button
            key={action.key}
            type="button"
            className={[
              'sqd-action-pill',
              `is-${action.tone}`,
              action.disabled ? 'is-disabled' : '',
              actionLoading === action.key ? 'is-loading' : '',
            ].filter(Boolean).join(' ')}
            onClick={action.onClick}
            disabled={action.disabled || busy}
            title={action.disabled && critical ? 'Disabled: queue health is Critical' : action.label}
          >
            {action.label}
          </button>
        ))}
      </div>
      {critical && (
        <span className="sqd-actions-bar__critical-hint">
          ⚠ Some actions disabled during Critical health
        </span>
      )}
    </div>
  )
}
