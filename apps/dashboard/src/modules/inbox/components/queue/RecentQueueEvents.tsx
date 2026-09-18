import { useEffect, useState, type FC } from 'react'
import { fetchAllQueueItems } from '../../../../lib/data/queueData'
import type { QueueItem } from '../../../../domain/queue/queue.types'

/**
 * §42/§43/§44 — REAL QUEUE EVENTS, OR NONE.
 *
 * This panel rendered eleven hardcoded `MOCK_EVENTS` with `Date.now()`-relative
 * timestamps, so they always looked like they had just happened: "Sent to …3847
 * — Dallas", "Failed — …9921 Houston: TextGrid content filter", "Suppression
 * written — opt-out keyword STOP". It is mounted by SendQueueDashboard in the
 * live product, so an operator was reading invented delivery and COMPLIANCE
 * events as real ones.
 *
 * It was also a second implementation of a capability the product already has:
 * QueuePage's events section reads `fetchAllQueueItems`. This now derives from
 * that same canonical source, so there is one queue truth rather than a real one
 * and a decorative one.
 */
export interface RecentQueueEvent {
  id: string
  type: 'queue_run_started' | 'queue_row_sent' | 'delivery_received' | 'send_failed' | 'suppression_written' | 'webhook_received' | 'campaign_target_updated'
  detail: string
  market?: string
  at: string // ISO string
}

const EVENT_ICONS: Record<RecentQueueEvent['type'], string> = {
  queue_run_started:       '▶',
  queue_row_sent:          '→',
  delivery_received:       '✓',
  send_failed:             '✕',
  suppression_written:     '🚫',
  webhook_received:        '⚡',
  campaign_target_updated: '✎',
}

const EVENT_TONES: Record<RecentQueueEvent['type'], string> = {
  queue_run_started:       'blue',
  queue_row_sent:          'cyan',
  delivery_received:       'green',
  send_failed:             'red',
  suppression_written:     'amber',
  webhook_received:        'blue',
  campaign_target_updated: 'muted',
}

/**
 * A queue row's own state IS the event: a row that sent, failed, or was
 * suppressed is the record of that happening. Nothing is synthesised — a row
 * with no dispatch history simply does not produce an event.
 */
const toEvent = (item: QueueItem): RecentQueueEvent | null => {
  const at = item.deliveredAt || item.sentAt || item.scheduledForUtc || null
  if (!at) return null

  const tail = String(item.phone ?? '').slice(-4)
  const where = item.market ? ` — ${item.market}` : ''

  if (item.status === 'delivered') {
    return { id: `${item.id}:delivered`, type: 'delivery_received', detail: `Delivered — …${tail}${where}`, market: item.market, at }
  }
  if (item.status === 'failed' || item.status === 'retry') {
    const why = item.failureReason ? `: ${item.failureReason}` : ''
    return { id: `${item.id}:failed`, type: 'send_failed', detail: `Failed — …${tail}${where}${why}`, market: item.market, at }
  }
  if (item.status === 'sent' || item.status === 'sending') {
    return { id: `${item.id}:sent`, type: 'queue_row_sent', detail: `Sent to …${tail}${where}`, market: item.market, at }
  }
  if (String(item.status).startsWith('blocked') || String(item.status).startsWith('paused')) {
    return { id: `${item.id}:blocked`, type: 'suppression_written', detail: `Held — …${tail}${where}: ${item.status}`, market: item.market, at }
  }
  return null
}

const relTime = (iso: string): string => {
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  return `${Math.floor(min / 60)}h ago`
}

export const RecentQueueEvents: FC = () => {
  const [events, setEvents] = useState<RecentQueueEvent[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let active = true
    void fetchAllQueueItems({ pageSize: 60 })
      .then((items) => {
        if (!active) return
        const derived = (Array.isArray(items) ? items : [])
          .map(toEvent)
          .filter((event): event is RecentQueueEvent => event !== null)
          .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
          .slice(0, 12)
        setEvents(derived)
      })
      .catch(() => { if (active) { setFailed(true); setEvents([]) } })
    return () => { active = false }
  }, [])

  const rows = events ?? []

  return (
    <div className="sqd-section sqd-event-stream-section">
      <div className="sqd-section__head">
        <span className="sqd-section-eyebrow">Recent Queue Events</span>
        <span className="sqd-panel__count">
          {events === null ? 'reading…' : `${rows.length} events`}
        </span>
      </div>
      <div className="sqd-event-stream">
        {events !== null && rows.length === 0 && (
          <div className="sqd-event-row is-muted">
            <span className="sqd-event-row__detail">
              {failed ? 'Queue events unavailable — the queue could not be read.' : 'No queue activity in the recent window.'}
            </span>
          </div>
        )}
        {rows.map(ev => (
          <div key={ev.id} className={`sqd-event-row is-${EVENT_TONES[ev.type]}`}>
            <span className={`sqd-event-row__icon is-${EVENT_TONES[ev.type]}`}>{EVENT_ICONS[ev.type]}</span>
            <span className="sqd-event-row__type">{ev.type.replace(/_/g, ' ')}</span>
            <span className="sqd-event-row__detail">{ev.detail}</span>
            {ev.market && <span className="sqd-event-row__market">{ev.market}</span>}
            <span className="sqd-event-row__time">{relTime(ev.at)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
