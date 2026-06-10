import { Icon } from '../../shared/icons'
import type { WorkflowDetail } from './workflow.types'

interface WorkflowAnalyticsPanelProps {
  detail: WorkflowDetail
}

export const WorkflowAnalyticsPanel = ({ detail }: WorkflowAnalyticsPanelProps) => {
  const dryRuns = (detail.runs ?? []).filter((run) => run.dry_run === true)
  const audit = detail.audit ?? []

  return (
    <div className="wfs-panel-grid is-wide">
      <section className="wfs-section">
        <header className="wfs-section__header">
          <div>
            <span className="wfs-kicker">Activity</span>
            <h3>Workflow Analytics</h3>
          </div>
        </header>
        <div className="wfs-metric-grid">
          <div><span>Runs</span><strong>{detail.runs?.length ?? 0}</strong></div>
          <div><span>Dry Runs</span><strong>{dryRuns.length}</strong></div>
          <div><span>Audit Logs</span><strong>{audit.length}</strong></div>
          <div><span>Live Sends</span><strong>0</strong></div>
        </div>
      </section>
      <section className="wfs-section">
        <header className="wfs-section__header">
          <div>
            <span className="wfs-kicker">Audit</span>
            <h3>Recent Events</h3>
          </div>
        </header>
        <div className="wfs-audit-list">
          {audit.length === 0 ? (
            <div className="wfs-empty">No audit rows</div>
          ) : audit.slice(0, 12).map((row, index) => (
            <article key={`${row.id ?? index}`} className="wfs-audit-row">
              <Icon name="activity" />
              <span>{String(row.action ?? 'workflow.activity')}</span>
              <time>{String(row.created_at ?? '')}</time>
            </article>
          ))}
        </div>
      </section>
    </div>
  )
}
