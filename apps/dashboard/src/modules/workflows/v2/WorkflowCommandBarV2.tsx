import { Icon } from '../../../shared/icons'
import type { Workflow, WorkflowDetail } from '../workflow.types'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

interface WorkflowCommandBarV2Props {
  detail: WorkflowDetail | null
  busy?: boolean
  validationCount: number
  onClone: () => void
  onPause: () => void
  onResume: () => void
  onDryRun: () => void
  onToggleConsole: () => void
  consoleOpen: boolean
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

export const WorkflowCommandBarV2 = ({
  detail,
  busy,
  validationCount,
  onClone,
  onPause,
  onResume,
  onDryRun,
  onToggleConsole,
  consoleOpen,
}: WorkflowCommandBarV2Props) => {
  const workflow: Workflow | undefined = detail?.workflow
  const liveBlocked = workflow?.live_send_enabled !== true

  return (
    <header className="wfs2-cmd">
      <div className="wfs2-cmd__identity">
        <span className="wfs2-cmd__kicker">Workflow Studio V2</span>
        <h1>{workflow?.name ?? 'Select or create a workflow'}</h1>
        <div className="wfs2-cmd__chips">
          <span className={cls('wfs2__badge', workflow && `is-${workflow.status}`)}>
            {workflow?.status ?? 'draft'}
          </span>
          <span className="wfs2-cmd__chip"><Icon name="message" /> {workflow?.channel ?? 'sms'}</span>
          <span className="wfs2-cmd__chip"><Icon name="radar" /> {workflow?.workflow_type ?? 'outbound'}</span>
          <span className="wfs2-cmd__chip is-safe"><Icon name="shield" /> Live blocked</span>
          <span className="wfs2-cmd__chip"><Icon name="check" /> {formatTimestamp(workflow?.updated_at)}</span>
        </div>
      </div>

      <div className="wfs2-cmd__actions">
        <button type="button" className="wfs2__btn is-ghost" disabled title="Dry-run mode only">
          <Icon name="eye" /> Dry Run
        </button>
        <button type="button" className="wfs2__btn is-ghost" disabled title="Live sends are disabled by global workflow guards">
          <Icon name="zap" /> Live
        </button>
        <button type="button" className="wfs2__btn" disabled={busy || !detail} onClick={onClone}>
          <Icon name="layers" /> Clone
        </button>
        {workflow?.status === 'paused' ? (
          <button type="button" className="wfs2__btn" disabled={busy || !detail} onClick={onResume}>
            <Icon name="play" /> Resume
          </button>
        ) : (
          <button type="button" className="wfs2__btn" disabled={busy || !detail} onClick={onPause}>
            <Icon name="pause" /> Pause
          </button>
        )}
        <button type="button" className="wfs2__btn is-primary" disabled={busy || !detail} onClick={onDryRun}>
          <Icon name="play" /> Dry Run
        </button>
        <button type="button" className="wfs2__btn" disabled={!detail} onClick={onToggleConsole}>
          <Icon name="activity" /> {consoleOpen ? 'Hide Console' : 'Console'}
        </button>
        <button
          type="button"
          className="wfs2__btn"
          disabled
          title={liveBlocked ? 'Live sends are blocked' : 'Publish is not enabled in this slice'}
        >
          <Icon name="shield" /> Publish {validationCount > 0 ? `(${validationCount})` : ''}
        </button>
      </div>
    </header>
  )
}
