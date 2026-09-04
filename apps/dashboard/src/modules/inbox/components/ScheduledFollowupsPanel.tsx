import { useCallback, useEffect, useState } from 'react'
import { listScheduledFollowups, type ScheduledFollowupItem } from '../../../lib/api/backendClient'

type Props = {
  /** Optional: restrict to a single thread. Omit for the full Scheduled view. */
  threadKey?: string
  onOpenThread?: (threadKey: string) => void
  onCancelSchedule?: (item: ScheduledFollowupItem) => void
  onReschedule?: (item: ScheduledFollowupItem) => void
}

const fmtDate = (item: ScheduledFollowupItem): string => {
  if (item.local_send_date && item.local_send_label) {
    return `${item.local_send_date} · ${item.local_send_label}`
  }
  if (!item.scheduled_for_utc) return 'Unscheduled'
  return new Date(item.scheduled_for_utc).toLocaleString()
}

const shortZone = (tz: string | null): string => {
  if (!tz) return ''
  const parts = tz.split('/')
  return (parts[parts.length - 1] || tz).replace(/_/g, ' ')
}

/**
 * Compact inspector for follow-ups intentionally parked in the future.
 *
 * Reads send_queue through /api/cockpit/inbox/scheduled. Deliberately shows the
 * queue state verbatim -- a scheduled message has NOT been sent, and nothing
 * here may render as delivered.
 */
export function ScheduledFollowupsPanel({ threadKey, onOpenThread, onCancelSchedule, onReschedule }: Props) {
  const [items, setItems] = useState<ScheduledFollowupItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const result = await listScheduledFollowups({ limit: 50, threadKey })
    if (!result.ok || !result.data?.ok) {
      setError(result.errorMessage ?? 'Could not load scheduled follow-ups')
      setItems([])
    } else {
      setItems(result.data.items ?? [])
    }
    setLoading(false)
  }, [threadKey])

  useEffect(() => { void load() }, [load])

  if (loading) {
    return <div className="nx-scheduled-panel nx-scheduled-panel--empty">Loading scheduled follow-ups…</div>
  }
  if (error) {
    return (
      <div className="nx-scheduled-panel nx-scheduled-panel--empty">
        <span>{error}</span>
        <button type="button" className="nx-scheduled-retry" onClick={() => void load()}>Retry</button>
      </div>
    )
  }
  if (items.length === 0) {
    return (
      <div className="nx-scheduled-panel nx-scheduled-panel--empty">
        <strong>Nothing scheduled</strong>
        <span>Follow-ups you schedule from the composer appear here until they send.</span>
      </div>
    )
  }

  return (
    <div className="nx-scheduled-panel">
      <div className="nx-scheduled-panel__head">
        <span>{items.length} scheduled</span>
        <span className="nx-scheduled-panel__note">Queued — not yet sent</span>
      </div>
      <ul className="nx-scheduled-list">
        {items.map((item) => (
          <li key={item.id ?? `${item.thread_key}-${item.scheduled_for_utc}`} className="nx-scheduled-row">
            <button
              type="button"
              className="nx-scheduled-row__main"
              onClick={() => item.thread_key && onOpenThread?.(item.thread_key)}
            >
              <div className="nx-scheduled-row__top">
                <span className="nx-scheduled-row__who">
                  {item.seller_name || item.to_phone_number || 'Unknown seller'}
                </span>
                <span className="nx-scheduled-row__state" data-state={item.schedule_state ?? 'pending'}>
                  {item.schedule_state ?? 'pending'}
                </span>
              </div>
              {item.property_address && (
                <div className="nx-scheduled-row__addr">{item.property_address}</div>
              )}
              <div className="nx-scheduled-row__preview">{item.message_preview || '(no message body)'}</div>
              <div className="nx-scheduled-row__when">
                <span className="nx-scheduled-row__local">{fmtDate(item)}</span>
                {item.timezone && (
                  <span className="nx-scheduled-row__tz">{shortZone(item.timezone)} local</span>
                )}
              </div>
            </button>
            <div className="nx-scheduled-row__actions">
              {onReschedule && (
                <button type="button" onClick={() => onReschedule(item)}>Reschedule</button>
              )}
              {onCancelSchedule && (
                <button type="button" className="is-danger" onClick={() => onCancelSchedule(item)}>Cancel</button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

export default ScheduledFollowupsPanel
