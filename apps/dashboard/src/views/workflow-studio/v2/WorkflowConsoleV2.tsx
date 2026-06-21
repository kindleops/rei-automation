import { useCallback, useEffect, useMemo, useState } from 'react'
import { Icon } from '../../../shared/icons'
import { loadConsole } from '../workflowStudio.adapter'
import type { WorkflowConsoleEvent } from '../workflow.types'

const cls = (...tokens: Array<string | false | null | undefined>) =>
  tokens.filter(Boolean).join(' ')

interface WorkflowConsoleV2Props {
  workflowId: string | null
  open: boolean
  onClose: () => void
  fallbackEvents?: WorkflowConsoleEvent[]
}

function formatTimestamp(value?: string) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    month: 'short',
    day: 'numeric',
  }).format(date)
}

export const WorkflowConsoleV2 = ({
  workflowId,
  open,
  onClose,
  fallbackEvents = [],
}: WorkflowConsoleV2Props) => {
  const [events, setEvents] = useState<WorkflowConsoleEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [nodeFilter, setNodeFilter] = useState('')
  const [sellerFilter, setSellerFilter] = useState('')

  const refresh = useCallback(async () => {
    if (!workflowId) return
    setLoading(true)
    setError('')
    try {
      const response = await loadConsole(workflowId, {
        status: statusFilter === 'all' ? undefined : statusFilter,
        node: nodeFilter || undefined,
        seller: sellerFilter || undefined,
      })
      setEvents(response.events ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Console unavailable')
      setEvents(fallbackEvents)
    } finally {
      setLoading(false)
    }
  }, [fallbackEvents, nodeFilter, sellerFilter, statusFilter, workflowId])

  useEffect(() => {
    if (!open || !workflowId) return
    void refresh()
  }, [open, refresh, workflowId])

  const filtered = useMemo(() => {
    const nodeNeedle = nodeFilter.trim().toLowerCase()
    const sellerNeedle = sellerFilter.trim().toLowerCase()
    return events.filter((event) => {
      if (statusFilter !== 'all' && String(event.status ?? '').toLowerCase() !== statusFilter) return false
      if (nodeNeedle && !String(event.node ?? '').toLowerCase().includes(nodeNeedle)) return false
      if (sellerNeedle && !String(event.seller ?? '').toLowerCase().includes(sellerNeedle)) return false
      return true
    })
  }, [events, nodeFilter, sellerFilter, statusFilter])

  if (!open) return null

  return (
    <section className="wfs2-console is-drawer">
      <header className="wfs2-console__head">
        <div>
          <strong>Execution Console</strong>
          <span>{loading ? 'Loading…' : `${filtered.length} events`}</span>
        </div>
        <div className="wfs2-console__head-actions">
          <button type="button" className="wfs2__btn is-ghost" onClick={() => void refresh()} disabled={loading}>
            <Icon name="refresh-cw" /> Refresh
          </button>
          <button type="button" className="wfs2__btn is-ghost" onClick={onClose}>
            <Icon name="x" /> Close
          </button>
        </div>
      </header>

      <div className="wfs2-console__filters">
        <label>
          <span>Status</span>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="all">All</option>
            <option value="progressing">Progressing</option>
            <option value="waiting">Waiting</option>
            <option value="blocked">Blocked</option>
            <option value="failed">Failed</option>
            <option value="completed">Completed</option>
          </select>
        </label>
        <label>
          <span>Node</span>
          <input value={nodeFilter} onChange={(event) => setNodeFilter(event.target.value)} placeholder="Filter node…" />
        </label>
        <label>
          <span>Seller</span>
          <input value={sellerFilter} onChange={(event) => setSellerFilter(event.target.value)} placeholder="Filter seller…" />
        </label>
      </div>

      {error && (
        <div className="wfs2-console__notice is-warn">
          <Icon name="alert" /> {error}
        </div>
      )}

      <div className="wfs2-console__table-wrap">
        <table className="wfs2-console__table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Seller</th>
              <th>Property</th>
              <th>Workflow</th>
              <th>Node</th>
              <th>Transition</th>
              <th>Duration</th>
              <th>Blocker</th>
              <th>Trace</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={9} className="wfs2-console__empty-row">
                  {loading ? 'Fetching console events…' : 'No console events for current filters.'}
                </td>
              </tr>
            ) : (
              filtered.map((event, index) => (
                <tr key={event.id ?? `${event.timestamp}-${index}`} className={cls(event.blocker && 'is-blocked')}>
                  <td>{formatTimestamp(event.timestamp)}</td>
                  <td>{event.seller ?? '—'}</td>
                  <td>{event.property ?? '—'}</td>
                  <td>{event.workflow ?? '—'}</td>
                  <td>{event.node ?? '—'}</td>
                  <td>{event.transition ?? '—'}</td>
                  <td>{event.duration_ms != null ? `${event.duration_ms}ms` : '—'}</td>
                  <td>{event.blocker ?? '—'}</td>
                  <td className="wfs2-console__trace">{event.trace_id ?? '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}