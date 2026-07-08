import { useCallback, useEffect, useState } from 'react'
import { Icon } from '../../../shared/icons'
import {
  loadWorkflowAutomationActivitySurface,
  type WorkflowAutomationActivityRow,
} from '../workflow-automation-activity.adapter'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

const SOURCE_LABELS: Record<string, string> = {
  workflow_v2: 'Workflow V2',
  send_queue_followup: 'Send queue follow-up',
  seller_flow: 'Seller flow',
  auto_reply: 'Auto-reply',
}

function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source
}

interface WorkflowAutomationActivityPanelProps {
  enabled?: boolean
  limit?: number
}

export function WorkflowAutomationActivityPanel({
  enabled = true,
  limit = 50,
}: WorkflowAutomationActivityPanelProps) {
  const [rows, setRows] = useState<WorkflowAutomationActivityRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorType, setErrorType] = useState<string | null>(null)
  const [retryable, setRetryable] = useState(true)
  const [counts, setCounts] = useState<Record<string, number>>({})

  const refresh = useCallback(async () => {
    if (!enabled) return
    setLoading(true)
    setError(null)
    setErrorType(null)
    const surface = await loadWorkflowAutomationActivitySurface({ limit })
    if (!surface.ok) {
      setError(surface.errorMessage ?? 'automation_activity_failed')
      setErrorType(surface.errorType ?? 'query_failed')
      setRetryable(surface.retryable ?? true)
      setLoading(false)
      return
    }
    setRows(surface.data.activity)
    setCounts(surface.data.counts)
    setRetryable(true)
    setLoading(false)
  }, [enabled, limit])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!enabled) return null

  return (
    <section className="wfs2-activity" aria-label="Live automation activity">
      <div className="wfs2-activity__head">
        <strong>Automation activity</strong>
        <button type="button" className="wfs2-activity__refresh" onClick={() => void refresh()} disabled={loading}>
          <Icon name="refresh-cw" size={12} />
        </button>
      </div>

      {error && rows.length === 0 && (
        <div className="wfs2-activity__error" role="alert">
          <p>{errorType === 'auth_error' ? 'Authentication failed' : 'Automation activity unavailable'}</p>
          <small>{error}</small>
          {retryable && (
            <button type="button" onClick={() => void refresh()}>Retry</button>
          )}
        </div>
      )}

      {!error && !loading && rows.length === 0 && (
        <div className="wfs2-activity__empty">
          <p>No automation activity in canonical sources.</p>
          <small>Checked workflow enrollments, scheduled tasks, and send_queue follow-ups.</small>
        </div>
      )}

      {rows.length > 0 && (
        <div className="wfs2-activity__meta">
          <span>{counts.total ?? rows.length} rows</span>
          <span>{counts.send_queue_followups ?? 0} queue follow-ups</span>
          <span>{counts.workflow_enrollments ?? 0} enrollments</span>
        </div>
      )}

      <ul className="wfs2-activity__list">
        {rows.map((row) => (
          <li key={`${row.source}:${row.id}`} className={cls('wfs2-activity__row', `is-${row.source}`)}>
            <div className="wfs2-activity__row-top">
              <span className="wfs2-activity__source">{sourceLabel(row.source)}</span>
              <span className="wfs2-activity__status">{row.status}</span>
            </div>
            <div className="wfs2-activity__seller">{row.seller_label ?? 'Unknown seller'}</div>
            <div className="wfs2-activity__property">{row.property_label ?? '—'}</div>
            <div className="wfs2-activity__signals">
              {row.seller_stage && <span>Stage: {row.seller_stage}</span>}
              {row.seller_temperature && <span>Temp: {row.seller_temperature}</span>}
              {row.touch_number != null && row.touch_number > 1 && <span>T{row.touch_number}</span>}
              {row.human_review_required && <span className="is-warn">Human review</span>}
            </div>
            {row.stopped_reason && (
              <div className="wfs2-activity__stopped">Stopped: {row.stopped_reason}</div>
            )}
            {row.next_scheduled_send && (
              <div className="wfs2-activity__next">Next send: {new Date(row.next_scheduled_send).toLocaleString()}</div>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}