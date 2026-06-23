import { Icon } from '../../../shared/icons'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

interface QueueGlobalCommandsProps {
  busyAction: string | null
  loading: boolean
  runnableCount: number
  failedCount: number
  onRunQueue: () => void
  onRetryFailed: () => void
  onRefresh: () => void
  layoutMode: string
}

export function QueueGlobalCommands({
  busyAction, loading, runnableCount, failedCount, onRunQueue, onRetryFailed, onRefresh, layoutMode,
}: QueueGlobalCommandsProps) {
  if (layoutMode === 'compact') return null

  return (
    <div className="occ-global-cmds">
      <button
        type="button"
        className={cls('occ-cmd-btn occ-cmd-btn--run', busyAction === 'run-queue-now' && 'is-busy')}
        disabled={busyAction !== null || runnableCount === 0}
        onClick={onRunQueue}
        title={runnableCount === 0 ? 'No scheduled/queued rows on current page' : `Will process ${runnableCount} runnable rows`}
      >
        <Icon name={busyAction === 'run-queue-now' ? 'refresh-cw' : 'send'} size={14} />
        <span className="occ-cmd-btn__text">
          <strong>Run Queue</strong>
          <small>{runnableCount > 0 ? `${runnableCount} runnable` : 'none ready'}</small>
        </span>
      </button>
      <button
        type="button"
        className={cls('occ-cmd-btn occ-cmd-btn--retry', busyAction === 'retry-all-failed' && 'is-busy', failedCount === 0 && 'is-disabled')}
        disabled={busyAction !== null || failedCount === 0}
        onClick={onRetryFailed}
        title="Retries eligible failures only — excludes 21610, opt-out, suppressed"
      >
        <Icon name={busyAction === 'retry-all-failed' ? 'refresh-cw' : 'zap'} size={14} />
        <span className="occ-cmd-btn__text">
          <strong>Retry Failed</strong>
          <small>{failedCount > 0 ? `${failedCount} in range` : 'none'}</small>
        </span>
      </button>
      <button
        type="button"
        className={cls('occ-cmd-btn occ-cmd-btn--refresh', loading && 'is-busy')}
        disabled={loading}
        onClick={onRefresh}
        title="Reload filtered data and metrics"
      >
        <Icon name="refresh-cw" size={14} />
      </button>
    </div>
  )
}