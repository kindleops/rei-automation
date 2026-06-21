import { Icon } from '../../../shared/icons'
import type { Workflow, WorkflowDetail } from '../workflow.types'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

interface WorkflowCommandBarV2Props {
  detail: WorkflowDetail | null
  busy?: boolean
  validationCount: number
  consoleOpen: boolean
  liveMode?: boolean
  onClone: () => void
  onPause: () => void
  onResume: () => void
  onDryRun: () => void
  onPublish: () => void
  onGoLive: () => void
  onToggleConsole: () => void
  onToggleLiveMode?: () => void
}

function formatTimestamp(value?: string) {
  if (!value) return 'Not saved'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Saved'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

function canPublish(workflow?: Workflow) {
  return workflow?.status === 'draft' || workflow?.operational_mode === 'draft'
}

function canGoLive(workflow?: Workflow) {
  if (!workflow) return false
  if (workflow.is_system_template) return false
  return workflow.status === 'active' || workflow.operational_mode === 'armed'
}

export const WorkflowCommandBarV2 = ({
  detail,
  busy,
  validationCount,
  consoleOpen,
  liveMode,
  onClone,
  onPause,
  onResume,
  onDryRun,
  onPublish,
  onGoLive,
  onToggleConsole,
  onToggleLiveMode,
}: WorkflowCommandBarV2Props) => {
  const workflow: Workflow | undefined = detail?.workflow
  const liveBlocked = workflow?.live_send_enabled !== true
  const publishable = canPublish(workflow)
  const liveReady = canGoLive(workflow) && !liveBlocked

  return (
    <header className="wfs2-cmd">
      <div className="wfs2-cmd__identity">
        <span className="wfs2-cmd__kicker">Workflow Studio V2</span>
        <h1>{workflow?.name ?? 'Select or create a workflow'}</h1>
        <div className="wfs2-cmd__chips">
          <span className={cls('wfs2__badge', workflow && `is-${workflow.status}`)}>
            {workflow?.operational_mode ?? workflow?.status ?? 'draft'}
          </span>
          {workflow?.is_system_template && <span className="wfs2-cmd__chip is-system">System</span>}
          <span className="wfs2-cmd__chip"><Icon name="message" /> {workflow?.channel ?? 'sms'}</span>
          <span className="wfs2-cmd__chip"><Icon name="radar" /> {workflow?.workflow_type ?? 'outbound'}</span>
          <span className="wfs2-cmd__chip"><Icon name="hash" /> v{workflow?.version ?? '1'}</span>
          <span className={cls('wfs2-cmd__chip', liveBlocked ? 'is-safe' : 'is-live')}>
            <Icon name="shield" /> {liveBlocked ? 'Live blocked' : 'Live armed'}
          </span>
          <span className="wfs2-cmd__chip"><Icon name="check" /> {formatTimestamp(workflow?.updated_at)}</span>
        </div>
      </div>

      <div className="wfs2-cmd__actions">
        <button
          type="button"
          className="wfs2__btn is-ghost"
          disabled={busy || !detail}
          onClick={onDryRun}
          title="Simulate workflow without sending live messages"
        >
          <Icon name="eye" /> Dry Run
        </button>

        <button
          type="button"
          className="wfs2__btn is-ghost"
          disabled={busy || !detail || !publishable}
          onClick={onPublish}
          title="Validate and publish draft to armed state"
        >
          <Icon name="check-double" /> Publish {validationCount > 0 ? `(${validationCount})` : ''}
        </button>

        <button
          type="button"
          className={cls('wfs2__btn', liveMode && 'is-primary')}
          disabled={busy || !detail || !liveReady}
          onClick={onGoLive}
          title={liveBlocked ? 'Live sends remain globally blocked' : 'Enable live execution'}
        >
          <Icon name="zap" /> Live
        </button>

        <button type="button" className="wfs2__btn" disabled={busy || !detail} onClick={onClone}>
          <Icon name="layers" /> Clone
        </button>

        {workflow?.status === 'paused' || workflow?.operational_mode === 'paused' ? (
          <button type="button" className="wfs2__btn" disabled={busy || !detail} onClick={onResume}>
            <Icon name="play" /> Resume
          </button>
        ) : (
          <button type="button" className="wfs2__btn" disabled={busy || !detail} onClick={onPause}>
            <Icon name="pause" /> Pause
          </button>
        )}

        <button type="button" className="wfs2__btn is-primary" disabled={busy || !detail} onClick={onDryRun}>
          <Icon name="play" /> Simulate
        </button>

        <button type="button" className="wfs2__btn" disabled={!detail} onClick={onToggleConsole}>
          <Icon name="activity" /> {consoleOpen ? 'Hide Console' : 'Console'}
        </button>

        {onToggleLiveMode && (
          <button
            type="button"
            className={cls('wfs2__btn', liveMode && 'is-accent')}
            disabled={!detail}
            onClick={onToggleLiveMode}
          >
            <Icon name="radar" /> {liveMode ? 'Live Overlay On' : 'Live Overlay'}
          </button>
        )}
      </div>
    </header>
  )
}